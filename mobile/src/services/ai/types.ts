// AI 服务配置的数据结构。
// 规则依据 docs/functions/AI模型配置与接入.md：
// - API Key 只存设备安全存储（expo-secure-store），普通配置文件里只放 keyRef 引用
// - 配置成功 ≠ 接口可访问 ≠ 具备某项业务能力，三种状态分开记录
// - 名称与模型 ID 是两个字段（2026-10-27 项目用户确认）

export type UrlKind = 'openai' | 'minimax';

export type AiCapability = 'text' | 'vision' | 'image_gen';

export const urlKindLabels: Record<UrlKind, string> = {
  openai: 'OpenAI 兼容',
  minimax: 'MiniMax 图像',
};

export const capabilityLabels: Record<AiCapability, string> = {
  text: '文本',
  vision: '视觉理解',
  image_gen: '图像生成',
};

export type TestStatus = 'untested' | 'passed' | 'failed';

export interface ModelConfig {
  id: string;
  /** 展示名称，如“智谱 GLM” */
  name: string;
  urlKind: UrlKind;
  /** 服务基础地址（不含接口路径，拼接规则由 urlKind 决定） */
  baseUrl: string;
  modelId: string;
  capabilities: AiCapability[];
  /** 设备安全存储中的 Key 引用；Key 本体绝不入此文件 */
  keyRef: string;
  /** 是否已在安全存储中保存了 Key */
  hasKey: boolean;
  testStatus: TestStatus;
  /** 测试失败时的摘要（不含 Key） */
  testMessage?: string;
  testedAt?: string;
  /**
   * 调用配置版本（D2，2026-10-29）：URL 类型/基础地址/模型 ID/能力标签/API Key 变化时更新；
   * 名称与连接测试结果变化不更新。旧配置缺省为 'legacy'，用于发送前判断配置是否被改过。
   */
  callRevision?: string;
  createdAt: string;
  updatedAt: string;
}

/** 旧配置（无 callRevision）的缺省版本标识 */
export const LEGACY_CALL_REVISION = 'legacy';

/** 读取配置的调用版本；缺失时按 legacy 处理 */
export function callRevisionOf(config: Pick<ModelConfig, 'callRevision'>): string {
  return config.callRevision ?? LEGACY_CALL_REVISION;
}

/** 基础地址是否可用于实际调用（必须是非空 http/https 地址） */
export function isValidBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  return /^https?:\/\/[^\s/]+/i.test(trimmed);
}

/** 是否可作为衣物分析的视觉候选（不含密钥可用性检查） */
export function isVisionCandidate(config: ModelConfig): boolean {
  return (
    config.urlKind === 'openai' &&
    config.capabilities.includes('vision') &&
    config.modelId.trim().length > 0 &&
    isValidBaseUrl(config.baseUrl)
  );
}

/** 拼接规则由 urlKind 决定（2026-10-27 确认的首批清单） */
export function endpointFor(kind: UrlKind, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return kind === 'openai' ? `${base}/chat/completions` : `${base}/v1/image_generation`;
}
