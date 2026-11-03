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
import { getSceneDefault, getPreferences } from '../data/repositories/settingsRepository';
import { getDefaultConfigId, setDefaultConfigId } from '../data/repositories/taskRepository';
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
    const view = await getAnalysisView(row.id);
    const alias = `item-${index + 1}`;
    idByAlias.set(alias, row.id);
    items.push({
      id: alias,
      name: view.suggestedName?.value ?? null,
      category: view.category.value ?? null,
      attributes: view.attributes.map((a) => ({ name: a.name, value: a.value })),
      colors: view.colors.value.map((c) => ({ name: c.name, hex: c.hex })),
    });
  }
  return { items, idByAlias };
}

/** 当次场景快照：常用场景默认值 + 首个偏好兜底 */
export async function loadSceneSnapshot(): Promise<{ city: string; day: string; scene: string }> {
  const sceneDefault = await getSceneDefault();
  const prefs = await getPreferences();
  return {
    city: sceneDefault?.city ?? '未设置地点',
    day: sceneDefault?.day ?? '今天',
    scene: sceneDefault?.scene ?? prefs[0] ?? '日常通勤',
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
  scene: { city: string; day: string; scene: string };
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

  const { items } = await loadWardrobeProfile();
  const inputKey = buildRecommendationInputKey({
    aliasItemIds: items.map((item) => item.id),
    scene: input.scene,
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
