import dns from 'node:dns/promises';
import net from 'node:net';

export class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
    this.code = 'SSRF_BLOCKED';
  }
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

export function isPrivateIp(rawIp) {
  const ip = String(rawIp || '').trim().toLowerCase();
  const family = net.isIP(ip);
  if (family === 4) return V4_BLOCKED.some(([base, bits]) => inCidr(ip, base, bits));
  if (family === 6) {
    // Conservative: reject mapped/special/link-local/ULA/multicast plus documentation space.
    const first = parseInt(ip.split(':')[0] || '0', 16);
    return first < 0x2000 || first > 0x3fff || ip.startsWith('2001:db8:') || ip.startsWith('2001:0:');
  }
  return true;
}

export async function assertSafeUrl(rawUrl, { allowedPorts = [80, 443] } = {}) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { throw new SsrfError('URL 无法解析'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('只允许 http/https 链接');
  if (url.username || url.password) throw new SsrfError('URL 不允许包含账号密码');
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (!allowedPorts.includes(port)) throw new SsrfError('不安全的端口 ' + port);

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new SsrfError('禁止访问内网地址');
    return url;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    const e = new Error('域名解析失败：' + host);
    e.code = 'DNS_FAILED';
    throw e;
  }
  if (!records.length) throw new SsrfError('域名无解析结果');
  for (const rec of records) {
    if (isPrivateIp(rec.address)) throw new SsrfError('域名指向内网地址（' + rec.address + '）');
  }
  return url;
}
