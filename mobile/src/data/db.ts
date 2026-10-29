// M2 本地存储：加密 SQLite（SQLCipher）+ schema 版本迁移。
// 依据 docs/开发计划.md §5.2/§6.4 与 AGENTS.md §3.2：
// - 全库 SQLCipher 加密，密钥存设备安全存储（expo-secure-store），首次运行生成
// - schema 带 user_version 与迁移步骤；升级失败不清库
// - M2 起为正式数据模型，真实资料直接沿用到后续版本

import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const DB_NAME = 'ownfit.db';
const KEY_REF = 'db-encryption-key-v1';

let dbInstance: SQLite.SQLiteDatabase | null = null;

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

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = versionRow?.user_version ?? 0;

  if (version < 1) {
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
}

/** 打开（并按需初始化）加密数据库。整个 APP 共享一个连接。 */
export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) return dbInstance;
  const key = await getOrCreateKey();
  const db = await SQLite.openDatabaseAsync(DB_NAME, {
    enableChangeListener: false,
    useNewConnection: true,
  });
  // SQLCipher：PRAGMA key 必须是打开后的第一条语句
  await db.execAsync(`PRAGMA key = '${key}'`);
  // 校验密钥正确（错误密钥下任何查询都会报"文件不是数据库"）
  await db.getFirstAsync('SELECT count(*) FROM sqlite_master');
  await migrate(db);
  dbInstance = db;
  return db;
}

/** 仅供诊断使用：确认数据库已加密（加密后文件头不再是明文 SQLite 标记） */
export const DB_FILE_NAME = DB_NAME;
