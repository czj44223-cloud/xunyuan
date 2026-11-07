export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const t = setTimeout(() => { cleanup(); resolve(); }, ms);
  const onAbort = () => { cleanup(); reject(abortError()); };
  function cleanup() {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
  signal?.addEventListener('abort', onAbort, { once: true });
});

export function abortError(message = '已取消') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** 全局最小间隔 + 并发上限的限速器（用于 5 QPS 的 DeepSeek 接口等）。 */
export class RateLimiter {
  constructor({ minIntervalMs = 0, concurrency = 1, name = '' } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.name = name;
    this.semaphore = new (class {
      constructor(n) { this.n = n; this.active = 0; this.q = []; }
      acquire() {
        if (this.active < this.n) { this.active++; return Promise.resolve(() => this.release()); }
        return new Promise((r) => this.q.push(r));
      }
      release() {
        this.active--;
        const next = this.q.shift();
        if (next) { this.active++; next(() => this.release()); }
      }
    })(concurrency);
    this.nextAt = 0;
  }

  async run(fn, signal) {
    const release = await this.semaphore.acquire();
    try {
      const wait = Math.max(0, this.nextAt - Date.now());
      this.nextAt = Math.max(Date.now(), this.nextAt) + this.minIntervalMs;
      if (wait > 0) await sleep(wait, signal);
      return await fn();
    } finally {
      release();
    }
  }
}

export function createLimiterMap({ minIntervalMs, concurrency = 1 }) {
  const map = new Map();
  return (key) => {
    const k = key || '__default__';
    if (!map.has(k)) map.set(k, new RateLimiter({ minIntervalMs, concurrency, name: k }));
    return map.get(k);
  };
}
