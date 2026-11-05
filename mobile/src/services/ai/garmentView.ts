// A2 轻量归一化视图（建议稿 A2，2026-11-04）：从动态属性的有效视图提取
// "关键特征不漏、不编造"的业务视图，供推荐输入（B2 预算）、预览提示词（C7 预算）
// 与防偏约束快照（C8）共用——三处消费同一份特征，不再各自拼文字。
// 规则：
// - 只搬运已有属性，不推断、不改写；未知就缺省输出（不猜填）
// - 归一化不把主观描述转换成实测值（"长款"就是"长款"，不是厘米）
// - 关键特征=影响"是不是这件衣服"的外观（图案/领型/袖型/长度/开合/版型等）；
//   次要描述=自由文本（"细节"等），超预算时先压缩，不参与身份判断

export interface GarmentColorInput {
  name: string;
  hex: string;
  isPrimary?: boolean;
}

export interface GarmentFeatureView {
  category: string | null;
  /** 主色（isPrimary 优先，否则第一个）；无颜色记录时为 null */
  mainColor: { name: string; hex: string } | null;
  /** 其余颜色名（用于"白底黑点"类描述） */
  accentColorNames: string[];
  /** 关键特征（按还原重要性排序）：`图案=大格纹` 形式 */
  keyFeatures: string[];
  /** 次要描述（自由文本），超预算时先压缩 */
  secondary: string[];
}

/**
 * 关键特征名清单：与分析契约 recommendedAttributeKeys 对齐并跨品类合并。
 * 不在此清单的属性名一律进次要层（不丢内容，只降优先级）。
 */
const KEY_FEATURE_ORDER = [
  '图案',
  '领型',
  '袖型',
  '衣长',
  '裙长',
  '长度',
  '版型',
  '轮廓',
  '腰线',
  '厚薄',
  '开合方式',
  '闭合方式',
  '鞋型',
  '鞋头',
  '跟型',
  '包型',
] as const;

export function buildGarmentFeatureView(input: {
  category: string | null;
  colors: GarmentColorInput[];
  attributes: Array<{ name: string; value: string }>;
}): GarmentFeatureView {  const main = input.colors.find((c) => c.isPrimary) ?? input.colors[0] ?? null;
  const keyEntries: Array<{ name: string; text: string }> = [];
  const secondary: string[] = [];

  for (const attribute of input.attributes) {
    const text = `${attribute.name}=${attribute.value}`;
    const order = KEY_FEATURE_ORDER.indexOf(attribute.name as (typeof KEY_FEATURE_ORDER)[number]);
    if (order >= 0) keyEntries.push({ name: attribute.name, text });
    else secondary.push(text);
  }
  // 按还原重要性排序（稳定：同名保持原顺序）
  keyEntries.sort((a, b) => {
    const indexA = KEY_FEATURE_ORDER.indexOf(a.name as (typeof KEY_FEATURE_ORDER)[number]);
    const indexB = KEY_FEATURE_ORDER.indexOf(b.name as (typeof KEY_FEATURE_ORDER)[number]);
    return indexA - indexB;
  });

  return {
    category: input.category,
    mainColor: main ? { name: main.name, hex: main.hex } : null,
    accentColorNames: input.colors.filter((c) => c !== main).map((c) => c.name),
    keyFeatures: keyEntries.map((entry) => entry.text),
    secondary,
  };
}

/** 特征视图 → 单行文字（推荐档案/约束快照共用）：身份层在前、次要层在后，空段省略 */
export function featureViewToLine(view: GarmentFeatureView, options: { includeHex?: boolean; includeSecondary?: boolean } = {}): string {
  const parts: string[] = [];
  if (view.category) parts.push(`品类=${view.category}`);
  if (view.mainColor) {
    parts.push(
      options.includeHex
        ? `主色=${view.mainColor.name}(${view.mainColor.hex})`
        : `主色=${view.mainColor.name}`,
    );
  }
  if (view.accentColorNames.length) parts.push(`配色=${view.accentColorNames.join('/')}`);
  if (view.keyFeatures.length) parts.push(view.keyFeatures.join('，'));
  if (options.includeSecondary !== false && view.secondary.length) parts.push(`细节：${view.secondary.join('，')}`);
  return parts.join('；');
}

/** B2 预算压缩辅助（评估 §8.8）：按关键特征清单把属性拆成关键/次要两层——
 * 推荐档案超字符预算时先去次要层（不丢单品身份），锁定单品与关键特征始终保留。 */
export function splitAttributesByImportance(
  attributes: Array<{ name: string; value: string }>,
): { key: Array<{ name: string; value: string }>; secondary: Array<{ name: string; value: string }> } {
  const key = attributes.filter((a) =>
    (KEY_FEATURE_ORDER as readonly string[]).includes(a.name),
  );
  const secondary = attributes.filter(
    (a) => !(KEY_FEATURE_ORDER as readonly string[]).includes(a.name),
  );
  return { key, secondary };
}
