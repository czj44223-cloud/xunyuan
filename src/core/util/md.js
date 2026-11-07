import TurndownService from 'turndown';
import { cleanWhitespace, stripHtml } from './text.js';

const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
});
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg']);

turndown.addRule('emptyLinks', {
  filter: (node) => node.nodeName === 'A' && !node.textContent.trim(),
  replacement: () => '',
});

turndown.addRule('images', {
  filter: 'img',
  replacement: () => '',
});

export function htmlToMarkdown(html) {
  try {
    return cleanWhitespace(turndown.turndown(String(html || '')));
  } catch {
    return cleanWhitespace(stripHtml(html));
  }
}
