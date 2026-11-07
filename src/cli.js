#!/usr/bin/env node
import { redactText, redactData } from './core/util/http.js';
import { workPath } from './core/util/workspace.js';
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, describeConfig, getKey } from './core/config.js';
import { RunManager } from './core/runManager.js';
import { listProviders } from './core/search/index.js';
import { detectBrowserPath, closeBrowserPool } from './core/browser/pool.js';
import { fetchWithBrowser } from './core/fetch/browser.js';
import { extractFromHtml } from './core/extractor.js';
import { supportsGbk } from './core/util/charset.js';
import { exportMarkdown } from './core/export.js';
import { AssetManager } from './core/assetManager.js';
import { listAssetSources } from './core/assets/sources/index.js';
import { formatBytes } from './core/assets/downloader.js';
import { spawn } from 'node:child_process';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const cyan = (s) => c('36', s);

function parseArgs(args = []) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) flags[key] = inline;
      else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) { flags[key] = args[i + 1]; i++; }
      else flags[key] = true;
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function printEvent(event) {
  const time = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const prefix = dim(`[${time}]`);
  const stage = event.stage ? dim(`${event.stage.padEnd(10)}`) : ' '.repeat(10);
  let line = event.message || event.type;
  if (event.type === 'fetch.started') line = dim(line);
  else if (event.type.endsWith('.failed') || event.type === 'run.failed') line = red(line);
  else if (event.type === 'run.completed' || event.type === 'synthesize.done') line = green(line);
  else if (event.type === 'log' && event.stage === 'warn') line = yellow(line);
  console.log(`${prefix} ${stage} ${line}`);
}

async function cmdRun(args) {
  const flags = parseArgs(args);
  const query = flags._.join(' ').trim();
  if (!query) {
    console.error(red('请提供收集主题，例如：node src/cli.js run "国产大模型 2026 进展"'));
    process.exit(1);
  }
  const config = loadConfig();
  const manager = new RunManager(loadConfig);
  const record = await manager.create({
    query,
    mode: flags.mode === 'deep' ? 'deep' : 'fast',
    providers: typeof flags.providers === 'string' ? flags.providers.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    fetchLimit: flags.fetch,
    maxRounds: flags.rounds,
    wantTable: Boolean(flags.table),
    useLLM: flags['no-llm'] ? false : true,
  });

  console.log('');
  console.log(bold(`  任务 ${record.id}`) + dim(`  ·  ${record.input.mode === 'deep' ? '深度模式' : '快速模式'}  ·  最多抓取 ${record.input.fetchLimit} 页`));
  console.log(dim(`  搜索源：${(record.input.providers.length ? record.input.providers : ['自动']).join(', ')}  ·  LLM：${config && getKey('deepseek') && !flags['no-llm'] ? '开启' : '关闭'}`));
  console.log('');

  const entry = manager.get(record.id);
  const unsubscribe = entry.events.subscribe((event) => {
    if (!flags.quiet) printEvent(event);
  });

  await manager.wait(record.id);
  unsubscribe();
  const final = await manager.getRecord(record.id);
  await closeBrowserPool();

  if (final?.report?.markdown) {
    const markdown = exportMarkdown(final);
    if (typeof flags.out === 'string') {
      const outPath = flags.out.endsWith('.md') ? flags.out : `${flags.out}.md`;
      await fs.writeFile(await workPath(outPath, { create: true }), markdown, 'utf8');
      console.log(`\n${green('报告已写入')} ${outPath}`);
    } else if (!flags.json) {
      console.log('\n' + markdown);
    }
    if (typeof flags.out === 'string' || flags.json) {
      const auto = await manager.get(record.id);
      if (auto) console.log(dim(`\n原始记录：${auto.dir}\\record.json`));
    }
  }
  if (flags.json) console.log(JSON.stringify(redactData(final), null, 2));

  const stats = final?.stats || {};
  console.log('');
  console.log(
    `${final?.status === 'completed' ? green('完成') : red(final?.status || '失败')}` +
    dim(`  ·  候选 ${final?.results?.length || 0} 条  ·  可读 ${final?.results?.filter((r) => r.status === 'ok').length || 0} 篇`) +
    dim(`  ·  搜索 ${stats.searches || 0} 次  ·  LLM ${stats.llmCalls || 0} 次`) +
    (stats.estCostUsd ? dim(`  ·  约 $${stats.estCostUsd}`) : ''),
  );
  if (final?.warnings?.length) {
    console.log(yellow(`\n  共 ${final.warnings.length} 条警告（已写入记录）：`));
    for (const w of final.warnings.slice(0, 8)) console.log(yellow(`  · ${w}`));
  }
  if (final?.error) console.log(red(`\n  错误：${final.error}`));

  process.exit(final?.status === 'completed' ? 0 : 1);
}

async function cmdAssets(args) {
  const flags = parseArgs(args);
  const folder = flags._[0];
  const brief = flags._.slice(1).join(' ').trim() || (typeof flags.brief === 'string' ? flags.brief : '');
  if (!folder || !brief) {
    console.error(red('用法：node src/cli.js assets <文件夹> <素材需求> [--video 6] [--audio 1] [--image 4]'));
    console.error(dim('示例：node src/cli.js assets D:/剪辑项目/素材 "城市夜景航拍 霓虹 慢镜头" --video 6 --audio 1'));
    process.exit(1);
  }

  const config = loadConfig();
  const manager = new AssetManager(loadConfig);
  const record = await manager.create({
    folder,
    brief,
    counts: {
      video: Number(flags.video || 0),
      audio: Number(flags.audio || 0),
      image: Number(flags.image || 0),
    },
    sources: typeof flags.sources === 'string' ? flags.sources.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    useLLM: flags['no-llm'] ? false : true,
  });

  console.log('');
  console.log(bold('  素材任务 ' + record.id));
  console.log(dim('  保存到：' + record.input.folder));
  console.log(dim('  需求：' + record.input.brief));
  console.log('');

  const entry = manager.get(record.id);
  entry.events.subscribe((event) => {
    if (!flags.quiet) printEvent(event);
  });

  await manager.wait(record.id);
  const final = await manager.getRecord(record.id);
  await closeBrowserPool();

  if (final?.status === 'completed') {
    console.log('');
    console.log(`${green('完成')}  ·  下载 ${final.stats.downloaded} 个素材  ·  ${formatBytes(final.stats.bytes)}`);
    console.log(dim('  文件夹：' + final.input.folder));
    console.log(dim('  清单：' + path.join(final.input.folder, '素材清单.md')));
    if (flags.open) {
      const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(command, [final.input.folder], { detached: true, stdio: 'ignore' }).unref();
    }
  } else {
    console.log(red('失败：' + (final?.error || final?.status)));
  }
  if (final?.warnings?.length) {
    console.log('');
    console.log(yellow('警告：'));
    for (const w of final.warnings.slice(-8)) console.log(yellow('  · ' + w));
  }
  process.exit(final?.status === 'completed' ? 0 : 1);
}

async function cmdDoctor() {
  const config = loadConfig();
  const lines = [];
  const check = (ok, label, detail = '') => lines.push(`${ok ? green('✓') : red('✗')} ${label}${detail ? dim('  ' + detail) : ''}`);

  check(true, 'Node.js', process.version);
  check(supportsGbk(), 'GBK 解码支持', supportsGbk() ? 'TextDecoder 可用' : '当前 Node 未编译完整 ICU，中文 GBK 站点可能乱码');

  const chromePath = detectBrowserPath(config.browser.executablePath);
  check(Boolean(chromePath), '本机浏览器', chromePath || '未找到 Chrome/Edge，请安装或设置 CHROME_PATH');

  lines.push('');
  lines.push(bold('  密钥'));
  for (const [label, key] of [
    ['DeepSeek', getKey('deepseek')],
    ['Tavily', getKey('tavily')],
    ['博查', getKey('bocha')],
    ['Serper', getKey('serper')],
    ['Exa', getKey('exa')],
    ['SearXNG', getKey('searxng')],
  ]) {
    check(Boolean(key), label, key ? '已配置' : (label === 'Tavily' ? '未配置（将使用免密模式）' : '未配置'));
  }

  lines.push('');
  lines.push(bold('  素材源'));
  for (const source of listAssetSources()) {
    check(source.ready, source.label, source.ready ? '可用 · ' + (source.kinds.join('/')) : source.reason || '不可用');
  }

  lines.push('');
  lines.push(bold('  搜索源'));
  for (const p of listProviders()) {
    check(p.ready, p.label, p.ready ? (p.keyless ? p.reason || '可用' : '可用') : p.reason || '不可用');
  }

  lines.push('');
  console.log('\n' + lines.join('\n'));

  if (!chromePath) return;
  console.log('\n' + dim('  正在启动无头浏览器并抓取 example.com …'));
  try {
    const doc = await fetchWithBrowser('https://example.com', { config });
    const extracted = extractFromHtml(doc.html, doc.finalUrl);
    console.log(`  ${green('✓')} 浏览器启动并抓取成功：${doc.title || '(无标题)'} ${dim(`via=${doc.via} 正文 ${extracted.markdown.length} 字`)}`);
  } catch (err) {
    console.log(`  ${red('✗')} 浏览器抓取失败：${redactText(err.message)}`);
    console.log(dim('    可尝试在 .env 设置 CHROME_PATH，或安装最新版 Chrome。'));
  } finally {
    await closeBrowserPool();
  }
}

function cmdProviders() {
  const providers = listProviders();
  console.log('');
  for (const p of providers) {
    const badge = p.ready ? green('可用') : red('未配置');
    const extra = p.ready ? dim(p.keyless ? p.reason || '' : '') : dim(p.reason || '');
    console.log(`  ${badge}  ${bold(p.label.padEnd(18))} ${dim(p.id.padEnd(10))} ${extra}`);
  }
  console.log('');
  console.log(dim('  提示：未配置的源会被自动跳过；Tavily 在无密钥时走免密模式。'));
  console.log('');
}

function cmdConfig() {
  console.log(JSON.stringify(describeConfig(loadConfig()), null, 2));
}

function help() {
  console.log(`
${bold('寻源 · 无头浏览器信息收集台')}

用法：
  node src/cli.js run <主题> [选项]   运行一次信息收集
  node src/cli.js serve              启动 Web 界面（默认 http://127.0.0.1:8787）
  node src/cli.js assets <文件夹> <需求>  检索并下载素材到本地文件夹
  node src/cli.js doctor             环境与密钥自检
  node src/cli.js providers          查看搜索源状态
  node src/cli.js config             查看当前配置（密钥已脱敏）

run 选项：
  --mode deep         深度模式：自动多轮追问补全
  --rounds <n>        深度模式最多轮数（1-3，默认 2）
  --fetch <n>         最多抓取页面数（1-30）
  --providers a,b     指定搜索源：deepseek,tavily,bocha,serper,exa,searxng,browser
  --table             额外生成结构化对比表
  --no-llm            不调用 LLM，只做摘录汇总
  --out <file.md>     把报告写入文件（默认打印到终端）
  --json              输出完整运行记录 JSON
  --quiet             不打印实时进度

示例：
  node src/cli.js run "国产大模型 2026 年进展"
  node src/cli.js run "固态电池量产进展" --mode deep --rounds 2 --fetch 12 --table --out reports/battery.md

assets 选项：
  --video <n>         下载视频片段数量（默认 0）
  --audio <n>         下载背景音乐数量（默认 0）
  --image <n>         下载图片数量（默认 0，需要 Pixabay/Pexels Key）
  --sources a,b       指定素材源：mixkit,coverr,pixabay,pexels
  --no-llm            不调用 LLM 生成英文检索词
  --open              完成后打开目标文件夹

示例：
  node src/cli.js assets D:/剪辑项目/素材 "城市夜景航拍 霓虹 慢镜头" --video 6 --audio 1 --open
`);
}

const [command = 'help', ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case 'run': await cmdRun(rest); break;
    case 'serve':
      await import('./server.js');
      break;
    case 'assets': await cmdAssets(rest); break;
    case 'doctor': await cmdDoctor(); break;
    case 'providers': cmdProviders(); break;
    case 'config': cmdConfig(); break;
    case 'help':
    case '--help':
    case '-h': help(); break;
    default:
      console.error(red(`未知命令：${command}`));
      help();
      process.exit(1);
  }
} catch (err) {
  console.error(red(`\n执行失败：${redactText(err.message)}`));
  if (process.env.DEBUG) console.error('详细错误已隐藏，请查看脱敏任务记录');
  process.exit(1);
}
