// 上身预览仓库（M5 轨 A）：
// - 人物参考照：相册选图压缩后落私有目录 files/preview-ref/reference.jpg（可移除、可替换），
//   preferences 表记录路径与版本（updatedAt 即参考版本，进入预览任务输入版本）。
// - 预览任务：复用 tasks 表（kind='try_on_preview'，item_id=basis 单品、photo_id='none'），
//   输入版本全部编码进 input_key 指纹（单品集+穿法+参考版本+配置+提示词版本）。
// - 生成结果落盘 files/previews/<taskId>.jpg，result_json 记录路径与提示词。
// 参考照仅发送给用户手动配置的图像生成服务（MiniMax subject_reference）。
// 规则沿用照片仓库：文件写入成功才落记录；移除时同时删文件与记录。

import * as ImageManipulator from 'expo-image-manipulator';
import { File, Directory, Paths } from 'expo-file-system';
import { getDb } from '../db';
import { updateTaskStatus } from './taskRepository';

const REFERENCE_ID = 'preview-reference';
const REFERENCE_RELATIVE_PATH = 'preview-ref/reference.jpg';
const REFERENCE_MAX_DIMENSION = 1024;

export interface PreviewReference {
  /** 相对路径（相对应用 document 目录） */
  path: string;
  /** 参考版本时间（进入预览任务输入版本） */
  updatedAt: string;
  /** C3 参考视角（用户声明）：面部特写 / 全身照。缺失为旧记录（未声明）。
   * 仅有脸部照时提示词不得假定模型知道本人身材（AI上身预览 §5 C3）。 */
  kind?: 'face' | 'full_body';
}

function refDir(): Directory {
  const dir = new Directory(Paths.document, 'preview-ref');
  if (!dir.exists) dir.create();
  return dir;
}

export async function getPreviewReference(): Promise<PreviewReference | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM preferences WHERE id = ?',
    REFERENCE_ID,
  );
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value) as PreviewReference;
      if (!parsed?.path) return null;
      // 文件被清理时视为无参考（记录不假装有效）
      if (!new File(Paths.document, parsed.path).exists) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  // 自愈：文件已落盘但记录缺失（上次写入记录失败/进程被杀）——重建记录而不是让用户重选
  const file = new File(Paths.document, REFERENCE_RELATIVE_PATH);
  if (!file.exists) return null;
  const record: PreviewReference = {
    path: REFERENCE_RELATIVE_PATH,
    updatedAt: file.modificationTime ? new Date(file.modificationTime).toISOString() : new Date().toISOString(),
  };
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO preferences (id, value, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    REFERENCE_ID,
    JSON.stringify(record),
    'user_selected',
    now,
    now,
  );
  return record;
}

/**
 * 从相册选图保存人物参考：压缩到 ≤1024px 后移入私有目录，再写记录。
 * 任一步失败清理残留并抛出。
 */
export async function savePreviewReference(input: {
  sourceUri: string;
  sourceWidth: number;
  sourceHeight: number;
}): Promise<PreviewReference> {
  const builder = ImageManipulator.ImageManipulator.manipulate(input.sourceUri);
  if (input.sourceWidth > REFERENCE_MAX_DIMENSION || input.sourceHeight > REFERENCE_MAX_DIMENSION) {
    const scale = REFERENCE_MAX_DIMENSION / Math.max(input.sourceWidth, input.sourceHeight);
    builder.resize({
      width: Math.round(input.sourceWidth * scale),
      height: Math.round(input.sourceHeight * scale),
    });
  }
  const rendered = await builder.renderAsync();
  const saved = await rendered.saveAsync({ compress: 0.85, format: ImageManipulator.SaveFormat.JPEG });

  const dir = refDir();
  const target = new File(dir, 'reference.jpg');
  if (target.exists) target.delete();
  new File(saved.uri).move(target);

  const record: PreviewReference = {
    path: REFERENCE_RELATIVE_PATH,
    updatedAt: new Date().toISOString(),
  };
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO preferences (id, value, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    REFERENCE_ID,
    JSON.stringify(record),
    'user_selected',
    now,
    now,
  );
  return record;
}

/** 移除人物参考（文件与记录一并清除；不存在时静默） */
export async function removePreviewReference(): Promise<void> {
  const db = await getDb();
  const current = await getPreviewReference();
  if (current) {
    const file = new File(Paths.document, current.path);
    if (file.exists) file.delete();
  }
  await db.runAsync('DELETE FROM preferences WHERE id = ?', REFERENCE_ID);
}

/** C3：声明参考视角（面部特写/全身照）。视角影响提示词的诚实表述，
 * 变化视为参考版本变化（updatedAt 前移），旧预览不再标注"本方案"。 */
export async function setPreviewReferenceKind(kind: 'face' | 'full_body'): Promise<void> {
  const current = await getPreviewReference();
  if (!current) return;
  const record: PreviewReference = { path: current.path, updatedAt: new Date().toISOString(), kind };
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO preferences (id, value, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    REFERENCE_ID,
    JSON.stringify(record),
    'user_selected',
    now,
    now,
  );
}

// ---------------------------------------------------------------------------
// 预览任务（tasks 表 kind='try_on_preview'）
// ---------------------------------------------------------------------------

export const PREVIEW_TASK_KIND = 'try_on_preview';
export const PREVIEW_CONTRACT_VERSION = 'try-on-preview-1';
export const PREVIEW_PROMPT_VERSION = '1';

export type PreviewTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'blocked'
  | 'stale'
  | 'cancelled';

export interface PreviewTask {
  id: string;
  status: PreviewTaskStatus;
  basisItemId: string;
  itemIds: string[];
  wearStyle: string;
  inputKey: string;
  requestKey: string;
  configId: string;
  configRevision: string;
  errorKind: string | null;
  errorSummary: string | null;
  resultPreviewPath: string | null;
  /** 生成成功但落盘失败时的供应商下载地址（R8：可仅重试下载，不重新生成） */
  pendingUrl: string | null;
  /** 入队快照（C2：单品集+各单品版本+穿法+参考版本；v5 通用列，旧任务为 null） */
  inputJson: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface TaskRow {
  id: string;
  status: PreviewTaskStatus;
  item_id: string;
  input_key: string;
  request_key: string;
  config_id: string;
  config_revision: string;
  error_kind: string | null;
  error_summary: string | null;
  result_json: string | null;
  input_json: string | null;
  created_at: string;
  finished_at: string | null;
}

function rowToTask(row: TaskRow): PreviewTask {
  let resultPreviewPath: string | null = null;
  let pendingUrl: string | null = null;
  try {
    const parsed = row.result_json
      ? (JSON.parse(row.result_json) as { previewPath?: string; pendingUrl?: string })
      : null;
    resultPreviewPath = parsed?.previewPath ?? null;
    pendingUrl = typeof parsed?.pendingUrl === 'string' ? parsed.pendingUrl : null;
  } catch {
    resultPreviewPath = null;
    pendingUrl = null;
  }
  return {
    id: row.id,
    status: row.status,
    basisItemId: row.item_id,
    itemIds: JSON.parse(row.input_key ? decodeInputKeyItemIds(row.input_key) : '[]') as string[],
    wearStyle: '',
    inputKey: row.input_key,
    requestKey: row.request_key,
    configId: row.config_id,
    configRevision: row.config_revision,
    errorKind: row.error_kind,
    errorSummary: row.error_summary,
    resultPreviewPath,
    pendingUrl,
    inputJson: row.input_json ?? null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** 从 input_key 指纹里取回单品集合（生成指纹时按固定顺序 JSON，可直接解析 itemIds 字段） */
function decodeInputKeyItemIds(inputKey: string): string {
  try {
    const parsed = JSON.parse(inputKey) as { itemIds?: string[] };
    return JSON.stringify(parsed.itemIds ?? []);
  } catch {
    return '[]';
  }
}

function newTaskId(): string {
  return `pt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 预览输入指纹：单品集（排序）+ 各单品资料版本 + 穿法 + 参考版本 + 配置与提示词版本。
 * C2/R5（2026-11-04）：衣物资料版本（items.revision）与人物参考版本一起进入指纹——
 * 更换照片、修改属性或删除衣物后视为不同输入，旧图不能冒充当前方案的生成结果。 */
export function buildPreviewInputKey(input: {
  itemIds: string[];
  itemRevisions: Record<string, number>;
  wearStyle: string;
  referenceUpdatedAt: string;
  configId: string;
  configRevision: string;
}): string {
  return JSON.stringify({
    itemIds: [...input.itemIds].sort(),
    itemRevisions: input.itemRevisions,
    wearStyle: input.wearStyle,
    referenceUpdatedAt: input.referenceUpdatedAt,
    configId: input.configId,
    configRevision: input.configRevision,
    contractVersion: PREVIEW_CONTRACT_VERSION,
    promptVersion: PREVIEW_PROMPT_VERSION,
  });
}

/** 判断任务输入是否与当前方案一致（“本方案”标注判定；C2：按完整输入版本比较，
 * 含各单品资料版本与人物参考版本，不只比单品集合与穿法） */
export function previewInputMatches(
  task: { inputKey: string },
  current: {
    itemIds: string[];
    itemRevisions: Record<string, number>;
    wearStyle: string;
    referenceUpdatedAt: string;
  },
): boolean {
  try {
    const parsed = JSON.parse(task.inputKey) as {
      itemIds?: string[];
      itemRevisions?: Record<string, number>;
      wearStyle?: string;
      referenceUpdatedAt?: string;
    };
    const sameIds = JSON.stringify([...(parsed.itemIds ?? [])].sort()) === JSON.stringify([...current.itemIds].sort());
    const sameRevisions = JSON.stringify(parsed.itemRevisions ?? {}) === JSON.stringify(current.itemRevisions);
    return sameIds && sameRevisions && parsed.wearStyle === current.wearStyle && parsed.referenceUpdatedAt === current.referenceUpdatedAt;
  } catch {
    return false;
  }
}

export interface CreatePreviewTaskInput {
  basisItemId: string;
  itemIds: string[];
  /** 各单品资料版本（入队快照；执行时校验，变化即 stale） */
  itemRevisions: Record<string, number>;
  wearStyle: string;
  /** 逐件穿法（C4；入队快照；执行时逐件进提示词） */
  itemWear?: Record<string, string>;
  /** C3 参考视角（face/full_body）；随快照进提示词的诚实表述 */
  referenceKind?: string;
  referenceUpdatedAt: string;
  configId: string;
  configSnapshot: string;
  configRevision: string;
  requestKey: string;
}

export type CreatePreviewTaskResult =
  | { status: 'created'; taskId: string }
  | { status: 'existing'; taskId: string };

/** 创建预览任务：requestKey 幂等；相同输入指纹且仍有 queued/running 时去重。
 * 入队快照存 tasks.input_json（v5 通用列）：执行时按快照校验发送，不现读会话。 */
export async function createPreviewTask(input: CreatePreviewTaskInput): Promise<CreatePreviewTaskResult> {
  const db = await getDb();

  const byRequest = await db.getFirstAsync<{ id: string }>(
    'SELECT id FROM tasks WHERE request_key = ?',
    input.requestKey,
  );
  if (byRequest) return { status: 'existing', taskId: byRequest.id };

  const inputKey = buildPreviewInputKey(input);
  const active = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM tasks WHERE kind = ? AND input_key = ? AND status IN ('queued','running') LIMIT 1",
    PREVIEW_TASK_KIND,
    inputKey,
  );
  if (active) return { status: 'existing', taskId: active.id };

  const countRow = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM tasks WHERE kind = ?',
    PREVIEW_TASK_KIND,
  );
  const id = newTaskId();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO tasks (
       id, kind, item_id, status, input_revision, attempt, photo_id, input_key, request_key,
       config_id, config_snapshot, config_revision, contract_version, prompt_version,
       input_json, created_at, updated_at
     ) VALUES (?, ?, ?, 'queued', 1, ?, 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    PREVIEW_TASK_KIND,
    input.basisItemId,
    Number(countRow?.n ?? 0) + 1,
    inputKey,
    input.requestKey,
    input.configId,
    input.configSnapshot,
    input.configRevision,
    PREVIEW_CONTRACT_VERSION,
    PREVIEW_PROMPT_VERSION,
    // C2 入队快照：单品集 + 各单品版本 + 穿法（含逐件，C4）+ 参考版本与视角（C3）
    JSON.stringify({
      itemIds: input.itemIds,
      itemRevisions: input.itemRevisions,
      wearStyle: input.wearStyle,
      itemWear: input.itemWear ?? {},
      referenceKind: input.referenceKind ?? null,
      referenceUpdatedAt: input.referenceUpdatedAt,
    }),
    now,
    now,
  );
  return { status: 'created', taskId: id };
}

function rowToTaskFull(row: TaskRow): PreviewTask {
  // wearStyle 从指纹还原，供展示（不入库的派生值）
  let wearStyle = '';
  try {
    wearStyle = (JSON.parse(row.input_key) as { wearStyle?: string }).wearStyle ?? '';
  } catch {
    wearStyle = '';
  }
  return { ...rowToTask(row), wearStyle };
}

/** 按状态取预览任务（执行器领取 / 启动恢复） */
export async function listPreviewTasksByStatus(status: PreviewTaskStatus): Promise<PreviewTask[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<TaskRow>(
    'SELECT * FROM tasks WHERE kind = ? AND status = ? ORDER BY created_at ASC, rowid ASC',
    PREVIEW_TASK_KIND,
    status,
  );
  return rows.map(rowToTaskFull);
}

/** 最近的预览任务（比较视图用，新→旧） */
export async function listRecentPreviewTasks(limit = 12): Promise<PreviewTask[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<TaskRow>(
    'SELECT * FROM tasks WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    PREVIEW_TASK_KIND,
    limit,
  );
  return rows.map(rowToTaskFull);
}

export async function getPreviewTask(id: string): Promise<PreviewTask | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  return row ? rowToTaskFull(row) : null;
}

/** 状态条件更新（沿用 tasks 通用条件更新；调用方传 allowedFrom） */
export function updatePreviewTaskStatus(
  id: string,
  allowedFrom: PreviewTaskStatus[],
  to: PreviewTaskStatus,
  patch: { errorKind?: string | null; errorSummary?: string | null; finishedAt?: string | null } = {},
): Promise<boolean> {
  return updateTaskStatus(
    id,
    allowedFrom,
    to,
    {
      errorKind: patch.errorKind ?? null,
      errorSummary: patch.errorSummary ?? null,
      finishedAt: patch.finishedAt ?? null,
    },
  );
}

/** 生成图落盘：官方 downloadFileAsync 下载到 files/previews/ 再改名为 <taskId>.jpg；记录 result_json。
 * 下载带 60s 超时——生成图 URL 有时效且 CDN 偶发挂起，无超时会让任务永远停在 running。
 * 注：曾用 fetch+File.write(ArrayBuffer) 在真机上写入失败（落盘检查报错），故改官方下载 API。 */
export const PREVIEW_DOWNLOAD_TIMEOUT_MS = 60000;

export async function savePreviewResultImage(taskId: string, remoteUrl: string, prompt: string): Promise<string> {
  const dir = new Directory(Paths.document, 'previews');
  if (!dir.exists) dir.create();

  const download = File.downloadFileAsync(remoteUrl, dir);
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('下载生成图超时（60 秒）')), PREVIEW_DOWNLOAD_TIMEOUT_MS);
  });
  const downloaded = await Promise.race([download, timeout]);
  // 真机验证（2026-11-02）：下载产物已在 previews/ 目录（exists=true size>0），
  // 但 move() 后新路径 exists 立即查为 false（move 非同步生效）——因此不再改名/移动，
  // 直接采用下载产物的文件名作为结果（taskId 关联在任务行与 result_json 中）。
  if (!downloaded.exists) throw new Error('生成图下载失败：文件不存在');
  const fileName = downloaded.uri.split('/').pop() ?? `${taskId}.jpg`;
  const relativePath = `previews/${fileName}`;
  const placed = new File(Paths.document, relativePath);
  if (!placed.exists || placed.size === 0) throw new Error('生成图落盘失败（下载产物不可读）');

  const db = await getDb();
  await db.runAsync(
    'UPDATE tasks SET result_json = ?, updated_at = ? WHERE id = ?',
    JSON.stringify({ previewPath: relativePath, prompt }),
    new Date().toISOString(),
    taskId,
  );
  return relativePath;
}

/** 预览图的可显示 URI */
export function previewImageUri(relativePath: string): string {
  return `${Paths.document.uri}/${relativePath}`;
}

/** 持久化"生成成功但保存失败"的供应商下载地址（R8：之后可仅重试下载，不重新生成、不重复计费） */
export async function savePendingDownload(taskId: string, remoteUrl: string, prompt: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE tasks SET result_json = ?, updated_at = ? WHERE id = ?',
    JSON.stringify({ pendingUrl: remoteUrl, prompt }),
    new Date().toISOString(),
    taskId,
  );
}

/** 仅重试下载（R8）：对 save_failed 任务用已持久化的 URL 重新下载落盘并置 succeeded。
 * 下载 URL 有时效，过期会失败——失败信息如实返回，任务保持 failed 可再次尝试或重新生成。 */
export async function retryPreviewDownload(taskId: string): Promise<string> {
  const db = await getDb();
  const row = await db.getFirstAsync<TaskRow>('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!row) throw new Error('任务不存在');
  let pendingUrl: string | null = null;
  let prompt = '';
  try {
    const parsed = row.result_json ? (JSON.parse(row.result_json) as { pendingUrl?: string; prompt?: string }) : null;
    pendingUrl = typeof parsed?.pendingUrl === 'string' ? parsed.pendingUrl : null;
    prompt = typeof parsed?.prompt === 'string' ? parsed.prompt : '';
  } catch {
    // 结果 JSON 损坏按无待下载处理
  }
  if (!pendingUrl) throw new Error('该任务没有可重试的下载地址（只能重新生成）');
  const path = await savePreviewResultImage(taskId, pendingUrl, prompt);
  const committed = await updateTaskStatus(taskId, ['failed'], 'succeeded', {
    errorKind: null,
    errorSummary: null,
    finishedAt: new Date().toISOString(),
  });
  if (!committed) throw new Error('任务状态已变化，下载结果未保存');
  return path;
}

/**
 * 删除一条预览任务记录与其生成图文件（用户明确要求删除；不可恢复）。
 * 进行中（queued/running）的任务由调用方拦截，不在此处处理。
 */
export async function deletePreviewTask(taskId: string): Promise<void> {
  const db = await getDb();
  const task = await getPreviewTask(taskId);
  if (!task) return;
  await db.runAsync('DELETE FROM tasks WHERE id = ?', taskId);
  if (task.resultPreviewPath) {
    const file = new File(Paths.document, task.resultPreviewPath);
    if (file.exists) file.delete();
  }
}

// ---------------------------------------------------------------------------
// C5 同条件比较（2026-11-04，schema v7 preview_comparisons）
// ---------------------------------------------------------------------------

export interface PreviewComparison {
  id: string;
  taskAId: string;
  taskBId: string;
  /** 比较组共享的人物参考版本（创建时校验一致） */
  referenceUpdatedAt: string;
  createdAt: string;
}

function referenceVersionOf(task: PreviewTask): string | null {
  try {
    return (JSON.parse(task.inputKey) as { referenceUpdatedAt?: string }).referenceUpdatedAt ?? null;
  } catch {
    return null;
  }
}

export type CreateComparisonResult =
  | { ok: true; comparison: PreviewComparison }
  | { ok: false; message: string };

/** 创建比较组（决策 D-8）：两张同人物参考版本、已成功的生成结果。
 * 记录共享条件供追溯；参数一致不保证视觉条件完全一致（展示时如实说明）。 */
export async function createPreviewComparison(taskAId: string, taskBId: string): Promise<CreateComparisonResult> {
  if (taskAId === taskBId) return { ok: false, message: '请选择两条不同的生成记录' };
  const [a, b] = await Promise.all([getPreviewTask(taskAId), getPreviewTask(taskBId)]);
  if (!a || !b) return { ok: false, message: '生成记录不存在' };
  if (a.status !== 'succeeded' || !a.resultPreviewPath || b.status !== 'succeeded' || !b.resultPreviewPath) {
    return { ok: false, message: '只有生成成功的记录才能比较' };
  }
  const refA = referenceVersionOf(a);
  const refB = referenceVersionOf(b);
  if (!refA || refA !== refB) {
    return { ok: false, message: '两条记录的人物参考版本不同，不属于同条件比较' };
  }
  const db = await getDb();
  const comparison: PreviewComparison = {
    id: `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    taskAId,
    taskBId,
    referenceUpdatedAt: refA,
    createdAt: new Date().toISOString(),
  };
  await db.runAsync(
    'INSERT INTO preview_comparisons (id, task_a_id, task_b_id, reference_updated_at, created_at) VALUES (?, ?, ?, ?, ?)',
    comparison.id,
    comparison.taskAId,
    comparison.taskBId,
    comparison.referenceUpdatedAt,
    comparison.createdAt,
  );
  return { ok: true, comparison };
}
