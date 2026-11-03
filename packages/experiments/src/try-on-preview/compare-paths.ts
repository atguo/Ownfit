// C1 预览路径对照实验（2026-11-04，能力改进建议 §5 C1；决策记录见
// docs/plans/2026-11-04-核心目标能力改进-落地计划与决策记录.md）。
// 对照三臂（同人物、同衣物、同请求，逐张记录，人工核对回填 review）：
//   1. text-baseline  当前文字路径基线（MiniMax subject_reference + 文字约束，即 APP 现行为）。
//   2. text-checked   文字路径 + 生成后视觉核对（核对器=已配置 vision 档案，规则同 APP C8 v1）。
//   3. garment-image  衣物图输入路径——**未选定服务**（候选清单见 PROVIDERS.md），
//                     接入适配器前此臂不可用；不自动付费调用，选定后由项目用户告知再实现。
// 费用纪律：默认只打印计划与调用次数；加 --yes 才真正调用（费用走项目用户账号）。
// 结论边界：只有真实样本能产生结论；本脚本只提供对照执行与记录，不预设结果。
//
// 运行：
//   pnpm --filter @ownfit/experiments exec tsx src/try-on-preview/compare-paths.ts \
//     --person samples/person/front-full.jpg --garment samples/wardrobe/knit-01.jpg \
//     --desc "奶油白的宽松针织衫，圆领长袖" [--arms text-baseline,text-checked] [--yes]
// 未提供 --desc 时取 A-衣物理解对该样本的最新记录（records/garment-understanding/）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config';
import { toDataUrl } from '../lib/images';
import { findLatestParsed } from '../lib/records';
import { chatCompletion } from '../lib/client';
import { tryOnPrompt } from './prompt';
import { generateTryOnRecorded } from './minimax';
import type { GarmentUnderstanding } from '../garment-understanding/schema';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

type Arm = 'text-baseline' | 'text-checked' | 'garment-image';
const ALL_ARMS: Arm[] = ['text-baseline', 'text-checked', 'garment-image'];

interface Args {
  person?: string;
  garment?: string;
  desc?: string;
  arms: Arm[];
  yes: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const armsRaw = (get('--arms') ?? 'text-baseline,text-checked').split(',');
  const arms = armsRaw.map((a) => a.trim()).filter((a): a is Arm => (ALL_ARMS as string[]).includes(a));
  return {
    person: get('--person'),
    garment: get('--garment'),
    desc: get('--desc'),
    arms: arms.length ? arms : ['text-baseline', 'text-checked'],
    yes: argv.includes('--yes'),
  };
}

/** 与 APP C8 核对器同源的核对提示词（规则版本 1）；只检查可见且影响选择的特征 */
const CHECK_RULE_VERSION = '1';

function checkerSystemPrompt(): string {
  return [
    '你是穿搭生成结果的核对器。按顺序收到：第 1 张=单品原图，第 2 张=人物参考，第 3 张=AI 生成结果。',
    '只检查生成结果里可见且影响选择的特征：漏件/多件、颜色或图案明显改变、领型/袖型/长度明显错误、',
    '人物脸部/体型与参考照明显不符。遮挡或证据不足用 unknown，不要猜。',
    '输出紧凑 JSON：{"items":[{"itemId":"garment","status":"match|deviate|unknown","note":"一句话"}],"overall":"match|minor|major"}',
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  const config = loadConfig();

  if (!args.person || !args.garment) {
    console.error('需要 --person 与 --garment 指向 samples/ 下真实样本文件（样本不入库）。');
    process.exit(1);
  }
  const fs = await import('node:fs');
  if (!fs.existsSync(path.join(pkgRoot, args.person)) || !fs.existsSync(path.join(pkgRoot, args.garment))) {
    console.error('样本文件不存在：请确认相对 packages/experiments 的路径。');
    process.exit(1);
  }

  // 衣物描述：优先手工 --desc；否则取 A-衣物理解对该样本的最新记录
  let promptText: string;
  if (args.desc?.trim()) {
    promptText = `让图中的人物换上这件服装：${args.desc.trim()}。保持人物的脸部、发型、肤色、体型和姿势完全不变，服装的颜色、图案、领口、袖型和长度严格符合上述描述，生成自然的日常穿搭效果，真实感照片风格。`;
  } else {
    const latest = findLatestParsed('garment-understanding', args.garment);
    if (!latest || !latest.parsed) {
      console.error('没有该样本的 A-衣物理解记录且未提供 --desc。先跑 garment-understanding 或手工描述。');
      process.exit(1);
    }
    promptText = tryOnPrompt(latest.parsed as GarmentUnderstanding);
  }

  const visionProfile = Object.values(config.profiles).find((p) => p.capabilities.includes('vision'));
  const plannedGenerations = (args.arms.includes('text-baseline') ? 1 : 0) + (args.arms.includes('text-checked') ? 1 : 0);
  console.log('=== C1 预览路径对照 ===');
  console.log(`人物参考：${args.person}`);
  console.log(`衣物样本：${args.garment}`);
  console.log(`执行臂：${args.arms.join(', ')}`);
  console.log(`预计生成调用：${plannedGenerations} 次；核对调用：${args.arms.includes('text-checked') ? (visionProfile ? 1 : 0) : 0} 次`);
  if (args.arms.includes('garment-image')) {
    console.log('garment-image 臂：未选定服务（候选见 src/try-on-preview/PROVIDERS.md），适配器接入前不可用、不调用。');
  }
  if (!args.yes) {
    console.log('预览模式（未加 --yes）：不发生任何调用。确认费用后加 --yes 执行。');
    return;
  }
  if (!config.profiles['minimax']) {
    console.error('MiniMax 未配置（.env：MINIMAX_BASE_URL / MINIMAX_API_KEY）。');
    process.exit(1);
  }

  for (const arm of args.arms) {
    if (arm === 'garment-image') {
      console.log('\n[garment-image] 跳过：服务未选定（PROVIDERS.md），不产生调用。');
      continue;
    }
    console.log(`\n--- ${arm} ---`);
    const generation = await generateTryOnRecorded({
      personRef: args.person,
      prompt: promptText,
      aspectRatio: '2:3',
      runId: `compare-${Date.now().toString(36)}`,
      purpose: arm === 'text-baseline' ? 'C1 文字路径基线' : 'C1 文字路径+核对',
      inputRefs: [args.person, args.garment],
    });
    if (!generation.ok || generation.imageRefs.length === 0) {
      console.error(`生成失败：${generation.error?.message ?? '未返回图片'}`);
      continue;
    }
    console.log(`生成图：${generation.imageRefs.join(', ')}`);

    if (arm === 'text-checked') {
      if (!visionProfile) {
        console.log('未配置 vision 档案：无法自动核对，本次按"未自动核对"登记（诚实边界，不当通过）。');
        continue;
      }
      const resultRef = generation.imageRefs[0];
      const check = await chatCompletion(visionProfile, [
        { role: 'system', content: checkerSystemPrompt() },
        {
          role: 'user',
          content: [
            { type: 'text', text: '图1=单品原图，图2=人物参考，图3=生成结果。请输出 JSON 判定。' },
            { type: 'image_url', image_url: { url: toDataUrl(args.garment) } },
            { type: 'image_url', image_url: { url: toDataUrl(args.person) } },
            { type: 'image_url', image_url: { url: toDataUrl(resultRef) } },
          ],
        },
      ]);
      console.log(
        `核对结果（规则 v${CHECK_RULE_VERSION}）：${check.ok ? check.content.slice(0, 400) : `核对失败：${check.message}`}`,
      );
      console.log('人工核对后请回填 records/try-on-preview/ 的 review 字段（核对器也可能误判）。');
    }
  }
  console.log('\n完成。结论需人工逐张核对后形成，不能以生成成功代替真实性评价。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
