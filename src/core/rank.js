import { titleSimilarity, termOverlap, siteOf } from './util/url.js';

function resultScore(r) {
  if (typeof r.score === 'number' && Number.isFinite(r.score)) return Math.max(0, Math.min(1, r.score));
  const rank = Number.isFinite(r.providerRank) ? r.providerRank : 10;
  return 1 / (1 + rank * 0.35);
}

function authorityScore(r) {
  if (typeof r.authority === 'number' && r.authority >= 0) return Math.min(1, r.authority / 4);
  return 0.5;
}

function recencyScore(publishedAt) {
  if (!publishedAt) return 0.5;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return 0.5;
  const days = (Date.now() - t) / 86400000;
  if (days < 0) return 0.6;
  if (days <= 30) return 1;
  if (days <= 180) return 0.85;
  if (days <= 365) return 0.7;
  if (days <= 1095) return 0.5;
  return 0.3;
}

function mergeInto(target, extra) {
  target.sources = [...new Set([...(target.sources || []), ...(extra.sources || [])])];
  target.providerRank = Math.min(target.providerRank ?? 99, extra.providerRank ?? 99);
  if ((extra.snippet || '').length > (target.snippet || '').length) target.snippet = extra.snippet;
  if ((extra.summary || '').length > (target.summary || '').length) target.summary = extra.summary;
  target.score = Math.max(target.score ?? 0, extra.score ?? 0);
  if (typeof extra.authority === 'number') {
    target.authority = typeof target.authority === 'number'
      ? Math.max(target.authority, extra.authority)
      : extra.authority;
  }
  if (!target.publishedAt && extra.publishedAt) target.publishedAt = extra.publishedAt;
  if (!target.siteName && extra.siteName) target.siteName = extra.siteName;
}

/** URL 精确去重 → 标题相似度去重 → 融合排序。 */
export function mergeAndRank(results, { query = '', limit = 20 } = {}) {
  const byUrl = new Map();
  for (const raw of results) {
    if (!raw?.url) continue;
    const r = {
      ...raw,
      id: raw.id || raw.url,
      sources: [raw.provider],
      snippet: raw.snippet || raw.summary || '',
    };
    const existing = byUrl.get(raw.url);
    if (existing) mergeInto(existing, r);
    else byUrl.set(raw.url, r);
  }

  const merged = [];
  for (const item of byUrl.values()) {
    let duplicate = null;
    for (const m of merged) {
      if (titleSimilarity(m.title, item.title) >= 0.85) { duplicate = m; break; }
    }
    if (duplicate) mergeInto(duplicate, item);
    else merged.push(item);
  }

  for (const r of merged) {
    const providerBase = Math.max(...r.sources.map((id) => (id === r.provider ? resultScore(r) : 0.55)));
    const multi = Math.min(1, (r.sources.length - 1) / 2);
    const overlap = termOverlap(query, [r.title, r.snippet, r.summary].filter(Boolean).join(' '));
    r.rankScore =
      0.45 * providerBase +
      0.2 * authorityScore(r) +
      0.15 * overlap +
      0.1 * recencyScore(r.publishedAt) +
      0.1 * multi;
    r.siteName = r.siteName || siteOf(r.url);
  }

  merged.sort((a, b) => b.rankScore - a.rankScore);
  const out = merged.slice(0, limit).map((r, i) => ({ ...r, id: `s${i + 1}` }));
  return out;
}
