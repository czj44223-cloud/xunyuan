import { getKey } from '../config.js';
import { postJson } from '../util/http.js';

/** DeepSeek Fetch API：由对方服务器抓取并直接返回 Markdown，作为最后兜底（计费）。 */
export async function fetchWithDeepSeek(url, { signal } = {}) {
  const key = getKey('deepseek');
  if (!key) throw new Error('未配置 DeepSeek API Key，无法使用 Fetch 兜底');
  const data = await postJson(
    'https://api.deepseek.com/v1/tools/fetch',
    { url: String(url).slice(0, 8192) },
    {
      headers: { authorization: `Bearer ${key}` },
      signal,
      timeoutMs: 40000,
      retries: 1,
    },
  );
  if (!data.content) throw new Error('DeepSeek Fetch 未返回正文');
  return {
    markdown: String(data.content),
    title: String(data.title || ''),
    finalUrl: url,
    via: 'deepseek-fetch',
    status: 200,
  };
}
