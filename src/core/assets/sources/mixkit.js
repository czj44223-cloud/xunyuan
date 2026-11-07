import { getBrowserPool } from '../../browser/pool.js';

export const id = 'mixkit';
export const label = 'Mixkit';
export const kinds = ['video', 'audio'];

const PAGES = {
  video: 'https://mixkit.co/free-stock-video/',
  audio: 'https://mixkit.co/free-stock-music/',
};

export function readiness() { return { ready: false, reason: '安全模式禁用浏览器网络；需要隔离出口后再评估' }; }

export async function search(kind, query, { count = 12, config, signal } = {}) {
  if (!kinds.includes(kind)) return [];
  const pool = getBrowserPool(config);
  const page = await pool.newPage('search', { blockAssets: true });
  try {
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    await page.goto(`${PAGES[kind]}?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1400);
    const rows = await page.evaluate((kindName) => {
      const cards = [...document.querySelectorAll('.item-grid-card')];
      return cards.map((card) => {
        const titleNode = card.querySelector('[class*="item-grid-card__title"]') || card.querySelector('a[href*="/free-stock-"]');
        const title = (titleNode?.textContent || '').replace(/\s+/g, ' ').trim();
        const link = card.querySelector('a[href*="/free-stock-"]')?.href || '';
        if (kindName === 'video') {
          const el = card.querySelector('[data-item-grid--video-player-item-id-value]');
          const vid = el?.getAttribute('data-item-grid--video-player-item-id-value') || '';
          return { title, pageUrl: link, fileUrl: vid ? `https://assets.mixkit.co/videos/${vid}/${vid}-1080.mp4` : '' };
        }
        const el = card.querySelector('[data-audio-player-preview-url-value]');
        return {
          title,
          pageUrl: link,
          fileUrl: el?.getAttribute('data-audio-player-preview-url-value') || '',
          fileId: el?.getAttribute('data-audio-player-item-id-value') || '',
        };
      }).filter((row) => row.fileUrl && row.title);
    }, kind);

    const seen = new Set();
    return rows
      .filter((row) => {
        if (seen.has(row.fileUrl)) return false;
        seen.add(row.fileUrl);
        return true;
      })
      .slice(0, Math.max(6, count * 2))
      .map((row) => ({
        source: id,
        sourceLabel: label,
        kind,
        title: row.title,
        pageUrl: row.pageUrl,
        fileUrl: row.fileUrl,
        license: 'Mixkit Free License（可商用，无需署名）',
        licenseUrl: 'https://mixkit.co/license/',
        author: 'Mixkit',
        meta: kind === 'video' ? { resolution: '1080p' } : { format: 'mp3' },
      }));
  } finally {
    await page.close().catch(() => {});
  }
}
