// No proxy, pooling, or implicit redirects: validate the address used at connection time.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { Readable } from 'node:stream';
import { isPrivateIp, SsrfError } from './ssrf.js';
export function validateNetworkUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new SsrfError('只允许无凭据HTTP(S)');
  if (![80, 443].includes(Number(u.port || (u.protocol === 'https:' ? 443 : 80)))) throw new SsrfError('端口被拒绝');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateIp(host)) throw new SsrfError('私网/回环被拒绝');
  return u;
}
export function publicLookup(host, options, callback) {
  dns.lookup(host, { all: true, verbatim: true }, (err, records) => {
    if (err) return callback(err);
    if (!records?.length || records.some(r => isPrivateIp(r.address))) return callback(new SsrfError('连接时DNS包含非公网地址'));
    if (options?.all) callback(null, records);
    else callback(null, records[0].address, records[0].family);
  });
}
export async function safeFetch(raw, options = {}) {
  const u = validateNetworkUrl(raw);
  if (options.redirect && options.redirect !== 'manual') throw new SsrfError('禁止隐式重定向');
  return new Promise((resolve, reject) => {
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(u, {
      method: options.method || 'GET', headers: options.headers || {},
      lookup: publicLookup, agent: false, signal: options.signal,
    }, res => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const empty = options.method === 'HEAD' || [204, 205, 304].includes(res.statusCode);
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
