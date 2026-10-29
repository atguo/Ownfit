// 衣物分析任务的持久化（分批执行手册 §3.2/§3.3）。
// 职责：任务创建（含幂等与去重）、查询、条件状态更新、默认视觉模型读写。
// 边界：不发起网络请求，不导入 UI 或任务执行器；配置快照与版本以字符串接收，
// 不依赖 P4 的配置服务（分批执行手册 §3.3：P2 只做低层仓库操作）。

import { getDb } from '../db';
import {
  GARMENT_ANALYSIS_KIND,
  type AnalysisTask,
  type AnalysisTaskStatus,
} from './analysisTypes';

function newId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rowToTask(row: Record<string, unknown>): AnalysisTask {
  return {
    id: String(row.id),
    kind: row.kind as AnalysisTask['kind'],
    itemId: String(row.item_id),
    status: row.status as AnalysisTaskStatus,
    inputRevision: Number(row.input_revision),
    attempt: Number(row.attempt),
    photoId: String(row.photo_id),
    inputKey: String(row.input_key),
    requestKey: String(row.request_key),
    configId: String(row.config_id),
    configSnapshot: String(row.config_snapshot),
    configRevision: String(row.config_revision),
    contractVersion: String(row.contract_version),
    promptVersion: String(row.prompt_version),
    retryOfTaskId: (row.retry_of_task_id as string) ?? null,
    resultJson: (row.result_json as string) ?? null,
    errorKind: (row.error_kind as string) ?? null,
    errorSummary: (row.error_summary as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: (row.started_at as string) ?? null,
    finishedAt: (row.finished_at as string) ?? null,
  };
}

export interface CreateGarmentTaskInput {
  itemId: string;
  photoId: string;
  inputRevision: number;
  inputKey: string;
  /** 一次主动提交的幂等键；相同 requestKey 只会有一个任务 */
  requestKey: string;
  configId: string;
  configSnapshot: string;
  configRevision: string;
  contractVersion: string;
  promptVersion: string;
  retryOfTaskId?: string | null;
}

export type CreateGarmentTaskResult =
  | { created: true; task: AnalysisTask }
  | { created: false; task: AnalysisTask };

/**
 * 创建衣物分析任务（status=queued）。
 * - 相同 requestKey 已存在：返回该任务，不重复创建（幂等）。
 * - 该衣物已有 queued/running 任务：返回已有任务，不并行创建（去重）。
 * - 否则插入，attempt 从 1 开始按该衣物历史任务数递增。
 */
export async function createGarmentTask(
  input: CreateGarmentTaskInput,
): Promise<CreateGarmentTaskResult> {
  const db = await getDb();

  const byRequest = await db.getFirstAsync<Record<string, unknown>>(
    'SELECT * FROM tasks WHERE request_key = ?',
    input.requestKey,
  );
  if (byRequest) return { created: false, task: rowToTask(byRequest) };

  const active = await db.getFirstAsync<Record<string, unknown>>(
    "SELECT * FROM tasks WHERE item_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC, rowid DESC LIMIT 1",
    input.itemId,
  );
  if (active) return { created: false, task: rowToTask(active) };

  const countRow = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM tasks WHERE item_id = ?',
    input.itemId,
  );
  const attempt = Number(countRow?.n ?? 0) + 1;
  const now = new Date().toISOString();
  const id = newId();

  await db.runAsync(
    `INSERT INTO tasks (
      id, kind, item_id, status, input_revision, attempt, photo_id, input_key, request_key,
      config_id, config_snapshot, config_revision, contract_version, prompt_version,
      retry_of_task_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    GARMENT_ANALYSIS_KIND,
    input.itemId,
    'queued',
    input.inputRevision,
    attempt,
    input.photoId,
    input.inputKey,
    input.requestKey,
    input.configId,
    input.configSnapshot,
    input.configRevision,
    input.contractVersion,
    input.promptVersion,
    input.retryOfTaskId ?? null,
    now,
    now,
  );

  const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', id);
  return { created: true, task: rowToTask(row ?? {}) };
}

export async function getTask(id: string): Promise<AnalysisTask | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', id);
  return row ? rowToTask(row) : null;
}

/** 该衣物最新任务（created_at 相同时用 rowid 兜底，避免时间戳相同导致顺序不稳） */
export async function getLatestTask(itemId: string): Promise<AnalysisTask | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>(
    'SELECT * FROM tasks WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    itemId,
  );
  return row ? rowToTask(row) : null;
}

export async function listTasksByItem(itemId: string): Promise<AnalysisTask[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM tasks WHERE item_id = ? ORDER BY created_at ASC, rowid ASC',
    itemId,
  );
  return rows.map(rowToTask);
}

/** 按状态取任务（created_at 相同时 rowid 兜底）；执行器领取 queued、启动恢复 running 时使用 */
export async function listTasksByStatus(status: AnalysisTaskStatus): Promise<AnalysisTask[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC, rowid ASC',
    status,
  );
  return rows.map(rowToTask);
}

export interface TaskStatusPatch {
  startedAt?: string | null;
  finishedAt?: string | null;
  resultJson?: string | null;
  errorKind?: string | null;
  errorSummary?: string | null;
}

/**
 * 条件状态更新：只有当前 status 在 allowedFrom 中才更新。
 * started_at / finished_at / result_json 为“提供才写入”（COALESCE），不提供时保持原值。
 * 返回是否真的更新了一行——调用方据此判断竞态（例如任务已被取消/删除）。
 */
export async function updateTaskStatus(
  id: string,
  allowedFrom: AnalysisTaskStatus[],
  to: AnalysisTaskStatus,
  patch: TaskStatusPatch = {},
): Promise<boolean> {
  const db = await getDb();
  const placeholders = allowedFrom.map(() => '?').join(', ');
  const now = new Date().toISOString();
  const result = await db.runAsync(
    `UPDATE tasks
       SET status = ?,
           started_at = COALESCE(?, started_at),
           finished_at = COALESCE(?, finished_at),
           result_json = COALESCE(?, result_json),
           error_kind = ?,
           error_summary = ?,
           updated_at = ?
     WHERE id = ? AND status IN (${placeholders})`,
    to,
    patch.startedAt ?? null,
    patch.finishedAt ?? null,
    patch.resultJson ?? null,
    patch.errorKind ?? null,
    patch.errorSummary ?? null,
    now,
    id,
    ...allowedFrom,
  );
  return result.changes > 0;
}

/** queued -> running；只有仍处于 queued 才生效（避免与取消/删除竞态） */
export async function markTaskRunning(id: string): Promise<boolean> {
  return updateTaskStatus(id, ['queued'], 'running', { startedAt: new Date().toISOString() });
}

/** 该衣物当前照片下最新的成功任务；用于读取“上次有效结果”（不跨照片、不拼多次输出） */
export async function getLatestSucceededTaskForPhoto(
  itemId: string,
  photoId: string,
): Promise<AnalysisTask | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>(
    "SELECT * FROM tasks WHERE item_id = ? AND photo_id = ? AND status = 'succeeded' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    itemId,
    photoId,
  );
  return row ? rowToTask(row) : null;
}

/** 归档联动：把该衣物 queued/running 任务置为 cancelled，保留已成功结果；返回影响行数 */
export async function cancelActiveTasks(itemId: string): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.runAsync(
    "UPDATE tasks SET status = 'cancelled', finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE item_id = ? AND status IN ('queued', 'running')",
    now,
    now,
    itemId,
  );
  return result.changes;
}

/** 彻底删除联动：在同一资料删除事务内清理该衣物的全部任务 */
export async function deleteTasksForItem(itemId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM tasks WHERE item_id = ?', itemId);
}

/** 读取该任务类型的默认视觉模型配置 ID；未设置返回 null */
export async function getDefaultConfigId(kind: string = GARMENT_ANALYSIS_KIND): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ default_config_id: string }>(
    'SELECT default_config_id FROM ai_task_preferences WHERE kind = ?',
    kind,
  );
  return row?.default_config_id ?? null;
}

/** 记住该任务类型的默认视觉模型（仅在用户选择或确认后调用） */
export async function setDefaultConfigId(
  configId: string,
  kind: string = GARMENT_ANALYSIS_KIND,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO ai_task_preferences (kind, default_config_id) VALUES (?, ?)
     ON CONFLICT(kind) DO UPDATE SET default_config_id = excluded.default_config_id`,
    kind,
    configId,
  );
}
