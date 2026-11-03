// 上身预览任务执行器（M5 轨 A）：与 garmentTaskRunner 相同的状态机语义，
// 但只服务 try_on_preview 任务：领取 queued → 发送前写 running → 生成 → 落盘提交。
// 边界：恢复记录 ≠ 恢复计算进度；不自动重发（interrupted 留给用户手动重试）；
// 任务中途归档/删除的取消联动后续按需要接入。

import { callRevisionOf, type ModelConfig } from './types';
import { generateImage } from './minimaxClient';
import {
  buildCorrections,
  checkerSystemPrompt,
  checkerUserPrompt,
  parseCheckerContent,
  type CheckerConstraintItem,
} from './previewChecker';
import {
  getPreviewTask,
  listPreviewTasksByStatus,
  type PreviewTask,
  type PreviewTaskStatus,
} from '../../data/repositories/previewRepository';
import type { PreviewItemVerdict, PreviewCheckOverall } from '../../data/repositories/previewCheckRepository';

export interface PreviewSlotItem {
  itemId: string;
  name: string;
  category: string;
  /** 主色（含 hex，来自有效视图；C8 核对与防偏同源） */
  mainColor?: { name: string; hex: string } | null;
  /** 其余颜色名 */
  accentColorNames?: string[];
  /** 关键特征（身份层：图案/领型/袖型/长度/开合/版型…，A2 归一化视图输出） */
  keyFeatures: string[];
  /** 次要描述（"细节"等自由文本；超预算时先压缩，不参与身份判断） */
  secondary: string[];
  /** 逐件穿法（C4：来自方案 per-item wearStyle；缺省回退全局穿法） */
  wearStyle?: string | null;
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
  /** 槽位单品描述（名称/品类），组装提示词；itemWear 为逐件穿法（C4，按件覆盖） */
  describeItems(itemIds: string[], itemWear?: Record<string, string>): Promise<PreviewSlotItem[]>;
  /** C2/R5 发送前复核：单品仍可用且资料版本与入队快照一致、人物参考版本一致。
   * 不一致返回 {ok:false,message}，任务标 stale——旧图不能冒充当前输入的生成结果。 */
  validateInput(
    itemIds: string[],
    itemRevisions: Record<string, number>,
    referenceUpdatedAt: string,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  generate(input: {
    config: Pick<ModelConfig, 'urlKind' | 'baseUrl' | 'modelId'>;
    apiKey: string;
    prompt: string;
    personDataUrl: string;
    signal: AbortSignal;
  }): Promise<{ ok: true; imageUrl: string } | { ok: false; kind: string; message: string }>;
  saveResultImage(taskId: string, url: string, prompt: string): Promise<string>;
  /** 生成成功但落盘失败时持久化供应商下载地址（R8：支持仅重试下载，不重新生成） */
  savePendingDownload(taskId: string, url: string, prompt: string): Promise<void>;
  /** C8 核对路由：ready=已配置视觉模型（与衣物分析同源默认，不发网络请求）；
   * missing=未配置（诚实登记 unchecked，不冒充已核对） */
  getChecker(): Promise<
    | { status: 'ready'; config: Pick<ModelConfig, 'id' | 'urlKind' | 'baseUrl' | 'modelId'>; apiKey: string; callRevision: string }
    | { status: 'missing' }
  >;
  /** C8 核对输入图：单品原图（缩略图 data URL，读不到为 null）、人物参考、生成结果 */
  loadCheckImages(task: PreviewTask): Promise<{
    garments: Array<{ itemId: string; dataUrl: string | null }>;
    person: string | null;
    result: string | null;
  }>;
  /** C8 视觉核对调用（OpenAI 兼容多图 chat） */
  runCheck(input: {
    config: Pick<ModelConfig, 'urlKind' | 'baseUrl' | 'modelId'>;
    apiKey: string;
    systemPrompt: string;
    userPrompt: string;
    images: string[];
  }): Promise<{ ok: true; content: string } | { ok: false; kind: string; message: string }>;
  /** C8 核对记录落库（preview_checks；生成成功与核对状态分开登记） */
  saveCheck(record: {
    taskId: string;
    personRefVersion: string | null;
    garmentVersions: string;
    checkerConfigId: string;
    checkerRevision: string;
    verdicts: PreviewItemVerdict[];
    overall: PreviewCheckOverall;
    retryCount: number;
  }): Promise<void>;
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

/** 入队快照（C2）：单品集 + 各单品资料版本 + 穿法（含逐件，C4）+ 人物参考版本与视角（C3） */
interface StoredPreviewInput {
  itemIds?: string[];
  itemRevisions?: Record<string, number>;
  wearStyle?: string;
  itemWear?: Record<string, string>;
  referenceKind?: string | null;
  referenceUpdatedAt?: string;
}

function parseStoredPreviewInput(inputJson: string | null): StoredPreviewInput | null {
  if (!inputJson) return null;
  try {
    const parsed = JSON.parse(inputJson) as StoredPreviewInput;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.itemIds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** C3：参考视角 → 提示词诚实说明。面部特写不假定模型知道本人身材，明确差异边界。 */
function referenceNoteFor(kind?: string | null): string {
  if (kind === 'face') {
    return '人物参考为面部特写：生成图的身材比例与体型由模型推断，可能与本人不同，不能作为合身判断依据。';
  }
  if (kind === 'full_body') {
    return '人物参考为全身照：人物的体型与比例以参考照为准。';
  }
  return '';
}

/** C7 提示词字符预算：超出按可解释规则压缩（先去次要层，再保身份层），仍超则显式失败，
 * 绝不静默截掉末尾衣物（截断会让后面的单品"整件消失"）。 */
export const PREVIEW_PROMPT_BUDGET = 6000;

/** C7（2026-11-04）：按重要性组织提示词——先全部单品身份（品类/主色/关键特征/逐件穿法），
 * 再次要描述；支持注入纠偏约束（C8 有界纠偏）与参考视角说明（C3）。返回是否压缩与是否仍超预算。 */
export function buildPrompt(
  items: PreviewSlotItem[],
  wearStyle: string,
  corrections: string[] = [],
  referenceNote = '',
): { text: string; compressed: boolean; overBudget: boolean } {
  const itemLine = (item: PreviewSlotItem, withSecondary: boolean): string => {
    const parts = [item.category];
    if (item.name) parts.push(`名称=${item.name}`);
    if (item.mainColor) parts.push(`主色=${item.mainColor.name}(${item.mainColor.hex})`);
    if (item.accentColorNames?.length) parts.push(`配色=${item.accentColorNames.join('/')}`);
    if (item.keyFeatures.length) parts.push(item.keyFeatures.join('，'));
    const itemWear = item.wearStyle && item.wearStyle !== '自然垂放' ? `穿法=${item.wearStyle}` : '';
    if (itemWear) parts.push(itemWear);
    if (withSecondary && item.secondary.length) parts.push(`细节：${item.secondary.join('，')}`);
    return parts.join('；');
  };

  const header = '让图中人物穿上以下衣物，保持人物的脸部、发型、肤色与姿态不变，只替换衣着：';
  const wearText =
    wearStyle && wearStyle !== '自然垂放' ? `穿法：${wearStyle}。` : '';
  const correctionText = corrections.length
    ? `重点约束（上一次生成在以下方面偏离，本次必须修正）：\n${corrections.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    : '';
  const footers = [
    '保持人物的脸部、发型、肤色、体型和姿势完全不变，服装的颜色、图案、领口、袖型和长度严格符合上述描述。',
    '人物完整全身入镜：从头到脚完整呈现，不裁切腿部与鞋履。',
    '自然站姿，简洁室内背景，真实感照片风格，不添加衣物清单以外的显著服饰。',
  ];

  const assemble = (withSecondary: boolean): string =>
    [
      header,
      ...items.map((item, index) => `${index + 1}. ${itemLine(item, withSecondary)}`),
      wearText,
      correctionText,
      ...(referenceNote ? [referenceNote] : []),
      ...footers,
    ]
      .filter(Boolean)
      .join('\n');

  const full = assemble(true);
  if (full.length <= PREVIEW_PROMPT_BUDGET) return { text: full, compressed: false, overBudget: false };
  // 第一次压缩：去次要层（细节描述），保留全部单品身份与关键特征
  const compressedText = assemble(false);
  if (compressedText.length <= PREVIEW_PROMPT_BUDGET) {
    return { text: compressedText, compressed: true, overBudget: false };
  }
  // 仍超预算：显式失败（错误说明会引导用户减少层数或简化资料），不静默丢单品
  return { text: compressedText, compressed: true, overBudget: true };
}

export function createPreviewTaskRunner(deps: PreviewRunnerDeps): PreviewRunner {
  let started = false;
  let foreground = false;
  let loopRunning = false;
  let unsubscribe: (() => void) | null = null;
  const inflight = new Set<string>();

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

    // C2/R5（2026-11-04）：发送前按入队快照复核——衣物可用性与资料版本、人物参考版本。
    // 不一致标 stale：更换照片/修改属性/删衣物后，旧任务不得继续把旧图标为当前输入生成。
    const stored = parseStoredPreviewInput(task.inputJson);
    if (stored) {
      const validation = await deps.validateInput(
        stored.itemIds ?? task.itemIds,
        stored.itemRevisions ?? {},
        stored.referenceUpdatedAt ?? reference.updatedAt,
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
    }

    const items = await deps.describeItems(task.itemIds, stored?.itemWear);
    // C7：按预算组织提示词（身份层优先）；仍超预算时显式失败，不静默截断。
    // C3：按参考视角追加诚实说明。
    const referenceNote = referenceNoteFor(stored?.referenceKind);
    const built = buildPrompt(items, task.wearStyle, [], referenceNote);
    if (built.overBudget) {
      await deps.updateStatus(task.id, ['running'], 'failed', {
        finishedAt: new Date().toISOString(),
        errorKind: 'prompt_over_budget',
        errorSummary: `本次搭配的衣物描述超出提示词预算（${PREVIEW_PROMPT_BUDGET} 字符）且无法在不丢失单品身份的前提下压缩；请减少层数或简化衣物资料后重试`,
      });
      deps.onSettled?.();
      return;
    }
    const prompt = built.text;

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
      // R8（2026-11-04）：生成已成功、仅保存失败——持久化供应商下载地址，
      // 用户可"仅重试下载"而不重新生成（不重复计费）。写入失败不影响终态标记。
      await deps
        .savePendingDownload(task.id, outcome.imageUrl, prompt)
        .catch(() => undefined);
      await deps.updateStatus(task.id, ['running'], 'failed', {
        finishedAt: now,
        errorKind: 'save_failed',
        errorSummary: `生成图保存失败：${error instanceof Error ? error.message : String(error)}（可仅重试下载，无需重新生成）`,
      });
      return;
    }

    // C8（2026-11-04）：生成成功后自动防偏核对（与生成状态分开登记）。
    // 独立于执行看门狗异步进行：核对/纠偏耗时不再拖长任务终态；
    // 全路径自兜底，不向调用方抛错，结束时通知订阅者刷新核对状态。
    const storedForCheck = parseStoredPreviewInput(task.inputJson);
    void runDriftCheck({
      task,
      items,
      wearStyle: task.wearStyle,
      referenceNote,
      personDataUrl: reference.dataUrl,
      personRefVersion: storedForCheck?.referenceUpdatedAt ?? reference.updatedAt,
      garmentVersions: JSON.stringify(storedForCheck?.itemRevisions ?? {}),
      imageConfig: config,
      apiKey,
      attempt: 0,
    });
  }

  /** C8 有界纠偏上限（决策 D-3）：重大偏离最多自动重试生成 1 次，超出即保留人工判断 */
  const MAX_AUTO_CORRECTIONS = 1;

  async function runDriftCheck(input: {
    task: PreviewTask;
    items: PreviewSlotItem[];
    wearStyle: string;
    referenceNote: string;
    personDataUrl: string;
    personRefVersion: string;
    garmentVersions: string;
    imageConfig: Pick<ModelConfig, 'id' | 'urlKind' | 'baseUrl' | 'modelId'>;
    apiKey: string;
    attempt: number;
  }): Promise<void> {
    const { task, items, wearStyle, attempt } = input;
    try {
      const constraints: CheckerConstraintItem[] = items.map((item) => ({
        itemId: item.itemId,
        name: item.name,
        category: item.category,
        mainColor: item.mainColor ?? null,
        keyFeatures: item.keyFeatures,
      }));
      const itemIds = constraints.map((c) => c.itemId);

      const checker = await deps.getChecker();
      if (checker.status !== 'ready') {
        await deps.saveCheck({
          taskId: task.id,
          personRefVersion: input.personRefVersion,
          garmentVersions: input.garmentVersions,
          checkerConfigId: 'none',
          checkerRevision: '',
          verdicts: [],
          overall: 'unchecked',
          retryCount: attempt,
        });
        return;
      }

      const images = await deps.loadCheckImages(task);
      const garmentUrls = images.garments.map((g) => g.dataUrl).filter((u): u is string => !!u);
      if (!images.result || garmentUrls.length === 0) {
        // 生成结果图或单品原图缺失：无法核对，如实登记 unknown（不当通过）
        await deps.saveCheck({
          taskId: task.id,
          personRefVersion: input.personRefVersion,
          garmentVersions: input.garmentVersions,
          checkerConfigId: checker.config.id ?? 'unknown',
          checkerRevision: checker.callRevision,
          verdicts: [],
          overall: 'unknown',
          retryCount: attempt,
        });
        return;
      }

      const outcome = await deps.runCheck({
        config: checker.config,
        apiKey: checker.apiKey,
        systemPrompt: checkerSystemPrompt(),
        userPrompt: checkerUserPrompt({ items: constraints, wearStyle }),
        images: [...garmentUrls, ...(images.person ? [images.person] : []), images.result],
      });
      if (!outcome.ok) {
        await deps.saveCheck({
          taskId: task.id,
          personRefVersion: input.personRefVersion,
          garmentVersions: input.garmentVersions,
          checkerConfigId: checker.config.id ?? 'unknown',
          checkerRevision: checker.callRevision,
          verdicts: [],
          overall: 'unknown',
          retryCount: attempt,
        });
        return;
      }
      const parsed = parseCheckerContent(outcome.content, itemIds);
      if (!parsed.ok) {
        await deps.saveCheck({
          taskId: task.id,
          personRefVersion: input.personRefVersion,
          garmentVersions: input.garmentVersions,
          checkerConfigId: checker.config.id ?? 'unknown',
          checkerRevision: checker.callRevision,
          verdicts: [],
          overall: 'unknown',
          retryCount: attempt,
        });
        return;
      }

      await deps.saveCheck({
        taskId: task.id,
        personRefVersion: input.personRefVersion,
        garmentVersions: input.garmentVersions,
        checkerConfigId: checker.config.id ?? 'unknown',
        checkerRevision: checker.callRevision,
        verdicts: parsed.value.verdicts,
        overall: parsed.value.overall,
        retryCount: attempt,
      });

      // 有界纠偏（D-3）：重大偏离且未达上限 → 补充证据支持的具体约束重新生成一次，再核对
      if (parsed.value.overall === 'major' && attempt < MAX_AUTO_CORRECTIONS) {
        const corrections = buildCorrections(parsed.value.verdicts, constraints);
        if (corrections.length > 0) {
          const retryPrompt = buildPrompt(items, wearStyle, corrections, input.referenceNote);
          if (!retryPrompt.overBudget) {
            const retry = await deps.generate({
              config: input.imageConfig,
              apiKey: input.apiKey,
              prompt: retryPrompt.text,
              personDataUrl: input.personDataUrl,
              signal: new AbortController().signal,
            });
            if (retry.ok) {
              try {
                await deps.saveResultImage(task.id, retry.imageUrl, retryPrompt.text);
                await runDriftCheck({ ...input, attempt: attempt + 1 });
                return;
              } catch {
                // 纠偏图保存失败：保留首次结果与其核对记录
              }
            }
            // 纠偏生成失败：保留首次结果与核对记录（不无限重试）
          }
        }
      }
    } catch {
      // 核对是辅助步骤：任何意外都不影响已成功的生成任务
    } finally {
      deps.onSettled?.();
    }
  }

  /** 执行级看门狗：整个 runClaimed 超过该时长仍未落终态时，标 interrupted 并通知。
   * 背景（2026-11-02 真机）：个别环境下 fetch abort / 内部 await 挂起，任务永停 running；
   * 看门狗不依赖具体挂点，保证任务必达终态。生成 120s + 下载 60s + 余量 = 240s。 */
  const EXECUTE_WATCHDOG_MS = 240000;

  async function execute(task: PreviewTask): Promise<void> {
    let sent = false;

    const run = (async (): Promise<'done' | 'error'> => {
      try {
        await runClaimed(task, () => {
          sent = true;
        });
        return 'done';
      } catch (error) {
        // 意外失败：发送过 → interrupted（结果未知），未发送 → failed；不留 running
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

    // 看门狗定时器在任务落终态后清理（R8：不残留 240s 定时器拖住进程/测试）
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    const watchdog = new Promise<'timeout'>((resolve) => {
      watchdogTimer = setTimeout(() => resolve('timeout'), EXECUTE_WATCHDOG_MS);
    });

    const outcome = await Promise.race([run, watchdog]);
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (outcome === 'timeout') {
      // 看门狗触发：runClaimed 仍未结束——按"发送过=结果未知"保守标 interrupted。
      // 迟到的 run 结果再落终态时，条件更新（allowedFrom=running）会拒绝，无双写。
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
