// 预览防偏核对记录仓库（C8，2026-11-04，schema v7 preview_checks 表；v8 增产物关联）。
// 职责：保存每次生成后的视觉核对结果（逐项判定、核对模型与规则版本、纠偏次数、产物关联）；
// 读取任务最近一次核对记录供面板展示。
// 边界：核对记录是"辅助判断"，不是真实性证明——重大偏离的结果不得作为可靠选择依据，
// 无核对能力时如实登记 unchecked，不冒充已核对。

import { getDb } from '../db';

/** v8（2026-11-04）：逐件穿法进约束、缺图显式标注附图索引，规则内容变化 → 版本升 2 */
export const PREVIEW_CHECK_RULE_VERSION = '2';

/** 单品判定：match=与约束一致；deviate=明显偏离；unknown=遮挡/证据不足/无法判断（不当通过） */
export type PreviewItemVerdictStatus = 'match' | 'deviate' | 'unknown';

export interface PreviewItemVerdict {
  itemId: string;
  status: PreviewItemVerdictStatus;
  note?: string;
}

/** 总体判定：unchecked=未配置核对能力；unknown=核对失败/无法判断；minor=轻微差异；major=重大偏离 */
export type PreviewCheckOverall = 'unchecked' | 'unknown' | 'match' | 'minor' | 'major';

export interface PreviewCheckRecord {
  id: string;
  taskId: string;
  /** 核对针对的产物（v8 起有值；旧记录为 null） */
  artifactId: string | null;
  personRefVersion: string | null;
  /** 各单品资料版本快照（ itemId → revision 的 JSON 字符串） */
  garmentVersions: string;
  checkerConfigId: string;
  checkerRevision: string;
  checkerRuleVersion: string;
  verdicts: PreviewItemVerdict[];
  overall: PreviewCheckOverall;
  /** 有界纠偏：本次核对前已自动重试生成的次数（0=首次生成） */
  retryCount: number;
  createdAt: string;
}

interface CheckRow {
  id: string;
  task_id: string;
  artifact_id: string | null;
  person_ref_version: string | null;
  garment_versions: string;
  checker_config_id: string;
  checker_revision: string;
  checker_rule_version: string;
  verdicts_json: string;
  overall: string;
  retry_count: number;
  created_at: string;
}

function rowToRecord(row: CheckRow): PreviewCheckRecord {
  let verdicts: PreviewItemVerdict[] = [];
  try {
    const parsed = JSON.parse(row.verdicts_json) as PreviewItemVerdict[];
    if (Array.isArray(parsed)) verdicts = parsed;
  } catch {
    verdicts = [];
  }
  return {
    id: row.id,
    taskId: row.task_id,
    artifactId: row.artifact_id ?? null,
    personRefVersion: row.person_ref_version,
    garmentVersions: row.garment_versions,
    checkerConfigId: row.checker_config_id,
    checkerRevision: row.checker_revision,
    checkerRuleVersion: row.checker_rule_version,
    verdicts,
    overall: row.overall as PreviewCheckOverall,
    retryCount: row.retry_count,
    createdAt: row.created_at,
  };
}

export interface SavePreviewCheckInput {
  taskId: string;
  /** 核对针对的产物（条件提交后必有；未配置核对等路径可空） */
  artifactId?: string | null;
  personRefVersion: string | null;
  garmentVersions: string;
  checkerConfigId: string;
  checkerRevision: string;
  verdicts: PreviewItemVerdict[];
  overall: PreviewCheckOverall;
  retryCount: number;
}

/** 保存一次核对记录（每次生成/纠偏重生成各存一条，历史保留；关联具体产物） */
export async function savePreviewCheck(input: SavePreviewCheckInput): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO preview_checks (
       id, task_id, artifact_id, person_ref_version, garment_versions, checker_config_id,
       checker_revision, checker_rule_version, verdicts_json, overall, retry_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `pchk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    input.taskId,
    input.artifactId ?? null,
    input.personRefVersion,
    input.garmentVersions,
    input.checkerConfigId,
    input.checkerRevision,
    PREVIEW_CHECK_RULE_VERSION,
    JSON.stringify(input.verdicts),
    input.overall,
    input.retryCount,
    new Date().toISOString(),
  );
}

/** 任务最近一次核对记录（面板展示；无则 null = 未核对） */
export async function getLatestPreviewCheck(taskId: string): Promise<PreviewCheckRecord | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<CheckRow>(
    'SELECT * FROM preview_checks WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    taskId,
  );
  return row ? rowToRecord(row) : null;
}

/** 任务已自动纠偏的次数（有界重试用：取历史记录的最大 retry_count） */
export async function getPreviewCheckRetryCount(taskId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ maxRetry: number }>(
    'SELECT MAX(retry_count) AS maxRetry FROM preview_checks WHERE task_id = ?',
    taskId,
  );
  return row?.maxRetry ?? 0;
}
