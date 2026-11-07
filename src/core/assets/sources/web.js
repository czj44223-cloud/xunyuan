import { redactText } from '../../util/http.js';
import { Semaphore } from '../../util/semaphore.js';
import { resolveProviderIds, getProvider } from '../../search/index.js';
import { fetchHttp } from '../../fetch/http.js';
import { canonicalizeUrl } from '../../util/url.js';

const PROVIDER_ORDER = ['deepseek', 'tavily', 'bocha', 'serper', 'exa', 'browser'];

export function urlHasExt(url, ext) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const target = String(ext || '').toLowerCase().replace(/^\./, '');
    if (!target) return false;
    if (target === 'jpg' || target === 'jpeg') {
      return pathname.endsWith('.jpg') || pathname.endsWith('.jpeg');
    }
    return pathname.endsWith(`.${target}`);
  } catch {
    return false;
  }
}

function filenameTitle(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name || url;
  } catch {
    return url;
  }
}

/**
 * 自定义后缀类型的检索：用搜索源找候选网页，再从页面里提取指向目标后缀的直链。
 * 仅用于用户明确指定后缀的类型（如 .wav / .srt / .cube / .png）。
 */
export async function searchWebFiles(type, queries, { count = 4, config, signal, emit, warn } = {}) {
  const ext = String(type.ext || '').toLowerCase();
  if (!ext) return [];
  const providerIds = resolveProviderIds(PROVIDER_ORDER, config).slice(0, 3);
  if (!providerIds.length) {
    warn('自定义类型需要至少一个可用的搜索源（DeepSeek / Tavily / 浏览器等）');
    return [];
  }

  const pages = [];
  const seenPages = new Set();
  for (const query of (queries || []).slice(0, 2)) {
    for (const providerId of providerIds) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      if (pages.length >= 12) break;
      const provider = getProvider(providerId);
      if (!provider) continue;
      try {
        const found = await provider.search(`${query} filetype:${ext}`, {
          count: Math.max(6, Math.min(20, count * 3)),
          config,
          signal,
        });
        for (const item of found) {
          if (!item.url || seenPages.has(item.url)) continue;
          seenPages.add(item.url);
          pages.push({ ...item, provider: providerId });
        }
        emit('source.done', `${provider.label}：${found.length} 个候选网页`, {
          source: providerId, kind: 'file', query, count: found.length,
        }, 'search');
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        warn(`${provider.label} 检索失败（${type.label}）：${redactText(err.message)}`);
      }
    }
    if (pages.length >= 12) break;
  }

  const items = [];
  const seenFiles = new Set();
  const push = (fileUrl, pageUrl, title) => {
    const clean = canonicalizeUrl(fileUrl);
    if (!clean || seenFiles.has(clean) || !urlHasExt(clean, ext)) return;
    seenFiles.add(clean);
    items.push({
      source: 'web',
      sourceLabel: '网页检索',
      kind: type.kind,
      title: (title || '').slice(0, 120) || filenameTitle(clean),
      pageUrl: pageUrl || clean,
      fileUrl: clean,
      ext,
      license: '公开网页文件 · 请自行核实授权',
      licenseUrl: '',
      author: '',
      query: queries?.[0] || '',
      meta: {},
    });
  };

  for (const page of pages) {
    if (urlHasExt(page.url, ext)) push(page.url, page.url, page.title);
  }

  const htmlPages = pages.filter((page) => !urlHasExt(page.url, ext)).slice(0, 8);
  const semaphore = new Semaphore(2);
  await Promise.all(htmlPages.map((page) => semaphore.run(async () => {
    try {
      const doc = await fetchHttp(page.url, { config, signal });
      const re = /(?:href|src)=["']([^"']+)["']/gi;
      let match;
      let found = 0;
      while ((match = re.exec(doc.html)) && found < 20) {
        try {
          const abs = new URL(match[1], doc.finalUrl).toString();
          if (urlHasExt(abs, ext)) {
            push(abs, doc.finalUrl, filenameTitle(abs));
            found++;
          }
        } catch { /* 非法链接 */ }
      }
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      // 单个页面失败不影响其它页面
    }
  }), signal));

  return items.slice(0, Math.max(count * 3, 8));
}
