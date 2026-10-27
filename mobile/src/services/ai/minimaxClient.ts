// MiniMax 图像生成客户端（自有协议 /v1/image_generation，RN 版）。
// 约束：subject_reference 仅支持人物肖像；生成图 URL 24h 失效。

import { endpointFor, type ModelConfig } from './types';

export interface ImageGenResult {
  ok: boolean;
  imageUrls: string[];
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

export interface ImageGenInput {
  prompt: string;
  /** 人物参考照（data URL） */
  personImage?: string;
  aspectRatio?: '1:1' | '2:3' | '3:4' | '9:16';
  n?: number;
}

export async function generateImage(
  config: Pick<ModelConfig, 'urlKind' | 'baseUrl' | 'modelId'>,
  apiKey: string,
  input: ImageGenInput,
  timeoutMs = 120000,
): Promise<ImageGenResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpointFor(config.urlKind, config.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.modelId,
        prompt: input.prompt.slice(0, 1500),
        ...(input.personImage
          ? { subject_reference: [{ type: 'character', image_file: input.personImage }] }
          : {}),
        ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
        n: input.n ?? 1,
        response_format: 'url',
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const payload = (await response.json().catch(() => null)) as {
      data?: { image_urls?: string[] };
      base_resp?: { status_code?: number; status_msg?: string };
    } | null;

    if (!response.ok) {
      return {
        ok: false,
        imageUrls: [],
        latencyMs,
        error: { kind: classify(response.status), message: `HTTP ${response.status}` },
      };
    }
    const base = payload?.base_resp;
    if (base && base.status_code !== 0) {
      const kind = base.status_code === 1008 ? 'quota' : base.status_code === 1004 || base.status_code === 2049 ? 'auth' : 'api';
      return {
        ok: false,
        imageUrls: [],
        latencyMs,
        error: { kind, message: `业务错误 ${base.status_code}：${base.status_msg ?? '未知'}` },
      };
    }
    const imageUrls = payload?.data?.image_urls ?? [];
    return { ok: imageUrls.length > 0, imageUrls, latencyMs, error: imageUrls.length ? undefined : { kind: 'empty', message: '未返回图片' } };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      imageUrls: [],
      latencyMs,
      error: { kind: 'network', message: aborted ? '请求超时' : `网络失败：${error instanceof Error ? error.message : String(error)}` },
    };
  } finally {
    clearTimeout(timer);
  }
}
