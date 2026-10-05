// main.mjs — 编排：采集 -> 渲染 -> AI -> 推送 -> 落盘
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  log, ensureDir, readJson, writeJson, nyDate, addDays, weekday, ymdOf,
} from './util.mjs';
import {
  collectNews, collectEcon, collectEarnings, collectEdgar8K,
  computeKeyDates, fetchFomcDates, collectWatchlistNews,
} from './sources.mjs';
import {
  renderDataMarkdown, renderFinalMarkdown, renderShortMarkdown,
  renderHtmlPage, buildLlmPrompt,
} from './render.mjs';
import { resolveLlmConfig, llmAvailable, chat } from './llm.mjs';
import { deliverAll, sendTest } from './deliver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'out');

/** 覆盖周的第一个交易日（美东）：周日/周六取下一周一，工作日取本周一 */
function reportWeekStart(todayNy) {
  const wd = weekday(todayNy);
  if (wd === 0) return addDays(todayNy, 1);
  if (wd === 6) return addDays(todayNy, 2);
  return addDays(todayNy, -(wd - 1));
}

function loadConfig() {
  const base = readJson(path.join(ROOT, 'config', 'default.json'), {});
  const local = readJson(path.join(ROOT, 'config', 'local.json'), null);
  const cfg = { ...base, ...(local || {}) };
  cfg.channels = { ...(base.channels || {}), ...((local && local.channels) || {}) };
  return cfg;
}

/** 把 GitHub Secrets / 环境变量注入渠道配置 */
function resolveChannels(cfg) {
  const env = process.env;
  const c = cfg.channels || {};
  const mode = (envName, cfgMode, fallback) => (env[envName] || cfgMode || fallback).trim();
  return {
    wecom: { enabled: Boolean(env.WECOM_WEBHOOK || c.wecom?.enabled), webhook: (env.WECOM_WEBHOOK || c.wecom?.webhook || '').trim(), mode: mode('WECOM_MODE', c.wecom?.mode, 'full') },
    dingtalk: { enabled: Boolean(env.DINGTALK_WEBHOOK), webhook: (env.DINGTALK_WEBHOOK || c.dingtalk?.webhook || '').trim(), secret: (env.DINGTALK_SECRET || c.dingtalk?.secret || '').trim(), mode: mode('DINGTALK_MODE', c.dingtalk?.mode, 'full') },
    feishu: { enabled: Boolean(env.FEISHU_WEBHOOK), webhook: (env.FEISHU_WEBHOOK || c.feishu?.webhook || '').trim(), mode: mode('FEISHU_MODE', c.feishu?.mode, 'full') },
    serverchan: { enabled: Boolean(env.SERVERCHAN_KEY), key: (env.SERVERCHAN_KEY || c.serverchan?.key || '').trim(), mode: mode('SERVERCHAN_MODE', c.serverchan?.mode, 'full') },
    pushplus: { enabled: Boolean(env.PUSHPLUS_TOKEN), token: (env.PUSHPLUS_TOKEN || c.pushplus?.token || '').trim(), mode: mode('PUSHPLUS_MODE', c.pushplus?.mode, 'full') },
  };
}

function appendStepSummary(md) {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (!p) return;
  try { fs.appendFileSync(p, md + '\n', 'utf8'); } catch { /* 忽略 */ }
}

function setOutput(name, value) {
  const p = process.env.GITHUB_OUTPUT;
  if (!p) return;
  try { fs.appendFileSync(p, name + '=' + String(value).replace(/\n/g, ' ') + '\n', 'utf8'); } catch { /* 忽略 */ }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run') || argv.includes('--no-push') || process.env.DRY_RUN === '1';
  const testOnly = argv.includes('--test-push') || process.env.TEST_PUSH === '1';

  const cfg = loadConfig();
  const channels = resolveChannels(cfg);

  if (testOnly) {
    log('仅执行推送通道连通性测试…');
    const results = await sendTest(channels);
    console.log(JSON.stringify(results, null, 2));
    return results.every((r) => r.ok) ? 0 : 1;
  }

  const todayNy = nyDate();
  const weekStart = reportWeekStart(todayNy);
  const weekEnd = addDays(weekStart, 6);
  const generatedAtCn = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date());

  log('=== 美股周报生成开始 ===');
  log('美东今天=' + todayNy + '  覆盖周=' + weekStart + ' ~ ' + weekEnd);

  const errors = [];

  log('[1/6] 拉取新闻…');
  const news = await collectNews(cfg).catch((e) => { errors.push('news: ' + e.message); log('  ! 新闻整体失败: ' + e.message); return []; });
  log('      ' + news.length + ' 条');

  log('[2/6] 拉取本周经济日历…');
  const econ = await collectEcon(weekStart, cfg.econ?.days ?? 6).catch((e) => { errors.push('econ: ' + e.message); return []; });
  log('      ' + econ.length + ' 项');

  log('[3/6] 拉取未来两周财报…');
  const earnings = await collectEarnings(weekStart, cfg.earnings?.days ?? 14, {
    minMarketCap: cfg.earnings?.minMarketCap ?? 20e9,
    maxPerDay: cfg.earnings?.maxPerDay ?? 8,
  }).catch((e) => { errors.push('earnings: ' + e.message); return []; });
  log('      ' + earnings.length + ' 家');

  log('[4/6] 拉取 FOMC 日历与 SEC 8-K…');
  const fomc = await fetchFomcDates().catch((e) => { errors.push('fomc: ' + e.message); return []; });
  // 8-K 监控范围 = 原有大市值清单 ∪ 用户自选股
  const edgarWatch = [...new Set([...(cfg.edgar?.watchlist || []), ...(cfg.watchlist?.symbols || [])])];
  const edgar = await collectEdgar8K(todayNy, cfg.edgar?.days ?? 7, edgarWatch).catch((e) => { errors.push('edgar: ' + e.message); return []; });
  const keyDates = computeKeyDates(weekStart, cfg.keyDatesDays ?? 45, fomc);
  log('      FOMC ' + fomc.length + ' 场 / 8-K ' + edgar.length + ' 条 / 关键日期 ' + keyDates.length + ' 个');

  log('[5/6] 拉取自选股新闻…');
  const watchlistNews = await collectWatchlistNews(cfg).catch((e) => { errors.push('watchlist: ' + e.message); return []; });
  const covered = new Set(watchlistNews.map((x) => x.symbol));
  log('      ' + watchlistNews.length + ' 条 / 覆盖 ' + covered.size + ' 个标的');

  const data = {
    todayNy, weekStart, weekEnd, generatedAtCn,
    cfg: {
      earnings: { minMarketCap: cfg.earnings?.minMarketCap ?? 20e9 },
      keyDatesDays: cfg.keyDatesDays ?? 45,
      edgar: { days: cfg.edgar?.days ?? 7 },
    },
    news, econ, earnings, edgar, keyDates, fomc, watchlistNews, errors,
  };

  ensureDir(OUT);
  const dataMd = renderDataMarkdown(data);
  fs.writeFileSync(path.join(OUT, 'raw-data.md'), dataMd, 'utf8');
  writeJson(path.join(OUT, 'raw-data.json'), data);

  log('[6/6] 生成 AI 解读…');
  let aiText = null;
  const llmCfg = resolveLlmConfig(cfg.llm);
  if (cfg.llm?.enabled === false) log('      已在配置中禁用 AI');
  else if (!llmAvailable(llmCfg)) log('      ! 未配置 LLM 凭据（' + (process.env.LLM_PROVIDER || cfg.llm?.provider || 'deepseek') + '），跳过 AI');
  else {
    log('      使用 ' + llmCfg.label + ' / ' + llmCfg.model);
    try {
      aiText = await chat(llmCfg, { user: buildLlmPrompt(dataMd) });
      log('      AI 生成 ' + aiText.length + ' 字符');
    } catch (err) {
      errors.push('llm: ' + err.message);
      log('      ! AI 生成失败: ' + err.message);
    }
  }

  const title = '美股周报 · ' + weekStart + ' 当周';
  const finalMd = renderFinalMarkdown(aiText, data);
  const shortMd = renderShortMarkdown(data, aiText);
  const html = renderHtmlPage(title, finalMd);

  const stamp = todayNy;
  const files = {
    md: path.join(OUT, stamp + '.md'),
    html: path.join(OUT, stamp + '.html'),
    latestMd: path.join(OUT, 'latest.md'),
    latestHtml: path.join(OUT, 'latest.html'),
  };
  fs.writeFileSync(files.md, finalMd, 'utf8');
  fs.writeFileSync(files.html, html, 'utf8');
  fs.writeFileSync(files.latestMd, finalMd, 'utf8');
  fs.writeFileSync(files.latestHtml, html, 'utf8');
  log('      报告已写入 out/' + stamp + '.md / .html');

  appendStepSummary(finalMd);
  setOutput('week_start', weekStart);
  setOutput('report_path', 'out/' + stamp + '.md');
  setOutput('ai_used', aiText ? 'true' : 'false');

  const anyChannel = Object.values(channels).some((c) => c.enabled);
  if (dryRun) {
    log('--dry-run：跳过推送。启用情况 = ' + JSON.stringify(Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.enabled]))));
  } else if (!anyChannel) {
    log('! 未配置任何推送渠道，仅生成本地产物。请设置仓库 Secrets（如 WECOM_WEBHOOK）。');
  } else {
    log('推送中…');
    const results = await deliverAll(channels, { title, fullMd: finalMd, shortMd });
    writeJson(path.join(OUT, 'delivery-result.json'), results);
    for (const r of results) log((r.ok ? '  ✓ ' : '  ✗ ') + r.channel + (r.error ? ' — ' + r.error : ''));
    if (results.length && results.every((r) => !r.ok)) errors.push('delivery: 所有渠道均失败');
  }

  if (errors.length) log('完成，但有以下警告：\n  - ' + errors.join('\n  - '));
  log('=== 美股周报生成结束 ===');
  return errors.some((e) => e.startsWith('llm:') || e.startsWith('news:')) ? 1 : 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => { console.error('[FATAL]', err); process.exit(1); });
