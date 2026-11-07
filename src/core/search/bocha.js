import { getKey } from '../config.js';
import { postJson } from '../util/http.js';
import { canonicalizeUrl } from '../util/url.js';

export const id = 'bocha';
export const label = '博查 Bocha';
export const qps = 4;

export function readiness() {
  return getKey('bocha') ? { ready: true } : { ready: false, reason: '未配置 BOCHA_API_KEY' };
}

export async function search(query, { count = 10, signal, config } = {}) {
  const key = getKey('bocha');
  if (!key) throw new Error('未配置博查 API Key');
  const data = await postJson(
    'https://api.bochaai.com/v1/web-search',
    { query: String(query), count: Math.min(50, Math.max(1, count)), freshness: 'noLimit', summary: true },
    {
      headers: { authorization: `Bearer ${key}` },
      signal,
      timeoutMs: config?.search?.timeoutMs ?? 20000,
      retries: 1,
    },
  );
  if (data.code && data.code !== 200) throw new Error(data.msg || `博查接口返回错误码 ${data.code}`);
  const pages = data.data?.webPages?.value || [];
  return pages
    .map((r, i) => {
      const url = canonicalizeUrl(r.url);
      if (!url) return null;
      return {
        provider: id,
        providerRank: i,
        title: String(r.name || '').trim(),
        url,
        snippet: String(r.snippet || '').trim(),
        summary: String(r.summary || '').trim() || undefined,
        publishedAt: r.datePublished || undefined,
        siteName: r.siteName || undefined,
      };
    })
    .filter(Boolean);
}
