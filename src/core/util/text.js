export function cleanWhitespace(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/[​-‏‪-‮]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function firstSentences(text, maxChars = 260) {
  const s = cleanWhitespace(text);
  if (s.length <= maxChars) return s;
  const slice = s.slice(0, maxChars * 2);
  const parts = slice.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [];
  let out = '';
  for (const part of parts) {
    if ((out + part).length > maxChars) break;
    out += part;
  }
  return (out || s.slice(0, maxChars)).trim() + (out && out.length < s.length ? '…' : '');
}

export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { /* 继续尝试截取 */ }
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, String.fromCharCode(39));
}

export function csvCell(value) {
  const s = String(value ?? '').replace(/\r?\n/g, ' ');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function truncateChars(text, maxChars) {
  const s = String(text || '');
  return s.length > maxChars ? s.slice(0, maxChars) + '\n\n…（内容过长，已截断）' : s;
}
