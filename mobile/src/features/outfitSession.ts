// M3 搭配会话：选基础单品 → 组合（槽位）→ 锁定/替换/穿法/撤销 → 保存为方案。
// 会话来源两种：手动构建（choose 页起步）与 AI 推荐采用（M5 轨 B4，RecommendationSheet）；
// 来源与 AI 理由随会话保存进契约 Plan（source/reason），不冒充手动。缺口按品类显式表达
// （衣橱文档 §3.1.1："已录入衣橱中暂未找到"，不推断用户未拥有）。
// 撤销栈为会话内存态；保存走契约校验 + planRepository。
// 2026-11-04（B3/R2）：外套为独立槽位 outer，与上衣/下装共存（≤2 层：内搭可加外套）；
// 槽位映射不再把外套并进上衣导致采用时丢件。会话新增 reasonStale：AI 理由在组合被
// 修改后标记"原始理由"，保存时如实标注，不冒充当前组合的推荐理由（R9/D2）。
// 2026-11-13 结构收敛：槽位/缺口/有效穿法/契约构造等纯规则移入 domain/outfitRules.ts，
// 本文件只保留会话状态、撤销栈与订阅胶水（react + repository 组合）。

import { useSyncExternalStore } from 'react';
import type { SceneSnapshot, WearStyle } from '@ownfit/contract';
import {
  buildOutfitPlan,
  type OutfitSessionState,
  type OutfitSlot,
  type OutfitSnapshot,
  slotForCategory,
  REQUIRED_SLOTS,
} from '../domain/outfitRules';
import { getItem, listItemIdsByStatus } from '../data/repositories/itemRepository';

interface SessionState extends OutfitSessionState {
  history: OutfitSnapshot[];
}

let state: SessionState = {
  active: false,
  basisId: null,
  slots: {},
  locks: [],
  wear: '自然垂放',
  slotWear: {},
  colorHints: [],
  parentPlanId: null,
  parentLabel: null,
  parentItemIds: [],
  source: 'manual',
  reason: null,
  reasonStale: false,
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
  slotWear: { ...state.slotWear },
  reasonStale: state.reasonStale,
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
  set({ basisId: prev.basisId, slots: prev.slots, locks: prev.locks, wear: prev.wear, slotWear: prev.slotWear, reasonStale: prev.reasonStale });
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

/** 槽位替换：只允许替换未锁定槽位（M3 通过条件：只替换未锁定项）。
 * AI 来源会话中换件后，原推荐理由不再描述当前组合 → reasonStale（R9）。 */
export function replaceSlot(slot: OutfitSlot, newItemId: string): 'ok' | 'locked' {
  const current = state.slots[slot];
  if (current && state.locks.includes(current)) return 'locked';
  const changed = current !== newItemId;
  withHistory({
    slots: { ...state.slots, [slot]: newItemId },
    // 基础单品解锁后被替换，新单品承接其角色，避免保存时追加旧单品。
    basisId: current === state.basisId ? newItemId : state.basisId,
    ...(changed && state.source === 'ai' && state.reason ? { reasonStale: true } : null),
  });
  return 'ok';
}

export function setWear(style: WearStyle) {
  withHistory({ wear: style });
}

/** 逐件穿法（C4）：按槽位设置；顶层 wear 语义为"主穿法"（内搭/连衣裙），
 * 外套槽位的穿法单独记录（外层敞开穿可与内搭前塞同时表达）。 */
export function setSlotWear(slot: OutfitSlot, style: WearStyle) {
  withHistory({
    slotWear: { ...state.slotWear, [slot]: style },
    // 顶层 wear 始终表示主穿法（内搭/连衣裙；非外套槽位）——保持契约 wear 必填字段的语义稳定
    ...(slot !== 'outer' ? { wear: style } : null),
  });
}

/** 选配色软提示（会话内参考；不参与撤销、不发送给 AI、新会话清空） */
export function setColorHints(colors: string[]) {
  set({ colorHints: [...new Set(colors)].slice(0, 8) });
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
    slotWear: {},
    colorHints: [], // 新会话清空选配色软提示
    parentPlanId: null,
    parentLabel: null,
    parentItemIds: [],
    source: 'manual',
    reason: null,
    reasonStale: false,
    history: [],
  });
  return true;
}

/**
 * 载入既有内容为当前会话：复用已保存方案（记录父版本）或 AI 推荐采用
 * （origin.source='ai' 并携带理由；修改后保存保留来源，不冒充手动）。
 * locks：采用的锁定集合（R3：采用保留原锁定，不再只锁 basis）；
 * 复用已保存方案时传方案内 basis/locked 角色，保持原方案含义（D2）。
 */
export function loadOutfitFrom(input: {
  planId: string;
  name: string | null;
  basisId: string;
  slots: Partial<Record<OutfitSlot, string>>;
  wear: WearStyle;
  /** 逐件穿法（C4：来自方案 per-item wearStyle；缺省空） */
  slotWear?: Partial<Record<OutfitSlot, WearStyle>>;
  itemIds: string[];
  origin?: { source: 'manual' | 'ai'; reason: string | null };
  locks?: string[];
}) {
  state.history = [];
  set({
    active: true,
    basisId: input.basisId,
    slots: { ...input.slots },
    locks: input.locks?.length ? [...new Set([input.basisId, ...input.locks])] : [input.basisId],
    wear: input.wear,
    slotWear: input.slotWear ? { ...input.slotWear } : {},
    colorHints: [], // 新会话清空选配色软提示
    parentPlanId: input.planId,
    parentLabel: input.name,
    parentItemIds: [...input.itemIds],
    source: input.origin?.source ?? 'manual',
    reason: input.origin?.reason ?? null,
    reasonStale: false,
  });
}

/** 会话 → 契约 Plan（读当前会话状态的薄包装；构造规则见 domain/outfitRules.buildOutfitPlan）。 */
export function buildContractPlan(planId: string, scene: SceneSnapshot): import('@ownfit/contract').Plan {
  return buildOutfitPlan(state, planId, scene);
}
