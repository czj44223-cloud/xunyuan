import { redactText } from '../../util/http.js';
import * as mixkit from './mixkit.js';
import * as coverr from './coverr.js';
import * as pixabay from './pixabay.js';
import * as pexels from './pexels.js';

export const SOURCES = [mixkit, coverr, pixabay, pexels];

export const ASSET_KINDS = [
  { id: 'video', label: '视频' },
  { id: 'audio', label: '音乐' },
  { id: 'image', label: '图片' },
];

export function listAssetSources() {
  return SOURCES.map((source) => ({
    id: source.id,
    label: source.label,
    kinds: source.kinds,
    ...source.readiness(),
  }));
}

export function resolveAssetSources(requested, kinds) {
  const usable = SOURCES.filter((s) => s.kinds.some((k) => kinds.includes(k)) && s.readiness().ready);
  if (!requested?.length) return usable.map((s) => s.id);
  return requested.filter((id) => usable.some((s) => s.id === id));
}

export async function searchCandidates({ kinds, queriesByKind, counts, sourceIds, config, signal, emit, warn }) {
  const itemsByKind = {};
  const errors = [];

  for (const kind of kinds) {
    const need = Number(counts[kind] || 0);
    if (need <= 0) { itemsByKind[kind] = []; continue; }

    const active = SOURCES.filter((s) => s.kinds.includes(kind) && s.readiness().ready && sourceIds.includes(s.id));
    if (!active.length) {
      warn(`没有可用于${kind === 'video' ? '视频' : kind === 'audio' ? '音乐' : '图片'}的素材源，已跳过`);
      itemsByKind[kind] = [];
      continue;
    }

    const queries = (queriesByKind[kind]?.length ? queriesByKind[kind] : []).slice(0, 3);
    if (!queries.length) queries.push(kind);

    const items = [];
    const seen = new Set();
    const target = Math.max(6, need * 3);

    for (const query of queries) {
      for (const source of active) {
        if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
        if (items.length >= target) break;
        try {
          const found = await source.search(kind, query, { count: need, config, signal });
          let added = 0;
          for (const item of found) {
            if (seen.has(item.fileUrl)) continue;
            seen.add(item.fileUrl);
            items.push({ ...item, query });
            added++;
          }
          emit('source.done', `${source.label}：${added} 个候选`, { source: source.id, kind, query, count: added }, 'search');
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
          const message = `${source.label} 检索失败：${redactText(err.message)}`;
          errors.push({ source: source.id, kind, query, message });
          emit('source.failed', message, { source: source.id, kind, query, error: redactText(err.message) }, 'search');
          warn(message);
        }
      }
      if (items.length >= target) break;
    }

    itemsByKind[kind] = items;
    emit('kind.done', `${kind === 'video' ? '视频' : kind === 'audio' ? '音乐' : '图片'}候选 ${items.length} 个`, {
      kind, count: items.length,
    }, 'search');
  }

  return { itemsByKind, errors };
}
