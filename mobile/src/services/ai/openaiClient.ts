// OpenAI 兼容 chat completions 客户端（RN 版，与 A 线实验脚本同协议同错误分类）。
// 只调用用户配置的接口：endpoint 由 urlKind 拼接规则生成。

import { endpointFor, type ModelConfig } from './types';

export interface ChatResult {
  ok: boolean;
  content: string;
  latencyMs: number;
  /** 供应商返回的 finish_reason（'length' 表示输出被 max_tokens 截断）；缺失时为 null */
  finishReason?: string | null;
  error?: { kind: string; message: string };
}

/** 调用参数：maxTokens 用于分析等长输出场景；signal 由调用方（任务执行器）传入以尽力停止 */
export interface ChatOptions {
  maxTokens?: number;
  signal?: AbortSignal;
}

function classify(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'invalid_request';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * OpenAI 兼容 chat completions 调用。
 * 兼容性：前四个参数与顺序保持不变（timeoutMs 仍是第 4 个），options 为追加参数；
 * 不传 options 时行为与连接测试一致（max_tokens=16、30 秒超时）。
 */
export async function chatCompletion(
  config: Pick<ModelConfig, 'urlKind' | 'baseUrl' | 'modelId'>,
  apiKey: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: unknown }>,
  timeoutMs = 30000,
  options: ChatOptions = {},
): Promise<ChatResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const external = options.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort);
  }
  try {
    const response = await fetch(endpointFor(config.urlKind, config.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.modelId,
        messages,
        max_tokens: options.maxTokens ?? 16,
      }),
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
    const raw = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    };
    const part = raw.choices?.[0]?.message?.content;
    const finishReason = raw.choices?.[0]?.finish_reason;
    const content = typeof part === 'string' ? part : '';
    // HTTP 200 即视为连接可用：推理型模型可能把小 token 预算全部用于思考而返回空内容，
    // 空回复不代表鉴权或地址有问题（真实案例：glm-5.3-flash + max_tokens 16）。
    // 注意：分析层必须自行拒绝空内容，不能沿用该判断。
    return {
      ok: true,
      content,
      latencyMs,
      finishReason: typeof finishReason === 'string' ? finishReason : null,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    const kind = aborted ? (timedOut ? 'timeout' : 'cancelled') : 'network';
    const message = aborted
      ? timedOut
        ? `请求超时（${timeoutMs}ms）`
        : '请求已取消'
      : `网络失败：${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, content: '', latencyMs, error: { kind, message } };
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}
