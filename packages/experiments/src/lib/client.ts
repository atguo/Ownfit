// OpenAI 兼容 chat completions 客户端（fetch 实现，无重 SDK 依赖）。
// GLM 与 DeepSeek 均兼容此协议；后续更换"图像能力更强的模型"只需新增服务档案。

import type { ServiceProfile } from './config';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatOptions {
  temperature?: number;
  timeoutMs?: number;
}

export type ChatErrorKind =
  | 'auth' // 401/403 鉴权失败
  | 'rate_limit' // 429
  | 'invalid_request' // 400 参数/协议不兼容
  | 'not_found' // 404 地址或模型不存在
  | 'server' // 5xx
  | 'network' // 超时/连接失败
  | 'empty' // 返回 200 但没有内容
  | 'unknown';

export type ChatResult =
  | {
      ok: true;
      content: string;
      raw: unknown;
      latencyMs: number;
      model: string;
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    }
  | { ok: false; kind: ChatErrorKind; status?: number; message: string; latencyMs: number; model: string };

function classifyError(status: number | undefined): ChatErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'invalid_request';
  if (status === 404) return 'not_found';
  if (status !== undefined && status >= 500) return 'server';
  return 'unknown';
}

export async function chatCompletion(
  profile: ServiceProfile,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ChatResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);

  try {
    const response = await fetch(`${profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`,
      },
      body: JSON.stringify({
        model: profile.modelId,
        messages,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      return {
        ok: false,
        kind: classifyError(response.status),
        status: response.status,
        message: `HTTP ${response.status}：${bodyText.slice(0, 500)}`,
        latencyMs,
        model: profile.modelId,
      };
    }

    const raw: unknown = await response.json();
    const content = extractContent(raw);
    if (!content) {
      return {
        ok: false,
        kind: 'empty',
        message: '返回 200 但未提取到消息内容',
        latencyMs,
        model: profile.modelId,
      };
    }

    return {
      ok: true,
      content,
      raw,
      latencyMs,
      model: profile.modelId,
      usage: extractUsage(raw),
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      kind: 'network',
      message: aborted
        ? `请求超时被中止（${options.timeoutMs ?? 60000}ms）`
        : `网络失败：${error instanceof Error ? error.message : String(error)}`,
      latencyMs,
      model: profile.modelId,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractContent(raw: unknown): string | null {
  const choices = (raw as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  // 部分兼容实现返回分段数组
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('');
    if (joined.trim()) return joined;
  }
  return null;
}

function extractUsage(raw: unknown): ChatUsage | undefined {
  const usage = (raw as { usage?: Record<string, unknown> })?.usage;
  if (!usage) return undefined;
  return {
    promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
  };
}
