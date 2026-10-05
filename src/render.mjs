// render.mjs — 结构化数据 -> Markdown / HTML
import { fmtMoney, weekdayNameCn, truncate, addDays, parseYmd, daysBetween } from './util.mjs';

const IMPORTANCE_CN = { high: '🔴 高', medium: '🟡 中', low: '⚪ 低' };

/**
 * 按板块给自选股新闻分组。板块归属由 config.watchlist.sectors 固定，
 * 不依赖 AI 判断（否则「纳斯达克上涨」这类市场综述会把 INTC 归到指数板块）。
 * @param {any[]} items 带 sector 字段的新闻
 * @param {string[]} order 板块顺序（来自配置）
 */
export const fmtPct = (p) => (p >= 0 ? '📈 +' : '📉 ') + Number(p).toFixed(2) + '%';

/**
 * 把周涨跌幅附加到成稿上。
 * 数字全部来自行情接口、由程序写入，绝不经过模型，避免 AI 编造价格。
 *   1) 在「📈 自选股动向」板块开头插入领涨/领跌摘要
 *   2) 给每只标的的加粗标题追加 📈 +x.xx% / 📉 -x.xx%
 */
export function annotatePerformance(md, perf) {
  const keys = Object.keys(perf || {});
  if (!keys.length) return md;

  let out = String(md).split('\n').map((line) => {
    const m = line.match(/^\*\*([^*]+)\*\*\s*$/);
    if (!m) return line;
    const inner = m[1].trim();
    const first = inner.split(/[\s　]+/)[0];
    const rec = perf[inner] || perf[first];
    if (!rec) return line;
    return line.trimEnd() + '　' + fmtPct(rec.pct);
  }).join('\n');

  const entries = keys.map((k) => [k, perf[k]]).sort((a, b) => b[1].pct - a[1].pct);
  const asOf = entries[0]?.[1]?.asOf || '';
  const up = entries.filter(([, v]) => v.pct > 0).slice(0, 4);
  const down = entries.filter(([, v]) => v.pct < 0).slice(-4).reverse();
  const L = ['**📊 本周涨跌**（' + (asOf ? '截至 ' + asOf + ' 收盘 · ' : '') + '共 ' + entries.length + ' 个标的）', ''];
  if (up.length) L.push('- 📈 领涨：' + up.map(([s, v]) => s + ' +' + v.pct.toFixed(2) + '%').join('　'));
  if (down.length) L.push('- 📉 领跌：' + down.map(([s, v]) => s + ' ' + v.pct.toFixed(2) + '%').join('　'));
  L.push('');
  return out.replace(/(^##\s*📈[^\n]*\n)/m, '$1\n' + L.join('\n'));
}

export function groupBySector(items, order = []) {
  const map = new Map();
  for (const it of items) {
    const s = it.sector || '其他';
    if (!map.has(s)) map.set(s, []);
    map.get(s).push(it);
  }
  const keys = [...map.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  return keys.map((k) => [k, map.get(k)]);
}

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

  push('## 六、自选股新闻（最近 ' + (data.cfg.watchlist?.maxAgeDays ?? 8) + ' 天）');
  push('');
  push('> ⚠️ 下面的板块归属是**固定给定的**，请原样沿用这些板块名称和分组，不要按新闻内容重新归类。');
  push('');
  const perf = data.watchlistPerf || {};
  if (Object.keys(perf).length) {
    const sorted = Object.entries(perf).sort((a, b) => b[1].pct - a[1].pct);
    push('### 本周涨跌（截至 ' + (sorted[0]?.[1]?.asOf || '') + ' 收盘）');
    push('');
    push('> 这些数字**由程序自动附加到每只标的的标题行**，你在正文里可以引用，但不要写进加粗标题行。');
    push('');
    for (const [sym, v] of sorted) push('- ' + sym + '　' + (v.pct >= 0 ? '+' : '') + v.pct.toFixed(2) + '%　（最新收盘 ' + v.last + '）');
    push('');
  }
  if (data.watchlistNews?.length) {
    for (const [sector, list] of groupBySector(data.watchlistNews, data.cfg.watchlist?.sectorOrder || [])) {
      push('### ' + sector + '（' + list.length + ' 条）');
      push('');
      for (const n of list) {
        push('- **[' + n.symbol + ']** ' + n.title + '（' + n.source + ' · ' + String(n.publishedAt).slice(0, 10) +
          (n.sentiment !== null && n.sentiment !== undefined ? ' · 情绪 ' + n.sentiment : '') + '）');
        if (n.link) push('  <' + n.link + '>');
      }
      push('');
    }
  } else push('_窗口内无自选股新闻_');
  push('');
  return L.join('\n');
}

export const AI_INSTRUCTION = [
  '你是一名资深美股策略分析师，为一位中文读者撰写每周一早晨的「美股前瞻周报」。',
  '',
  '【排版硬性要求】读者是在手机上看这份报告（企业微信群 + 微信推送），请严格遵守：',
  '1. **绝对不要使用表格**。手机屏幕窄，表格会被挤成一团看不清。',
  '2. **按日期分组**：每个交易日单独一行加粗小标题，下面用 - 列表逐条列出当天事件。',
  '3. 每条事件开头用 🔴 标注高重要性、🟡 标注中等重要性。',
  '4. 每条事件固定占一行，格式为：- {圆点} **事件名**　关键数值 —— 一句话解读',
  '   （「——」前后各留一个空格；关键数值写成「预期 55.1 / 前值 55.4」这种形式，数据里没有就整段省略）',
  '5. 板块之间空一行，不要出现超过三行的长段落。',
  '',
  '【内容要求】',
  '1. 全部用简体中文，专业但易懂；专有名词可保留英文。',
  '2. **只使用下面提供的数据**，绝对不要编造新闻、日期、数字或公司。',
  '3. 目标是让读者在事件发生**之前**理解「为什么要关心它」，而不是事后复述。',
  '4. 严格按下面五节输出，不要添加额外章节，不要写"根据提供的数据"这类元话术，直接进入正文。',
  '',
  '【输出格式示例 —— 请严格按照这个样式】',
  '',
  '## 📌 一周要点速览',
  '',
  '**① 就业走弱 vs 通胀降温**',
  '9 月非农仅新增 2.9 万、失业率升至 4.2%，核心 PCE 低于预期，加息担忧明显缓解。',
  '',
  '**② ISM 非制造业 PMI 是本周最关键数据**',
  '前值 55.4、预期 55.1，就业分项已跌破荣枯线，是判断服务业是否跟随制造业走弱的关键。',
  '',
  '（共 3-5 条，固定格式：加粗的一句话标题 + 换行 + 一句说明）',
  '',
  '## 🗓 本周关键日程',
  '',
  '**10/06 周二**',
  '- 🔴 **ISM 非制造业 PMI**　预期 55.1 / 前值 55.4 —— 服务业景气度风向标，低于预期利好债市与防御板块',
  '- 🟡 **ADP 就业**　前值 2 万 —— 高频就业指标，可作为周五初请的先行参考',
  '',
  '**10/07 周三**',
  '- 🔴 **FOMC 会议纪要** —— 市场借此判断委员们对就业下行与通胀黏性的权衡',
  '',
  '（每个交易日一个小标题，当天的重要事件逐条列出）',
  '',
  '## 📊 重点财报前瞻',
  '',
  '**10/08 周四 盘前**',
  '- **PEP 百事可乐**　市值 $171.8B　预期 EPS 2.29 —— 必需消费代表，关注北美量价是否齐跌',
  '',
  '（按「日期 + 盘前/盘后」分组，挑市值最大或最受关注的 6-10 家，格式同上）',
  '',
  '## 📈 自选股动向',
  '',
  '### 存储芯片',
  '',
  '**MU 美光**',
  '- Micron: The Market May Be Pricing In...（SeekingAlpha） —— 一句话说明这条消息对公司的含义',
  '- HBM 需求下具备翻倍潜力 —— 同一逻辑的强化版本',
  '',
  '**SNDK 闪迪**',
  '- 长期协议覆盖优质但估值偏贵（上调评级） —— 长协锁定价格是利好',
  '',
  '### AI 算力 / 数据中心供电',
  '',
  '**CRWV CoreWeave**',
  '- UBS 认为 AI 基础设施市场仍然火热 —— 算力租赁需求未见降温',
  '',
  '（数据里的第六节已经按板块分好组了，请严格遵守：',
  '  1. **原样沿用那些板块名称和分组**，绝对不要按新闻内容重新归类。',
  '     比如 INTC 永远属于「半导体」，哪怕它那条消息写的是市场综述也一样；SOXX 属于「指数 / ETF」。',
  '  2. 每个板块用 ### 三级标题，板块内**按标的拆分**：每只标的用一个加粗行 **代码 中文名** 开头，',
  '     它的新闻作为下面以 - 开头的条目，格式：- 标题（可译成中文） —— 一句话解读。',
  '  3. 标题里与标的重复的公司名前缀请去掉（「美光：xxx」→「xxx」），避免和标题行重复。',
  '  4. 数据里出现过的标的一个都不能漏；若某条确实是纯市场综述，保留条目但在解读里点明。',
  '  5. 同一只标的不能出现在两个板块下。',
  '  6. 不要在加粗标题行里写涨跌幅数字 —— 程序会自动把真实的周涨跌附加到标题行末尾。',
  '     但你可以在下面的解读文字里引用这些幅度，来说明消息与股价走势是否一致。）',
  '',
  '## 🔭 前瞻日历',
  '',
  '- **10/16 月度期权到期** —— 尾盘成交量与波动容易被放大，注意持仓集中度',
  '- **10/27-28 FOMC 议息会议** —— 全月波动最大的事件之一',
  '',
  '（列出 FOMC、期权到期/四巫日、指数再平衡、休市日，说明对投资者意味着什么）',
  '',
  '## 📰 上周要闻回顾',
  '',
  '**宏观政策**',
  '- 新闻标题（来源） —— 一句话说明影响',
  '',
  '**科技 AI**',
  '- ...',
  '',
  '（用 2-4 个小标题把新闻归类，每组 2-4 条，有条目对应的链接就附在末尾）',
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

const shortDate = (d) => String(d).slice(5).replace('-', '/');
const stripTrailingDate = (t) => String(t).replace(/（\d{4}-\d{2}-\d{2}）\s*$/, '');

/** 头部元信息：用短日期，手机上一眼扫完 */
function reportHeader(data) {
  return '# 🇺🇸 美股周报 · ' + shortDate(data.weekStart) + ' 当周\n\n' +
    '> 覆盖 ' + shortDate(data.weekStart) + ' ~ ' + shortDate(data.weekEnd) + '（美东）　·　生成于 ' + data.generatedAtCn + '\n';
}

/** 在每一节前插入分割线，让长报告在手机上的层次更清楚（markdown_v2 / 微信均支持 ---） */
export function decorateSections(md) {
  const out = [];
  let seenSection = false;
  for (const line of String(md).split('\n')) {
    if (/^##\s/.test(line)) {
      if (seenSection) out.push('', '---', '');
      seenSection = true;
    }
    out.push(line);
  }
  // 折叠多余空行，避免 `---` 前后出现三连换行
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * 规则聚合版（AI 不可用时的兜底）。
 * 与 AI 版保持同一套手机友好的列表排版，不使用表格。
 */
export function renderFallbackMarkdown(data) {
  const L = [];
  const push = (s = '') => L.push(s);
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1) + '…'; };

  push('## 🗓 本周关键日程');
  push('');
  const byDay = new Map();
  for (const e of data.econ) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  if (byDay.size) {
    for (const [d, items] of byDay) {
      push('**' + shortDate(d) + ' ' + items[0].weekdayCn + '**');
      for (const e of items) {
        const dot = e.importance === 'high' ? '🔴' : '🟡';
        const nums = [e.consensus && e.consensus !== '—' ? '预期 ' + e.consensus : '', e.previous && e.previous !== '—' ? '前值 ' + e.previous : ''].filter(Boolean).join(' / ');
        push('- ' + dot + ' **' + e.event + '**' + (nums ? '　' + nums : ''));
      }
      push('');
    }
  } else { push('_本周无重要美国经济数据_'); push(''); }

  push('## 📊 重点财报前瞻');
  push('');
  const featured = data.earnings.slice(0, 12);
  const eByDay = new Map();
  for (const e of featured) {
    const k = e.date + '|' + e.timeCn;
    if (!eByDay.has(k)) eByDay.set(k, []);
    eByDay.get(k).push(e);
  }
  if (eByDay.size) {
    for (const [k, items] of eByDay) {
      const [d, t] = k.split('|');
      push('**' + shortDate(d) + ' ' + items[0].weekdayCn + ' ' + t + '**');
      for (const e of items) push('- **' + e.symbol + ' ' + e.name + '**　市值 ' + fmtMoney(e.marketCap) + '　预期 EPS ' + e.epsForecast);
      push('');
    }
    if (data.earnings.length > featured.length) {
      push('_（本周另有 ' + (data.earnings.length - featured.length) + ' 家市值 ≥ ' + fmtMoney(data.cfg.earnings.minMarketCap) + ' 的公司披露，完整列表见 Actions 产物）_');
      push('');
    }
  } else { push('_窗口内无大市值公司披露_'); push(''); }

  push('## 🔭 前瞻日历');
  push('');
  if (data.keyDates.length) {
    for (const k of data.keyDates) {
      push('- **' + k.date + (k.endDate && k.endDate !== k.date ? ' ~ ' + k.endDate : '') + ' ' + stripTrailingDate(k.title) + '** —— ' + k.detail);
    }
  } else push('- 未来窗口内无特殊日程');
  push('');

  push('## 📎 SEC 8-K 重大公告');
  push('');
  if (data.edgar.length) {
    for (const e of data.edgar) {
      push('- **' + shortDate(e.date) + ' ' + e.ticker + '**' + (e.meanings.length ? '　事项：' + e.meanings.join('、') : '') + (e.url ? '　' + e.url : ''));
    }
  } else push('- 窗口内无自选股 8-K 提交');
  push('');

  push('## 📈 自选股动向');
  push('');
  if (data.watchlistNews?.length) {
    for (const [sector, list] of groupBySector(data.watchlistNews, data.cfg.watchlist?.sectorOrder || [])) {
      push('### ' + sector);
      push('');
      for (const n of list) {
        const rec = (data.watchlistPerf || {})[n.symbol];
        push('- **' + n.symbol + '**' + (rec ? '　' + fmtPct(rec.pct) : '') + '　' + clip(n.title, 72) + '（' + n.source + '）' + (n.link ? '　' + n.link : ''));
      }
      push('');
    }
  } else { push('- 窗口内无自选股新闻'); push(''); }

  push('## 📰 最新新闻');
  push('');
  const groups = new Map();
  for (const n of data.news) {
    if (!groups.has(n.category)) groups.set(n.category, []);
    groups.get(n.category).push(n);
  }
  for (const [cat, items] of groups) {
    push('**' + cat + '**');
    for (const n of items.slice(0, 5)) push('- ' + n.title + '（' + n.source + '）' + (n.link ? '　' + n.link : ''));
    push('');
  }
  return L.join('\n').trimEnd();
}

export function renderFinalMarkdown(aiText, data) {
  const header = reportHeader(data);
  const body = aiText && aiText.trim()
    ? decorateSections(aiText.trim())
    : '> ⚠️ 本期 AI 解读不可用，以下为规则聚合版本。\n\n' + renderFallbackMarkdown(data);
  return withFooter(header + '\n' + annotatePerformance(body, data.watchlistPerf || {}));
}

/** 从 AI 周报里抽出某一节正文（用于精简版复用 AI 的要点） */
export function extractSection(md, headingRe) {
  const lines = String(md || '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) { if (headingRe.test(lines[i])) start = i + 1; continue; }
    if (/^##\s/.test(lines[i])) return lines.slice(start, i).join('\n').trim();
  }
  return start === -1 ? '' : lines.slice(start).join('\n').trim();
}

/**
 * 精简版：给有严格长度限制的渠道用（企业微信 markdown 单条 4096 字节）。
 * 优先复用 AI 的「一周要点速览」，没有 AI 时退回头条新闻。
 * 目标体积 <= 3500 字节，确保一条发完。
 */
export function renderShortMarkdown(data, aiText) {
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1) + '…'; };
  const L = [];
  L.push('## 🇺🇸 美股周报 · ' + data.weekStart + ' 当周');
  L.push('');

  const highlights = extractSection(aiText, /^##\s*📌/);
  const bullets = highlights.split('\n').map((l) => l.match(/^\s*[-*]\s+(.*)$/)).filter(Boolean).map((m) => m[1]);
  if (bullets.length) {
    L.push('**要点速览**');
    L.push('');
    for (const b of bullets.slice(0, 5)) L.push('- ' + clip(b.replace(/\*\*/g, ''), 100));
    L.push('');
  } else {
    L.push('**头条**');
    L.push('');
    for (const n of data.news.slice(0, 5)) L.push('- ' + clip(n.title, 64));
    L.push('');
  }

  L.push('**关键日期**');
  L.push('');
  if (data.keyDates.length) {
    for (const k of data.keyDates.slice(0, 4)) {
      // 事件标题里往往已经带了日期（如「月度期权到期（2026-10-16）」），去掉避免重复
      const title = k.title.replace(/（\d{4}-\d{2}-\d{2}）\s*$/, '');
      L.push('- ' + k.date + '　' + clip(title, 44));
    }
  } else L.push('- 本周无 FOMC / 期权到期 / 休市等特殊日程');
  L.push('');

  L.push('**本周重要数据**');
  L.push('');
  // 经济日历里同一份数据常拆成多个子项（ISM 的非制造业 PMI/就业/新订单/物价…），
  // 精简版按前两个单词归组，每组只保留最短的那个名字，避免被截断成看不懂的碎片。
  const groups = new Map();
  for (const e of data.econ.filter((x) => x.importance === 'high')) {
    const key = e.event.toLowerCase().split(/\s+/).slice(0, 2).join(' ');
    const cur = groups.get(key);
    if (!cur || e.event.length < cur.event.length) groups.set(key, e);
  }
  const high = [...groups.values()].slice(0, 5);
  if (high.length) {
    for (const e of high) L.push('- ' + e.date.slice(5) + '　' + clip(e.event, 40) + (e.consensus && e.consensus !== '—' ? '（预期 ' + clip(e.consensus, 10) + '）' : ''));
  } else L.push('- 本周无高重要性数据');
  L.push('');

  L.push('**重点财报**');
  L.push('');
  const top = data.earnings.slice(0, 6);
  if (top.length) for (const e of top) L.push('- ' + e.date.slice(5) + ' ' + e.timeCn + '　' + e.symbol + '　' + fmtMoney(e.marketCap));
  else L.push('- 窗口内无大市值公司披露');
  L.push('');
  L.push('> 完整 AI 解读见 Server酱推送，或 Actions 运行产出的 Artifacts。');
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
