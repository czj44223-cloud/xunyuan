import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENV_FILE, CONFIG_FILE } from './paths.js';

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 8787 },
  llm: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', maxInputTokens: 30000, timeoutMs: 120000 },
  search: { perProviderCount: 10, timeoutMs: 20000 },
  fetch: {
    concurrency: 4, timeoutMs: 25000, maxBytes: 5 * 1024 * 1024,
    perHostConcurrency: 1, perHostDelayMs: 1000, minChars: 300, deepseekFetch: false,
    allowedPorts: [80, 443], maxRedirects: 5,
  },
  pipeline: { fetchLimit: 8, deepFetchLimit: 25, maxRounds: 2 },
  browser: { headless: true, channel: 'chrome', executablePath: '' },
  providers: {
    deepseek: { enabled: true },
    tavily: { enabled: true },
    bocha: { enabled: true },
    serper: { enabled: true },
    exa: { enabled: true },
    searxng: { enabled: true },
    browser: { enabled: true, engines: ['bing', 'baidu', 'so'] },
  },
};

const ENV_KEYS = {
  deepseek: 'DEEPSEEK_API_KEY',
  tavily: 'TAVILY_API_KEY',
  bocha: 'BOCHA_API_KEY',
  serper: 'SERPER_API_KEY',
  exa: 'EXA_API_KEY',
  searxng: 'SEARXNG_BASE_URL',
  pixabay: 'PIXABAY_API_KEY',
  pexels: 'PEXELS_API_KEY',
  chrome: 'CHROME_PATH',
};

const SECRET_ENV_NAMES = new Set([
  'DEEPSEEK_API_KEY', 'TAVILY_API_KEY', 'BOCHA_API_KEY', 'SERPER_API_KEY', 'EXA_API_KEY',
  'PIXABAY_API_KEY', 'PEXELS_API_KEY',
]);

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== 'object' || base === null) return override ?? base;
  if (typeof override !== 'object' || override === null) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loadEnvFile() {
  try { process.loadEnvFile(ENV_FILE); } catch { /* .env 不存在时忽略 */ }
}

export function loadConfig() {
  loadEnvFile();
  const userConfig = readJsonSafe(CONFIG_FILE) || {};
  const cfg = deepMerge(DEFAULTS, userConfig);
  if (process.env.CHROME_PATH) cfg.browser.executablePath = process.env.CHROME_PATH;
  cfg.server = { host: '127.0.0.1', port: 8787 };
  cfg.llm.baseUrl = 'https://api.deepseek.com';
  cfg.fetch.browserFallback = false;
  cfg.browser.disabled = true;
  cfg.providers.browser.enabled = false;
  return cfg;
}

export function getKey(providerId) {
  const name = ENV_KEYS[providerId];
  return name ? (process.env[name] || '').trim() : '';
}

export function hasAnyKey() {
  return Boolean(getKey('deepseek'));
}

export function maskSecret(value) { return value ? '已配置（隐藏）' : ''; }

export function providerConfig() {
  return {
    deepseek: { key: getKey('deepseek'), baseUrl: 'https://api.deepseek.com' },
    tavily: { key: getKey('tavily'), baseUrl: 'https://api.tavily.com' },
    bocha: { key: getKey('bocha'), baseUrl: 'https://api.bochaai.com' },
    serper: { key: getKey('serper'), baseUrl: 'https://google.serper.dev' },
    exa: { key: getKey('exa'), baseUrl: 'https://api.exa.ai' },
    searxng: { key: getKey('searxng'), baseUrl: getKey('searxng') },
    pixabay: { key: getKey('pixabay'), baseUrl: 'https://pixabay.com' },
    pexels: { key: getKey('pexels'), baseUrl: 'https://api.pexels.com' },
  };
}

export function describeConfig(cfg = loadConfig()) {
  const keys = {};
  for (const [id, envName] of Object.entries(ENV_KEYS)) {
    if (id === 'chrome') continue;
    const v = (process.env[envName] || '').trim();
    keys[id] = { configured: Boolean(v), masked: maskSecret(v) };
  }
  return {
    server: cfg.server,
    llm: cfg.llm,
    search: cfg.search,
    fetch: cfg.fetch,
    pipeline: cfg.pipeline,
    browser: cfg.browser,
    providers: cfg.providers,
    keys,
    keyless: { tavily: true },
  };
}

function formatEnvValue(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  return /[\s#"']/.test(v) ? JSON.stringify(v) : v;
}

export function saveConfigPatch(patch = {}) {
  if (patch.config?.llm?.baseUrl !== undefined && patch.config.llm.baseUrl !== 'https://api.deepseek.com') throw Object.assign(new Error('只允许官方DeepSeek目标'), { status: 400 });
  if (patch.config?.server || patch.config?.browser) throw Object.assign(new Error('安全模式不允许修改监听或浏览器设置'), { status: 400 });
  const userConfig = readJsonSafe(CONFIG_FILE) || {};
  const nextConfig = deepMerge(userConfig, patch.config || {});
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(nextConfig, null, 2) + '\n', 'utf8');

  const envUpdates = {};
  for (const [providerId, value] of Object.entries(patch.secrets || {})) {
    const envName = ENV_KEYS[providerId];
    if (!envName || !SECRET_ENV_NAMES.has(envName) && envName !== 'SEARXNG_BASE_URL') continue;
    if (value === undefined || value === null || value === '') continue;
    envUpdates[envName] = String(value).trim();
    process.env[envName] = String(value).trim();
  }
  if (patch.chromePath !== undefined) {
    envUpdates.CHROME_PATH = String(patch.chromePath || '').trim();
    process.env.CHROME_PATH = envUpdates.CHROME_PATH;
  }
  if (Object.keys(envUpdates).length) mergeEnvFile(envUpdates);
  return { ok: true };
}

function mergeEnvFile(updates) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/); } catch { /* 新建 */ }
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] in updates) {
      out.push(`${m[1]}=${formatEnvValue(updates[m[1]])}`);
      seen.add(m[1]);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}=${formatEnvValue(v)}`);
  }
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  fs.writeFileSync(ENV_FILE, text, { encoding: 'utf8', mode: 0o600 });
}

export { ROOT, DEFAULTS };
