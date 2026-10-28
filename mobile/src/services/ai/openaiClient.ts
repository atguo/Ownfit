// OpenAI 兼容 chat completions 客户端（RN 版，与 A 线实验脚本同协议同错误分类）。
// 只调用用户配置的接口：endpoint 由 urlKind 拼接规则生成。

import { endpointFor, type ModelConfig } from './types';

export interface ChatResult {
  ok: boolean;
  content: string;
  latencyMs: number;
  error?: { kind: string; message: string };
}

function classify(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'invalid_request';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'unknown';
}

export async function chatCompletion(
  config: Pick<ModelConfig, 'urlKind' | 'baseUrl' | 'modelId'>,
  apiKey: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: unknown }>,
  timeoutMs = 30000,
): Promise<ChatResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpointFor(config.urlKind, config.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: config.modelId, messages, max_tokens: 16 }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        content: '',
        latencyMs,
        error: { kind: classify(response.status), message: `HTTP ${response.status}：${body.slice(0, 200)}` },
      };
    }
    const raw = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const part = raw.choices?.[0]?.message?.content;
    const content = typeof part === 'string' ? part : '';
    // HTTP 200 即视为连接可用：推理型模型可能把小 token 预算全部用于思考而返回空内容，
    // 空回复不代表鉴权或地址有问题（真实案例：glm-5.3-flash + max_tokens 16）。
    return { ok: true, content, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      content: '',
      latencyMs,
      error: { kind: 'network', message: aborted ? '请求超时' : `网络失败：${error instanceof Error ? error.message : String(error)}` },
    };
  } finally {
    clearTimeout(timer);
  }
}
