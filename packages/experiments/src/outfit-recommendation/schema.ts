// A-搭配推荐实验：输入衣物档案（结构化，不含照片）+ 场景 → 文本模型生成候选组合。
// 实验内 schema 用于校验返回结构；通过率与缺口统计是 M5 接入的证据。
// 边界：本 schema 不是 M3 业务契约；接入前需由适配层转换并过契约 v1.0.0 校验。

import { z } from 'zod';

export const RECOMMENDATION_VERSION = '0.1.0-draft';

export const wearStyles = ['自然垂放', '前侧塞衣角', '外层敞开穿'] as const;
export type WearStyle = (typeof wearStyles)[number];

export const slotRoles = ['top', 'bottom', 'dress', 'shoes', 'outerwear', 'bag', 'accessory'] as const;
export type SlotRole = (typeof slotRoles)[number];

/** 推荐请求（实验输入） */
export const recommendationRequestSchema = z.strictObject({
  city: z.string().min(1),
  day: z.string().min(1),
  scene: z.string().min(1),
  temperatureC: z.number().optional(),
  weather: z.string().optional(),
});

export type RecommendationRequest = z.infer<typeof recommendationRequestSchema>;

/** 候选组合：按槽位给单品 ID + 穿法 + 说明 */
export const candidateSchema = z.strictObject({
  slots: z
    .array(
      z.strictObject({
        role: z.enum(slotRoles),
        itemId: z.string().min(1),
        note: z.string().max(120).optional(),
      }),
    )
    .min(1)
    .max(7),
  wearStyle: z.enum(wearStyles),
  reason: z.string().max(200).optional(),
});

export type Candidate = z.infer<typeof candidateSchema>;

/** 模型返回：候选列表 + 缺口说明（数据不足时必须显式表达） */
export const recommendationResultSchema = z.strictObject({
  candidates: z.array(candidateSchema).max(5),
  /** 资料缺口：缺哪类衣物、为什么无法给出该槽位 */
  gaps: z.array(z.string().max(120)).max(8).default([]),
  /** 模型给出的整体说明（不作为合身结论） */
  summary: z.string().max(300).optional(),
});

export type RecommendationResult = z.infer<typeof recommendationResultSchema>;

export function parseRecommendation(value: unknown): { ok: true; value: RecommendationResult } | { ok: false; error: string } {
  const parsed = recommendationResultSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('；');
  return { ok: false, error: `推荐结果校验失败：${issues}` };
}

/** 校验候选引用的单品是否存在且可用（实验内判定，APP 侧再校验可用性） */
export function checkCandidateItemIds(
  result: RecommendationResult,
  availableIds: readonly string[],
): { missingItemIds: string[] } {
  const available = new Set(availableIds);
  const missing = new Set<string>();
  for (const candidate of result.candidates) {
    for (const slot of candidate.slots) {
      if (!available.has(slot.itemId)) missing.add(slot.itemId);
    }
  }
  return { missingItemIds: [...missing] };
}
