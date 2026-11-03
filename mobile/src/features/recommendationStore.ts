// 搭配推荐会话状态（M5 轨 B4）：执行器单例、变化通知、档案读取、入队。
// 档案 id 映射：提示词用别名 item-1..N（避免把存量缓存 URI 喂给模型），
// 结果候选在 runner 内已回映为真实单品 ID。

import { getConfig, getApiKey } from '../services/ai/configStore';
import { resolveTextConfig, type ConfigResolution } from '../services/ai/visionConfig';
import { createRecommendationTaskRunner, type RecommendationRunner } from '../services/ai/recommendationTaskRunner';
import { buildRecommendationInputKey, type ProfileItem } from '../services/ai/recommendationService';
import { chatCompletion } from '../services/ai/openaiClient';
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

/** 读取已入库单品的结构化档案：别名 item-1..N（按创建顺序）→ 真实 id 映射 */
export async function loadWardrobeProfile(): Promise<{ items: ProfileItem[]; idByAlias: Map<string, string> }> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM items WHERE status = 'active' ORDER BY created_at ASC",
  );
  const items: ProfileItem[] = [];
  const idByAlias = new Map<string, string>();
  for (const [index, row] of rows.entries()) {
    const [view, item] = await Promise.all([getAnalysisView(row.id), getItem(row.id)]);
    const alias = `item-${index + 1}`;
    idByAlias.set(alias, row.id);
    items.push({
      id: alias,
      // A1：用户实际名称优先于 AI 名称建议（建议稿 B3；AI 建议仅在用户未命名时使用）
      name: item?.name ?? view.suggestedName?.value ?? null,
      category: view.category.value ?? null,
      attributes: view.attributes.map((a) => ({ name: a.name, value: a.value })),
      colors: view.colors.value.map((c) => ({ name: c.name, hex: c.hex })),
    });
  }
  return { items, idByAlias };
}

/**
 * 当次场景快照（M6 批次 1.2）：读首页当次 context（启动时由长期默认播种、
 * SceneSheet 当次修改直接生效），不再只读长期默认。
 * 温度只在来源为实时天气/手动填写时带上——演示温度（tempSource='demo'）不进 AI 输入。
 * B6：实时天气带天气描述（晴/雨/雪等，参与选择）；手动温度无描述不编造。
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
  return {
    city: context.city || sceneDefault?.city || '未设置地点',
    day: context.day || sceneDefault?.day || '今天',
    scene: context.scene || sceneDefault?.scene || prefs[0] || '日常通勤',
    ...(context.tempSource === 'real' || context.tempSource === 'manual'
      ? { temp: context.temp, tempSource: context.tempSource }
      : null),
    ...(context.tempSource === 'real' && context.weatherDesc ? { weatherDesc: context.weatherDesc } : null),
  };
}

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
      loadProfile: loadWardrobeProfile,
      loadScene: loadSceneSnapshot,
      commitResult: commitRecommendationResult,
      onSettled: notifyRecommendationChanged,
      subscribeChanges: subscribeRecommendationChanges,
    });
  }
  return runner;
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
  /** 当前搭配会话中已锁定的真实单品 ID（映射为别名进提示词与快照；可省略） */
  lockedItemIds?: string[];
  /** 当次要求（选填，如"只换鞋""更正式一点"）；仅本次请求有效（B1） */
  note?: string | null;
  /** 已就绪（ready）或用户已选定的文本配置 ID */
  configId: string;
}

export type EnqueueRecommendationResult =
  | { status: 'created'; taskId: string }
  | { status: 'existing'; taskId: string };

/** 入队一次推荐（模型选择由面板先完成） */
export async function enqueueRecommendation(
  input: EnqueueRecommendationInput,
): Promise<EnqueueRecommendationResult> {
  initRecommendationRunner();
  const config = getConfig(input.configId);
  if (!config) return { status: 'existing', taskId: 'missing-config' };

  const { items, idByAlias } = await loadWardrobeProfile();
  // 锁定集映射：真实 id → 别名（提示词只用别名）；不在当前档案中的锁定项忽略
  const aliasByRealId = new Map([...idByAlias].map(([alias, realId]) => [realId, alias]));
  const lockedAliases = (input.lockedItemIds ?? [])
    .map((realId) => aliasByRealId.get(realId))
    .filter((alias): alias is string => !!alias);
  // 身材资料随入队快照（M6 批次 2）：指纹与执行时发送内容保持一致
  const bodyProfile = await getBodyProfile();
  const body = bodyProfile
    ? {
        ...(bodyProfile.heightCm != null ? { heightCm: bodyProfile.heightCm } : null),
        ...(bodyProfile.weightKg != null ? { weightKg: bodyProfile.weightKg } : null),
      }
    : null;
  // B1：长期偏好与当次要求随入队快照（执行时按快照发送；长期偏好全部参与排序）
  const preferences = await getPreferences();
  const note = input.note?.trim() ? input.note.trim().slice(0, 120) : null;
  const inputKey = buildRecommendationInputKey({
    aliasItemIds: items.map((item) => item.id),
    scene: input.scene,
    body,
    lockedAliases,
    preferences,
    note,
    configId: config.id,
    configRevision: callRevisionOf(config),
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
    // 入队快照：执行时按此发送，不现读会话状态（场景/锁定/身材/偏好可能已变化）
    inputJson: JSON.stringify({ scene: input.scene, lockedAliases, body, preferences, note }),
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
