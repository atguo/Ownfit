// 上身预览仓库（M5 轨 A + 评估 §8.3/§8.4/§8.5，2026-11-04）：
// - 人物参考照：相册选图压缩后落私有目录 preview-ref/（唯一新文件→提交引用→清旧；
//   删旧失败登记 pending_cleanup，写新失败保留旧引用），记录含版本与视角。
// - 预览任务：复用 tasks 表（kind='try_on_preview'），输入版本编码进 input_key 指纹
//   （PreviewInputV2：单品集+各单品版本+有效逐件穿法+参考版本与视角+配置+提示词版本）。
// - 生成结果：下载到唯一新文件 → 条件提交（preview_artifacts 不可变产物 + tasks 指针 CAS），
//   失败时旧产物不变；后处理（核对/纠偏）由 preview_postprocess 承载。
// 参考照仅发送给用户手动配置的图像生成服务（MiniMax subject_reference）。

import * as ImageManipulator from 'expo-image-manipulator';
import { File, Directory, Paths } from 'expo-file-system';
import { getDb } from '../db';
import { updateTaskStatus } from './taskRepository';
import { canonicalJson } from '../../services/ai/canonical';
import { recordPendingCleanup } from './maintenanceRepository';

const REFERENCE_ID = 'preview-reference';
/** 旧版固定文件名（自愈识别用；新保存一律唯一文件名） */
const REFERENCE_LEGACY_PATH = 'preview-ref/reference.jpg';
const REFERENCE_MAX_DIMENSION = 1024;

export interface PreviewReference {
  /** 相对路径（相对应用 document 目录） */
  path: string;
  /** 参考版本时间（进入预览任务输入版本） */
  updatedAt: string;
  /** C3 参考视角（用户声明）：面部特写 / 全身照。缺失为旧记录（未声明）。 */
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
  // 自愈：仅针对旧版固定路径（文件已落盘但记录缺失——上次写入记录失败/进程被杀）
  const file = new File(Paths.document, REFERENCE_LEGACY_PATH);
  if (!file.exists) return null;
  const record: PreviewReference = {
    path: REFERENCE_LEGACY_PATH,
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
 * 从相册选图保存人物参考（评估 §8.8 文件保护）：压缩 → 唯一新文件落盘 → 提交引用 → 清旧文件。
 * 写记录失败保留旧引用并清理新文件（不半途丢参考）；删旧失败登记 pending_cleanup（不阻断）。
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

  const previous = await getPreviewReference();
  const dir = refDir();
  const fileName = `reference-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  const target = new File(dir, fileName);
  new File(saved.uri).move(target);
  if (!target.exists) throw new Error('人物参考落盘失败（文件不可读）');

  const record: PreviewReference = {
    path: `preview-ref/${fileName}`,
    updatedAt: new Date().toISOString(),
    ...(previous?.kind ? { kind: previous.kind } : null),
  };
  const db = await getDb();
  const now = new Date().toISOString();
  try {
    await db.runAsync(
      `INSERT INTO preferences (id, value, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      REFERENCE_ID,
      JSON.stringify(record),
      'user_selected',
      now,
      now,
    );
  } catch (error) {
    // 提交引用失败：清掉新文件，保留旧引用（旧图仍有效，不让用户回到无参考态）
    try {
      target.delete();
    } catch {
      await recordPendingCleanup('preview-ref', record.path, '替换引用失败后清理新文件失败');
    }
    throw error;
  }
  // 清旧文件（不同路径才删）；失败登记待清理，不阻断新引用生效
  if (previous && previous.path !== record.path) {
    try {
      const oldFile = new File(Paths.document, previous.path);
      if (oldFile.exists) oldFile.delete();
    } catch (error) {
      await recordPendingCleanup('preview-ref', previous.path, error instanceof Error ? error.message : String(error));
    }
  }
  return record;
}

/** 移除人物参考（文件与记录一并清除；不存在时静默；删文件失败登记待清理） */
export async function removePreviewReference(): Promise<void> {
  const db = await getDb();
  const current = await getPreviewReference();
  if (current) {
    try {
      const file = new File(Paths.document, current.path);
      if (file.exists) file.delete();
    } catch (error) {
      await recordPendingCleanup('preview-ref', current.path, error instanceof Error ? error.message : String(error));
    }
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
// C7/§8.3（2026-11-04）：逐件穿法进指纹与核对约束后提示词语义变化，版本升 2（不冒充历史 v1）
export const PREVIEW_PROMPT_VERSION = '2';

export const PREVIEW_INPUT_VERSION = 2;

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
  /** 任务行的提示词版本（列 prompt_version） */
  promptVersion: string;
  errorKind: string | null;
  errorSummary: string | null;
  resultPreviewPath: string | null;
  /** 当前选中产物的 id（v8 起有值；旧记录为 null=legacy 无不可变产物） */
  resultArtifactId: string | null;
  /** 生成成功但落盘失败时的供应商下载地址（R8：可仅重试下载，不重新生成） */
  pendingUrl: string | null;
  /** 入队快照（PreviewInputV2；v5 通用列，旧任务为 null） */
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
  prompt_version: string;
  error_kind: string | null;
  error_summary: string | null;
  result_json: string | null;
  input_json: string | null;
  result_artifact_id: string | null;
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
    promptVersion: row.prompt_version,
    errorKind: row.error_kind,
    errorSummary: row.error_summary,
    resultPreviewPath,
    resultArtifactId: row.result_artifact_id ?? null,
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

/** 预览入队快照（PreviewInputV2，评估 §8.3）：单品集+各单品版本+有效逐件穿法+
 * 人物参考版本与视角；执行与"本方案"判定共用同一比较。 */
export interface PreviewInputV2 {
  inputVersion: typeof PREVIEW_INPUT_VERSION;
  itemIds: string[];
  itemRevisions: Record<string, number>;
  /** 有效逐件穿法（itemId → 穿法；入队前已按槽位语义归一） */
  itemWear: Record<string, string>;
  wearStyle: string;
  referenceKind: string | null;
  referenceUpdatedAt: string;
}

/** 预览输入指纹（§8.3.3）：规范化序列化——真实单品集（排序）、资料版本、有效逐件穿法、
 * 主穿法、参考版本与视角、配置与提示词版本全部纳入；键序变化不产生新指纹。 */
export function buildPreviewInputKey(input: {
  itemIds: string[];
  itemRevisions: Record<string, number>;
  wearStyle: string;
  itemWear?: Record<string, string>;
  referenceKind?: string | null;
  referenceUpdatedAt: string;
  configId: string;
  configRevision: string;
}): string {
  return canonicalJson({
    inputVersion: PREVIEW_INPUT_VERSION,
    itemIds: [...input.itemIds].sort(),
    itemRevisions: input.itemRevisions,
    wearStyle: input.wearStyle,
    itemWear: input.itemWear ?? {},
    referenceKind: input.referenceKind ?? null,
    referenceUpdatedAt: input.referenceUpdatedAt,
    configId: input.configId,
    configRevision: input.configRevision,
    contractVersion: PREVIEW_CONTRACT_VERSION,
    promptVersion: PREVIEW_PROMPT_VERSION,
  });
}

/** 判断任务输入是否与当前方案一致（"本方案"标注判定；含逐件穿法，F3） */
export function previewInputMatches(
  task: { inputKey: string },
  current: {
    itemIds: string[];
    itemRevisions: Record<string, number>;
    wearStyle: string;
    itemWear?: Record<string, string>;
    referenceUpdatedAt: string;
    referenceKind?: string | null;
  },
): boolean {
  try {
    const parsed = JSON.parse(task.inputKey) as Record<string, unknown>;
    // 比较输入语义字段（config/contract/prompt 版本与 inputVersion 不属于"当前方案是否变化"的判定）
    const semanticKeys = [
      'itemIds',
      'itemRevisions',
      'wearStyle',
      'itemWear',
      'referenceKind',
      'referenceUpdatedAt',
    ];
    const taskSemantic = canonicalJson(Object.fromEntries(semanticKeys.map((k) => [k, parsed[k]])));
    const currentSemantic = canonicalJson(
      Object.fromEntries(
        semanticKeys.map((k) => [
          k,
          k === 'itemIds'
            ? [...current.itemIds].sort()
            : k === 'itemWear'
              ? current.itemWear ?? {}
              : k === 'referenceKind'
                ? current.referenceKind ?? null
                : current[k as 'itemRevisions' | 'wearStyle' | 'referenceUpdatedAt'],
        ]),
      ),
    );
    return taskSemantic === currentSemantic;
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
  /** 有效逐件穿法（C4/F3；入队快照；执行时逐件进提示词与指纹） */
  itemWear?: Record<string, string>;
  /** C3 参考视角（face/full_body）；随快照进提示词与指纹 */
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

/** 创建预览任务：requestKey 幂等；相同输入指纹且仍有 queued/running 时去重。 */
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
    // PreviewInputV2 入队快照：单品集 + 各单品版本 + 有效逐件穿法 + 参考版本与视角
    JSON.stringify({
      inputVersion: PREVIEW_INPUT_VERSION,
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

// ---------------------------------------------------------------------------
// 产物条件提交（评估 §8.4：先修提交，再接核对）
// ---------------------------------------------------------------------------

export const PREVIEW_DOWNLOAD_TIMEOUT_MS = 60000;

export interface PreviewArtifact {
  id: string;
  taskId: string;
  /** 0=首次生成，>0=第 N 次纠偏重生成 */
  attempt: number;
  path: string;
  prompt: string;
  inputKey: string;
  configId: string;
  createdAt: string;
}

export interface CommittedArtifact {
  artifactId: string;
  path: string;
  attempt: number;
  inputVersion: string;
}

export type CommitArtifactResult =
  | { ok: true; artifact: CommittedArtifact }
  | { ok: false; reason: 'state_changed' }
  | { ok: false; reason: 'download_failed'; message: string };

function previewsDir(): Directory {
  const dir = new Directory(Paths.document, 'previews');
  if (!dir.exists) dir.create();
  return dir;
}

/** 下载生成图到唯一新文件（不做改名/移动——move 非同步生效，真机已踩坑）；失败清理由调用方处理 */
async function downloadPreviewFile(remoteUrl: string): Promise<{ relativePath: string } | { error: string }> {
  const dir = previewsDir();
  try {
    const download = File.downloadFileAsync(remoteUrl, dir);
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error('下载生成图超时（60 秒）')), PREVIEW_DOWNLOAD_TIMEOUT_MS);
    });
    let downloaded: { exists: boolean; uri: string };
    try {
      downloaded = await Promise.race([download, timeout]);
    } finally {
      // 竞速结束后清掉 60s 定时器：不残留挂起定时器拖住进程（测试与真机后台都受益）
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
    if (!downloaded.exists) return { error: '生成图下载失败：文件不存在' };
    const fileName = downloaded.uri.split('/').pop() ?? 'preview.jpg';
    const relativePath = `previews/${fileName}`;
    const placed = new File(Paths.document, relativePath);
    if (!placed.exists || placed.size === 0) return { error: '生成图落盘失败（下载产物不可读）' };
    return { relativePath };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 下载并条件提交一次产物（评估 §8.4.1）：
 * 下载到唯一新文件（网络/文件操作不在数据库事务内）→ 短事务内校验任务状态与指针 CAS →
 * 写 preview_artifacts（不可变）+ tasks 指针与 result_json + preview_postprocess(queued)。
 * 状态不符/指针已被移动 → state_changed（下载产物清理，旧产物不变）。
 * - 首次生成：expectedStatus=['running']，指针此前必为空；
 * - 仅重试下载：expectedStatus=['failed']，指针此前必为空；
 * - 纠偏重生成：expectedStatus=['succeeded']，previousArtifactId=当前指针（CAS）。
 */
export async function downloadAndCommitArtifact(input: {
  taskId: string;
  remoteUrl: string;
  prompt: string;
  inputKey: string;
  configId: string;
  attempt: number;
  expectedStatus: PreviewTaskStatus[];
  /** 纠偏时的指针 CAS：只有当前指针仍指向该产物才提交 */
  previousArtifactId?: string | null;
}): Promise<CommitArtifactResult> {
  const downloaded = await downloadPreviewFile(input.remoteUrl);
  if ('error' in downloaded) return { ok: false, reason: 'download_failed', message: downloaded.error };

  const db = await getDb();
  const relativePath = downloaded.relativePath;
  const artifactId = `part-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  let committed = false;
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ status: string; result_artifact_id: string | null }>(
      'SELECT status, result_artifact_id FROM tasks WHERE id = ?',
      input.taskId,
    );
    if (!row || !input.expectedStatus.includes(row.status as PreviewTaskStatus)) return; // 迟到执行者不得写入
    if (input.previousArtifactId) {
      if ((row.result_artifact_id ?? null) !== input.previousArtifactId) return; // 指针已被移动
    } else if (row.result_artifact_id != null) {
      return; // 已有产物（重复提交/迟到）
    }
    await db.runAsync(
      `INSERT INTO preview_artifacts (id, task_id, attempt, path, prompt, input_key, config_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      artifactId,
      input.taskId,
      input.attempt,
      relativePath,
      input.prompt,
      input.inputKey,
      input.configId,
      now,
    );
    await db.runAsync(
      'UPDATE tasks SET result_json = ?, result_artifact_id = ?, updated_at = ? WHERE id = ?',
      JSON.stringify({ previewPath: relativePath, prompt: input.prompt, artifactId }),
      artifactId,
      now,
      input.taskId,
    );
    await db.runAsync(
      `INSERT INTO preview_postprocess (id, task_id, artifact_id, stage, attempt, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      `pp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      input.taskId,
      artifactId,
      input.attempt,
      now,
      now,
    );
    committed = true;
  });
  if (!committed) {
    try {
      const file = new File(Paths.document, relativePath);
      if (file.exists) file.delete();
    } catch {
      await recordPendingCleanup('previews', relativePath, '条件提交失败后清理下载文件失败');
    }
    return { ok: false, reason: 'state_changed' };
  }
  return {
    ok: true,
    artifact: { artifactId, path: relativePath, attempt: input.attempt, inputVersion: input.inputKey },
  };
}

/** 读取产物（后处理核对输入用） */
export async function getPreviewArtifact(artifactId: string): Promise<PreviewArtifact | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    id: string;
    task_id: string;
    attempt: number;
    path: string;
    prompt: string;
    input_key: string;
    config_id: string;
    created_at: string;
  }>('SELECT * FROM preview_artifacts WHERE id = ?', artifactId);
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    path: row.path,
    prompt: row.prompt,
    inputKey: row.input_key,
    configId: row.config_id,
    createdAt: row.created_at,
  };
}

/** 预览图的可显示 URI */
export function previewImageUri(relativePath: string): string {
  return `${Paths.document.uri}/${relativePath}`;
}

/** 持久化"生成成功但保存失败"的供应商下载地址（R8/F6：条件写入——任务已离开 running 时拒绝）。
 * 返回是否写入（迟到执行者不得覆盖终态任务的 result_json）。 */
export async function savePendingDownload(taskId: string, remoteUrl: string, prompt: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.runAsync(
    "UPDATE tasks SET result_json = ?, updated_at = ? WHERE id = ? AND status = 'running'",
    JSON.stringify({ pendingUrl: remoteUrl, prompt }),
    new Date().toISOString(),
    taskId,
  );
  return result.changes > 0;
}

/** 仅重试下载的本地执行权（重复点击最多一个下载在途） */
const retryInflight = new Set<string>();

/** 仅重试下载（R8/F6，评估 §8.4.2）：领取本地执行权 → 条件提交产物 → 翻状态。
 * 下载 URL 有时效，过期会失败——失败信息如实返回，任务保持 failed。 */
export async function retryPreviewDownload(taskId: string): Promise<string> {
  if (retryInflight.has(taskId)) throw new Error('这条记录的下载已在进行中');
  retryInflight.add(taskId);
  try {
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
    const committed = await downloadAndCommitArtifact({
      taskId,
      remoteUrl: pendingUrl,
      prompt,
      inputKey: row.input_key,
      configId: row.config_id,
      attempt: 0,
      expectedStatus: ['failed'],
    });
    if (!committed.ok) {
      if (committed.reason === 'state_changed') throw new Error('任务状态已变化，下载结果未保存');
      throw new Error(committed.message);
    }
    const flipped = await updateTaskStatus(taskId, ['failed'], 'succeeded', {
      errorKind: null,
      errorSummary: null,
      finishedAt: new Date().toISOString(),
    });
    if (!flipped) {
      // 状态翻转失败（任务被删/已离开 failed）：撤销刚提交的产物，不留悬空指针
      await deleteArtifactRows(taskId, [committed.artifact.artifactId], [committed.artifact.path]);
      throw new Error('任务状态已变化，下载结果未保存');
    }
    return committed.artifact.path;
  } finally {
    retryInflight.delete(taskId);
  }
}

/** 删除产物行与文件（产物不可变，只随删除联动清除） */
async function deleteArtifactRows(taskId: string, artifactIds: string[], paths: string[]): Promise<void> {
  const db = await getDb();
  for (const artifactId of artifactIds) {
    await db.runAsync('DELETE FROM preview_artifacts WHERE id = ?', artifactId);
  }
  for (const path of paths) {
    try {
      const file = new File(Paths.document, path);
      if (file.exists) file.delete();
    } catch (error) {
      await recordPendingCleanup('previews', path, error instanceof Error ? error.message : String(error));
    }
  }
  void taskId;
}

/**
 * 删除一条预览任务记录及其全部产物文件（用户明确要求删除；不可恢复）。
 * 联动清理：后处理记录、核对记录、涉及该任务的比较组（不留悬空比较）。
 * 进行中（queued/running）的任务由调用方拦截，不在此处处理。
 */
export async function deletePreviewTask(taskId: string): Promise<void> {
  const db = await getDb();
  const task = await getPreviewTask(taskId);
  if (!task) return;
  const artifacts = await db.getAllAsync<{ id: string; path: string }>(
    'SELECT id, path FROM preview_artifacts WHERE task_id = ?',
    taskId,
  );
  await db.runAsync('DELETE FROM preview_postprocess WHERE task_id = ?', taskId);
  await db.runAsync('DELETE FROM preview_checks WHERE task_id = ?', taskId);
  await db.runAsync(
    'DELETE FROM preview_comparisons WHERE task_a_id = ? OR task_b_id = ? OR artifact_a_id IN (SELECT id FROM preview_artifacts WHERE task_id = ?) OR artifact_b_id IN (SELECT id FROM preview_artifacts WHERE task_id = ?)',
    taskId,
    taskId,
    taskId,
    taskId,
  );
  await db.runAsync('DELETE FROM tasks WHERE id = ?', taskId);
  await deleteArtifactRows(
    taskId,
    artifacts.map((a) => a.id),
    artifacts.map((a) => a.path),
  );
}

// ---------------------------------------------------------------------------
// C5/§8.5 同条件比较（绑定不可变产物并校验共同条件）
// ---------------------------------------------------------------------------

export interface ComparisonConditions {
  referenceUpdatedAt: string;
  referenceKind: string | null;
  configId: string;
  configRevision: string;
  promptVersion: string;
  aspectRatio: string;
}

export interface PreviewComparison {
  id: string;
  taskAId: string;
  taskBId: string;
  /** 绑定的不可变产物（v8 起）；旧比较组为 null → legacy（不补造共享参数） */
  artifactAId: string | null;
  artifactBId: string | null;
  /** 共同条件快照（旧记录仅有人物参考版本） */
  referenceUpdatedAt: string;
  conditions: ComparisonConditions | null;
  createdAt: string;
}

interface ComparisonRow {
  id: string;
  task_a_id: string;
  task_b_id: string;
  artifact_a_id: string | null;
  artifact_b_id: string | null;
  reference_updated_at: string;
  conditions_json: string | null;
  created_at: string;
}

function rowToComparison(row: ComparisonRow): PreviewComparison {
  let conditions: ComparisonConditions | null = null;
  if (row.conditions_json) {
    try {
      conditions = JSON.parse(row.conditions_json) as ComparisonConditions;
    } catch {
      conditions = null;
    }
  }
  return {
    id: row.id,
    taskAId: row.task_a_id,
    taskBId: row.task_b_id,
    artifactAId: row.artifact_a_id ?? null,
    artifactBId: row.artifact_b_id ?? null,
    referenceUpdatedAt: row.reference_updated_at,
    conditions,
    createdAt: row.created_at,
  };
}

/** 任务的实际共同条件（从输入快照与任务列取实际值；比较的是这些，不是展示名） */
function conditionsOf(task: PreviewTask): ComparisonConditions | null {
  try {
    const stored = task.inputJson ? (JSON.parse(task.inputJson) as { referenceUpdatedAt?: string; referenceKind?: string | null }) : null;
    if (!stored?.referenceUpdatedAt) return null;
    return {
      referenceUpdatedAt: stored.referenceUpdatedAt,
      referenceKind: stored.referenceKind ?? null,
      configId: task.configId,
      configRevision: task.configRevision,
      promptVersion: task.promptVersion,
      aspectRatio: '2:3',
    };
  } catch {
    return null;
  }
}

const COMPARISON_CONDITION_LABELS: Record<keyof ComparisonConditions, string> = {
  referenceUpdatedAt: '人物参考版本',
  referenceKind: '参考视角',
  configId: '模型配置',
  configRevision: '模型配置版本',
  promptVersion: '提示词版本',
  aspectRatio: '输出比例',
};

export type CreateComparisonResult =
  | { ok: true; comparison: PreviewComparison }
  | { ok: false; message: string };

/** 创建比较组（评估 §8.5）：两张已成功且绑定不可变产物的记录；先校验共同条件一致、
 * 文件可读。搭配单品与穿法是被比较的变量，不要求相同。 */
export async function createPreviewComparison(taskAId: string, taskBId: string): Promise<CreateComparisonResult> {
  if (taskAId === taskBId) return { ok: false, message: '请选择两条不同的生成记录' };
  const [a, b] = await Promise.all([getPreviewTask(taskAId), getPreviewTask(taskBId)]);
  if (!a || !b) return { ok: false, message: '生成记录不存在' };
  if (a.status !== 'succeeded' || !a.resultPreviewPath || b.status !== 'succeeded' || !b.resultPreviewPath) {
    return { ok: false, message: '只有生成成功的记录才能比较' };
  }
  if (!a.resultArtifactId || !b.resultArtifactId) {
    return { ok: false, message: '这两条记录缺少不可变的产物引用（旧版本生成），不能作为同条件比较；仍可普通查看' };
  }
  const conditionsA = conditionsOf(a);
  const conditionsB = conditionsOf(b);
  if (!conditionsA || !conditionsB) {
    return { ok: false, message: '这两条记录缺少完整的生成条件记录，不能作为同条件比较' };
  }
  if (canonicalJson(conditionsA) !== canonicalJson(conditionsB)) {
    const diff = (Object.keys(conditionsA) as Array<keyof ComparisonConditions>)
      .filter((key) => canonicalJson(conditionsA[key]) !== canonicalJson(conditionsB[key]))
      .map((key) => COMPARISON_CONDITION_LABELS[key])
      .join('、');
    return { ok: false, message: `两条记录的条件不同（${diff}），不属于同条件比较` };
  }
  const [artifactA, artifactB] = await Promise.all([
    getPreviewArtifact(a.resultArtifactId),
    getPreviewArtifact(b.resultArtifactId),
  ]);
  if (!artifactA || !artifactB) {
    return { ok: false, message: '生成图文件已缺失，无法比较' };
  }
  for (const path of [artifactA.path, artifactB.path]) {
    if (!new File(Paths.document, path).exists) {
      return { ok: false, message: '生成图文件已缺失，无法比较' };
    }
  }
  const db = await getDb();
  const comparison: PreviewComparison = {
    id: `cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    taskAId,
    taskBId,
    artifactAId: artifactA.id,
    artifactBId: artifactB.id,
    referenceUpdatedAt: conditionsA.referenceUpdatedAt,
    conditions: conditionsA,
    createdAt: new Date().toISOString(),
  };
  await db.runAsync(
    'INSERT INTO preview_comparisons (id, task_a_id, task_b_id, artifact_a_id, artifact_b_id, reference_updated_at, conditions_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    comparison.id,
    comparison.taskAId,
    comparison.taskBId,
    comparison.artifactAId,
    comparison.artifactBId,
    comparison.referenceUpdatedAt,
    JSON.stringify(comparison.conditions),
    comparison.createdAt,
  );
  return { ok: true, comparison };
}

/** 读取比较组（面板回看用；null=不存在） */
export async function getPreviewComparison(id: string): Promise<PreviewComparison | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<ComparisonRow>('SELECT * FROM preview_comparisons WHERE id = ?', id);
  return row ? rowToComparison(row) : null;
}
