import { getBrowserPool } from '../../browser/pool.js';

export const id = 'coverr';
export const label = 'Coverr';
export const kinds = ['video'];

export function readiness() { return { ready: false, reason: '安全模式禁用浏览器网络；需要隔离出口后再评估' }; }

function slugToTitle(slug) {
  const text = slug
    .replace(/^coverr-/, '')
    .replace(/-\d+$/, '')
    .replace(/-/g, ' ')
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : slug;
}

const PREMIUM_HINT = /premium|watermark|temp-|promo|banner|paywall|subscription|logo|intro-/i;

export async function search(kind, query, { count = 12, config, signal } = {}) {
  if (!kinds.includes(kind)) return [];
  const pool = getBrowserPool(config);
  const page = await pool.newPage('search', { blockAssets: true });
  try {
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    await page.goto(`https://coverr.co/s?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1600);
    const html = await page.content();

    const titles = new Map();
    const altRe = /alt="([^"]{3,160})"[^>]*?src="https:\/\/cdn\.coverr\.co\/videos\/([a-z0-9-]+)\/thumbnail/gi;
    for (const match of html.matchAll(altRe)) {
      titles.set(match[2], match[1].trim());
    }

    const seen = new Set();
    const items = [];
    const videoRe = /https:\/\/cdn\.coverr\.co\/videos\/([a-z0-9-]+)\/1080p\.mp4/g;
    for (const match of html.matchAll(videoRe)) {
      const slug = match[1];
      if (PREMIUM_HINT.test(slug) || seen.has(slug)) continue;
      seen.add(slug);
      items.push({
        source: id,
        sourceLabel: label,
        kind: 'video',
        title: titles.get(slug) || slugToTitle(slug),
        pageUrl: `https://coverr.co/videos/${slug}`,
        fileUrl: `https://cdn.coverr.co/videos/${slug}/1080p.mp4`,
        license: 'Coverr Free License（免费商用，署名要求见页面）',
        licenseUrl: 'https://coverr.co/license',
        author: 'Coverr',
        meta: { resolution: '1080p' },
      });
      if (items.length >= Math.max(6, count * 2)) break;
    }
    return items;
  } finally {
    await page.close().catch(() => {});
  }
}
