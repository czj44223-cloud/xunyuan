import { redactText, redactData } from './util/http.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 一次运行的事件流：内存订阅（SSE）+ JSONL 落盘（断线重放/历史）。 */
export class RunEvents {
  constructor(runDir) {
    this.dir = runDir;
    this.file = path.join(runDir, 'events.jsonl');
    this.seq = 0;
    this.history = [];
    this.listeners = new Set();
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const text = await fs.readFile(this.file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          this.history.push(ev);
          this.seq = Math.max(this.seq, ev.seq || 0);
        } catch { /* 跳过损坏行 */ }
      }
    } catch { /* 新运行，无历史 */ }
  }

  emit(type, { stage = '', message = '', data = null } = {}) {
    const event = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      type,
      stage,
      message: redactText(message),
      data: redactData(data),
    };
    this.history.push(event);
    if (this.history.length > 5000) this.history.splice(0, this.history.length - 5000);
    this.writeQueue = this.writeQueue
      .then(() => fs.appendFile(this.file, JSON.stringify(event) + '\n', 'utf8'))
      .catch(() => {});
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* 单个订阅者异常不影响其它订阅 */ }
    }
    return event;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  replay(afterSeq = 0) {
    return this.history.filter((e) => e.seq > afterSeq);
  }

  async flush() {
    await this.writeQueue;
  }
}
