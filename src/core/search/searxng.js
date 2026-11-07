import { getKey } from '../config.js';
import { requestJson } from '../util/http.js';
import { canonicalizeUrl } from '../util/url.js';

export const id = 'searxng';
export const label = 'SearXNG';
export const qps = 2;

export function readiness() {
  return getKey('searxng')
    ? { ready: true }
    : { ready: false, reason: '未配置 SEARXNG_BASE_URL' };
}

export async function search(query, { count = 10, signal, config } = {}) {
  const base = getKey('searxng').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 SearXNG 地址');
  const params = new URLSearchParams({
    q: String(query),
    format: 'json',
    language: 'zh-CN',
    safesearch: '0',
  });
  const data = await requestJson(`${base}/search?${params}`, {
    headers: { accept: 'application/json' },
    signal,
    timeoutMs: config?.search?.timeoutMs ?? 20000,
    retries: 1,
  });
  return (data.results || [])
    .slice(0, count)
    .map((r, i) => {
      const url = canonicalizeUrl(r.url);
      if (!url) return null;
      return {
        provider: id,
        providerRank: i,
        title: String(r.title || '').trim(),
        url,
        snippet: String(r.content || '').trim(),
        publishedAt: r.publishedDate || undefined,
        score: typeof r.score === 'number' ? Math.max(0, Math.min(1, r.score)) : undefined,
      };
    })
    .filter(Boolean);
}
