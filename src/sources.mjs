// sources.mjs — 数据采集：新闻 / 经济日历 / 财报 / 8-K / 关键日期
import {
  httpText, httpJson, parseFeed, stripHtml, decodeEntities, truncate,
  nyDate, addDays, weekday, weekdayNameCn, nthWeekday, ymdOf, parseYmd,
  rangeYmd, parseMoney, log, sleep,
} from './util.mjs';

// SEC 要求 User-Agent 中必须包含可联系的邮箱，否则返回 403
export const SEC_CONTACT = process.env.SEC_CONTACT_EMAIL || 'weekly-brief@example.com';
const EDGAR_UA = 'us-stock-weekly-brief/1.0 (' + SEC_CONTACT + ')';
const NASDAQ_HEADERS = { 'Accept': 'application/json, text/plain, */*', 'Origin': 'https://www.nasdaq.com', 'Referer': 'https://www.nasdaq.com/' };

// ---------------------------------------------------------------- 新闻源
export const NEWS_FEEDS = [
  { id: 'cnbc-top',       name: 'CNBC',           weight: 2.6, url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { id: 'cnbc-markets',   name: 'CNBC Markets',   weight: 2.7, url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258' },
  { id: 'cnbc-tech',      name: 'CNBC Tech',      weight: 2.2, url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910' },
  { id: 'cnbc-earnings',  name: 'CNBC Earnings',  weight: 2.5, url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839135' },
  { id: 'mw-top',         name: 'MarketWatch',    weight: 2.4, url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { id: 'mw-realtime',    name: 'MarketWatch',    weight: 2.3, url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines' },
  { id: 'mw-marketpulse', name: 'MarketWatch',    weight: 2.1, url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse' },
  { id: 'dj-markets',     name: 'WSJ Markets',    weight: 3.0, url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml' },
  { id: 'wsj-business',   name: 'WSJ Business',   weight: 2.8, url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml' },
  { id: 'fed-press',      name: '美联储',          weight: 3.6, url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
];

const CATEGORY_RULES = [
  { category: '货币政策', w: 3.0, re: /\b(fed|fomc|powell|rate cut|rate hike|interest rate|monetary policy|balance sheet|qt|dot plot|美联储|降息|加息)\b/i },
  { category: '通胀就业', w: 2.8, re: /\b(inflation|cpi|ppi|pce|jobs report|nonfarm|payroll|unemployment|jobless|labor market|wage)\b/i },
  { category: '关税地缘', w: 2.6, re: /\b(tariff|trade war|sanction|export control|geopolit|china|beijing|semiconductor ban)\b/i },
  { category: '科技AI',   w: 2.5, re: /\b(ai|artificial intelligence|nvidia|gpu|data center|datacenter|chip|semiconductor|openai|hyperscaler|llm|model)\b/i },
  { category: '财报个股', w: 2.4, re: /\b(earnings|quarter|revenue|guidance|profit|results|beats|misses|outlook|回购|财报)\b/i },
  { category: '市场行情', w: 1.6, re: /\b(stocks|market|s&p|nasdaq|dow|rally|selloff|record high|treasury|yield|bond|vix|gold|oil)\b/i },
];

const MUST_HIT = /\b(trump|white house|tariff|fed|fomc|powell|inflation|cpi|pce|jobs|payroll|recession|rate cut|nvidia|apple|microsoft|alphabet|google|amazon|meta|tesla|openai|ai|chip|semiconductor|earnings|guidance|sec|merger|acquisition|bankrupt|default|shutdown|debt ceiling)\b/i;

function scoreNews(item, feed, now) {
  let score = feed.weight;
  const hay = item.title + ' ' + item.summary;
  for (const rule of CATEGORY_RULES) if (rule.re.test(hay)) { score += rule.w; break; }
  if (MUST_HIT.test(hay)) score += 1.2;
  const t = Date.parse(item.date);
  if (!Number.isNaN(t)) {
    const ageH = (now - t) / 3600000;
    if (ageH <= 24) score += 1.4;
    else if (ageH <= 72) score += 0.8;
    else if (ageH <= 168) score += 0.3;
    else score -= 1.5;
  } else score -= 0.5;
  if (item.title.length < 25) score -= 0.4;
  return score;
}

function categorize(text) {
  for (const rule of CATEGORY_RULES) if (rule.re.test(text)) return rule.category;
  return '综合';
}

function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '').slice(0, 60);
}

export async function collectNews(cfg, now = Date.now()) {
  const maxAgeDays = cfg.news?.maxAgeDays ?? 8;
  const limit = cfg.news?.limit ?? 22;
  const perFeed = cfg.news?.perFeed ?? 12;
  const buckets = await Promise.allSettled(
    NEWS_FEEDS.map(async (feed) => {
      const xml = await httpText(feed.url, { timeoutMs: 25000, retries: 1 });
      return parseFeed(xml).slice(0, perFeed).map((it) => ({ ...it, feed: feed.name, feedId: feed.id }));
    }),
  );

  let all = [];
  for (const b of buckets) {
    if (b.status === 'fulfilled') all.push(...b.value);
    else log('  ! 新闻源失败:', b.reason?.message);
  }

  const seen = new Set();
  const cutoff = now - maxAgeDays * 86400000;
  const scored = [];
  for (const it of all) {
    if (!it.title) continue;
    const t = Date.parse(it.date);
    if (!Number.isNaN(t) && t < cutoff) continue;
    const key = normTitle(it.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const feed = NEWS_FEEDS.find((f) => f.id === it.feedId);
    scored.push({
      title: it.title,
      link: it.link,
      source: it.feed,
      date: Number.isNaN(t) ? null : new Date(t).toISOString(),
      dateCn: Number.isNaN(t) ? '—' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)),
      summary: truncate(it.summary, 320),
      category: categorize(it.title + ' ' + it.summary),
      score: scoreNews(it, feed, now),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------- 经济日历
const ECON_IMPORTANCE = [
  { level: 'high', re: /(fomc|fed (chair|speaks)|interest rate decision|federal funds|nonfarm|non-farm|payrolls|unemployment rate|core cpi|cpi|core pce|pce price|gdp|retail sales|ism (manufacturing|services|non-manufacturing)|consumer confidence|jolts|average hourly earnings)/i },
  { level: 'medium', re: /(initial jobless claims|continuing jobless claims|ppi|producer price|durable goods|industrial production|housing starts|building permits|existing home sales|new home sales|trade balance|michigan|empire state|philly fed|chicago pmi|adp|crude oil inventories|treasury|beige book)/i },
];
const ECON_SKIP = /(all car sales|all truck sales|chain store|retail sales ex|bank holiday)/i;
const ECON_SPEAK = /\bspeaks?\b/i;
const ECON_SPEAK_KEEP = /(fed|fomc|chair|powell|governor|president of the (new york|richmond|boston|chicago))/i;

function econImportance(name) {
  for (const r of ECON_IMPORTANCE) if (r.re.test(name)) return r.level;
  return 'low';
}

export async function collectEcon(weekStart, days = 6) {
  const out = [];
  const dates = rangeYmd(weekStart, days);
  for (const d of dates) {
    if (weekday(d) === 0 || weekday(d) === 6) continue;
    try {
      const j = await httpJson('https://api.nasdaq.com/api/calendar/economicevents?date=' + d, { headers: NASDAQ_HEADERS, timeoutMs: 25000, retries: 1 });
      const rows = j?.data?.rows || [];
      for (const r of rows) {
        if (r.country !== 'United States') continue;
        const name = stripHtml(r.eventName);
        if (!name || ECON_SKIP.test(name)) continue;
        if (ECON_SPEAK.test(name) && !ECON_SPEAK_KEEP.test(name)) continue;
        const level = econImportance(name);
        if (level === 'low') continue;
        out.push({
          date: d,
          weekdayCn: weekdayNameCn(d),
          timeEt: r.gmt ? r.gmt + ' UTC' : '',
          event: name,
          importance: level,
          consensus: stripHtml(r.consensus) || '—',
          previous: stripHtml(r.previous) || '—',
          actual: stripHtml(r.actual) || '—',
        });
      }
    } catch (err) {
      log('  ! 经济日历 ' + d + ' 失败: ' + err.message);
    }
    await sleep(150);
  }
  const rank = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => (a.date === b.date ? rank[a.importance] - rank[b.importance] : a.date < b.date ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------- 财报
const EARN_TIME_CN = {
  'time-pre-market': '盘前',
  'time-after-hours': '盘后',
  'time-not-supplied': '时间待定',
};

export async function collectEarnings(startYmd, days, { minMarketCap = 20e9, maxPerDay = 8 } = {}) {
  const out = [];
  for (const d of rangeYmd(startYmd, days)) {
    if (weekday(d) === 0 || weekday(d) === 6) continue;
    try {
      const j = await httpJson('https://api.nasdaq.com/api/calendar/earnings?date=' + d, { headers: NASDAQ_HEADERS, timeoutMs: 25000, retries: 1 });
      const rows = j?.data?.rows || [];
      const picked = rows
        .map((r) => ({
          date: d,
          weekdayCn: weekdayNameCn(d),
          symbol: r.symbol,
          name: stripHtml(r.name),
          marketCap: parseMoney(r.marketCap),
          timeCn: EARN_TIME_CN[r.time] || '时间待定',
          epsForecast: stripHtml(r.epsForecast) || '—',
          lastYearEPS: stripHtml(r.lastYearEPS) || '—',
          fiscalQuarter: stripHtml(r.fiscalQuarterEnding) || '',
          noOfEsts: r.noOfEsts || '',
        }))
        .filter((r) => r.marketCap >= minMarketCap)
        .sort((a, b) => b.marketCap - a.marketCap)
        .slice(0, maxPerDay);
      out.push(...picked);
    } catch (err) {
      log('  ! 财报 ' + d + ' 失败: ' + err.message);
    }
    await sleep(150);
  }
  return out;
}

// ---------------------------------------------------------------- SEC 8-K
let tickerMapCache = null;

async function loadTickerMap() {
  if (tickerMapCache) return tickerMapCache;
  const raw = await httpText('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': EDGAR_UA }, timeoutMs: 30000 });
  const map = new Map();
  for (const rec of Object.values(JSON.parse(raw))) {
    map.set(String(rec.ticker).toUpperCase(), { cik: String(rec.cik_str).padStart(10, '0'), title: rec.title });
  }
  tickerMapCache = map;
  return map;
}

const EIGHTK_MEANING = {
  '1.01': '签署重大合同', '1.02': '终止重大合同', '1.03': '破产/接管',
  '2.01': '完成重大收购或处置', '2.02': '公布经营业绩/指引', '2.03': '承担重大债务',
  '2.04': '触发加速还款义务', '2.05': '重组费用', '2.06': '资产减值',
  '3.01': '退市/上市资格瑕疵', '3.02': '未登记的股权出售', '3.03': '修改证券持有人权利',
  '4.01': '更换审计师', '4.02': '财务报表不可依赖', '5.01': '控制权变更',
  '5.02': '高管/董事变动', '5.03': '修改公司章程', '7.01': 'FD 披露', '8.01': '其他重大事件',
};

/** 从 EDGAR 每日索引行中取出文件名（列宽在不同日期略有差异，用正则更稳） */
function parseIdxLine(line) {
  const fileMatch = line.match(/(edgar\/data\/\S+)\s*$/);
  if (!fileMatch) return null;
  const filename = fileMatch[1].trim();
  return {
    form: line.slice(0, 12).trim(),
    company: line.slice(12, 74).trim(),
    cikRaw: line.slice(74, 86).trim(),
    filename,
    accession: (filename.match(/(\d{10}-\d{2}-\d{6})/) || [])[1] || '',
  };
}

/**
 * 抓取 8-K 的 Item 编号。
 * 直接取完整提交文件（.txt）：它一定包含封面页的 Item 列表，避免了
 * 从 index.json 里猜哪一份 HTML 才是主文档（附件名字千奇百怪）。
 */
export function edgarLandingUrl(cikNum, accession) {
  return 'https://www.sec.gov/Archives/edgar/data/' + Number(cikNum) + '/' + accession.replace(/-/g, '') + '/' + accession + '-index.html';
}

async function enrichItems(cikNum, accession) {
  const landing = edgarLandingUrl(cikNum, accession);
  if (!accession) return { items: [], meanings: [], url: landing };
  const base = 'https://www.sec.gov/Archives/edgar/data/' + Number(cikNum) + '/' + accession.replace(/-/g, '');
  try {
    const txt = await httpText(base + '/' + accession + '.txt', { headers: { 'User-Agent': EDGAR_UA }, timeoutMs: 45000, retries: 1 });
    const items = [...new Set((txt.match(/Item\s+([1-9]\.\d{2})/gi) || []).map((m) => m.replace(/item\s+/i, '')))].sort();
    return { items, meanings: items.map((i) => EIGHTK_MEANING[i]).filter(Boolean), url: landing };
  } catch {
    return { items: [], meanings: [], url: landing };
  }
}

export async function collectEdgar8K(endYmd, days = 7, watchlist = [], { enrich = true, maxEnrich = 12 } = {}) {
  let map;
  try { map = await loadTickerMap(); } catch (err) { log('  ! SEC 代码表获取失败: ' + err.message); return []; }

  const wanted = new Map();
  for (const t of watchlist) {
    const rec = map.get(String(t).toUpperCase());
    if (rec) wanted.set(rec.cik, { ticker: String(t).toUpperCase(), title: rec.title });
  }
  if (!wanted.size) return [];

  const results = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(endYmd, -i);
    if (weekday(d) === 0 || weekday(d) === 6) continue;
    const year = d.slice(0, 4);
    const qtr = 'QTR' + Math.ceil(Number(d.slice(5, 7)) / 3);
    const url = 'https://www.sec.gov/Archives/edgar/daily-index/' + year + '/' + qtr + '/form.' + d.replace(/-/g, '') + '.idx';
    try {
      const txt = await httpText(url, { headers: { 'User-Agent': EDGAR_UA }, timeoutMs: 30000, retries: 1 });
      for (const line of txt.split('\n')) {
        if (!/^8-K/.test(line)) continue;
        const parsed = parseIdxLine(line);
        if (!parsed) continue;
        const cik = parsed.cikRaw.padStart(10, '0');
        if (!wanted.has(cik)) continue;
        const meta = wanted.get(cik);
        results.push({
          date: d,
          weekdayCn: weekdayNameCn(d),
          form: parsed.form,
          ticker: meta.ticker,
          company: parsed.company || meta.title,
          cik,
          accession: parsed.accession,
          filename: parsed.filename,
          items: [],
          meanings: [],
          url: edgarLandingUrl(cik, parsed.accession),
        });
      }
    } catch (err) {
      // 当天索引尚未发布时会是 403/404，属正常情况，静默跳过
      if (!/HTTP (403|404)/.test(err.message)) log('  ! EDGAR ' + d + ' 失败: ' + err.message);
    }
    await sleep(200);
  }

  const uniq = new Map();
  for (const r of results) uniq.set(r.date + '|' + r.ticker + '|' + r.form, r);
  let list = [...uniq.values()].sort((a, b) => (a.date < b.date ? 1 : -1));

  if (enrich) {
    let done = 0;
    for (const r of list) {
      if (done >= maxEnrich) break;
      const { items, meanings, url } = await enrichItems(r.cik, r.accession);
      r.items = items; r.meanings = meanings; if (url) r.url = url; done++;
      await sleep(200);
    }
  }
  return list;
}

export { EIGHTK_MEANING };

// ---------------------------------------------------------------- 关键日期
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function observed(d) {
  const wd = d.getUTCDay();
  if (wd === 6) return ymdOf(new Date(d.getTime() - 86400000));
  if (wd === 0) return ymdOf(new Date(d.getTime() + 86400000));
  return ymdOf(d);
}

export function nyseHolidays(year) {
  const easter = easterSunday(year);
  const goodFri = ymdOf(new Date(easter.getTime() - 2 * 86400000));
  return [
    { date: observed(new Date(Date.UTC(year, 0, 1))), name: '元旦' },
    { date: nthWeekday(year, 1, 1, 3), name: '马丁·路德·金日' },
    { date: nthWeekday(year, 2, 1, 3), name: '总统日' },
    { date: goodFri, name: '耶稣受难日' },
    { date: nthWeekday(year, 5, 1, 5), name: '阵亡将士纪念日' },
    { date: observed(new Date(Date.UTC(year, 5, 19))), name: '六月节' },
    { date: observed(new Date(Date.UTC(year, 6, 4))), name: '独立日' },
    { date: nthWeekday(year, 9, 1, 1), name: '劳工节' },
    { date: nthWeekday(year, 11, 4, 4), name: '感恩节' },
    { date: observed(new Date(Date.UTC(year, 11, 25))), name: '圣诞节' },
  ];
}

export async function fetchFomcDates() {
  const out = [];
  try {
    const html = await httpText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', { timeoutMs: 30000, retries: 1 });
    const panels = html.split(/<div class="panel panel-default">/);
    for (const panel of panels) {
      const ym = panel.match(/(\d{4})\s+FOMC Meetings/);
      if (!ym) continue;
      const year = Number(ym[1]);
      const re = /fomc-meeting__month[^>]*>\s*<strong>([A-Za-z]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>\s*([0-9]{1,2})\s*-\s*([0-9]{1,2})(\*?)/g;
      let m;
      const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
      while ((m = re.exec(panel))) {
        const month = months[m[1].toLowerCase()];
        if (!month) continue;
        const startDay = Number(m[2]);
        const endDay = Number(m[3]);
        const start = ymdOf(new Date(Date.UTC(year, month - 1, startDay)));
        const end = ymdOf(new Date(Date.UTC(year, month - 1, endDay)));
        out.push({
          date: start, endDate: end, kind: 'FOMC',
          title: 'FOMC 议息会议（' + month + '/' + startDay + '-' + endDay + '）' + (m[4] === '*' ? ' · 含经济预测与点阵图' : ''),
          detail: '决议与主席记者会通常在最后一天美东时间 14:00 / 14:30 公布，属于全月波动最大的事件之一。',
        });
      }
    }
  } catch (err) {
    log('  ! FOMC 日历获取失败: ' + err.message);
  }
  return out;
}

export function computeKeyDates(startYmd, days, fomc = []) {
  const out = [];
  const endYmd = addDays(startYmd, days - 1);
  const start = parseYmd(startYmd), end = parseYmd(endYmd);

  const overlaps = (a, b) => parseYmd(a) <= end && parseYmd(b) >= start;

  // FOMC
  for (const f of fomc) {
    if (overlaps(f.date, f.endDate)) {
      out.push({ date: f.date, endDate: f.endDate, kind: 'FOMC', title: f.title, detail: f.detail });
    }
  }

  // 遍历月份：月度期权到期 / 四巫日 / 指数季度再平衡
  const months = new Set();
  for (let d = new Date(start); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) months.add(d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1));
  const last = new Date(end);
  months.add(last.getUTCFullYear() + '-' + (last.getUTCMonth() + 1));

  for (const key of months) {
    const [y, m] = key.split('-').map(Number);
    const opex = nthWeekday(y, m, 5, 3); // 第三个星期五
    if (opex >= startYmd && opex <= endYmd) {
      const isQuad = [3, 6, 9, 12].includes(m);
      out.push({
        date: opex, kind: isQuad ? '四巫日' : '期权到期',
        title: isQuad ? '四巫日 / 季度期权到期（' + opex + '）' : '月度期权到期（' + opex + '）',
        detail: isQuad
          ? '股指期货、股指期权、个股期货、个股期权同日到期，尾盘成交量与波动通常显著放大，也是指数季度再平衡生效日。'
          : '月度个股与指数期权集中到期，当周尾盘波动易放大，注意持仓集中度。',
      });
      if (isQuad) {
        const rebal = addDays(opex, 3); // 下一个周一开盘生效
        out.push({
          date: rebal, kind: '指数再平衡',
          title: 'S&P / 纳斯达克指数季度再平衡生效（' + rebal + ' 开盘）',
          detail: '被动资金按新权重调仓，被纳入/剔除的个股在生效前一交易日尾盘常有异常成交。',
        });
      }
    }
  }

  // 美东假期
  const years = new Set([start.getUTCFullYear(), end.getUTCFullYear()]);
  for (const y of years) {
    for (const h of nyseHolidays(y)) {
      if (h.date >= startYmd && h.date <= endYmd) {
        out.push({ date: h.date, kind: '休市', title: 'NYSE 休市 · ' + h.name, detail: '美股全天休市，无交易与结算。' });
      }
    }
  }

  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------- 自选股新闻
const SA_RSS = 'https://seekingalpha.com/api/sa/combined/';
const MARKETAUX = 'https://api.marketaux.com/v1/news/all';

const NEWS_SIGNAL = /(beat|miss|guidance|upgrade|downgrade|price target|earnings|revenue|profit|acquisition|merger|partnership|contract|buyback|dividend|recall|lawsuit|investigat|fda|approval|launch|supply|capacity|order|hbm|dram|nand|wafer|foundry|capex|data ?cent|ai )/i;

function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '').slice(0, 70);
}

/**
 * 自选股新闻。三个免费源互补：
 *   1. SeekingAlpha 个股 RSS —— 主力。每只股票 30 条、无额度限制、股票垂直内容质量最高。
 *   2. Marketaux —— 补充。跨代码聚合，带实体情绪分；但免费档限 30 次/天且每次最多 3 条，
 *      所以按 batchSize 合并代码 + 少量翻页，并强制带 published_after（否则会返回 2021 年的旧闻）。
 *   3. 关键词搜索（Marketaux search=）—— 覆盖 SK 海力士这类没有美股代码的标的。
 */
export async function collectWatchlistNews(cfg, now = Date.now()) {
  const w = cfg.watchlist || {};
  const symbols = w.symbols || [];
  const aliases = w.aliases || {};
  // 关键词支持两种写法：字符串，或 { term, sector }
  const keywords = (w.keywords || []).map((k) => (typeof k === 'string' ? { term: k, sector: '其他' } : k));
  if (!symbols.length && !keywords.length) return [];

  // 板块归属完全由配置决定（config.watchlist.sectors），不让 AI 按新闻内容自行归类。
  // 否则「纳斯达克 9 月涨 2%」这种市场综述会把 INTC 归到指数板块去。
  const sectors = w.sectors || {};
  const sectorOf = (sym) => {
    for (const [name, list] of Object.entries(sectors)) if (list.includes(sym)) return name;
    return '其他';
  };

  const maxAgeDays = w.maxAgeDays ?? 8;
  const cutoff = now - maxAgeDays * 86400000;
  const block = (w.excludePublishers || []).map((s) => String(s).toLowerCase());
  const perSymbol = w.perSymbol ?? 4;
  const seen = new Set();
  const items = [];
  const perSymbolCount = new Map();

  const push = (rec) => {
    const key = normalizeTitle(rec.title);
    if (!key || key.length < 12 || seen.has(key)) return;
    const src = String(rec.source || '').toLowerCase();
    if (block.some((b) => src.includes(b))) return;
    const sym = rec.symbol || '-';
    const n = perSymbolCount.get(sym) || 0;
    if (n >= perSymbol) return;
    perSymbolCount.set(sym, n + 1);
    seen.add(key);
    items.push({ ...rec, sector: rec.sector || sectorOf(sym) });
  };

  const httpOpts = { timeoutMs: 20000, retries: 1 };

  // ---- 1) SeekingAlpha 个股 RSS
  for (const sym of symbols) {
    const q = aliases[sym] || sym;
    try {
      const xml = await httpText(SA_RSS + encodeURIComponent(q) + '.xml', httpOpts);
      for (const it of parseFeed(xml)) {
        const t = Date.parse(it.date);
        if (Number.isNaN(t) || t < cutoff) continue;
        push({ symbol: sym, title: it.title, link: it.link, publishedAt: new Date(t).toISOString(), source: 'SeekingAlpha', sentiment: null });
      }
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) log('  ! 自选股 ' + sym + ' 新闻失败: ' + err.message);
    }
    await sleep(120);
  }

  // ---- 2) Marketaux：只用来补 SeekingAlpha 没覆盖到的代码 + 关键词搜索
  //         （免费档只有 30 次/天、每次最多 3 条，全量查既浪费又抢不到位置）
  const mxKey = (process.env.MARKETAUX_API_KEY || w.marketaux?.key || '').trim();
  const gapSymbols = symbols.filter((s) => !items.some((it) => it.symbol === s));
  if (w.marketaux?.enabled !== false && mxKey && (gapSymbols.length || keywords.length)) {
    const batchSize = w.marketaux?.batchSize ?? 6;
    const pages = w.marketaux?.pages ?? 2;
    const iso = new Date(cutoff).toISOString().slice(0, 10) + 'T00:00';
    const batches = [];
    for (let i = 0; i < gapSymbols.length; i += batchSize) {
      batches.push(gapSymbols.slice(i, i + batchSize).map((s) => aliases[s] || s));
    }
    let requests = 0;
    const call = async (params) => {
      const url = MARKETAUX + '?' + params + '&api_token=' + encodeURIComponent(mxKey);
      requests++;
      return httpJson(url, { timeoutMs: 20000, retries: 1, headers: { 'User-Agent': 'us-stock-weekly-brief' } });
    };
    for (const batch of batches) {
      for (let p = 1; p <= pages; p++) {
        try {
          const j = await call('symbols=' + batch.join(',') + '&filter_entities=true&language=en&limit=3&page=' + p + '&published_after=' + iso);
          const rows = j?.data || [];
          for (const d of rows) {
            const ent = (d.entities || [])[0] || {};
            const t = Date.parse(d.published_at);
            if (Number.isNaN(t) || t < cutoff) continue;
            const orig = Object.keys(aliases).find((k) => aliases[k] === ent.symbol) || ent.symbol || '-';
            push({
              symbol: orig, title: d.title, link: d.url,
              publishedAt: new Date(t).toISOString(),
              source: String(d.source || 'Marketaux').replace(/^www\./, ''),
              sentiment: typeof ent.sentiment_score === 'number' ? ent.sentiment_score : null,
            });
          }
          if (rows.length < 3) break;
        } catch (err) {
          log('  ! Marketaux 批次失败: ' + err.message);
          break;
        }
        await sleep(300);
      }
    }
    // ---- 3) 关键词（覆盖非美股标的）
    for (const kw of keywords) {
      try {
        const j = await call('search=' + encodeURIComponent(kw.term) + '&language=en&limit=3&published_after=' + iso);
        for (const d of j?.data || []) {
          const t = Date.parse(d.published_at);
          if (Number.isNaN(t) || t < cutoff) continue;
          push({ symbol: kw.term, sector: kw.sector, title: d.title, link: d.url, publishedAt: new Date(t).toISOString(), source: String(d.source || 'Marketaux').replace(/^www\./, ''), sentiment: null });
        }
      } catch (err) { log('  ! Marketaux 关键词「' + kw.term + '」失败: ' + err.message); }
      await sleep(300);
    }
    log('      Marketaux 用了 ' + requests + ' 次请求（免费档 30 次/天）');
  } else if (!mxKey) {
    log('      （未配置 MARKETAUX_API_KEY，仅用 SeekingAlpha）');
  }

  // ---- 排序：时效 + 标题信号 + 情绪强度
  const score = (it) => {
    let s = 0;
    const ageH = (now - Date.parse(it.publishedAt)) / 3600000;
    if (ageH <= 24) s += 3; else if (ageH <= 72) s += 2; else if (ageH <= 168) s += 1;
    if (NEWS_SIGNAL.test(it.title)) s += 1.5;
    if (it.sentiment !== null && Math.abs(it.sentiment) >= 0.4) s += 0.5;
    if (/seekingalpha/i.test(it.source)) s += 0.3;
    return s;
  };
  items.sort((a, b) => score(b) - score(a) || (a.publishedAt < b.publishedAt ? 1 : -1));

  // 轮转挑选：先每个代码保底 1 条，再第二轮、第三轮补满。
  // 否则 META / NVDA / MSFT 这些新闻大户会把 COHR / AXTI / NBIS 这类冷门标的挤没。
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.symbol)) groups.set(it.symbol, []);
    groups.get(it.symbol).push(it);
  }
  const lists = [...groups.values()];
  const limit = w.limit ?? 18;
  const picked = [];
  for (let round = 0; picked.length < limit; round++) {
    let progressed = false;
    for (const g of lists) {
      if (!g[round]) continue;
      picked.push(g[round]);
      progressed = true;
      if (picked.length >= limit) break;
    }
    if (!progressed) break;
  }
  picked.sort((a, b) => score(b) - score(a));
  return picked;
}
