// MiniMax 图像生成适配器（自有协议，非 OpenAI 兼容）。
// 端点：POST {baseUrl}/v1/image_generation，Bearer 认证。
// 关键约束（官方文档）：
//   - subject_reference 目前仅支持 type:"character"（人物肖像），不支持服装参考图
//   - 服装只能靠 prompt 传达（≤1500 字符）
//   - 返回的图片 URL 24 小时失效——必须当场下载到 samples/preview-output/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireProfile } from '../lib/config';
import { toDataUrl } from '../lib/images';
import { appendRecord } from '../lib/records';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const outputRoot = path.join(pkgRoot, 'samples', 'preview-output');

export interface MiniMaxTryOnRequest {
  /** 人物参考照（正面全身，单人效果最佳） */
  personRef: string;
  /** 生成指令（可由 tryOnPrompt() 从衣物理解结果生成，≤1500 字符） */
  prompt: string;
  /** image-01（标准）或 image-01-live（对照）；默认取档案 MODEL_ID */
  model?: string;
  aspectRatio?: '1:1' | '2:3' | '3:4' | '9:16';
  n?: number;
  /** 批次标识：输出落盘 samples/preview-output/<runId>/ */
  runId: string;
}

export interface MiniMaxTryOnResult {
  ok: boolean;
  imageRefs: string[];
  latencyMs: number;
  model: string;
  error?: { kind: string; message: string };
}

export async function generateTryOn(request: MiniMaxTryOnRequest): Promise<MiniMaxTryOnResult> {
  const profile = requireProfile('minimax', 'image_gen');
  const model = request.model ?? profile.modelId;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(`${profile.baseUrl}/v1/image_generation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${profile.apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt: request.prompt.slice(0, 1500),
        subject_reference: [{ type: 'character', image_file: toDataUrl(request.personRef) }],
        ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
        n: request.n ?? 1,
        response_format: 'url',
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const message = `HTTP ${response.status}：${JSON.stringify(payload).slice(0, 300)}`;
      return { ok: false, imageRefs: [], latencyMs, model, error: { kind: classify(response.status), message } };
    }

    const baseResp = (payload as { base_resp?: { status_code?: number; status_msg?: string } })?.base_resp;
    if (baseResp && baseResp.status_code !== 0) {
      const kind = baseResp.status_code === 1008 ? 'quota' : baseResp.status_code === 1004 || baseResp.status_code === 2049 ? 'auth' : 'api';
      const message = `业务错误 ${baseResp.status_code}：${baseResp.status_msg ?? '未知'}`;
      return { ok: false, imageRefs: [], latencyMs, model, error: { kind, message } };
    }

    const urls = (payload as { data?: { image_urls?: string[] } })?.data?.image_urls ?? [];
    const runDir = path.join(outputRoot, request.runId);
    fs.mkdirSync(runDir, { recursive: true });

    // URL 24h 失效：当场下载落盘
    const imageRefs: string[] = [];
    for (const [index, url] of urls.entries()) {
      const fileName = `${model}-${Date.now()}-${index}.png`;
      const absolute = path.join(runDir, fileName);
      const imageResponse = await fetch(url);
      if (!imageResponse.ok) {
        console.error(`警告：第 ${index + 1} 张图下载失败（HTTP ${imageResponse.status}），URL 24h 内有效：${url}`);
        continue;
      }
      fs.writeFileSync(absolute, Buffer.from(await imageResponse.arrayBuffer()));
      imageRefs.push(`samples/preview-output/${request.runId}/${fileName}`);
    }

    if (!imageRefs.length) {
      return { ok: false, imageRefs: [], latencyMs, model, error: { kind: 'empty', message: '生成成功但图片下载全部失败' } };
    }
    return { ok: true, imageRefs, latencyMs, model };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      imageRefs: [],
      latencyMs,
      model,
      error: {
        kind: 'network',
        message: aborted ? '请求超时（120s）' : `网络失败：${error instanceof Error ? error.message : String(error)}`,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function classify(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'invalid_request';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** 生成并落记录（所有调用都走这里，保证证据链完整） */
export async function generateTryOnRecorded(
  request: Omit<MiniMaxTryOnRequest, 'runId'> & { runId: string; purpose: string; inputRefs: string[] },
): Promise<MiniMaxTryOnResult> {
  const result = await generateTryOn(request);
  appendRecord('try-on-preview', {
    workflow: 'try-on-preview',
    purpose: request.purpose,
    provider: 'minimax',
    model: result.model,
    inputRefs: request.inputRefs,
    outputRefs: result.imageRefs,
    ok: result.ok,
    latencyMs: result.latencyMs,
    error: result.error,
  });
  return result;
}
