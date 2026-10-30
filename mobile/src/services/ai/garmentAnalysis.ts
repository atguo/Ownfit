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
export const GARMENT_PROMPT_VERSION = '5';

/** 分析调用参数（D3）：与连接测试的 16 / 30000 区分开。真机实测 2048/4096/8192 均出现
 * finish_reason=length 截断（模型输出带缩进的长清单，思考型模型思考也计入额度）；
 * 提示词已要求紧凑单行 JSON，项目用户指示上限放大到 40960；若供应商拒绝该值会以
 * HTTP 400 失败，届时按错误信息回调。 */
export const ANALYSIS_MAX_TOKENS = 40960;
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
1. 只输出一个 JSON 对象，不要解释文字。可以整体包一层 \`\`\`json 围栏，但不要再有其它内容。必须是紧凑单行 JSON：不要缩进、不要换行——缩进会浪费输出额度，容易被截断。
2. attributes 是动态属性清单：照片里看得到的细节都写进去（如领型、袖型、版型、衣长、图案、纽扣、口袋、缝线、做旧、光泽感等），名称和条数不限（0-40 条），每条 {"name":"属性名(≤20字)","value":"描述(≤200字)"}。条数以照片实际可见的细节为准，够用即可，不必凑满 40 条。属性名必须用简体中文（如"领型""袖型""图案"），禁止使用英文单词或拼音作属性名；同名不要重复。
3. targetStatus、category、suggestedName、colors、unclearParts 都是独立的顶层字段，不要把它们（或 suggestedName/category 这类英文键名）放进 attributes。
4. 只描述照片里看得见的内容。看不清或不确定的属性就不要写进 attributes，改为放入 unclearParts（≤6 项，说明部位或原因）。
5. 禁止输出尺寸数字、面料成分、品牌、尺码、合身结论、保暖/防水等性能结论——这些无法从单张照片得知，写了会破坏档案可信度。
6. colors 0-4 项，每项 {"name":"日常中文颜色名","hex":"#RRGGBB 近似色","isPrimary":布尔}，非空时恰好一项 isPrimary=true。
7. category 只能是：上衣、下装、连衣裙、外套、鞋履、包、配饰之一；判断不了填 null。
8. suggestedName：≤30 字的中文短名建议；判断不了填 null。
9. targetStatus：画面只有一件目标衣服且可辨认时 "single"；有多件无法确定目标 "ambiguous"；不是衣物 "not_garment"；完全看不清 "unreadable"。
10. targetStatus 不是 "single" 时：category=null、suggestedName=null、colors=[]、attributes=[]，且 unclearParts 至少 1 项。

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
 * 严格解析模型返回内容，按顺序尝试：
 * 1. 整体就是一个 JSON 对象；
 * 2. 推理型模型先输出的 <think>…</think> 思考段剥掉后满足 1；
 * 3. 正文里恰好有一个完整的 ```json / ``` 围栏块（整体包裹，或围栏前后带说明文字）。
 * 不截取首尾花括号修复任意文本，不接受多个围栏块（无法确定目标）；
 * 提取出的内容仍必须是完整 JSON 并通过契约校验。
 * 失败时附返回内容开头摘要，便于在设备上诊断（分析输出不含敏感信息）。
 */
export function parseAnalysisContent(content: string): ParseContentResult {
  const fail = (raw: string): ParseContentResult => ({
    ok: false,
    error: `返回内容不是完整的 JSON 对象，也不是围栏包裹的对象；开头：${raw.slice(0, 60) || '（空）'}`,
  });

  const trimmed = content.trim();
  const thinkStripped = trimmed.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  for (const candidate of [trimmed, thinkStripped]) {
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      try {
        return { ok: true, value: JSON.parse(candidate) };
      } catch {
        // 整体是 JSON 形状但解析失败：继续尝试围栏提取，不走修复
      }
    }
  }

  for (const candidate of [trimmed, thinkStripped]) {
    const blocks = [...candidate.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
      .map((match) => (match[1] ?? '').trim())
      .filter((text) => text.startsWith('{') && text.endsWith('}'));
    if (blocks.length === 1) {
      try {
        return { ok: true, value: JSON.parse(blocks[0]) };
      } catch {
        return { ok: false, error: `围栏内容不是合法 JSON：${blocks[0].slice(0, 60)}` };
      }
    }
    if (blocks.length > 1) {
      return { ok: false, error: `返回内容包含 ${blocks.length} 个代码块，无法确定分析结果` };
    }
  }

  return fail(trimmed);
}

/**
 * 供应商适配：
 * - 实验提示词里的“鞋”显式映射为契约的“鞋履”（契约只接受“鞋履”）。
 * - 模型偶发沿用英文键名（旧档案字段习惯）时映射为中文属性名，不改语义；
 *   映射只认小写比较，未收录的名称原样保留。
 * - 同名属性去重：保留最后一条（与档案“同名取最新”一致），避免整体校验因重复被拒。
 */
const ATTRIBUTE_NAME_ZH: Record<string, string> = {
  pattern: '图案',
  neckline: '领型',
  collar: '领型',
  sleeve: '袖型',
  sleeves: '袖型',
  fit: '版型',
  silhouette: '版型',
  length: '长度',
  hem: '下摆',
  closure: '闭合方式',
  pocket: '口袋',
  pockets: '口袋',
  button: '纽扣',
  buttons: '纽扣',
  seam: '缝线',
  style: '风格',
  stylingtags: '穿搭风格',
  description: '细节描述',
  detail: '细节',
  details: '细节',
  texture: '质感',
  waistline: '腰线',
  skirtlength: '裙长',
  heel: '跟型',
  toe: '鞋头',
  shoetype: '鞋型',
  bagtype: '包型',
  accessorytype: '配饰类型',
};

export function normalizeAnalysisPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const payload = { ...(value as Record<string, unknown>) };
  const category = payload.category;
  if (typeof category === 'string' && category === '鞋') {
    payload.category = '鞋履';
  }
  if (Array.isArray(payload.attributes)) {
    const byName = new Map<string, unknown>();
    for (const entry of payload.attributes) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.name !== 'string') continue;
      const normalized = ATTRIBUTE_NAME_ZH[record.name.trim().toLowerCase()];
      const name = normalized ?? record.name;
      byName.set(name, { ...record, name });
    }
    payload.attributes = [...byName.values()];
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
    return {
      ok: false,
      error: {
        kind: 'invalid_output',
        message:
          chat.finishReason === 'length'
            ? `模型输出在 ${ANALYSIS_MAX_TOKENS} token 上限处被截断，未返回完整 JSON；可重试，若反复出现请换模型`
            : parsed.error,
      },
    };
  }

  const validated = parseGarmentAnalysis(normalizeAnalysisPayload(parsed.value));
  if (!validated.ok) {
    return {
      ok: false,
      error: {
        kind: 'invalid_output',
        message:
          chat.finishReason === 'length'
            ? `模型输出被 ${ANALYSIS_MAX_TOKENS} token 上限截断；${validated.error}`
            : validated.error,
      },
    };
  }

  return { ok: true, result: validated.value };
}
