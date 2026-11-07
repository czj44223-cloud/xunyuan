import { redactText } from './util/http.js';
import { searchAll, resolveProviderIds, listProviders } from './search/index.js';
import { mergeAndRank } from './rank.js';
import { fetchArticle } from './fetch/index.js';
import { Semaphore } from './util/semaphore.js';
import { truncateToTokens } from './util/tokens.js';
import { cleanWhitespace, firstSentences, truncateChars } from './util/text.js';
import * as P from './prompts.js';

const PRICE_PER_CALL_USD = 0.00075;

export async function runCollection({ record, config, events, signal, llm, save }) {
  const emit = (type, message, data = null, stage = '') => events.emit(type, { stage, message, data });
  const input = record.input;
  const warnings = record.warnings;
  const stats = record.stats;

  const checkAbort = () => {
    if (signal.aborted) {
      const err = new Error('任务已取消');
      err.name = 'AbortError';
      throw err;
    }
  };

  const warn = (message, data = null) => {
    if (!warnings.includes(message)) warnings.push(message);
    if (warnings.length > 60) warnings.shift();
    emit('log', message, data, 'warn');
  };

  const providerIds = resolveProviderIds(input.providers, config);
  if (!providerIds.length) {
    const detail = listProviders()
      .filter((p) => !p.ready)
      .map((p) => `${p.label}：${p.reason || '未配置'}`)
      .join('；');
    throw new Error(`没有可用的搜索源。${detail || '请检查配置。'}`);
  }

  emit('run.started', `开始收集：${input.query}`, {
    query: input.query,
    mode: input.mode,
    providers: providerIds,
    fetchLimit: input.fetchLimit,
    useLLM: Boolean(input.useLLM && llm.ready),
  }, 'init');

  const usedQueries = new Set();
  const attemptedUrls = new Set();
  let remaining = input.fetchLimit;
  const maxRounds = input.mode === 'deep' && llm.ready ? input.maxRounds : 1;

  let queries = await planInitialQueries(input, llm, signal, emit);
  for (const q of queries) usedQueries.add(q);

  for (let round = 0; round < maxRounds && remaining > 0; round++) {
    checkAbort();
    record.rounds.push({ i: round, queries: [...queries], newSources: 0, fetched: 0 });
    emit('round.started', `第 ${round + 1} 轮检索：${queries.length} 条查询`, { round, queries }, 'search');

    const { results, errors } = await searchAll({
      queries,
      providerIds,
      count: config.search?.perProviderCount ?? 10,
      signal,
      config,
      emit,
      stats,
    });
    for (const e of errors) warn(`搜索源 ${e.provider} 失败：${e.message}`, e);
    checkAbort();

    const fresh = results.filter((r) => !attemptedUrls.has(r.url));
    const ranked = mergeAndRank(fresh, { query: input.query, limit: 30 });
    const perRound = input.mode === 'deep'
      ? Math.max(3, Math.ceil(input.fetchLimit / maxRounds))
      : input.fetchLimit;
    const batch = ranked.slice(0, Math.min(remaining, perRound));

    record.rounds.at(-1).newSources = batch.length;
    emit('dedupe.done', `去重排序后取 ${batch.length} 条来源准备抓取`, {
      raw: results.length,
      uniqueFresh: fresh.length,
      selected: batch.length,
    }, 'search');

    if (!batch.length) {
      warn('本轮没有新的可抓取来源');
      break;
    }

    const fetched = await fetchBatch(batch, {
      config, signal, emit, save, record, stats, attemptedUrls, warn, checkAbort, round,
    });
    record.results.push(...fetched);
    record.rounds.at(-1).fetched = fetched.filter((r) => r.status === 'ok').length;
    remaining -= fetched.length;
    save?.();

    const okCount = record.results.filter((r) => r.status === 'ok').length;
    emit('round.done', `第 ${round + 1} 轮完成：累计 ${okCount} 篇可读资料`, {
      round,
      fetched: fetched.length,
      ok: fetched.filter((r) => r.status === 'ok').length,
    }, 'fetch');

    if (input.useLLM && llm.ready) {
      await extractFacts(record.results.filter((r) => !r.facts && r.status === 'ok'), {
        query: input.query, config, signal, llm, emit, stats, warn, checkAbort,
      });
      save?.();
    }

    if (input.mode === 'deep' && round < maxRounds - 1 && llm.ready) {
      const followUps = await planFollowUps({
        query: input.query, results: record.results, usedQueries, llm, signal, emit, warn,
      });
      const freshQueries = followUps.filter((q) => !usedQueries.has(q));
      if (!freshQueries.length) {
        emit('log', '未发现新的信息缺口，提前结束深度检索', null, 'search');
        break;
      }
      queries = freshQueries;
      for (const q of freshQueries) usedQueries.add(q);
    }
  }

  checkAbort();
  const usable = record.results
    .filter((r) => r.status === 'ok' && r.extract?.markdown?.trim())
    .sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0));

  if (!usable.length) {
    warn('没有抓到任何可读正文，报告将只包含来源清单');
  }

  emit('synthesize.started', input.useLLM && llm.ready ? '正在生成综述报告…' : '生成摘录汇总…', {
    usable: usable.length,
  }, 'synthesize');

  let report;
  if (input.useLLM && llm.ready && usable.length) {
    try {
      report = await synthesizeReport({ query: input.query, usable, config, llm, signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      warn(`综述生成失败，已降级为摘录汇总：${redactText(err.message)}`);
      report = buildFallbackReport(input.query, usable, '模型调用失败');
    }
  } else {
    report = buildFallbackReport(
      input.query,
      usable,
      input.useLLM && llm.ready ? '没有可用正文' : '未启用 AI 整理',
    );
  }
  record.report = report;
  stats.llmCalls = llm.stats.calls;
  emit('synthesize.done', '报告已完成', { chars: report.markdown.length, citations: report.citations.length }, 'synthesize');

  checkAbort();
  if (input.wantTable) {
    record.table = await buildTable({
      query: input.query, usable, report, llm, signal, stats, warn, useLLM: input.useLLM && llm.ready,
    });
  }

  stats.llmCalls = llm.stats.calls;
  stats.estCostUsd = Number((
    (stats.byProvider?.deepseek || 0) * PRICE_PER_CALL_USD +
    (stats.deepseekFetchCalls || 0) * PRICE_PER_CALL_USD
  ).toFixed(4));
  record.stats = stats;
  save?.();
  return record;
}

async function planInitialQueries(input, llm, signal, emit) {
  if (input.mode !== 'deep') return [input.query];
  if (!llm.ready) {
    return [input.query, `${input.query} 最新进展`, `${input.query} 数据 报告`];
  }
  try {
    const data = await llm.json({
      system: P.QUERY_PLAN_SYSTEM,
      user: P.queryPlanUser(input.query),
      signal,
      maxTokens: 500,
    });
    const planned = (data.queries || [])
      .map((q) => String(q || '').trim())
      .filter((q) => q && q.length <= 128)
      .slice(0, 4);
    const all = [input.query, ...planned.filter((q) => q !== input.query)].slice(0, 5);
    emit('log', `深度模式检索计划：${all.length} 条查询`, { queries: all }, 'search');
    return all;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    emit('log', `检索计划生成失败，使用原查询：${redactText(err.message)}`, null, 'warn');
    return [input.query];
  }
}

async function fetchBatch(batch, ctx) {
  const { config, signal, emit, record, stats, attemptedUrls, warn, checkAbort, round } = ctx;
  const semaphore = new Semaphore(config.fetch?.concurrency ?? 4);
  const baseIndex = record.results.length;
  const out = new Array(batch.length);

  await Promise.all(batch.map((item, idx) => semaphore.run(async () => {
    attemptedUrls.add(item.url);
    checkAbort();
    emit('fetch.started', `抓取：${item.title.slice(0, 60) || item.url}`, {
      url: item.url, index: baseIndex + idx + 1,
    }, 'fetch');
    try {
      const article = await fetchArticle(item.url, { config, signal });
      stats.fetches = (stats.fetches || 0) + 1;
      if (article.via === 'deepseek-fetch') stats.deepseekFetchCalls = (stats.deepseekFetchCalls || 0) + 1;
      out[idx] = {
        ...item,
        id: `s${baseIndex + idx + 1}`,
        status: 'ok',
        via: article.via,
        strategy: article.strategy,
        chars: article.chars,
        quality: Number((article.quality || 0).toFixed(2)),
        extract: {
          title: article.title || item.title,
          markdown: truncateChars(article.markdown, 20000),
          quality: Number((article.quality || 0).toFixed(2)),
          truncated: article.markdown.length > 20000,
          attempts: article.attempts,
        },
        facts: null,
      };
      emit('fetch.done', `已抓取（${article.via}）：${(article.title || item.title).slice(0, 40)} · ${article.chars} 字`, {
        url: item.url,
        chars: article.chars,
        via: article.via,
        quality: Number((article.quality || 0).toFixed(2)),
      }, 'fetch');
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const status = err.code === 'BLOCKED' ? 'blocked'
        : err.code === 'SSRF_BLOCKED' ? 'ssrf_blocked'
          : 'failed';
      out[idx] = {
        ...item,
        id: `s${baseIndex + idx + 1}`,
        status,
        error: redactText(err.message),
        extract: null,
        facts: null,
      };
      warn(`抓取失败：${item.url}（${redactText(err.message)}）`, { url: item.url, error: redactText(err.message), status });
      emit('fetch.failed', `抓取失败：${item.title.slice(0, 40) || item.url}`, {
        url: item.url, error: redactText(err.message), status,
      }, 'fetch');
    }
  })));
  ctx.save?.();
  return out.filter(Boolean);
}

async function extractFacts(results, ctx) {
  const { query, signal, llm, emit, stats, warn, checkAbort } = ctx;
  if (!results.length) return;
  const semaphore = new Semaphore(2);
  await Promise.all(results.map((r) => semaphore.run(async () => {
    checkAbort();
    try {
      const content = truncateToTokens(r.extract.markdown, 7000).text;
      const data = await llm.json({
        system: P.EXTRACT_SYSTEM,
        user: P.extractUser(query, { id: r.id, url: r.url, content }),
        signal,
        maxTokens: 1500,
      });
      r.facts = normalizeFacts(data);
      r.relevance = typeof data.relevance === 'number' ? Math.max(0, Math.min(1, data.relevance)) : null;
      emit('llm.extract.done', `已梳理：${r.title.slice(0, 40)}（${r.facts.keyPoints.length} 条要点）`, {
        url: r.url, keyPoints: r.facts.keyPoints.length,
      }, 'extract');
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      warn(`要点抽取失败：${r.title.slice(0, 40)}（${redactText(err.message)}）`);
      r.facts = fallbackFacts(r.extract.markdown);
    }
  })));
  stats.llmCalls = llm.stats.calls;
}

function normalizeFacts(data = {}) {
  const points = Array.isArray(data.keyPoints) ? data.keyPoints : [];
  return {
    keyPoints: points
      .map((p) => (typeof p === 'string' ? { point: p, evidence: '' } : { point: String(p?.point || ''), evidence: String(p?.evidence || '') }))
      .filter((p) => p.point)
      .slice(0, 8),
    entities: Array.isArray(data.entities) ? data.entities.map(String).slice(0, 20) : [],
    numbers: Array.isArray(data.numbers)
      ? data.numbers.map((n) => ({ label: String(n?.label || ''), value: String(n?.value || '') })).filter((n) => n.label || n.value).slice(0, 15)
      : [],
    quotes: Array.isArray(data.quotes) ? data.quotes.map(String).slice(0, 5) : [],
    stance: String(data.stance || '').slice(0, 200),
    publishedAt: data.publishedAt ? String(data.publishedAt).slice(0, 30) : '',
  };
}

function fallbackFacts(markdown) {
  const paragraphs = cleanWhitespace(markdown).split(/\n{2,}/).filter((p) => p.length > 60);
  return {
    keyPoints: paragraphs.slice(0, 4).map((p) => ({ point: firstSentences(p, 150), evidence: '' })),
    entities: [],
    numbers: [],
    quotes: [],
    stance: '',
    publishedAt: '',
  };
}

async function planFollowUps({ query, results, usedQueries, llm, signal, emit, warn }) {
  const summary = results
    .filter((r) => r.status === 'ok')
    .slice(0, 15)
    .map((r) => `- ${r.title}：${firstSentences(r.extract?.markdown || '', 180)}`)
    .join('\n');
  try {
    const data = await llm.json({
      system: P.GAP_SYSTEM,
      user: P.gapUser(query, summary, [...usedQueries]),
      signal,
      maxTokens: 600,
    });
    const followUps = (data.followUps || [])
      .map((f) => String(f?.query || f || '').trim())
      .filter((q) => q && q.length <= 128)
      .slice(0, 3);
    emit('log', `缺口分析：发现 ${(data.gaps || []).length} 处信息缺口，追加 ${followUps.length} 条查询`, {
      gaps: data.gaps || [], followUps,
    }, 'search');
    return followUps;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    warn(`缺口分析失败：${redactText(err.message)}`);
    return [];
  }
}

function buildSources(usable, maxInputTokens) {
  const selected = usable.slice(0, 20);
  const perSourceTokens = Math.max(350, Math.floor((maxInputTokens - 6000) / Math.max(1, selected.length)));
  return selected.map((r, i) => ({
    n: i + 1,
    id: r.id,
    title: r.extract?.title || r.title,
    url: r.url,
    site: r.siteName || '',
    date: r.publishedAt || r.facts?.publishedAt || '',
    facts: r.facts,
    excerpt: truncateToTokens(r.extract.markdown, Math.min(1800, perSourceTokens)).text,
  }));
}

async function synthesizeReport({ query, usable, config, llm, signal }) {
  const sources = buildSources(usable, config.llm?.maxInputTokens ?? 30000);
  const { text } = await llm.chat({
    messages: [
      { role: 'system', content: P.SYNTH_SYSTEM },
      { role: 'user', content: P.synthesizeUser(query, sources) },
    ],
    temperature: 0.25,
    maxTokens: 4500,
    signal,
  });
  return validateCitations(text, sources, query);
}

function validateCitations(markdown, sources, query) {
  const valid = new Map(sources.map((s) => [s.n, s]));
  let cleaned = String(markdown || '')
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  cleaned = cleaned.replace(/\[(\d{1,2})\]/g, (m, n) => (valid.has(Number(n)) ? m : ''));
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');

  const used = new Set([...cleaned.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
  if (!used.size) {
    for (const s of sources.slice(0, 8)) used.add(s.n);
  }
  const citations = [...used].sort((a, b) => a - b).map((n) => {
    const s = valid.get(n);
    return { n, resultId: s.id, url: s.url, title: s.title };
  });

  let body = cleaned.replace(/\n##\s*参考来源[\s\S]*$/m, '').trim();
  if (!body) body = `# ${query}\n\n（模型未返回有效正文）`;
  const refBlock = '\n\n## 参考来源\n\n' + citations.map((c) => `- [${c.n}] ${c.title} — ${c.url}`).join('\n');
  return {
    markdown: body + refBlock,
    citations,
    degraded: false,
    generatedAt: new Date().toISOString(),
  };
}

function buildFallbackReport(query, usable, reason) {
  const lines = [];
  lines.push(`# ${query} · 信息收集报告`);
  lines.push('');
  lines.push(`> ${reason}。以下为本次抓取内容的摘录汇总，已保留全部来源链接供核对。`);
  lines.push('');
  lines.push('## 采集概况');
  lines.push('');
  lines.push(`- 可读来源：${usable.length} 篇`);
  lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}`);
  const sites = [...new Set(usable.map((r) => r.siteName).filter(Boolean))];
  if (sites.length) lines.push(`- 来源站点：${sites.slice(0, 12).join('、')}`);
  lines.push('');
  lines.push('## 来源摘录');
  lines.push('');

  const citations = [];
  const top = usable.slice(0, 15);
  top.forEach((r, i) => {
    const n = i + 1;
    citations.push({ n, resultId: r.id, url: r.url, title: r.extract?.title || r.title });
    lines.push(`### [${n}] ${(r.extract?.title || r.title).slice(0, 100)}`);
    lines.push('');
    const meta = [r.siteName, r.publishedAt, r.url].filter(Boolean).join(' · ');
    lines.push(`来源：${meta}`);
    lines.push('');
    if (r.facts?.keyPoints?.length) {
      for (const p of r.facts.keyPoints.slice(0, 5)) {
        lines.push(`- ${p.point}${p.evidence ? `（${p.evidence}）` : ''}`);
      }
    } else {
      lines.push(firstSentences(r.extract?.markdown || '', 320));
    }
    lines.push('');
  });

  lines.push('## 参考来源');
  lines.push('');
  for (const c of citations) lines.push(`- [${c.n}] ${c.title} — ${c.url}`);
  return {
    markdown: lines.join('\n'),
    citations,
    degraded: true,
    reason,
    generatedAt: new Date().toISOString(),
  };
}

async function buildTable({ query, usable, report, llm, signal, stats, warn, useLLM }) {
  if (!useLLM) {
    const rows = report.citations.map((c) => [String(c.n), c.title, (() => { try { return new URL(c.url).hostname; } catch { return ''; } })(), c.url]);
    return {
      caption: `${query} · 来源清单`,
      columns: ['序号', '标题', '站点', '链接'],
      rows,
      source: 'fallback',
    };
  }
  const sources = buildSources(usable, 20000);
  if (sources.length < 2) return null;
  try {
    const data = await llm.json({
      system: P.TABLE_SYSTEM,
      user: P.tableUser(query, sources),
      signal,
      maxTokens: 1800,
    });
    stats.llmCalls = llm.stats.calls;
    const table = normalizeTable(data);
    if (!table) throw new Error('表格结构不完整');
    return { ...table, source: 'llm' };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    warn(`对比表生成失败：${redactText(err.message)}`);
    const rows = report.citations.map((c) => [String(c.n), c.title, (() => { try { return new URL(c.url).hostname; } catch { return ''; } })(), c.url]);
    return { caption: `${query} · 来源清单`, columns: ['序号', '标题', '站点', '链接'], rows, source: 'fallback' };
  }
}

function normalizeTable(data = {}) {
  const columns = Array.isArray(data.columns)
    ? data.columns.map((c) => String(c || '').slice(0, 40)).filter(Boolean).slice(0, 8)
    : [];
  if (columns.length < 2) return null;
  const rows = (Array.isArray(data.rows) ? data.rows : [])
    .filter(Array.isArray)
    .map((row) => row.slice(0, columns.length).map((v) => String(v ?? '').slice(0, 300)))
    .filter((row) => row.length === columns.length)
    .slice(0, 15);
  if (!rows.length) return null;
  return { caption: String(data.caption || '').slice(0, 120), columns, rows };
}
