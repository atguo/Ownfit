// 衣物分析业务契约 v2.0.0-draft（动态属性模型）。
// 本版取代旧的"固定 9 字段 + 枚举 + 三态"形状（真机验证后的重构设计，
// 见 docs/plans/2026-10-29-衣物分析字段与来源重构-设计.md）：
// - 放弃固定字段与枚举选项：AI 按需产出动态细节属性，条数与名称不限
// - 颜色内置并带 hex（近似色块，用户可改）
// - 未知/不适用不再表达：属性存在即"已分析到"，不存在即"未提取"
// 红线不变：禁止猜测精确尺寸、面料成分、品牌、尺码、真人合身、保暖/防水结论。
//
// 契约校验只能保证结构与取值合法，不能防止模型幻觉；真机仍需逐项人工核对。

import { z, type ZodType } from 'zod';
import type { ParseResult } from './schema';

export const GARMENT_ANALYSIS_VERSION = '2.0.0-draft';

/** 与分析对齐的衣物大类（与 mobile/src/data/demo.ts 的 categories 一致） */
export const garmentCategories = ['上衣', '下装', '连衣裙', '外套', '鞋履', '包', '配饰'] as const;
export type GarmentCategory = (typeof garmentCategories)[number];

/** 目标单品是否可确定：只有 single 才允许产生可应用属性 */
export const targetStatuses = ['single', 'ambiguous', 'not_garment', 'unreadable'] as const;
export type TargetStatus = (typeof targetStatuses)[number];

/** AI 给出的近似色（仅作色块与回显，用户可改） */
export const garmentColorSchema = z.strictObject({
  name: z.string().min(1).max(20),
  hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'hex 必须是 #RRGGBB'),
  isPrimary: z.boolean(),
});
export type GarmentColor = z.infer<typeof garmentColorSchema>;

/** 动态细节属性：名称 1-20 字、值 1-200 字；同名不重复（在对象级 refine 校验） */
export const detailAttributeSchema = z.strictObject({
  name: z.string().min(1).max(20),
  value: z.string().min(1).max(200),
});
export type DetailAttribute = z.infer<typeof detailAttributeSchema>;

/**
 * 每品类推荐属性名（引导 AI 一致性与详情排序；契约不限制，AI 可自由增加）。
 * 最终措辞见重构设计 §8。
 */
export const recommendedAttributeKeys: Record<GarmentCategory, readonly string[]> = {
  上衣: ['领型', '袖型', '版型', '衣长', '图案', '细节'],
  下装: ['版型', '长度', '腰线', '图案', '细节'],
  连衣裙: ['领型', '袖型', '版型', '裙长', '腰线', '图案', '细节'],
  外套: ['领型', '袖型', '版型', '衣长', '厚薄', '图案', '细节'],
  鞋履: ['鞋型', '鞋头', '跟型', '闭合方式', '图案', '细节'],
  包: ['包型', '尺寸感', '图案', '细节'],
  配饰: ['配饰类型', '图案', '细节'],
};

/**
 * 衣物分析结果（2.0.0-draft 动态属性模型）：
 * - targetStatus = 'single' 时：category/suggestedName 可有值，colors/attributes 可有内容
 * - targetStatus 非 'single' 时：category/suggestedName 必须为 null，
 *   colors/attributes 必须为空，unclearParts 至少 1 项（说明为什么无法确定）
 * - 不确定的属性就不输出；禁止以空值或猜测填充
 */
export const garmentAnalysisSchema = z
  .strictObject({
    targetStatus: z.enum(targetStatuses),
    category: z.enum(garmentCategories).nullable(),
    suggestedName: z.string().min(1).max(30).nullable(),
    colors: z.array(garmentColorSchema).max(4),
    attributes: z.array(detailAttributeSchema).max(40),
    unclearParts: z.array(z.string().min(1).max(80)).max(6),
  })
  .refine((value) => value.colors.length === 0 || value.colors.filter((c) => c.isPrimary).length === 1, {
    message: 'colors 非空时必须恰好一个 isPrimary=true 的主色',
  })
  .refine(
    (value) => {
      const names = value.attributes.map((a) => a.name);
      return new Set(names).size === names.length;
    },
    { message: 'attributes 存在重复属性名' },
  )
  .refine(
    (value) =>
      value.targetStatus === 'single' ||
      (value.category === null && value.suggestedName === null && value.colors.length === 0 && value.attributes.length === 0),
    { message: 'targetStatus 非 single 时，category/suggestedName 必须为 null 且 colors/attributes 必须为空' },
  )
  .refine(
    (value) => value.targetStatus === 'single' || value.unclearParts.length >= 1,
    { message: 'targetStatus 非 single 时，unclearParts 至少 1 项' },
  );

export type GarmentAnalysis = z.infer<typeof garmentAnalysisSchema>;

/** 解析并严格校验模型返回的分析结构；不修改输入、不补默认值 */
export function parseGarmentAnalysis(value: unknown): ParseResult<GarmentAnalysis> {
  const result = garmentAnalysisSchema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('；');
  return { ok: false, error: `衣物分析校验失败：${issues}` };
}
