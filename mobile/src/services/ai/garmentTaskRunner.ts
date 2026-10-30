// 衣物分析任务执行器（分批执行手册 R4/R5 / P5）。
// 职责：领取 queued → 发送前写 running → 校验输入与配置 → 调用模型 → 原子提交；
// 以及前后台控制、启动恢复、配置版本检查、事件通知与“结果已拿到但本地保存失败”的内存重试。
// 边界：
// - 模块级单例由根布局持有，串行执行、并发最大 1；
// - 数据库事务中不等待网络；提交安全性独立于通知（通知只用于尽力中止与刷新）；
// - 只重试本地提交，绝不因保存失败重新调用模型；不自动重试付费调用。

import { GARMENT_ANALYSIS_VERSION, type GarmentAnalysis } from '@ownfit/contract';
import {
  getDefaultConfigId,
  createGarmentTask,
  getTask,
  listTasksByStatus,
  markTaskRunning,
  setDefaultConfigId,
  updateTaskStatus,
  type CreateGarmentTaskInput,
  type TaskStatusPatch,
} from '../../data/repositories/taskRepository';
import {
  GARMENT_ANALYSIS_KIND,
  type AnalysisTask,
  type AnalysisTaskStatus,
  type AnalysisTrigger,
  type RejectReason,
} from '../../data/repositories/analysisTypes';
import { getItem, type WardrobeItem } from '../../data/repositories/itemRepository';
import {
  getMainPhotoForAnalysis,
  readAnalysisImage,
  type AnalysisImageResult,
} from '../../data/repositories/photoRepository';
import { commitGarmentAnalysis, type AnalysisCommitResult } from '../../data/repositories/attributeRepository';
import { getApiKey, getConfig } from './configStore';
import { resolveVisionConfig, type ConfigResolution } from './visionConfig';
import {
  GARMENT_PROMPT_VERSION,
  runGarmentAnalysis,
  type AnalysisRunResult,
} from './garmentAnalysis';
import { callRevisionOf, type ModelConfig } from './types';

/** 配置快照：只含白名单字段，绝不含 Key 或 keyRef */
export interface ConfigSnapshot {
  id: string;
  name: string;
  urlKind: ModelConfig['urlKind'];
  baseUrl: string;
  modelId: string;
}

function toConfigSnapshot(config: ModelConfig): ConfigSnapshot {
  return {
    id: config.id,
    name: config.name,
    urlKind: config.urlKind,
    baseUrl: config.baseUrl,
    modelId: config.modelId,
  };
}

/** 输入指纹：固定顺序 JSON，无需密码学哈希（分批执行手册 §3.2） */
export function buildInputKey(input: {
  itemId: string;
  revision: number;
  photoId: string;
  configId: string;
  configRevision: string;
  contractVersion?: string;
  promptVersion?: string;
}): string {
  return JSON.stringify({
    itemId: input.itemId,
    revision: input.revision,
    photoId: input.photoId,
    configId: input.configId,
    configRevision: input.configRevision,
    contractVersion: input.contractVersion ?? GARMENT_ANALYSIS_VERSION,
    promptVersion: input.promptVersion ?? GARMENT_PROMPT_VERSION,
  });
}

export interface GarmentTaskRunnerDeps {
  resolveVisionConfig(defaultConfigId: string | null): Promise<ConfigResolution>;
  getDefaultConfigId(): Promise<string | null>;
  setDefaultConfigId(configId: string): Promise<void>;
  getItem(id: string): Promise<WardrobeItem | undefined>;
  getConfig(id: string): ModelConfig | undefined;
  getApiKey(keyRef: string): Promise<string | null>;
  getMainPhotoForAnalysis(itemId: string): Promise<{ photoId: string } | null>;
  readAnalysisImage(itemId: string): Promise<AnalysisImageResult>;
  createGarmentTask(input: CreateGarmentTaskInput): Promise<{ created: boolean; task: AnalysisTask }>;
  listTasksByStatus(status: AnalysisTaskStatus): Promise<AnalysisTask[]>;
  getTask(id: string): Promise<AnalysisTask | null>;
  markTaskRunning(id: string): Promise<boolean>;
  updateTaskStatus(
    id: string,
    allowedFrom: AnalysisTaskStatus[],
    to: AnalysisTaskStatus,
    patch?: TaskStatusPatch,
  ): Promise<boolean>;
  runGarmentAnalysis(input: {
    config: Pick<ModelConfig, 'urlKind' | 'baseUrl' | 'modelId'>;
    apiKey: string;
    imageDataUrl: string;
    signal?: AbortSignal;
  }): Promise<AnalysisRunResult>;
  commitGarmentAnalysis(taskId: string, result: GarmentAnalysis): Promise<AnalysisCommitResult>;
  /** 数据库状态可能变化的通知（归档/删除/重试等）；只用于尽力中止与刷新，提交安全性不依赖它 */
  subscribeChanges?(listener: () => void): () => void;
  /** 任务状态落库后的通知（领取/完成/失败/中断等）；页面据此刷新展示，不承担提交安全性 */
  onTaskSettled?(): void;
}

export interface EnqueueGarmentAnalysisInput {
  itemId: string;
  /** 用户选定的视觉配置；省略时使用该任务类型的默认配置 */
  configId?: string;
  trigger: AnalysisTrigger;
  /** 一次主动提交的幂等键；同一批各件为 `${actionId}:${itemId}` */
  requestKey: string;
  retryOfTaskId?: string;
}

export type EnqueueGarmentAnalysisResult =
  | { status: 'created'; task: AnalysisTask }
  | { status: 'existing'; task: AnalysisTask }
  | { status: 'rejected'; reason: RejectReason };

export interface GarmentTaskRunner {
  /** 幂等：重复调用只保留一个执行循环 */
  start(): void;
  stop(): void;
  setForeground(foreground: boolean): void;
  isForeground(): boolean;
  /** 启动恢复：遗留 running 标为 interrupted（不重发），并唤醒 queued */
  recover(): Promise<void>;
  enqueueGarmentAnalysis(input: EnqueueGarmentAnalysisInput): Promise<EnqueueGarmentAnalysisResult>;
  /** 只重试本地提交（不再调用模型） */
  retryPendingCommits(): Promise<void>;
  getPendingCommitCount(): number;
  /** 外部变化（归档/删除等）后调用：尽力中止已不再有效的在途请求并唤醒循环 */
  handleExternalChange(): Promise<void>;
}

const RETRYABLE_RETRY_STATES: readonly AnalysisTaskStatus[] = ['failed', 'interrupted', 'stale', 'blocked'];

/** 结果未知的错误类别：可能已被供应商受理，标为中断并允许用户手动重试 */
const UNKNOWN_OUTCOME_KINDS: readonly string[] = ['timeout', 'network', 'cancelled'];

export function createGarmentTaskRunner(deps: GarmentTaskRunnerDeps): GarmentTaskRunner {
  let started = false;
  let foreground = false;
  let loopRunning = false;
  let unsubscribe: (() => void) | null = null;

  /** 在途请求的取消句柄：仅用于尽力停止，不承担正确性 */
  const inflight = new Map<string, AbortController>();
  /** 已拿到结果但本地提交失败的条目：只重试本地提交 */
  const pendingCommits = new Map<string, GarmentAnalysis>();

  async function commitWithRetry(taskId: string, result: GarmentAnalysis): Promise<void> {
    try {
      await deps.commitGarmentAnalysis(taskId, result);
      pendingCommits.delete(taskId);
    } catch {
      // 本地保存失败：结果留在内存，仅重试本地提交，绝不再调用模型
      pendingCommits.set(taskId, result);
    }
  }

  async function retryPendingCommits(): Promise<void> {
    for (const [taskId, result] of [...pendingCommits]) {
      await commitWithRetry(taskId, result);
    }
  }

  /** 校验并领取下一个 queued 任务；返回 null 表示当前没有可发送的任务 */
  async function claimNext(): Promise<AnalysisTask | null> {
    const queued = await deps.listTasksByStatus('queued');
    for (const task of queued) {
      const item = await deps.getItem(task.itemId);
      if (!item || item.status === 'deleted') {
        await deps.updateTaskStatus(task.id, ['queued'], 'cancelled', { finishedAt: new Date().toISOString() });
        deps.onTaskSettled?.();
        continue;
      }
      if (item.status === 'archived') {
        await deps.updateTaskStatus(task.id, ['queued'], 'cancelled', { finishedAt: new Date().toISOString() });
        deps.onTaskSettled?.();
        continue;
      }
      // 发送前发现资料或照片变化：stale，零网络请求
      if (item.revision !== task.inputRevision || item.mainPhotoId !== task.photoId) {
        await deps.updateTaskStatus(task.id, ['queued'], 'stale', { finishedAt: new Date().toISOString() });
        deps.onTaskSettled?.();
        continue;
      }
      const photo = await deps.getMainPhotoForAnalysis(task.itemId);
      if (!photo || photo.photoId !== task.photoId) {
        await deps.updateTaskStatus(task.id, ['queued'], 'stale', { finishedAt: new Date().toISOString() });
        deps.onTaskSettled?.();
        continue;
      }
      // 配置版本检查：已删除或被改过 → blocked，不把请求改发到新地址
      const config = deps.getConfig(task.configId);
      if (!config || callRevisionOf(config) !== task.configRevision) {
        await deps.updateTaskStatus(task.id, ['queued'], 'blocked', {
          finishedAt: new Date().toISOString(),
          errorKind: 'config_changed',
          errorSummary: '所选模型配置已被修改或删除，请重新选择后再分析',
        });
        deps.onTaskSettled?.();
        continue;
      }
      // 发送前先把状态写成 running
      if (await deps.markTaskRunning(task.id)) {
        deps.onTaskSettled?.();
        return { ...task, status: 'running' };
      }
    }
    return null;
  }

  async function execute(task: AnalysisTask): Promise<void> {
    // 兜底：任何路径都以“状态落库 + 通知”结束，绝不让任务停留在 running。
    // 发送前意外失败 → failed（未发起请求，无计费风险）；发送后 → interrupted（结果未知）。
    let sent = false;
    try {
      await runClaimed(task, () => {
        sent = true;
      });
    } catch (error) {
      try {
        await deps.updateTaskStatus(task.id, ['running'], sent ? 'interrupted' : 'failed', {
          finishedAt: new Date().toISOString(),
          errorKind: 'internal',
          errorSummary: `处理意外失败：${error instanceof Error ? error.message : String(error)}`,
        });
      } catch {
        // 兜底写状态也失败：留给下次启动 recover() 处理遗留 running
      }
    }
    deps.onTaskSettled?.();
  }

  /** 执行一个已领取（running）的任务：读取输入 → 调用模型 → 落库终态 */
  async function runClaimed(task: AnalysisTask, markSent: () => void): Promise<void> {
    const config = deps.getConfig(task.configId);
    if (!config) return; // 已被删除：交由状态检查处理

    const apiKey = await deps.getApiKey(config.keyRef);
    if (!apiKey) {
      await deps.updateTaskStatus(task.id, ['running'], 'blocked', {
        finishedAt: new Date().toISOString(),
        errorKind: 'config_invalid',
        errorSummary: '所选模型配置缺少可读取的 API Key',
      });
      return;
    }

    const image = await deps.readAnalysisImage(task.itemId);
    if (!image.ok) {
      await deps.updateTaskStatus(task.id, ['running'], 'failed', {
        finishedAt: new Date().toISOString(),
        errorKind: image.reason === 'photo_missing' ? 'photo_missing' : 'file_missing',
        errorSummary: '分析用的照片已不可用',
      });
      return;
    }

    // 请求使用排队时固定的快照地址，不因期间配置被改而改发目标
    let snapshot: ConfigSnapshot;
    try {
      snapshot = JSON.parse(task.configSnapshot) as ConfigSnapshot;
    } catch {
      snapshot = toConfigSnapshot(config);
    }

    const controller = new AbortController();
    inflight.set(task.id, controller);
    markSent();
    let outcome: AnalysisRunResult;
    try {
      outcome = await deps.runGarmentAnalysis({
        config: { urlKind: snapshot.urlKind, baseUrl: snapshot.baseUrl, modelId: snapshot.modelId },
        apiKey,
        imageDataUrl: image.dataUrl,
        signal: controller.signal,
      });
    } finally {
      inflight.delete(task.id);
    }

    const now = new Date().toISOString();
    if (outcome.ok) {
      await commitWithRetry(task.id, outcome.result);
      return;
    }

    const kind = outcome.error.kind;
    if (UNKNOWN_OUTCOME_KINDS.includes(kind)) {
      // 超时/断网/被中止：结果未知，可能已被受理；不自动重发，留给用户手动重试
      await deps.updateTaskStatus(task.id, ['running'], 'interrupted', {
        finishedAt: now,
        errorKind: kind,
        errorSummary: outcome.error.message,
      });
      return;
    }
    await deps.updateTaskStatus(task.id, ['running'], 'failed', {
      finishedAt: now,
      errorKind: kind,
      errorSummary: outcome.error.message,
    });
  }

  async function loop(): Promise<void> {
    if (loopRunning) return;
    loopRunning = true;
    try {
      const hadPending = pendingCommits.size > 0;
      await retryPendingCommits();
      if (hadPending) deps.onTaskSettled?.();
      while (foreground) {
        const task = await claimNext();
        if (!task) break;
        await execute(task);
      }
    } finally {
      loopRunning = false;
    }
  }

  /** 通知到达：中止已不再有效的在途请求（尽力），并唤醒循环 */
  async function handleExternalChange(): Promise<void> {
    for (const [taskId, controller] of [...inflight]) {
      const current = await deps.getTask(taskId);
      if (!current || current.status !== 'running') {
        controller.abort();
        inflight.delete(taskId);
      }
    }
    if (foreground) kick();
  }

  /**
   * 唤醒执行循环。异常不向外抛：意外错误会终止本轮领取，任务保持原状态，
   * 由下一次显式触发（入队/前后台切换/通知）重新尝试——不用定时器热重试。
   */
  function kick(): void {
    void loop().catch(() => {});
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      if (deps.subscribeChanges) unsubscribe = deps.subscribeChanges(() => void handleExternalChange());
    },
    stop(): void {
      started = false;
      foreground = false;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    },
    setForeground(value: boolean): void {
      foreground = value;
      if (value) kick();
    },
    isForeground(): boolean {
      return foreground;
    },
    async recover(): Promise<void> {
      // 遗留 running 保守标为 interrupted：极端情况下可能尚未真正发送，优先避免重复计费
      const running = await deps.listTasksByStatus('running');
      for (const task of running) {
        const changed = await deps.updateTaskStatus(task.id, ['running'], 'interrupted', {
          finishedAt: new Date().toISOString(),
          errorKind: 'interrupted',
          errorSummary: '应用被中断，本次结果未知；重试可能再次计费',
        });
        if (changed) deps.onTaskSettled?.();
      }
    },
    async enqueueGarmentAnalysis(input: EnqueueGarmentAnalysisInput): Promise<EnqueueGarmentAnalysisResult> {
      const item = await deps.getItem(input.itemId);
      if (!item) return { status: 'rejected', reason: 'item_missing' };
      if (item.status === 'deleted' || item.status === 'archived') {
        return { status: 'rejected', reason: 'item_unavailable' };
      }
      const photo = await deps.getMainPhotoForAnalysis(input.itemId);
      if (!photo) return { status: 'rejected', reason: 'photo_missing' };

      if (input.retryOfTaskId) {
        const previous = await deps.getTask(input.retryOfTaskId);
        if (!previous || !RETRYABLE_RETRY_STATES.includes(previous.status)) {
          return { status: 'rejected', reason: 'retry_target_invalid' };
        }
      }

      let config: ModelConfig | undefined;
      if (input.configId) {
        config = deps.getConfig(input.configId);
        if (!config || config.urlKind !== 'openai' || !config.capabilities.includes('vision')) {
          return { status: 'rejected', reason: 'config_invalid' };
        }
      } else {
        const defaultId = await deps.getDefaultConfigId();
        const resolution = await deps.resolveVisionConfig(defaultId);
        if (resolution.status !== 'ready') return { status: 'rejected', reason: 'config_missing' };
        config = resolution.config;
        await deps.setDefaultConfigId(config.id);
      }

      const configRevision = callRevisionOf(config);
      const result = await deps.createGarmentTask({
        itemId: input.itemId,
        photoId: photo.photoId,
        inputRevision: item.revision,
        inputKey: buildInputKey({
          itemId: input.itemId,
          revision: item.revision,
          photoId: photo.photoId,
          configId: config.id,
          configRevision,
        }),
        requestKey: input.requestKey,
        configId: config.id,
        configSnapshot: JSON.stringify(toConfigSnapshot(config)),
        configRevision,
        contractVersion: GARMENT_ANALYSIS_VERSION,
        promptVersion: GARMENT_PROMPT_VERSION,
        retryOfTaskId: input.retryOfTaskId ?? null,
      });

      if (foreground) kick();
      return { status: result.created ? 'created' : 'existing', task: result.task };
    },
    retryPendingCommits,
    getPendingCommitCount(): number {
      return pendingCommits.size;
    },
    handleExternalChange,
  };
}

/** 用真实仓库与 AI 服务装配依赖；页面只需再补 subscribeChanges（通知/刷新） */
export function createDefaultGarmentTaskRunnerDeps(): Omit<GarmentTaskRunnerDeps, 'subscribeChanges'> {
  return {
    resolveVisionConfig,
    getDefaultConfigId: () => getDefaultConfigId(GARMENT_ANALYSIS_KIND),
    setDefaultConfigId: (configId) => setDefaultConfigId(configId, GARMENT_ANALYSIS_KIND),
    getItem,
    getConfig,
    getApiKey,
    getMainPhotoForAnalysis,
    readAnalysisImage,
    createGarmentTask,
    listTasksByStatus,
    getTask,
    markTaskRunning,
    updateTaskStatus,
    runGarmentAnalysis,
    commitGarmentAnalysis,
  };
}
