// M3 搭配会话：选基础单品 → 组合（槽位）→ 锁定/替换/穿法/撤销 → 保存为方案。
// 组合为手动构建（无 AI 推荐，不宣称智能）；缺口按品类显式表达（衣橱文档 §3.1.1：
// "已录入衣橱中暂未找到"，不推断用户未拥有）。撤销栈为会话内存态；保存走契约校验 + planRepository。

import { useSyncExternalStore } from 'react';
import type { SceneSnapshot, WearStyle } from '@ownfit/contract';
import { type ItemCategory } from '../data/demo';
import { getItem, listItemIdsByStatus } from '../data/repositories/itemRepository';

// 品类 → 组合槽位。连衣裙与"上衣+下装"互斥；包/配饰不进入默认组合。
export type OutfitSlot = 'top' | 'dress' | 'bottom' | 'shoes';

export function slotForCategory(category: ItemCategory): OutfitSlot | null {
  switch (category) {
    case '上衣':
    case '外套':
      return 'top';
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

/** 必需槽位的组合方案（连衣裙替代上衣+下装；鞋恒必需） */
export const REQUIRED_SLOTS: OutfitSlot[][] = [
  ['dress', 'shoes'],
  ['top', 'bottom', 'shoes'],
];

export const slotLabels: Record<OutfitSlot, string> = {
  top: '上衣',
  dress: '连衣裙',
  bottom: '下装',
  shoes: '鞋子',
};

export interface OutfitSnapshot {
  basisId: string | null;
  slots: Partial<Record<OutfitSlot, string>>;
  locks: string[];
  wear: WearStyle;
}

export interface OutfitSessionState {
  active: boolean;
  basisId: string | null;
  slots: Partial<Record<OutfitSlot, string>>;
  locks: string[];
  wear: WearStyle;
  parentPlanId: string | null;
  parentLabel: string | null;
  parentItemIds: string[];
}

interface SessionState extends OutfitSessionState {
  history: OutfitSnapshot[];
}

let state: SessionState = {
  active: false,
  basisId: null,
  slots: {},
  locks: [],
  wear: '自然垂放',
  parentPlanId: null,
  parentLabel: null,
  parentItemIds: [],
  history: [],
};

const listeners = new Set<() => void>();

function set(change: Partial<SessionState>) {
  state = { ...state, ...change };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOutfitSession(): OutfitSessionState {
  return useSyncExternalStore(subscribe, () => state);
}

export function getOutfitSession(): OutfitSessionState {
  return state;
}

const snapshot = (): OutfitSnapshot => ({
  basisId: state.basisId,
  slots: { ...state.slots },
  locks: [...state.locks],
  wear: state.wear,
});

/** 修改入撤销栈 */
function withHistory(change: Partial<SessionState>) {
  const history = [...state.history, snapshot()].slice(-20);
  set({ ...change, history });
}

export function outfitHistoryLength(): number {
  return state.history.length;
}

export function outfitUndo(): boolean {
  const prev = state.history.pop();
  if (!prev) return false;
  set({ basisId: prev.basisId, slots: prev.slots, locks: prev.locks, wear: prev.wear });
  return true;
}

export function toggleLock(itemId: string) {
  set({
    locks: state.locks.includes(itemId)
      ? state.locks.filter((id) => id !== itemId)
      : [...state.locks, itemId],
  });
}

export function isLocked(itemId: string): boolean {
  return state.locks.includes(itemId);
}

/** 槽位替换：只允许替换未锁定槽位（M3 通过条件：只替换未锁定项） */
export function replaceSlot(slot: OutfitSlot, newItemId: string): 'ok' | 'locked' {
  const current = state.slots[slot];
  if (current && state.locks.includes(current)) return 'locked';
  withHistory({
    slots: { ...state.slots, [slot]: newItemId },
    // 基础单品解锁后被替换，新单品承接其角色，避免保存时追加旧单品。
    basisId: current === state.basisId ? newItemId : state.basisId,
  });
  return 'ok';
}

export function setWear(style: WearStyle) {
  withHistory({ wear: style });
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

/**
 * 从选择的基础单品开始搭配（异步：从真实衣橱填充互补槽位）。
 * - basis 落入其品类对应槽位；互补槽位取衣橱中最近入库的同类单品
 * - 缺失槽位留空（构成缺口，outfit 页显式表达）
 * - basis 默认锁定
 */
export async function startOutfitFrom(basisId: string): Promise<boolean> {
  const basis = await getItem(basisId);
  if (!basis?.category || basis.status !== 'active') return false; // 草稿未确认品类时不能作为搭配起点
  const basisSlot = slotForCategory(basis.category);
  if (!basisSlot) return false;

  const activeIds = await listItemIdsByStatus('active');
  const slots: Partial<Record<OutfitSlot, string>> = { [basisSlot]: basisId };
  const taken = new Set([basisId]);

  const required: OutfitSlot[] = basisSlot === 'dress' ? REQUIRED_SLOTS[0] : REQUIRED_SLOTS[1];
  for (const slot of required) {
    if (slots[slot]) continue;
    for (const candidateId of activeIds) {
      if (taken.has(candidateId)) continue;
      const candidate = await getItem(candidateId);
      if (candidate?.category && slotForCategory(candidate.category) === slot) {
        slots[slot] = candidateId;
        taken.add(candidateId);
        break;
      }
    }
  }

  set({
    active: true,
    basisId,
    slots,
    locks: [basisId],
    wear: '自然垂放',
    parentPlanId: null,
    parentLabel: null,
    parentItemIds: [],
    history: [],
  });
  return true;
}

/** 复用已保存方案：载入为当前会话并记录父版本（修改后保存将关联 parent） */
export function loadOutfitFrom(input: {
  planId: string;
  name: string | null;
  basisId: string;
  slots: Partial<Record<OutfitSlot, string>>;
  wear: WearStyle;
  itemIds: string[];
}) {
  state.history = [];
  set({
    active: true,
    basisId: input.basisId,
    slots: { ...input.slots },
    locks: [input.basisId],
    wear: input.wear,
    parentPlanId: input.planId,
    parentLabel: input.name,
    parentItemIds: [...input.itemIds],
  });
}

/** 会话 → 契约 Plan。gaps 表达缺失槽位（真实衣橱暂缺，不虚构完整组合）。 */
export function buildContractPlan(planId: string, scene: SceneSnapshot): import('@ownfit/contract').Plan {
  const missing = missingSlots(state.slots);
  const items: Array<{ itemId: string; role: 'basis' | 'locked' | 'piece' }> = [];
  if (state.basisId) items.push({ itemId: state.basisId, role: 'basis' });
  for (const id of Object.values(state.slots)) {
    if (!id || id === state.basisId) continue;
    items.push({ itemId: id, role: state.locks.includes(id) ? 'locked' : 'piece' });
  }
  return {
    planId,
    parentPlanId: state.parentPlanId,
    version: 1,
    items,
    wear: { slot: '整体', style: state.wear },
    reason: null,
    gaps: missing.map((slot) => ({ kind: 'missing_category' as const, message: slotGapMessage(slot) })),
    scene: { ...scene },
    source: 'manual',
    createdAt: new Date().toISOString(),
  };
}
