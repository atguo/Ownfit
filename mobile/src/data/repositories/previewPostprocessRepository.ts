// 预览后处理生命周期仓库（评估 §8.4.3，schema v8 preview_postprocess）。
// 生成 succeeded 之后的核对/纠偏各阶段持久化：queued → checking → checked/unchecked/
// unknown，纠偏时 → correcting →（新产物入队新的后处理行）；中断/进程死亡 → interrupted。
// 执行标识（execution）用于领取互斥；应用层 runner 统一领取，面板只订阅。

import { getDb } from '../db';

export type PreviewPostProcessStage =
  | 'queued'
  | 'checking'
  | 'correcting'
  | 'checked'
  | 'unchecked'
  | 'unknown'
  | 'interrupted';

export interface PreviewPostProcessRecord {
  id: string;
  taskId: string;
  artifactId: string;
  stage: PreviewPostProcessStage;
  /** 该产物前的纠偏次数（0=首次生成产物） */
  attempt: number;
  execution: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PostProcessRow {
  id: string;
  task_id: string;
  artifact_id: string;
  stage: string;
  attempt: number;
  execution: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: PostProcessRow): PreviewPostProcessRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    artifactId: row.artifact_id,
    stage: row.stage as PreviewPostProcessStage,
    attempt: row.attempt,
    execution: row.execution,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 入队一条后处理（产物条件提交成功后调用；stage=queued） */
export async function createPreviewPostProcess(input: {
  taskId: string;
  artifactId: string;
  attempt: number;
}): Promise<string> {
  const db = await getDb();
  const id = `pp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO preview_postprocess (id, task_id, artifact_id, stage, attempt, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    id,
    input.taskId,
    input.artifactId,
    input.attempt,
    now,
    now,
  );
  return id;
}

/** 领取下一条 queued 后处理（queued → checking，原子；无则 null） */
export async function claimNextPostProcess(): Promise<PreviewPostProcessRecord | null> {
  const db = await getDb();
  const candidate = await db.getFirstAsync<PostProcessRow>(
    "SELECT * FROM preview_postprocess WHERE stage = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1",
  );
  if (!candidate) return null;
  const execution = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await db.runAsync(
    "UPDATE preview_postprocess SET stage = 'checking', execution = ?, updated_at = ? WHERE id = ? AND stage = 'queued'",
    execution,
    new Date().toISOString(),
    candidate.id,
  );
  if (result.changes === 0) return null; // 其他执行者抢先领取
  const claimed = await db.getFirstAsync<PostProcessRow>('SELECT * FROM preview_postprocess WHERE id = ?', candidate.id);
  return claimed ? rowToRecord(claimed) : null;
}

/** 条件阶段更新：只允许从 allowedFrom 阶段迁移；返回是否生效 */
export async function updatePostProcessStage(
  id: string,
  allowedFrom: PreviewPostProcessStage[],
  to: PreviewPostProcessStage,
  patch: { error?: string | null } = {},
): Promise<boolean> {
  const db = await getDb();
  const placeholders = allowedFrom.map(() => '?').join(', ');
  const result = await db.runAsync(
    `UPDATE preview_postprocess SET stage = ?, error = COALESCE(?, error), updated_at = ?
     WHERE id = ? AND stage IN (${placeholders})`,
    to,
    patch.error ?? null,
    new Date().toISOString(),
    id,
    ...allowedFrom,
  );
  return result.changes > 0;
}

/** 按阶段取后处理（启动恢复/清理联动用） */
export async function listPostProcessByStage(stage: PreviewPostProcessStage): Promise<PreviewPostProcessRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<PostProcessRow>(
    'SELECT * FROM preview_postprocess WHERE stage = ? ORDER BY created_at ASC, rowid ASC',
    stage,
  );
  return rows.map(rowToRecord);
}

/** 任务最近一条后处理记录（面板展示核对阶段；null=尚无） */
export async function getLatestPostProcess(taskId: string): Promise<PreviewPostProcessRecord | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<PostProcessRow>(
    'SELECT * FROM preview_postprocess WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    taskId,
  );
  return row ? rowToRecord(row) : null;
}

/** 启动恢复：遗留 checking/correcting（进程可能在调用中被杀，结果未知）→ interrupted，不悄悄再付费 */
export async function recoverInFlightPostProcess(): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.runAsync(
    "UPDATE preview_postprocess SET stage = 'interrupted', error = COALESCE(error, '应用被中断，本次核对/纠偏结果未知'), updated_at = ? WHERE stage IN ('checking', 'correcting')",
    now,
  );
  return result.changes;
}
