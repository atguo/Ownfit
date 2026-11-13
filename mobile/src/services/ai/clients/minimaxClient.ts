// MiniMax 图像生成客户端（自有协议，RN 版），按模型代际分流：
// - image-01（旧）：POST /v1/image_generation，subject_reference 仅支持人物肖像，prompt 硬限 1500 字符。
// - MiniMax-H3-Image（新，2026-11-13 接入）：人物与衣物真图参考（1~16 张 data URI，请求体 ≤64MiB）、
//   prompt ≤32000 字符；有参考图走 POST /v1/images/edits，纯文生图走 POST /v1/images/generations。
//   响应形态 data[]（每项 url 或 error；部分失败仍 200），旧 base_resp 错误体不再出现。
// 共同边界：生成图 URL 24h 失效，成功后须及时下载落盘。

import { endpointFor, type ModelConfig } from '../types';

export interface ImageGenResult {
  ok: boolean;
  imageUrls: string[];
  latencyMs: number;
  error?: { kind: string; message: string };
}

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

/** H3-Image 代际判定（modelId 含 h3-image，忽略大小写与分隔符；高速版 Highspeed 同样命中） */
export function isH3ImageModel(modelId: string | undefined): boolean {
  return /h3[-_]?image/i.test(modelId ?? '');
}

/** H3 端点：用户按旧习惯填 /v1/image_generation（或 /v1/images/generations）时自动改写到目标接口；
 * 已填 /v1/images/edits 则原样使用。 */
export function h3EndpointFor(baseUrl: string, withImages: boolean): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/images\/edits$/.test(base)) return base;
  if (/\/images\/generations$/.test(base)) return withImages ? base.replace(/\/images\/generations$/, '/images/edits') : base;
  if (/\/image_generation$/.test(base)) return withImages ? base.replace(/\/image_generation$/, '/images/edits') : base.replace(/\/image_generation$/, '/images/generations');
  return withImages ? `${base}/images/edits` : `${base}/images/generations`;
}

export interface ImageGenInput {
  prompt: string;
  /** 人物参考照（data URL）。H3 时作为图 1；image-01 时走 subject_reference。 */
  personImage?: string;
  /** 衣物实拍参考图（data URL，H3 专用；image-01 不支持衣物参考，传入时仍按旧协议发送文字特征）。 */
  garmentImages?: string[];
  aspectRatio?: '1:1' | '2:3' | '3:4' | '9:16' | string;
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
  const h3 = isH3ImageModel(config.modelId);
  try {
    const garmentImages = (input.garmentImages ?? []).filter(Boolean);
    const referenceImages = [input.personImage, ...garmentImages].filter(Boolean) as string[];
    const response = await fetch(h3 ? h3EndpointFor(config.baseUrl, referenceImages.length > 0) : endpointFor(config.urlKind, config.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(
        h3
          ? {
              model: config.modelId,
              // C7（2026-11-04）：不静默截断——H3 上限 32000 字符，装配层预算（PREVIEW_PROMPT_BUDGET）仍按成本控制组织。
              prompt: input.prompt,
              ...(referenceImages.length
                ? { images: referenceImages.map((dataUrl) => ({ image_url: dataUrl })) }
                : {}),
              ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
              n: input.n ?? 1,
              response_format: 'url',
            }
          : {
              model: config.modelId,
              // C7（2026-11-04）：不再静默截断到 1500 字符——截掉末尾衣物会让后面的单品"整件消失"。
              // 提示词长度由装配层按预算组织（previewTaskRunner.buildPrompt：先保全部单品身份，
              // 超预算按可解释规则压缩次要描述，仍超则显式失败），客户端原样发送。
              prompt: input.prompt,
              ...(input.personImage
                ? { subject_reference: [{ type: 'character', image_file: input.personImage }] }
                : {}),
              ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
              n: input.n ?? 1,
              response_format: 'url',
            },
      ),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const payload = (await response.json().catch(() => null)) as {
      data?: Array<{ url?: string; error?: { code?: string; message?: string } }>;
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
    if (h3) {
      // H3：部分失败仍 200，逐项检查；全部失败时服务端已返回非 2xx（上面拦截）。
      const items = payload?.data ?? [];
      const okUrls = items.filter((d) => d.url).map((d) => d.url as string);
      if (okUrls.length) return { ok: true, imageUrls: okUrls, latencyMs };
      const firstError = items.find((d) => d.error)?.error;
      return {
        ok: false,
        imageUrls: [],
        latencyMs,
        error: {
          kind: 'api',
          message: firstError ? `生成失败 ${firstError.code ?? ''}：${firstError.message ?? '未知'}` : '未返回图片',
        },
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
    const imageUrls = (payload as { data?: { image_urls?: string[] } } | null)?.data?.image_urls ?? [];
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
