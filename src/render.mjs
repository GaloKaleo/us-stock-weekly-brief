// render.mjs — 结构化数据 -> Markdown / HTML
import { fmtMoney, weekdayNameCn, truncate, addDays, parseYmd, daysBetween } from './util.mjs';

const IMPORTANCE_CN = { high: '🔴 高', medium: '🟡 中', low: '⚪ 低' };

export function renderDataMarkdown(data) {
  const L = [];
  const push = (s = '') => L.push(s);

  push('# 美股周报 · 原始数据（' + data.weekStart + ' ~ ' + data.weekEnd + '）');
  push('');
  push('- 生成时间（美东）：' + data.todayNy + ' / 覆盖周起始：' + data.weekStart + '（美东）');
  push('- 数据来源：CNBC / MarketWatch / WSJ / 美联储 RSS，Nasdaq 财报与经济日历，SEC EDGAR 8-K');
  push('');

  push('## 一、本周经济日历（美国）');
  push('');
  if (data.econ.length) {
    push('| 日期 | 星期 | 时间(UTC) | 重要性 | 事件 | 预期 | 前值 | 实际 |');
    push('|---|---|---|---|---|---|---|---|');
    for (const e of data.econ) {
      push('| ' + e.date + ' | ' + e.weekdayCn + ' | ' + (e.timeEt || '—') + ' | ' + (IMPORTANCE_CN[e.importance] || '') + ' | ' + e.event + ' | ' + e.consensus + ' | ' + e.previous + ' | ' + e.actual + ' |');
    }
  } else push('_暂无数据_');
  push('');

  push('## 二、未来两周重要财报（市值 ≥ ' + fmtMoney(data.cfg.earnings.minMarketCap) + '）');
  push('');
  if (data.earnings.length) {
    push('| 日期 | 星期 | 盘前/盘后 | 代码 | 公司 | 市值 | 预期EPS | 去年同期EPS | 覆盖分析师 |');
    push('|---|---|---|---|---|---|---|---|---|');
    for (const e of data.earnings) {
      push('| ' + e.date + ' | ' + e.weekdayCn + ' | ' + e.timeCn + ' | ' + e.symbol + ' | ' + e.name + ' | ' + fmtMoney(e.marketCap) + ' | ' + e.epsForecast + ' | ' + e.lastYearEPS + ' | ' + (e.noOfEsts || '—') + ' |');
    }
  } else push('_暂无数据_');
  push('');

  push('## 三、关键日期（未来 ' + data.cfg.keyDatesDays + ' 天）');
  push('');
  if (data.keyDates.length) {
    for (const k of data.keyDates) {
      push('- **' + k.date + (k.endDate && k.endDate !== k.date ? ' ~ ' + k.endDate : '') + '** · ' + k.kind + ' · ' + k.title + ' — ' + k.detail);
    }
  } else push('_暂无数据_');
  push('');

  push('## 四、最新美股新闻（按重要度排序，共 ' + data.news.length + ' 条）');
  push('');
  for (const n of data.news) {
    push('- [' + n.category + '] **' + n.title + '**（' + n.source + ' · ' + n.dateCn + '）');
    if (n.summary) push('  ' + n.summary);
    if (n.link) push('  <' + n.link + '>');
  }
  push('');

  push('## 五、SEC 8-K 重大公告（自选股，最近 ' + data.cfg.edgar.days + ' 天）');
  push('');
  if (data.edgar.length) {
    for (const e of data.edgar) {
      push('- **' + e.date + '** · ' + e.ticker + ' · ' + e.company + ' · ' + e.form +
        (e.meanings.length ? ' · 事项：' + e.meanings.join('、') + '（' + e.items.join(', ') + '）' : '') +
        (e.url ? ' · ' + e.url : ''));
    }
  } else push('_窗口内无自选股 8-K 提交_');
  push('');
  return L.join('\n');
}

export const AI_INSTRUCTION = [
  '你是一名资深美股策略分析师，为一位中文读者撰写每周一早晨的「美股前瞻周报」。',
  '',
  '写作要求：',
  '1. 全部用简体中文，专业但易懂；不要出现英文长句，专有名词可保留英文。',
  '2. **只使用上面提供的数据**，绝对不要编造新闻、日期、数字或公司。数据里没有的不要写。',
  '3. 目标是让读者在这些事件发生**之前**就理解"为什么要关心它"，而不是事后复述。',
  '4. 严格按下面五节输出，不要添加额外章节，不要写"根据提供的数据"这类元话术，直接进入正文。',
  '',
  '输出格式（Markdown）：',
  '',
  '## 📌 一周要点速览',
  '3-5 条要点，每条一句话，说明本周市场最需要关注什么。',
  '',
  '## 🗓 本周关键日程',
  '按日期顺序列出本周最重要的经济数据与事件。用一个 Markdown 表格：日期 | 事件 | 重要性 | 提前了解要点。',
  '"提前了解要点"列每条 1-2 句，解释这个数据是什么、市场为什么在意、超预期/低于预期分别利好什么。',
  '',
  '## 📊 重点财报前瞻',
  '挑选市值最大或最受关注的 6-10 家，说明它是谁、属于什么行业、市场关注它的什么指标、对板块的指示意义。',
  '',
  '## 🔭 前瞻日历（未来 2-6 周）',
  '列出 FOMC、期权到期/四巫日、指数再平衡、休市日等，说明各自意味着什么、投资者需要提前做什么。',
  '',
  '## 📰 上周要闻回顾',
  '把新闻合并归类（宏观政策 / 科技AI / 财报个股 / 其他），每组 2-4 条，写明事件与影响，并给出来源链接。',
  '',
  '最后单独一行写：> 本简报由自动化程序 + AI 生成，仅供信息参考，不构成任何投资建议。',
].join('\n');

export function buildLlmPrompt(dataMarkdown) {
  return [
    AI_INSTRUCTION,
    '',
    '===== 以下是本期原始数据 =====',
    '',
    dataMarkdown,
    '',
    '===== 数据结束 =====',
    '',
    '现在请直接输出周报正文（Markdown），不要任何前言、解释或代码块包裹。',
  ].join('\n');
}

function withFooter(md) {
  if (/不构成任何投资建议/.test(md)) return md;
  return md.trimEnd() + '\n\n> 本简报由自动化程序 + AI 生成，仅供信息参考，不构成任何投资建议。\n';
}

/** 把 Markdown 标题整体降一级，避免与报告主标题冲突 */
export function demoteHeadings(md) {
  return String(md).split('\n').map((line) => (/^#{1,5}\s/.test(line) ? '#' + line : line)).join('\n');
}

export function renderFinalMarkdown(aiText, data) {
  const header =
    '# 🇺🇸 美股周报 · ' + data.weekStart + ' 当周\n\n' +
    '> 覆盖周期：' + data.weekStart + ' ~ ' + data.weekEnd + '（美东）　·　生成时间：' + data.generatedAtCn + '\n\n';
  if (aiText && aiText.trim()) return header + withFooter(aiText.trim());
  return header + '> ⚠️ 本期 AI 解读不可用，以下为规则聚合版本。\n\n' + withFooter(demoteHeadings(renderDataMarkdown(data)));
}

export function renderShortMarkdown(data, aiText) {
  const L = [];
  L.push('## 🇺🇸 美股周报 · ' + data.weekStart + ' 当周');
  L.push('');
  L.push('**本周关键日期**');
  L.push('');
  for (const k of data.keyDates.slice(0, 8)) {
    L.push('- ' + k.date + '　' + k.title);
  }
  if (!data.keyDates.length) L.push('- 本周无 FOMC / 期权到期 / 休市等特殊日程');
  L.push('');
  L.push('**本周重要数据**');
  L.push('');
  const high = data.econ.filter((e) => e.importance === 'high').slice(0, 8);
  if (high.length) for (const e of high) L.push('- ' + e.date + '　' + e.event + '（预期 ' + e.consensus + '）');
  else L.push('- 本周无高重要性数据');
  L.push('');
  L.push('**重点关注财报**');
  L.push('');
  const top = data.earnings.slice(0, 8);
  if (top.length) for (const e of top) L.push('- ' + e.date + ' ' + e.timeCn + '　' + e.symbol + ' ' + e.name + '（' + fmtMoney(e.marketCap) + '）');
  else L.push('- 窗口内无大市值公司披露');
  L.push('');
  L.push('**头条**');
  L.push('');
  for (const n of data.news.slice(0, 6)) L.push('- [' + n.source + '] ' + n.title);
  L.push('');
  L.push('完整报告见本次运行产物（Artifacts）。');
  return L.join('\n');
}

// ---------------------------------------------------------- 迷你 Markdown -> HTML
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  let t = escapeHtml(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  t = t.replace(/(^|\s)&lt;(https?:[^&\s]+)&gt;/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  return t;
}

export function markdownToHtml(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inList = false, inTable = false, inQuote = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (/^\s*$/.test(line)) { closeList(); closeTable(); closeQuote(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); closeTable(); closeQuote(); const lv = h[1].length; out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>'); continue; }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { closeList(); closeTable(); closeQuote(); out.push('<hr/>'); continue; }

    if (/^\|/.test(line)) {
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const next = (lines[i + 1] || '').trim();
      if (!inTable) { closeList(); closeQuote(); out.push('<table><thead><tr>' + cells.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'); inTable = true; }
      else if (/^\|[\s:-]+\|/.test(next) === false && /^\|?[\s:|-]+\|?$/.test(line) && cells.every((c) => /^:?-{2,}:?$/.test(c))) { continue; }
      else if (cells.every((c) => /^:?-{2,}:?$/.test(c))) { continue; }
      else out.push('<tr>' + cells.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      continue;
    } else closeTable();

    if (/^>\s?/.test(line)) { closeList(); if (!inQuote) { out.push('<blockquote>'); inQuote = true; } out.push('<p>' + inline(line.replace(/^>\s?/, '')) + '</p>'); continue; }
    else closeQuote();

    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { closeQuote(); if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(li[1]) + '</li>'); continue; }
    const oli = line.match(/^\s*\d+\.\s+(.*)$/);
    if (oli) { closeQuote(); if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(oli[1]) + '</li>'); continue; }
    closeList();

    out.push('<p>' + inline(line) + '</p>');
  }
  closeList(); closeTable(); closeQuote();
  return out.join('\n');
}

export function renderHtmlPage(title, md) {
  const body = markdownToHtml(md);
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8"/>\n<meta name="viewport" content="width=device-width,initial-scale=1"/>\n<title>' +
    escapeHtml(title) + '</title>\n<style>\n' +
    ':root{color-scheme:light dark}body{max-width:900px;margin:0 auto;padding:28px 18px 60px;font:15px/1.75 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1c1f23;background:#fff}\n' +
    'h1{font-size:26px;border-bottom:3px solid #d92b2b;padding-bottom:10px}h2{font-size:20px;margin-top:34px;padding-left:10px;border-left:4px solid #d92b2b}\n' +
    'table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13.5px}th,td{border:1px solid #e3e6ea;padding:7px 9px;text-align:left;vertical-align:top}\n' +
    'th{background:#f5f7fa;font-weight:600}tr:nth-child(even) td{background:#fafbfc}\n' +
    'blockquote{margin:16px 0;padding:10px 14px;background:#f6f8fa;border-left:4px solid #c9ced6;color:#4a5158;font-size:13.5px}\n' +
    'a{color:#0a58ca;text-decoration:none}a:hover{text-decoration:underline}code{background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:13px}\n' +
    'ul{padding-left:22px}li{margin:4px 0}hr{border:0;border-top:1px solid #e6e9ed;margin:26px 0}\n' +
    '@media(prefers-color-scheme:dark){body{background:#16181c;color:#dfe3e8}h2{border-color:#e05252}th{background:#22252b}tr:nth-child(even) td{background:#1b1e23}th,td{border-color:#2e3238}blockquote{background:#1d2026;color:#a7aeb7;border-color:#3a3f47}code{background:#24272d}a{color:#79b8ff}}\n' +
    '</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
}

export function dateRangeCn(a, b) { return a + ' ~ ' + b; }
