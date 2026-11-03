// 搭配推荐任务持久化（M5 轨 B4）：复用 tasks 表，kind='outfit_recommendation'。
// item_id 固定 'outfit-recommendation'（推荐无单一基础单品）；photo_id 'none'。
// 输入指纹（input_key）= 单品别名集 + 场景 + 配置与提示词版本；结果 result_json 存候选（真实单品 ID）。

import { getDb } from '../db';
import { updateTaskStatus, type TaskStatusPatch } from './taskRepository';

export const RECOMMENDATION_TASK_KIND = 'outfit_recommendation';

export type RecommendationTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'blocked'
  | 'stale'
  | 'cancelled';

export interface RecommendationSlot {
  role: string;
  itemId: string;
  note?: string;
}

export interface RecommendationCandidate {
  slots: RecommendationSlot[];
  wearStyle: string;
  reason?: string;
}

export interface RecommendationTask {
  id: string;
  status: RecommendationTaskStatus;
  inputKey: string;
  requestKey: string;
  configId: string;
  configRevision: string;
  errorKind: string | null;
  errorSummary: string | null;
  candidates: RecommendationCandidate[] | null;
  gaps: string[];
  summary: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface TaskRow {
  id: string;
  status: RecommendationTaskStatus;
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

function rowToTask(row: TaskRow): RecommendationTask {
  let candidates: RecommendationCandidate[] | null = null;
  let gaps: string[] = [];
  let summary: string | null = null;
  if (row.result_json) {
    try {
      const parsed = JSON.parse(row.result_json) as {
        candidates?: RecommendationCandidate[];
        gaps?: string[];
        summary?: string;
      };
      if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
      if (Array.isArray(parsed.gaps)) gaps = parsed.gaps;
      if (typeof parsed.summary === 'string') summary = parsed.summary;
    } catch {
      // 结果 JSON 损坏视为无结果
    }
  }
  return {
    id: row.id,
    status: row.status,
    inputKey: row.input_key,
    requestKey: row.request_key,
    configId: row.config_id,
    configRevision: row.config_revision,
    errorKind: row.error_kind,
    errorSummary: row.error_summary,
    candidates,
    gaps,
    summary,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export interface CreateRecommendationTaskInput {
  inputKey: string;
  requestKey: string;
  configId: string;
  configSnapshot: string;
  configRevision: string;
}

export type CreateRecommendationResult =
  | { status: 'created'; taskId: string }
  | { status: 'existing'; taskId: string };

/** 创建推荐任务：requestKey 幂等；相同输入指纹且仍有 queued/running 时去重 */
export async function createRecommendationTask(
  input: CreateRecommendationTaskInput,
): Promise<CreateRecommendationResult> {
  const db = await getDb();
  const byRequest = await db.getFirstAsync<{ id: string }>(
    'SELECT id FROM tasks WHERE request_key = ?',
    input.requestKey,
  );
  if (byRequest) return { status: 'existing', taskId: byRequest.id };

  const active = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM tasks WHERE kind = ? AND input_key = ? AND status IN ('queued','running') LIMIT 1",
    RECOMMENDATION_TASK_KIND,
    input.inputKey,
  );
  if (active) return { status: 'existing', taskId: active.id };

  const id = `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO tasks (
       id, kind, item_id, status, input_revision, attempt, photo_id, input_key, request_key,
       config_id, config_snapshot, config_revision, contract_version, prompt_version, created_at, updated_at
     ) VALUES (?, ?, 'outfit-recommendation', 'queued', 1, 1, 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    RECOMMENDATION_TASK_KIND,
    input.inputKey,
    input.requestKey,
    input.configId,
    input.configSnapshot,
    input.configRevision,
    'outfit-recommendation-1',
    '1',
    now,
    now,
  );
  return { status: 'created', taskId: id };
}

export async function listRecommendationTasksByStatus(status: RecommendationTaskStatus): Promise<RecommendationTask[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<TaskRow>(
    'SELECT * FROM tasks WHERE kind = ? AND status = ? ORDER BY created_at ASC, rowid ASC',
    RECOMMENDATION_TASK_KIND,
    status,
  );
  return rows.map(rowToTask);
}

export async function getRecommendationTask(id: string): Promise<RecommendationTask | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  return row ? rowToTask(row) : null;
}

/** 删除一条推荐任务记录（用户明确要求删除；仅结果记录，不涉及文件） */
export async function deleteRecommendationTask(taskId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM tasks WHERE id = ?', taskId);
}

/** 最近一次已完成的推荐任务（面板展示；新→旧） */
export async function getLatestFinishedRecommendation(): Promise<RecommendationTask | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<TaskRow>(
    "SELECT * FROM tasks WHERE kind = ? AND status IN ('succeeded','failed','interrupted','blocked') ORDER BY finished_at DESC, rowid DESC LIMIT 1",
    RECOMMENDATION_TASK_KIND,
  );
  return row ? rowToTask(row) : null;
}

export function updateRecommendationTaskStatus(
  id: string,
  allowedFrom: RecommendationTaskStatus[],
  to: RecommendationTaskStatus,
  patch: TaskStatusPatch = {},
): Promise<boolean> {
  return updateTaskStatus(id, allowedFrom, to, patch);
}

/** 成功提交候选（真实单品 ID 已回映）；result_json 也存 gaps/summary 供面板展示 */
export async function commitRecommendationResult(
  taskId: string,
  result: { candidates: RecommendationCandidate[]; gaps: string[]; summary?: string },
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE tasks SET result_json = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(result),
    new Date().toISOString(),
    taskId,
  );
}
