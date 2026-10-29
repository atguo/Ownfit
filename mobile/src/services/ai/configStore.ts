// AI 配置存储：
// - 非敏感配置（名称/类型/地址/模型 ID/能力/Key 引用）→ 应用私有目录 JSON 文件
// - API Key → expo-secure-store（设备安全存储），配置文件中只有 keyRef 引用
// M2 引入本地数据库后，此仓库整体迁入 DB（接口保持不变）。

import * as SecureStore from 'expo-secure-store';
import { File, Paths } from 'expo-file-system';
import { LEGACY_CALL_REVISION, type ModelConfig } from './types';

const CONFIG_FILE = 'ai-model-configs.json';

function configFile(): File {
  return new File(Paths.document, CONFIG_FILE);
}

export function loadConfigs(): ModelConfig[] {
  const file = configFile();
  if (!file.exists) return [];
  try {
    const parsed: unknown = JSON.parse(file.textSync());
    if (!Array.isArray(parsed)) return [];
    return parsed as ModelConfig[];
  } catch {
    // 文件损坏时不抛出、不静默清空：保留原文件并返回空列表，提示用户
    return [];
  }
}

/** 结构化读取结果：区分“没有配置”和“配置损坏”，避免把损坏当成未配置 */
export type ConfigsReadResult =
  | { ok: true; configs: ModelConfig[] }
  | { ok: false; reason: 'unreadable' };

/**
 * 分析等任务使用的结构化读取：文件不存在 = 空列表（合法）；文件存在但无法解析 = unreadable。
 * 不改变 loadConfigs 的既有行为（其调用方仍把它当空列表处理）。
 */
export function loadConfigsStructured(): ConfigsReadResult {
  const file = configFile();
  if (!file.exists) return { ok: true, configs: [] };
  try {
    const parsed: unknown = JSON.parse(file.textSync());
    if (!Array.isArray(parsed)) return { ok: false, reason: 'unreadable' };
    return { ok: true, configs: parsed as ModelConfig[] };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

function saveConfigs(configs: ModelConfig[]): void {
  configFile().writeSync(JSON.stringify(configs, null, 2));
}

export function getConfig(id: string): ModelConfig | undefined {
  return loadConfigs().find((c) => c.id === id);
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

/** 新增配置：生成 id 与 keyRef，写入 Key 与配置文件 */
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
  saveConfigs([...loadConfigs(), config]);
  return config;
}

/**
 * 更新配置：Key 为空时沿用原 Key；URL 类型/地址等变更后测试状态重置为未测试。
 * callRevision 仅在影响调用结果的字段变化时更新（名称、测试结果不算，见 D2）。
 */
export async function updateConfig(id: string, input: ConfigInput): Promise<ModelConfig | undefined> {
  const configs = loadConfigs();
  const index = configs.findIndex((c) => c.id === id);
  if (index < 0) return undefined;
  const previous = configs[index];
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
  configs[index] = config;
  saveConfigs(configs);
  return config;
}

/** 直接更新测试结果（测试连接专用） */
export async function updateTestResult(
  id: string,
  result: { testStatus: ModelConfig['testStatus']; testMessage?: string },
): Promise<void> {
  const configs = loadConfigs();
  const index = configs.findIndex((c) => c.id === id);
  if (index < 0) return;
  configs[index] = {
    ...configs[index],
    testStatus: result.testStatus,
    testMessage: result.testMessage,
    testedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveConfigs(configs);
}

/** 删除配置：二次确认由 UI 负责；这里级联删除安全存储中的 Key */
export async function deleteConfig(id: string): Promise<void> {
  const configs = loadConfigs();
  const target = configs.find((c) => c.id === id);
  if (target) {
    await SecureStore.deleteItemAsync(target.keyRef).catch(() => {
      // Key 已不存在时忽略，配置仍需删除
    });
  }
  saveConfigs(configs.filter((c) => c.id !== id));
}

/** 读取 Key（仅调用接口时使用；不落日志） */
export async function getApiKey(keyRef: string): Promise<string | null> {
  return SecureStore.getItemAsync(keyRef);
}
