import { redactData } from '../util/http.js';
import { redactText } from '../util/http.js';
import { workPath } from '../util/workspace.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Semaphore } from '../util/semaphore.js';
import { searchCandidates, resolveAssetSources } from './sources/index.js';
import { searchWebFiles, urlHasExt } from './sources/web.js';
import { downloadAsset, extensionFor, assetFilename, uniquePath, formatBytes } from './downloader.js';
import { ASSET_PLAN_SYSTEM, assetPlanUser } from './prompts.js';
import { safeFilename } from '../util/url.js';

const KIND_LABEL = { video: '视频', audio: '音乐', image: '图片', file: '文件' };
const DEFAULT_FOLDER = { video: 'video', audio: 'audio', image: 'images' };
const DEFAULT_EXT = { video: 'mp4', audio: 'mp3', image: 'jpg' };

export async function runAssetJob({ record, config, events, signal, llm, save }) {
  const emit = (type, message, data = null, stage = '') => events.emit(type, { stage, message, data });
  const input = record.input;
  const warnings = record.warnings;
  const stats = record.stats;

  const checkAbort = () => {
    if (signal.aborted) {
      const err = new Error('任务已取消');
      err.name = 'AbortError';
      throw err;
    }
  };
  const warn = (message, data = null) => {
    if (!warnings.includes(message)) warnings.push(message);
    if (warnings.length > 60) warnings.shift();
    emit('log', message, data, 'warn');
  };

  const types = (input.types?.length ? input.types : legacyTypes(input.counts)).filter((t) => t.count > 0);
  if (!types.length) throw new Error('没有需要收集的素材类型');
  const folder = await workPath(input.folder, { create: true, directory: true });

  emit('job.started', `开始收集素材：${input.brief}`, {
    folder,
    types: types.map((t) => ({ label: t.label, ext: t.ext, count: t.count })),
    useLLM: Boolean(input.useLLM && llm.ready),
  }, 'plan');

  // 分配归档文件夹：内置类型用 video/audio/images，自定义类型用名称
  const usedFolders = new Set(Object.values(DEFAULT_FOLDER));
  for (const type of types) {
    if (type.custom || !DEFAULT_FOLDER[type.kind]) {
      const base = safeFilename(type.label || type.ext, 'files');
      let candidate = base;
      let n = 2;
      while (usedFolders.has(candidate)) candidate = `${base}-${n++}`;
      usedFolders.add(candidate);
      type.folder = candidate;
    } else {
      type.folder = DEFAULT_FOLDER[type.kind];
    }
    await workPath(path.join(folder, type.folder), { create: true, directory: true });
  }

  /* 1. 生成英文检索词 */
  const queries = { video: [], audio: [], image: [] };
  let planSummary = '';
  if (input.useLLM && llm.ready) {
    try {
      const data = await llm.json({
        system: ASSET_PLAN_SYSTEM,
        user: assetPlanUser(input.brief, input.counts),
        signal,
        maxTokens: 600,
      });
      planSummary = String(data.summary || '').slice(0, 200);
      for (const kind of ['video', 'audio', 'image']) {
        queries[kind] = (data[`${kind}Queries`] || [])
          .map((q) => String(q || '').replace(/["'，。]/g, '').trim())
          .filter(Boolean)
          .slice(0, 3);
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      warn(`检索词规划失败，直接使用原始描述：${redactText(err.message)}`);
    }
  }

  const queriesByType = new Map();
  for (const type of types) {
    const base = queries[type.kind]?.length ? queries[type.kind] : [input.brief];
    if (type.custom) {
      const merged = [`${input.brief} ${type.label}`, input.brief, ...base]
        .map((q) => String(q).trim())
        .filter(Boolean);
      queriesByType.set(type.id, [...new Set(merged)].slice(0, 2));
    } else {
      queriesByType.set(type.id, [...new Set(base.map(String))].slice(0, 3));
    }
  }

  record.plan = {
    summary: planSummary,
    queries,
    typeQueries: Object.fromEntries([...queriesByType.entries()].map(([id, list]) => [id, list])),
  };
  emit('plan.done', `检索计划：${types.map((t) => `${t.label}（.${t.ext}）`).join('、')}`, {
    summary: planSummary,
    typeQueries: record.plan.typeQueries,
  }, 'plan');
  save?.();

  /* 2. 按类型检索候选素材 */
  const sourceIds = resolveAssetSources(input.sources, types.map((t) => t.kind));
  const candidates = new Map();

  for (const type of types) {
    checkAbort();
    emit('type.started', `检索${type.label}（.${type.ext}）…`, {
      typeId: type.id, label: type.label, ext: type.ext,
    }, 'search');
    let items = [];
    const typeQueries = queriesByType.get(type.id) || [input.brief];

    try {
      if (type.kind === 'file' || type.custom) {
        items = await searchWebFiles(type, typeQueries, { count: type.count, config, signal, emit, warn });
      } else {
        const { itemsByKind } = await searchCandidates({
          kinds: [type.kind],
          queriesByKind: { [type.kind]: typeQueries },
          counts: { [type.kind]: type.count },
          sourceIds,
          config,
          signal,
          emit,
          warn,
        });
        items = itemsByKind[type.kind] || [];
        const defaultExt = DEFAULT_EXT[type.kind];
        if (type.ext && type.ext !== defaultExt) {
          const filtered = items.filter((item) => urlHasExt(item.fileUrl, type.ext));
          if (filtered.length) {
            items = filtered;
          } else {
            warn(`${type.label}：图库没有 .${type.ext} 格式，改用网页检索`);
            items = await searchWebFiles(type, typeQueries, { count: type.count, config, signal, emit, warn });
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      warn(`${type.label}检索失败：${redactText(err.message)}`);
    }

    candidates.set(type.id, items);
    record.candidates[type.id] = items.length;
    stats.candidates += items.length;
    emit('type.done', `${type.label}：${items.length} 个候选`, {
      typeId: type.id, label: type.label, ext: type.ext, count: items.length,
    }, 'search');
    save?.();
  }

  emit('search.done', `共找到 ${stats.candidates} 个候选素材，开始下载`, { candidates: record.candidates }, 'search');
  checkAbort();

  /* 3. 按类型下载并归档 */
  const semaphore = new Semaphore(config?.assets?.concurrency ?? 2);
  const hashes = new Map();

  const downloadType = async (type) => {
    const items = candidates.get(type.id) || [];
    let saved = 0;
    const dir = path.join(folder, type.folder);

    for (const item of items) {
      if (saved >= type.count) break;
      checkAbort();
      const ext = type.ext ? '.' + type.ext : extensionFor(item, type.kind);
      const filename = assetFilename(item, saved + 1, ext);
      const dest = await uniquePath(dir, filename);

      emit('download.started', `下载${type.label}：${String(item.title || '').slice(0, 50)}`, {
        typeId: type.id, label: type.label, kind: type.kind, ext: type.ext,
        title: item.title, source: item.source, url: item.fileUrl,
      }, 'download');

      try {
        const result = await semaphore.run(
          () => downloadAsset(item, dest, { kind: type.kind, config, signal, referer: item.pageUrl }),
          signal,
        );
        if (hashes.has(result.sha256)) {
          await fs.unlink(dest).catch(() => {});
          warn(`跳过重复文件：${String(item.title || '').slice(0, 40)}`);
          continue;
        }
        hashes.set(result.sha256, item);
        const rel = path.relative(folder, dest).split(path.sep).join('/');
        record.items.push({
          file: rel,
          kind: type.kind,
          typeId: type.id,
          typeLabel: type.label,
          ext: type.ext,
          title: item.title,
          source: item.source,
          sourceLabel: item.sourceLabel,
          pageUrl: item.pageUrl,
          license: item.license,
          licenseUrl: item.licenseUrl,
          author: item.author,
          query: item.query,
          bytes: result.bytes,
          sha256: result.sha256,
          status: 'done',
        });
        stats.downloaded++;
        stats.bytes += result.bytes;
        saved++;
        emit('download.done', `已保存 ${path.basename(dest)} · ${formatBytes(result.bytes)}`, {
          typeId: type.id, label: type.label, kind: type.kind, file: rel, bytes: result.bytes, saved, need: type.count,
        }, 'download');
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        record.items.push({
          kind: type.kind,
          typeId: type.id,
          typeLabel: type.label,
          ext: type.ext,
          title: item.title,
          source: item.source,
          pageUrl: item.pageUrl,
          status: 'failed',
          error: redactText(err.message),
        });
        warn(`下载失败：${String(item.title || '').slice(0, 40)}（${redactText(err.message)}）`);
        emit('download.failed', `下载失败：${String(item.title || '').slice(0, 40)}`, {
          typeId: type.id, label: type.label, kind: type.kind, error: redactText(err.message), url: item.fileUrl,
        }, 'download');
      }
      save?.();
    }

    if (saved < type.count) warn(`${type.label}只收集到 ${saved}/${type.count} 个可用素材`);
  };

  await Promise.all(types.map((type) => downloadType(type)));
  checkAbort();

  /* 4. 生成清单并整理 */
  emit('organize.started', '正在写入素材清单…', null, 'organize');
  const manifest = buildManifest(record, types);
  await fs.writeFile(await workPath(path.join(folder, 'manifest.json'), { create: true }), JSON.stringify(redactData(manifest), null, 2), 'utf8');
  await fs.writeFile(await workPath(path.join(folder, '素材清单.md'), { create: true }), buildMarkdown(manifest), 'utf8');
  record.manifest = {
    json: path.join(folder, 'manifest.json'),
    readme: path.join(folder, '素材清单.md'),
  };
  emit('organize.done', `已整理 ${stats.downloaded} 个素材到 ${folder}`, {
    downloaded: stats.downloaded,
    bytes: stats.bytes,
    folder,
  }, 'organize');

  if (!stats.downloaded) throw new Error('没有下载到任何素材，请调整需求描述或检查网络后重试');
  save?.();
  return record;
}

function legacyTypes(counts = {}) {
  const out = [];
  if (counts.video > 0) out.push({ id: 'video', label: '视频', ext: 'mp4', kind: 'video', count: counts.video, custom: false });
  if (counts.audio > 0) out.push({ id: 'audio', label: '音乐', ext: 'mp3', kind: 'audio', count: counts.audio, custom: false });
  if (counts.image > 0) out.push({ id: 'image', label: '图片', ext: 'jpg', kind: 'image', count: counts.image, custom: false });
  return out;
}

function doneItems(record) {
  return record.items.filter((item) => item.status === 'done');
}

function buildManifest(record, types) {
  const items = doneItems(record);
  return {
    generator: '寻源 · 信息收集台',
    version: 2,
    createdAt: record.createdAt,
    completedAt: new Date().toISOString(),
    brief: record.input.brief,
    folder: record.input.folder,
    plan: record.plan,
    types: types.map((t) => ({
      id: t.id, label: t.label, ext: t.ext, kind: t.kind, count: t.count, folder: t.folder,
    })),
    stats: record.stats,
    sources: [...new Set(items.map((item) => item.source))],
    items: items.map((item) => ({
      file: item.file,
      kind: item.kind,
      typeLabel: item.typeLabel,
      ext: item.ext,
      title: item.title,
      source: item.source,
      pageUrl: item.pageUrl,
      license: item.license,
      licenseUrl: item.licenseUrl,
      author: item.author,
      bytes: item.bytes,
      sha256: item.sha256,
      query: item.query,
    })),
  };
}

function buildMarkdown(manifest) {
  const lines = [];
  lines.push(`# 素材清单 · ${manifest.brief}`);
  lines.push('');
  lines.push(`> 由「寻源」信息收集台生成于 ${new Date(manifest.completedAt).toLocaleString('zh-CN')}`);
  lines.push(`> 共 ${manifest.items.length} 个文件，合计 ${formatBytes(manifest.stats.bytes)}`);
  if (manifest.plan?.summary) lines.push(`> 需求概括：${manifest.plan.summary}`);
  lines.push('');
  lines.push('## 目录结构');
  lines.push('');
  for (const type of manifest.types) {
    const count = manifest.items.filter((item) => item.typeLabel === type.label && item.ext === type.ext).length;
    lines.push(`- \`${type.folder}/\`：${count} 个${type.label}（.${type.ext}）`);
  }
  lines.push('');
  lines.push('## 素材明细');
  lines.push('');
  lines.push('| 文件 | 类型 | 标题 | 来源 | 授权 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const item of manifest.items) {
    const title = String(item.title || '').replace(/\|/g, '\\|').slice(0, 80);
    const page = item.pageUrl ? `[${item.source}](${item.pageUrl})` : item.source;
    lines.push(`| \`${item.file}\` | ${item.typeLabel || KIND_LABEL[item.kind] || item.kind}.${item.ext || ''} | ${title} | ${page} | ${item.license || ''} |`);
  }
  const unused = manifest.stats.candidates - manifest.items.length;
  lines.push('');
  lines.push('## 授权与使用说明');
  lines.push('');
  lines.push('- 每个素材的授权信息已记录在 `manifest.json` 的 `license` / `licenseUrl` 字段中，请在成片发布前核对来源页面。');
  lines.push('- Mixkit：免费许可，可商用且无需署名；Coverr：免费许可，部分素材有署名要求；Pixabay / Pexels：按各自内容许可执行。');
  lines.push('- 自定义后缀类型的文件来自公开网页检索，版权与可用范围需自行核实，请勿直接商用未授权内容。');
  lines.push('- 素材仍归原作者所有，请勿将素材本身作为独立商品转售。');
  if (unused > 0) {
    lines.push('');
    lines.push(`> 另有 ${unused} 个候选素材未下载（数量已满足或下载失败），可在运行记录中查看。`);
  }
  return lines.join('\n') + '\n';
}
