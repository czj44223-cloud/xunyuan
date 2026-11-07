/** 粗略 token 估算：中文约 1 token/字，拉丁约 4 字符/token，标点/空白约 0.4。 */
export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  let other = 0;
  let space = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x3040 && code <= 0x30ff)) cjk++;
    else if (/\s/.test(ch)) space++;
    else other++;
  }
  return Math.ceil(cjk + other / 3.6 + space * 0.15);
}

export function truncateToTokens(text, maxTokens, { maxChars = Infinity } = {}) {
  const s = String(text || '');
  if (!s) return { text: '', truncated: false };
  if (estimateTokens(s) <= maxTokens && s.length <= maxChars) return { text: s, truncated: false };

  const paragraphs = s.split(/\n{2,}/).filter(Boolean);
  const out = [];
  let used = 0;
  let chars = 0;
  for (const p of paragraphs) {
    const cost = estimateTokens(p) + 1;
    if (used + cost > maxTokens || chars + p.length > maxChars) {
      if (!out.length) {
        const budgetChars = Math.min(maxChars, Math.floor(maxTokens * (cjkRatio(p) ? 0.9 : 3.2)));
        out.push(p.slice(0, budgetChars));
      }
      break;
    }
    out.push(p);
    used += cost;
    chars += p.length;
  }
  return { text: out.join('\n\n'), truncated: true };
}

function cjkRatio(s) {
  const total = s.length || 1;
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length;
  return cjk / total;
}
