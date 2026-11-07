import { getKey } from '../config.js';
import { postJson } from '../util/http.js';
import { canonicalizeUrl } from '../util/url.js';

export const id = 'deepseek';
export const label = 'DeepSeek 搜索';
export const qps = 4;

export function readiness() {
  return getKey('deepseek')
    ? { ready: true }
    : { ready: false, reason: '未配置 DEEPSEEK_API_KEY' };
}

export async function search(query, { count = 10, signal, config } = {}) {
  const key = getKey('deepseek');
  if (!key) throw new Error('未配置 DeepSeek API Key');
  const data = await postJson(
    'https://api.deepseek.com/v1/tools/search',
    { query: String(query).slice(0, 128), count: Math.min(50, Math.max(1, count)) },
    {
      headers: { authorization: `Bearer ${key}` },
      signal,
      timeoutMs: config?.search?.timeoutMs ?? 20000,
      retries: 2,
    },
  );
  return (data.results || [])
    .map((r, i) => {
      const url = canonicalizeUrl(r.url);
      if (!url) return null;
      return {
        provider: id,
        providerRank: i,
        title: String(r.title || '').trim(),
        url,
        snippet: String(r.snippet || '').trim(),
        summary: String(r.summary || '').trim() || undefined,
        publishedAt: r.date || undefined,
        siteName: r.site_name || undefined,
        score: typeof r.rerank_score === 'number' ? Math.max(0, Math.min(1, r.rerank_score / 3)) : undefined,
        authority: typeof r.authority === 'number' ? r.authority : undefined,
      };
    })
    .filter(Boolean);
}
