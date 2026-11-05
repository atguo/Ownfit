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
  /** previews/ 与 preview-ref/ 下无产物/参考引用的文件（评估 §8.8；活动写入保护见年龄阈值） */
  previewOrphanFiles: string[];
}

function photosDir(): Directory {
  return new Directory(Paths.document, 'photos');
}

function thumbsDir(): Directory {
  return new Directory(Paths.document, 'thumbs');
}

function previewsDir(): Directory {
  return new Directory(Paths.document, 'previews');
}

function previewRefDir(): Directory {
  return new Directory(Paths.document, 'preview-ref');
}

/** 预览类文件的"活动写入保护"年龄：修改时间在该窗口内的文件视为可能在途写入，不清理 */
const PREVIEW_FILE_MIN_AGE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 待清理记录（评估 §8.9：删除失败文件的最小持久化记录，仅类型/路径/重试状态）
// ---------------------------------------------------------------------------

export interface PendingCleanupRecord {
  id: string;
  kind: string;
  path: string;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 登记一条删除失败的文件待清理（任何写文件联动处可调用；不抛出） */
export async function recordPendingCleanup(kind: string, path: string, error?: string): Promise<void> {
  try {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO pending_cleanup (id, kind, path, retry_count, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
      `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind,
      path,
      error ?? null,
      now,
      now,
    );
  } catch {
    // 记录失败不阻断主流程（文件清理是辅助动作）
  }
}

/** 全部待清理记录（数据工具页展示） */
export async function listPendingCleanup(): Promise<PendingCleanupRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    kind: string;
    path: string;
    retry_count: number;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>('SELECT * FROM pending_cleanup ORDER BY created_at ASC');
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    path: row.path,
    retryCount: row.retry_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** 重试待清理文件：删除成功即移除记录；失败递增计数并保留原因 */
export async function retryPendingCleanup(): Promise<{ removed: string[]; failed: string[] }> {
  const records = await listPendingCleanup();
  const removed: string[] = [];
  const failed: string[] = [];
  const db = await getDb();
  for (const record of records) {
    try {
      const file = new File(Paths.document, record.path);
      if (!file.exists) {
        await db.runAsync('DELETE FROM pending_cleanup WHERE id = ?', record.id);
        removed.push(record.path);
        continue;
      }
      file.delete();
      await db.runAsync('DELETE FROM pending_cleanup WHERE id = ?', record.id);
      removed.push(record.path);
    } catch (error) {
      failed.push(record.path);
      await db.runAsync(
        'UPDATE pending_cleanup SET retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?',
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
        record.id,
      );
    }
  }
  return { removed, failed };
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
  // 预览类引用：产物路径 + 人物参考记录 + 待清理记录（保护在途/失败重试中的文件）
  const artifactRows = await db.getAllAsync<{ path: string }>('SELECT path FROM preview_artifacts');
  for (const row of artifactRows) referenced.add(row.path);
  const refRow = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM preferences WHERE id = ?',
    'preview-reference',
  );
  if (refRow?.value) {
    try {
      const parsed = JSON.parse(refRow.value) as { path?: string };
      if (parsed?.path) referenced.add(parsed.path);
    } catch {
      // 记录损坏按无引用处理（文件成为孤儿候选，但仍有年龄保护）
    }
  }
  const cleanupRows = await db.getAllAsync<{ path: string }>('SELECT path FROM pending_cleanup');
  for (const row of cleanupRows) referenced.add(row.path);

  const previewOrphanFiles = [
    ...listFileNames(previewsDir()).map((name) => `previews/${name}`),
    ...listFileNames(previewRefDir()).map((name) => `preview-ref/${name}`),
  ].filter((path) => !referenced.has(path));

  const orphanFiles = [
    ...listFileNames(photosDir()).map((name) => `photos/${name}`),
    ...listFileNames(thumbsDir()).map((name) => `thumbs/${name}`),
  ].filter((path) => !referenced.has(path));

  return { missingFiles, danglingMainRefs, orphanFiles, rebuildableThumbs, previewOrphanFiles };
}

/** 文件是否足够"老"（活动写入保护）；修改时间未知时保守跳过 */
function isOldEnoughForCleanup(file: File): boolean {
  const modifiedAt = (file as unknown as { modificationTime?: number }).modificationTime;
  if (typeof modifiedAt !== 'number' || !(modifiedAt > 0)) return false;
  return Date.now() - modifiedAt > PREVIEW_FILE_MIN_AGE_MS;
}

/**
 * 清理孤儿文件：调用时重新扫描，只删除"无任何记录引用"的文件。
 * photos/thumbs 无记录引用即删；previews/preview-ref 额外要求"足够老"
 * （修改时间在保护窗口内的可能是下载/纠偏在途产物，不清）。
 * 返回实际删除的相对路径；删除失败登记 pending_cleanup。
 */
export async function cleanOrphanFiles(): Promise<{ deleted: string[] }> {
  const { orphanFiles, previewOrphanFiles } = await scanConsistency();
  const deleted: string[] = [];
  for (const path of orphanFiles) {
    const file = new File(Paths.document, path);
    if (file.exists) {
      try {
        file.delete();
        deleted.push(path);
      } catch (error) {
        await recordPendingCleanup('photos', path, error instanceof Error ? error.message : String(error));
      }
    }
  }
  for (const path of previewOrphanFiles) {
    const file = new File(Paths.document, path);
    if (!file.exists) continue;
    if (!isOldEnoughForCleanup(file)) continue; // 活动写入保护
    try {
      file.delete();
      deleted.push(path);
    } catch (error) {
      await recordPendingCleanup('previews', path, error instanceof Error ? error.message : String(error));
    }
  }
  return { deleted };
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

// ---------------------------------------------------------------------------
// 衣物档案导出（M5 轨 B1）：结构化档案 JSON，不含照片
// ---------------------------------------------------------------------------

export interface WardrobeProfileEntry {
  id: string;
  name: string | null;
  category: string | null;
  /** AI 与人工合并后的动态属性（同名取最新） */
  attributes: Array<{ name: string; value: string; source: string }>;
  /** 用户确认的颜色 */
  colors: Array<{ name: string; hex: string; isPrimary: boolean }>;
  /** 仅用户录入的测量 */
  measurements: Array<{ name: string; amount: string; unit: string; note?: string }>;
}

/**
 * 导出衣物档案（仅已入库、未归档、未删除的单品）。
 * 不含照片与路径——档案用于搭配推荐实验与调试，不需要图像。
 */
export async function exportWardrobeProfiles(): Promise<{
  exportedAt: string;
  items: WardrobeProfileEntry[];
}> {
  const db = await getDb();
  const { getAnalysisView } = await import('./attributeRepository');
  const rows = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM items WHERE status = 'active' ORDER BY created_at ASC",
  );
  const items: WardrobeProfileEntry[] = [];
  for (const [index, row] of rows.entries()) {
    const view = await getAnalysisView(row.id);
    items.push({
      // 导出用短别名（item-1..N）：真实 id 可能是早期的选图 URI（存量数据），
      // 不应把缓存路径喂给模型；档案内唯一即可，APP 侧接入时按序号回映真实 id。
      id: `item-${index + 1}`,
      name: view.suggestedName?.value ?? null,
      category: view.category.value ?? null,
      attributes: view.attributes.map((a) => ({ name: a.name, value: a.value, source: a.source })),
      colors: view.colors.value.map((c) => ({ name: c.name, hex: c.hex, isPrimary: c.isPrimary })),
      measurements: (view.measurements?.list ?? []).map((m) => ({
        name: m.name,
        amount: m.amount,
        unit: m.unit,
        ...(m.note ? { note: m.note } : {}),
      })),
    });
  }
  return { exportedAt: new Date().toISOString(), items };
}
