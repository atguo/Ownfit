// 衣物照片分析客户端（字段来源重构版，提示词按 2.0.0-draft 动态属性模型）。
// 只负责：提示词、图片请求、严格 JSON 解析与业务契约适配。
// 边界：不写数据库、不决定重试、不读取密钥（密钥由调用方从安全存储取出后传入内存）。
// 契约与版本见 packages/contract/src/garmentAnalysis.ts（2.0.0-draft）。

import {
  parseGarmentAnalysis,
  recommendedAttributeKeys,
  type GarmentAnalysis,
  type GarmentCategory,
} from '@ownfit/contract';
import { chatCompletion } from './openaiClient';
import type { ModelConfig } from './types';

/** 提示词版本：随提示词或解析约定的变化递增，用于任务记录的 prompt_version */
export const GARMENT_PROMPT_VERSION = '2';

/** 分析调用参数（D3）：与连接测试的 16 / 30000 区分开 */
export const ANALYSIS_MAX_TOKENS = 2048;
export const ANALYSIS_TIMEOUT_MS = 90000;

export type AnalysisErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'invalid_request'
  | 'not_found'
  | 'server'
  | 'unknown'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'empty'
  | 'invalid_output';

export type AnalysisRunResult =
  | { ok: true; result: GarmentAnalysis }
  | { ok: false; error: { kind: AnalysisErrorKind; message: string } };

const ANALYSIS_ERROR_KINDS: readonly AnalysisErrorKind[] = [
  'auth',
  'rate_limit',
  'invalid_request',
  'not_found',
  'server',
  'unknown',
  'timeout',
  'cancelled',
  'network',
  'empty',
  'invalid_output',
];

function toAnalysisErrorKind(kind: string | undefined): AnalysisErrorKind {
  return ANALYSIS_ERROR_KINDS.includes(kind as AnalysisErrorKind)
    ? (kind as AnalysisErrorKind)
    : 'unknown';
}

const SYSTEM_PROMPT = `你是服装档案助手。看一张衣服照片，输出一个 JSON 对象，用于写入用户的衣物档案。数据越详细越好，这些数据会供后续 AI 使用。

硬性规则：
1. 只输出一个 JSON 对象，不要解释文字。可以整体包一层 \`\`\`json 围栏，但不要再有其它内容。
2. attributes 是动态属性清单：照片里看得到的细节都写进去（如领型、袖型、版型、衣长、图案、纽扣、口袋、缝线、做旧、光泽感等），名称和条数不限（0-40 条），每条 {"name":"属性名(≤20字)","value":"描述(≤200字)"}。同名不要重复。
3. 只描述照片里看得见的内容。看不清或不确定的属性就不要写进 attributes，改为放入 unclearParts（≤6 项，说明部位或原因）。
4. 禁止输出尺寸数字、面料成分、品牌、尺码、合身结论、保暖/防水等性能结论——这些无法从单张照片得知，写了会破坏档案可信度。
5. colors 0-4 项，每项 {"name":"日常中文颜色名","hex":"#RRGGBB 近似色","isPrimary":布尔}，非空时恰好一项 isPrimary=true。
6. category 只能是：上衣、下装、连衣裙、外套、鞋履、包、配饰之一；判断不了填 null。
7. suggestedName：≤30 字的短名建议；判断不了填 null。
8. targetStatus：画面只有一件目标衣服且可辨认时 "single"；有多件无法确定目标 "ambiguous"；不是衣物 "not_garment"；完全看不清 "unreadable"。
9. targetStatus 不是 "single" 时：category=null、suggestedName=null、colors=[]、attributes=[]，且 unclearParts 至少 1 项。

输出结构（所有键都必需）：
{
  "targetStatus": "single",
  "category": "上衣",
  "suggestedName": "米白色宽松针织衫",
  "colors": [{"name": "奶油白", "hex": "#F5F0E1", "isPrimary": true}],
  "attributes": [{"name": "领型", "value": "圆领"}, {"name": "版型", "value": "宽松"}],
  "unclearParts": ["背面"]
}

各品类通常可以关注的属性名（仅供参考，照片里有的其他细节也请输出）：
上衣：领型、袖型、版型、衣长、图案、细节。
下装：版型、长度、腰线、图案、细节。
连衣裙：领型、袖型、版型、裙长、腰线、图案、细节。
外套：领型、袖型、版型、衣长、厚薄、图案、细节。
鞋履：鞋型、鞋头、跟型、闭合方式、图案、细节。
包：包型、尺寸感、图案、细节。
配饰：配饰类型、图案、细节。`;

const USER_TEXT = '请分析这张照片中的衣服，按 system 要求输出 JSON。';

/** 组装请求消息：只含本件照片（一张）、可选品类提示（含该品类的推荐属性名）与提示词 */
export function buildAnalysisMessages(
  imageDataUrl: string,
  categoryHint?: string,
): Array<{ role: 'system' | 'user'; content: unknown }> {
  const hint = categoryHint?.trim();
  const recommended = hint
    ? (recommendedAttributeKeys[hint as GarmentCategory] ?? null)
    : null;
  const guide = recommended ? `这类衣服通常可以关注：${recommended.join('、')}（仅供参考）。` : '';
  const text = `${USER_TEXT}${guide}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

export type ParseContentResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * 严格解析模型返回内容：
 * 只接受“整体就是 JSON 对象”，或“整体包在一层 ```json / ``` 围栏里的对象”。
 * 不截取首尾花括号修复任意文本，避免把解释文字里的片段当成结果。
 */
export function parseAnalysisContent(content: string): ParseContentResult {
  const trimmed = content.trim();
  let jsonText: string | null = null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    jsonText = trimmed;
  } else {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fenced) jsonText = fenced[1].trim();
  }
  if (jsonText === null || !jsonText.startsWith('{') || !jsonText.endsWith('}')) {
    return { ok: false, error: '返回内容不是完整的 JSON 对象，也不是单层围栏包裹的对象' };
  }
  try {
    return { ok: true, value: JSON.parse(jsonText) };
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 供应商适配：实验提示词里的“鞋”显式映射为契约的“鞋履”。
 * 契约只接受“鞋履”，其余取值不做任何猜测性转换。
 */
export function normalizeAnalysisPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const payload = { ...(value as Record<string, unknown>) };
  const category = payload.category;
  if (typeof category === 'string' && category === '鞋') {
    payload.category = '鞋履';
  }
  return payload;
}

export interface RunGarmentAnalysisInput {
  config: Pick<ModelConfig, 'urlKind' | 'baseUrl' | 'modelId'>;
  apiKey: string;
  /** 由 photoRepository.readAnalysisImage 产出；不传本地 file URI */
  imageDataUrl: string;
  categoryHint?: string;
  /** 由任务执行器传入，用于尽力停止已发送的请求 */
  signal?: AbortSignal;
  /** 仅供测试与将来可配置；不传时使用 D3 的 90000 */
  timeoutMs?: number;
}

/**
 * 执行一次分析调用：请求 → 拒绝空内容 → 严格解析 → 契约校验。
 * 不写数据库，不做重试；失败以结构化错误返回，由调用方（执行器）决定记录与是否让用户手动重试。
 */
export async function runGarmentAnalysis(
  input: RunGarmentAnalysisInput,
): Promise<AnalysisRunResult> {
  const chat = await chatCompletion(
    input.config,
    input.apiKey,
    buildAnalysisMessages(input.imageDataUrl, input.categoryHint),
    input.timeoutMs ?? ANALYSIS_TIMEOUT_MS,
    { maxTokens: ANALYSIS_MAX_TOKENS, signal: input.signal },
  );

  if (!chat.ok) {
    return {
      ok: false,
      error: {
        kind: toAnalysisErrorKind(chat.error?.kind),
        message: chat.error?.message ?? '调用失败',
      },
    };
  }

  // HTTP 200 但内容为空：连接测试视为可达，分析必须视为失败（R3）
  if (chat.content.trim().length === 0) {
    return { ok: false, error: { kind: 'empty', message: '模型未返回内容，无法得到分析结果' } };
  }

  const parsed = parseAnalysisContent(chat.content);
  if (!parsed.ok) {
    return { ok: false, error: { kind: 'invalid_output', message: parsed.error } };
  }

  const validated = parseGarmentAnalysis(normalizeAnalysisPayload(parsed.value));
  if (!validated.ok) {
    return { ok: false, error: { kind: 'invalid_output', message: validated.error } };
  }

  return { ok: true, result: validated.value };
}
