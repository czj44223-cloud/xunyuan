import { redactText } from './util/http.js';
import { redactData } from './util/http.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RUNS_DIR } from './paths.js';
import { RunEvents } from './events.js';
import { runCollection } from './pipeline.js';
import { LLM } from './llm/deepseek.js';
import { newRunId } from './util/ids.js';

const ID_RE = /^r_[A-Za-z0-9_]+$/;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeInput(raw = {}) {
  const query = String(raw.query || '').trim();
  if (!query) throw Object.assign(new Error('请填写要收集的主题'), { status: 400 });
  if (query.length > 500) throw Object.assign(new Error('主题过长（最多 500 字）'), { status: 400 });
  const mode = raw.mode === 'deep' ? 'deep' : 'fast';
  const providers = Array.isArray(raw.providers)
    ? raw.providers.map((p) => String(p)).filter(Boolean).slice(0, 12)
    : [];
  return {
    query,
    mode,
    providers,
    fetchLimit: clamp(raw.fetchLimit, 1, 30, mode === 'deep' ? 20 : 8),
    maxRounds: clamp(raw.maxRounds, 1, 3, 2),
    wantTable: Boolean(raw.wantTable),
    useLLM: raw.useLLM !== false,
  };
}

export class RunManager {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.runs = new Map();
  }

  async create(rawInput) {
    const input = normalizeInput(rawInput);
    const id = newRunId();
    const dir = path.join(RUNS_DIR, id);
    await fs.mkdir(dir, { recursive: true });
    const events = new RunEvents(dir);
    await events.init();

    const record = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'queued',
      input,
      rounds: [],
      results: [],
      report: null,
      table: null,
      stats: { searches: 0, fetches: 0, llmCalls: 0, estCostUsd: 0, byProvider: {} },
      warnings: [],
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
    this.runs.set(id, entry);
    await this.save(entry);

    this.#execute(entry).catch(() => {}).finally(() => {
      entry.resolveFinished(record);
    });
    return record;
  }

  async #execute(entry) {
    const config = this.getConfig();
    entry.llm = new LLM(config);
    entry.record.status = 'running';
    await this.save(entry);
    try {
      await runCollection({
        record: entry.record,
        config,
        events: entry.events,
        signal: entry.controller.signal,
        llm: entry.llm,
        save: () => this.save(entry),
      });
      if (entry.record.status !== 'cancelled') {
        entry.record.status = 'completed';
        entry.events.emit('run.completed', { stage: 'done', message: '任务完成', data: statsOf(entry.record) });
      }
    } catch (err) {
      if (err?.name === 'AbortError' || entry.controller.signal.aborted) {
        entry.record.status = 'cancelled';
        entry.events.emit('run.cancelled', { stage: 'done', message: '任务已取消' });
      } else {
        entry.record.status = 'failed';
        entry.record.error = redactText(err.message) || String(err);
        entry.events.emit('run.failed', { stage: 'done', message: entry.record.error, data: { code: err.code || '' } });
      }
    } finally {
      entry.record.updatedAt = new Date().toISOString();
      entry.record.stats.llmCalls = entry.llm.stats.calls;
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

  get(id) {
    return this.runs.get(id) || null;
  }

  async getRecord(id) {
    if (!ID_RE.test(id || '')) return null;
    const entry = this.runs.get(id);
    if (entry) return entry.record;
    return this.loadRecord(id);
  }

  async loadRecord(id) {
    if (!ID_RE.test(id || '')) return null;
    try {
      const text = await fs.readFile(path.join(RUNS_DIR, id, 'record.json'), 'utf8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async replayFromDisk(id, after = 0) {
    if (!ID_RE.test(id || '')) return [];
    try {
      const text = await fs.readFile(path.join(RUNS_DIR, id, 'events.jsonl'), 'utf8');
      return text.split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter((e) => e && e.seq > after);
    } catch {
      return [];
    }
  }

  async list(limit = 50) {
    let dirs = [];
    try {
      dirs = await fs.readdir(RUNS_DIR, { withFileTypes: true });
    } catch {
      return [];
    }
    const records = [];
    for (const dirent of dirs) {
      if (!dirent.isDirectory() || !ID_RE.test(dirent.name)) continue;
      const record = await this.loadRecord(dirent.name);
      if (!record) continue;
      records.push(record);
    }
    records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return records.slice(0, limit).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      status: r.status,
      query: r.input?.query || '',
      mode: r.input?.mode || 'fast',
      sources: r.results?.filter((x) => x.status === 'ok').length || 0,
      candidates: r.results?.length || 0,
      reportChars: r.report?.markdown?.length || 0,
      warnings: r.warnings?.length || 0,
    }));
  }

  cancel(id) {
    const entry = this.runs.get(id);
    if (!entry) return false;
    if (['completed', 'failed', 'cancelled'].includes(entry.record.status)) return false;
    entry.controller.abort();
    entry.record.status = 'cancelled';
    entry.events.emit('run.cancelled', { stage: 'done', message: '任务已取消（用户请求）' });
    this.save(entry);
    return true;
  }

  wait(id) {
    const entry = this.runs.get(id);
    return entry ? entry.finished : Promise.resolve(null);
  }
}

function statsOf(record) {
  return {
    status: record.status,
    candidates: record.results.length,
    readable: record.results.filter((r) => r.status === 'ok').length,
    ...record.stats,
  };
}
