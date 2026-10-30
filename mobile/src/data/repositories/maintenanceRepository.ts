// 数据一致性维护（M4 蓝图工作块 2，§6.4）：
// - 引用完整性扫描：悬空照片引用（记录在、文件缺）与悬空主图引用（items.main_photo_id 无对应记录）
// - 孤儿文件清点与清理：photos/、thumbs/ 下无任何 photos 记录引用的文件
//   （§6.4：清理前检查引用，只删"无任何记录引用"者；清理不修改数据库记录）
// - 缩略图重建：缩略图属可重建缓存，从原件再生成（原件缺失的无法重建，不 pretend）
// - 容量检查：可用空间低于阈值时拒绝新照片写入（由 photoRepository 保存前调用）
// 边界：扫描只读；清理在调用时重新扫描而非信任外部列表，避免竞态误删。

import * as ImageManipulator from 'expo-image-manipulator';
import { File, Directory, Paths } from 'expo-file-system';
import * as FileSystemLegacy from 'expo-file-system/legacy';
import { getDb } from '../db';

/** 新照片写入所需的最低可用空间（蓝图：50MB） */
export const MIN_FREE_BYTES_FOR_PHOTO = 50 * 1024 * 1024;

/** 缩略图宽度（与 photoRepository 的生成参数保持一致） */
const THUMB_WIDTH = 480;

export interface ConsistencyReport {
  /** 记录在、文件缺失（原件或缩略图至少其一缺失） */
  missingFiles: Array<{
    photoId: string;
    itemId: string;
    originalPath: string;
    thumbPath: string;
    missing: Array<'original' | 'thumb'>;
  }>;
  /** items.main_photo_id 指向不存在的照片记录 */
  danglingMainRefs: Array<{ itemId: string; mainPhotoId: string }>;
  /** 有文件、无 photos 记录引用（相对路径） */
  orphanFiles: string[];
  /** 缩略图缺失但原件在（可重建），值为照片记录 id */
  rebuildableThumbs: string[];
}

function photosDir(): Directory {
  return new Directory(Paths.document, 'photos');
}

function thumbsDir(): Directory {
  return new Directory(Paths.document, 'thumbs');
}

/** 列出目录下的文件名（目录不存在视为空；只认文件，忽略子目录） */
function listFileNames(dir: Directory): string[] {
  if (!dir.exists) return [];
  return dir
    .list()
    .filter((entry): entry is File => entry instanceof File)
    .map((file) => file.name);
}

function fileExists(relativePath: string): boolean {
  return new File(Paths.document, relativePath).exists;
}

/** 全库一致性扫描（只读，不修改任何记录或文件） */
export async function scanConsistency(): Promise<ConsistencyReport> {
  const db = await getDb();

  const photoRows = await db.getAllAsync<{
    id: string;
    item_id: string;
    original_path: string;
    thumb_path: string;
  }>('SELECT id, item_id, original_path, thumb_path FROM photos');

  const missingFiles: ConsistencyReport['missingFiles'] = [];
  const rebuildableThumbs: string[] = [];
  for (const row of photoRows) {
    const missing: Array<'original' | 'thumb'> = [];
    if (!fileExists(row.original_path)) missing.push('original');
    if (!fileExists(row.thumb_path)) missing.push('thumb');
    if (missing.length === 0) continue;
    missingFiles.push({
      photoId: row.id,
      itemId: row.item_id,
      originalPath: row.original_path,
      thumbPath: row.thumb_path,
      missing,
    });
    // 只有原件在、仅缩略图缺失时才可重建（原件是唯一事实来源）
    if (!missing.includes('original') && missing.includes('thumb')) {
      rebuildableThumbs.push(row.id);
    }
  }

  const danglingMainRefs = (
    await db.getAllAsync<{ id: string; main_photo_id: string }>(
      `SELECT i.id AS id, i.main_photo_id AS main_photo_id
         FROM items i LEFT JOIN photos p ON p.id = i.main_photo_id
        WHERE i.main_photo_id IS NOT NULL AND p.id IS NULL`,
    )
  ).map((row) => ({ itemId: row.id, mainPhotoId: row.main_photo_id }));

  const referenced = new Set<string>();
  for (const row of photoRows) {
    referenced.add(row.original_path);
    referenced.add(row.thumb_path);
  }
  const orphanFiles = [
    ...listFileNames(photosDir()).map((name) => `photos/${name}`),
    ...listFileNames(thumbsDir()).map((name) => `thumbs/${name}`),
  ].filter((path) => !referenced.has(path));

  return { missingFiles, danglingMainRefs, orphanFiles, rebuildableThumbs };
}

/**
 * 清理孤儿文件：调用时重新扫描，只删除"无任何 photos 记录引用"的文件。
 * 返回实际删除的相对路径；不修改数据库记录（记录是事实，文件是资源）。
 */
export async function cleanOrphanFiles(): Promise<{ deleted: string[] }> {
  const { orphanFiles } = await scanConsistency();
  for (const path of orphanFiles) {
    const file = new File(Paths.document, path);
    if (file.exists) file.delete();
  }
  return { deleted: orphanFiles };
}

/**
 * 从原件重建缺失的缩略图（可重建清单来自扫描；只处理原件仍在者）。
 * 生成成功才移动到位（失败不破坏原有数据），返回重建与失败的照片 id。
 */
export async function rebuildMissingThumbnails(): Promise<{ rebuilt: string[]; failed: string[] }> {
  const db = await getDb();
  const rebuilt: string[] = [];
  const failed: string[] = [];

  for (const photoId of (await scanConsistency()).rebuildableThumbs) {
    const row = await db.getFirstAsync<{ original_path: string; thumb_path: string }>(
      'SELECT original_path, thumb_path FROM photos WHERE id = ?',
      photoId,
    );
    if (!row) continue;
    const originalUri = `${Paths.document.uri}/${row.original_path}`;
    try {
      const ref = await ImageManipulator.ImageManipulator.manipulate(originalUri)
        .resize({ width: THUMB_WIDTH })
        .renderAsync();
      const saved = await ref.saveAsync({ compress: 0.75, format: ImageManipulator.SaveFormat.JPEG });
      const target = new File(Paths.document, row.thumb_path);
      if (target.exists) target.delete();
      new File(saved.uri).move(target);
      rebuilt.push(photoId);
    } catch {
      failed.push(photoId);
    }
  }
  return { rebuilt, failed };
}

/**
 * 可用空间字节数；系统接口失败时返回 null（调用方不得把 null 当作 0 阻断用户，
 * 写入失败另有兜底处理，不因探测失败而拒绝保存）。
 */
export async function getFreeDiskBytes(): Promise<number | null> {
  try {
    const bytes = await FileSystemLegacy.getFreeDiskStorageAsync();
    return typeof bytes === 'number' && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

/** 是否还有空间写入新照片；探测失败视为有（由写入失败兜底） */
export async function hasRoomForNewPhoto(): Promise<boolean> {
  const free = await getFreeDiskBytes();
  return free === null || free >= MIN_FREE_BYTES_FOR_PHOTO;
}
