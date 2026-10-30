// A-搭配推荐提示词：把衣物档案交给文本模型，请它给出候选组合与资料缺口。
// 红线与衣物理解一致：不猜尺寸/面料/品牌/尺码/合身/保暖；资料不足时显式说明缺口。

export interface ProfileItem {
  id: string;
  name: string | null;
  category: string | null;
  attributes: Array<{ name: string; value: string }>;
  colors: Array<{ name: string; hex: string }>;
  measurements: Array<{ name: string; amount: string; unit: string }>;
}

export const recommendationSystemPrompt = `你是个人穿搭助理。根据用户的真实衣物档案，给出可执行的穿搭候选组合。

规则：
1. 只使用档案里出现过的单品 ID，绝不虚构不存在的衣物或新的属性。
2. 组合要覆盖合理槽位（上衣/下装/连衣裙其一 + 鞋履；外套、包、配饰按需）。
3. 数据不足时不要凑数：把缺的槽位写进 gaps（例如"没有鞋履可搭"），不要用不存在的单品填补。
4. wearStyle 只能是：自然垂放、前侧塞衣角、外层敞开穿。
5. reason 用一句话说明搭配思路（风格/场合/颜色协调），不要下合身、保暖、显瘦等结论——
   单凭照片与档案无法判断这些。
6. 输出紧凑 JSON，不要解释文字、不要代码围栏。结构：
{"candidates":[{"slots":[{"role":"top","itemId":"item-xxx","note":"可选说明"}],"wearStyle":"自然垂放","reason":"可选一句话"}],"gaps":["缺口说明"],"summary":"可选总述"}`;

export function buildProfileText(items: ProfileItem[]): string {
  if (items.length === 0) return '（档案为空）';
  return items
    .map((item) => {
      const attrs = item.attributes.map((a) => `${a.name}:${a.value}`).join('，');
      const colors = item.colors.map((c) => c.name).join('/');
      const measures = item.measurements.map((m) => `${m.name}${m.amount}${m.unit}`).join('，');
      return [
        `- id=${item.id}`,
        `品类=${item.category ?? '未知'}`,
        `名称=${item.name ?? '未命名'}`,
        colors ? `颜色=${colors}` : '',
        attrs ? `属性=${attrs}` : '',
        measures ? `实测=${measures}` : '',
      ]
        .filter(Boolean)
        .join('；');
    })
    .join('\n');
}

export function recommendationUserPrompt(input: {
  items: ProfileItem[];
  scene: { city: string; day: string; scene: string; temperatureC?: number; weather?: string };
}): string {
  const sceneLine = [
    `城市=${input.scene.city}`,
    `日期=${input.scene.day}`,
    `场合=${input.scene.scene}`,
    input.scene.temperatureC !== undefined ? `气温=${input.scene.temperatureC}℃` : '',
    input.scene.weather ? `天气=${input.scene.weather}` : '',
  ]
    .filter(Boolean)
    .join('，');
  return `我的衣物档案：\n${buildProfileText(input.items)}\n\n今天的情境：${sceneLine}\n\n请按 system 要求的 JSON 结构给出 2-3 个候选组合。`;
}
