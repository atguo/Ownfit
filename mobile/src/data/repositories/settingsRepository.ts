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

// 身材资料（M6 批次 2，2026-11-03 项目用户决定内测前实现基础录入）：
// 仅身高/体重两项选填，存 preferences 表 JSON（id 避开 pref- 前缀，同 color-library/preview-reference 约定）。
// 只存本机；仅作为 AI 推荐的体型参考织入提示词，不作合身判断、不收集围度。
export interface BodyProfile {
  heightCm?: number;
  weightKg?: number;
  updatedAt: string;
}

const BODY_PROFILE_ID = 'body-profile';

function parseBodyProfile(raw: string): BodyProfile | null {
  try {
    const parsed = JSON.parse(raw) as BodyProfile;
    if (!parsed || typeof parsed !== 'object') return null;
    const profile: BodyProfile = { updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '' };
    if (typeof parsed.heightCm === 'number' && parsed.heightCm > 0) profile.heightCm = parsed.heightCm;
    if (typeof parsed.weightKg === 'number' && parsed.weightKg > 0) profile.weightKg = parsed.weightKg;
    if (!profile.heightCm && !profile.weightKg) return null;
    return profile;
  } catch {
    return null;
  }
}

export async function getBodyProfile(): Promise<BodyProfile | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM preferences WHERE id = ?',
    BODY_PROFILE_ID,
  );
  return row?.value ? parseBodyProfile(row.value) : null;
}

/** 保存身材资料；两项都为空视为清除记录（返回 null）。数值四舍五入到一位小数。 */
export async function saveBodyProfile(
  input: { heightCm?: number | null; weightKg?: number | null },
): Promise<BodyProfile | null> {
  const db = await getDb();
  const round1 = (value: number) => Math.round(value * 10) / 10;
  const heightCm = typeof input.heightCm === 'number' && input.heightCm > 0 ? round1(input.heightCm) : undefined;
  const weightKg = typeof input.weightKg === 'number' && input.weightKg > 0 ? round1(input.weightKg) : undefined;
  if (!heightCm && !weightKg) {
    await db.runAsync('DELETE FROM preferences WHERE id = ?', BODY_PROFILE_ID);
    return null;
  }
  const profile: BodyProfile = { updatedAt: new Date().toISOString() };
  if (heightCm) profile.heightCm = heightCm;
  if (weightKg) profile.weightKg = weightKg;
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO preferences (id, value, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    BODY_PROFILE_ID,
    JSON.stringify(profile),
    'user_selected',
    now,
    now,
  );
  return profile;
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
