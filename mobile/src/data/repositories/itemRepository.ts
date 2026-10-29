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
import { categories, type ItemCategory } from '../demo';

export type ItemStatus = 'draft' | 'active' | 'archived';

export interface WardrobeItem {
  id: string;
  status: ItemStatus;
  category: ItemCategory | null;
  name: string | null;
  sourceType: string;
  mainPhotoId: string | null;
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

/** 确认品类（+可选名称）：草稿 → 已入库，同时写入用户确认的品类属性 */
export async function confirmItem(
  id: string,
  input: { category: ItemCategory; name?: string },
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    'UPDATE items SET status = ?, category = ?, name = ?, updated_at = ? WHERE id = ?',
    'active',
    input.category,
    input.name?.trim() || null,
    now,
    id,
  );
  await db.runAsync(
    `INSERT INTO attributes (id, item_id, field, value, source_type, source_ref, confirm_status, recorded_at, item_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    `attr-${id}-category`,
    id,
    'category',
    input.category,
    'user_confirmed',
    '录入时手动确认',
    'confirmed',
    now,
  );
}

/** 编辑名称与品类（已入库件） */
export async function updateItemBasics(
  id: string,
  input: { name?: string | null; category?: ItemCategory },
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  const item = await getItem(id);
  if (!item) return;
  const name = input.name !== undefined ? input.name?.trim() || null : item.name;
  const category = input.category ?? item.category;
  await db.runAsync(
    'UPDATE items SET name = ?, category = ?, updated_at = ? WHERE id = ?',
    name,
    category,
    now,
    id,
  );
  if (input.category && input.category !== item.category) {
    await db.runAsync(
      `INSERT INTO attributes (id, item_id, field, value, source_type, source_ref, confirm_status, recorded_at, item_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      `attr-${id}-category-${Date.now().toString(36)}`,
      id,
      'category',
      input.category,
      'user_confirmed',
      '详情页手动修改',
      'confirmed',
      now,
    );
  }
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
    "SELECT thumb_path FROM photos WHERE item_id = ? AND kind = 'main' LIMIT 1",
    itemId,
  );
  return row?.thumb_path ?? null;
}

export async function archiveItem(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE items SET status = 'archived', updated_at = ? WHERE id = ?", new Date().toISOString(), id);
}

export async function restoreItem(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE items SET status = 'active', updated_at = ? WHERE id = ?", new Date().toISOString(), id);
}

/** 彻底删除：级联删除照片记录与文件。调用方必须先做二次确认。 */
export async function purgeItem(id: string): Promise<void> {
  const db = await getDb();
  const photos = await db.getAllAsync<{ original_path: string; thumb_path: string }>(
    'SELECT original_path, thumb_path FROM photos WHERE item_id = ?',
    id,
  );
  for (const photo of photos) deletePhotoFiles(photo.original_path, photo.thumb_path);
  await db.runAsync('DELETE FROM photos WHERE item_id = ?', id);
  await db.runAsync('DELETE FROM attributes WHERE item_id = ?', id);
  await db.runAsync('DELETE FROM items WHERE id = ?', id);
}

/** 品类清单（衣橱筛选用） */
export const wardrobeCategories = categories;
