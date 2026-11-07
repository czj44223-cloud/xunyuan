export class Semaphore {
  constructor(limit = 1) {
    this.limit = Math.max(1, limit | 0);
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next(() => this.release());
    }
  }

  async run(fn) {
    const release = await this.acquire();
    try { return await fn(); } finally { release(); }
  }
}

export function createKeyedLimiter(limit = 1) {
  const map = new Map();
  return (key) => {
    const k = key || '__default__';
    if (!map.has(k)) map.set(k, new Semaphore(limit));
    return map.get(k);
  };
}
