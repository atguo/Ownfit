// 上身预览的轻量会话状态（M5 轨 A）：模块级执行器单例、变化通知、入队与模型解析。
// 不是持久化真源：任务状态与结果以数据库为准。
// 边界：MiniMax 客户端不支持外部取消信号——尽力中止不可用；中断表达依赖任务状态机
// （超时/网络错误 → interrupted，允许手动重试）。

import * as ImageManipulator from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';
import { getConfig, getApiKey } from '../services/ai/configStore';
import { callRevisionOf } from '../services/ai/types';
import { resolveImageGenConfig, type ConfigResolution } from '../services/ai/visionConfig';
import { createPreviewTaskRunner, type PreviewRunner } from '../services/ai/previewTaskRunner';
import { generateImage } from '../services/ai/minimaxClient';
import { getItem } from '../data/repositories/itemRepository';
import { getDefaultConfigId, setDefaultConfigId } from '../data/repositories/taskRepository';
import {
  createPreviewTask,
  getPreviewReference,
  getPreviewTask,
  listPreviewTasksByStatus,
  PREVIEW_TASK_KIND,
  updatePreviewTaskStatus,
} from '../data/repositories/previewRepository';

export type PreviewChangeListener = () => void;
const listeners = new Set<PreviewChangeListener>();

export function subscribePreviewChanges(listener: PreviewChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyPreviewChanged(): void {
  for (const listener of [...listeners]) listener();
}

export function createActionId(): string {
  return `prev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

let runner: PreviewRunner | null = null;

export function initPreviewRunner(): PreviewRunner {
  if (!runner) {
    runner = createPreviewTaskRunner({
      listQueued: () => listPreviewTasksByStatus('queued'),
      listRunning: () => listPreviewTasksByStatus('running'),
      getTask: getPreviewTask,
      markRunning: (id) => updatePreviewTaskStatus(id, ['queued'], 'running'),
      updateStatus: updatePreviewTaskStatus,
      getConfig,
      getApiKey,
      readReferenceDataUrl: async () => {
        const reference = await getPreviewReference();
        if (!reference) return null;
        const file = new File(Paths.document, reference.path);
        if (!file.exists) return null;
        const base64 = await file.base64();
        return { dataUrl: `data:image/jpeg;base64,${base64}`, updatedAt: reference.updatedAt };
      },
      describeItems: async (itemIds) => {
        const out: Array<{ itemId: string; name: string; category: string }> = [];
        for (const itemId of itemIds) {
          const item = await getItem(itemId);
          if (!item) continue;
          out.push({ itemId, name: item.name ?? '未命名', category: item.category ?? '衣物' });
        }
        return out;
      },
      generate: async (input) => {
        // minimaxClient 自带 120s 超时；不支持外部取消信号（见文件头边界说明）
        void input.signal;
        const result = await generateImage(
          input.config,
          input.apiKey,
          { prompt: input.prompt, personImage: input.personDataUrl, aspectRatio: '2:3', n: 1 },
        );
        if (result.ok && result.imageUrls.length > 0) {
          return { ok: true as const, imageUrl: result.imageUrls[0] };
        }
        return {
          ok: false as const,
          kind: result.error?.kind ?? 'unknown',
          message: result.error?.message ?? '生成失败',
        };
      },
      saveResultImage: (taskId, url, prompt) =>
        import('../data/repositories/previewRepository').then((m) => m.savePreviewResultImage(taskId, url, prompt)),
      onSettled: notifyPreviewChanged,
      subscribeChanges: subscribePreviewChanges,
    });
  }
  return runner;
}

/** 解析可用的图像生成模型（读取本地配置与安全存储，不发网络请求） */
export async function resolveImageGenForPreview(): Promise<ConfigResolution> {
  return resolveImageGenConfig(await getDefaultConfigId(PREVIEW_TASK_KIND));
}

/** 记住预览默认图像生成模型（用户在候选中明确选择后调用） */
export async function rememberDefaultImageGenConfig(configId: string): Promise<void> {
  await setDefaultConfigId(configId, PREVIEW_TASK_KIND);
  notifyPreviewChanged();
}

export interface EnqueuePreviewInput {
  basisItemId: string;
  itemIds: string[];
  wearStyle: string;
  /** 已就绪（ready）或用户已选定的图像生成配置 ID */
  configId: string;
}

export type EnqueuePreviewResult =
  | { status: 'created'; taskId: string }
  | { status: 'existing'; taskId: string }
  | { status: 'rejected'; reason: 'reference_missing' };

/** 入队一次预览生成（模型选择由面板先完成；参考照缺失时拒绝） */
export async function enqueuePreview(input: EnqueuePreviewInput): Promise<EnqueuePreviewResult> {
  const reference = await getPreviewReference();
  if (!reference) return { status: 'rejected', reason: 'reference_missing' };

  const config = getConfig(input.configId);
  if (!config) return { status: 'rejected', reason: 'reference_missing' };

  const requestKey = `${createActionId()}:${input.basisItemId}`;
  const result = await createPreviewTask({
    basisItemId: input.basisItemId,
    itemIds: input.itemIds,
    wearStyle: input.wearStyle,
    referenceUpdatedAt: reference.updatedAt,
    configId: config.id,
    configSnapshot: JSON.stringify({
      id: config.id,
      name: config.name,
      urlKind: config.urlKind,
      baseUrl: config.baseUrl,
      modelId: config.modelId,
    }),
    configRevision: callRevisionOf(config),
    requestKey,
  });
  notifyPreviewChanged();
  return result;
}
