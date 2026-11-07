import { getKey } from '../config.js';
import { postJson } from '../util/http.js';
import { canonicalizeUrl } from '../util/url.js';

export const id = 'serper';
export const label = 'Serper（Google）';
export const qps = 4;

export function readiness() {
  return getKey('serper') ? { ready: true } : { ready: false, reason: '未配置 SERPER_API_KEY' };
}

export async function search(query, { count = 10, signal, config } = {}) {
  const key = getKey('serper');
  if (!key) throw new Error('未配置 Serper API Key');
  const data = await postJson(
    'https://google.serper.dev/search',
    { q: String(query), num: Math.min(20, Math.max(1, count)), hl: 'zh-cn', gl: 'cn' },
    {
      headers: { 'x-api-key': key },
      signal,
      timeoutMs: config?.search?.timeoutMs ?? 20000,
      retries: 1,
    },
  );
  return (data.organic || [])
    .map((r, i) => {
      const url = canonicalizeUrl(r.link);
      if (!url) return null;
      return {
        provider: id,
        providerRank: i,
        title: String(r.title || '').trim(),
        url,
        snippet: String(r.snippet || '').trim(),
        publishedAt: r.date || undefined,
      };
    })
    .filter(Boolean);
}
