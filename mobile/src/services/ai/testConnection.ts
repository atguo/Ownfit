// 连接测试：配置成功 ≠ 接口可访问，用最小代价的真实请求区分状态。
// OpenAI 兼容：一次极小文本请求（max_tokens=16，费用可忽略）。
// MiniMax 图像：协议无免费端点，测试会实际生成一张 512px 图（表单已明示会产生费用）。

import type { ModelConfig } from './types';
import { getApiKey } from './configStore';
import { chatCompletion } from './openaiClient';
import { generateImage } from './minimaxClient';

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export async function testConnection(config: ModelConfig, draftApiKey?: string): Promise<ConnectionTestResult> {
  const apiKey = draftApiKey ?? (await getApiKey(config.keyRef));
  if (!apiKey) {
    return { ok: false, message: '尚未填写 API Key' };
  }

  if (config.urlKind === 'openai') {
    const result = await chatCompletion(config, apiKey, [
      { role: 'user', content: 'hi' },
    ]);
    if (result.ok) {
      return {
        ok: true,
        message: result.content.trim()
          ? `连接成功（${result.latencyMs}ms）`
          : `连接成功（${result.latencyMs}ms）。模型未返回可见文本——推理型模型常见，不影响连接判断`,
      };
    }
    return {
      ok: false,
      message: `${result.error?.kind ?? 'unknown'}：${result.error?.message ?? '未知错误'}`,
    };
  }

  // MiniMax 图像：最小一张 512px
  const result = await generateImage(config, apiKey, {
    prompt: 'a simple green leaf on white background',
    aspectRatio: '1:1',
    n: 1,
  });
  if (result.ok) {
    return { ok: true, message: `连接成功，已生成测试图（${result.latencyMs}ms）` };
  }
  return {
    ok: false,
    message: `${result.error?.kind ?? 'unknown'}：${result.error?.message ?? '未知错误'}`,
  };
}
