import { redactText } from '../util/http.js';
import { assertSafeUrl, SsrfError } from '../util/ssrf.js';
import { decodeBuffer } from '../util/charset.js';
import { requestBuffer } from '../util/http.js';

const HTML_TYPES = /text\/html|application\/xhtml\+xml|text\/plain/i;

/** 纯 HTTP 抓取：手动跟随重定向，每一跳都做 SSRF 校验。 */
export async function fetchHttp(url, { config, signal } = {}) {
  const allowedPorts = config?.fetch?.allowedPorts || [80, 443];
  const maxRedirects = config?.fetch?.maxRedirects ?? 5;
  const timeoutMs = config?.fetch?.timeoutMs ?? 25000;
  const maxBytes = config?.fetch?.maxBytes ?? 5 * 1024 * 1024;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(current, { allowedPorts });
    const res = await requestBuffer(current, {
      signal,
      timeoutMs,
      maxBytes,
      retries: 1,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('重定向缺少 Location');
      const next = new URL(location, current).toString();
      try {
        await assertSafeUrl(next, { allowedPorts });
      } catch (err) {
        if (err instanceof SsrfError) throw new SsrfError(`重定向到不安全地址：${redactText(err.message)}`);
        throw err;
      }
      current = next;
      continue;
    }

    if (res.status >= 400) {
      const err = new Error(`页面返回 HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType && !HTML_TYPES.test(contentType)) {
      throw new Error(`不支持的内容类型：${contentType.split(';')[0]}`);
    }
    if (!res.buffer.length) throw new Error('页面内容为空');

    const { text, charset } = decodeBuffer(res.buffer, contentType);
    return {
      html: text,
      text: contentType.includes('text/plain') ? text : undefined,
      status: res.status,
      finalUrl: current,
      contentType,
      charset,
      bytes: res.buffer.length,
      via: 'http',
    };
  }
  throw new Error(`重定向次数超过 ${maxRedirects} 次`);
}
