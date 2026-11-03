// 上身预览的轻量会话状态（M5 轨 A）：模块级执行器单例、变化通知、入队与模型解析。
// 不是持久化真源：任务状态与结果以数据库为准。
// 边界：MiniMax 客户端不支持外部取消信号——尽力中止不可用；中断表达依赖任务状态机
// （超时/网络错误 → interrupted，允许手动重试）。

import * as ImageManipulator from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';
import { getConfig, getApiKey } from '../services/ai/configStore';
import { callRevisionOf } from '../services/ai/types';
import { resolveImageGenConfig, resolveVisionConfig, type ConfigResolution } from '../services/ai/visionConfig';
import { createPreviewTaskRunner, type PreviewRunner, type PreviewSlotItem } from '../services/ai/previewTaskRunner';
import { buildGarmentFeatureView } from '../services/ai/garmentView';
import { WEAR_STYLE_VALUES } from '../services/ai/recommendationService';
import { checkerSystemPrompt, checkerUserPrompt } from '../services/ai/previewChecker';
import { chatCompletion } from '../services/ai/openaiClient';
import { generateImage } from '../services/ai/minimaxClient';
import { getItem } from '../data/repositories/itemRepository';
import { getAnalysisView } from '../data/repositories/attributeRepository';
import { getMainPhotoPaths } from '../data/repositories/photoRepository';
import { getDefaultConfigId, setDefaultConfigId } from '../data/repositories/taskRepository';
import { GARMENT_ANALYSIS_KIND } from '../data/repositories/analysisTypes';
import {
  savePreviewCheck,
  getLatestPreviewCheck,
  type PreviewCheckRecord,
} from '../data/repositories/previewCheckRepository';
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
      describeItems: async (itemIds, itemWear) => {
        const out: PreviewSlotItem[] = [];
        for (const itemId of itemIds) {
          const item = await getItem(itemId);
          if (!item) continue;
          const view = await getAnalysisView(itemId);
          // A2 归一化视图（与推荐输入、C8 约束快照同源）：关键特征/次要分层，未知不猜填
          const features = buildGarmentFeatureView({
            category: view.category.value,
            colors: view.colors.value,
            attributes: view.attributes,
          });
          out.push({
            itemId,
            // A1：用户实际名称优先于 AI 名称建议
            name: item.name ?? view.suggestedName?.value ?? '未命名',
            category: features.category ?? '衣物',
            mainColor: features.mainColor,
            accentColorNames: features.accentColorNames,
            keyFeatures: features.keyFeatures,
            secondary: features.secondary,
            // C4：逐件穿法来自入队快照（按件覆盖全局穿法）
            wearStyle: itemWear?.[itemId] ?? null,
          });
        }
        return out;
      },
      generate: async (input) => {
        // minimaxClient 自带 120s 超时；不支持外部取消信号（见文件头边界说明）。
        // 硬超时防线（150s）：即使客户端超时在个别 RN 环境失效，任务也必达终态，不永挂 running。
        const HARD_TIMEOUT_MS = 150000;
        type GenerationOutcome = { ok: true; imageUrl: string } | { ok: false; kind: string; message: string };
        const hardTimeout = new Promise<GenerationOutcome>((resolve) => {
          setTimeout(() => resolve({ ok: false, kind: 'timeout', message: '生成超时（150 秒硬超时）' }), HARD_TIMEOUT_MS);
        });
        const call = (async (): Promise<GenerationOutcome> => {
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
        })();
        return Promise.race([call, hardTimeout]);
      },
      saveResultImage: (taskId, url, prompt) =>
        import('../data/repositories/previewRepository').then((m) => m.savePreviewResultImage(taskId, url, prompt)),
      // R8：生成成功但落盘失败时持久化下载地址，供"仅重试下载"（不重新生成、不重复计费）
      savePendingDownload: (taskId, url, prompt) =>
        import('../data/repositories/previewRepository').then((m) => m.savePendingDownload(taskId, url, prompt)),
      // C2/R5 发送前复核：单品可用性与资料版本、人物参考版本与入队快照一致
      validateInput: async (itemIds, itemRevisions, referenceUpdatedAt) => {
        for (const itemId of itemIds) {
          const item = await getItem(itemId);
          if (!item || item.status !== 'active') {
            return { ok: false as const, message: `搭配中的「${itemId}」已删除或归档，方案已变化，请重新生成预览` };
          }
          const expected = itemRevisions[itemId];
          if (typeof expected === 'number' && item.revision !== expected) {
            return { ok: false as const, message: `「${item.name ?? itemId}」的资料在生成等待期间被修改（换图/改属性），旧图不能冒充当前输入，请重新生成预览` };
          }
        }
        const reference = await getPreviewReference();
        if (!reference) {
          return { ok: false as const, message: '人物参考照已不存在，方案无法按原输入生成，请重新准备参考后再生成' };
        }
        if (reference.updatedAt !== referenceUpdatedAt) {
          return { ok: false as const, message: '人物参考照已更换，旧任务不能冒充当前人物输入，请重新生成预览' };
        }
        return { ok: true as const };
      },
      onSettled: notifyPreviewChanged,
      // C8 防偏闭环依赖：核对路由（与衣物分析同源视觉默认，无则诚实未核对）、
      // 核对输入图（单品缩略图+人物参考+生成结果）、多图视觉核对调用、记录落库
      getChecker: async () => {
        const resolution = await resolveVisionConfig(await getDefaultConfigId(GARMENT_ANALYSIS_KIND));
        if (resolution.status !== 'ready') return { status: 'missing' as const };
        const apiKey = await getApiKey(resolution.config.keyRef);
        if (!apiKey) return { status: 'missing' as const };
        return {
          status: 'ready' as const,
          config: {
            id: resolution.config.id,
            urlKind: resolution.config.urlKind,
            baseUrl: resolution.config.baseUrl,
            modelId: resolution.config.modelId,
          },
          apiKey,
          callRevision: resolution.callRevision,
        };
      },
      loadCheckImages: async (task) => {
        const garments: Array<{ itemId: string; dataUrl: string | null }> = [];
        for (const itemId of task.itemIds) {
          const paths = await getMainPhotoPaths(itemId);
          if (!paths) {
            garments.push({ itemId, dataUrl: null });
            continue;
          }
          const file = new File(Paths.document, paths.thumbPath);
          if (!file.exists) {
            garments.push({ itemId, dataUrl: null });
            continue;
          }
          const base64 = await file.base64();
          garments.push({ itemId, dataUrl: `data:image/jpeg;base64,${base64}` });
        }
        let person: string | null = null;
        const reference = await getPreviewReference();
        if (reference) {
          const refFile = new File(Paths.document, reference.path);
          if (refFile.exists) person = `data:image/jpeg;base64,${await refFile.base64()}`;
        }
        let result: string | null = null;
        if (task.resultPreviewPath) {
          const resultFile = new File(Paths.document, task.resultPreviewPath);
          if (resultFile.exists) result = `data:image/jpeg;base64,${await resultFile.base64()}`;
        }
        return { garments, person, result };
      },
      runCheck: async (input) => {
        const chat = await chatCompletion(
          input.config,
          input.apiKey,
          [
            { role: 'system', content: input.systemPrompt },
            {
              role: 'user',
              content: [
                { type: 'text', text: input.userPrompt },
                ...input.images.map((url) => ({ type: 'image_url', image_url: { url } })),
              ],
            },
          ],
          90000,
          { maxTokens: 2048 },
        );
        return chat.ok ? { ok: true as const, content: chat.content } : { ok: false as const, kind: chat.error?.kind ?? 'unknown', message: chat.error?.message ?? '核对调用失败' };
      },
      saveCheck: (record) => savePreviewCheck(record),
      subscribeChanges: subscribePreviewChanges,
    });
  }
  return runner;
}

/** 解析可用的图像生成模型（读取本地配置与安全存储，不发网络请求） */
export async function resolveImageGenForPreview(): Promise<ConfigResolution> {
  return resolveImageGenConfig(await getDefaultConfigId(PREVIEW_TASK_KIND));
}

/** 任务最近一次防偏核对记录（面板展示；null=尚无记录） */
export async function loadLatestPreviewCheck(taskId: string): Promise<PreviewCheckRecord | null> {
  return getLatestPreviewCheck(taskId);
}

/** R8：仅重试下载（生成成功但保存失败的任务；不重新生成、不重复计费） */
export async function retryPreviewSave(taskId: string): Promise<string> {
  const { retryPreviewDownload } = await import('../data/repositories/previewRepository');
  const path = await retryPreviewDownload(taskId);
  notifyPreviewChanged();
  return path;
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
  /** 逐件穿法（C4，itemId → 穿法）；随入队快照持久化并逐件进提示词 */
  itemWear?: Record<string, string | undefined>;
  /** 已就绪（ready）或用户已选定的图像生成配置 ID */
  configId: string;
}

export type EnqueuePreviewResult =
  | { status: 'created'; taskId: string }
  | { status: 'existing'; taskId: string }
  | { status: 'rejected'; reason: 'reference_missing' | 'items_invalid'; message?: string };

/** 当前方案的输入版本（C2）：单品集 + 各单品资料版本 + 穿法 + 人物参考版本。
 * 供面板做“本方案/方案已变化”判定与入队快照；单品缺失/不可用返回 null。 */
export async function loadCurrentPreviewInput(
  itemIds: string[],
  wearStyle: string,
): Promise<{
  itemIds: string[];
  itemRevisions: Record<string, number>;
  wearStyle: string;
  referenceUpdatedAt: string;
} | null> {
  const reference = await getPreviewReference();
  if (!reference) return null;
  const itemRevisions: Record<string, number> = {};
  for (const itemId of itemIds) {
    const item = await getItem(itemId);
    if (!item || item.status !== 'active' || !item.category) return null;
    itemRevisions[itemId] = item.revision;
  }
  return { itemIds, itemRevisions, wearStyle, referenceUpdatedAt: reference.updatedAt };
}

/** 入队一次预览生成（模型选择由面板先完成；参考照缺失或单品不可用时拒绝） */
export async function enqueuePreview(input: EnqueuePreviewInput): Promise<EnqueuePreviewResult> {
  const reference = await getPreviewReference();
  if (!reference) return { status: 'rejected', reason: 'reference_missing' };

  const config = getConfig(input.configId);
  if (!config) return { status: 'rejected', reason: 'reference_missing' };

  // C2：入队快照固定各单品资料版本与参考版本；执行时校验，变化即 stale
  const itemRevisions: Record<string, number> = {};
  for (const itemId of input.itemIds) {
    const item = await getItem(itemId);
    if (!item || item.status !== 'active') {
      return {
        status: 'rejected',
        reason: 'items_invalid',
        message: '搭配里有已删除或不可用的衣物，请先调整方案再生成预览',
      };
    }
    itemRevisions[itemId] = item.revision;
  }

  const requestKey = `${createActionId()}:${input.basisItemId}`;
  // C4：逐件穿法清洗（只保留白名单值与在案单品）
  const itemWear: Record<string, string> = {};
  for (const itemId of input.itemIds) {
    const style = input.itemWear?.[itemId];
    if (typeof style === 'string' && WEAR_STYLE_VALUES.includes(style as (typeof WEAR_STYLE_VALUES)[number])) {
      itemWear[itemId] = style;
    }
  }
  const result = await createPreviewTask({
    basisItemId: input.basisItemId,
    itemIds: input.itemIds,
    itemRevisions,
    wearStyle: input.wearStyle,
    itemWear,
    // C3：参考视角随快照（生成时如实说明证据范围）
    referenceKind: reference.kind,
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
