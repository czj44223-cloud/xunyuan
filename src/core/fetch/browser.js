import { getBrowserPool } from '../browser/pool.js';
import { assertSafeUrl } from '../util/ssrf.js';

const BLOCKED_HINT = /验证码|人机验证|安全验证|访问过于频繁|异常流量|unusual traffic|captcha|access denied|forbidden/i;

/** 无头浏览器抓取：执行 JS 后再取完整 DOM。 */
export async function fetchWithBrowser(url, { config, signal } = {}) {
  await assertSafeUrl(url, { allowedPorts: config?.fetch?.allowedPorts || [80, 443] });
  const pool = getBrowserPool(config);
  const timeoutMs = config?.fetch?.timeoutMs ?? 25000;
  const page = await pool.newPage('fetch', { blockAssets: true });
  try {
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => (document.body?.innerText || '').length > 300, { timeout: 3000 }).catch(() => {});

    const status = response?.status() ?? 0;
    if (status >= 400) {
      const err = new Error(`页面返回 HTTP ${status}`);
      err.status = status;
      throw err;
    }

    const finalUrl = page.url();
    await assertSafeUrl(finalUrl, { allowedPorts: config?.fetch?.allowedPorts || [80, 443] });

    const html = await page.content();
    const title = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1200) || '').catch(() => '');
    if (BLOCKED_HINT.test(title) || BLOCKED_HINT.test(bodyText.slice(0, 600))) {
      const err = new Error('页面疑似验证码/访问拦截');
      err.code = 'BLOCKED';
      throw err;
    }
    return {
      html,
      title,
      status,
      finalUrl,
      via: 'browser',
      bytes: html.length,
    };
  } finally {
    await page.close().catch(() => {});
  }
}
