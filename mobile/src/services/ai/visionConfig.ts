// 视觉模型路由（分批执行手册 D1 / P4）。
// 只读取本地配置与设备安全存储中的密钥，**不发任何网络请求**；
// 区分“未配置”“配置无效”“配置损坏”，不把它们统一说成未配置。

import { getApiKey, loadConfigsStructured } from './configStore';
import { callRevisionOf, isVisionCandidate, type ModelConfig } from './types';

export type InvalidVisionConfigReason = 'config_unreadable' | 'config_invalid' | 'key_missing';

export type ConfigResolution =
  | { status: 'ready'; config: ModelConfig; callRevision: string }
  | { status: 'choose'; candidates: ModelConfig[] }
  | { status: 'missing' }
  | { status: 'invalid'; reason: InvalidVisionConfigReason; message: string };

/**
 * 解析可用的视觉模型配置。
 * @param defaultConfigId 该任务类型已记住的默认配置 ID（可为 null）。
 *
 * 规则（D1）：
 * - 无视觉候选 → missing；配置损坏 → invalid(config_unreadable)；
 * - 有视觉候选但地址/模型 ID 无效 → invalid(config_invalid)；
 * - 有有效候选但都读不到密钥 → invalid(key_missing)；
 * - 已记录的默认仍可用 → ready；无默认且只有一个候选 → ready（调用方负责记住）；
 * - **默认失效（缺失或不再可用）时即使只剩一个候选也返回 choose**，不静默切换供应商。
 */
export async function resolveVisionConfig(defaultConfigId?: string | null): Promise<ConfigResolution> {
  const read = loadConfigsStructured();
  if (!read.ok) {
    return {
      status: 'invalid',
      reason: 'config_unreadable',
      message: '本地模型配置无法读取（文件可能已损坏），请到“模型配置”检查后重试',
    };
  }

  const visionConfigs = read.configs.filter(
    (config) => config.urlKind === 'openai' && config.capabilities.includes('vision'),
  );
  if (visionConfigs.length === 0) {
    return { status: 'missing' };
  }

  const candidates = visionConfigs.filter(isVisionCandidate);
  if (candidates.length === 0) {
    return {
      status: 'invalid',
      reason: 'config_invalid',
      message: '视觉配置缺少有效的服务地址或模型 ID',
    };
  }

  const usable: ModelConfig[] = [];
  for (const config of candidates) {
    const key = await getApiKey(config.keyRef);
    if (key) usable.push(config);
  }
  if (usable.length === 0) {
    return {
      status: 'invalid',
      reason: 'key_missing',
      message: '视觉配置缺少可读取的 API Key，请在“模型配置”中补全',
    };
  }

  const preferred = defaultConfigId ? usable.find((config) => config.id === defaultConfigId) : undefined;
  if (preferred) {
    return { status: 'ready', config: preferred, callRevision: callRevisionOf(preferred) };
  }

  if (!defaultConfigId && usable.length === 1) {
    const only = usable[0];
    return { status: 'ready', config: only, callRevision: callRevisionOf(only) };
  }

  return { status: 'choose', candidates: usable };
}

/** 图像生成候选：MiniMax 图像 URL 类型 + image_gen 能力标签 */
function isImageGenCandidate(config: ModelConfig): boolean {
  return config.urlKind === 'minimax' && config.capabilities.includes('image_gen') && !!config.baseUrl && !!config.modelId;
}

/**
 * 解析可用的图像生成模型配置（上身预览用）。
 * 规则与 resolveVisionConfig 完全一致（D1）：missing/invalid/choose/ready，
 * 默认失效时即使只剩一个候选也 choose，不静默切换供应商。
 */
export async function resolveImageGenConfig(defaultConfigId?: string | null): Promise<ConfigResolution> {
  const read = loadConfigsStructured();
  if (!read.ok) {
    return {
      status: 'invalid',
      reason: 'config_unreadable',
      message: '本地模型配置无法读取（文件可能已损坏），请到“模型配置”检查后重试',
    };
  }

  const candidates = read.configs.filter(isImageGenCandidate);
  if (candidates.length === 0) {
    return { status: 'missing' };
  }

  const usable: ModelConfig[] = [];
  for (const config of candidates) {
    const key = await getApiKey(config.keyRef);
    if (key) usable.push(config);
  }
  if (usable.length === 0) {
    return {
      status: 'invalid',
      reason: 'key_missing',
      message: '图像生成配置缺少可读取的 API Key，请在“模型配置”中补全',
    };
  }

  const preferred = defaultConfigId ? usable.find((config) => config.id === defaultConfigId) : undefined;
  if (preferred) {
    return { status: 'ready', config: preferred, callRevision: callRevisionOf(preferred) };
  }

  if (!defaultConfigId && usable.length === 1) {
    const only = usable[0];
    return { status: 'ready', config: only, callRevision: callRevisionOf(only) };
  }

  return { status: 'choose', candidates: usable };
}
