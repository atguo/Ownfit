// 通用 OpenAI 图像兼容客户端（支持多图参考 JSON 协议，如火山方舟 Seedream 3.0/4.0/5.0 Flash、
// 以及遵循 POST {baseUrl}/images/generations + image: string[] 的 OpenAI 图像兼容网关）。
// 协议约定：
// - 请求：POST {baseUrl}/images/generations（已填完整路径则原样使用）
// - 体：{ model, prompt, size, response_format: 'url', watermark: false, image?: string[] }
//   其中 image 为 [人物参考照 data URL, ...衣物实拍图 data URL]（无参考图如连接测试时不传该字段）。
// - 响应：兼容 data[].url 与 data[].b64_json（自动转为 data URI）。

import { endpointFor, type ModelConfig } from '../types';
import type { ImageGenInput, ImageGenResult } from './minimaxClient';

function classify(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 422) return 'content';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'invalid_request';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'unknown';
}

export interface OpenAIImageGenInput extends ImageGenInput {
  /** 图像尺寸，如 '2K' 或 '1024x1024'；未指定时默认 '2K'（适配 Seedream 5.0 等通用高分辨率模型） */
  size?: string;
  /** 是否关闭供应商水印（默认 false，避免水印遮挡试穿细节） */
  watermark?: boolean;
}

export async function generateOpenAIImage(
  config: Pick<ModelConfig, 'urlKind' | 'baseUrl' | 'modelId'>,
  apiKey: string,
  input: OpenAIImageGenInput,
  timeoutMs = 120000,
): Promise<ImageGenResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const extraPersonImages = (input.extraPersonImages ?? []).filter(Boolean);
    const garmentImages = (input.garmentImages ?? []).filter(Boolean);
    const referenceImages = [input.personImage, ...extraPersonImages, ...garmentImages].filter(Boolean) as string[];
    const url = endpointFor(config.urlKind, config.baseUrl);
    const body: Record<string, unknown> = {
      model: config.modelId,
      prompt: input.prompt,
      size: input.size ?? '2K',
      response_format: 'url',
      watermark: input.watermark ?? false,
    };
    if (referenceImages.length > 0) {
      body.image = referenceImages;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const payload = (await response.json().catch(() => null)) as {
      data?: Array<{ url?: string; b64_json?: string; error?: { code?: string; message?: string } }>;
      error?: { code?: string; message?: string; type?: string };
    } | null;

    if (!response.ok) {
      const apiMsg = payload?.error?.message;
      const apiCode = payload?.error?.code;
      const detail = apiMsg ? `HTTP ${response.status}（${apiCode ? `${apiCode}: ` : ''}${apiMsg}）` : `HTTP ${response.status}`;
      return {
        ok: false,
        imageUrls: [],
        latencyMs,
        error: { kind: classify(response.status), message: detail },
      };
    }

    const items = payload?.data ?? [];
    const urls: string[] = [];
    for (const item of items) {
      if (item.url) {
        urls.push(item.url);
      } else if (item.b64_json) {
        urls.push(`data:image/png;base64,${item.b64_json}`);
      }
    }
    if (urls.length > 0) {
      return { ok: true, imageUrls: urls, latencyMs };
    }
    const firstError = items.find((d) => d.error)?.error ?? payload?.error;
    return {
      ok: false,
      imageUrls: [],
      latencyMs,
      error: {
        kind: 'api',
        message: firstError
          ? `生成失败 ${firstError.code ?? ''}：${firstError.message ?? '未知'}`
          : '未返回图片',
      },
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      imageUrls: [],
      latencyMs,
      error: {
        kind: 'network',
        message: aborted ? '请求超时' : `网络失败：${error instanceof Error ? error.message : String(error)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
