// 搭配领域规则（2026-11-13 结构收敛：纯规则自 features/outfitSession.ts 移入 domain）。
// 本文件只含无副用的纯函数、常量与类型：不依赖 react、repository 或全局会话状态；
// 会话状态与操作（撤销栈、订阅、锁定开关等）仍在 features/outfitSession.ts，
// 该处按状态胶水组合本文件的规则。UI、保存、生成与核对统一消费这里的结果。

import type { Plan, SceneSnapshot, WearStyle } from '@ownfit/contract';
import { type ItemCategory } from './categories';

// 品类 → 组合槽位。连衣裙与"上衣+下装"互斥；外套独立槽位；包/配饰不进入默认组合。
export type OutfitSlot = 'top' | 'dress' | 'bottom' | 'shoes' | 'outer';

export function slotForCategory(category: ItemCategory): OutfitSlot | null {
  switch (category) {
    case '上衣':
      return 'top';
    case '外套':
      return 'outer';
    case '连衣裙':
      return 'dress';
    case '下装':
      return 'bottom';
    case '鞋履':
      return 'shoes';
    default:
      return null; // 包/配饰：不进入默认组合
  }
}

/** 必需槽位的组合方案（连衣裙替代上衣+下装；鞋恒必需；外套可选层） */
export const REQUIRED_SLOTS: OutfitSlot[][] = [
  ['dress', 'shoes'],
  ['top', 'bottom', 'shoes'],
];

export const slotLabels: Record<OutfitSlot, string> = {
  top: '上衣',
  dress: '连衣裙',
  bottom: '下装',
  shoes: '鞋子',
  outer: '外套',
};

export interface OutfitSnapshot {
  basisId: string | null;
  slots: Partial<Record<OutfitSlot, string>>;
  locks: string[];
  wear: WearStyle;
  /** 逐件穿法（C4，契约 v1.1.0）：外套敞开与内搭前塞可同时表达；缺省槽位按顶层 wear */
  slotWear: Partial<Record<OutfitSlot, WearStyle>>;
  reasonStale: boolean;
}

export interface OutfitSessionState {
  active: boolean;
  basisId: string | null;
  slots: Partial<Record<OutfitSlot, string>>;
  locks: string[];
  wear: WearStyle;
  /** 逐件穿法（C4）：按槽位覆盖顶层 wear；无外套时与顶层一致 */
  slotWear: Partial<Record<OutfitSlot, WearStyle>>;
  /** 选配色软提示（评估 §8.8，2026-11-04）：来自颜色库的本次挑选，仅会话内参考，
   * 不参与撤销栈、不发送给 AI、不设为长期偏好；新会话开始时清空 */
  colorHints: string[];
  parentPlanId: string | null;
  parentLabel: string | null;
  parentItemIds: string[];
  /** 会话来源：手动构建='manual'；AI 推荐采用='ai'（契约 Plan.source 同值） */
  source: 'manual' | 'ai';
  /** AI 推荐理由（source='ai' 时来自候选 reason；无则 null，不编造） */
  reason: string | null;
  /** AI 理由是否已失效（组合被替换后标 true；保存时如实标注为原始理由） */
  reasonStale: boolean;
}

/**
 * 有效逐件穿法（评估 §8.3.1，单一出处）：内搭/连衣裙取本件覆盖或主穿法；
 * 外套取本件设置或自然垂放（省略"自然垂放"不再与全局穿法产生歧义）；
 * 鞋履不继承塞衣角等不适用穿法。UI、保存、生成、核对都消费这一份结果。
 */
export function effectiveSlotWear(slot: OutfitSlot, override: WearStyle | undefined, mainWear: WearStyle): WearStyle {
  if (slot === 'shoes') return '自然垂放';
  if (slot === 'outer') return override ?? '自然垂放';
  return override ?? mainWear;
}

/** 缺失的必需槽位（组合完整性检查；缺口显式表达，不虚构完整组合） */
export function missingSlots(slots: Partial<Record<OutfitSlot, string>>): OutfitSlot[] {
  let best: OutfitSlot[] = REQUIRED_SLOTS[0];
  let bestMissing = REQUIRED_SLOTS.length + 1;
  for (const combo of REQUIRED_SLOTS) {
    const missing = combo.filter((slot) => !slots[slot]);
    if (missing.length < bestMissing) {
      best = missing;
      bestMissing = missing.length;
    }
  }
  return best;
}

export function slotGapMessage(slot: OutfitSlot): string {
  return `已录入衣橱中暂未找到${slotLabels[slot]}。这不代表你没有，可以再添加一件。`;
}

/** 会话状态 → 契约 Plan（纯函数：调用方传入会话状态；features/outfitSession 提供读全局态的薄包装）。
 * gaps 表达缺失槽位（真实衣橱暂缺，不虚构完整组合）。
 * AI 理由在组合被修改后（reasonStale）保存时如实标注为原始理由，不冒充当前组合的推荐依据（R9）。 */
export function buildOutfitPlan(state: OutfitSessionState, planId: string, scene: SceneSnapshot): Plan {
  const missing = missingSlots(state.slots);
  const items: Array<{ itemId: string; role: 'basis' | 'locked' | 'piece'; wearStyle?: WearStyle }> = [];
  if (state.basisId) {
    const basisSlot = (Object.entries(state.slots) as [OutfitSlot, string][]).find(
      ([, id]) => id === state.basisId,
    )?.[0];
    const basisWear = basisSlot ? state.slotWear[basisSlot] : undefined;
    items.push({ itemId: state.basisId, role: 'basis', ...(basisWear ? { wearStyle: basisWear } : null) });
  }
  for (const [slot, id] of Object.entries(state.slots) as [OutfitSlot, string][]) {
    if (!id || id === state.basisId) continue;
    const slotWear = state.slotWear[slot];
    items.push({
      itemId: id,
      role: state.locks.includes(id) ? 'locked' : 'piece',
      // C4：逐件穿法只在有显式设置时输出（缺省按顶层 wear，不重复存储）
      ...(slotWear ? { wearStyle: slotWear } : null),
    });
  }
  const reason = state.reasonStale && state.reason ? `（搭配已修改，以下为原始推荐理由）${state.reason}` : state.reason;
  return {
    planId,
    parentPlanId: state.parentPlanId,
    version: 1,
    items,
    wear: { slot: '整体', style: state.wear },
    reason,
    gaps: missing.map((slot) => ({ kind: 'missing_category' as const, message: slotGapMessage(slot) })),
    scene: { ...scene },
    source: state.source,
    createdAt: new Date().toISOString(),
  };
}
