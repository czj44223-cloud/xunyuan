import { redactText } from '../util/http.js';
import { fetchHttp } from './http.js';
import { fetchWithBrowser } from './browser.js';
import { fetchWithDeepSeek } from './deepseekFetch.js';
import { extractFromHtml, extractFromMarkdown, qualityScore } from '../extractor.js';
import { RateLimiter, abortError } from '../util/rate.js';

const hostLimiters = new Map();

function limiterFor(host, config) {
  if (!hostLimiters.has(host)) {
    hostLimiters.set(host, new RateLimiter({
      minIntervalMs: config?.fetch?.perHostDelayMs ?? 1000,
      concurrency: config?.fetch?.perHostConcurrency ?? 1,
      name: host,
    }));
  }
  return hostLimiters.get(host);
}

function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  return b.quality * 10 + Math.min(1, b.markdown.length / 20000) > a.quality * 10 + Math.min(1, a.markdown.length / 20000) ? b : a;
}

function finish(candidate, attempts, degraded = false) {
  return {
    title: candidate.title || '',
    markdown: candidate.markdown,
    url: candidate.finalUrl || candidate.url,
    via: candidate.via,
    strategy: candidate.strategy,
    quality: candidate.quality,
    chars: candidate.markdown.length,
    degraded,
    attempts,
  };
}

/**
 * 自适应抓取链：HTTP → 无头浏览器 → DeepSeek Fetch（可选）。
 * 每步都尝试抽取正文，质量达标即返回；否则保留质量最好的一次。
 */
export async function fetchArticle(url, { config, signal } = {}) {
  const host = (() => { try { return new URL(url).hostname; } catch { return 'invalid'; } })();
  return limiterFor(host, config).run(async () => {
    const attempts = [];
    const minChars = config?.fetch?.minChars ?? 300;
    const threshold = config?.fetch?.minQuality ?? 0.3;
    let best = null;

    if (signal?.aborted) throw abortError();

    try {
      const doc = await fetchHttp(url, { config, signal });
      const extracted = doc.text
        ? { title: '', markdown: doc.text, strategy: 'plain-text', quality: qualityScore(doc.text), textLength: doc.text.length }
        : extractFromHtml(doc.html, doc.finalUrl);
      const candidate = {
        ...extracted,
        title: extracted.title || doc.title || '',
        finalUrl: doc.finalUrl,
        via: 'http',
        url,
      };
      attempts.push({ via: 'http', ok: true, chars: candidate.markdown.length, quality: candidate.quality, strategy: candidate.strategy });
      best = better(best, candidate);
      if (candidate.quality >= threshold && candidate.markdown.length >= minChars) {
        return finish(candidate, attempts);
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      attempts.push({ via: 'http', ok: false, error: redactText(err.message), code: err.code || '' });
    }

    if (config?.fetch?.browserFallback !== false) {
      try {
        const doc = await fetchWithBrowser(url, { config, signal });
        const extracted = extractFromHtml(doc.html, doc.finalUrl);
        const candidate = {
          ...extracted,
          title: extracted.title || doc.title || '',
          finalUrl: doc.finalUrl,
          via: 'browser',
          url,
        };
        attempts.push({ via: 'browser', ok: true, chars: candidate.markdown.length, quality: candidate.quality, strategy: candidate.strategy });
        best = better(best, candidate);
        if (candidate.quality >= threshold && candidate.markdown.length >= minChars) {
          return finish(candidate, attempts);
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        attempts.push({ via: 'browser', ok: false, error: redactText(err.message), code: err.code || '' });
      }
    }

    if (config?.fetch?.deepseekFetch) {
      try {
        const doc = await fetchWithDeepSeek(url, { signal });
        const candidate = {
          ...extractFromMarkdown(doc.markdown, doc.title),
          finalUrl: url,
          via: 'deepseek-fetch',
          url,
        };
        attempts.push({ via: 'deepseek-fetch', ok: true, chars: candidate.markdown.length, quality: candidate.quality, strategy: candidate.strategy });
        best = better(best, candidate);
        if (candidate.quality >= threshold && candidate.markdown.length >= minChars) {
          return finish(candidate, attempts);
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        attempts.push({ via: 'deepseek-fetch', ok: false, error: redactText(err.message), code: err.code || '' });
      }
    }

    if (best && best.markdown.trim().length >= 100) {
      return finish(best, attempts, true);
    }
    const detail = attempts.map((a) => `${a.via}: ${a.error || '正文过短'}`).join('；');
    const err = new Error(`抓取失败（${detail || '无可用策略'}）`);
    err.attempts = attempts;
    throw err;
  }, signal);
}
