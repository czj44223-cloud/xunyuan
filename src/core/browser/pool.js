import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { redactText } from '../util/http.js';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function detectBrowserPath(explicitPath = '') {
  const candidates = [explicitPath, process.env.CHROME_PATH, ...CHROME_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return '';
}

export class BrowserPool {
  constructor(config = {}) {
    this.config = config;
    this.browser = null;
    this.launching = null;
    this.fetchContext = null;
    this.searchContext = null;
    this.executablePath = '';
  }

  async getBrowser() {
    throw Object.assign(new Error('安全模式已禁用所有浏览器网络：尚无隔离出口，不能保证重定向/子资源与DNS重绑定安全'), { code: 'BROWSER_DISABLED' });
    /* istanbul ignore next */
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = this.#launch().finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  async #launch() {
    const explicit = this.config.executablePath || '';
    this.executablePath = detectBrowserPath(explicit);
    const options = {
      headless: this.config.headless !== false,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
      ],
    };
    if (this.executablePath) options.executablePath = this.executablePath;
    else options.channel = this.config.channel || 'chrome';

    try {
      this.browser = await chromium.launch(options);
    } catch (err) {
      const hint = this.executablePath
        ? `已找到浏览器：${this.executablePath}`
        : '未探测到本机 Chrome/Edge，请安装 Chrome，或在 .env 中设置 CHROME_PATH。';
      const e = new Error(`无法启动无头浏览器。${hint} 原始错误：${redactText(err.message)}`);
      e.code = 'BROWSER_LAUNCH_FAILED';
      throw e;
    }
    this.browser.on('disconnected', () => {
      this.browser = null;
      this.fetchContext = null;
      this.searchContext = null;
    });
    return this.browser;
  }

  async #context(kind) {
    const browser = await this.getBrowser();
    const slot = kind === 'search' ? 'searchContext' : 'fetchContext';
    if (this[slot] && !this[slot].isClosed?.()) return this[slot];
    const context = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1366, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    this[slot] = context;
    return context;
  }

  getFetchContext() { return this.#context('fetch'); }
  getSearchContext() { return this.#context('search'); }

  async newPage(kind = 'fetch', { blockAssets = true } = {}) {
    const context = await this.#context(kind);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(25000);
    if (blockAssets) {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'media' || type === 'font') return route.abort().catch(() => {});
        const url = route.request().url();
        if (/doubleclick|googletagmanager|google-analytics|hm\.baidu\.com|cnzz\.com|51\.la|umeng/i.test(url)) {
          return route.abort().catch(() => {});
        }
        return route.continue().catch(() => {});
      }).catch(() => {});
    }
    return page;
  }

  async close() {
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.browser = null;
    this.fetchContext = null;
    this.searchContext = null;
  }
}

let sharedPool = null;

export function getBrowserPool(config) {
  if (!sharedPool) sharedPool = new BrowserPool(config?.browser || {});
  else if (config?.browser) sharedPool.config = config.browser;
  return sharedPool;
}

export async function closeBrowserPool() {
  if (sharedPool) await sharedPool.close();
  sharedPool = null;
}
