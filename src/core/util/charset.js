const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-]+)/i;
const HEADER_CHARSET_RE = /charset\s*=\s*["']?([a-zA-Z0-9_\-]+)/i;
const GB_ALIASES = new Set(['gb2312', 'gbk', 'gb18030', 'x-gbk', 'gb_2312-80', 'cp936', 'windows-936']);

export function normalizeCharset(label) {
  if (!label) return '';
  const cs = String(label).trim().toLowerCase();
  if (GB_ALIASES.has(cs)) return 'gbk';
  if (cs === 'utf8') return 'utf-8';
  if (cs === 'latin1' || cs === 'iso-8859-1' || cs === 'iso8859-1') return 'iso-8859-1';
  return cs;
}

export function detectCharset(buffer, contentType = '') {
  if (!buffer || buffer.length < 2) return 'utf-8';
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8';
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';

  const headerMatch = String(contentType || '').match(HEADER_CHARSET_RE);
  if (headerMatch) {
    const cs = normalizeCharset(headerMatch[1]);
    if (cs) return cs;
  }
  const head = buffer.subarray(0, 8192).toString('latin1');
  const metaMatch = head.match(META_CHARSET_RE) || head.match(/<\?xml[^>]+encoding\s*=\s*["']([^"']+)/i);
  if (metaMatch) {
    const cs = normalizeCharset(metaMatch[1]);
    if (cs) return cs;
  }
  return 'utf-8';
}

export function decodeBuffer(buffer, contentType = '') {
  let charset = detectCharset(buffer, contentType);
  let text;
  try {
    text = new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    charset = 'utf-8';
    text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
  if (charset === 'utf-8' && text.includes('\uFFFD')) {
    try {
      const alt = new TextDecoder('gbk', { fatal: false }).decode(buffer);
      const altBad = (alt.match(/\uFFFD/g) || []).length;
      const curBad = (text.match(/\uFFFD/g) || []).length;
      if (altBad < curBad) {
        text = alt;
        charset = 'gbk';
      }
    } catch { /* 环境不支持 gbk 时忽略 */ }
  }
  return { text: text.replace(/^\uFEFF/, ''), charset };
}

export function supportsGbk() {
  try { new TextDecoder('gbk'); return true; } catch { return false; }
}
