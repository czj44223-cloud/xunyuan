import { getKey } from '../config.js';
import { postJson } from '../util/http.js';
import { canonicalizeUrl } from '../util/url.js';

export const id = 'tavily';
export const label = 'Tavily';
export const qps = 4;

export function readiness() {
  return getKey('tavily')
    ? { ready: true }
    : { ready: true, keyless: true, reason: '免密模式（受速率限制）' };
}

export async function search(query, { count = 10, signal, config } = {}) {
  const key = getKey('tavily');
  const headers = key
    ? { authorization: `Bearer ${key}` }
    : { 'x-tavily-access-mode': 'keyless' };
  const data = await postJson(
    'https://api.tavily.com/search',
    {
      query: String(query),
      max_results: Math.min(20, Math.max(1, count)),
      search_depth: 'basic',
      topic: 'general',
      include_answer: false,
      include_raw_content: false,
    },
    {
      headers,
      signal,
      timeoutMs: config?.search?.timeoutMs ?? 20000,
      retries: 1,
    },
  );
  return (data.results || [])
    .map((r, i) => {
      const url = canonicalizeUrl(r.url);
      if (!url) return null;
      const content = String(r.content || '').trim();
      return {
        provider: id,
        providerRank: i,
        title: String(r.title || '').trim(),
        url,
        snippet: content.slice(0, 300),
        summary: content.length > 300 ? content.slice(0, 1200) : undefined,
        publishedAt: r.published_date || undefined,
        score: typeof r.score === 'number' ? Math.max(0, Math.min(1, r.score)) : undefined,
      };
    })
    .filter(Boolean);
}
