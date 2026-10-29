// 衣物分析属性的读写与提交（字段来源重构设计 §9 + 分批执行手册 R2/R5）。
// 职责：动态属性行读写（人工/AI）、测量与颜色读写、展示视图组装、结果原子提交。
// 规则：
// - 属性存在即"已分析到"，不存在即"未提取"；未知显式表达，不用空串冒充
// - 同名属性取最新一行；人工/AI 历史行都保留（可追溯），物理删除需明确操作（递增 revision）
// - 用户确认值不被 AI 覆盖：AI 行只取"当前照片最新成功任务"，且仅承认 2.0 契约版本
// - 提交保护：任务不存在/非 running → discarded；衣物删除/归档 → cancelled；
//   revision 或主图不一致 → stale；通过 → succeeded + 写动态属性行（仅 single）
// - AI 品类建议不能直接改变 items.category

import {
  GARMENT_ANALYSIS_VERSION,
  parseGarmentAnalysis,
  recommendedAttributeKeys,
  type GarmentAnalysis,
  type GarmentColor,
} from '@ownfit/contract';
import { getDb } from '../db';
import type {
  AnalysisTask,
  AnalysisView,
  AttrSource,
  DynamicAttribute,
  Measurement,
} from './analysisTypes';
import { getItem } from './itemRepository';
import { getMainPhotoForAnalysis } from './photoRepository';
import {
  getLatestSucceededTaskForPhoto,
  getLatestTask,
  getTask,
  updateTaskStatus,
} from './taskRepository';

/** 内置字段名（有专用展示/写入；不作为动态属性行展示） */
const BUILTIN_FIELDS = new Set(['category', 'suggested_name', 'colors', 'measurements']);

interface AttributeRow {
  field: string;
  value: string | null;
  source_type: string;
  recorded_at: string;
  analysis_task_id: string | null;
  rowid: number;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 人工属性写入（确认采纳=user_confirmed；自己输入/修改=user_entered）；写入递增 revision */
export interface UserAttributeInput {
  itemId: string;
  field: string;
  /** 字符串或数组（数组以 JSON 存储，如颜色/测量） */
  value: string | GarmentColor[] | Measurement[];
  sourceType: 'user_confirmed' | 'user_entered';
  sourceRef: string;
}

export async function recordUserAttribute(input: UserAttributeInput): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const value = typeof input.value === 'string' ? input.value : JSON.stringify(input.value);
  const valueFormat = typeof input.value === 'string' ? 'text' : 'json';
  await db.withTransactionAsync(async () => {
    const item = await getItem(input.itemId);
    if (!item || item.status === 'deleted') throw new Error('这件衣物已删除');
    const revision = item.revision + 1;
    await db.runAsync(
      'UPDATE items SET revision = ?, updated_at = ? WHERE id = ?',
      revision,
      now,
      input.itemId,
    );
    await db.runAsync(
      `INSERT INTO attributes (id, item_id, field, value, unit, source_type, source_ref, confirm_status, recorded_at, item_version, value_state, value_format, analysis_task_id)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'known', ?, NULL)`,
      newId('attr'),
      input.itemId,
      input.field,
      value,
      input.sourceType,
      input.sourceRef,
      input.sourceType,
      now,
      revision,
      valueFormat,
    );
  });
}

/** 物理删除某名称的属性行（重构设计 §9：用户可物理删除），并递增 revision */
export async function deleteAttribute(itemId: string, field: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const item = await getItem(itemId);
  if (!item) return;
  const revision = item.revision + 1;
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM attributes WHERE item_id = ? AND field = ?', itemId, field);
    await db.runAsync('UPDATE items SET revision = ?, updated_at = ? WHERE id = ?', revision, now, itemId);
  });
}

/** 测量列表写入（仅用户录入；AI 永不写）。覆盖式保存整份列表。 */
export async function setMeasurements(itemId: string, list: Measurement[]): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const item = await getItem(itemId);
  if (!item) return;
  const revision = item.revision + 1;
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM attributes WHERE item_id = ? AND field = ?', itemId, 'measurements');
    await db.runAsync(
      `INSERT INTO attributes (id, item_id, field, value, unit, source_type, source_ref, confirm_status, recorded_at, item_version, value_state, value_format, analysis_task_id)
       VALUES (?, ?, 'measurements', ?, NULL, 'user_entered', '用户测量', 'confirmed', ?, ?, 'known', 'json', NULL)`,
      newId('msr'),
      itemId,
      JSON.stringify(list),
      now,
      revision,
    );
  });
}

/** 读取某字段的最新一行（原始值） */
async function latestFieldValue(itemId: string, field: string): Promise<AttributeRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<AttributeRow>(
    'SELECT field, value, source_type, recorded_at, analysis_task_id, rowid AS rid FROM attributes WHERE item_id = ? AND field = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1',
    itemId,
    field,
  );
  return row ?? null;
}

/**
 * 读取详情/列表视图（重构设计 §9）：
 * - lastValidResult：当前照片最新"有效"成功任务（契约版本 2.0.0-draft、single）
 * - colors：用户确认行优先，否则回退 AI 结果颜色
 * - suggestedName：来自 AI 结果（采纳后写入 items.name）
 * - attributes：动态细节行，同名取最新；按品类推荐键排序
 * - measurements：测量列表（仅用户录入）
 */
export async function getAnalysisView(itemId: string): Promise<AnalysisView> {
  const db = await getDb();
  const item = await getItem(itemId);
  const latestTask = await getLatestTask(itemId);
  const photo = await getMainPhotoForAnalysis(itemId);
  const aiTask = photo ? await getLatestSucceededTaskForPhoto(itemId, photo.photoId) : null;

  // 只承认当前契约版本的成功结果；旧形状仅作历史诊断，不生成视图（重构设计 §11）
  let lastValid: {
    taskId: string;
    result: GarmentAnalysis;
    completedAt: string;
    modelName: string;
  } | null = null;
  if (aiTask && aiTask.contractVersion === GARMENT_ANALYSIS_VERSION && aiTask.resultJson) {
    try {
      const raw = JSON.parse(aiTask.resultJson) as unknown;
      const parsed = parseGarmentAnalysis(raw);
      if (parsed.ok && parsed.value.targetStatus === 'single') {
        lastValid = {
          taskId: aiTask.id,
          result: parsed.value,
          completedAt: aiTask.finishedAt ?? aiTask.updatedAt,
          modelName: snapshotModelName(aiTask.configSnapshot, aiTask.configId),
        };
      }
    } catch {
      // 结果 JSON 损坏视为无有效结果
    }
  }

  // 全量属性行：同名取最新；分类为动态行 / 用户颜色 / 测量
  const rows = await db.getAllAsync<AttributeRow>(
    `SELECT field, value, source_type, recorded_at, analysis_task_id, rowid AS rid
       FROM attributes WHERE item_id = ?
      ORDER BY recorded_at DESC, rowid DESC`,
    itemId,
  );

  const dynamicByName = new Map<string, DynamicAttribute>();
  let userColors: GarmentColor[] | null = null;
  let userColorsSource: AttrSource = 'user_entered';
  let measurements: { list: Measurement[]; source: AttrSource } | null = null;

  for (const row of rows) {
    const source = row.source_type as AttrSource;
    if (BUILTIN_FIELDS.has(row.field)) {
      if (row.field === 'colors' && row.source_type !== 'ai_inferred' && userColors === null) {
        try {
          const parsed = JSON.parse(row.value ?? '[]') as GarmentColor[];
          if (Array.isArray(parsed)) {
            userColors = parsed;
            userColorsSource = source;
          }
        } catch {
          // 损坏行忽略
        }
      }
      if (row.field === 'measurements' && measurements === null) {
        try {
          const parsed = JSON.parse(row.value ?? '[]') as Measurement[];
          if (Array.isArray(parsed)) measurements = { list: parsed, source };
        } catch {
          // 损坏行忽略
        }
      }
      continue;
    }
    if (!dynamicByName.has(row.field)) {
      dynamicByName.set(row.field, {
        name: row.field,
        value: row.value ?? '',
        source,
        recordedAt: row.recorded_at,
        analysisTaskId: row.analysis_task_id,
      });
    }
  }

  // 排序：品类推荐键在前（按其顺序），其余按写入时间
  const recommended = item?.category
    ? (recommendedAttributeKeys[item.category as keyof typeof recommendedAttributeKeys] ?? [])
    : [];
  const attributes = [...dynamicByName.values()].sort((a, b) => {
    const indexA = recommended.indexOf(a.name);
    const indexB = recommended.indexOf(b.name);
    if (indexA >= 0 && indexB >= 0) return indexA - indexB;
    if (indexA >= 0) return -1;
    if (indexB >= 0) return 1;
    return a.recordedAt < b.recordedAt ? -1 : 1;
  });

  const colors = userColors
    ? { value: userColors, source: userColorsSource }
    : lastValid
      ? { value: lastValid.result.colors, source: 'ai_inferred' as AttrSource }
      : { value: [] as GarmentColor[], source: 'ai_inferred' as AttrSource };

  return {
    latestTask,
    lastValidResult: lastValid,
    category: { value: item?.category ?? null, source: 'user_confirmed' },
    suggestedName: lastValid
      ? { value: lastValid.result.suggestedName, source: 'ai_inferred' }
      : null,
    colors,
    attributes,
    measurements,
  };
}

function snapshotModelName(snapshotJson: string, fallback: string): string {
  try {
    const parsed = JSON.parse(snapshotJson) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name ? parsed.name : fallback;
  } catch {
    return fallback;
  }
}

export type AnalysisCommitResult = 'applied' | 'stale' | 'discarded';

/**
 * 原子提交分析结果（不重新调用 AI）。
 * - 任务不存在或不再是 running：discarded（已被取消/删除/重复提交）。
 * - 衣物已删除或已归档：把任务置 cancelled，discarded（不写任何结果与属性）。
 * - revision 或主图与任务输入不一致：置 stale，不应用。
 * - 通过：置 succeeded、写 result_json；仅 single 时写动态属性行（非 single 只存诊断）。
 * - AI 结果本身不递增输入 revision。
 */
export async function commitGarmentAnalysis(
  taskId: string,
  result: GarmentAnalysis,
): Promise<AnalysisCommitResult> {
  const db = await getDb();
  let outcome: AnalysisCommitResult = 'discarded';
  await db.withTransactionAsync(async () => {
    const task = await getTask(taskId);
    if (!task || task.status !== 'running') return;

    const item = await getItem(task.itemId);
    if (!item || item.status === 'deleted' || item.status === 'archived') {
      await updateTaskStatus(taskId, ['running'], 'cancelled', {
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    const now = new Date().toISOString();
    if (item.revision !== task.inputRevision || item.mainPhotoId !== task.photoId) {
      await updateTaskStatus(taskId, ['running'], 'stale', { finishedAt: now });
      outcome = 'stale';
      return;
    }

    const committed = await updateTaskStatus(taskId, ['running'], 'succeeded', {
      resultJson: JSON.stringify(result),
      finishedAt: now,
    });
    if (!committed) return;

    // 仅 single 时写动态属性行（非 single 只存诊断 JSON）
    if (result.targetStatus === 'single') {
      await db.runAsync('DELETE FROM attributes WHERE analysis_task_id = ?', taskId);
      for (const attribute of result.attributes) {
        await db.runAsync(
          `INSERT INTO attributes (id, item_id, field, value, unit, source_type, source_ref, confirm_status, recorded_at, item_version, value_state, value_format, analysis_task_id)
           VALUES (?, ?, ?, ?, NULL, 'ai_inferred', ?, 'unconfirmed', ?, ?, 'known', 'text', ?)`,
          newId('attr'),
          task.itemId,
          attribute.name,
          attribute.value,
          task.photoId,
          now,
          task.inputRevision,
          taskId,
        );
      }
    }
    outcome = 'applied';
  });
  return outcome;
}
