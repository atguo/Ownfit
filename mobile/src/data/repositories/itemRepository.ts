// 单品仓库：草稿/入库/归档/删除与查询。
// 规则依据衣橱功能文档：
// - 保存草稿与可参与搭配分离；品类确认前不入库
// - 状态独立：草稿/已入库/已归档；重试与重复提交不重复创建（调用方按选择会话传入稳定 ref）
// - 归档为主；彻底删除需二次确认（UI 负责）并级联删除照片文件
// - 未知显式表达：品类未确认 = NULL + status=draft，不用空字符串冒充已确认

import { getDb } from '../db';
import {
  deletePhotoFiles,
  savePhotoFiles,
  insertPhotoRecord,
  ORIGINAL_MAX_DIMENSION,
} from './photoRepository';
import { cancelActiveTasks, deleteTasksForItem } from './taskRepository';
import { categories, type ItemCategory } from '../demo';

export type ItemStatus = 'draft' | 'active' | 'archived' | 'deleted';

export interface WardrobeItem {
  id: string;
  status: ItemStatus;
  category: ItemCategory | null;
  name: string | null;
  sourceType: string;
  mainPhotoId: string | null;
  /** 资料版本：用户修改、确认入库、归档/恢复、删除与更换照片时递增（AI 结果不递增） */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function newId(): string {
  return `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rowToItem(row: Record<string, unknown>): WardrobeItem {
  return {
    id: String(row.id),
    status: row.status as ItemStatus,
    category: (row.category as ItemCategory) ?? null,
    name: (row.name as string) ?? null,
    sourceType: String(row.source_type ?? 'photo'),
    mainPhotoId: (row.main_photo_id as string) ?? null,
    revision: Number(row.revision ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * 从一张选图创建草稿。图片先落盘，再建记录；文件失败会抛出、不产生半成品记录。
 * clientRef 由调用方保证同一选择只传一次（幂等键：首次建草稿后忽略重复 ref）。
 */
export async function createDraftFromPhoto(
  sourceUri: string,
  clientRef?: string,
  sourceWidth?: number,
  sourceHeight?: number,
): Promise<WardrobeItem> {
  const db = await getDb();
  if (clientRef) {
    const existing = await db.getFirstAsync('SELECT id FROM items WHERE id = ?', clientRef);
    if (existing) {
      const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM items WHERE id = ?', clientRef);
      return rowToItem(row ?? {});
    }
  }
  const id = clientRef ?? newId();
  const now = new Date().toISOString();

  // 先落 items 再存照片文件；文件失败时回滚 items 并清理文件——
  // 不留下"有记录无图"的半成品（衣橱文档 §5.3：文件写入失败不伪装入库成功）。
  await db.runAsync(
    'INSERT INTO items (id, status, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    id,
    'draft',
    'photo',
    now,
    now,
  );
  let files: { id: string; originalPath: string; thumbPath: string } | null = null;
  try {
    files = await savePhotoFiles({
      sourceUri,
      sourceWidth: sourceWidth ?? ORIGINAL_MAX_DIMENSION + 1,
      sourceHeight: sourceHeight ?? ORIGINAL_MAX_DIMENSION + 1,
    });
    await insertPhotoRecord({ id: files.id, itemId: id, kind: 'main', originalPath: files.originalPath, thumbPath: files.thumbPath });
    await db.runAsync('UPDATE items SET main_photo_id = ?, updated_at = ? WHERE id = ?', files.id, now, id);
  } catch (error) {
    if (files) deletePhotoFiles(files.originalPath, files.thumbPath); // 数据库失败时清理已落盘文件
    await db.runAsync('DELETE FROM items WHERE id = ?', id).catch(() => {});
    throw error;
  }

  const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM items WHERE id = ?', id);
  return rowToItem(row ?? {});
}

/**
 * 确认品类（+可选名称）：草稿 → 已入库，同时写入用户确认的品类属性。
 * 幂等：已是已入库且品类与名称都未变时不重复写属性、不递增 revision。
 */
export async function confirmItem(
  id: string,
  input: { category: ItemCategory; name?: string },
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const current = await getItem(id);
  if (!current || current.status === 'deleted') throw new Error('这件衣物已删除');
  const name = input.name?.trim() || null;
  if (current.status === 'active' && current.category === input.category && current.name === name) {
    return; // 幂等：重复确认不产生重复属性，也不推进版本
  }
  const revision = current.revision + 1;
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE items SET status = ?, category = ?, name = ?, revision = ?, updated_at = ? WHERE id = ?',
      'active',
      input.category,
      name,
      revision,
      now,
      id,
    );
    await db.runAsync(
      `INSERT INTO attributes (id, item_id, field, value, unit, source_type, source_ref, confirm_status, recorded_at, item_version)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      `attr-${id}-category-${Date.now().toString(36)}`,
      id,
      'category',
      input.category,
      'user_confirmed',
      '录入时手动确认',
      'confirmed',
      now,
      revision,
    );
  });
}

/** 编辑名称与品类（已入库件）；实际发生变化才递增 revision */
export async function updateItemBasics(
  id: string,
  input: { name?: string | null; category?: ItemCategory },
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const item = await getItem(id);
  if (!item || item.status === 'deleted') return;
  const name = input.name !== undefined ? input.name?.trim() || null : item.name;
  const category = input.category ?? item.category;
  const categoryChanged = input.category !== undefined && input.category !== item.category;
  if (name === item.name && !categoryChanged) return;

  const revision = item.revision + 1;
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'UPDATE items SET name = ?, category = ?, revision = ?, updated_at = ? WHERE id = ?',
      name,
      category,
      revision,
      now,
      id,
    );
    if (categoryChanged && input.category !== undefined) {
      await db.runAsync(
        `INSERT INTO attributes (id, item_id, field, value, unit, source_type, source_ref, confirm_status, recorded_at, item_version)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        `attr-${id}-category-${Date.now().toString(36)}`,
        id,
        'category',
        input.category,
        'user_confirmed',
        '详情页手动修改',
        'confirmed',
        now,
        revision,
      );
    }
  });
}

export async function getItem(id: string): Promise<WardrobeItem | undefined> {
  const db = await getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM items WHERE id = ?', id);
  return row ? rowToItem(row) : undefined;
}

export async function listItemIdsByStatus(status: ItemStatus): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    'SELECT id FROM items WHERE status = ? ORDER BY updated_at DESC',
    status,
  );
  return rows.map((r) => r.id);
}

/** 主图缩略图路径（列表用） */
export async function getMainThumb(itemId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ thumb_path: string }>(
    "SELECT thumb_path FROM photos WHERE item_id = ? AND kind = 'main' AND EXISTS (SELECT 1 FROM items WHERE items.id = photos.item_id AND items.status != 'deleted') LIMIT 1",
    itemId,
  );
  return row?.thumb_path ?? null;
}

/**
 * 归档：状态改为 archived 并递增 revision；同时取消该衣物 queued/running 的分析任务
 * （分批执行手册 R5），已保存的成功结果保留。
 */
export async function archiveItem(id: string): Promise<void> {
  const db = await getDb();
  const item = await getItem(id);
  if (!item || item.status === 'deleted') return;
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    if (item.status !== 'archived') {
      await db.runAsync(
        "UPDATE items SET status = 'archived', revision = revision + 1, updated_at = ? WHERE id = ? AND status != 'deleted'",
        now,
        id,
      );
    }
    await cancelActiveTasks(id);
  });
}

/** 恢复到衣橱（仅 archived 生效，且不复活已删除记录）；不自动重新分析 */
export async function restoreItem(id: string): Promise<void> {
  const db = await getDb();
  const item = await getItem(id);
  if (!item || item.status === 'deleted' || item.status === 'active') return;
  await db.runAsync(
    "UPDATE items SET status = 'active', revision = revision + 1, updated_at = ? WHERE id = ? AND status != 'deleted'",
    new Date().toISOString(),
    id,
  );
}

/**
 * 删除资料及照片，保留最小已删除标记供历史方案引用；重复调用可重试文件清理。
 * 资料事务内同时清理该衣物的分析属性与任务（分批执行手册 R5），收藏与穿着记录不动。
 */
export async function purgeItem(id: string): Promise<void> {
  const db = await getDb();
  const photos = await db.getAllAsync<{ original_path: string; thumb_path: string }>(
    'SELECT original_path, thumb_path FROM photos WHERE item_id = ?',
    id,
  );
  // 先使资料不可用；文件清理中断时保留路径记录，后续重试仍可清理。
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "UPDATE items SET status = 'deleted', name = NULL, category = NULL, main_photo_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?",
      new Date().toISOString(), id,
    );
    await db.runAsync('DELETE FROM attributes WHERE item_id = ?', id);
    await deleteTasksForItem(id);
  });
  for (const photo of photos) deletePhotoFiles(photo.original_path, photo.thumb_path);
  await db.runAsync('DELETE FROM photos WHERE item_id = ?', id);

}

/** 品类清单（衣橱筛选用） */
export const wardrobeCategories = categories;
