// A-上身预览 prompt：由 A-衣物理解的结构化输出生成服装描述。
// MiniMax 参考图只支持人物肖像，服装只能靠 prompt 文字传达（≤1500 字符）——
// 因此"结构化字段 → 描述"的一致性损失正是 A 线要量化的边界。

import type { GarmentUnderstanding } from '../garment-understanding/schema';

export function describeGarment(u: GarmentUnderstanding): string {
  const parts: string[] = [];
  const colors = u.colors.map((c) => c.name).join('和');
  parts.push(`${colors}的${u.category}`);

  if (u.pattern !== '未知' && u.pattern !== '纯色') parts.push(`图案为${u.pattern}`);
  if (u.neckline !== '未知') parts.push(`${u.neckline}`);
  if (u.sleeve !== '未知') parts.push(`${u.sleeve}`);
  if (u.fit !== '未知') parts.push(`版型${u.fit}`);
  if (u.description) parts.push(`（${u.description}）`);

  return parts.join('，');
}

export function tryOnPrompt(u: GarmentUnderstanding): string {
  const garment = describeGarment(u);
  return (
    `让图中的人物换上这件服装：${garment}。` +
    '保持人物的脸部、发型、肤色、体型和姿势完全不变，' +
    '服装的颜色、图案、领口、袖型和长度严格符合上述描述，' +
    '生成自然的日常穿搭效果，真实感照片风格。'
  );
}
