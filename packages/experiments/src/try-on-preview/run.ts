// A-上身预览跑批：人物参考照 + 服装描述 → MiniMax image-01 生成试穿图。
// 服装描述优先取 A-衣物理解的真实记录（records/garment-understanding/），
// 没有时用 --desc 手工描述——两种方式的生成质量差异本身是实验观测点。
//
// 运行：
//   pnpm --filter @ownfit/experiments exec tsx src/try-on-preview/run.ts \
//     --person samples/person/front-full.jpg \
//     --garment samples/wardrobe/knit-01.jpg      # 走 A1 理解记录
//     （或 --desc "奶油白的宽松针织衫，圆领长袖"）  # 手工描述
//   加 --yes 真正调用（费用走你的账号）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config';
import { findLatestParsed } from '../lib/records';
import { tryOnPrompt } from './prompt';
import { generateTryOnRecorded } from './minimax';
import type { GarmentUnderstanding } from '../garment-understanding/schema';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

interface Args {
  person?: string;
  garment?: string;
  desc?: string;
  aspect: '1:1' | '2:3' | '3:4' | '9:16';
  n: number;
  yes: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const aspect = (get('--aspect') ?? '2:3') as Args['aspect'];
  return {
    person: get('--person'),
    garment: get('--garment'),
    desc: get('--desc'),
    aspect: (['1:1', '2:3', '3:4', '9:16'] as const).includes(aspect) ? aspect : '2:3',
    n: Number(get('--n') ?? 1) || 1,
    yes: argv.includes('--yes'),
  };
}

function fileExists(relative: string | undefined): relative is string {
  return !!relative && fs.existsSync(path.join(pkgRoot, relative));
}

async function main() {
  const args = parseArgs();

  if (!loadConfig().profiles['minimax']) {
    console.error('MiniMax 未配置。请在 .env 填入 MINIMAX_BASE_URL / MINIMAX_API_KEY（模型已定 image-01）。');
    process.exit(1);
  }
  if (!fileExists(args.person)) {
    console.error('需要 --person <人物参考照路径>（正面全身，单人；拍摄规范见 samples/README.md）');
    process.exit(1);
  }

  // 服装描述：优先 A1 理解记录（真实管线），否则手工描述
  let prompt: string;
  let promptSource: string;
  const inputRefs = [args.person];
  if (fileExists(args.garment)) {
    inputRefs.push(args.garment);
    const latest = findLatestParsed('garment-understanding', args.garment);
    if (latest) {
      const understanding = latest.parsed as GarmentUnderstanding;
      prompt = tryOnPrompt(understanding);
      promptSource = `A-衣物理解记录（${latest.ts}，模型 ${latest.model}）`;
    } else {
      console.error(`未找到 ${args.garment} 的衣物理解记录。先跑 src/garment-understanding/run.ts，或改用 --desc 手工描述。`);
      process.exit(1);
    }
  } else if (args.desc) {
    prompt = `让图中的人物换上这件服装：${args.desc}。保持人物的脸部、发型、肤色、体型和姿势完全不变，服装特征严格符合描述，生成自然的日常穿搭效果，真实感照片风格。`;
    promptSource = '手工描述';
  } else {
    console.error('需要 --garment <衣服样本路径>（走 A1 理解记录）或 --desc "<服装文字描述>"');
    process.exit(1);
  }

  console.log(`模型：image-01（选型已定，不做 live 对照）`);
  console.log(`人物：${args.person}`);
  console.log(`服装描述来源：${promptSource}`);
  console.log(`prompt（${prompt.length}/1500 字符）：${prompt}`);
  console.log(`参数：aspect=${args.aspect} n=${args.n}，共 1 次 API 调用（${args.n} 张图）。`);
  if (!args.yes) {
    console.error('\n确认无误后加 --yes 重新运行。');
    process.exit(0);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const result = await generateTryOnRecorded({
    personRef: args.person,
    prompt,
    aspectRatio: args.aspect,
    n: args.n,
    runId,
    purpose: `上身预览可行性：${promptSource}`,
    inputRefs,
  });

  if (result.ok) {
    console.log(`\n✓ 生成完成（${result.latencyMs}ms），已落盘（URL 24h 失效，本机副本为准）：`);
    for (const ref of result.imageRefs) console.log(`  ${ref}`);
    console.log('\n人工核对维度（AI 上身预览文档 §8.2）：人物还原 / 单品还原 / 上身表现 / 面料表现。');
  } else {
    console.error(`\n✗ 生成失败（${result.error?.kind}）：${result.error?.message}`);
    process.exit(1);
  }
}

void main();
