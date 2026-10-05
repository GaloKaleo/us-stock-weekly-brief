// util.mjs — 通用工具：网络、RSS 解析、日期计算
import fs from 'node:fs';
import path from 'node:path';

export const NY_TZ = 'America/New_York';

export function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log('[' + ts + ']', ...args);
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 带超时与重试的 GET，返回文本 */
export async function httpText(url, opts = {}) {
  const { headers = {}, timeoutMs = 25000, retries = 2, retryDelayMs = 800 } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return text;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function httpJson(url, opts = {}) { return JSON.parse(await httpText(url, opts)); }

export function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function stripHtml(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function truncate(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** 极简 RSS/Atom 解析 */
export function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const block of blocks) {
    const pick = (tag) => {
      const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'));
      return m ? decodeEntities(m[1]).trim() : '';
    };
    let link = pick('link');
    if (!link) {
      const m = block.match(/<link[^>]*href="([^"]+)"/);
      if (m) link = decodeEntities(m[1]);
    }
    items.push({
      title: stripHtml(pick('title')),
      link,
      date: pick('pubDate') || pick('published') || pick('updated') || pick('dc:date'),
      summary: stripHtml(pick('description') || pick('summary') || pick('content')),
    });
  }
  return items;
}

// ---------- 日期工具（以美东时间为准） ----------

/** 给定时刻在美东的 YYYY-MM-DD */
export function nyDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function parseYmd(ymd) { return new Date(ymd + 'T12:00:00Z'); }

export function ymdOf(date) { return new Date(date).toISOString().slice(0, 10); }

export function addDays(ymd, n) {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return ymdOf(d);
}

/** 0=周日 ... 6=周六 */
export function weekday(ymd) { return parseYmd(ymd).getUTCDay(); }

export function weekdayNameCn(ymd) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday(ymd)];
}

/** 从 from 起（含）的第一个周一 */
export function nextMonday(ymd) {
  const wd = weekday(ymd);
  const delta = wd === 1 ? 0 : (8 - wd) % 7;
  return addDays(ymd, delta);
}

/** 某月第 n 个星期几（weekday: 0=周日），返回 YYYY-MM-DD */
export function nthWeekday(year, month, weekdayTarget, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWd = first.getUTCDay();
  let day = 1 + ((weekdayTarget - firstWd + 7) % 7) + (n - 1) * 7;
  return ymdOf(new Date(Date.UTC(year, month - 1, day)));
}

export function daysBetween(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
}

export function rangeYmd(startYmd, days) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(addDays(startYmd, i));
  return out;
}

/** 解析金额字符串，如 "$171,826,201,000" -> 数字 */
export function parseMoney(s) {
  if (!s) return 0;
  const m = String(s).replace(/[,$\s]/g, '').match(/^\(?(-?[\d.]+)([KMBT])?\)?/i);
  if (!m) return 0;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] || '').toUpperCase()] || 1;
  return Math.abs(parseFloat(m[1])) * mult;
}

export function fmtMoney(n) {
  if (!n) return '—';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M';
  return '$' + n;
}

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
