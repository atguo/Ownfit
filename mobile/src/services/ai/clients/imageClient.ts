// 图像生成统一协议分发层：
// 按 config.urlKind 分流到对应协议客户端，业务层（previewStore / testConnection）不直接绑定具体厂商。
// - openai_images：通用 OpenAI 图像兼容协议（火山方舟 Seedream 5.0 等多图参考 JSON 接口）
// - minimax：MiniMax 图像协议（H3-Image 多图 edits / 旧 image-01 subject_reference）

import type { ModelConfig } from '../types';
import { generateImage as generateMinimaxImage, isH3ImageModel, type ImageGenInput, type ImageGenResult } from './minimaxClient';
import { generateOpenAIImage } from './openaiImagesClient';

export type { ImageGenInput, ImageGenResult };

/** 当前图像配置是否支持“人物 + 多件衣物实拍图”真图参考路径 */
export function supportsGarmentReferenceImages(
  config: Pick<ModelConfig, 'urlKind' | 'modelId'>,
): boolean {
  if (config.urlKind === 'openai_images') return true;
  if (config.urlKind === 'minimax') return isH3ImageModel(config.modelId);
  return false;
}

/** 按配置协议分发图像生成请求 */
export async function generateImageByConfig(
  config: Pick<ModelConfig, 'urlKind' | 'baseUrl' | 'modelId'>,
  apiKey: string,
  input: ImageGenInput,
  timeoutMs = 120000,
): Promise<ImageGenResult> {
  if (config.urlKind === 'openai_images') {
    return generateOpenAIImage(config, apiKey, input, timeoutMs);
  }
  return generateMinimaxImage(config, apiKey, input, timeoutMs);
}
