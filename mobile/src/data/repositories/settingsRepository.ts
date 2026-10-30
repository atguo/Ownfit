// 偏好（长期）与常用场景默认值的持久化。
// 规则依据：个人资料文档 §4.2（长期偏好 vs 当次意图分离）与天气文档 §4.1
// （常用场景只是默认值，当次调整不自动覆盖长期默认）。

import { getDb } from '../db';

export interface SceneDefault {
  city: string;
  day: '今天' | '明天';
  scene: string;
}

/**
 * preferences 是多用途共享表：偏好项、颜色库（color-library）、人物参考（preview-reference）都在其中。
 * 约定：偏好项 id 一律以 `pref-` 开头，其他用途避开该前缀——读取偏好时据此过滤，
 * 避免把颜色库/人物参考的 JSON 当成偏好显示（真机曾出现）。
 */
const PREFERENCE_ID_PREFIX = 'pref-';

export async function getPreferences(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ value: string }>(
    'SELECT value FROM preferences WHERE id LIKE ? ORDER BY created_at',
    `${PREFERENCE_ID_PREFIX}%`,
  );
  return rows.map((r) => r.value);
}

export async function setPreferences(values: string[]): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM preferences WHERE id LIKE ?', `${PREFERENCE_ID_PREFIX}%`);
    for (const value of values) {
      await db.runAsync(
        'INSERT INTO preferences (id, value, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        `pref-${value}-${Date.now().toString(36)}`,
        value,
        'user_selected',
        now,
        now,
      );
    }
  });
}

export async function getSceneDefault(): Promise<SceneDefault | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ city: string; day: '今天' | '明天'; scene: string }>(
    'SELECT city, day, scene FROM scene_default WHERE id = 1',
  );
  return row ?? null;
}

/** 保存常用场景默认值（仅当用户明确选择“保存为常用”时调用） */
export async function saveSceneDefault(defaultValue: SceneDefault): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO scene_default (id, city, day, scene, updated_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET city = excluded.city, day = excluded.day, scene = excluded.scene, updated_at = excluded.updated_at`,
    defaultValue.city,
    defaultValue.day,
    defaultValue.scene,
    new Date().toISOString(),
  );
}
