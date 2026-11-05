// 规范化 JSON 序列化（评估 §8.2.3/§8.3.3）：对象按键排序、数组保序、undefined 剔除。
// 输入指纹与"同输入"判定共用：内容相同但键序/临时数组顺序不同的输入得到同一字符串。
// 独立模块供推荐（recommendationInput）与预览（previewRepository）共同消费。

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
