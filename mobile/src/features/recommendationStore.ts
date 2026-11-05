// 搭配推荐会话状态（M5 轨 B4）：执行器单例、变化通知、档案读取、入队。
// S1（2026-11-04，评估 §8.2）：入队即生成 RecommendationInputV2 快照——实际发送档案、
// 每件 realId/alias/revision、锁定真实 ID、场景具体日期、偏好/要求、基线与允许变化槽位
// 全部持久化（tasks.input_json）；执行与采用只依据快照复核，不按当前衣橱重建映射
// （修复旧 R4 别名漂移：等待中的请求不再锁错衣物）。
// B2 输入预算：档案超上限时锁定优先、其余按创建顺序截取，提示词如实注明。

import { getConfig, getApiKey } from '../services/ai/configStore';
import { resolveTextConfig, type ConfigResolution } from '../services/ai/visionConfig';
import { createRecommendationTaskRunner, type RecommendationRunner } from '../services/ai/recommendationTaskRunner';
import {
  RECOMMENDATION_CONTRACT_VERSION,
  RECOMMENDATION_PROMPT_VERSION,
  RECOMMENDATION_PROMPT_BUDGET,
  categoryToSlotRole,
  profileLines,
  type ProfileItem,
} from '../services/ai/recommendationService';
import { splitAttributesByImportance } from '../services/ai/garmentView';
import {
  buildRecommendationInputKeyV2,
  localTargetDate,
  parseRecommendationInputV2,
  RECOMMENDATION_INPUT_VERSION,
  type RecommendationBaseline,
  type RecommendationInputV2,
} from '../services/ai/recommendationInput';
import { callRevisionOf } from '../services/ai/types';
import { getItem } from '../data/repositories/itemRepository';
import { getAnalysisView } from '../data/repositories/attributeRepository';
import {
  commitRecommendationResult,
  createRecommendationTask,
  getRecommendationTask,
  listRecommendationTasksByStatus,
  RECOMMENDATION_TASK_KIND,
  updateRecommendationTaskStatus,
} from '../data/repositories/recommendationRepository';
import { getBodyProfile, getSceneDefault, getPreferences } from '../data/repositories/settingsRepository';
import { getDefaultConfigId, setDefaultConfigId } from '../data/repositories/taskRepository';
import { getContextSnapshot } from './demoStore';
import { getDb } from '../data/db';

export type RecommendationChangeListener = () => void;
const listeners = new Set<RecommendationChangeListener>();

export function subscribeRecommendationChanges(listener: RecommendationChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyRecommendationChanged(): void {
  for (const listener of [...listeners]) listener();
}

/** B2 输入预算（决策 D-12 + §8.8 修订）：档案超过上限时只送入一部分——
 * 锁定必进 → 各组合槽位保底配额（避免前 40 件都是上衣，鞋/外套晚入库也有机会）→
 * 其余按创建顺序；提示词如实注明，不静默丢弃；别名编号保持全柜口径（截取不重排）。 */
export const RECOMMENDATION_PROFILE_CAP = 40;

/** B2 槽位保底配额：每个组合相关槽位至少送入这么多件（按创建顺序） */
export const RECOMMENDATION_SLOT_QUOTA = 6;

/** B2 件数选择（§8.8）：锁定优先 → 槽位保底 → 创建顺序兜底 */
function selectSlotAware(
  items: ProfileItem[],
  lockedSet: Set<string>,
  realIdOf: (alias: string) => string,
): ProfileItem[] {
  if (items.length <= RECOMMENDATION_PROFILE_CAP) return items;
  const chosen: ProfileItem[] = [];
  const chosenIds = new Set<string>();
  const take = (item: ProfileItem) => {
    const realId = realIdOf(item.id);
    if (chosenIds.has(realId)) return;
    chosen.push(item);
    chosenIds.add(realId);
  };
  for (const item of items) {
    if (lockedSet.has(realIdOf(item.id))) take(item);
  }
  const slotItems = new Map<string, ProfileItem[]>();
  for (const item of items) {
    const slot = categoryToSlotRole(item.category);
    if (!slot) continue;
    const list = slotItems.get(slot) ?? [];
    list.push(item);
    slotItems.set(slot, list);
  }
  for (const list of slotItems.values()) {
    for (const item of list.slice(0, RECOMMENDATION_SLOT_QUOTA)) take(item);
  }
  for (const item of items) {
    if (chosen.length >= RECOMMENDATION_PROFILE_CAP) break;
    take(item);
  }
  return chosen.slice(0, RECOMMENDATION_PROFILE_CAP);
}

/** B2 字符预算压缩（§8.8）：超预算先去掉非锁定单品的次要描述层（"细节"类属性），
 * 锁定单品身份与关键特征始终保留；仍超限返回 overBudget（入队显式拒绝，不静默截断）。
 * 字符预算是本地防御，不宣称精确 token 限制。 */
function compressWithinBudget(
  items: ProfileItem[],
  lockedSet: Set<string>,
  realIdOf: (alias: string) => string,
): { items: ProfileItem[]; compressed: boolean; overBudget: boolean } {
  const over = (list: ProfileItem[]) => profileLines(list).join('\n').length > RECOMMENDATION_PROMPT_BUDGET;
  if (!over(items)) return { items, compressed: false, overBudget: false };
  const compressedItems = items.map((item) => {
    // 锁定单品整行保留（锁定身份不因预算丢失）
    if (lockedSet.has(realIdOf(item.id))) return item;
    const { key } = splitAttributesByImportance(item.attributes);
    return { ...item, attributes: key.map((a) => ({ ...a })) };
  });
  if (over(compressedItems)) {
    return { items: compressedItems, compressed: true, overBudget: true };
  }
  return { items: compressedItems, compressed: true, overBudget: false };
}

async function activeItemIds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM items WHERE status = 'active' ORDER BY created_at ASC",
  );
  return rows.map((row) => row.id);
}

/** 读取已入库单品的结构化档案：别名 item-1..N（按创建顺序）→ 真实 id 映射。
 * A1/S1：属性带取值来源、单品带资料版本（快照与指纹用；人工值在提示词标注）。
 * lockedRealIds：请求锁定的真实单品（超限时优先送入）；
 * full=true：不做截取（入队建别名映射/指纹用，保证锁定映射不因预算丢项）。 */
export async function loadWardrobeProfile(
  options: { lockedRealIds?: string[]; full?: boolean } = {},
): Promise<{
  items: ProfileItem[];
  idByAlias: Map<string, string>;
  truncated: boolean;
  totalCount: number;
  sentCount: number;
}> {
  const allIds = await activeItemIds();
  const lockedSet = new Set(options.lockedRealIds ?? []);
  // 选择送入子集：锁定必进；其余按创建顺序填到上限；别名按全柜编号（不重排）
  const selectedIds =
    options.full || allIds.length <= RECOMMENDATION_PROFILE_CAP
      ? allIds
      : (() => {
          const lockedFirst = allIds.filter((id) => lockedSet.has(id));
          const rest = allIds.filter((id) => !lockedSet.has(id));
          const room = RECOMMENDATION_PROFILE_CAP - lockedFirst.length;
          return [...lockedFirst, ...rest.slice(0, Math.max(0, room))];
        })();
  const items: ProfileItem[] = [];
  const idByAlias = new Map<string, string>();
  for (const realId of selectedIds) {
    const index = allIds.indexOf(realId);
    const [view, item] = await Promise.all([getAnalysisView(realId), getItem(realId)]);
    const alias = `item-${index + 1}`;
    idByAlias.set(alias, realId);
    items.push({
      id: alias,
      // A1：用户实际名称优先于 AI 名称建议（建议稿 B3；AI 建议仅在用户未命名时使用）
      name: item?.name ?? view.suggestedName?.value ?? null,
      category: view.category.value ?? null,
      attributes: view.attributes.map((a) => ({ name: a.name, value: a.value, source: a.source })),
      colors: view.colors.value.map((c) => ({ name: c.name, hex: c.hex, isPrimary: c.isPrimary })),
      revision: item?.revision ?? 0,
    });
  }
  return {
    items,
    idByAlias,
    truncated: !options.full && allIds.length > RECOMMENDATION_PROFILE_CAP,
    totalCount: allIds.length,
    sentCount: selectedIds.length,
  };
}

/**
 * 当次场景快照（M6 批次 1.2）：读首页当次 context（启动时由长期默认播种、
 * SceneSheet 当次修改直接生效），不再只读长期默认。
 * 温度只在来源为实时天气/手动填写时带上——演示温度（tempSource='demo'）不进 AI 输入。
 * B6：实时天气带天气描述（晴/雨/雪等，参与选择）；手动温度无描述不编造。
 * F4（S3 补充）：实时温度必须仍与当前地点/目标日期匹配且未过期才可发送；
 * 过期/错位的实时数据不进推荐（手动值属于当前条件，不受此限）。
 */
export async function loadSceneSnapshot(): Promise<{
  city: string;
  day: string;
  scene: string;
  temp?: string;
  tempSource?: string;
  weatherDesc?: string;
}> {
  const context = getContextSnapshot();
  const prefs = await getPreferences();
  const sceneDefault = await getSceneDefault();
  // 手动值属于当前条件（不受时效限制）；实时值必须与当前地点/目标日期匹配且未过期（F4）
  const includeTemp =
    context.tempSource === 'manual' ||
    (context.tempSource === 'real' && isRealWeatherUsable(context));
  return {
    city: context.city || sceneDefault?.city || '未设置地点',
    day: context.day || sceneDefault?.day || '今天',
    scene: context.scene || sceneDefault?.scene || prefs[0] || '日常通勤',
    ...(includeTemp
      ? { temp: context.temp, tempSource: context.tempSource }
      : null),
    ...(context.tempSource === 'real' && includeTemp && context.weatherDesc
      ? { weatherDesc: context.weatherDesc }
      : null),
  };
}

/** 实时天气是否仍可用于当次推荐（F4）：与当次地点一致、目标日期未跨日、2 小时内获取 */
export function isRealWeatherUsable(context: {
  tempSource?: string;
  city: string;
  day: string;
  weatherFetchedAt?: string;
  weatherTargetDate?: string;
  weatherPlace?: string;
  now?: Date;
}): boolean {
  if (context.tempSource !== 'real' || !context.weatherFetchedAt) return false;
  const now = context.now ?? new Date();
  const fetchedAt = new Date(context.weatherFetchedAt).getTime();
  if (Number.isNaN(fetchedAt)) return false;
  if (now.getTime() - fetchedAt > FRESH_MAX_AGE_MS) return false;
  // 跨日失效：目标日期不是"今天"即过期（不依赖获取时间的本地日历判断，长期前台停留也覆盖）
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (context.weatherTargetDate && context.weatherTargetDate !== today) return false;
  // 地点错位：天气归属地与当次地点不一致即不可用
  if (context.weatherPlace && context.city && context.weatherPlace !== context.city) return false;
  return true;
}

/** 实时天气的新鲜度上限（与 weatherAuto 共用口径）：超过 2 小时视为过期 */
export const FRESH_MAX_AGE_MS = 2 * 60 * 60 * 1000;

let runner: RecommendationRunner | null = null;

export function initRecommendationRunner(): RecommendationRunner {
  if (!runner) {
    runner = createRecommendationTaskRunner({
      listQueued: () => listRecommendationTasksByStatus('queued'),
      listRunning: () => listRecommendationTasksByStatus('running'),
      getTask: getRecommendationTask,
      markRunning: (id) => updateRecommendationTaskStatus(id, ['queued'], 'running'),
      updateStatus: updateRecommendationTaskStatus,
      getConfig,
      getApiKey,
      // S1：执行器不再现读衣橱档案——按入队快照校验各单品可用性与资料版本
      validateSnapshotItems: validateSnapshotItems,
      commitResult: commitRecommendationResult,
      onSettled: notifyRecommendationChanged,
      subscribeChanges: subscribeRecommendationChanges,
    });
  }
  return runner;
}

/** S1 快照校验（执行器发送前调用）：单品仍存在、已入库且资料版本与入队一致。
 * 任何一件不满足即整体拒绝（标 stale 保留原请求），不过滤锁定项后继续。 */
export async function validateSnapshotItems(
  entries: Array<{ realId: string; revision: number }>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  for (const entry of entries) {
    const item = await getItem(entry.realId);
    if (!item || item.status !== 'active') {
      return {
        ok: false,
        message: `「${item?.name ?? entry.realId.slice(0, 20)}」已删除或归档，原请求的衣物已不可用，请重新推荐`,
      };
    }
    if (item.revision !== entry.revision) {
      return {
        ok: false,
        message: `「${item.name ?? entry.realId.slice(0, 20)}」的资料在等待期间被修改（换图/改属性），旧请求不能冒充当前资料，请重新推荐`,
      };
    }
  }
  return { ok: true };
}

/** 解析可用的文本模型（推荐用；读取本地配置与安全存储，不发网络请求） */
export async function resolveTextForRecommendation(): Promise<ConfigResolution> {
  return resolveTextConfig(await getDefaultConfigId(RECOMMENDATION_TASK_KIND));
}

/** 记住推荐默认文本模型（用户在候选中明确选择后调用） */
export async function rememberDefaultRecommendationConfig(configId: string): Promise<void> {
  await setDefaultConfigId(configId, RECOMMENDATION_TASK_KIND);
  notifyRecommendationChanged();
}

export interface EnqueueRecommendationInput {
  scene: { city: string; day: string; scene: string; temp?: string; tempSource?: string; weatherDesc?: string };
  /** 当前搭配会话中已锁定的真实单品 ID（进快照与提示词；不在档案中的忽略） */
  lockedItemIds?: string[];
  /** 当次要求（选填，如"只换鞋""更正式一点"）；仅本次请求有效（B1） */
  note?: string | null;
  /** 已就绪（ready）或用户已选定的文本配置 ID */
  configId: string;
  /** 入队时的组合基线（full 模式供采用复核；replace_slot 必填并配合 targetSlot） */
  baseline?: RecommendationBaseline;
  /** F8 局部替换：目标槽位（会话槽位名）；提供时 mode=replace_slot */
  targetSlot?: 'top' | 'dress' | 'bottom' | 'shoes' | 'outer' | null;
}

export type EnqueueRecommendationResult =
  | { status: 'created'; taskId: string }
  | { status: 'existing'; taskId: string }
  | { status: 'rejected'; reason: 'profile_over_budget'; message: string };

/** 入队一次推荐（模型选择由面板先完成）：一次一致读取生成快照 → 指纹 → 建任务 */
export async function enqueueRecommendation(
  input: EnqueueRecommendationInput,
): Promise<EnqueueRecommendationResult> {
  initRecommendationRunner();
  const config = getConfig(input.configId);
  if (!config) return { status: 'existing', taskId: 'missing-config' };

  const { items, idByAlias } = await loadWardrobeProfile({ full: true });
  // 锁定集：真实 id 全程保留（快照存 realIds；别名只作本次请求的传输编号）
  const aliasByRealId = new Map([...idByAlias].map(([alias, realId]) => [realId, alias]));
  const lockedRealIds = (input.lockedItemIds ?? []).filter((realId) => aliasByRealId.has(realId));
  // B2 预算：件数选择（槽位保底）+ 字符预算压缩（次要层先去，锁定身份保留）
  const realIdOf = (alias: string) => idByAlias.get(alias) ?? '';
  const lockedSet = new Set(lockedRealIds);
  const allIds = [...idByAlias.values()];
  const selected = selectSlotAware(items, lockedSet, realIdOf);
  const compressed = compressWithinBudget(selected, lockedSet, realIdOf);
  if (compressed.overBudget) {
    return {
      status: 'rejected',
      reason: 'profile_over_budget',
      message: `衣物档案压缩次要描述后仍超出提示词预算（${RECOMMENDATION_PROMPT_BUDGET} 字符），本次未发起推荐；请减少衣物资料中的描述或分批推荐`,
    };
  }
  const sentItems = compressed.items;
  const truncated = compressed.compressed || items.length > RECOMMENDATION_PROFILE_CAP;
  const bodyProfile = await getBodyProfile();
  const body = bodyProfile
    ? {
        ...(bodyProfile.heightCm != null ? { heightCm: bodyProfile.heightCm } : null),
        ...(bodyProfile.weightKg != null ? { weightKg: bodyProfile.weightKg } : null),
      }
    : null;
  const preferences = await getPreferences();
  const note = input.note?.trim() ? input.note.trim().slice(0, 120) : null;
  const mode = input.targetSlot ? ('replace_slot' as const) : ('full' as const);
  const stored: Omit<RecommendationInputV2, 'inputVersion' | 'createdAt'> = {
    items: sentItems.map((item) => ({
      realId: idByAlias.get(item.id) ?? '',
      alias: item.id,
      revision: item.revision ?? 0,
      name: item.name,
      category: item.category,
      attributes: item.attributes,
      colors: item.colors,
    })),
    truncated,
    totalCount: allIds.length,
    lockedRealIds,
    scene: { ...input.scene, targetDate: localTargetDate(input.scene.day) },
    body,
    preferences,
    note,
    mode,
    baseline: input.baseline ?? null,
    targetSlot: input.targetSlot ?? null,
  };
  const inputKey = buildRecommendationInputKeyV2({
    stored,
    configId: config.id,
    configRevision: callRevisionOf(config),
    contractVersion: RECOMMENDATION_CONTRACT_VERSION,
    promptVersion: RECOMMENDATION_PROMPT_VERSION,
  });
  const requestKey = `rec-req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const result = await createRecommendationTask({
    inputKey,
    requestKey,
    configId: config.id,
    configSnapshot: JSON.stringify({
      id: config.id,
      name: config.name,
      urlKind: config.urlKind,
      baseUrl: config.baseUrl,
      modelId: config.modelId,
    }),
    configRevision: callRevisionOf(config),
    // 入队快照（S1/V2）：执行时按此发送与校验，不现读会话状态
    inputJson: JSON.stringify({
      ...stored,
      inputVersion: RECOMMENDATION_INPUT_VERSION,
      createdAt: new Date().toISOString(),
    }),
  });
  notifyRecommendationChanged();
  return result;
}

/** 最近一次已完成的推荐任务（面板展示） */
export async function loadLatestRecommendation() {
  const { getLatestFinishedRecommendation } = await import('../data/repositories/recommendationRepository');
  return getLatestFinishedRecommendation();
}

/** 活动任务（queued/running）是否存在（面板状态显示） */
export async function hasActiveRecommendation(): Promise<boolean> {
  if ((await listRecommendationTasksByStatus('queued')).length > 0) return true;
  return (await listRecommendationTasksByStatus('running')).length > 0;
}

/** 单品可用性（候选采用前复核；同搭配页复用口径） */
export async function getItemAvailability(itemId: string): Promise<boolean> {
  const item = await getItem(itemId);
  return !!item && item.status === 'active' && !!item.category;
}

/** 采用前的快照版本复核：候选单品的资料版本仍与入队一致（变化即提示重新推荐） */
export async function verifySnapshotRevisions(
  stored: RecommendationInputV2,
  itemIds: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  const revisionById = new Map(stored.items.map((item) => [item.realId, item.revision]));
  for (const itemId of itemIds) {
    const expected = revisionById.get(itemId);
    if (expected === undefined) continue; // 候选新增件不在快照口径内（已在执行端校验为快照内单品）
    const item = await getItem(itemId);
    if (!item || item.status !== 'active') {
      return { ok: false, message: '候选里的衣物已删除或归档，请重新推荐。' };
    }
    if (item.revision !== expected) {
      return { ok: false, message: `「${item.name ?? '衣物'}」的资料在推荐等待期间被修改，结果不再对应当前资料，请重新推荐。` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 采用决策（S1 纯函数；RecommendationSheet 执行动作，测试直接驱动）
// ---------------------------------------------------------------------------

/** 采用复核用的会话形状（与 outfitSession.OutfitSessionState 的字段子集同形） */
export interface SessionLike {
  active: boolean;
  slots: Partial<Record<string, string>>;
  locks: string[];
  wear: string;
  slotWear: Partial<Record<string, string>>;
}

export type AdoptionDecision =
  | {
      action: 'load_full';
      basisId: string;
      slots: Partial<Record<string, string>>;
      wear: string;
      itemIds: string[];
      locks: string[];
      reason: string | null;
    }
  | { action: 'replace_slot'; slot: string; itemId: string }
  | { action: 'blocked'; message: string };

function baselineMatchesSession(
  baseline: RecommendationBaseline,
  session: SessionLike,
): boolean {
  const baselineEntries = Object.entries(baseline.slots).filter(([, id]) => !!id);
  const sessionEntries = Object.entries(session.slots).filter(([, id]) => !!id);
  if (baselineEntries.length !== sessionEntries.length) return false;
  for (const [slot, id] of baselineEntries) {
    if (session.slots[slot as keyof typeof session.slots] !== id) return false;
  }
  if (baseline.wear !== session.wear) return false;
  const baselineWearEntries = Object.entries(baseline.slotWear).filter(([, v]) => !!v);
  const sessionWearEntries = Object.entries(session.slotWear).filter(([, v]) => !!v);
  if (baselineWearEntries.length !== sessionWearEntries.length) return false;
  for (const [slot, style] of baselineWearEntries) {
    if (session.slotWear[slot as keyof typeof session.slotWear] !== style) return false;
  }
  return true;
}

/** 采用决策用的候选形状（仓库层 role 为 string；服务层候选可赋值） */
export interface AdoptionCandidate {
  slots: ReadonlyArray<{ role: string; itemId: string; note?: string }>;
  wearStyle: string;
  reason?: string | null;
}

/**
 * 采用决策（评估 §8.2.6）：读取候选所属任务的快照复核，不只看此刻 session。
 * - 无可核验快照（旧记录）→ blocked，不提供冒充受约束结果的一键采用；
 * - replace_slot：基线与会话完全一致才允许，且只替换目标槽位（单次变更，保留其他件/穿法）；
 * - full：基线或锁定已变化 → blocked 提示重新推荐；通过则整套采用并保留原请求锁定。
 * mappedSlots 由调用方先完成可用性与品类映射（错误各自有明确文案）。
 */
export function evaluateAdoption(input: {
  stored: RecommendationInputV2 | null;
  candidate: AdoptionCandidate;
  /** 候选经品类映射后的槽位（UI 槽位名 → 真实单品 ID） */
  mappedSlots: Partial<Record<string, string>>;
  session: SessionLike | null;
}): AdoptionDecision {
  if (!input.stored) {
    return {
      action: 'blocked',
      message: '这条推荐记录缺少可核验的请求约束（旧版本），无法确认它对应哪些衣物。请重新生成后再采用。',
    };
  }
  const adoptedIds = Object.values(input.mappedSlots).filter((id): id is string => !!id);
  const session = input.session;

  if (input.stored.mode === 'replace_slot') {
    const baseline = input.stored.baseline;
    const targetSlot = input.stored.targetSlot;
    if (!baseline || !targetSlot) {
      return { action: 'blocked', message: '这条局部替换记录缺少基线组合，请重新推荐。' };
    }
    if (!session?.active || !baselineMatchesSession(baseline, session)) {
      return {
        action: 'blocked',
        message: '搭配已经发生变化，这条“只换一件”的结果不再适用。请重新推荐，或手动替换。',
      };
    }
    const replacementId = input.mappedSlots[targetSlot];
    if (!replacementId) {
      return { action: 'blocked', message: '候选缺少目标槽位的替代单品，请换一个候选。' };
    }
    for (const [slot, id] of Object.entries(input.mappedSlots) as [string, string][]) {
      if (slot === targetSlot) continue;
      if (baseline.slots[slot] !== id) {
        return { action: 'blocked', message: '候选改动了应保持不变的单品，已拒绝采用。请重新推荐。' };
      }
    }
    return { action: 'replace_slot', slot: targetSlot, itemId: replacementId };
  }

  // full 模式：会话基线/锁定已变化时停止采用（不把旧候选覆盖新编辑）
  if (session?.active) {
    if (input.stored.baseline && !baselineMatchesSession(input.stored.baseline, session)) {
      return {
        action: 'blocked',
        message: '搭配已经发生变化，这条推荐不再对应你当前编辑的组合。请重新推荐。',
      };
    }
    const currentLocks = new Set(session.locks);
    const missingLock = input.stored.lockedRealIds.find((id) => !currentLocks.has(id));
    if (missingLock) {
      return {
        action: 'blocked',
        message: '请求时的锁定单品已不在当前搭配中，结果可能不再适用。请重新推荐。',
      };
    }
  }
  const keptLocks = input.stored.lockedRealIds.filter((id) => adoptedIds.includes(id));
  return {
    action: 'load_full',
    basisId: adoptedIds[0] ?? '',
    slots: { ...input.mappedSlots },
    wear: input.candidate.wearStyle,
    itemIds: adoptedIds,
    locks: keptLocks,
    reason: input.candidate.reason ?? null,
  };
}

export { parseRecommendationInputV2 };
