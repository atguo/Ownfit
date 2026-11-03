// AI 配置存储（M6 批次 1.4 起为本地数据库）：
// - 非敏感配置（名称/类型/地址/模型 ID/能力/Key 引用）→ 加密库 ai_configs 表（schema v6）
// - API Key → expo-secure-store（设备安全存储），配置行只有 keyRef 引用
// 读取路径：启动时经 ensureConfigCache 把表载入内存镜像，同步 getter 读镜像
// （任务执行器/路由层保持既有同步签名，不在热路径加异步）；写路径直接落库并同步镜像。
// 历史：M2–M5.5 非敏感配置存应用私有 JSON；首次缓存初始化时表为空且 JSON 可解析则
// 搬入数据库并删除旧文件（表非空后不再读旧文件；损坏文件保留不删，迁移按空处理）。

import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import { getDb } from '../../data/db';
import { LEGACY_CALL_REVISION, type ModelConfig } from './types';

const CONFIG_FILE = 'ai-model-configs.json';

function configFile(): File {
  return new File(Paths.document, CONFIG_FILE);
}

/** 内存镜像：null = 尚未从数据库加载（或数据库未就绪），同步 getter 按未就绪处理 */
let cache: ModelConfig[] | null = null;

function rowToConfig(row: {
  id: string;
  name: string;
  url_kind: string;
  base_url: string;
  model_id: string;
  capabilities: string;
  key_ref: string;
  has_key: number;
  test_status: string;
  test_message: string | null;
  tested_at: string | null;
  call_revision: string | null;
  created_at: string;
  updated_at: string;
}): ModelConfig {
  let capabilities: ModelConfig['capabilities'] = [];
  try {
    const parsed: unknown = JSON.parse(row.capabilities);
    if (Array.isArray(parsed)) capabilities = parsed as ModelConfig['capabilities'];
  } catch {
    // 能力列表损坏按空处理，配置仍可见（可编辑修复）
  }
  return {
    id: row.id,
    name: row.name,
    urlKind: row.url_kind as ModelConfig['urlKind'],
    baseUrl: row.base_url,
    modelId: row.model_id,
    capabilities,
    keyRef: row.key_ref,
    hasKey: row.has_key === 1,
    testStatus: row.test_status as ModelConfig['testStatus'],
    ...(row.test_message != null ? { testMessage: row.test_message } : null),
    ...(row.tested_at != null ? { testedAt: row.tested_at } : null),
    ...(row.call_revision != null ? { callRevision: row.call_revision } : null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function configToRow(config: ModelConfig) {
  return [
    config.id,
    config.name,
    config.urlKind,
    config.baseUrl,
    config.modelId,
    JSON.stringify(config.capabilities),
    config.keyRef,
    config.hasKey ? 1 : 0,
    config.testStatus,
    config.testMessage ?? null,
    config.testedAt ?? null,
    config.callRevision ?? null,
    config.createdAt,
    config.updatedAt,
  ] as const;
}

const UPSERT_SQL = `INSERT INTO ai_configs (
     id, name, url_kind, base_url, model_id, capabilities, key_ref, has_key,
     test_status, test_message, tested_at, call_revision, created_at, updated_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     name = excluded.name, url_kind = excluded.url_kind, base_url = excluded.base_url,
     model_id = excluded.model_id, capabilities = excluded.capabilities, key_ref = excluded.key_ref,
     has_key = excluded.has_key, test_status = excluded.test_status, test_message = excluded.test_message,
     tested_at = excluded.tested_at, call_revision = excluded.call_revision, updated_at = excluded.updated_at`;

/** 旧 JSON → 数据库一次性搬迁：仅当表为空且文件可解析时执行；搬迁后尽力删除旧文件 */
async function migrateLegacyJsonFile(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  const file = configFile();
  if (!file.exists) return;
  const count = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM ai_configs');
  if ((count?.n ?? 0) > 0) return; // 表已有数据：不再读旧文件（删除失败残留的文件保持惰性）
  let configs: ModelConfig[];
  try {
    const parsed: unknown = JSON.parse(file.textSync());
    if (!Array.isArray(parsed)) return; // 损坏文件：保留原样，按无配置处理
    configs = parsed as ModelConfig[];
  } catch {
    return; // 解析失败：保留原文件，不静默清空来源
  }
  await db.withTransactionAsync(async () => {
    for (const config of configs) {
      await db.runAsync(UPSERT_SQL, ...configToRow(config));
    }
  });
  try {
    file.delete();
  } catch {
    // 删除失败：文件残留但不再被读取（表已非空，下次启动跳过迁移）
  }
}

/**
 * 从数据库加载配置镜像（APP 启动与数据库安全模式重试后调用）。
 * 成功后同步 getter 可用；失败时镜像保持未加载，AI 功能按"配置未就绪"表达。
 */
export async function ensureConfigCache(): Promise<boolean> {
  try {
    const db = await getDb();
    await migrateLegacyJsonFile(db);
    const rows = await db.getAllAsync<Parameters<typeof rowToConfig>[0]>(
      'SELECT * FROM ai_configs ORDER BY created_at ASC',
    );
    cache = rows.map(rowToConfig);
    return true;
  } catch {
    cache = null;
    return false;
  }
}

export function loadConfigs(): ModelConfig[] {
  return cache ?? [];
}

/** 结构化读取结果：区分“未就绪/损坏”和“没有配置”，避免把损坏当成未配置 */
export type ConfigsReadResult =
  | { ok: true; configs: ModelConfig[] }
  | { ok: false; reason: 'unreadable' };

/**
 * 结构化读取：镜像已加载 = 配置列表（空列表合法）；未加载 = unreadable
 * （数据库未就绪或历史文件损坏的情况由调用方按"配置不可用"表达）。
 */
export function loadConfigsStructured(): ConfigsReadResult {
  if (cache === null) return { ok: false, reason: 'unreadable' };
  return { ok: true, configs: cache };
}

export function getConfig(id: string): ModelConfig | undefined {
  return cache?.find((c) => c.id === id);
}

export interface ConfigInput {
  name: string;
  urlKind: ModelConfig['urlKind'];
  baseUrl: string;
  modelId: string;
  capabilities: ModelConfig['capabilities'];
  /** 新输入的 Key；为空表示沿用已保存的 Key（编辑场景） */
  apiKey?: string;
}

function newId(): string {
  return `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 生成新的调用版本标识（D2）。随机值，不由 Key 派生，避免任何形式的密钥哈希泄漏。
 */
function newCallRevision(): string {
  return `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function storeKey(keyRef: string, apiKey: string): Promise<void> {
  await SecureStore.setItemAsync(keyRef, apiKey, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/** 落库并同步内存镜像；失败抛出（调用方提示），镜像不动 */
async function persistConfig(config: ModelConfig): Promise<void> {
  const db = await getDb();
  await db.runAsync(UPSERT_SQL, ...configToRow(config));
  if (cache === null) await ensureConfigCache();
  else {
    const index = cache.findIndex((c) => c.id === config.id);
    if (index >= 0) cache[index] = config;
    else cache = [...cache, config];
  }
}

/** 新增配置：生成 id 与 keyRef，写入 Key 与配置表 */
export async function addConfig(input: ConfigInput): Promise<ModelConfig> {
  const id = newId();
  const keyRef = `ai-key-${id}`;
  if (input.apiKey) await storeKey(keyRef, input.apiKey);
  const now = new Date().toISOString();
  const config: ModelConfig = {
    id,
    name: input.name,
    urlKind: input.urlKind,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    capabilities: input.capabilities,
    keyRef,
    hasKey: !!input.apiKey,
    testStatus: 'untested',
    callRevision: newCallRevision(),
    createdAt: now,
    updatedAt: now,
  };
  await persistConfig(config);
  return config;
}

/**
 * 更新配置：Key 为空时沿用原 Key；URL 类型/地址等变更后测试状态重置为未测试。
 * callRevision 仅在影响调用结果的字段变化时更新（名称、测试结果不算，见 D2）。
 */
export async function updateConfig(id: string, input: ConfigInput): Promise<ModelConfig | undefined> {
  const previous = getConfig(id);
  if (!previous) return undefined;
  if (input.apiKey) await storeKey(previous.keyRef, input.apiKey);
  const callChanged =
    previous.urlKind !== input.urlKind ||
    previous.baseUrl !== input.baseUrl ||
    previous.modelId !== input.modelId ||
    JSON.stringify(previous.capabilities) !== JSON.stringify(input.capabilities) ||
    !!input.apiKey;
  const config: ModelConfig = {
    ...previous,
    name: input.name,
    urlKind: input.urlKind,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    capabilities: input.capabilities,
    hasKey: input.apiKey ? true : previous.hasKey,
    testStatus: 'untested',
    testMessage: undefined,
    testedAt: undefined,
    callRevision: callChanged ? newCallRevision() : previous.callRevision ?? LEGACY_CALL_REVISION,
    updatedAt: new Date().toISOString(),
  };
  await persistConfig(config);
  return config;
}

/** 直接更新测试结果（测试连接专用） */
export async function updateTestResult(
  id: string,
  result: { testStatus: ModelConfig['testStatus']; testMessage?: string },
): Promise<void> {
  const previous = getConfig(id);
  if (!previous) return;
  const config: ModelConfig = {
    ...previous,
    testStatus: result.testStatus,
    testMessage: result.testMessage,
    testedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await persistConfig(config);
}

/** 删除配置：二次确认由 UI 负责；这里级联删除安全存储中的 Key 与配置行 */
export async function deleteConfig(id: string): Promise<void> {
  const target = getConfig(id);
  if (target) {
    await SecureStore.deleteItemAsync(target.keyRef).catch(() => {
      // Key 已不存在时忽略，配置仍需删除
    });
  }
  const db = await getDb();
  await db.runAsync('DELETE FROM ai_configs WHERE id = ?', id);
  if (cache === null) await ensureConfigCache();
  else cache = cache.filter((c) => c.id !== id);
}

/** 读取 Key（仅调用接口时使用；不落日志） */
export async function getApiKey(keyRef: string): Promise<string | null> {
  return SecureStore.getItemAsync(keyRef);
}
