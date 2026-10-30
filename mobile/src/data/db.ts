// M2 本地存储：加密 SQLite（SQLCipher）+ schema 版本迁移。
// 依据 docs/开发计划.md §5.2/§6.4 与 AGENTS.md §3.2：
// - 全库 SQLCipher 加密，密钥存设备安全存储（expo-secure-store），首次运行生成
// - schema 带 user_version 与迁移步骤；升级失败不清库
// - M2 起为正式数据模型，真实资料直接沿用到后续版本
// - getDb 用 Promise 单例串行化初始化：并发调用共享同一过程，
//   避免"database is locked"（多连接同时迁移/写入）

import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const DB_NAME = 'ownfit.db';
const KEY_REF = 'db-encryption-key-v1';

/** 取（或首次生成）数据库加密密钥。密钥只存在于设备安全存储。 */
async function getOrCreateKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY_REF);
  if (existing) return existing;
  const bytes = await Crypto.getRandomBytesAsync(32);
  const key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(KEY_REF, key, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return key;
}

/** v1：M2 基础表（单品/照片/属性/偏好/场景默认） */
async function migrateToV1(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        category TEXT,
        name TEXT,
        source_type TEXT NOT NULL DEFAULT 'photo',
        main_photo_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY NOT NULL,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'main',
        original_path TEXT NOT NULL,
        thumb_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_photos_item ON photos(item_id);
      CREATE TABLE IF NOT EXISTS attributes (
        id TEXT PRIMARY KEY NOT NULL,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        value TEXT,
        unit TEXT,
        source_type TEXT NOT NULL,
        source_ref TEXT,
        confirm_status TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        item_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_attributes_item ON attributes(item_id);
      CREATE TABLE IF NOT EXISTS preferences (
        id TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user_selected',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scene_default (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        city TEXT,
        day TEXT,
        scene TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  await db.execAsync('PRAGMA user_version = 1');
}

/** v2：M3 方案（收藏）与穿着记录。契约结构见 packages/contract */
async function migrateToV2(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY NOT NULL,
        parent_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        name TEXT,
        basis_item_id TEXT NOT NULL,
        wear_slot TEXT NOT NULL DEFAULT '整体',
        wear_style TEXT NOT NULL,
        reason TEXT,
        scene_city TEXT,
        scene_day TEXT,
        scene_name TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plan_items (
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id),
        role TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (plan_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_plan_items_plan ON plan_items(plan_id);
      CREATE TABLE IF NOT EXISTS worn_records (
        id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        worn_at TEXT NOT NULL,
        satisfied TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_worn_plan ON worn_records(plan_id);
    `);
  await db.execAsync('PRAGMA user_version = 2');
}

/**
 * v3（分批执行手册 §3.2）：衣物分析任务、属性状态列、默认视觉模型。
 * schema 变更与 user_version 更新在同一事务内：中途失败整体回滚，保留原库，不清库。
 *
 * 事务方式：使用同一连接事务（withTransactionAsync），不使用 withExclusiveTransactionAsync。
 * 原因（2026-10-29 项目用户确认，替代手册原文的 exclusive 要求）：expo-sqlite 的
 * withExclusiveTransactionAsync 会新建原生连接且不继承 SQLCipher 密钥，加密库上会因缺少
 * PRAGMA key 而失败；本库为 SQLCipher 全库加密，必须复用已带密钥的连接。
 */
async function migrateToV3(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`
        ALTER TABLE items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE attributes ADD COLUMN value_state TEXT NOT NULL DEFAULT 'known';
        ALTER TABLE attributes ADD COLUMN value_format TEXT NOT NULL DEFAULT 'text';
        ALTER TABLE attributes ADD COLUMN analysis_task_id TEXT;
      `);
    // 旧记录 value 为 NULL 表示“未知”，不用空字符串冒充
    await db.execAsync("UPDATE attributes SET value_state = 'unknown' WHERE value IS NULL");
    await db.execAsync(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          item_id TEXT NOT NULL,
          status TEXT NOT NULL,
          input_revision INTEGER NOT NULL,
          attempt INTEGER NOT NULL,
          photo_id TEXT NOT NULL,
          input_key TEXT NOT NULL,
          request_key TEXT NOT NULL UNIQUE,
          config_id TEXT NOT NULL,
          config_snapshot TEXT NOT NULL,
          config_revision TEXT NOT NULL,
          contract_version TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          retry_of_task_id TEXT,
          result_json TEXT,
          error_kind TEXT,
          error_summary TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_item_created ON tasks(item_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_item ON tasks(item_id) WHERE status IN ('queued', 'running');
        CREATE TABLE IF NOT EXISTS ai_task_preferences (
          kind TEXT PRIMARY KEY NOT NULL,
          default_config_id TEXT NOT NULL
        );
      `);
    await db.execAsync('PRAGMA user_version = 3');
  });
}

/**
 * 各版本迁移步骤（顺序执行，每步把库推进到对应 user_version）。
 * 导出用于测试：测试必须调用这里的生产迁移步骤构造 v1/v2 库，
 * 不能在测试里另复制一套建表 SQL（分批执行手册 P2）。
 */
export const schemaMigrations: ReadonlyArray<{
  version: number;
  up: (db: SQLite.SQLiteDatabase) => Promise<void>;
}> = [
  { version: 1, up: migrateToV1 },
  { version: 2, up: migrateToV2 },
  { version: 3, up: migrateToV3 },
];

/**
 * 按 user_version 依次执行未完成的迁移（可测试）：只依赖 execAsync / getFirstAsync /
 * withExclusiveTransactionAsync，不依赖真实设备密钥或 SQLCipher 打开流程（分批执行手册 §3.3）。
 * 规则：不删除、不重建、不清空数据库；失败保留原库。
 */
export async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = versionRow?.user_version ?? 0;
  for (const step of schemaMigrations) {
    if (version < step.version) await step.up(db);
  }
}

/**
 * 打开（并按需初始化）加密数据库。整个 APP 共享一个连接。
 * Promise 单例：并发调用共享同一初始化过程，避免多连接锁冲突。
 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openAndMigrate();
    dbPromise.catch(() => {
      // 初始化失败时允许下次调用重试
      dbPromise = null;
    });
  }
  return dbPromise;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** 初始化失败信息（M4 安全模式）：阶段 + 原始消息；成功初始化后清除 */
export type DbInitFailure = { stage: 'open' | 'key' | 'migrate'; message: string };
let lastInitFailure: DbInitFailure | null = null;

/** 最近一次数据库初始化失败的阶段与消息；无失败时为 null（供安全模式展示与重试） */
export function getLastDbInitFailure(): DbInitFailure | null {
  return lastInitFailure;
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  try {
    const key = await getOrCreateKey();
    const db = await SQLite.openDatabaseAsync(DB_NAME, {
      enableChangeListener: false,
      useNewConnection: true,
    });
    try {
      // SQLCipher：PRAGMA key 必须是打开后的第一条语句
      await db.execAsync(`PRAGMA key = '${key}'`);
      // 校验密钥正确（错误密钥下任何查询都会报"文件不是数据库"）
      await db.getFirstAsync('SELECT count(*) FROM sqlite_master');
      await runMigrations(db);
      lastInitFailure = null;
      return db;
    } catch (error) {
      try {
        await db.closeAsync();
      } catch {
        // 关闭失败不影响错误上报
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stage: DbInitFailure['stage'] = message.includes('file is not a database')
      ? 'key'
      : /migration|user_version/i.test(message)
        ? 'migrate'
        : 'open';
    lastInitFailure = { stage, message };
    throw error;
  }
}

/** 仅供诊断使用：确认数据库已加密（加密后文件头不再是明文 SQLite 标记） */
export const DB_FILE_NAME = DB_NAME;
