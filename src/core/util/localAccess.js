import { randomBytes, timingSafeEqual } from 'node:crypto';
export function localAccess(port = 8787) {
  const session = randomBytes(32).toString('hex');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const validCookie = (raw) => {
    const value = String(raw || '').split(';').map(x => x.trim()).find(x => x.startsWith('xunyuan_session='))?.slice(16) || '';
    return /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(session));
  };
  return (req, res, next) => {
    const host = req.headers.host;
    if (!hosts.has(host)) return res.status(403).json({ error: '不允许的Host' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return res.status(403).json({ error: '不允许的Origin' });
    if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return res.status(403).json({ error: '跨站请求被拒绝' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Only a top-level navigation bootstraps an HttpOnly session; never expose it in JS/URLs/logs.
    if (req.method === 'GET' && req.path === '/' && (!req.headers['sec-fetch-mode'] || req.headers['sec-fetch-mode'] === 'navigate')) {
      if (!validCookie(req.headers.cookie)) res.setHeader('Set-Cookie', `xunyuan_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
      return next();
    }
    if (req.path === '/api/health' && req.method === 'GET') return next();
    if (req.path.toLowerCase().startsWith('/api/') && !validCookie(req.headers.cookie)) return res.status(401).json({ error: '请先打开本地首页建立会话' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (!origin || req.headers['x-xunyuan-request'] !== '1')) return res.status(403).json({ error: '缺少同源防CSRF标记' });
    next();
  };
}
