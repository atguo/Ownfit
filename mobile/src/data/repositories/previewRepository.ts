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
  created_at: string;
  finished_at: string | null;
}

function rowToTask(row: TaskRow): PreviewTask {
  let resultPreviewPath: string | null = null;
  try {
    const parsed = row.result_json ? (JSON.parse(row.result_json) as { previewPath?: string }) : null;
    resultPreviewPath = parsed?.previewPath ?? null;
  } catch {
    resultPreviewPath = null;
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

/** 预览输入指纹：单品集（排序）+ 穿法 + 参考版本 + 配置与提示词版本；用于去重与“方案已变化”判定 */
export function buildPreviewInputKey(input: {
  itemIds: string[];
  wearStyle: string;
  referenceUpdatedAt: string;
  configId: string;
  configRevision: string;
}): string {
  return JSON.stringify({
    itemIds: [...input.itemIds].sort(),
    wearStyle: input.wearStyle,
    referenceUpdatedAt: input.referenceUpdatedAt,
    configId: input.configId,
    configRevision: input.configRevision,
    contractVersion: PREVIEW_CONTRACT_VERSION,
    promptVersion: PREVIEW_PROMPT_VERSION,
  });
}

export interface CreatePreviewTaskInput {
  basisItemId: string;
  itemIds: string[];
  wearStyle: string;
  referenceUpdatedAt: string;
  configId: string;
  configSnapshot: string;
  configRevision: string;
  requestKey: string;
}

export type CreatePreviewTaskResult =
  | { status: 'created'; taskId: string }
  | { status: 'existing'; taskId: string };

/** 创建预览任务：requestKey 幂等；相同输入指纹且仍有 queued/running 时去重 */
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
       config_id, config_snapshot, config_revision, contract_version, prompt_version, created_at, updated_at
     ) VALUES (?, ?, ?, 'queued', 1, ?, 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

/** 生成图落盘：下载远程 URL → files/previews/<taskId>.jpg；记录 result_json */
export async function savePreviewResultImage(taskId: string, remoteUrl: string, prompt: string): Promise<string> {
  const response = await fetch(remoteUrl);
  if (!response.ok) throw new Error(`下载生成图失败：HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const dir = new Directory(Paths.document, 'previews');
  if (!dir.exists) dir.create();
  const target = new File(dir, `${taskId}.jpg`);
  if (target.exists) target.delete();
  target.write(bytes);
  const relativePath = `previews/${taskId}.jpg`;
  if (!target.exists || target.size === 0) throw new Error('生成图落盘失败');

  const db = await getDb();
  await db.runAsync(
    "UPDATE tasks SET result_json = ?, updated_at = ? WHERE id = ?",
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
