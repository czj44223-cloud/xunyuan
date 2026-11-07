import { redactText } from '../util/http.js';
import * as deepseek from './deepseek.js';
import * as tavily from './tavily.js';
import * as bocha from './bocha.js';
import * as serper from './serper.js';
import * as exa from './exa.js';
import * as searxng from './searxng.js';
import * as browser from './browser.js';
import { createLimiterMap } from '../util/rate.js';

export const PROVIDERS = [deepseek, tavily, bocha, serper, exa, searxng, browser];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id) {
  return BY_ID.get(id);
}

export function listProviders() {
  return PROVIDERS.map((p) => {
    const status = p.readiness();
    return { id: p.id, label: p.label, qps: p.qps, ...status };
  });
}

export function resolveProviderIds(requested, config) {
  const configured = PROVIDERS
    .filter((p) => config?.providers?.[p.id]?.enabled !== false)
    .filter((p) => p.readiness().ready)
    .map((p) => p.id);
  if (!requested?.length) return configured;
  return requested.filter((id) => BY_ID.has(id) && configured.includes(id));
}

export async function searchAll({ queries, providerIds, count = 10, signal, config, emit, stats }) {
  const ids = (providerIds?.length ? providerIds : resolveProviderIds([], config)).filter((id) => BY_ID.has(id));
  if (!ids.length) {
    const detail = listProviders()
      .filter((p) => !p.ready)
      .map((p) => `${p.label}：${p.reason || '不可用'}`)
      .join('；');
    throw new Error(`没有可用的搜索源${detail ? '（' + detail + '）' : '，请检查配置'}`);
  }

  const limiterFor = createLimiterMap({ minIntervalMs: 250, concurrency: 2 });
  const tasks = [];
  for (const q of queries) {
    for (const id of ids) {
      const provider = BY_ID.get(id);
      const limiter = limiterFor(id);
      limiter.minIntervalMs = Math.max(100, Math.round(1000 / (provider.qps || 2)));
      tasks.push(
        limiter
          .run(async () => {
            const t0 = Date.now();
            const results = await provider.search(q, { count, signal, config });
            stats.searches++;
            emit?.('search.provider.done', `${provider.label}：${results.length} 条结果`, { provider: id, query: q, count: results.length, ms: Date.now() - t0 }, 'search');
            return results;
          }, signal)
          .catch((err) => {
            emit?.('search.provider.failed', `${provider.label} 失败：${redactText(err.message)}`, { provider: id, query: q, error: redactText(err.message), status: err.status || 0 }, 'search');
            return { error: { provider: id, query: q, message: redactText(err.message), status: err.status || 0 } };
          }),
      );
    }
  }

  const settled = await Promise.allSettled(tasks);
  const results = [];
  const errors = [];
  for (const item of settled) {
    if (item.status !== 'fulfilled') {
      errors.push({ provider: 'unknown', query: '', message: item.reason?.message || String(item.reason) });
      continue;
    }
    if (item.value?.error) errors.push(item.value.error);
    else if (Array.isArray(item.value)) results.push(...item.value);
  }
  if (!results.length && errors.length) {
    const detail = [...new Set(errors.map((e) => `${e.provider}: ${e.message}`))].join('；');
    throw new Error(`所有搜索源均未返回结果（${detail}）`);
  }
  return { results, errors, providersUsed: ids };
}

export async function testProvider(id, config) {
  const provider = BY_ID.get(id);
  if (!provider) throw new Error('未知搜索源');
  const results = await provider.search('OpenAI', { count: 2, config, signal: AbortSignal.timeout(20000) });
  return { ok: true, count: results.length };
}
