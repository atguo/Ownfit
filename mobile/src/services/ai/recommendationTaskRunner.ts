// 搭配推荐任务执行器（M5 轨 B4）：文本模型生成候选组合。
// 与 previewTaskRunner 相同的状态机语义：发送前写 running、启动恢复标 interrupted、
// 异常兜底不留 running、执行级看门狗保证任务必达终态。
// 生成 = OpenAI 兼容 chatCompletion（文本模型），无下载步骤。
// S1（2026-11-04，评估 §8.2）：执行只依据入队快照（RecommendationInputV2）——
// 不再按当前衣橱重建别名映射（旧 R4 漂移根因）；发送前校验快照内单品可用性与
// 资料版本，不满足标 stale 并保留原请求；局部替换候选按允许变化范围本地校验（F8）。
// 历史兼容：无 V2 快照的旧 queued 请求标 stale（不自动重发）；旧 running 由启动恢复标 interrupted。

import { getConfig, getApiKey } from './configStore';
import { callRevisionOf, type ModelConfig } from './types';
import { chatCompletion } from './openaiClient';
import {
  categoryToSlotRole,
  normalizeRecommendation,
  parseRecommendationContent,
  recommendationSystemPrompt,
  recommendationUserPrompt,
  RECOMMENDATION_PROMPT_VERSION,
  type ProfileItem,
  type SlotRole,
} from './recommendationService';
import {
  aliasMapOf,
  parseRecommendationInputV2,
  type RecommendationInputV2,
  type ReplacementRule,
} from './recommendationInput';
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
  /** S1 发送前校验：快照内各单品仍可用且资料版本一致；不满足整体拒绝（标 stale 保留原请求） */
  validateSnapshotItems(
    entries: Array<{ realId: string; revision: number }>,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  /** 候选落库（succeeded 提交） */
  commitResult(
    taskId: string,
    result: { candidates: { slots: Array<{ role: SlotRole; itemId: string; note?: string }>; wearStyle: string; reason?: string }[]; gaps: string[]; summary?: string },
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

/** 会话槽位名 → 服务层槽位（局部替换约束用） */
const UI_SLOT_TO_ROLE: Record<string, SlotRole> = {
  top: 'top',
  dress: 'dress',
  bottom: 'bottom',
  shoes: 'shoes',
  outer: 'outerwear',
};

const UI_SLOT_LABELS: Record<string, string> = {
  top: '上衣',
  dress: '连衣裙',
  bottom: '下装',
  shoes: '鞋子',
  outer: '外套',
};

/** 局部替换提示词说明（F8）：目标槽位与保持不变的范围对模型显式声明 */
function replacementNoteFor(stored: RecommendationInputV2): string | undefined {
  if (stored.mode !== 'replace_slot' || !stored.targetSlot) return undefined;
  const label = UI_SLOT_LABELS[stored.targetSlot] ?? stored.targetSlot;
  const keptCount = stored.lockedRealIds.length;
  return [
    `本次是"只换${label}"的局部替换任务：`,
    `候选必须保留用户当前组合中的其余 ${keptCount} 件单品（见上方锁定清单），只把${label}换成档案中品类相符的其他单品。`,
    '不要新增其他槽位的衣物（例如不要额外加外套），不要改动保留单品的角色，不要更换穿法。',
  ].join('');
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
      // S1 历史兼容：无 V2 快照的旧 queued 请求标 stale（缺少可核验的真实 ID 映射，不自动重发）
      if (!parseRecommendationInputV2(task.inputJson)) {
        await deps.updateStatus(task.id, ['queued'], 'stale', {
          finishedAt: new Date().toISOString(),
          errorKind: 'legacy_input',
          errorSummary: '这条推荐是旧版本请求，缺少可核验的输入快照；请重新生成（不会自动重发）',
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

    // S1：执行只依据入队快照（claimNext 已确保 V2 可解析）
    const stored = parseRecommendationInputV2(task.inputJson);
    if (!stored) {
      await deps.updateStatus(task.id, ['running'], 'stale', {
        finishedAt: new Date().toISOString(),
        errorKind: 'legacy_input',
        errorSummary: '缺少可核验的输入快照，请重新生成',
      });
      deps.onSettled?.();
      return;
    }

    // 发送前复核：快照内单品可用性与资料版本（不满足标 stale 保留原请求，不静默舍弃锁定项）
    const validation = await deps.validateSnapshotItems(
      stored.items.map((item) => ({ realId: item.realId, revision: item.revision })),
    );
    if (!validation.ok) {
      await deps.updateStatus(task.id, ['running'], 'stale', {
        finishedAt: new Date().toISOString(),
        errorKind: 'input_changed',
        errorSummary: validation.message,
      });
      deps.onSettled?.();
      return;
    }

    // 提示词档案直接来自快照（别名只作本次请求的传输编号）
    const items: ProfileItem[] = stored.items.map((item) => ({
      id: item.alias,
      name: item.name,
      category: item.category,
      attributes: item.attributes,
      colors: item.colors,
    }));
    const idByAlias = aliasMapOf(stored);
    const aliasByRealId = new Map([...idByAlias].map(([alias, realId]) => [realId, alias]));
    const lockedAliases = stored.lockedRealIds
      .map((realId) => aliasByRealId.get(realId))
      .filter((alias): alias is string => !!alias);
    const body = sanitizeBody(stored.body);
    const preferences = sanitizePreferences(stored.preferences);
    const note = sanitizeNote(stored.note);
    const profileNote = stored.truncated
      ? `（衣物较多，本次仅送入 ${stored.items.length}/${stored.totalCount} 件：锁定单品与较早入库优先；其余未参与本次推荐）`
      : undefined;
    const replacementNote = replacementNoteFor(stored);

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
            content: recommendationUserPrompt({
              items,
              scene: stored.scene,
              body,
              lockedAliases,
              preferences,
              note,
              profileNote,
              replacementNote,
            }),
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
    // 本地校验：锁定完整 + 品类与槽位一致 + 局部替换的可变范围（F8）
    const categoryByAlias = new Map(
      stored.items.filter((item) => item.category).map((item) => [item.alias, item.category as string]),
    );
    const replacement: ReplacementRule | undefined =
      stored.mode === 'replace_slot' && stored.targetSlot
        ? {
            lockedAliases,
            targetRole: UI_SLOT_TO_ROLE[stored.targetSlot] ?? (stored.targetSlot as SlotRole),
            baselineRoles: Object.fromEntries(
              Object.entries(stored.baseline?.slots ?? {})
                .map(([slot, realId]) => [UI_SLOT_TO_ROLE[slot] ?? slot, aliasByRealId.get(realId)] as const)
                .filter((entry): entry is [SlotRole, string] => !!entry[1]),
            ),
          }
        : undefined;
    const normalized = normalizeRecommendation(parsedContent.value, idByAlias, {
      requireLockedAliases: lockedAliases,
      categoryByAlias,
      replacement,
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

/** 提示词版本（store 入队指纹用） */
export { RECOMMENDATION_PROMPT_VERSION };
