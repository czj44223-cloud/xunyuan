const TRACKING_EXACT = new Set([
  'gclid', 'dclid', 'fbclid', 'msclkid', 'yclid', 'twclid', 'igshid', 'si',
  'spm', 'scm', 'share_source', 'share_medium', 'share_plat', 'share_tag',
  'share_token', 'share_from', 'from_source', 'ref_src', 'ref_url', 'ref',
  'referrer', 'click_id', 'clickid', '_hsenc', '_hsmi', 'mc_cid', 'mc_eid',
  'vero_id', 'wickedid', 'oly_anon_id', 'oly_enc_id', 'rb_clickid', 's_cid',
  'mkt_tok', 'trk', 'trkCampaign', 'sc_channel', 'sc_campaign', 'sc_content',
]);
const TRACKING_PREFIXES = ['utm_', 'pk_', 'mtm_', 'hsa_', 'piwik_', 'matomo_'];

function isTrackingParam(name) {
  const key = String(name).toLowerCase();
  if (TRACKING_EXACT.has(key)) return true;
  return TRACKING_PREFIXES.some((p) => key.startsWith(p));
}

export function canonicalizeUrl(input) {
  try {
    const u = new URL(String(input).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
    for (const name of [...u.searchParams.keys()]) {
      if (isTrackingParam(name)) u.searchParams.delete(name);
    }
    let out = u.toString();
    if (u.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return null;
  }
}

export function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function isCjk(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(text || ''));
}

export function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

export function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function wordSet(s) {
  return new Set(s.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

export function jaccardWords(a, b) {
  const A = wordSet(a);
  const B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (isCjk(na) && isCjk(nb)) return diceCoefficient(na, nb);
  return Math.max(diceCoefficient(na, nb), jaccardWords(na, nb));
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'with', 'by', 'what', 'how', 'why', '2025', '2026']);

export function termOverlap(query, text) {
  const q = String(query || '').toLowerCase();
  const t = String(text || '').toLowerCase();
  if (!q || !t) return 0;
  const terms = isCjk(q)
    ? [...new Set((q.match(/[\u3400-\u9fff]{2,}|[a-z0-9]{2,}/gi) || []))]
    : [...new Set(q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP_WORDS.has(w)))];
  if (!terms.length) return 0;
  let hits = 0;
  for (const term of terms) if (t.includes(term)) hits++;
  return hits / terms.length;
}

export function safeFilename(name, fallback = 'report') {
  const cleaned = String(name || '')
    .replace(/[<>:"/\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return fallback;
  return cleaned;
}
