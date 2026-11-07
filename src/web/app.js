import { renderSafeMarkdown } from './sanitize.js';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STAGE_ORDER = ['search', 'dedupe', 'fetch', 'extract', 'synthesize'];
const STAGE_LABEL = { search: '检索', dedupe: '去重', fetch: '抓取', extract: '抽取', synthesize: '整理' };
const EVENT_TYPES = [
  'run.started', 'search.query', 'search.provider.done', 'search.provider.failed',
  'dedupe.done', 'fetch.started', 'fetch.done', 'fetch.failed',
  'extract.done', 'llm.extract.done', 'round.started', 'round.done',
  'synthesize.started', 'synthesize.done',
  'run.completed', 'run.failed', 'run.cancelled', 'log', 'stream.end',
];

const state = {
  providers: [],
  config: null,
  mode: 'fast',
  selected: new Set(),
  currentRunId: null,
  record: null,
  es: null,
  logCount: 0,
  refreshTimer: null,
  activeTab: 'report',
  assetSources: [],
  assetSelected: new Set(),
  assetTypes: [
    { id: 'video', kind: 'video', label: '视频', icon: '▶', ext: 'mp4', count: 6, custom: false },
    { id: 'audio', kind: 'audio', label: '音乐', icon: '♪', ext: 'mp3', count: 1, custom: false },
  ],
  viewerOpen: false,
  viewerFolder: '',
  viewerFiles: [],
  assetMode: 'assets',
  currentAssetId: null,
  assetRecord: null,
  assetEs: null,
  assetLogCount: 0,
  assetRefreshTimer: null,
  folderPath: null,
  folderParent: null,
  folderHome: '',
};

init();

async function init() {
  bindEvents();
  applyTheme();
  try {
    await Promise.all([loadProviders(), loadConfig(), loadAssetSources(), loadHistory()]);
  } catch (err) {
    toast(`初始化失败：${err.message}`);
  }
  renderProviders();
  renderAssetSources();
  updateHint();
  renderAssetHint();
  restoreAssetTypes();
  renderAssetTypes();
  try {
    const lastFolder = localStorage.getItem('lastAssetFolder');
    if (lastFolder) setWorkingFolder(lastFolder);
  } catch { /* ignore */ }
  const label = $('#history-label');
  if (label) label.textContent = '素材任务';
  showView('assets');
}

/* -------------------- 通用请求 -------------------- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}), 'x-xunyuan-request': '1' },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `请求失败（HTTP ${res.status}）`);
  return data;
}

/* -------------------- 配置与搜索源 -------------------- */
async function loadProviders() {
  const data = await api('/api/providers');
  state.providers = data.providers || [];
  const saved = localStorage.getItem('selectedProviders');
  if (saved) {
    try {
      const ids = JSON.parse(saved);
      state.selected = new Set(ids.filter((id) => state.providers.some((p) => p.id === id && p.ready)));
    } catch { /* ignore */ }
  }
  if (!state.selected.size) {
    for (const p of state.providers) if (p.ready) state.selected.add(p.id);
  }
}

function renderProviders() {
  const container = $('#providers');
  if (!container) return;
  container.innerHTML = '';
  for (const p of state.providers) {
    const label = document.createElement('label');
    label.className = 'provider-chip';
    const usable = p.ready;
    if (usable) label.classList.add('ready');
    else label.classList.add('disabled');
    if (state.selected.has(p.id)) label.classList.add('checked');

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.selected.has(p.id);
    input.disabled = !usable;
    input.value = p.id;
    input.addEventListener('change', () => {
      if (input.checked) state.selected.add(p.id);
      else state.selected.delete(p.id);
      label.classList.toggle('checked', input.checked);
      persistSelection();
      updateHint();
    });

    const dot = document.createElement('span');
    dot.className = 'pdot';
    const name = document.createElement('span');
    name.textContent = p.label;
    label.append(input, dot, name);
    if (p.keyless) {
      const badge = document.createElement('span');
      badge.className = 'keyless';
      badge.textContent = '免密';
      label.append(badge);
    }
    if (!p.ready && p.reason) label.title = p.reason;
    container.append(label);
  }

  const mini = $('#provider-mini');
  if (mini) {
    mini.innerHTML = '';
    for (const p of state.providers) {
      const el = document.createElement('span');
      el.className = `pm-dot${p.ready ? ' on' : ''}`;
      el.title = p.ready ? `${p.label}：可用` : `${p.label}：${p.reason || '不可用'}`;
      const dot = document.createElement('i');
      const text = document.createTextNode(p.label.replace('（Google）', '').replace(' 搜索', '').replace('博查 Bocha', '博查').replace('浏览器直连检索', '浏览器'));
      el.append(dot, text);
      mini.append(el);
    }
  }
}

function persistSelection() {
  localStorage.setItem('selectedProviders', JSON.stringify([...state.selected]));
}

function updateHint() {
  const hint = $('#composer-hint');
  if (!hint) return;
  const hasDeepseek = state.providers.find((p) => p.id === 'deepseek')?.ready;
  if (!hasDeepseek) {
    hint.textContent = '未配置 DeepSeek Key：将自动使用 Tavily 免密模式与浏览器直连检索，可在「设置与密钥」中补充。';
  } else if (!state.selected.size) {
    hint.textContent = '请至少选择一个可用的搜索源。';
  } else {
    hint.textContent = `已选 ${state.selected.size} 个搜索源 · 浏览器抓取会自动识别正文并跳过导航广告。`;
  }
}

async function loadConfig() {
  state.config = await api('/api/config');
}

/* -------------------- 主题 -------------------- */
function applyTheme() {
  const saved = localStorage.getItem('theme') || 'auto';
  document.documentElement.dataset.theme = saved;
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme || 'auto';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  let next;
  if (current === 'auto') next = prefersDark ? 'light' : 'dark';
  else next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  document.documentElement.dataset.theme = next;
  toast(next === 'dark' ? '已切换到深色' : '已切换到浅色');
}

/* -------------------- 任务 -------------------- */
async function startRun(event) {
  event.preventDefault();
  const query = $('#query').value.trim();
  if (!query) { toast('请先输入要收集的主题'); $('#query').focus(); return; }
  if (!state.selected.size) { toast('请至少选择一个搜索源'); return; }

  const button = $('#btn-run');
  button.disabled = true;
  try {
    const payload = {
      query,
      mode: state.mode,
      providers: [...state.selected],
      fetchLimit: Number($('#opt-fetch').value) || 8,
      maxRounds: Number($('#opt-rounds').value) || 2,
      wantTable: $('#opt-table').checked,
      useLLM: $('#opt-llm').checked,
    };
    const data = await api('/api/runs', { method: 'POST', body: JSON.stringify(payload) });
    await openRun(data.runId);
    loadHistory();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

async function openRun(runId) {
  disconnectEvents();
  state.currentRunId = runId;
  state.record = null;
  resetRunUI();
  showView('run');

  const record = await api(`/api/runs/${runId}`);
  state.record = record;
  renderRunHeader(record);
  renderSources(record.results);
  setSteps(record.status === 'completed' ? STAGE_ORDER.length : 0, record.status);
  renderResults(record);
  if (record.status === 'running' || record.status === 'queued') {
    $('#btn-cancel').hidden = false;
  }
  connectEvents(runId);
  highlightHistory(runId);
}

function resetRunUI() {
  $('#run-query').textContent = '';
  $('#run-meta').textContent = '';
  $('#log').innerHTML = '';
  $('#sources').innerHTML = '';
  $('#source-count').textContent = '';
  $('#results').hidden = true;
  $('#warnings').hidden = true;
  $('#btn-cancel').hidden = true;
  $('#btn-export').disabled = true;
  $('#run-status').className = 'status-pill';
  state.logCount = 0;
  setSteps(-1);
}

function renderRunHeader(record) {
  if (!record) return;
  $('#run-query').textContent = record.input?.query || '';
  const meta = [];
  meta.push(record.input?.mode === 'deep' ? '深度模式' : '快速模式');
  meta.push(`最多抓取 ${record.input?.fetchLimit || 0} 页`);
  if (record.input?.wantTable) meta.push('对比表');
  if (record.input?.useLLM === false) meta.push('未启用 AI');
  meta.push(record.id);
  $('#run-meta').textContent = meta.join('  ·  ');

  const status = record.status || 'queued';
  const map = { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
  const pill = $('#run-status');
  pill.className = `status-pill ${status}`;
  pill.innerHTML = '';
  const dot = document.createElement('i');
  pill.append(dot, document.createTextNode(map[status] || status));

  const terminal = ['completed', 'failed', 'cancelled'].includes(status);
  $('#btn-cancel').hidden = terminal;
  $('#btn-export').disabled = !record.report;
}

function connectEvents(runId) {
  const es = new EventSource(`/api/runs/${runId}/events`);
  state.es = es;
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (event) => {
      let data = {};
      try { data = JSON.parse(event.data || '{}'); } catch { /* ignore */ }
      handleEvent(type, data);
    });
  }
  es.onerror = () => {
    /* EventSource 会自动重连；终态由服务端 stream.end 关闭 */
  };
}

function disconnectEvents() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function handleEvent(type, event) {
  if (type === 'stream.end') {
    disconnectEvents();
    finalizeRun();
    return;
  }
  appendLog(type, event);
  updateStepsFromEvent(type, event);

  if (['run.completed', 'run.failed', 'run.cancelled'].includes(type)) {
    disconnectEvents();
    finalizeRun();
    return;
  }
  if (type === 'fetch.done' || type === 'fetch.failed' || type === 'round.done' || type === 'search.provider.done') {
    scheduleRecordRefresh();
  }
}

function updateStepsFromEvent(type, event) {
  if (type === 'run.completed') { setSteps(STAGE_ORDER.length, 'completed'); return; }
  if (type === 'run.failed' || type === 'run.cancelled') return;
  const stage = event.stage;
  if (!stage) return;
  const index = STAGE_ORDER.indexOf(stage);
  if (index >= 0) setSteps(index);
}

function setSteps(activeIndex, status) {
  $$('#steps .step').forEach((el, i) => {
    el.classList.toggle('done', activeIndex > i || activeIndex === STAGE_ORDER.length);
    el.classList.toggle('active', i === activeIndex && status !== 'completed' && status !== 'failed' && status !== 'cancelled');
  });
}

function appendLog(type, event) {
  const log = $('#log');
  if (!log) return;
  const line = document.createElement('div');
  const isWarn = type.endsWith('failed') || (type === 'log' && event.stage === 'warn');
  const isError = type === 'run.failed';
  const isOk = type === 'run.completed' || type === 'synthesize.done';
  line.className = `log-line${isError ? ' error' : isWarn ? ' warn' : isOk ? ' ok' : ''}`;

  const time = document.createElement('span');
  time.className = 't';
  const date = event.ts ? new Date(event.ts) : new Date();
  time.textContent = date.toLocaleTimeString('zh-CN', { hour12: false });

  const stage = document.createElement('span');
  stage.className = 's';
  stage.textContent = STAGE_LABEL[event.stage] || event.stage || '';

  const message = document.createElement('span');
  message.className = 'm';
  message.textContent = event.message || type;

  line.append(time, stage, message);
  log.append(line);
  state.logCount++;
  if (state.logCount > 400) {
    log.firstElementChild?.remove();
  }
  $('#log-count').textContent = `${state.logCount} 条`;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function scheduleRecordRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    if (!state.currentRunId) return;
    try {
      const record = await api(`/api/runs/${state.currentRunId}`);
      state.record = record;
      renderRunHeader(record);
      renderSources(record.results);
    } catch { /* ignore */ }
  }, 1200);
}

async function finalizeRun() {
  if (!state.currentRunId) return;
  try {
    const record = await api(`/api/runs/${state.currentRunId}`);
    state.record = record;
    renderRunHeader(record);
    renderSources(record.results);
    renderResults(record);
    if (record.report) {
      $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (record.status === 'failed' && record.error) toast(`任务失败：${record.error}`);
    loadHistory();
  } catch (err) {
    toast(`获取结果失败：${err.message}`);
  }
}

async function cancelRun() {
  if (!state.currentRunId) return;
  $('#btn-cancel').disabled = true;
  try {
    await api(`/api/runs/${state.currentRunId}/cancel`, { method: 'POST' });
    toast('已请求取消');
  } catch (err) {
    toast(err.message);
  } finally {
    $('#btn-cancel').disabled = false;
  }
}

/* -------------------- 来源卡片 -------------------- */
function renderSources(results = []) {
  const list = $('#sources');
  if (!list) return;
  list.innerHTML = '';
  const completed = results.filter((r) => r.status === 'ok').length;
  $('#source-count').textContent = results.length ? `${completed} / ${results.length} 篇可读` : '等待检索…';
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'sources-empty';
    empty.textContent = '检索到的来源会实时出现在这里';
    list.append(empty);
    return;
  }

  const statusText = {
    ok: '已抓取',
    failed: '抓取失败',
    blocked: '被拦截',
    ssrf_blocked: '地址被拒',
  };

  for (const r of results) {
    const card = document.createElement('div');
    card.className = 'source-card';

    const top = document.createElement('div');
    top.className = 'sc-top';
    const link = document.createElement('a');
    link.className = 'sc-title';
    link.href = r.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = r.extract?.title || r.title || r.url;
    const badge = document.createElement('span');
    badge.className = `sc-badge ${r.status === 'ok' ? '' : r.status}`;
    badge.textContent = r.status === 'ok'
      ? (r.via === 'browser' ? '浏览器抓取' : r.via === 'http' ? 'HTTP 抓取' : '已抓取')
      : statusText[r.status] || r.status;
    top.append(link, badge);

    const meta = document.createElement('div');
    meta.className = 'sc-meta';
    const parts = [];
    if (r.siteName) parts.push(r.siteName);
    if (r.publishedAt) parts.push(String(r.publishedAt).slice(0, 10));
    if (r.chars) parts.push(`${r.chars} 字`);
    if (r.sources?.length > 1) parts.push(`${r.sources.length} 源命中`);
    if (r.error) parts.push(r.error);
    meta.textContent = parts.join(' · ');

    const snippet = document.createElement('div');
    snippet.className = 'sc-snippet';
    snippet.textContent = r.snippet || '';

    card.append(top, meta);
    if (r.snippet) card.append(snippet);
    list.append(card);
  }
}

/* -------------------- 结果 -------------------- */
function renderResults(record) {
  if (!record?.report) return;
  $('#results').hidden = false;
  $('#btn-export').disabled = false;

  const report = record.report.markdown || '';
  const body = $('#report-body');
  body.innerHTML = sanitizeMarkdown(report);
  linkify(body);

  renderTable(record.table);
  renderSourceList(record);
  $('#json-body').textContent = JSON.stringify(record, null, 2).slice(0, 400000);

  if (record.warnings?.length) {
    const box = $('#warnings');
    box.hidden = false;
    box.innerHTML = '';
    const title = document.createElement('strong');
    title.textContent = `运行中有 ${record.warnings.length} 条警告`;
    const ul = document.createElement('ul');
    for (const w of record.warnings.slice(0, 8)) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.append(li);
    }
    box.append(title, ul);
  } else {
    $('#warnings').hidden = true;
  }
  syncDownload();
}

function sanitizeMarkdown(markdown) { return renderSafeMarkdown(markdown, window); }

function linkify(root) {
  for (const a of $$('a[href]', root)) {
    if (a.getAttribute('href')?.startsWith('#')) continue;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
}

function renderTable(table) {
  const wrap = $('#table-body');
  wrap.innerHTML = '';
  if (!table?.columns?.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '本次未生成对比表（可在高级选项中勾选「生成对比表」）。';
    wrap.append(empty);
    return;
  }
  if (table.caption) {
    const caption = document.createElement('div');
    caption.className = 'table-caption';
    caption.textContent = table.caption;
    wrap.append(caption);
  }
  const el = document.createElement('table');
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const col of table.columns) {
    const th = document.createElement('th');
    th.textContent = col;
    tr.append(th);
  }
  thead.append(tr);
  const tbody = document.createElement('tbody');
  for (const row of table.rows || []) {
    const rowEl = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      rowEl.append(td);
    }
    tbody.append(rowEl);
  }
  el.append(thead, tbody);
  wrap.append(el);
}

function renderSourceList(record) {
  const list = $('#source-list');
  list.innerHTML = '';
  const citations = record.report?.citations || [];
  const byN = new Map(citations.map((c) => [c.n, c]));
  const results = (record.results || []).filter((r) => r.status === 'ok');
  const ordered = citations.length
    ? citations.map((c) => ({ n: c.n, result: record.results.find((r) => r.id === c.resultId) || { url: c.url, title: c.title } }))
    : results.map((r, i) => ({ n: i + 1, result: r }));

  for (const { n, result } of ordered) {
    const row = document.createElement('div');
    row.className = 'source-row';
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = String(n);
    const body = document.createElement('div');
    body.className = 'body';
    const a = document.createElement('a');
    a.href = result.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = result.extract?.title || result.title || result.url;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const parts = [];
    if (result.siteName) parts.push(result.siteName);
    if (result.publishedAt) parts.push(String(result.publishedAt).slice(0, 10));
    if (result.chars) parts.push(`${result.chars} 字`);
    parts.push(result.url);
    meta.textContent = parts.join(' · ');
    body.append(a, meta);
    if (result.snippet) {
      const snippet = document.createElement('div');
      snippet.className = 'snippet';
      snippet.textContent = result.snippet;
      body.append(snippet);
    }
    row.append(num, body);
    list.append(row);
  }

  if (!ordered.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '没有可展示的来源。';
    list.append(empty);
  }
}

/* -------------------- 标签页与导出 -------------------- */
function switchTab(tab) {
  state.activeTab = tab;
  $$('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  $$('.tab-pane').forEach((el) => { el.hidden = el.dataset.pane !== tab; });
  syncDownload();
}

function syncDownload() {
  const link = $('#btn-download');
  if (!state.currentRunId) return;
  const map = { report: 'md', table: 'csv', sources: 'csv', json: 'json' };
  const format = map[state.activeTab] || 'md';
  link.href = `/api/runs/${state.currentRunId}/export?format=${format}`;
  link.setAttribute('download', '');
}

async function copyCurrent() {
  if (!state.record) return;
  let text = '';
  if (state.activeTab === 'report') text = state.record.report?.markdown || '';
  else if (state.activeTab === 'json') text = $('#json-body').textContent;
  else if (state.activeTab === 'sources') {
    text = (state.record.report?.citations || []).map((c) => `[${c.n}] ${c.title} — ${c.url}`).join('\n');
  } else if (state.activeTab === 'table') {
    const table = state.record.table;
    if (table?.columns) {
      text = [table.columns.join('\t'), ...table.rows.map((r) => r.join('\t'))].join('\n');
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    toast('复制失败，请手动选择');
  }
}

/* -------------------- 历史 -------------------- */
async function loadHistory() {
  if (state.assetMode === 'assets') return loadAssetHistory();
  return loadResearchHistory();
}

async function loadResearchHistory() {
  try {
    const data = await api('/api/runs');
    const list = $('#history');
    list.innerHTML = '';
    if (!data.runs?.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '还没有任务记录';
      list.append(empty);
      return;
    }
    for (const run of data.runs) {
      const btn = document.createElement('button');
      btn.className = 'history-item';
      btn.dataset.runId = run.id;
      btn.type = 'button';
      if (run.id === state.currentRunId) btn.classList.add('active');

      const q = document.createElement('span');
      q.className = 'hq';
      q.textContent = run.query;

      const meta = document.createElement('span');
      meta.className = 'hm';
      const dot = document.createElement('i');
      dot.className = `dot ${run.status}`;
      const time = document.createElement('span');
      time.textContent = formatTime(run.createdAt);
      const count = document.createElement('span');
      count.textContent = `${run.sources || 0} 篇`;
      meta.append(dot, time, count);

      btn.append(q, meta);
      btn.addEventListener('click', () => openRun(run.id));
      list.append(btn);
    }
  } catch { /* ignore */ }
}

function highlightHistory(runId) {
  $$('.history-item').forEach((el) => el.classList.toggle('active', el.dataset.runId === runId));
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  } catch {
    return '';
  }
}

/* -------------------- 设置 -------------------- */
function openSettings() {
  const dialog = $('#settings-dialog');
  const form = $('#settings-form');
  const keys = state.config?.keys || {};
  form.reset();
  for (const [name, info] of Object.entries(keys)) {
    const label = $(`#key-${name}`);
    if (label) label.textContent = info.configured ? `已配置 ${info.masked}` : '未配置';
  }
  const model = form.elements.namedItem('model');
  if (model) model.value = state.config?.llm?.model || 'deepseek-chat';
  $('#test-result').hidden = true;
  dialog.showModal();
}

async function saveSettings({ silent = false } = {}) {
  const form = $('#settings-form');
  const secrets = {};
  for (const id of ['deepseek', 'tavily', 'bocha', 'serper', 'exa', 'searxng', 'pixabay', 'pexels']) {
    const input = form.elements.namedItem(id);
    if (input && input.value.trim()) secrets[id] = input.value.trim();
  }
  const model = form.elements.namedItem('model')?.value.trim();
  const chromePath = form.elements.namedItem('chromePath')?.value.trim();
  const payload = { secrets };
  if (model) payload.config = { llm: { model } };
  if (chromePath) payload.chromePath = chromePath;

  try {
    const data = await api('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    state.config = data.config;
    await Promise.all([loadProviders(), loadAssetSources()]);
    renderProviders();
    renderAssetSources();
    updateHint();
    renderAssetHint();
    if (!silent) toast('设置已保存');
    return true;
  } catch (err) {
    showTestResult(`保存失败：${err.message}`, 'err');
    return false;
  }
}

async function testConnection(button) {
  const type = button.dataset.test;
  const provider = button.dataset.provider;
  const box = $('#test-result');
  box.hidden = false;
  box.className = 'test-result';
  box.textContent = '正在测试…';

  const hasInput = [...$('#settings-form').elements]
    .some((el) => el.type === 'password' && el.value.trim());
  if (hasInput) {
    const saved = await saveSettings({ silent: true });
    if (!saved) return;
  }

  try {
    const body = type === 'llm' ? { type: 'llm' } : { type: 'search', provider };
    const data = await api('/api/config/test', { method: 'POST', body: JSON.stringify(body) });
    box.className = 'test-result ok';
    box.textContent = type === 'llm'
      ? `对话接口可用（${data.ms}ms）：${data.reply}`
      : `${provider} 搜索可用：返回 ${data.count} 条（${data.ms}ms）`;
  } catch (err) {
    box.className = 'test-result err';
    box.textContent = `测试失败：${err.message}`;
  }
}

function showTestResult(text, kind) {
  const box = $('#test-result');
  box.hidden = false;
  box.className = `test-result ${kind}`;
  box.textContent = text;
}

/* -------------------- 其他 UI -------------------- */
function showView(name) {
  $('#view-home').hidden = name !== 'home';
  $('#view-run').hidden = name !== 'run';
  $('#view-assets').hidden = name !== 'assets';
  $('#view-asset-job').hidden = name !== 'assetJob';
  $('#view-loading').hidden = true;
  const titles = { home: '新建收集', run: '收集详情', assets: '找素材', assetJob: '素材任务' };
  $('#topbar-title').textContent = titles[name] || '';
}

function bindEvents() {
  $('#form-run').addEventListener('submit', startRun);
  $('#btn-new').addEventListener('click', () => {
    disconnectEvents();
    disconnectAssetEvents();
    state.currentRunId = null;
    state.record = null;
    setAssetMode('research');
    if (state.viewerOpen) toggleViewer(false);
    showView('home');
    highlightHistory(null);
    $('#query').focus();
  });
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-cancel').addEventListener('click', cancelRun);
  $('#btn-copy').addEventListener('click', copyCurrent);
  $('#btn-export').addEventListener('click', () => {
    switchTab(state.activeTab);
    $('#btn-download').click();
  });

  $$('.mode-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      $$('.mode-option').forEach((b) => b.classList.toggle('active', b === btn));
      $('#field-rounds').hidden = state.mode !== 'deep';
      $('#opt-fetch').value = state.mode === 'deep' ? 20 : 8;
      $('#opt-table').checked = state.mode === 'deep';
    });
  });

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    if (submitter?.value === 'cancel') {
      $('#settings-dialog').close();
      return;
    }
    const ok = await saveSettings();
    if (ok) $('#settings-dialog').close();
  });

  $$('[data-test]').forEach((btn) => btn.addEventListener('click', () => testConnection(btn)));

  $('#query').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      $('#form-run').requestSubmit();
    }
  });

  $('#btn-new-assets').addEventListener('click', () => {
    disconnectEvents();
    disconnectAssetEvents();
    setAssetMode('assets');
    showView('assets');
    highlightHistory(null);
    $('#sf-brief').focus();
  });
  $('#form-asset').addEventListener('submit', startAssetJob);
  $('#btn-work-folder').addEventListener('click', openFolderDialog);
  $('#btn-asset-config').addEventListener('click', toggleAssetConfig);
  $('#btn-add-type').addEventListener('click', toggleTypeMenu);
  $('#btn-drawer-toggle').addEventListener('click', () => toggleViewer());
  $('#btn-drawer-close').addEventListener('click', () => toggleViewer(false));
  $('#btn-drawer-refresh').addEventListener('click', refreshViewer);
  $('#btn-drawer-open').addEventListener('click', openViewerFolder);
  $('#sf-brief').addEventListener('input', () => autoGrow($('#sf-brief')));
  $('#sf-brief').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') $('#form-asset').requestSubmit();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.type-add-wrap')) {
      const menu = $('#type-menu');
      if (menu && !menu.hidden) {
        menu.hidden = true;
        $('#btn-add-type').setAttribute('aria-expanded', 'false');
      }
    }
    if (!event.target.closest('.config-col')) {
      const pop = $('#asset-config');
      if (pop && !pop.hidden) {
        pop.hidden = true;
        $('#btn-asset-config').setAttribute('aria-expanded', 'false');
      }
    }
  });
  $('#sf-folder').addEventListener('input', renderAssetHint);
  $('#aj-cancel').addEventListener('click', cancelAssetJob);
  $('#aj-open').addEventListener('click', openAssetFolder);
  $('#folder-close').addEventListener('click', () => $('#folder-dialog').close());
  $('#folder-cancel').addEventListener('click', () => $('#folder-dialog').close());
  $('#folder-up').addEventListener('click', () => loadFolder(state.folderParent || '').catch((err) => toast(err.message)));
  $('#folder-home').addEventListener('click', () => loadFolder(state.folderHome || '').catch((err) => toast(err.message)));
  $('#folder-select').addEventListener('click', () => {
    if (!state.folderPath) return toast('请先进入一个文件夹');
    setWorkingFolder(state.folderPath);
    $('#folder-dialog').close();
  });
}

function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 2600);
}

window.addEventListener('beforeunload', () => {
  disconnectEvents();
  disconnectAssetEvents();
});

/* -------------------- 素材收集 -------------------- */
const ASSET_STAGES = ['plan', 'search', 'download', 'organize'];
const ASSET_STAGE_LABEL = { plan: '规划', search: '检索', download: '下载', organize: '整理' };
const ASSET_KIND_LABEL = { video: '视频', audio: '音乐', image: '图片', file: '文件' };
const ASSET_EVENT_TYPES = [
  'job.started', 'plan.done', 'source.done', 'source.failed', 'kind.done', 'search.done',
  'download.started', 'download.done', 'download.failed', 'organize.started', 'organize.done',
  'job.completed', 'job.failed', 'job.cancelled', 'log', 'stream.end',
];

async function loadAssetSources() {
  const data = await api('/api/assets/sources');
  state.assetSources = data.sources || [];
  const saved = localStorage.getItem('assetSources');
  if (saved) {
    try {
      state.assetSelected = new Set(
        JSON.parse(saved).filter((id) => state.assetSources.some((s) => s.id === id && s.ready)),
      );
    } catch { /* ignore */ }
  }
  if (!state.assetSelected.size) {
    for (const source of state.assetSources) if (source.ready) state.assetSelected.add(source.id);
  }
}

function renderAssetSources() {
  const box = $('#asset-sources');
  if (!box) return;
  box.innerHTML = '';
  for (const source of state.assetSources) {
    const label = document.createElement('label');
    label.className = 'provider-chip';
    if (source.ready) label.classList.add('ready');
    else label.classList.add('disabled');
    if (state.assetSelected.has(source.id)) label.classList.add('checked');

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.assetSelected.has(source.id);
    input.disabled = !source.ready;
    input.addEventListener('change', () => {
      if (input.checked) state.assetSelected.add(source.id);
      else state.assetSelected.delete(source.id);
      label.classList.toggle('checked', input.checked);
      localStorage.setItem('assetSources', JSON.stringify([...state.assetSelected]));
      renderAssetHint();
    });

    const dot = document.createElement('span');
    dot.className = 'pdot';
    const name = document.createElement('span');
    name.textContent = source.label;
    const kinds = document.createElement('span');
    kinds.className = 'keyless';
    kinds.textContent = source.kinds.map((kind) => ASSET_KIND_LABEL[kind] || kind).join('/');
    label.append(input, dot, name, kinds);
    if (!source.ready) label.title = source.reason || '';
    box.append(label);
  }
  updateConfigSummary();
}

function assetCounts() {
  const counts = { video: 0, audio: 0, image: 0, file: 0 };
  for (const type of state.assetTypes) {
    counts[type.kind] = (counts[type.kind] || 0) + (Number(type.count) || 0);
  }
  return counts;
}

function renderAssetHint() {
  const hint = $('#asset-hint');
  if (!hint) return;
  const total = totalAssetCount();
  const types = state.assetTypes.filter((type) => type.count > 0);
  const imageReady = state.assetSources.some((source) => source.ready && source.kinds.includes('image'));
  const imageTypes = types.filter((type) => type.kind === 'image');
  const customTypes = types.filter((type) => type.custom || type.kind === 'file');
  const folder = $('#sf-folder').value.trim();
  const parts = [];
  if (!types.length) parts.push('请至少添加一种文件类型');
  if (total > 24) parts.push('一次最多 24 个素材');
  if (imageTypes.some((type) => !type.custom) && !imageReady) parts.push('图片素材需配置 Pixabay 或 Pexels');
  if (customTypes.length) parts.push('自定义后缀走网页检索，速度较慢且请核实版权');
  if (folder) parts.push('保存到 ' + folder);
  hint.textContent = parts.join(' · ') || '内置类型来自 Mixkit / Coverr 等图库；自定义类型会按后缀检索网页文件。';
}

function setAssetMode(mode) {
  state.assetMode = mode;
  const label = $('#history-label');
  if (label) label.textContent = mode === 'assets' ? '素材任务' : '历史任务';
  loadHistory();
}

async function startAssetJob(event) {
  event.preventDefault();
  const folder = $('#sf-folder').value.trim();
  const brief = $('#sf-brief').value.trim();
  const counts = assetCounts();
  const types = state.assetTypes
    .filter((type) => Number(type.count) > 0)
    .map((type) => ({ label: type.label, ext: type.ext, count: Number(type.count), custom: Boolean(type.custom) }));
  if (!folder) return toast('请选择或填写保存文件夹');
  if (!brief) return toast('请描述需要什么素材');
  if (!types.length) return toast('请至少添加一种文件类型');

  const button = $('#btn-asset-run');
  button.disabled = true;
  try {
    const data = await api('/api/assets/jobs', {
      method: 'POST',
      body: JSON.stringify({
        folder,
        brief,
        counts,
        types,
        sources: [...state.assetSelected],
        useLLM: $('#sf-llm').checked,
      }),
    });
    await openAssetJob(data.jobId);
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

async function openAssetJob(jobId) {
  disconnectAssetEvents();
  state.currentAssetId = jobId;
  state.assetRecord = null;
  resetAssetUI();
  showView('assetJob');
  const record = await api(`/api/assets/jobs/${jobId}`);
  state.assetRecord = record;
  renderAssetHeader(record);
  renderAssetFiles(record);
  renderAssetSummary(record);
  connectAssetEvents(jobId);
  highlightHistory(jobId);
  setAssetMode('assets');
  setWorkingFolder(record.input?.folder || '');
  await toggleViewer(true);
}

function resetAssetUI() {
  $('#aj-brief').textContent = '';
  $('#aj-meta').textContent = '';
  $('#aj-log').innerHTML = '';
  $('#aj-files').innerHTML = '';
  $('#aj-count').textContent = '';
  $('#aj-log-count').textContent = '';
  $('#aj-summary').hidden = true;
  $('#aj-manifest').hidden = true;
  $('#aj-cancel').hidden = true;
  $('#aj-open').disabled = true;
  $('#aj-status').className = 'status-pill';
  state.assetLogCount = 0;
  updateAssetSteps(-1);
}

function renderAssetHeader(record) {
  if (!record) return;
  $('#aj-brief').textContent = record.input?.brief || '';
  const counts = record.input?.counts || {};
  const meta = [
    `视频 ${counts.video || 0}`,
    `音乐 ${counts.audio || 0}`,
    `图片 ${counts.image || 0}`,
    record.input?.folder || '',
    record.id,
  ].filter(Boolean);
  $('#aj-meta').textContent = meta.join('  ·  ');

  const status = record.status || 'queued';
  const map = { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
  const pill = $('#aj-status');
  pill.className = `status-pill ${status}`;
  pill.innerHTML = '';
  const dot = document.createElement('i');
  pill.append(dot, document.createTextNode(map[status] || status));

  const terminal = ['completed', 'failed', 'cancelled'].includes(status);
  $('#aj-cancel').hidden = terminal;
  $('#aj-open').disabled = !(record.stats?.downloaded > 0);
  const manifest = $('#aj-manifest');
  if (record.manifest || record.status === 'completed') {
    manifest.hidden = false;
    manifest.href = assetFileUrl(record.id, 'manifest.json');
  } else {
    manifest.hidden = true;
  }
}

function connectAssetEvents(jobId) {
  const es = new EventSource(`/api/assets/jobs/${jobId}/events`);
  state.assetEs = es;
  for (const type of ASSET_EVENT_TYPES) {
    es.addEventListener(type, (event) => {
      let data = {};
      try { data = JSON.parse(event.data || '{}'); } catch { /* ignore */ }
      handleAssetEvent(type, data);
    });
  }
}

function disconnectAssetEvents() {
  if (state.assetEs) {
    state.assetEs.close();
    state.assetEs = null;
  }
  if (state.assetRefreshTimer) {
    clearTimeout(state.assetRefreshTimer);
    state.assetRefreshTimer = null;
  }
}

function handleAssetEvent(type, event) {
  if (type === 'stream.end') {
    disconnectAssetEvents();
    finalizeAsset();
    return;
  }
  appendAssetLog(type, event);
  const index = ASSET_STAGES.indexOf(event.stage);
  if (index >= 0) updateAssetSteps(index);
  if (['download.done', 'download.failed', 'search.done', 'source.done'].includes(type)) scheduleAssetRefresh();
  if (type === 'download.done' && state.viewerOpen) refreshViewer();
  if (['job.completed', 'job.failed', 'job.cancelled'].includes(type)) {
    disconnectAssetEvents();
    if (type === 'job.completed') updateAssetSteps(ASSET_STAGES.length, 'completed');
    finalizeAsset();
  }
}

function appendAssetLog(type, event) {
  const log = $('#aj-log');
  if (!log) return;
  const line = document.createElement('div');
  const isWarn = type.endsWith('failed') || (type === 'log' && event.stage === 'warn');
  const isOk = type === 'job.completed' || type === 'organize.done';
  line.className = `log-line${type === 'job.failed' ? ' error' : isWarn ? ' warn' : isOk ? ' ok' : ''}`;

  const time = document.createElement('span');
  time.className = 't';
  const date = event.ts ? new Date(event.ts) : new Date();
  time.textContent = date.toLocaleTimeString('zh-CN', { hour12: false });

  const stage = document.createElement('span');
  stage.className = 's';
  stage.textContent = ASSET_STAGE_LABEL[event.stage] || event.stage || '';

  const message = document.createElement('span');
  message.className = 'm';
  message.textContent = event.message || type;

  line.append(time, stage, message);
  log.append(line);
  state.assetLogCount++;
  if (state.assetLogCount > 400) log.firstElementChild?.remove();
  $('#aj-log-count').textContent = `${state.assetLogCount} 条`;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function updateAssetSteps(activeIndex, status) {
  $$('#aj-steps .step').forEach((el, i) => {
    el.classList.toggle('done', activeIndex > i || activeIndex === ASSET_STAGES.length);
    const terminal = ['completed', 'failed', 'cancelled'].includes(status || '');
    el.classList.toggle('active', i === activeIndex && !terminal);
  });
}

function scheduleAssetRefresh() {
  if (state.assetRefreshTimer) return;
  state.assetRefreshTimer = setTimeout(async () => {
    state.assetRefreshTimer = null;
    if (!state.currentAssetId) return;
    try {
      const record = await api(`/api/assets/jobs/${state.currentAssetId}`);
      state.assetRecord = record;
      renderAssetHeader(record);
      renderAssetFiles(record);
      renderAssetSummary(record);
    } catch { /* ignore */ }
  }, 1000);
}

async function finalizeAsset() {
  if (!state.currentAssetId) return;
  try {
    const record = await api(`/api/assets/jobs/${state.currentAssetId}`);
    state.assetRecord = record;
    renderAssetHeader(record);
    renderAssetFiles(record);
    renderAssetSummary(record);
    updateAssetSteps(record.status === 'completed' ? ASSET_STAGES.length : -1, record.status);
    if (record.status === 'failed' && record.error) toast(`任务失败：${record.error}`);
    if (record.status === 'completed') toast(`已下载 ${record.stats.downloaded} 个素材`);
    if (state.viewerOpen) refreshViewer();
    loadHistory();
  } catch (err) {
    toast(err.message);
  }
}

async function cancelAssetJob() {
  if (!state.currentAssetId) return;
  $('#aj-cancel').disabled = true;
  try {
    await api(`/api/assets/jobs/${state.currentAssetId}/cancel`, { method: 'POST' });
    toast('已请求取消');
  } catch (err) {
    toast(err.message);
  } finally {
    $('#aj-cancel').disabled = false;
  }
}

async function openAssetFolder() {
  if (!state.currentAssetId) return;
  try {
    const data = await api(`/api/assets/jobs/${state.currentAssetId}/open`, { method: 'POST' });
    toast('已在资源管理器中打开');
    return data;
  } catch (err) {
    toast(err.message);
  }
}

function assetFileUrl(jobId, rel) {
  return `/api/assets/jobs/${jobId}/file?rel=${encodeURIComponent(rel)}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function renderAssetFiles(record) {
  const box = $('#aj-files');
  if (!box) return;
  box.innerHTML = '';
  const items = record.items || [];
  const done = items.filter((item) => item.status === 'done');
  const failed = items.filter((item) => item.status === 'failed');
  $('#aj-count').textContent = done.length
    ? `${done.length} 个文件 · ${formatBytes(record.stats?.bytes || 0)}`
    : failed.length ? '下载中…' : '等待素材…';

  if (!done.length && !failed.length) {
    const empty = document.createElement('div');
    empty.className = 'asset-empty';
    empty.textContent = '下载完成的素材会实时出现在这里';
    box.append(empty);
    return;
  }

  for (const item of done) {
    const card = document.createElement('a');
    card.className = 'asset-card';
    card.href = assetFileUrl(record.id, item.file);
    card.target = '_blank';
    card.rel = 'noopener';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (item.kind === 'image') {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = item.title || '';
      img.src = assetFileUrl(record.id, item.file);
      thumb.append(img);
    } else {
      thumb.textContent = item.kind === 'video' ? '▶ VIDEO' : '♪ AUDIO';
    }

    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.title || item.file;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const type = document.createElement('span');
    type.className = 'asset-type';
    type.textContent = ASSET_KIND_LABEL[item.kind] || item.kind;
    const rest = document.createElement('span');
    rest.textContent = `${item.sourceLabel || item.source} · ${formatBytes(item.bytes)}`;
    meta.append(type, rest);
    body.append(name, meta);
    card.append(thumb, body);
    box.append(card);
  }

  for (const item of failed.slice(0, 4)) {
    const card = document.createElement('div');
    card.className = 'asset-card';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.textContent = '下载失败';
    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.title || '未知素材';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = item.error || '';
    body.append(name, meta);
    card.append(thumb, body);
    box.append(card);
  }
}

function renderAssetSummary(record) {
  const card = $('#aj-summary');
  if (!card) return;
  const hasData = record.stats?.downloaded || record.plan || record.status === 'completed';
  if (!hasData) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const body = $('#aj-summary-body');
  body.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'aj-summary-grid';
  const stats = [
    [String(record.stats?.downloaded || 0), '已下载文件'],
    [formatBytes(record.stats?.bytes || 0), '总大小'],
    [String(record.stats?.candidates || 0), '候选素材'],
    [record.input?.folder || '', '保存位置'],
  ];
  for (const [value, label] of stats) {
    const el = document.createElement('div');
    el.className = 'aj-stat';
    const strong = document.createElement('strong');
    strong.textContent = value;
    const span = document.createElement('span');
    span.textContent = label;
    el.append(strong, span);
    grid.append(el);
  }
  body.append(grid);

  const plan = document.createElement('div');
  plan.className = 'asset-plan';
  if (record.plan?.summary) {
    const p = document.createElement('p');
    p.textContent = `需求概括：${record.plan.summary}`;
    plan.append(p);
  }
  for (const [kind, queries] of Object.entries(record.plan?.queries || {})) {
    if (!queries?.length) continue;
    const p = document.createElement('p');
    p.textContent = `${ASSET_KIND_LABEL[kind] || kind}检索词：${queries.join(' / ')}`;
    plan.append(p);
  }
  if (record.manifest) {
    const p = document.createElement('p');
    p.textContent = '授权与来源信息已写入文件夹内的 manifest.json 与 素材清单.md，商用前请逐条核对。';
    plan.append(p);
  }
  body.append(plan);

  if (record.warnings?.length) {
    const box = document.createElement('div');
    box.className = 'warnings';
    box.style.marginTop = '16px';
    box.style.borderRadius = '10px';
    box.style.borderTop = '0';
    const title = document.createElement('strong');
    title.textContent = `运行中有 ${record.warnings.length} 条警告`;
    const ul = document.createElement('ul');
    for (const warning of record.warnings.slice(0, 8)) {
      const li = document.createElement('li');
      li.textContent = warning;
      ul.append(li);
    }
    box.append(title, ul);
    body.append(box);
  }
}

async function loadAssetHistory() {
  try {
    const data = await api('/api/assets/jobs');
    const list = $('#history');
    list.innerHTML = '';
    if (!data.jobs?.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '还没有素材任务';
      list.append(empty);
      return;
    }
    for (const job of data.jobs) {
      const btn = document.createElement('button');
      btn.className = 'history-item';
      btn.type = 'button';
      btn.dataset.runId = job.id;
      if (job.id === state.currentAssetId) btn.classList.add('active');

      const q = document.createElement('span');
      q.className = 'hq';
      q.textContent = job.brief;

      const meta = document.createElement('span');
      meta.className = 'hm';
      const dot = document.createElement('i');
      dot.className = `dot ${job.status}`;
      const time = document.createElement('span');
      time.textContent = formatTime(job.createdAt);
      const count = document.createElement('span');
      count.textContent = `${job.downloaded || 0} 个`;
      meta.append(dot, time, count);

      btn.append(q, meta);
      btn.addEventListener('click', () => openAssetJob(job.id));
      list.append(btn);
    }
  } catch { /* ignore */ }
}

async function openFolderDialog() {
  const dialog = $('#folder-dialog');
  dialog.showModal();
  const start = $('#sf-folder').value.trim();
  try {
    await loadFolder(start || '');
  } catch {
    await loadFolder('');
  }
}

async function loadFolder(dir) {
  const url = dir ? `/api/fs/list?path=${encodeURIComponent(dir)}` : '/api/fs/list';
  const data = await api(url);
  state.folderPath = data.path || null;
  state.folderParent = data.parent || null;
  state.folderHome = data.home || '';
  $('#folder-path').value = data.path || '选择一个磁盘或文件夹';
  $('#folder-select').disabled = !data.path;

  const list = $('#folder-list');
  list.innerHTML = '';
  if (!data.dirs?.length) {
    const empty = document.createElement('div');
    empty.className = 'folder-empty';
    empty.textContent = '这个文件夹里没有子文件夹';
    list.append(empty);
    return;
  }
  for (const folder of data.dirs) {
    const btn = document.createElement('button');
    btn.className = 'folder-item';
    btn.type = 'button';
    const icon = document.createElement('span');
    icon.className = 'fi-icon';
    icon.textContent = '▸';
    const name = document.createElement('span');
    name.textContent = folder.name;
    const arrow = document.createElement('span');
    arrow.style.marginLeft = 'auto';
    arrow.style.opacity = '0.4';
    arrow.textContent = '›';
    btn.append(icon, name, arrow);
    btn.addEventListener('click', () => {
      loadFolder(folder.path).catch((err) => toast(err.message));
    });
    list.append(btn);
  }
}


/* -------------------- 素材工作台：类型按钮、提示词合集与查看器 -------------------- */
const ASSET_TYPE_DEFS = {
  video: { label: '视频', icon: '▶', ext: 'mp4' },
  audio: { label: '音乐', icon: '♪', ext: 'mp3' },
  image: { label: '图片', icon: '▣', ext: 'jpg' },
};
const KIND_BY_EXT = new Map([
  ...['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'].map((ext) => [ext, 'video']),
  ...['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'].map((ext) => [ext, 'audio']),
  ...['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'svg'].map((ext) => [ext, 'image']),
]);
const PROMPT_ICONS = ['🎬', '🌃', '🎵', '✨', '🚀', '🧊', '🌊', '🏙️', '📦', '🔥', '🎨', '🕹️'];

function extKind(ext) {
  return KIND_BY_EXT.get(String(ext || '').toLowerCase()) || 'file';
}

function totalAssetCount() {
  return state.assetTypes.reduce((sum, type) => sum + (Number(type.count) || 0), 0);
}

function renderAssetTypes() {
  const list = $('#type-list');
  if (!list) return;
  list.innerHTML = '';
  for (const type of state.assetTypes) {
    const pill = document.createElement('div');
    pill.className = 'type-pill';

    const icon = document.createElement('span');
    icon.className = 'tp-icon';
    icon.textContent = type.icon || '◆';
    const name = document.createElement('span');
    name.className = 'tp-name';
    name.textContent = type.label;
    const ext = document.createElement('span');
    ext.className = 'tp-ext';
    ext.textContent = '.' + type.ext;

    const stepper = document.createElement('span');
    stepper.className = 'stepper';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.title = '减少';
    const value = document.createElement('b');
    value.textContent = String(Number(type.count) || 0);
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '＋';
    plus.title = '增加';
    const clampCount = (n) => Math.max(0, Math.min(12, n));
    minus.addEventListener('click', () => {
      type.count = clampCount((Number(type.count) || 0) - 1);
      value.textContent = String(type.count);
      persistAssetTypes();
      renderAssetHint();
    });
    plus.addEventListener('click', () => {
      type.count = clampCount((Number(type.count) || 0) + 1);
      value.textContent = String(type.count);
      persistAssetTypes();
      renderAssetHint();
    });
    stepper.append(minus, value, plus);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'type-remove';
    remove.textContent = '×';
    remove.title = '移除该类型';
    remove.addEventListener('click', () => {
      state.assetTypes = state.assetTypes.filter((t) => t.id !== type.id);
      renderAssetTypes();
      renderAssetHint();
      persistAssetTypes();
    });

    pill.append(icon, name, ext, stepper, remove);
    list.append(pill);
  }
  renderTypeMenu();
  persistAssetTypes();
}

function persistAssetTypes() {
  try {
    localStorage.setItem('assetTypes', JSON.stringify(state.assetTypes));
  } catch { /* ignore */ }
}

function restoreAssetTypes() {
  try {
    const raw = localStorage.getItem('assetTypes');
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    const cleaned = list
      .filter((type) => type && type.label && /^[a-z0-9]{1,6}$/.test(type.ext || ''))
      .slice(0, 10)
      .map((type, index) => ({
        id: type.id || `t${index}`,
        label: String(type.label).slice(0, 20),
        ext: String(type.ext).toLowerCase(),
        kind: type.kind || extKind(type.ext),
        count: Math.max(0, Math.min(12, Number(type.count) || 0)),
        custom: Boolean(type.custom),
        icon: type.icon || '◆',
      }));
    if (cleaned.length) state.assetTypes = cleaned;
  } catch { /* ignore */ }
}

function renderTypeMenu() {
  const menu = $('#type-menu');
  if (!menu) return;
  menu.innerHTML = '';

  for (const [kind, def] of Object.entries(ASSET_TYPE_DEFS)) {
    if (state.assetTypes.some((type) => type.kind === kind && !type.custom)) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `${def.icon}  ${def.label}（.${def.ext}）`;
    btn.addEventListener('click', () => {
      state.assetTypes.push({ id: kind, kind, label: def.label, icon: def.icon, ext: def.ext, count: 1, custom: false });
      $('#type-menu').hidden = true;
      $('#btn-add-type').setAttribute('aria-expanded', 'false');
      renderAssetTypes();
      renderAssetHint();
    });
    menu.append(btn);
  }

  const custom = document.createElement('button');
  custom.type = 'button';
  custom.textContent = '◆  自定义类型…';
  custom.addEventListener('click', openCustomTypeForm);
  menu.append(custom);
}

function toggleTypeMenu() {
  const menu = $('#type-menu');
  const btn = $('#btn-add-type');
  if (!menu) return;
  menu.hidden = !menu.hidden;
  btn?.setAttribute('aria-expanded', String(!menu.hidden));
  if (menu.hidden) $('#custom-type-form').hidden = true;
}

function openCustomTypeForm() {
  $('#type-menu').hidden = true;
  $('#btn-add-type').setAttribute('aria-expanded', 'false');
  const form = $('#custom-type-form');
  form.hidden = false;
  $('#ct-label').value = '';
  $('#ct-ext').value = '';
  $('#ct-label').focus();
}

function addCustomType() {
  const label = $('#ct-label').value.trim();
  const ext = $('#ct-ext').value.trim().toLowerCase().replace(/^\./, '');
  if (!label) return toast('请填写类型名称');
  if (!/^[a-z0-9]{1,6}$/.test(ext)) return toast('请填写明确的后缀名，如 wav、srt、cube');
  if (state.assetTypes.some((type) => type.ext === ext && type.label === label)) {
    return toast('这个类型已经添加过了');
  }
  const kind = extKind(ext);
  state.assetTypes.push({
    id: 't' + Date.now().toString(36),
    label,
    ext,
    kind,
    count: 1,
    custom: true,
    icon: '◆',
  });
  $('#custom-type-form').hidden = true;
  $('#ct-label').value = '';
  $('#ct-ext').value = '';
  renderAssetTypes();
  renderAssetHint();
  toast(`已添加：${label}（.${ext}）`);
}

function toggleAssetConfig() {
  const pop = $('#asset-config');
  const btn = $('#btn-asset-config');
  if (!pop) return;
  pop.hidden = !pop.hidden;
  btn?.setAttribute('aria-expanded', String(!pop.hidden));
}

function updateConfigSummary() {
  const el = $('#config-summary');
  if (!el) return;
  const selected = state.assetSources
    .filter((source) => state.assetSelected.has(source.id))
    .map((source) => source.label);
  el.textContent = selected.length ? selected.join(' · ') : '未选择来源';
}

function setWorkingFolder(folder) {
  const input = $('#sf-folder');
  if (!input) return;
  const value = String(folder || '').trim();
  input.value = value;
  const name = $('#wf-name');
  const btn = $('#btn-work-folder');
  if (value) {
    const sep = String.fromCharCode(92);
    const normalized = value.replace(/[/]+$/, '').split('/').join(sep);
    const parts = normalized.split(sep).filter(Boolean);
    const base = parts[parts.length - 1] || value;
    if (name) name.textContent = base;
    if (btn) btn.title = value;
    try { localStorage.setItem('lastAssetFolder', value); } catch { /* ignore */ }
  } else {
    if (name) name.textContent = '选择文件夹';
    if (btn) btn.title = '选择工作文件夹';
  }
  state.viewerFolder = value || state.viewerFolder;
  updateViewerFolder();
  renderAssetHint();
  if (state.viewerOpen) refreshViewer();
}

function updateViewerFolder() {
  const fromInput = ($('#sf-folder')?.value || '').trim();
  const fromRecord = state.assetRecord?.input?.folder || '';
  state.viewerFolder = fromInput || fromRecord || state.viewerFolder || '';
  const pathEl = $('#drawer-path');
  if (pathEl) pathEl.textContent = state.viewerFolder || '未选择文件夹';
}

function autoGrow(textarea) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
}

async function toggleViewer(force) {
  const next = typeof force === 'boolean' ? force : !state.viewerOpen;
  if (next) {
    updateViewerFolder();
    if (!state.viewerFolder) {
      toast('请先选择工作文件夹');
      return;
    }
  }
  state.viewerOpen = next;
  const drawer = $('#asset-drawer');
  if (!drawer) return;
  drawer.classList.toggle('open', next);
  drawer.setAttribute('aria-hidden', String(!next));
  if (next) await refreshViewer();
}

async function refreshViewer() {
  const body = $('#drawer-files');
  if (!body) return;
  updateViewerFolder();
  const folder = state.viewerFolder;
  const pathEl = $('#drawer-path');
  if (pathEl) pathEl.textContent = folder || '未选择文件夹';
  if (!folder) {
    body.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'viewer-empty';
    empty.textContent = '先选择工作文件夹';
    body.append(empty);
    return;
  }
  body.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'viewer-empty';
  loading.textContent = '正在读取文件夹…';
  body.append(loading);
  try {
    const data = await api(`/api/fs/files?path=${encodeURIComponent(folder)}`);
    state.viewerFiles = data.files || [];
    renderViewerFiles(state.viewerFiles);
  } catch (err) {
    body.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'viewer-empty';
    empty.textContent = err.message;
    body.append(empty);
  }
}

function renderViewerFiles(files) {
  const body = $('#drawer-files');
  if (!body) return;
  body.innerHTML = '';
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'viewer-empty';
    empty.textContent = '这个文件夹里还没有素材';
    body.append(empty);
    return;
  }
  const groups = { video: [], audio: [], image: [], other: [] };
  for (const file of files) (groups[file.kind] || groups.other).push(file);
  for (const kind of ['video', 'audio', 'image', 'other']) {
    if (!groups[kind].length) continue;
    const section = document.createElement('section');
    section.className = 'viewer-section';
    const head = document.createElement('h4');
    const label = kind === 'other' ? '其它文件' : (ASSET_KIND_LABEL[kind] || kind);
    head.textContent = `${label} · ${groups[kind].length}`;
    const grid = document.createElement('div');
    grid.className = 'viewer-grid';
    for (const file of groups[kind]) grid.append(buildViewerItem(file));
    section.append(head, grid);
    body.append(section);
  }
}

function buildViewerItem(file) {
  const card = document.createElement('div');
  card.className = 'v-item';
  const preview = document.createElement('div');
  preview.className = 'v-preview';
  const url = `/api/fs/file?path=${encodeURIComponent(file.path)}`;
  if (file.kind === 'image') {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = file.name;
    img.src = url;
    preview.append(img);
  } else if (file.kind === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.preload = 'metadata';
    preview.append(video);
  } else if (file.kind === 'audio') {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    audio.preload = 'metadata';
    preview.append(audio);
  } else {
    preview.textContent = 'FILE';
    preview.style.minHeight = '60px';
    preview.style.fontSize = '11px';
    preview.style.letterSpacing = '0.12em';
  }
  const meta = document.createElement('div');
  meta.className = 'v-meta';
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = file.name;
  link.title = file.rel;
  const info = document.createElement('span');
  info.textContent = `${file.rel} · ${formatBytes(file.bytes)}`;
  meta.append(link, info);
  card.append(preview, meta);
  return card;
}

async function openViewerFolder() {
  updateViewerFolder();
  if (!state.viewerFolder) return toast('请先选择工作文件夹');
  try {
    await api('/api/fs/open', { method: 'POST', body: JSON.stringify({ path: state.viewerFolder }) });
    toast('已在资源管理器中打开');
  } catch (err) {
    toast(err.message);
  }
}


/* -------------------- 提示词合集 -------------------- */
state.prompts = [];
state.promptDraft = { id: null, icon: '🎬' };

async function openPromptsDialog() {
  const dialog = $('#prompts-dialog');
  if (!dialog) return;
  resetPromptEditor();
  dialog.showModal();
  await loadPrompts();
}

async function loadPrompts() {
  try {
    const data = await api('/api/prompts');
    state.prompts = data.prompts || [];
    renderPromptList();
  } catch (err) {
    toast(err.message);
  }
}

function renderPromptList() {
  const list = $('#prompt-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.prompts.length) {
    const empty = document.createElement('div');
    empty.className = 'prompt-empty';
    empty.textContent = '还没有提示词，在下方新建一个吧';
    list.append(empty);
    return;
  }
  for (const prompt of state.prompts) {
    const card = document.createElement('div');
    card.className = 'prompt-btn';

    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'pb-use';
    const icon = document.createElement('span');
    icon.className = 'pb-icon';
    icon.textContent = prompt.icon || '💡';
    const body = document.createElement('span');
    body.className = 'pb-body';
    const title = document.createElement('strong');
    title.textContent = prompt.title || prompt.content.slice(0, 20);
    const preview = document.createElement('small');
    preview.textContent = prompt.content;
    body.append(title, preview);
    use.append(icon, body);
    use.addEventListener('click', () => usePrompt(prompt));

    const actions = document.createElement('span');
    actions.className = 'pb-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.title = '编辑';
    edit.textContent = '✎';
    edit.addEventListener('click', () => editPrompt(prompt));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.title = '删除';
    del.textContent = '×';
    del.addEventListener('click', () => removePrompt(prompt));
    actions.append(edit, del);

    card.append(use, actions);
    list.append(card);
  }
}

function usePrompt(prompt) {
  const brief = $('#sf-brief');
  if (!brief) return;
  brief.value = prompt.content;
  autoGrow(brief);
  $('#prompts-dialog').close();
  renderAssetHint();
  toast(`已填入「${prompt.title}」`);
}

function editPrompt(prompt) {
  state.promptDraft = { id: prompt.id, icon: prompt.icon || '🎬' };
  $('#prompt-title').value = prompt.title || '';
  $('#prompt-content').value = prompt.content || '';
  $('#prompt-icon-btn').textContent = state.promptDraft.icon;
  $('#pe-mode').textContent = '编辑提示词';
  $('#prompt-content').focus();
}

async function removePrompt(prompt) {
  if (!window.confirm(`删除提示词「${prompt.title}」？`)) return;
  try {
    await api(`/api/prompts/${encodeURIComponent(prompt.id)}`, { method: 'DELETE' });
    await loadPrompts();
    toast('已删除');
  } catch (err) {
    toast(err.message);
  }
}

function resetPromptEditor() {
  state.promptDraft = { id: null, icon: '🎬' };
  $('#prompt-title').value = '';
  $('#prompt-content').value = '';
  $('#prompt-icon-btn').textContent = '🎬';
  $('#icon-custom').value = '';
  $('#pe-mode').textContent = '新建提示词';
  $('#icon-menu').hidden = true;
}

function setPromptIcon(icon) {
  state.promptDraft.icon = icon || '🎬';
  $('#prompt-icon-btn').textContent = state.promptDraft.icon;
}

async function savePrompt() {
  const title = $('#prompt-title').value.trim();
  const content = $('#prompt-content').value.trim();
  if (!content) return toast('提示词内容不能为空');
  try {
    await api('/api/prompts', {
      method: 'POST',
      body: JSON.stringify({
        id: state.promptDraft.id || undefined,
        title,
        content,
        icon: state.promptDraft.icon || '🎬',
      }),
    });
    resetPromptEditor();
    await loadPrompts();
    toast('提示词已保存');
  } catch (err) {
    toast(err.message);
  }
}

function renderIconGrid() {
  const grid = $('#icon-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const icon of PROMPT_ICONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = icon;
    btn.addEventListener('click', () => {
      setPromptIcon(icon);
      $('#icon-menu').hidden = true;
    });
    grid.append(btn);
  }
}

function bindWorkbenchUi() {
  $('#btn-prompts')?.addEventListener('click', openPromptsDialog);
  $('#prompts-close')?.addEventListener('click', () => $('#prompts-dialog').close());
  $('#btn-pe-reset')?.addEventListener('click', resetPromptEditor);
  $('#btn-prompt-save')?.addEventListener('click', savePrompt);
  $('#btn-prompt-current')?.addEventListener('click', () => {
    const brief = $('#sf-brief').value.trim();
    if (!brief) return toast('需求框还是空的');
    $('#prompt-content').value = brief;
    if (!$('#prompt-title').value.trim()) $('#prompt-title').value = brief.slice(0, 20);
  });
  $('#prompt-icon-btn')?.addEventListener('click', () => {
    const menu = $('#icon-menu');
    menu.hidden = !menu.hidden;
  });
  $('#icon-custom')?.addEventListener('input', (event) => {
    const chars = [...event.target.value.trim()];
    if (chars.length) setPromptIcon(chars[0]);
  });
  $('#btn-ct-add')?.addEventListener('click', addCustomType);
  $('#btn-ct-cancel')?.addEventListener('click', () => { $('#custom-type-form').hidden = true; });
  $('#ct-label')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#ct-ext').focus(); });
  $('#ct-ext')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') addCustomType(); });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.icon-picker')) {
      const menu = $('#icon-menu');
      if (menu && !menu.hidden) menu.hidden = true;
    }
  });
  renderIconGrid();
}

bindWorkbenchUi();
