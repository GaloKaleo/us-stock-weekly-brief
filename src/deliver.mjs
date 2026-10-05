// deliver.mjs — 推送渠道：企业微信 / 钉钉 / 飞书 / Server酱 / PushPlus / 控制台
import crypto from 'node:crypto';
import { log } from './util.mjs';

const bytes = (s) => Buffer.byteLength(s, 'utf8');

/**
 * 各平台分片之间的发送间隔。
 * 企业微信群机器人官方限制是「每个机器人不超过 20 条/分钟」，
 * 所以间隔必须 >= 3000ms，否则长报告分片时会触发限流。
 */
const CHUNK_DELAY_MS = { wecom: 3200, dingtalk: 3200, feishu: 1500, serverchan: 1200, pushplus: 1200 };

/** 按小节切块，尽量不破坏 Markdown 结构 */
export function chunkMarkdown(md, maxBytes) {
  const sections = String(md).split(/\n(?=##\s)/);
  const chunks = [];
  let cur = '';
  // 去掉分片后遗留在末尾的孤立分割线
  const clean = (s) => s.replace(/\n*-{3,}\s*$/, '').trim();
  const flush = () => { const t = clean(cur); if (t) chunks.push(t); cur = ''; };
  for (const sec of sections) {
    if (bytes(sec) > maxBytes) {
      flush();
      let buf = '';
      for (const line of sec.split('\n')) {
        if (bytes(buf + '\n' + line) > maxBytes) { const t = clean(buf); if (t) chunks.push(t); buf = line; }
        else buf = buf ? buf + '\n' + line : line;
      }
      const t = clean(buf); if (t) chunks.push(t);
      continue;
    }
    if (bytes(cur + '\n' + sec) > maxBytes) flush();
    cur = cur ? cur + '\n' + sec : sec;
  }
  flush();
  return chunks.length ? chunks : [''];
}

async function postJson(url, body, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 300));
    if (json && typeof json === 'object') {
      const code = json.errcode ?? json.code ?? json.status;
      if (code !== undefined && code !== 0 && code !== 200 && code !== 'ok' && json.success !== true) {
        throw new Error('接口返回错误: ' + text.slice(0, 300));
      }
    }
    return json ?? text;
  } finally { clearTimeout(timer); }
}

// ---------------- 企业微信 ----------------
/**
 * 必须用 markdown_v2 而不是旧的 markdown：
 * 旧版 markdown 只支持标题/加粗/链接/引用/行内代码/字体颜色，
 * **不支持列表、表格、分割线**——发过去会变成一堆裸文本，排版很难看。
 * markdown_v2 支持列表、表格、分割线、斜体（代价是不支持字体颜色）。
 */
async function sendWecom(webhook, title, md) {
  const chunks = chunkMarkdown(md, 3800);
  for (let i = 0; i < chunks.length; i++) {
    const head = chunks.length > 1 ? '## ' + title + '（' + (i + 1) + '/' + chunks.length + '）\n\n' : '';
    const content = head + chunks[i];
    try {
      await postJson(webhook, { msgtype: 'markdown_v2', markdown_v2: { content } });
    } catch (err) {
      log('  · 企业微信 markdown_v2 未生效，回退到旧版 markdown：' + err.message);
      await postJson(webhook, { msgtype: 'markdown', markdown: { content } });
    }
    log('  ✓ 企业微信 第 ' + (i + 1) + '/' + chunks.length + ' 条已发送');
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS.wecom));
  }
}

// ---------------- 钉钉 ----------------
function dingtalkSign(webhook, secret) {
  const timestamp = Date.now();
  const stringToSign = timestamp + '\n' + secret;
  const sign = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  const sep = webhook.includes('?') ? '&' : '?';
  return webhook + sep + 'timestamp=' + timestamp + '&sign=' + encodeURIComponent(sign);
}

async function sendDingtalk(webhook, secret, title, md) {
  const url = secret ? dingtalkSign(webhook, secret) : webhook;
  const chunks = chunkMarkdown(md, 18000);
  for (let i = 0; i < chunks.length; i++) {
    const head = chunks.length > 1 ? '### ' + title + '（' + (i + 1) + '/' + chunks.length + '）\n\n' : '';
    await postJson(url, { msgtype: 'markdown', markdown: { title: title + (chunks.length > 1 ? ' ' + (i + 1) + '/' + chunks.length : ''), text: head + chunks[i] } });
    log('  ✓ 钉钉 第 ' + (i + 1) + '/' + chunks.length + ' 条已发送');
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS.dingtalk));
  }
}

// ---------------- 飞书 ----------------
async function sendFeishu(webhook, title, md) {
  const chunks = chunkMarkdown(md, 24000);
  for (let i = 0; i < chunks.length; i++) {
    const head = chunks.length > 1 ? '**' + title + '（' + (i + 1) + '/' + chunks.length + '）**\n' : '**' + title + '**\n';
    await postJson(webhook, {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: { template: 'red', title: { tag: 'plain_text', content: title + (chunks.length > 1 ? ' (' + (i + 1) + '/' + chunks.length + ')' : '') } },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: head + chunks[i] } }],
      },
    });
    log('  ✓ 飞书 第 ' + (i + 1) + '/' + chunks.length + ' 条已发送');
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS.feishu));
  }
}

// ---------------- Server酱 ----------------
async function sendServerChan(key, title, md) {
  const url = /^sctp/i.test(key) || key.includes('/') ? 'https://' + key.replace(/^https?:\/\//, '') : 'https://sctapi.ftqq.com/' + key + '.send';
  const chunks = chunkMarkdown(md, 30000);
  for (const c of chunks) await postJson(url, { title, desp: c });
  log('  ✓ Server酱 已发送');
}

// ---------------- PushPlus ----------------
async function sendPushPlus(token, title, md) {
  const chunks = chunkMarkdown(md, 18000);
  for (const c of chunks) await postJson('https://www.pushplus.plus/send', { token, title, content: c, template: 'markdown' });
  log('  ✓ PushPlus 已发送');
}

/**
 * 按配置推送。任何单个渠道失败都不影响其它渠道。
 * @returns {{channel:string, ok:boolean, error?:string}[]}
 */
/**
 * 按配置推送。任何单个渠道失败都不影响其它渠道。
 * 每个渠道可以独立选择 content：
 *   mode = 'short' → 发精简版（适合企业微信这种 4KB 限制、不想刷屏的渠道）
 *   mode = 'full'  → 发完整版（默认）
 * @returns {{channel:string, ok:boolean, mode:string, error?:string}[]}
 */
export async function deliverAll(channels, { title, fullMd, shortMd }) {
  const results = [];
  const pick = (ch) => (ch?.mode === 'short' && shortMd ? shortMd : fullMd);
  const run = async (name, ch, fn) => {
    if (!ch?.enabled) return;
    const mode = ch.mode === 'short' && shortMd ? 'short' : 'full';
    try { await fn(pick(ch)); results.push({ channel: name, ok: true, mode }); log('  · ' + name + ' 使用' + (mode === 'short' ? '精简版' : '完整版')); }
    catch (err) { log('  ✗ ' + name + ' 推送失败: ' + err.message); results.push({ channel: name, ok: false, mode, error: err.message }); }
  };

  await run('企业微信', channels.wecom, (md) => sendWecom(channels.wecom.webhook, title, md));
  await run('钉钉', channels.dingtalk, (md) => sendDingtalk(channels.dingtalk.webhook, channels.dingtalk.secret, title, md));
  await run('飞书', channels.feishu, (md) => sendFeishu(channels.feishu.webhook, title, md));
  await run('Server酱', channels.serverchan, (md) => sendServerChan(channels.serverchan.key, title, md));
  await run('PushPlus', channels.pushplus, (md) => sendPushPlus(channels.pushplus.token, title, md));
  return results;
}

export async function sendTest(channels) {
  const title = '美股周报 · 通道连通性测试';
  const md = '## ✅ 通道测试\n\n如果你看到这条消息，说明该通道配置正确。\n\n- 发送时间：' + new Date().toISOString() + '\n- 正式周报将在每周一早晨自动送达。';
  return deliverAll(channels, { title, fullMd: md, shortMd: md });
}
