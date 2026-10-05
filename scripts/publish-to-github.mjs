#!/usr/bin/env node
/**
 * 一键把本项目创建成 GitHub 仓库并上传全部文件（无需本地安装 git）。
 *
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish-to-github.mjs --name us-stock-weekly-brief
 *   可选参数：
 *     --name    仓库名（默认 us-stock-weekly-brief）
 *     --private 创建为私有仓库（默认 public，见 README 中"60 天停用"说明）
 *     --desc    仓库描述
 *
 * Token 权限要求（classic PAT）：repo + workflow
 *   —— workflow 权限是必须的，否则无法上传 .github/workflows/ 下的文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = 'https://api.github.com';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const REPO = getArg('name', 'us-stock-weekly-brief');
const PRIVATE = args.includes('--private');
const DESC = getArg('desc', '每周一自动生成的美股前瞻周报：新闻 + 经济日历 + 财报 + 关键日期 + AI 中文解读');
const TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getArg('token', '') || '').trim();

if (!TOKEN) {
  console.error('缺少 Token。请这样运行：');
  console.error('  GITHUB_TOKEN=ghp_xxx node scripts/publish-to-github.mjs --name <仓库名>');
  console.error('Token 需要 repo + workflow 权限：https://github.com/settings/tokens/new?scopes=repo,workflow');
  process.exit(1);
}

const SKIP_DIRS = new Set(['node_modules', 'out', '.git', '.tools', '.npmcache', 'dshtest', '.dshtest']);
const SKIP_FILES = /^(probe-|\.env$|local\.json$)/;

function walk(dir, base = '', acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.gitignore') continue;
    const abs = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, rel, acc);
    } else {
      if (SKIP_FILES.test(entry.name)) continue;
      acc.push({ abs, rel, size: fs.statSync(abs).size });
    }
  }
  return acc;
}

async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'us-stock-weekly-brief-publisher',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

const me = await api('GET', '/user');
if (!me.ok) {
  console.error('Token 无效或无法访问 GitHub：HTTP ' + me.status + ' ' + me.text.slice(0, 200));
  process.exit(1);
}
const owner = me.json.login;
console.log('已认证为：' + owner + (me.json.name ? '（' + me.json.name + '）' : ''));

console.log('创建仓库 ' + owner + '/' + REPO + ' …');
const created = await api('POST', '/user/repos', {
  name: REPO, private: PRIVATE, description: DESC, auto_init: false, has_issues: true, has_wiki: false,
});
if (created.ok) {
  console.log('  ✓ 仓库已创建');
} else if (created.status === 422) {
  console.log('  · 仓库已存在，继续上传（同名文件会被覆盖）');
} else {
  console.error('  ✗ 创建失败：HTTP ' + created.status + ' ' + created.text.slice(0, 300));
  if (/workflow/i.test(created.text)) {
    console.error('  → 你的 Token 缺少 workflow 权限，请到 https://github.com/settings/tokens 重新勾选 repo 与 workflow');
  }
  process.exit(1);
}

const files = walk(ROOT).sort((a, b) => {
  // 先传普通文件，最后传 workflow，便于把 workflow 权限错误留到最后提示
  const aw = a.rel.includes('.github/workflows') ? 1 : 0;
  const bw = b.rel.includes('.github/workflows') ? 1 : 0;
  return aw - bw;
});
console.log('待上传文件：' + files.length + ' 个');

let first = true, workflowBlocked = false;
for (const f of files) {
  const content = fs.readFileSync(f.abs).toString('base64');
  const res = await api('PUT', '/repos/' + owner + '/' + REPO + '/contents/' + f.rel.split('/').map(encodeURIComponent).join('/'), {
    message: (first ? '初始化：' : '') + '添加 ' + f.rel,
    content,
    branch: 'main',
  });
  first = false;
  if (res.ok) {
    console.log('  ✓ ' + f.rel + ' (' + f.size + 'B)');
  } else {
    const msg = res.json?.message || res.text.slice(0, 160);
    console.log('  ✗ ' + f.rel + ' → HTTP ' + res.status + ' ' + msg);
    if (/workflow/i.test(msg)) workflowBlocked = true;
  }
  await new Promise((r) => setTimeout(r, 250));
}

console.log('');
if (workflowBlocked) {
  console.log('⚠️  .github/workflows/ 下的文件未能上传：你的 Token 缺少 workflow 权限。');
  console.log('   请到 https://github.com/settings/tokens 重新生成 Token，勾选 repo + workflow，然后重跑本脚本。');
} else {
  console.log('✅ 完成：https://github.com/' + owner + '/' + REPO);
}
console.log('');
console.log('接下来（只需做一次）：');
console.log('  1) 打开 https://github.com/' + owner + '/' + REPO + '/settings/secrets/actions');
console.log('  2) 添加 Secret：DEEPSEEK_API_KEY');
console.log('  3) 添加 Secret：WECOM_WEBHOOK（或 DINGTALK_WEBHOOK / FEISHU_WEBHOOK）');
console.log('  4) 打开 https://github.com/' + owner + '/' + REPO + '/actions 确认 Actions 已启用');
console.log('  5) 在「美股周报」工作流点 Run workflow 手动验证一次');
