// llm.mjs — OpenAI 兼容的对话补全（DeepSeek / GitHub Models / 任意兼容端点）
import { log } from './util.mjs';

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  'github-models': {
    label: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    model: 'openai/gpt-4o-mini',
    keyEnv: 'GITHUB_TOKEN',
  },
  custom: {
    label: 'Custom OpenAI-compatible',
    baseUrl: '',
    model: '',
    keyEnv: 'LLM_API_KEY',
  },
};

export function resolveLlmConfig(cfg = {}) {
  const env = process.env;
  const providerName = (env.LLM_PROVIDER || cfg.provider || 'deepseek').trim();
  const preset = PROVIDERS[providerName] || PROVIDERS.custom;
  const apiKey = (env.LLM_API_KEY || env[preset.keyEnv] || '').trim();
  const baseUrl = (env.LLM_BASE_URL || cfg.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
  const model = (env.LLM_MODEL || cfg.model || preset.model || '').trim();
  // DeepSeek V4 系列（deepseek-flash / deepseek-v4-pro）**默认开启思考模式**，
  // 思维链会占用输出预算（导致 content 为空）且按输出价计费。本任务只是把给定数据改写成
  // 固定格式的简报，不需要推理，因此默认关闭。非 DeepSeek 的兼容端点不发送该参数。
  const thinking = (env.LLM_THINKING || cfg.thinking || (providerName === 'deepseek' ? 'disabled' : 'auto')).trim();
  return { providerName, label: preset.label, apiKey, baseUrl, model, thinking, maxTokens: Number(env.LLM_MAX_TOKENS || cfg.maxTokens || 4000), temperature: Number(env.LLM_TEMPERATURE ?? cfg.temperature ?? 0.4) };
}

export function llmAvailable(cfg) { return Boolean(cfg.apiKey && cfg.baseUrl && cfg.model); }

export async function chat(cfg, { system, user, timeoutMs = 240000 }) {
  const url = cfg.baseUrl + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey, 'Accept': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        ...(cfg.thinking && cfg.thinking !== 'auto' ? { thinking: { type: cfg.thinking } } : {}),
        ...(cfg.thinking === 'enabled' ? {} : { temperature: cfg.temperature }),
        max_tokens: cfg.maxTokens,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('LLM HTTP ' + res.status + ': ' + text.slice(0, 400));
    const json = JSON.parse(text);
    const content = json?.choices?.[0]?.message?.content;
    const reasoning = json?.choices?.[0]?.message?.reasoning_content;
    if (!content) {
      if (reasoning) throw new Error('模型把输出预算全用在思考链上了（thinking 模式未关闭），content 为空。请在 config 里设 llm.thinking="disabled"，或调大 maxTokens。');
      throw new Error('LLM 返回为空: ' + text.slice(0, 300));
    }
    const finish = json?.choices?.[0]?.finish_reason;
    if (finish === 'length') log('  ! 输出被 max_tokens 截断（finish_reason=length）');
    const usage = json.usage || {};
    log('  LLM 用量: prompt=' + (usage.prompt_tokens ?? '?') + ' completion=' + (usage.completion_tokens ?? '?'));
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}
