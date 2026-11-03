// 搭配推荐任务执行器（M5 轨 B4）：文本模型生成候选组合。
// 与 previewTaskRunner 相同的状态机语义：发送前写 running、启动恢复标 interrupted、
// 异常兜底不留 running、执行级看门狗保证任务必达终态。
// 生成 = OpenAI 兼容 chatCompletion（文本模型），无下载步骤。

import { getConfig, getApiKey } from './configStore';
import { callRevisionOf, type ModelConfig } from './types';
import { chatCompletion } from './openaiClient';
import {
  buildRecommendationInputKey,
  normalizeRecommendation,
  parseRecommendationContent,
  recommendationSystemPrompt,
  recommendationUserPrompt,
  RECOMMENDATION_PROMPT_VERSION,
  type ProfileItem,
  type RecommendationCandidate,
} from './recommendationService';
import {
  commitRecommendationResult,
  getRecommendationTask,
  listRecommendationTasksByStatus,
  updateRecommendationTaskStatus,
  type RecommendationTask,
  type RecommendationTaskStatus,
} from '../../data/repositories/recommendationRepository';

export interface RecommendationRunnerDeps {
  listQueued(): Promise<RecommendationTask[]>;
  listRunning(): Promise<RecommendationTask[]>;
  getTask(id: string): Promise<RecommendationTask | null>;
  markRunning(id: string): Promise<boolean>;
  updateStatus(
    id: string,
    allowedFrom: RecommendationTaskStatus[],
    to: RecommendationTaskStatus,
    patch?: { errorKind?: string | null; errorSummary?: string | null; finishedAt?: string | null },
  ): Promise<boolean>;
  getConfig(id: string): ModelConfig | undefined;
  getApiKey(keyRef: string): Promise<string | null>;
  /** 读取当前衣物档案（已入库单品，别名 → 真实 id 映射一并返回）。
   * lockedAliases：请求锁定的别名（B2 预算超限时优先送入）；truncated=本次未送入全部档案。 */
  loadProfile(lockedAliases?: string[]): Promise<{
    items: ProfileItem[];
    idByAlias: Map<string, string>;
    truncated?: boolean;
    sentCount?: number;
    totalCount?: number;
  }>;
  /** 当次场景快照（仅旧任务无入队快照时兜底使用） */
  loadScene(): Promise<{
    city: string;
    day: string;
    scene: string;
    temp?: string;
    tempSource?: string;
    weatherDesc?: string;
  }>;
  /** 候选落库（succeeded 提交） */
  commitResult(
    taskId: string,
    result: { candidates: RecommendationCandidate[]; gaps: string[]; summary?: string },
  ): Promise<void>;
  onSettled?(): void;
  subscribeChanges?(listener: () => void): () => void;
}

export interface RecommendationRunner {
  start(): void;
  setForeground(value: boolean): void;
  recover(): Promise<void>;
  handleExternalChange(): Promise<void>;
}

const EXECUTE_WATCHDOG_MS = 90000;
const CHAT_TIMEOUT_MS = 60000;
const UNKNOWN_OUTCOME_KINDS: readonly string[] = ['timeout', 'network', 'cancelled'];

/** 入队时持久化的输入快照（schema v5 起）；损坏视为无快照，回退现读场景 */
interface StoredRecommendationInput {
  scene?: { city: string; day: string; scene: string; temp?: string; tempSource?: string; weatherDesc?: string };
  lockedAliases?: string[];
  /** 身材资料（M6 批次 2）；旧任务无此字段，仅接受数值防脏数据进提示词 */
  body?: { heightCm?: number; weightKg?: number } | null;
  /** 长期偏好（B1：全部参与排序）；消毒后进提示词 */
  preferences?: string[];
  /** 当次要求（B1）；消毒后进提示词，仅本次有效 */
  note?: string | null;
}

function parseStoredInput(inputJson: string | null): StoredRecommendationInput | null {
  if (!inputJson) return null;
  try {
    const parsed = JSON.parse(inputJson) as StoredRecommendationInput;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.scene && typeof parsed.scene.city !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 快照身材资料消毒：只保留正数值字段，脏数据不进提示词 */
function sanitizeBody(input?: { heightCm?: number; weightKg?: number } | null): {
  heightCm?: number;
  weightKg?: number;
} | null {
  if (!input || typeof input !== 'object') return null;
  const body: { heightCm?: number; weightKg?: number } = {};
  if (typeof input.heightCm === 'number' && input.heightCm > 0) body.heightCm = input.heightCm;
  if (typeof input.weightKg === 'number' && input.weightKg > 0) body.weightKg = input.weightKg;
  return body.heightCm || body.weightKg ? body : null;
}

/** 快照长期偏好消毒：只保留非空短字符串，最多 10 条（B1） */
function sanitizePreferences(input?: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is string => typeof item === 'string' && !!item.trim())
    .map((item) => item.trim().slice(0, 30))
    .slice(0, 10);
}

/** 快照当次要求消毒：单行短文本（B1） */
function sanitizeNote(input?: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  return input.trim().slice(0, 120);
}

export function createRecommendationTaskRunner(deps: RecommendationRunnerDeps): RecommendationRunner {
  let started = false;
  let foreground = false;
  let loopRunning = false;
  let unsubscribe: (() => void) | null = null;

  async function claimNext(): Promise<RecommendationTask | null> {
    const queued = await deps.listQueued();
    for (const task of queued) {
      const config = deps.getConfig(task.configId);
      if (!config || callRevisionOf(config) !== task.configRevision) {
        await deps.updateStatus(task.id, ['queued'], 'blocked', {
          finishedAt: new Date().toISOString(),
          errorKind: 'config_changed',
          errorSummary: '所选模型配置已被修改或删除，请重新生成',
        });
        deps.onSettled?.();
        continue;
      }
      if (await deps.markRunning(task.id)) {
        deps.onSettled?.();
        return { ...task, status: 'running' };
      }
    }
    return null;
  }

  async function runClaimed(task: RecommendationTask, markSent: () => void): Promise<void> {
    const config = deps.getConfig(task.configId);
    if (!config) return;

    const apiKey = await deps.getApiKey(config.keyRef);
    if (!apiKey) {
      await deps.updateStatus(task.id, ['running'], 'blocked', {
        finishedAt: new Date().toISOString(),
        errorKind: 'config_invalid',
        errorSummary: '所选模型配置缺少可读取的 API Key',
      });
      return;
    }

    // 场景与锁定集用入队时的快照（不现读会话状态）；旧任务无快照时回退现读
    const stored = parseStoredInput(task.inputJson);
    const scene = stored?.scene ?? (await deps.loadScene());
    const requestedLocks = stored?.lockedAliases ?? [];
    // B2：档案超限时锁定项优先送入（别名编号保持全柜口径，不重排）
    const profile = await deps.loadProfile(requestedLocks);
    const { items, idByAlias } = profile;
    if (items.length === 0) {
      await deps.updateStatus(task.id, ['running'], 'failed', {
        finishedAt: new Date().toISOString(),
        errorKind: 'profile_empty',
        errorSummary: '衣橱里没有已入库衣物，先录入并确认品类后再用 AI 推荐',
      });
      return;
    }
    const lockedAliases = requestedLocks.filter((id) => items.some((item) => item.id === id));
    const body = sanitizeBody(stored?.body);
    // B1：长期偏好与当次要求按入队快照发送（不现读，可能与入队时不同）
    const preferences = sanitizePreferences(stored?.preferences);
    const note = sanitizeNote(stored?.note);
    // B2：截取时在提示词中如实说明（不静默丢弃）
    const profileNote = profile.truncated
      ? `（衣物较多，本次仅送入 ${profile.sentCount}/${profile.totalCount} 件：锁定单品与较早入库优先；其余未参与本次推荐）`
      : undefined;

    const controller = new AbortController();
    markSent();
    let content: string;
    try {
      const chat = await chatCompletion(
        { urlKind: config.urlKind, baseUrl: config.baseUrl, modelId: config.modelId },
        apiKey,
        [
          { role: 'system', content: recommendationSystemPrompt() },
          {
            role: 'user',
            content: recommendationUserPrompt({ items, scene, body, lockedAliases, preferences, note, profileNote }),
          },
        ],
        CHAT_TIMEOUT_MS,
        { maxTokens: 2048, signal: controller.signal },
      );
      if (!chat.ok) {
        const failure = chat.error ?? { kind: 'unknown', message: '调用失败' };
        const unknown = UNKNOWN_OUTCOME_KINDS.includes(failure.kind);
        await deps.updateStatus(task.id, ['running'], unknown ? 'interrupted' : 'failed', {
          finishedAt: new Date().toISOString(),
          errorKind: failure.kind,
          errorSummary: failure.message,
        });
        return;
      }
      content = chat.content;
    } finally {
      void controller;
    }

    const parsedContent = parseRecommendationContent(content);
    if (!parsedContent.ok) {
      await deps.updateStatus(task.id, ['running'], 'failed', {
        finishedAt: new Date().toISOString(),
        errorKind: 'invalid_output',
        errorSummary: parsedContent.error,
      });
      return;
    }
    const normalized = normalizeRecommendation(parsedContent.value, idByAlias, {
      // B3：锁定集作为本地校验输入——候选缺锁定单品在此拒绝，不只靠提示词约束
      requireLockedAliases: lockedAliases,
    });
    if (!normalized.ok) {
      await deps.updateStatus(task.id, ['running'], 'failed', {
        finishedAt: new Date().toISOString(),
        errorKind: 'invalid_output',
        errorSummary: normalized.error,
      });
      return;
    }

    await deps.commitResult(task.id, normalized.value);
    await deps.updateStatus(task.id, ['running'], 'succeeded', {
      finishedAt: new Date().toISOString(),
    });
  }

  async function execute(task: RecommendationTask): Promise<void> {
    let sent = false;

    const run = (async (): Promise<'done' | 'error'> => {
      try {
        await runClaimed(task, () => {
          sent = true;
        });
        return 'done';
      } catch (error) {
        try {
          await deps.updateStatus(task.id, ['running'], sent ? 'interrupted' : 'failed', {
            finishedAt: new Date().toISOString(),
            errorKind: 'internal',
            errorSummary: `处理意外失败：${error instanceof Error ? error.message : String(error)}`,
          });
        } catch {
          // 兜底也失败：留给下次启动 recover()
        }
        return 'error';
      }
    })();

    // 看门狗定时器在任务落终态后清理（R8：不残留定时器拖住进程/测试）
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    const watchdog = new Promise<'timeout'>((resolve) => {
      watchdogTimer = setTimeout(() => resolve('timeout'), EXECUTE_WATCHDOG_MS);
    });

    const outcome = await Promise.race([run, watchdog]);
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (outcome === 'timeout') {
      await deps
        .updateStatus(task.id, ['running'], sent ? 'interrupted' : 'failed', {
          finishedAt: new Date().toISOString(),
          errorKind: 'watchdog',
          errorSummary: `执行超过 ${Math.round(EXECUTE_WATCHDOG_MS / 1000)} 秒未完成，已按结果未知处理；可重试`,
        })
        .catch(() => undefined);
    }
    deps.onSettled?.();
  }

  async function loop(): Promise<void> {
    if (loopRunning) return;
    loopRunning = true;
    try {
      while (foreground) {
        const task = await claimNext();
        if (!task) break;
        await execute(task);
      }
    } finally {
      loopRunning = false;
    }
  }

  function kick(): void {
    void loop().catch(() => {});
  }

  async function handleExternalChange(): Promise<void> {
    if (foreground) kick();
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      if (deps.subscribeChanges) unsubscribe = deps.subscribeChanges(() => void handleExternalChange());
    },
    setForeground(value: boolean): void {
      foreground = value;
      if (value) kick();
    },
    async recover(): Promise<void> {
      const running = await deps.listRunning();
      for (const task of running) {
        const changed = await deps.updateStatus(task.id, ['running'], 'interrupted', {
          finishedAt: new Date().toISOString(),
          errorKind: 'interrupted',
          errorSummary: '应用被中断，本次推荐结果未知；可重试',
        });
        if (changed) deps.onSettled?.();
      }
    },
    async handleExternalChange(): Promise<void> {
      if (foreground) kick();
    },
  };
}

/** 推荐输入指纹（store 入队用；与 runner 解耦） */
export { buildRecommendationInputKey, RECOMMENDATION_PROMPT_VERSION };
