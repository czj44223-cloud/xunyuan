import { redactText } from './util/http.js';
import { redactData } from './util/http.js';
import { workPath } from './util/workspace.js';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { ASSET_JOBS_DIR } from './paths.js';
import { RunEvents } from './events.js';
import { runAssetJob } from './assets/pipeline.js';
import { LLM } from './llm/deepseek.js';
import { newRunId } from './util/ids.js';

const ID_RE = /^r_[A-Za-z0-9_]+$/;
const MAX_TOTAL = 24;
const MAX_PER_KIND = 12;

const FORBIDDEN_FOLDER = [
  /^[a-z]:[\\/]?$/i,
  /^[a-z]:[\\/](windows|program files|program files \(x86\)|programdata|system volume information)([\\/]|$)/i,
  /^\/$/,
];

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function prepareFolder(rawFolder) {
 return workPath(rawFolder, { create: true, directory: true });
}

const DEFAULT_EXT = { video: 'mp4', audio: 'mp3', image: 'jpg' };
const KIND_LABEL = { video: '视频', audio: '音乐', image: '图片', file: '文件' };
const EXT_KIND = new Map([
  ...['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'].map((ext) => [ext, 'video']),
  ...['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'].map((ext) => [ext, 'audio']),
  ...['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'svg'].map((ext) => [ext, 'image']),
]);

export function kindForExt(ext) {
  return EXT_KIND.get(String(ext || '').toLowerCase()) || 'file';
}

function parseTypes(raw) {
  const list = [];
  const source = Array.isArray(raw.types) ? raw.types : [];
  for (const item of source.slice(0, 10)) {
    const ext = String(item?.ext || '').trim().toLowerCase().replace(/^\./, '');
    if (!/^[a-z0-9]{1,6}$/.test(ext)) continue;
    const count = clamp(item?.count, 0, MAX_PER_KIND, 0);
    if (count < 1) continue;
    const kind = kindForExt(ext);
    const label = String(item?.label || '').trim().slice(0, 20) || KIND_LABEL[kind];
    list.push({
      id: `t${list.length + 1}`,
      label,
      ext,
      kind,
      count,
      custom: Boolean(item?.custom) || kind === 'file',
    });
  }
  if (list.length) return list;

  const legacy = {
    video: clamp(raw.counts?.video, 0, MAX_PER_KIND, 0),
    audio: clamp(raw.counts?.audio, 0, MAX_PER_KIND, 0),
    image: clamp(raw.counts?.image, 0, MAX_PER_KIND, 0),
  };
  for (const kind of ['video', 'audio', 'image']) {
    if (legacy[kind] > 0) {
      list.push({ id: kind, label: KIND_LABEL[kind], ext: DEFAULT_EXT[kind], kind, count: legacy[kind], custom: false });
    }
  }
  return list;
}

export async function normalizeAssetInput(raw = {}) {
  const brief = String(raw.brief || '').trim();
  if (!brief) throw Object.assign(new Error('请描述需要什么样的素材'), { status: 400 });
  if (brief.length > 500) throw Object.assign(new Error('需求描述过长（最多 500 字）'), { status: 400 });
  const folder = await prepareFolder(raw.folder);
  const types = parseTypes(raw);
  const total = types.reduce((sum, type) => sum + type.count, 0);
  if (!total) throw Object.assign(new Error('请至少添加一种素材类型并设置数量'), { status: 400 });
  if (total > MAX_TOTAL) throw Object.assign(new Error(`一次最多收集 ${MAX_TOTAL} 个素材`), { status: 400 });

  const counts = { video: 0, audio: 0, image: 0, file: 0 };
  for (const type of types) counts[type.kind] = (counts[type.kind] || 0) + type.count;

  return {
    brief,
    folder,
    counts,
    types,
    sources: Array.isArray(raw.sources) ? raw.sources.map(String).slice(0, 8) : [],
    useLLM: raw.useLLM !== false,
  };
}

export class AssetManager {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.jobs = new Map();
  }

  async create(rawInput) {
    const input = await normalizeAssetInput(rawInput);
    const id = newRunId();
    const dir = path.join(ASSET_JOBS_DIR, id);
    await fs.mkdir(dir, { recursive: true });
    const events = new RunEvents(dir);
    await events.init();

    const record = {
      id,
      kind: 'assets',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'queued',
      input,
      plan: null,
      candidates: {},
      items: [],
      stats: { candidates: 0, downloaded: 0, bytes: 0 },
      warnings: [],
      manifest: null,
      error: null,
    };

    const entry = {
      dir,
      record,
      events,
      controller: new AbortController(),
      llm: new LLM(this.getConfig()),
      writeQueue: Promise.resolve(),
    };
    entry.finished = new Promise((resolve) => { entry.resolveFinished = resolve; });
    this.jobs.set(id, entry);
    await this.save(entry);
    this.#execute(entry).catch(() => {}).finally(() => entry.resolveFinished(record));
    return record;
  }

  async #execute(entry) {
    const config = this.getConfig();
    entry.llm = new LLM(config);
    entry.record.status = 'running';
    await this.save(entry);
    try {
      await runAssetJob({
        record: entry.record,
        config,
        events: entry.events,
        signal: entry.controller.signal,
        llm: entry.llm,
        save: () => this.save(entry),
      });
      if (entry.record.status !== 'cancelled') {
        entry.record.status = 'completed';
        entry.events.emit('job.completed', { stage: 'done', message: '素材收集完成', data: {
          downloaded: entry.record.stats.downloaded,
          bytes: entry.record.stats.bytes,
          folder: entry.record.input.folder,
        } });
      }
    } catch (err) {
      if (err?.name === 'AbortError' || entry.controller.signal.aborted) {
        entry.record.status = 'cancelled';
        entry.events.emit('job.cancelled', { stage: 'done', message: '素材任务已取消' });
      } else {
        entry.record.status = 'failed';
        entry.record.error = redactText(err.message) || String(err);
        entry.events.emit('job.failed', { stage: 'done', message: entry.record.error });
      }
    } finally {
      entry.record.updatedAt = new Date().toISOString();
      await this.save(entry);
      await entry.events.flush();
    }
  }

  #write(entry) {
    entry.record.updatedAt = new Date().toISOString();
    const file = path.join(entry.dir, 'record.json');
    const tmp = `${file}.${process.pid}.tmp`;
    const payload = JSON.stringify(redactData(entry.record), null, 2);
    return fs.writeFile(tmp, payload, 'utf8')
      .then(() => fs.rename(tmp, file))
      .catch(async () => {
        try { await fs.writeFile(file, payload, 'utf8'); } catch { /* ignore */ }
      });
  }

  save(entry) {
    entry.writeQueue = entry.writeQueue.then(() => this.#write(entry), () => this.#write(entry));
    return entry.writeQueue;
  }

  get(id) { return this.jobs.get(id) || null; }

  async getRecord(id) {
    if (!ID_RE.test(id || '')) return null;
    const entry = this.jobs.get(id);
    if (entry) return entry.record;
    return this.loadRecord(id);
  }

  async loadRecord(id) {
    if (!ID_RE.test(id || '')) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(ASSET_JOBS_DIR, id, 'record.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async replayFromDisk(id, after = 0) {
    if (!ID_RE.test(id || '')) return [];
    try {
      const text = await fs.readFile(path.join(ASSET_JOBS_DIR, id, 'events.jsonl'), 'utf8');
      return text.split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter((event) => event && event.seq > after);
    } catch {
      return [];
    }
  }

  async list(limit = 30) {
    let dirs = [];
    try {
      dirs = await fs.readdir(ASSET_JOBS_DIR, { withFileTypes: true });
    } catch {
      return [];
    }
    const records = [];
    for (const dirent of dirs) {
      if (!dirent.isDirectory() || !ID_RE.test(dirent.name)) continue;
      const record = await this.loadRecord(dirent.name);
      if (record) records.push(record);
    }
    records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return records.slice(0, limit).map((r) => ({
      id: r.id,
      kind: 'assets',
      createdAt: r.createdAt,
      status: r.status,
      brief: r.input?.brief || '',
      folder: r.input?.folder || '',
      downloaded: r.stats?.downloaded || 0,
      candidates: r.stats?.candidates || 0,
      bytes: r.stats?.bytes || 0,
    }));
  }

  cancel(id) {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    if (['completed', 'failed', 'cancelled'].includes(entry.record.status)) return false;
    entry.controller.abort();
    entry.record.status = 'cancelled';
    entry.events.emit('job.cancelled', { stage: 'done', message: '素材任务已取消（用户请求）' });
    this.save(entry);
    return true;
  }

  wait(id) {
    const entry = this.jobs.get(id);
    return entry ? entry.finished : Promise.resolve(null);
  }
}
