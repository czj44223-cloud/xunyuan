// Fail closed if the sanitizer is unavailable, even when marked loaded successfully.
export function renderSafeMarkdown(markdown, { marked, DOMPurify } = {}) {
  const text = String(markdown || '');
  if (!marked?.parse || !DOMPurify?.sanitize) return '<pre>' + text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') + '</pre>';
  return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), { ADD_ATTR: ['target'] });
}
