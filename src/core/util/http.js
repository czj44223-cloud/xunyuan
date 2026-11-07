import { safeFetch } from './safeFetch.js';
import { abortError, sleep } from './rate.js';

const SECRET_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'api-key', 'x-tavily-access-mode']);

export class HttpError extends Error {
  constructor(message, { status = 0, code = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code || (status ? `HTTP_${status}` : 'NETWORK');
    this.body = body;
  }
}

export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADER_NAMES.has(k.toLowerCase()) ? '••••' : v;
  }
  return out;
}

export function redactText(text) {
  let value = String(text || '');
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|SESSION)/i.test(name) && secret && secret.length >= 6) value = value.split(secret).join('[REDACTED]');
  }
  return value.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|tvly-)[A-Za-z0-9_-]{6,}/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|session)["'\s:=]+)[A-Za-z0-9._-]{6,}/gi, '$1[REDACTED]');
}

function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function backoffMs(attempt) {
  return Math.min(4000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function retryAfterMs(res) {
  const value = res.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(10000, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(10000, Math.max(0, date - Date.now())) : null;
}

async function readLimited(res, maxBytes) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new HttpError(`响应体超过上限 ${Math.round(maxBytes / 1024)}KB`, { status: res.status, code: 'BODY_TOO_LARGE' });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function requestBuffer(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    signal,
    timeoutMs = 20000,
    retries = 1,
    maxBytes = 5 * 1024 * 1024,
    retryStatuses = [408, 429, 500, 502, 503, 504],
    redirect = 'manual',
  } = options;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw abortError();
    try {
      const res = await safeFetch(url, {
        method,
        headers,
        body,
        redirect,
        signal: withTimeout(signal, timeoutMs),
      });

      if (retryStatuses.includes(res.status) && attempt < retries) {
        const wait = retryAfterMs(res) ?? backoffMs(attempt);
        try { await res.body?.cancel(); } catch { /* ignore */ }
        await sleep(wait, signal);
        continue;
      }

      const buffer = await readLimited(res, maxBytes);
      return { status: res.status, headers: res.headers, buffer, url };
    } catch (err) {
      if (signal?.aborted) throw abortError();
      lastError = err;
      if (err instanceof HttpError && err.code === 'BODY_TOO_LARGE') throw err;
      if (attempt < retries) {
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new HttpError(`请求超时（${Math.round(timeoutMs / 1000)}s）`, { code: 'TIMEOUT' });
      }
      throw new HttpError(`网络请求失败：${redactText(err.message)}`, { code: 'NETWORK' });
    }
  }
  throw lastError || new HttpError('请求失败');
}

export async function requestJson(url, options = {}) {
  const res = await requestBuffer(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers || {}) },
  });
  const text = res.buffer.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { /* 交由下面报错 */ }

  if (res.status < 200 || res.status >= 300) {
    const apiMessage = json?.error?.message || json?.message || '';
    const detail = redactText(apiMessage || text.slice(0, 300));
    throw new HttpError(`HTTP ${res.status}${detail ? '：' + detail : ''}`, {
      status: res.status,
      code: json?.error?.code || `HTTP_${res.status}`,
      body: detail,
    });
  }
  if (!json) {
    throw new HttpError('返回内容不是合法 JSON', { status: res.status, code: 'BAD_JSON', body: redactText(text.slice(0, 300)) });
  }
  return json;
}

export function postJson(url, payload, { headers = {}, ...rest } = {}) {
  return requestJson(url, {
    ...rest,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

export function getJson(url, { headers = {}, ...rest } = {}) {
  return requestJson(url, { ...rest, method: 'GET', headers });
}

export function redactData(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /^(?:authorization|api[_-]?key|password|token|secret|session)$/i.test(k) ? '[REDACTED]' : redactData(v)]));
  return value;
}
