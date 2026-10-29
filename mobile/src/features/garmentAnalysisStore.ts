// 衣物分析的轻量会话状态（分批执行手册 §3.3 / P5、P6）。
// 职责：变化通知订阅（页面刷新与执行器尽力中止）、当前会话待提交的单品 ID、请求键辅助、
// 模块级执行器单例与视觉模型解析/默认项读写。
// 边界：不是持久化真源，不存 Key，不保存第二份权威结果（结果与状态以数据库为准）。

import { GARMENT_ANALYSIS_KIND } from '../data/repositories/analysisTypes';
import { getDefaultConfigId, setDefaultConfigId } from '../data/repositories/taskRepository';
import {
  createDefaultGarmentTaskRunnerDeps,
  createGarmentTaskRunner,
  type GarmentTaskRunner,
} from '../services/ai/garmentTaskRunner';
import { resolveVisionConfig, type ConfigResolution } from '../services/ai/visionConfig';

export type AnalysisChangeListener = () => void;

const listeners = new Set<AnalysisChangeListener>();

/** 订阅分析相关的数据变化；返回取消订阅函数 */
export function subscribeAnalysisChanges(listener: AnalysisChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 通知订阅者：数据库中的任务/属性可能已变化（归档、删除、入队、提交等） */
export function notifyAnalysisChanged(): void {
  for (const listener of [...listeners]) listener();
}

/** 一次真实点击或选图对应一个 actionId；同一批各件为 `${actionId}:${itemId}` */
export function createActionId(): string {
  return `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function requestKeyFor(actionId: string, itemId: string): string {
  return `${actionId}:${itemId}`;
}

export interface SessionBatch {
  actionId: string;
  /** 本批已保存、等待分析的单品 ID（顺序与选图一致） */
  itemIds: string[];
}

let sessionBatch: SessionBatch | null = null;

/**
 * 记住当前录入会话的待提交批次。
 * 用途：用户去配置模型后回到仍存在的录入会话时，继续本批尚未发送的分析；
 * 会话退出后由调用方清理，不据此偷偷扫描历史草稿。
 */
export function setSessionBatch(batch: SessionBatch): void {
  sessionBatch = { actionId: batch.actionId, itemIds: [...batch.itemIds] };
}

export function getSessionBatch(): SessionBatch | null {
  return sessionBatch ? { actionId: sessionBatch.actionId, itemIds: [...sessionBatch.itemIds] } : null;
}

export function clearSessionBatch(): void {
  sessionBatch = null;
}

/** 从本批中移除已入队的单品（入队成功或用户放弃） */
export function removeFromSessionBatch(itemId: string): void {
  if (!sessionBatch) return;
  sessionBatch = { ...sessionBatch, itemIds: sessionBatch.itemIds.filter((id) => id !== itemId) };
}

let runner: GarmentTaskRunner | null = null;

/**
 * 取（或首次创建）模块级执行器单例。
 * 页面与根布局共用同一实例；重复调用返回同一对象，执行器自身保证只有一个执行循环。
 */
export function initGarmentTaskRunner(): GarmentTaskRunner {
  if (!runner) {
    runner = createGarmentTaskRunner({
      ...createDefaultGarmentTaskRunnerDeps(),
      subscribeChanges: subscribeAnalysisChanges,
    });
  }
  return runner;
}

export function getGarmentTaskRunner(): GarmentTaskRunner | null {
  return runner;
}

/** 解析当前可用于衣物分析的视觉模型（读取本地配置与安全存储，不发网络请求） */
export async function resolveVisionForAnalysis(): Promise<ConfigResolution> {
  return resolveVisionConfig(await getDefaultConfigId(GARMENT_ANALYSIS_KIND));
}

/** 记住衣物分析的默认视觉模型（用户在模型选择或配置页明确选择时调用） */
export async function rememberDefaultVisionConfig(configId: string): Promise<void> {
  await setDefaultConfigId(configId, GARMENT_ANALYSIS_KIND);
  notifyAnalysisChanged();
}

/** 读取当前记住的默认视觉模型配置 ID */
export async function getRememberedVisionConfigId(): Promise<string | null> {
  return getDefaultConfigId(GARMENT_ANALYSIS_KIND);
}

/** 有结果拿到但本地未保存成功的条数（0 表示没有待保存结果） */
export function getPendingAnalysisCommitCount(): number {
  return runner?.getPendingCommitCount() ?? 0;
}

/** 只重试本地保存（不再调用模型）；完成后通知刷新 */
export async function retryPendingAnalysisCommits(): Promise<void> {
  await runner?.retryPendingCommits();
  notifyAnalysisChanged();
}

/**
 * 数据库状态变化（归档、删除等）后通知执行器：它会尽力中止已不再有效的在途请求。
 * 提交安全性不依赖该通知——提交时仍会重新校验任务与衣物状态。
 */
export function notifyAnalysisDbChanged(): void {
  notifyAnalysisChanged();
}
