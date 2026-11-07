import { getKey } from '../../config.js';
import { requestJson } from '../../util/http.js';

export const id = 'pexels';
export const label = 'Pexels';
export const kinds = ['video', 'image'];

export function readiness() {
  return getKey('pexels')
    ? { ready: true, reason: '已配置 API Key' }
    : { ready: false, reason: '未配置 PEXELS_API_KEY（免费注册）' };
}

function pickVideoFile(files = []) {
  const landscape = files
    .filter((f) => f.width && f.height && f.width >= f.height)
    .sort((a, b) => b.width - a.width);
  const target = landscape.find((f) => f.width <= 1920) || landscape[0];
  return target?.link ? target : null;
}

export async function search(kind, query, { count = 12, signal, config } = {}) {
  const key = getKey('pexels');
  if (!key) throw new Error('未配置 Pexels API Key');
  const headers = { authorization: key };
  const perPage = Math.min(80, Math.max(3, count * 2));

  if (kind === 'video') {
    const params = new URLSearchParams({ query, per_page: String(perPage), orientation: 'landscape' });
    const data = await requestJson(`https://api.pexels.com/videos/search?${params}`, {
      headers, signal, timeoutMs: config?.search?.timeoutMs ?? 20000, retries: 1,
    });
    return (data.videos || []).map((hit) => {
      const file = pickVideoFile(hit.video_files);
      if (!file) return null;
      return {
        source: id,
        sourceLabel: label,
        kind: 'video',
        title: `Pexels video ${hit.id}`,
        pageUrl: hit.url,
        fileUrl: file.link,
        license: 'Pexels License（可免费商用）',
        licenseUrl: 'https://www.pexels.com/license/',
        author: hit.user?.name || 'Pexels',
        meta: { width: file.width, height: file.height, duration: hit.duration },
      };
    }).filter(Boolean);
  }

  if (kind === 'image') {
    const params = new URLSearchParams({ query, per_page: String(perPage), orientation: 'landscape' });
    const data = await requestJson(`https://api.pexels.com/v1/search?${params}`, {
      headers, signal, timeoutMs: config?.search?.timeoutMs ?? 20000, retries: 1,
    });
    return (data.photos || []).map((hit) => {
      const url = hit.src?.large2x || hit.src?.original || hit.src?.large;
      if (!url) return null;
      return {
        source: id,
        sourceLabel: label,
        kind: 'image',
        title: hit.alt || `Pexels photo ${hit.id}`,
        pageUrl: hit.url,
        fileUrl: url,
        license: 'Pexels License（可免费商用）',
        licenseUrl: 'https://www.pexels.com/license/',
        author: hit.photographer || 'Pexels',
        meta: { width: hit.width, height: hit.height },
      };
    }).filter(Boolean);
  }
  return [];
}
