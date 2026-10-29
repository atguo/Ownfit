// 衣见业务契约 v1.0.0-draft：搭配请求、方案结果与方案修改的稳定结构。
// 依据 docs/开发计划.md §6.3 与 docs/functions/基于已有衣橱生成搭配.md §5.1。
//
// 冻结状态：草案（1.0.0-draft）。真实模型输出的适配尚未验证（A 线样本待采集），
// 冻结前字段可能随实现反馈调整；任何变更须记录原因、影响与回归范围并升级版本。
//
// 缺省语义（§6.3：未知值、空列表和失败不能混用）：
// - reason = null      → 推荐原因未提供，UI 显示缺省文案，不得编造理由
// - gaps = []          → 无缺口
// - 失败               → 用 PlanFailure 表达，不产出部分有效的 Plan
// - satisfied = null   → 穿过但未评价，不视为满意

import { z, type ZodType } from 'zod';

export const CONTRACT_VERSION = '1.0.0-draft';

/** 穿法的作用部位。当前仅支持整体；未来扩展（如袖口、下摆）在此追加。 */
export const wearSlots = ['整体'] as const;
export type WearSlot = (typeof wearSlots)[number];

/** 穿法样式（当前支持清单）。请求不在此清单内的穿法按"不支持"拒绝。 */
export const wearStyles = ['自然垂放', '前侧塞衣角', '外层敞开穿'] as const;
export type WearStyle = (typeof wearStyles)[number];

export const wearSchema = z.object({
  slot: z.enum(wearSlots),
  style: z.enum(wearStyles),
});
export type Wear = z.infer<typeof wearSchema>;

/** 方案内单品的角色：basis = 本轮搭配的起点单品；locked = 用户声明替换时保留；piece = 组合件 */
export const planItemRoleSchema = z.enum(['basis', 'locked', 'piece']);
export type PlanItemRole = z.infer<typeof planItemRoleSchema>;

export const planItemSchema = z.object({
  /** 单品引用：指向本地衣橱 items.id */
  itemId: z.string().min(1),
  role: planItemRoleSchema,
});
export type PlanItem = z.infer<typeof planItemSchema>;

/** 场景快照：方案生成/保存时的环境条件（手动输入；天气服务数据 M5 接入后扩展） */
export const sceneSnapshotSchema = z.object({
  city: z.string().min(1),
  day: z.enum(['今天', '明天']),
  scene: z.string().min(1),
});
export type SceneSnapshot = z.infer<typeof sceneSnapshotSchema>;

/** 缺口与不可执行原因的类型 */
export const gapKinds = [
  'missing_category', // 衣橱中暂未找到该品类（不推断用户未拥有）
  'no_candidate', // 同品类无可替换项
  'unsupported_wear', // 请求的穿法不在支持清单
  'insufficient_photo', // 主图不可辨认，无法用于该用途
  'other',
] as const;
export const gapSchema = z.object({
  kind: z.enum(gapKinds),
  message: z.string().min(1),
});
export type Gap = z.infer<typeof gapSchema>;

/**
 * 搭配请求：用户从哪一件开始 + 锁定集合 + 场景。
 * 规则：basis 必须同时出现在锁定集合中（起点单品默认锁定，可手动解锁后移除）。
 */
export const planRequestSchema = z
  .object({
    basisItemId: z.string().min(1),
    lockedItemIds: z.array(z.string().min(1)).min(1),
    scene: sceneSnapshotSchema,
  })
  .refine((request) => request.lockedItemIds.includes(request.basisItemId), {
    message: 'basisItemId 必须包含在 lockedItemIds 中（起点单品默认锁定）',
  })
  .refine((request) => new Set(request.lockedItemIds).size === request.lockedItemIds.length, {
    message: 'lockedItemIds 存在重复项',
  });
export type PlanRequest = z.infer<typeof planRequestSchema>;

/**
 * 方案结果：一次保存产出的完整方案（版本节点）。
 * 规则：
 * - version 单调递增；parentPlanId 指向被复用/修改的父版本（新方案为 null）
 * - items 至少 1 件，且恰好 1 件 role = 'basis'
 * - reason = null 表示未提供原因（UI 显缺省文案，不得编造）
 * - gaps = [] 表示无缺口
 */
export const planSchema = z
  .object({
    planId: z.string().min(1),
    parentPlanId: z.string().min(1).nullable(),
    version: z.number().int().positive(),
    items: z.array(planItemSchema).min(1),
    wear: wearSchema,
    reason: z.string().min(1).nullable(),
    gaps: z.array(gapSchema),
    scene: sceneSnapshotSchema,
    source: z.enum(['manual', 'ai']),
    createdAt: z.string().min(1),
  })
  .refine((plan) => plan.items.filter((item) => item.role === 'basis').length === 1, {
    message: '方案必须恰好包含 1 件 role=basis 的单品',
  });
export type Plan = z.infer<typeof planSchema>;

/** 失败结果：请求被拒绝或执行失败时产出，不产出部分有效的 Plan */
export const planFailureSchema = z.object({
  kind: z.enum([
    'unsupported_wear',
    'basis_not_locked',
    'item_not_found',
    'version_conflict',
    'other',
  ]),
  message: z.string().min(1),
});
export type PlanFailure = z.infer<typeof planFailureSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function zodParse<T>(schema: ZodType<T>, value: unknown, label: string): ParseResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('；');
  return { ok: false, error: `${label} 校验失败：${issues}` };
}

export function parsePlanRequest(value: unknown): ParseResult<PlanRequest> {
  return zodParse<PlanRequest>(planRequestSchema, value, '搭配请求');
}
export function parsePlan(value: unknown): ParseResult<Plan> {
  return zodParse<Plan>(planSchema, value, '方案');
}
export function parsePlanFailure(value: unknown): ParseResult<PlanFailure> {
  return zodParse<PlanFailure>(planFailureSchema, value, '失败结果');
}
