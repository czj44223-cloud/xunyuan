import { redactData } from './util/http.js';
import { csvCell } from './util/text.js';

export function exportMarkdown(record) {
  const lines = [];
  lines.push(record.report?.markdown || `# ${record.input.query}\n\n（暂无报告）`);
  if (record.table?.columns?.length) {
    lines.push('');
    lines.push(`## ${record.table.caption || '对比表'}`);
    lines.push('');
    lines.push('| ' + record.table.columns.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ') + ' |');
    lines.push('| ' + record.table.columns.map(() => '---').join(' | ') + ' |');
    for (const row of record.table.rows || []) {
      lines.push('| ' + row.map((v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |');
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`> 由「寻源」信息收集台生成 · ${new Date(record.createdAt).toLocaleString('zh-CN')} · 任务 ${record.id}`);
  if (record.stats?.estCostUsd) lines.push(`> 搜索/Fetch 估算成本：$${record.stats.estCostUsd}`);
  return lines.join('\n') + '\n';
}

export function exportCsv(record) {
  const table = record.table;
  if (table?.columns?.length) {
    const rows = [table.columns, ...(table.rows || [])];
    return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  const rows = [['序号', '标题', '站点', '日期', '链接']];
  (record.report?.citations || []).forEach((c) => {
    let site = '';
    try { site = new URL(c.url).hostname; } catch { /* ignore */ }
    const result = record.results.find((r) => r.id === c.resultId);
    rows.push([String(c.n), c.title, site, result?.publishedAt || '', c.url]);
  });
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function exportJson(record) {
  return JSON.stringify(redactData(record), null, 2);
}
