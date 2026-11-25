// 照片仓库：选图后的原件副本落盘 + 缩略图生成 + 数据库记录。
// 规则依据衣橱功能文档 §5.3：
// - 选图后立即保存本地副本与稳定资源引用，不依赖临时相册 URI
// - 原件存应用私有持久目录（不是缓存）；缩略图属可清理缓存，可随时重建
// - 文件写入失败不伪装入库成功（写入在先、记录在后）

import * as ImageManipulator from 'expo-image-manipulator';
import { File, Directory, Paths } from 'expo-file-system';
import { getDb } from '../db';
import { hasRoomForNewPhoto } from './maintenanceRepository';

/** 原件副本的最长边（px）。完整原图保留在系统相册，APP 不承诺管理相册原件。 */
export const ORIGINAL_MAX_DIMENSION = 2048;
const THUMB_WIDTH = 480;
/** 单件衣物最多保存的照片张数（1 张主图 + 最多 5 张补充细节/背面图） */
export const MAX_ITEM_PHOTOS = 6;

export interface SavedPhoto {
  id: string;
  itemId: string;
  kind: 'main' | 'extra';
  originalPath: string;
  thumbPath: string;
}

function photosDir(): Directory {
  const dir = new Directory(Paths.document, 'photos');
  if (!dir.exists) dir.create();
  return dir;
}

function thumbsDir(): Directory {
  const dir = new Directory(Paths.document, 'thumbs');
  if (!dir.exists) dir.create();
  return dir;
}

function newId(): string {
  return `ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 把缓存里的渲染结果移动到持久目录，返回相对路径 */
function persistFile(cacheUri: string, targetDir: Directory, fileName: string, relativeRoot: string): string {
  const source = new File(cacheUri);
  const target = new File(targetDir, fileName);
  if (target.exists) target.delete();
  source.move(target);
  return `${relativeRoot}/${fileName}`;
}

/**
 * 从选图结果保存照片文件：原件副本（≤2048px）+ 缩略图（480px）。
 * 两个文件都成功落盘后才返回；任一步失败会清理已写文件并抛出——
 * 不留下半份文件（缩略图从缓存原图生成，生成成功后才移动，避免移动后源丢失）。
 */
export async function savePhotoFiles(input: {
  sourceUri: string;
  sourceWidth: number;
  sourceHeight: number;
}): Promise<{ id: string; originalPath: string; thumbPath: string }> {
  // 容量防御（M4）：可用空间低于阈值时拒绝写入，避免写一半失败留下悬空记录
  if (!(await hasRoomForNewPhoto())) {
    throw new Error('设备存储空间不足（低于 50MB），已停止保存新照片。请清理空间后重试。');
  }
  const id = newId();

  // 1. 原件副本：超过 2048px 等比缩小，小图保持原样
  let builder = ImageManipulator.ImageManipulator.manipulate(input.sourceUri);
  if (input.sourceWidth > ORIGINAL_MAX_DIMENSION || input.sourceHeight > ORIGINAL_MAX_DIMENSION) {
    const scale = ORIGINAL_MAX_DIMENSION / Math.max(input.sourceWidth, input.sourceHeight);
    builder = builder.resize({
      width: Math.round(input.sourceWidth * scale),
      height: Math.round(input.sourceHeight * scale),
    });
  }
  const originalRef = await builder.renderAsync();
  const savedOriginal = await originalRef.saveAsync({ compress: 0.85, format: ImageManipulator.SaveFormat.JPEG });

  // 2. 缩略图：从缓存原图生成（此刻原图还在缓存，未被移动）
  let thumbSavedUri: string;
  try {
    const thumbRef = await ImageManipulator.ImageManipulator.manipulate(savedOriginal.uri)
      .resize({ width: THUMB_WIDTH })
      .renderAsync();
    const savedThumb = await thumbRef.saveAsync({ compress: 0.75, format: ImageManipulator.SaveFormat.JPEG });
    thumbSavedUri = savedThumb.uri;
  } catch (error) {
    new File(savedOriginal.uri).delete(); // 清理缓存副本
    throw error;
  }

  // 3. 两个文件都就绪后才移入持久目录
  const originalPath = persistFile(savedOriginal.uri, photosDir(), `${id}.jpg`, 'photos');
  let thumbPath: string;
  try {
    thumbPath = persistFile(thumbSavedUri, thumbsDir(), `${id}.jpg`, 'thumbs');
  } catch (error) {
    new File(Paths.document, originalPath).delete();
    throw error;
  }

  return { id, originalPath, thumbPath };
}

/** 把已落盘的照片文件写入数据库记录（文件成功落盘之后调用） */
export async function insertPhotoRecord(input: {
  id: string;
  itemId: string;
  kind: 'main' | 'extra';
  originalPath: string;
  thumbPath: string;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO photos (id, item_id, kind, original_path, thumb_path, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    input.id,
    input.itemId,
    input.kind,
    input.originalPath,
    input.thumbPath,
    new Date().toISOString(),
  );
}

/** 解析相对路径为可显示的 file:// URI（列表与详情共用） */
export function photoUri(relativePath: string): string {
  return `${Paths.document.uri}/${relativePath}`;
}

/** 列出某件单品的全部照片（主图优先，其次按创建时间正序） */
export async function listPhotosForItem(itemId: string): Promise<SavedPhoto[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    item_id: string;
    kind: 'main' | 'extra';
    original_path: string;
    thumb_path: string;
  }>(
    `SELECT id, item_id, kind, original_path, thumb_path
       FROM photos
      WHERE item_id = ?
        AND EXISTS (SELECT 1 FROM items WHERE items.id = photos.item_id AND items.status != 'deleted')
      ORDER BY CASE WHEN kind = 'main' THEN 0 ELSE 1 END, created_at ASC, rowid ASC`,
    itemId,
  );
  return rows.map((row) => ({
    id: row.id,
    itemId: row.item_id,
    kind: row.kind,
    originalPath: row.original_path,
    thumbPath: row.thumb_path,
  }));
}

/**
 * 给同一件单品补充一张照片（kind='extra'），同时推进 items.revision。
 * 写入失败时回滚已落盘文件，不留悬空记录。
 */
export async function addExtraPhotoToItem(
  itemId: string,
  input: { sourceUri: string; sourceWidth?: number; sourceHeight?: number },
): Promise<SavedPhoto> {
  const existing = await listPhotosForItem(itemId);
  if (existing.length >= MAX_ITEM_PHOTOS) {
    throw new Error(`同一件衣物最多保存 ${MAX_ITEM_PHOTOS} 张照片`);
  }
  const files = await savePhotoFiles({
    sourceUri: input.sourceUri,
    sourceWidth: input.sourceWidth ?? ORIGINAL_MAX_DIMENSION + 1,
    sourceHeight: input.sourceHeight ?? ORIGINAL_MAX_DIMENSION + 1,
  });
  const db = await getDb();
  const now = new Date().toISOString();
  const kind: 'main' | 'extra' = existing.length === 0 ? 'main' : 'extra';
  try {
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        'INSERT INTO photos (id, item_id, kind, original_path, thumb_path, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        files.id,
        itemId,
        kind,
        files.originalPath,
        files.thumbPath,
        now,
      );
      if (kind === 'main') {
        await db.runAsync(
          'UPDATE items SET main_photo_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
          files.id,
          now,
          itemId,
        );
      } else {
        await db.runAsync(
          'UPDATE items SET revision = revision + 1, updated_at = ? WHERE id = ?',
          now,
          itemId,
        );
      }
    });
  } catch (error) {
    deletePhotoFiles(files.originalPath, files.thumbPath);
    throw error;
  }
  return { id: files.id, itemId, kind, originalPath: files.originalPath, thumbPath: files.thumbPath };
}

/** 将某件单品的指定照片设为主图（同事务更新 kind、items.main_photo_id 与 revision） */
export async function setMainPhotoForItem(itemId: string, photoId: string): Promise<void> {
  const db = await getDb();
  const target = await db.getFirstAsync<{ id: string }>(
    'SELECT id FROM photos WHERE id = ? AND item_id = ?',
    photoId,
    itemId,
  );
  if (!target) throw new Error('所选照片不存在');
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync("UPDATE photos SET kind = 'extra' WHERE item_id = ? AND id != ?", itemId, photoId);
    await db.runAsync("UPDATE photos SET kind = 'main' WHERE id = ?", photoId);
    await db.runAsync(
      'UPDATE items SET main_photo_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      photoId,
      now,
      itemId,
    );
  });
}

/** 删除单品的一张非主图补充照片（保留至少 1 张主图；同步清理文件并递增 revision） */
export async function deleteExtraPhotoFromItem(itemId: string, photoId: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string; kind: string; original_path: string; thumb_path: string }>(
    'SELECT id, kind, original_path, thumb_path FROM photos WHERE id = ? AND item_id = ?',
    photoId,
    itemId,
  );
  if (!row) return;
  if (row.kind === 'main') {
    throw new Error('请先将另一张照片设为主图，再删除当前主图');
  }
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM photos WHERE id = ?', photoId);
    await db.runAsync(
      'UPDATE items SET revision = revision + 1, updated_at = ? WHERE id = ?',
      now,
      itemId,
    );
  });
  deletePhotoFiles(row.original_path, row.thumb_path);
}

/** 主图路径对（详情用原图、列表用缩略图） */
export async function getMainPhotoPaths(
  itemId: string,
): Promise<{ originalPath: string; thumbPath: string } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ original_path: string; thumb_path: string }>(
    "SELECT original_path, thumb_path FROM photos WHERE item_id = ? AND kind = 'main' AND EXISTS (SELECT 1 FROM items WHERE items.id = photos.item_id AND items.status != 'deleted') LIMIT 1",
    itemId,
  );
  return row ? { originalPath: row.original_path, thumbPath: row.thumb_path } : null;
}

/** 删除一张照片的文件（彻底删除单品时级联调用） */
export function deletePhotoFiles(originalPath: string, thumbPath: string): void {
  for (const p of [originalPath, thumbPath]) {
    const file = new File(Paths.document, p);
    if (file.exists) file.delete();
  }
}

/**
 * 按衣物主图引用（items.main_photo_id）解析稳定的分析输入照片。
 * 不用 kind='main' 兜底猜测，也不用列表缩略图替代分析证据。
 * 衣物已删除或主图缺失时返回 null（调用方据此拒绝创建/提交任务）。
 */
export async function getMainPhotoForAnalysis(
  itemId: string,
): Promise<{ photoId: string; originalPath: string } | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string; original_path: string }>(
    `SELECT p.id AS id, p.original_path AS original_path
       FROM items i JOIN photos p ON p.id = i.main_photo_id
      WHERE i.id = ? AND i.status != 'deleted'`,
    itemId,
  );
  return row ? { photoId: row.id, originalPath: row.original_path } : null;
}

export type AnalysisImageResult =
  | { ok: true; photoId: string; dataUrl: string }
  | { ok: false; reason: 'photo_missing' | 'file_missing' };

/**
 * 读取分析用图片：本件原件副本（photos/ 下 ≤2048px 的 JPEG），转成内存 data URL。
 * 发送前校验文件仍在（删除或清理后的路径不得再作为输入）；不返回本地 file URI。
 */
export async function readAnalysisImage(itemId: string): Promise<AnalysisImageResult> {
  const photo = await getMainPhotoForAnalysis(itemId);
  if (!photo) return { ok: false, reason: 'photo_missing' };
  const file = new File(Paths.document, photo.originalPath);
  if (!file.exists) return { ok: false, reason: 'file_missing' };
  const base64 = await file.base64();
  return { ok: true, photoId: photo.photoId, dataUrl: `data:image/jpeg;base64,${base64}` };
}
