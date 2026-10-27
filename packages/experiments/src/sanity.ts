// A 线连通性冒烟：验证 .env 配置与 OpenAI 兼容协议是否可用。
// 文本一次（任一已配置服务）；若配置了视觉服务且 samples/wardrobe 有图，再发一张图验证图像输入。
// 运行：pnpm --filter @ownfit/experiments exec tsx src/sanity.ts

import { loadConfig, requireProfile, findProfileWith, type ServiceProfile } from './lib/config';
import { chatCompletion } from './lib/client';
import { listSampleImages, toDataUrl } from './lib/images';

function summarize(profile: ServiceProfile, ok: boolean, detail: string, latencyMs: number): string {
  const mark = ok ? '✓' : '✗';
  return `${mark} [${profile.name}] ${profile.modelId} @ ${profile.baseUrl} — ${detail}（${latencyMs}ms）`;
}

async function main() {
  const { profiles } = loadConfig();
  const configured = Object.keys(profiles);
  if (!configured.length) {
    console.error('未找到任何服务配置。请复制 packages/experiments/.env.example 为 .env 并填入凭证。');
    process.exit(1);
  }
  console.log(`已配置服务：${configured.join('、')}`);

  let failures = 0;

  // 1. 文本冒烟：每个已配置服务各一次
  for (const name of configured) {
    const profile = requireProfile(name);
    const result = await chatCompletion(profile, [
      { role: 'user', content: '请只回复两个字：收到' },
    ]);
    if (result.ok) {
      console.log(summarize(profile, true, `文本通，回复「${result.content.trim().slice(0, 20)}」`, result.latencyMs));
    } else {
      failures += 1;
      console.log(summarize(profile, false, `${result.kind}：${result.message.slice(0, 120)}`, result.latencyMs));
    }
  }

  // 2. 图像冒烟：第一个声明 vision 能力的服务
  const hasVision = Object.values(profiles).some((p) => p.capabilities.includes('vision'));
  const images = listSampleImages('samples/wardrobe');
  if (hasVision && images.length > 0) {
    const profile = findProfileWith('vision');
    const imageRef = images[0];
    const result = await chatCompletion(profile, [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张图里是什么？用不超过 15 个字回答。' },
          { type: 'image_url', image_url: { url: toDataUrl(imageRef) } },
        ],
      },
    ]);
    if (result.ok) {
      console.log(summarize(profile, true, `图像通（${imageRef}），回复「${result.content.trim().slice(0, 30)}」`, result.latencyMs));
    } else {
      failures += 1;
      console.log(summarize(profile, false, `图像：${result.kind}：${result.message.slice(0, 120)}`, result.latencyMs));
    }
  } else if (hasVision) {
    console.log('— 跳过图像冒烟：samples/wardrobe 下还没有图片（拍摄指南见 samples/README.md）');
  }

  if (failures > 0) {
    console.error(`\n冒烟未全部通过（${failures} 项失败）。`);
    process.exit(1);
  }
  console.log('\n冒烟通过。');
}

void main();
