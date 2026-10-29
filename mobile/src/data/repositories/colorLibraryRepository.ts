// 颜色库仓库（重构设计 §10）：用户确认过的颜色集合，跨单品共用。
// 存储复用 preferences 表（id='color-library'，JSON），无 schema 迁移。
// 只有用户确认的颜色才入库；AI 推断未确认不入库。按 hex+name 去重。

import { getDb } from '../db';

export interface ColorEntry {
  name: string;
  hex: string;
  addedAt: string;
}

const COLOR_LIBRARY_ID = 'color-library';

export async function getColorLibrary(): Promise<ColorEntry[]> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM preferences WHERE id = ?',
    COLOR_LIBRARY_ID,
  );
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value) as ColorEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 并入颜色（按 hex+name 去重；已有则更新 addedAt 不重复追加） */
export async function addToColorLibrary(colors: { name: string; hex: string }[]): Promise<void> {
  if (colors.length === 0) return;
  const db = await getDb();
  const existing = await getColorLibrary();
  const now = new Date().toISOString();
  const byKey = new Map(existing.map((entry) => [`${entry.hex}|${entry.name}`, entry]));
  for (const color of colors) {
    const key = `${color.hex}|${color.name}`;
    if (!byKey.has(key)) {
      byKey.set(key, { name: color.name, hex: color.hex, addedAt: now });
    } else {
      byKey.get(key)!.addedAt = now;
    }
  }
  const merged = [...byKey.values()];
  await db.runAsync(
    `INSERT INTO preferences (id, value, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    COLOR_LIBRARY_ID,
    JSON.stringify(merged),
    now,
    now,
  );
}
