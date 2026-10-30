// 上身预览任务执行器（M5 轨 A）：与 garmentTaskRunner 相同的状态机语义，
// 但只服务 try_on_preview 任务：领取 queued → 发送前写 running → 生成 → 落盘提交。
// 边界：恢复记录 ≠ 恢复计算进度；不自动重发（interrupted 留给用户手动重试）；
// 任务中途归档/删除的取消联动后续按需要接入。

import { callRevisionOf, type ModelConfig } from './types';
import { generateImage } from './minimaxClient';
import {
  getPreviewTask,
  listPreviewTasksByStatus,
  type PreviewTask,
  type PreviewTaskStatus,
} from '../../data/repositories/previewRepository';

export interface PreviewSlotItem {
  itemId: string;
  name: string;
  category: string;
}

export interface PreviewRunnerDeps {
  listQueued(): Promise<PreviewTask[]>;
  listRunning(): Promise<PreviewTask[]>;
  getTask(id: string): Promise<PreviewTask | null>;
  markRunning(id: string): Promise<boolean>;
  updateStatus(
    id: string,
    allowedFrom: PreviewTaskStatus[],
    to: PreviewTaskStatus,
    patch?: { errorKind?: string | null; errorSummary?: string | null; finishedAt?: string | null },
  ): Promise<boolean>;
  getConfig(id: string): ModelConfig | undefined;
  getApiKey(keyRef: string): Promise<string | null>;
  /** 读取人物参考（含版本）；缺失时任务标 failed(reference_missing) */
  readReferenceDataUrl(): Promise<{ dataUrl: string; updatedAt: string } | null>;
  /** 槽位单品描述（名称/品类），组装提示词 */
  describeItems(itemIds: string[]): Promise<PreviewSlotItem[]>;
  generate(input: {
    config: Pick<ModelConfig, 'urlKind' | 'baseUrl' | 'modelId'>;
    apiKey: string;
    prompt: string;
    personDataUrl: string;
    signal: AbortSignal;
  }): Promise<{ ok: true; imageUrl: string } | { ok: false; kind: string; message: string }>;
  saveResultImage(taskId: string, url: string, prompt: string): Promise<string>;
  onSettled?(): void;
  subscribeChanges?(listener: () => void): () => void;
}

export interface PreviewRunner {
  start(): void;
  setForeground(value: boolean): void;
  recover(): Promise<void>;
  handleExternalChange(): Promise<void>;
}

/** 结果未知的错误类别：可能已被服务受理，标为中断并允许用户手动重试 */
const UNKNOWN_OUTCOME_KINDS: readonly string[] = ['timeout', 'network', 'cancelled', 'quota'];

export function createPreviewTaskRunner(deps: PreviewRunnerDeps): PreviewRunner {
  let started = false;
  let foreground = false;
  let loopRunning = false;
  let unsubscribe: (() => void) | null = null;
  const inflight = new Set<string>();

  function buildPrompt(items: PreviewSlotItem[], wearStyle: string): string {
    const parts = items.map((item) => `${item.category}（${item.name}）`);
    const wearText = wearStyle && wearStyle !== '自然垂放' ? `穿法：${wearStyle}。` : '';
    return [
      '让图中人物穿上以下衣物，保持人物的脸部、发型、肤色与姿态不变，只替换衣着：',
      ...parts.map((part, index) => `${index + 1}. ${part}`),
      wearText,
      '全身照，自然站姿，简洁室内背景，真实感风格，不添加衣物清单以外的显著服饰。',
    ].join('\n');
  }

  async function claimNext(): Promise<PreviewTask | null> {
    const queued = await deps.listQueued();
    for (const task of queued) {
      const config = deps.getConfig(task.configId);
      if (!config || callRevisionOf(config) !== task.configRevision) {
        await deps.updateStatus(task.id, ['queued'], 'blocked', {
          finishedAt: new Date().toISOString(),
          errorKind: 'config_changed',
          errorSummary: '所选模型配置已被修改或删除，请重新选择后再生成',
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

  async function runClaimed(task: PreviewTask, markSent: () => void): Promise<void> {
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

    const reference = await deps.readReferenceDataUrl();
    if (!reference) {
      await deps.updateStatus(task.id, ['running'], 'failed', {
        finishedAt: new Date().toISOString(),
        errorKind: 'reference_missing',
        errorSummary: '人物参考照已不存在，请到“我的 → 人物参考”重新准备',
      });
      return;
    }

    const items = await deps.describeItems(task.itemIds);
    const prompt = buildPrompt(items, task.wearStyle);

    const controller = new AbortController();
    inflight.add(task.id);
    markSent();
    let outcome: { ok: true; imageUrl: string } | { ok: false; kind: string; message: string };
    try {
      outcome = await deps.generate({
        config: { urlKind: config.urlKind, baseUrl: config.baseUrl, modelId: config.modelId },
        apiKey,
        prompt,
        personDataUrl: reference.dataUrl,
        signal: controller.signal,
      });
    } finally {
      inflight.delete(task.id);
    }

    const now = new Date().toISOString();
    if (!outcome.ok) {
      if (UNKNOWN_OUTCOME_KINDS.includes(outcome.kind)) {
        await deps.updateStatus(task.id, ['running'], 'interrupted', {
          finishedAt: now,
          errorKind: outcome.kind,
          errorSummary: outcome.message,
        });
        return;
      }
      await deps.updateStatus(task.id, ['running'], 'failed', {
        finishedAt: now,
        errorKind: outcome.kind,
        errorSummary: outcome.message,
      });
      return;
    }

    try {
      await deps.saveResultImage(task.id, outcome.imageUrl, prompt);
      await deps.updateStatus(task.id, ['running'], 'succeeded', { finishedAt: now });
    } catch (error) {
      await deps.updateStatus(task.id, ['running'], 'failed', {
        finishedAt: now,
        errorKind: 'save_failed',
        errorSummary: `生成图保存失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function execute(task: PreviewTask): Promise<void> {
    // 兜底：任何路径都以“状态落库 + 通知”结束，绝不让任务停留在 running（与衣物分析执行器一致）
    let sent = false;
    try {
      await runClaimed(task, () => {
        sent = true;
      });
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
    for (const id of [...inflight]) {
      const current = await deps.getTask(id);
      if (!current || current.status !== 'running') inflight.delete(id);
    }
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
      // 遗留 running 保守标为 interrupted：极端情况下可能尚未真正发送，优先避免重复计费
      const running = await deps.listRunning();
      for (const task of running) {
        const changed = await deps.updateStatus(task.id, ['running'], 'interrupted', {
          finishedAt: new Date().toISOString(),
          errorKind: 'interrupted',
          errorSummary: '应用被中断，本次生成结果未知；可重试',
        });
        if (changed) deps.onSettled?.();
      }
    },
    handleExternalChange,
  };
}
