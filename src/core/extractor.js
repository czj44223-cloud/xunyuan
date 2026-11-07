import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { htmlToMarkdown } from './util/md.js';
import { cleanWhitespace, stripHtml } from './util/text.js';

const REMOVE_SELECTORS = 'script,style,noscript,iframe,svg,canvas,nav,header,footer,aside,form,button,input,select,textarea,[aria-hidden="true"]';

function visibleLength(html) {
  return stripHtml(html).replace(/\s+/g, '').length;
}

function fallbackFromDom(document, url) {
  const candidates = ['article', 'main', '[role="main"]', '#content', '.content', '.article', '.post', 'body'];
  let best = null;
  let bestLen = 0;
  for (const selector of candidates) {
    const node = document.querySelector(selector);
    if (!node) continue;
    const clone = node.cloneNode(true);
    clone.querySelectorAll(REMOVE_SELECTORS).forEach((el) => el.remove());
    const len = visibleLength(clone.innerHTML);
    if (len > bestLen) { best = clone; bestLen = len; }
  }
  if (!best) {
    const body = document.body?.cloneNode(true);
    if (!body) return '';
    body.querySelectorAll(REMOVE_SELECTORS).forEach((el) => el.remove());
    best = body;
  }
  return htmlToMarkdown(best.innerHTML);
}

function largestTextBlock(document) {
  let best = '';
  let bestLen = 0;
  for (const el of document.querySelectorAll('div,section,article,main,td')) {
    if (el.querySelector('div,section,article')) continue;
    const clone = el.cloneNode(true);
    clone.querySelectorAll(REMOVE_SELECTORS).forEach((n) => n.remove());
    const len = visibleLength(clone.innerHTML);
    if (len > bestLen) { bestLen = len; best = clone.innerHTML; }
  }
  return bestLen >= 200 ? htmlToMarkdown(best) : '';
}

export function qualityScore(markdown) {
  if (!markdown) return 0;
  const compact = markdown.replace(/\s+/g, '');
  const len = compact.length;
  const paragraphs = markdown.split(/\n{2,}/).filter((p) => p.trim().length > 40).length;
  const links = (markdown.match(/\]\(/g) || []).length;
  const linkDensity = paragraphs ? Math.min(1, links / (paragraphs * 3)) : 0;
  return Math.min(1, Math.min(1, len / 2500) * 0.55 + Math.min(1, paragraphs / 6) * 0.35 + (1 - linkDensity) * 0.1);
}

export function extractFromHtml(html, url = '') {
  const result = { title: '', markdown: '', textLength: 0, strategy: 'none', quality: 0 };
  if (!html || !html.trim()) return result;

  let source = html;
  if (source.length > 3_500_000) source = source.slice(0, 3_500_000);
  source = source.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

  let dom;
  try {
    dom = new JSDOM(source, {
      url: url || 'https://example.com/',
      contentType: 'text/html',
      virtualConsole: new VirtualConsole(),
    });
  } catch {
    return result;
  }

  const document = dom.window.document;
  const docTitle = cleanWhitespace(document.title || '');

  let article = null;
  try {
    article = new Readability(document.cloneNode(true), { charThreshold: 200 }).parse();
  } catch { /* 使用兜底 */ }

  if (article?.content && visibleLength(article.content) >= 300) {
    const markdown = htmlToMarkdown(article.content);
    if (markdown.trim().length >= 200) {
      result.title = cleanWhitespace(article.title || docTitle);
      result.markdown = markdown;
      result.strategy = 'readability';
      result.publishedAt = article.publishedTime || undefined;
      result.textLength = markdown.length;
      result.quality = qualityScore(markdown);
      return result;
    }
  }

  let markdown = fallbackFromDom(document, url);
  let strategy = 'fallback';
  if (markdown.replace(/\s+/g, '').length < 300) {
    const big = largestTextBlock(document);
    if (big.length > markdown.length) { markdown = big; strategy = 'largest-block'; }
  }
  result.title = cleanWhitespace(article?.title || docTitle);
  result.markdown = markdown;
  result.strategy = strategy;
  result.textLength = markdown.length;
  result.quality = qualityScore(markdown);
  return result;
}

export function extractFromMarkdown(markdown, title = '') {
  const text = cleanWhitespace(markdown);
  return {
    title,
    markdown: text,
    strategy: 'deepseek-fetch',
    textLength: text.length,
    quality: qualityScore(text),
  };
}
