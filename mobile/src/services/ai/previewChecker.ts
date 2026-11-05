// C8 生成后视觉核对（2026-11-04）：把本次生成图与"单品原图 + 人物参考 + 约束快照"对照，
// 逐项记录 匹配/偏离/无法判断。生成器不支持衣物图不妨碍核对器读图（能力分别路由）。
// 边界（功能文档 AI上身预览 §5）：
// - 只检查可见且影响选择的特征：漏件/多件、颜色或图案改变、领袖/轮廓明显错误、穿法/层次不符、
//   明显人物外观或比例变化；
// - 遮挡部位、缺失原始证据、核对超时/失败一律 unknown，不能当通过；
// - 不能只让文本模型自称遵守提示词，也不能只用同一份可能错误的文字当核对真值——
//   核对依据是单品原图与人物参考，不是提示词本身；
// - 核对器自身也可能误判，规则版本化（PREVIEW_CHECK_RULE_VERSION），需人工样本校准。

import { parseRecommendationContent } from './recommendationService';
import type { PreviewItemVerdict, PreviewItemVerdictStatus, PreviewCheckOverall } from '../../data/repositories/previewCheckRepository';

/** 提交给核对器的约束快照：与生成提示词同源（A2 特征视图），每件含身份与关键特征。
 * §8.4.5（2026-11-04）：逐件有效穿法进入核对约束；imageIndex=该件实际附图的序号
 * （null=该件缺原图，明确标注，不通过 filter 改变图与清单的对应关系）。 */
export interface CheckerConstraintItem {
  itemId: string;
  name: string;
  category: string;
  mainColor: { name: string; hex: string } | null;
  keyFeatures: string[];
  /** 该件的有效穿法（缺省=自然垂放） */
  wearStyle?: string | null;
  /** 该件原图在本次核对消息里的图序号（1 起）；null=未附原图 */
  imageIndex?: number | null;
}

export interface CheckerVerdict {
  overall: PreviewCheckOverall;
  verdicts: PreviewItemVerdict[];
}

const STATUS_VALUES: PreviewItemVerdictStatus[] = ['match', 'deviate', 'unknown'];
const OVERALL_VALUES: PreviewCheckOverall[] = ['match', 'minor', 'major'];

export function checkerSystemPrompt(): string {
  return [
    '你是穿搭生成结果的核对器。你会按顺序收到多张图：',
    '先是本次方案各单品的原始照片（数量与顺序见约束清单的图号标注，个别单品可能缺图），',
    '然后是用户本人的人物参考照，最后一张是 AI 生成的上身预览结果。',
    '任务：对照单品原图、人物参考与约束清单，只检查生成结果里可见且影响选择的特征：',
    '- 漏件/多件（清单里的每件衣物是否都出现在结果中，有没有多余衣物）',
    '- 颜色或图案明显改变',
    '- 领型/袖型/长度/开合等关键特征明显错误',
    '- 穿法/层次不符（如外套没有敞开、下摆没有塞入；逐件穿法以清单标注为准）',
    '- 人物脸部/体型与参考照明显不符',
    '输出紧凑 JSON，不要解释文字、不要代码围栏。结构：',
    '{"items":[{"itemId":"约束里的单品ID","status":"match|deviate|unknown","note":"一句话（可选）"}],"overall":"match|minor|major"}',
    '判定规则：',
    '- 每个itemId都给一条判定；看不清/被遮挡/该件缺原图/证据不足时用 unknown，不要猜。',
    '- overall：match=关键特征都符合；minor=有差异但不影响选衣判断；major=漏件/整件被换成别的衣服/主要颜色或图案错误/人物明显变化。',
    '- 单品原图中没有的特征（如侧面内部结构）不作为判定依据。',
  ].join('\n');
}

export function checkerUserPrompt(input: { items: CheckerConstraintItem[]; wearStyle: string }): string {
  const lines = input.items.map((item) => {
    const image = typeof item.imageIndex === 'number' ? `图${item.imageIndex}` : '（本次未附原图，只能按 unknown 处理）';
    const parts = [`${image}=单品「${item.name}」（id=${item.itemId}）`, `品类=${item.category}`];
    if (item.mainColor) parts.push(`主色=${item.mainColor.name}(${item.mainColor.hex})`);
    if (item.keyFeatures.length) parts.push(item.keyFeatures.join('，'));
    if (item.wearStyle && item.wearStyle !== '自然垂放') parts.push(`穿法=${item.wearStyle}`);
    return parts.join('；');
  });
  const wear = input.wearStyle && input.wearStyle !== '自然垂放' ? `预期主穿法：${input.wearStyle}（逐件穿法以清单为准）。` : '';
  const attached = input.items.filter((item) => typeof item.imageIndex === 'number').length;
  return [
    '约束清单（与生成时使用的一致）：',
    ...lines,
    wear,
    `附图共 ${attached} 张单品原图（清单中标注了对应图号）+ 人物参考照 + AI 生成结果。`,
    `请按 system 要求的 JSON 结构输出 ${input.items.length} 条单品判定与 overall；未附原图的单品给 unknown。`,
  ].join('\n');
}

/** 手写校验解析核对结果：结构/取值非法即失败（不猜、不补默认判定） */
export function parseCheckerVerdict(value: unknown, expectedItemIds: string[]): { ok: true; value: CheckerVerdict } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '核对结果不是 JSON 对象' };
  }
  const raw = value as { items?: unknown; overall?: unknown };
  if (!Array.isArray(raw.items)) return { ok: false, error: '核对结果缺少 items' };
  const expected = new Set(expectedItemIds);
  const verdicts: PreviewItemVerdict[] = [];
  const seen = new Set<string>();
  for (const item of raw.items) {
    const v = item as { itemId?: unknown; status?: unknown; note?: unknown };
    if (typeof v.itemId !== 'string' || !expected.has(v.itemId)) {
      return { ok: false, error: `核对结果引用了未知单品：${String(v.itemId).slice(0, 40)}` };
    }
    if (seen.has(v.itemId)) return { ok: false, error: `单品重复判定：${v.itemId}` };
    if (typeof v.status !== 'string' || !STATUS_VALUES.includes(v.status as PreviewItemVerdictStatus)) {
      return { ok: false, error: `判定状态非法：${String(v.status).slice(0, 20)}` };
    }
    seen.add(v.itemId);
    verdicts.push({
      itemId: v.itemId,
      status: v.status as PreviewItemVerdictStatus,
      ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note.trim().slice(0, 120) } : null),
    });
  }
  // 清单里的每件单品都必须有判定；缺判定按 unknown 处理（不当通过）
  for (const itemId of expectedItemIds) {
    if (!seen.has(itemId)) verdicts.push({ itemId, status: 'unknown', note: '核对结果缺少该单品的判定' });
  }
  if (typeof raw.overall !== 'string' || !OVERALL_VALUES.includes(raw.overall as PreviewCheckOverall)) {
    return { ok: false, error: `overall 非法：${String(raw.overall).slice(0, 20)}` };
  }
  let overall = raw.overall as PreviewCheckOverall;
  // 本地一致性防线：存在明确偏离时不得登记为 match
  if (overall === 'match' && verdicts.some((v) => v.status === 'deviate')) overall = 'minor';
  return { ok: true, value: { overall, verdicts } };
}

/** 复用推荐结果的严格解析规则（整体 JSON / 剥 think / 单个围栏）后做结构校验 */
export function parseCheckerContent(
  content: string,
  expectedItemIds: string[],
): { ok: true; value: CheckerVerdict } | { ok: false; error: string } {
  const parsed = parseRecommendationContent(content);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return parseCheckerVerdict(parsed.value, expectedItemIds);
}

/** 从偏离判定推导纠偏约束（C8 有界纠偏）：只用快照里已有的证据重申，不发明新特征 */
export function buildCorrections(
  verdicts: PreviewItemVerdict[],
  items: CheckerConstraintItem[],
): string[] {
  const byId = new Map(items.map((item) => [item.itemId, item]));
  const corrections: string[] = [];
  for (const verdict of verdicts) {
    if (verdict.status !== 'deviate') continue;
    const item = byId.get(verdict.itemId);
    if (!item) continue;
    const identity = [
      `${item.category}（${item.name}）`,
      item.mainColor ? `主色 ${item.mainColor.name}` : '',
      item.keyFeatures.join('，'),
    ]
      .filter(Boolean)
      .join('：');
    corrections.push(`「${identity}」在上一张结果中被改变或遗漏（核对意见：${verdict.note ?? '明显偏离'}），必须严格按原图与上述特征还原`);
  }
  return corrections;
}
