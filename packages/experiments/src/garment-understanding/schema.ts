// A-衣物理解：输出字段 schema。
// 字段集依据 docs/functions/衣橱资料入库与渐进完善.md §4.3「可提取字段」：
// 品类、颜色、图案、领型、袖型、版型、搭配标签；未知显式表达，不猜测。
// 注意：这是实验内部的校验结构，不是 M3 业务契约（契约草案在 M3 前另行形成）。

import { z } from 'zod';

// 枚举按功能文档 §4.3 归纳；「未知」是合法值——看不清/不确定时必须填未知而不是猜。
export const garmentUnderstandingSchema = z.object({
  category: z.enum(['上衣', '下装', '连衣裙', '外套', '鞋', '包', '配饰', '未知']),
  categoryConfidence: z.enum(['确定', '推测']),
  colors: z
    .array(z.object({ name: z.string().min(1), isPrimary: z.boolean() }))
    .max(4)
    .readonly(),
  pattern: z.enum(['纯色', '条纹', '格纹', '印花', '拼接', '其他', '未知']),
  neckline: z.enum(['未知', '无领/圆领', 'V领', '立领', '翻领', '连帽', '一字领', '其他']),
  sleeve: z.enum(['未知', '无袖', '短袖', '七分袖', '长袖', '其他']),
  fit: z.enum(['未知', '修身', '合体', '宽松', 'oversize']),
  stylingTags: z.array(z.string().min(1)).max(6).readonly(),
  /** 一句话描述：用于人工核对模型到底"看到"了什么 */
  description: z.string().min(1).max(120),
  /** 模型自己声明的看不清之处（如背面、面料质感） */
  unclearParts: z.array(z.string()).max(6).readonly(),
});

export type GarmentUnderstanding = z.infer<typeof garmentUnderstandingSchema>;

/** 从模型返回文本中容错提取 JSON（兼容 ```json 围栏与前后缀文字） */
export function parseUnderstanding(text: string): { ok: true; value: GarmentUnderstanding } | { ok: false; error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { ok: false, error: '返回中未找到 JSON 对象' };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const result = garmentUnderstandingSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('；');
    return { ok: false, error: `字段校验失败：${issues}` };
  }
  return { ok: true, value: result.data };
}
