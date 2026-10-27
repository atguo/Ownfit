// A-上身预览：输入组织方式定义（按 docs/functions/AI上身预览.md §4.2）。
// 实验要对比两种组织方式在人物/单品一致性上的表现：
//   A. 独立图：人物参考 + 每件单品各一张，多轮消息传入
//   B. 拼图+编号：选定套装拼成一张带编号的图 + 关键细节图，单轮传入
// 本文件先固化输入结构；生成服务适配器按 PROVIDERS.md 选型后逐家实现。

export interface PersonReference {
  /** 相对路径，如 samples/person/front-full.jpg */
  imageRef: string;
  /** 视角：正面全身/侧面全身/半身 */
  pose: '正面全身' | '侧面全身' | '半身';
}

export interface GarmentInput {
  /** 单品编号：拼图与记录中的稳定映射键 */
  slot: string; // 如 "A1"
  imageRef: string;
  /** 该单品的结构化档案引用（可来自 A-衣物理解的记录） */
  understandingRef?: string;
}

export interface TryOnInputPlanA {
  mode: 'independent';
  person: PersonReference;
  garments: GarmentInput[];
}

export interface TryOnCombiner {
  mode: 'collage';
  /** 拼图成品（带编号标注）的相对路径 */
  collageRef: string;
  /** 编号映射：编号 → 单品，保留原图引用（文档要求拼图不替代原图留存） */
  slots: GarmentInput[];
  person: PersonReference;
}

export type TryOnInput = TryOnInputPlanA | TryOnCombiner;

export function describeInput(input: TryOnInput): string {
  if (input.mode === 'independent') {
    const garments = input.garments.map((g) => `${g.slot}=${g.imageRef}`).join('，');
    return `独立图：人物 ${input.person.imageRef}（${input.person.pose}）；单品 ${garments}`;
  }
  const slots = input.slots.map((g) => `${g.slot}=${g.imageRef}`).join('，');
  return `拼图：${input.collageRef}；映射 ${slots}；人物 ${input.person.imageRef}`;
}
