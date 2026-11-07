import { redactText } from '../util/http.js';
import { workPath } from '../util/workspace.js';
import { safeFetch } from '../util/safeFetch.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { assertSafeUrl } from '../util/ssrf.js';
import { abortError, sleep } from '../util/rate.js';
import { safeFilename } from '../util/url.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const ALLOWED_TYPES = {
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'application/octet-stream'],
  audio: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'application/octet-stream'],
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'application/octet-stream'],
  file: [],
};

const DEFAULT_MAX_BYTES = {
  video: 220 * 1024 * 1024,
  audio: 40 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  file: 100 * 1024 * 1024,
};

const DEFAULT_EXT = { video: '.mp4', audio: '.mp3', image: '.jpg' };

export function extensionFor(item, kind) {
  const match = String(item.fileUrl || '').match(/\.(mp4|webm|mov|m4v|mp3|wav|ogg|m4a|jpg|jpeg|png|webp|avif|gif)(?:$|[?#])/i);
  if (match) return '.' + match[1].toLowerCase().replace('jpeg', 'jpg');
  return DEFAULT_EXT[kind] || '.bin';
}

export function assetFilename(item, index, ext) {
  const base = safeFilename(item.title, 'asset')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
    .replace(/[-.]+$/, '');
  return `${String(index).padStart(2, '0')}_${base || 'asset'}_${item.source}${ext}`;
}

export async function uniquePath(dir, filename) {
  const ext = filename.match(/\.[^.]+$/)?.[0] || '';
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  for (let n = 1; n < 200; n++) {
    const candidate = n === 1 ? filename : `${stem}-${n}${ext}`;
    const full = `${dir}/${candidate}`;
    try {
      await fsp.access(full);
    } catch {
      return full;
    }
  }
  return `${dir}/${Date.now()}-${filename}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** 流式下载到本地文件：逐跳 SSRF 校验、大小限制、空闲超时、失败重试、sha256。 */
export async function downloadAsset(item, destPath, opts = {}) {
  const attempts = 2;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await downloadOnce(item, destPath, opts);
    } catch (err) {
      if (err?.name === 'AbortError' && opts.signal?.aborted) throw err;
      lastError = err;
      if (attempt < attempts - 1) await sleep(1200, opts.signal);
    }
  }
  throw lastError;
}

async function downloadOnce(item, destPath, { kind, config, signal, referer } = {}) {
  destPath = await workPath(destPath, { create: true });
  const maxBytes = config?.assets?.maxBytes?.[kind] || DEFAULT_MAX_BYTES[kind] || 100 * 1024 * 1024;
  const overallMs = config?.assets?.downloadTimeoutMs || 20 * 60 * 1000;
  const idleMs = config?.assets?.idleTimeoutMs || 90000;
  const allowedPorts = config?.fetch?.allowedPorts || [80, 443];
  const headers = {
    'user-agent': UA,
    accept: '*/*',
    ...(referer ? { referer } : {}),
  };

  let current = item.fileUrl;
  for (let hop = 0; hop <= 5; hop++) {
    if (signal?.aborted) throw abortError();
    await assertSafeUrl(current, { allowedPorts });

    const controller = new AbortController();
    let idleTimer = null;
    const overallTimer = setTimeout(() => controller.abort(), overallMs);
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleMs);
    };
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    resetIdle();

    try {
      let res;
      try {
        res = await safeFetch(current, { headers, redirect: 'manual', signal: controller.signal });
      } catch (err) {
        if (signal?.aborted) throw abortError();
        if (err.name === 'AbortError') throw new Error('下载超时（长时间无响应）');
        throw new Error(`下载连接失败：${redactText(err.message)}`);
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new Error('重定向缺少 Location');
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);

      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const allowed = ALLOWED_TYPES[kind] || [];
      if (contentType && allowed.length && !allowed.includes(contentType)) {
        throw new Error(`内容类型不符：${contentType}`);
      }
      if (kind === 'file' && /text\/html|application\/json/i.test(contentType)) {
        throw new Error('返回的是网页而不是文件');
      }
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared && declared > maxBytes) throw new Error(`文件过大（${formatBytes(declared)}）`);

      const tmp = await workPath(`${destPath}.part-${process.pid}`, { create: true });
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
      let total = 0;
      try {
        for await (const chunk of res.body) {
          resetIdle();
          total += chunk.length;
          if (total > maxBytes) throw new Error(`文件超过大小上限 ${formatBytes(maxBytes)}`);
          hash.update(chunk);
          if (!out.write(chunk)) await once(out, 'drain');
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
        await workPath(destPath, { create: true });
        await fsp.rename(tmp, destPath);
        return { bytes: total, sha256: hash.digest('hex'), contentType };
      } catch (err) {
        out.destroy();
        await fsp.unlink(tmp).catch(() => {});
        if (signal?.aborted) throw abortError();
        if (controller.signal.aborted) throw new Error('下载超时（连接空闲时间过长）');
        throw err;
      }
    } finally {
      clearTimeout(overallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new Error('重定向次数过多');
}
