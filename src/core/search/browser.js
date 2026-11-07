import { redactText } from '../util/http.js';
import { getBrowserPool } from '../browser/pool.js';
import { canonicalizeUrl } from '../util/url.js';

export const id = 'browser';
export const label = '浏览器直连检索';
export const qps = 0.35;

const ENGINE_META = {
  bing: { name: 'Bing', build: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&count=20` },
  baidu: { name: '百度', build: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=20` },
  so: { name: '360', build: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}` },
};

export function readiness() { return { ready: false, reason: '安全模式禁用浏览器网络；需要隔离出口后再评估' }; }

function normalizeLink(href, landurl) {
  const direct = landurl && /^https?:\/\//i.test(landurl) ? landurl : href;
  if (!direct) return '';
  try {
    const u = new URL(direct, 'https://www.baidu.com');
    if (u.hostname.endsWith('baidu.com') && u.pathname === '/link') return u.toString();
    return u.toString();
  } catch {
    return '';
  }
}

async function extractRows(page, engine) {
  return page.evaluate((engineName) => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const text = (el, selectors) => {
      for (const sel of selectors) {
        const node = el.querySelector(sel);
        if (node && clean(node.textContent)) return clean(node.textContent);
      }
      return '';
    };
    const anchor = (el) => {
      const a = el.querySelector('h2 a') || el.querySelector('h3 a') || el.querySelector('a[href]');
      if (!a) return { href: '', landurl: '' };
      return { href: a.getAttribute('href') || '', landurl: a.getAttribute('data-landurl') || '' };
    };
    const rows = [];
    if (engineName === 'bing') {
      for (const li of document.querySelectorAll('li.b_algo')) {
        const { href, landurl } = anchor(li);
        rows.push({ title: text(li, ['h2']), href, landurl, snippet: text(li, ['p', '.b_lineclamp2', '.b_lineclamp3']) });
      }
    } else if (engineName === 'baidu') {
      for (const el of document.querySelectorAll('#content_left .c-container, #content_left div[class*="result"]')) {
        const { href, landurl } = anchor(el);
        rows.push({ title: text(el, ['h3']), href, landurl, snippet: text(el, ['.c-abstract', '.content-right_8Zs40', '[class*="content-right"]', '.c-span-last']) });
      }
    } else {
      for (const el of document.querySelectorAll('li.res-list, .result')) {
        const { href, landurl } = anchor(el);
        rows.push({ title: text(el, ['h3']), href, landurl, snippet: text(el, ['.res-desc', '.res-list p', 'p']) });
      }
    }
    return rows.filter((r) => r.title && (r.href || r.landurl)).slice(0, 30);
  }, engine);
}

async function runEngine(pool, engine, query) {
  const meta = ENGINE_META[engine];
  if (!meta) throw new Error(`未知搜索引擎：${engine}`);
  const page = await pool.newPage('search', { blockAssets: true });
  try {
    const resp = await page.goto(meta.build(query), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1200);
    const status = resp?.status() || 0;
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1500) || '').catch(() => '');
    if (/验证码|人机验证|安全验证|异常流量|unusual traffic|captcha/i.test(bodyText)) {
      throw new Error(`${meta.name} 要求人机验证`);
    }
    const rows = await extractRows(page, engine);
    if (!rows.length) {
      if (status >= 400) throw new Error(`${meta.name} 返回 HTTP ${status}`);
      throw new Error(`${meta.name} 未解析到结果（可能被拦截或页面结构变化）`);
    }
    return rows
      .map((row, i) => {
        const url = canonicalizeUrl(normalizeLink(row.href, row.landurl));
        if (!url) return null;
        return {
          provider: `browser:${engine}`,
          providerRank: i,
          title: row.title,
          url,
          snippet: row.snippet,
        };
      })
      .filter(Boolean);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function search(query, { signal, config, engine } = {}) {
  if (signal?.aborted) throw new Error('已取消');
  const pool = getBrowserPool(config);
  const engines = engine
    ? [engine]
    : (config?.providers?.browser?.engines || ['bing', 'baidu', 'so']);
  const errors = [];
  for (const name of engines) {
    try {
      const results = await runEngine(pool, name, query);
      return results;
    } catch (err) {
      errors.push(`${ENGINE_META[name]?.name || name}: ${redactText(err.message)}`);
    }
  }
  throw new Error(`浏览器检索失败（${errors.join('；')}）`);
}
