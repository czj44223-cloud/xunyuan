import { getKey } from '../config.js';
import { postJson } from '../util/http.js';
import { canonicalizeUrl } from '../util/url.js';

export const id = 'exa';
export const label = 'Exa';
export const qps = 4;

export function readiness() {
  return getKey('exa') ? { ready: true } : { ready: false, reason: '未配置 EXA_API_KEY' };
}

export async function search(query, { count = 10, signal, config } = {}) {
  const key = getKey('exa');
  if (!key) throw new Error('未配置 Exa API Key');
  const data = await postJson(
    'https://api.exa.ai/search',
    {
      query: String(query),
      numResults: Math.min(25, Math.max(1, count)),
      type: 'auto',
      contents: { text: { maxCharacters: 1000 } },
    },
    {
      headers: { 'x-api-key': key },
      signal,
      timeoutMs: config?.search?.timeoutMs ?? 20000,
      retries: 1,
    },
  );
  return (data.results || [])
    .map((r, i) => {
      const url = canonicalizeUrl(r.url);
      if (!url) return null;
      const text = String(r.text || '').trim();
      return {
        provider: id,
        providerRank: i,
        title: String(r.title || '').trim(),
        url,
        snippet: text.slice(0, 300),
        summary: text.length > 300 ? text.slice(0, 1200) : undefined,
        publishedAt: r.publishedDate || undefined,
        score: typeof r.score === 'number' ? Math.max(0, Math.min(1, r.score)) : undefined,
      };
    })
    .filter(Boolean);
}
