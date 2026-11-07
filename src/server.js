import express from 'express';
import { localAccess } from './core/util/localAccess.js';
import { workPath, WORK_ROOT, initWorkRoot } from './core/util/workspace.js';
import { redactText, redactData } from './core/util/http.js';
import path from 'node:path';
import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { loadConfig, describeConfig, saveConfigPatch } from './core/config.js';
import { ROOT, WEB_DIR } from './core/paths.js';
import { RunManager } from './core/runManager.js';
import { AssetManager } from './core/assetManager.js';
import { listProviders, testProvider } from './core/search/index.js';
import { listAssetSources } from './core/assets/sources/index.js';
import { listPrompts, upsertPrompt, deletePrompt } from './core/promptStore.js';
import { LLM } from './core/llm/deepseek.js';
import { closeBrowserPool } from './core/browser/pool.js';
import { exportMarkdown, exportCsv, exportJson } from './core/export.js';
import { safeFilename } from './core/util/url.js';

const app = express();
const manager = new RunManager(loadConfig);
const assetManager = new AssetManager(loadConfig);

const TERMINAL_EVENTS = new Set([
  'run.completed', 'run.failed', 'run.cancelled',
  'job.completed', 'job.failed', 'job.cancelled',
]);

await initWorkRoot();
app.use(localAccess(8787));
app.disable('x-powered-by');
app.use((req, res, next) => { const json = res.json.bind(res); res.json = value => json(redactData(value)); next(); });
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  if (req.path === '/' || /\.(?:js|css|html)$/.test(req.path)) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(WEB_DIR, { extensions: ['html'] }));

app.get('/vendor/marked.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'));
});
app.get('/vendor/purify.min.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.min.js'));
});

/* -------------------- 基础接口 -------------------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/providers', (req, res) => {
  res.json({ providers: listProviders() });
});

app.get('/api/config', (req, res) => {
  res.json(describeConfig(loadConfig()));
});

app.post('/api/config', async (req, res) => {
  const body = req.body || {};
  saveConfigPatch({ config: body.config, secrets: body.secrets, chromePath: body.chromePath });
  if (body.chromePath !== undefined || body.config?.browser) await closeBrowserPool();
  res.json({ ok: true, config: describeConfig(loadConfig()) });
});

app.post('/api/config/test', async (req, res) => {
  const { type = 'search', provider } = req.body || {};
  const config = loadConfig();
  if (type === 'llm') {
    const llm = new LLM(config);
    if (!llm.ready) return res.status(400).json({ error: '未配置 DeepSeek API Key' });
    const started = Date.now();
    const { text } = await llm.chat({
      messages: [{ role: 'user', content: '只回复两个字：可用' }],
      maxTokens: 10,
      temperature: 0,
      signal: AbortSignal.timeout(30000),
    });
    return res.json({ ok: true, ms: Date.now() - started, reply: text.slice(0, 60) });
  }
  if (!provider) return res.status(400).json({ error: '缺少 provider' });
  const started = Date.now();
  const result = await testProvider(provider, config);
  res.json({ ok: true, ms: Date.now() - started, ...result });
});

/* -------------------- 信息收集任务 -------------------- */
app.post('/api/runs', async (req, res) => {
  const record = await manager.create(req.body || {});
  res.status(202).json({ runId: record.id, status: record.status, input: record.input });
});

app.get('/api/runs', async (req, res) => {
  res.json({ runs: await manager.list(50) });
});

app.get('/api/runs/:id', async (req, res) => {
  const record = await manager.getRecord(req.params.id);
  if (!record) return res.status(404).json({ error: '任务不存在' });
  res.json(record);
});

app.post('/api/runs/:id/cancel', (req, res) => {
  const cancelled = manager.cancel(req.params.id);
  if (!cancelled) return res.status(409).json({ error: '任务不存在或已结束' });
  res.json({ ok: true });
});

app.get('/api/runs/:id/events', async (req, res) => {
  const id = req.params.id;
  const entry = manager.get(id);
  const record = entry?.record || await manager.loadRecord(id);
  if (!record) return res.status(404).json({ error: '任务不存在' });
  await streamEvents(req, res, {
    entry,
    record,
    replay: () => manager.replayFromDisk(id, Number(req.query.after || 0) || 0),
  });
});

app.get('/api/runs/:id/export', async (req, res) => {
  const record = await manager.getRecord(req.params.id);
  if (!record) return res.status(404).json({ error: '任务不存在' });
  const format = String(req.query.format || 'md').toLowerCase();
  const base = safeFilename(record.input?.query || 'report');

  let content;
  let ext;
  let type;
  if (format === 'json') {
    content = exportJson(record);
    ext = 'json';
    type = 'application/json; charset=utf-8';
  } else if (format === 'csv') {
    content = exportCsv(record);
    ext = 'csv';
    type = 'text/csv; charset=utf-8';
  } else {
    content = exportMarkdown(record);
    ext = 'md';
    type = 'text/markdown; charset=utf-8';
  }

  const asciiName = `report-${record.id}.${ext}`;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`);
  res.send(content);
});

/* -------------------- 提示词合集 -------------------- */
app.get('/api/prompts', async (req, res) => {
  res.json({ prompts: await listPrompts() });
});

app.post('/api/prompts', async (req, res) => {
  const prompt = await upsertPrompt(req.body || {});
  res.json({ ok: true, prompt });
});

app.delete('/api/prompts/:id', async (req, res) => {
  await deletePrompt(req.params.id);
  res.json({ ok: true });
});

/* -------------------- 素材收集任务 -------------------- */
app.get('/api/assets/sources', (req, res) => {
  res.json({ sources: listAssetSources() });
});

app.post('/api/assets/jobs', async (req, res) => {
  const record = await assetManager.create(req.body || {});
  res.status(202).json({ jobId: record.id, status: record.status, input: record.input });
});

app.get('/api/assets/jobs', async (req, res) => {
  res.json({ jobs: await assetManager.list(30) });
});

app.get('/api/assets/jobs/:id', async (req, res) => {
  const record = await assetManager.getRecord(req.params.id);
  if (!record) return res.status(404).json({ error: '任务不存在' });
  res.json(record);
});

app.post('/api/assets/jobs/:id/cancel', (req, res) => {
  const cancelled = assetManager.cancel(req.params.id);
  if (!cancelled) return res.status(409).json({ error: '任务不存在或已结束' });
  res.json({ ok: true });
});

app.get('/api/assets/jobs/:id/events', async (req, res) => {
  const id = req.params.id;
  const entry = assetManager.get(id);
  const record = entry?.record || await assetManager.loadRecord(id);
  if (!record) return res.status(404).json({ error: '任务不存在' });
  await streamEvents(req, res, {
    entry,
    record,
    replay: () => assetManager.replayFromDisk(id, Number(req.query.after || 0) || 0),
  });
});

app.get('/api/assets/jobs/:id/file', async (req, res) => {
  const record = await assetManager.getRecord(req.params.id);
  if (!record) return res.status(404).json({ error: '任务不存在' });
  const rel = String(req.query.rel || '');
  if (!rel) return res.status(400).json({ error: '缺少文件参数' });
  const base = await workPath(record.input.folder, { directory: true });
  const abs = await workPath(path.join(base, rel));
  if (abs !== base && !abs.startsWith(base + path.sep)) return res.status(403).json({ error: '路径越界' });
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: '文件不存在' });
  });
});

app.post('/api/assets/jobs/:id/open', async (req, res) => {
  const record = await assetManager.getRecord(req.params.id);
  if (!record) return res.status(404).json({ error: '任务不存在' });
  const folder = await workPath(record.input.folder, { directory: true });
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(command, [folder], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true, folder });
  } catch (err) {
    res.status(500).json({ error: `无法打开文件夹：${err.message}` });
  }
});

/* -------------------- 目录浏览 -------------------- */
app.get('/api/fs/list', async (req, res) => {
  const raw = String(req.query.path || '').trim();
  const home = WORK_ROOT;
  if (!raw) {
    return res.json({ path: null, parent: null, home, dirs: [...listRoots(), { name: '用户目录', path: home }] });
  }
  const dir = await workPath(raw, { directory: true });
  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) return res.status(400).json({ error: '不是文件夹' });
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !/^\$|^System Volume Information$/i.test(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, 400);
  const parent = path.dirname(dir);
  res.json({ path: dir, parent: dir === WORK_ROOT ? null : parent, home, dirs });
});

function listRoots() { return [{ name: '专用工作根', path: WORK_ROOT }]; }

/* -------------------- 本地素材文件（查看器） -------------------- */
const MEDIA_KINDS = {
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio',
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', avif: 'image', gif: 'image',
  srt: 'file', vtt: 'file', ass: 'file', txt: 'file', md: 'file', json: 'file',
  cube: 'file', lut: 'file', ttf: 'file', otf: 'file', woff: 'file', woff2: 'file',
  obj: 'file', glb: 'file', gltf: 'file', fbx: 'file', aep: 'file', mogrt: 'file', pdf: 'file',
};

app.get('/api/fs/files', async (req, res) => {
  const raw = String(req.query.path || '').trim();
  if (!raw) return res.status(400).json({ error: '缺少文件夹路径' });
  const root = await workPath(raw, { directory: true });
  let stat;
  try { stat = await fsp.stat(root); } catch { return res.status(404).json({ error: '文件夹不存在' }); }
  if (!stat.isDirectory()) return res.status(400).json({ error: '不是文件夹' });

  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 2 || files.length >= 300) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= 300) break;
      if (entry.isSymbolicLink()) continue;
      const full = await workPath(path.join(dir, entry.name));
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !/^System Volume Information$/i.test(entry.name)) {
          await walk(full, depth + 1);
        }
        continue;
      }
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      const kind = MEDIA_KINDS[ext];
      if (!kind) continue;
      let info;
      try { info = await fsp.stat(full); } catch { continue; }
      files.push({
        name: entry.name,
        path: full,
        rel: path.relative(root, full).split(path.sep).join('/'),
        kind,
        bytes: info.size,
        mtime: info.mtimeMs,
      });
    }
  };
  await walk(root, 0);
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-CN'));
  res.json({ path: root, files });
});

app.get('/api/fs/file', async (req, res) => {
  const raw = String(req.query.path || '').trim();
  if (!raw) return res.status(400).json({ error: '缺少文件路径' });
  const abs = await workPath(raw);
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!MEDIA_KINDS[ext]) return res.status(400).json({ error: '不支持的文件类型' });
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: '文件不存在' });
  });
});

app.post('/api/fs/open', async (req, res) => {
  const raw = String(req.body?.path || '').trim();
  if (!raw) return res.status(400).json({ error: '缺少路径' });
  const dir = await workPath(raw, { directory: true });
  let stat;
  try { stat = await fsp.stat(dir); } catch { return res.status(404).json({ error: '文件夹不存在' }); }
  if (!stat.isDirectory()) return res.status(400).json({ error: '不是文件夹' });
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(command, [dir], { detached: true, stdio: 'ignore' }).unref();
  res.json({ ok: true, path: dir });
});

/* -------------------- SSE -------------------- */
async function streamEvents(req, res, { entry, record, replay }) {
  const after = Number(req.query.after || req.headers['last-event-id'] || 0) || 0;

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  let closed = false;
  let lastSent = after;
  let ping = null;
  let unsubscribe = () => {};

  const cleanup = () => {
    if (ping) clearInterval(ping);
    unsubscribe();
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    cleanup();
    try { res.write('event: stream.end\ndata: {}\n\n'); } catch { /* ignore */ }
    res.end();
  };
  const send = (event) => {
    if (closed || !event || event.seq <= lastSent) return;
    lastSent = event.seq;
    try {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch { /* ignore */ }
    if (TERMINAL_EVENTS.has(event.type)) setTimeout(finish, 30);
  };

  req.on('close', () => {
    closed = true;
    cleanup();
  });

  const buffered = [];
  let live = false;
  if (entry) {
    unsubscribe = entry.events.subscribe((event) => {
      if (live) send(event);
      else buffered.push(event);
    });
  }

  const history = entry ? entry.events.replay(after) : await replay();
  for (const event of history) send(event);
  live = true;
  for (const event of buffered) send(event);
  buffered.length = 0;

  if (['completed', 'failed', 'cancelled'].includes(record.status) || !entry) {
    setTimeout(finish, 60);
  } else {
    ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 15000);
  }
}

/* -------------------- 兜底与错误处理 -------------------- */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (process.env.DEBUG) console.error(redactText(err.message));
  res.status(status).json({ error: redactText(err.message || '服务器内部错误'), code: redactText(err.code || '') });
});

const config = loadConfig();
config.server = { host: '127.0.0.1', port: 8787 };
const server = app.listen(config.server.port, config.server.host, () => {
  console.log('\n  寻源 · 信息收集台已启动');
  console.log(`  http://${config.server.host}:${config.server.port}\n`);
});

const shutdown = async () => {
  console.log('\n正在关闭…');
  server.close();
  await closeBrowserPool();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, server, manager, assetManager };
