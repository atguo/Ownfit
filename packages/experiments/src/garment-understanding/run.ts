// A-衣物理解小样本跑批：对 samples/wardrobe 下每张图调用视觉模型，
// 记录原始返回与解析结果到 records/garment-understanding/。
// 运行：pnpm --filter @ownfit/experiments exec tsx src/garment-understanding/run.ts [--yes] [--limit N] [--provider glm]
// 不带 --yes 时只打印将发生的调用数后退出（每次跑模型前确认规模，费用走你的账号）。

import { findProfileWith } from '../lib/config';
import { chatCompletion } from '../lib/client';
import { appendRecord } from '../lib/records';
import { listSampleImages, toDataUrl } from '../lib/images';
import { garmentSystemPrompt, garmentUserPrompt } from './prompt';
import { parseUnderstanding } from './schema';

interface Args {
  yes: boolean;
  limit: number;
  provider?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    yes: argv.includes('--yes'),
    limit: Number(get('--limit') ?? 0) || Number.MAX_SAFE_INTEGER,
    provider: get('--provider'),
  };
}

async function main() {
  const args = parseArgs();
  const profile = args.provider ? findProfileWith('vision') : findProfileWith('vision');
  if (args.provider && profile.name !== args.provider) {
    throw new Error(`服务 "${args.provider}" 未声明 vision 能力或未配置`);
  }

  const images = listSampleImages('samples/wardrobe').slice(0, args.limit);
  if (!images.length) {
    console.error('samples/wardrobe 下没有图片。请按 samples/README.md 的拍摄指南放入 6–10 张衣服照片。');
    process.exit(1);
  }

  console.log(`服务：[${profile.name}] ${profile.modelId}`);
  console.log(`样本：${images.length} 张`);
  console.log(`将发生 ${images.length} 次 API 调用（费用走你的账号）。`);
  if (!args.yes) {
    console.error('\n确认无误后加 --yes 重新运行。');
    process.exit(0);
  }

  let okCount = 0;
  const fieldStats = new Map<string, { unknown: number; total: number }>();
  const trackUnknown = (field: string, isUnknown: boolean) => {
    const stat = fieldStats.get(field) ?? { unknown: 0, total: 0 };
    stat.total += 1;
    if (isUnknown) stat.unknown += 1;
    fieldStats.set(field, stat);
  };

  for (const imageRef of images) {
    process.stdout.write(`\n▶ ${imageRef} ... `);
    const result = await chatCompletion(
      profile,
      [
        { role: 'system', content: garmentSystemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: garmentUserPrompt() },
            { type: 'image_url', image_url: { url: toDataUrl(imageRef) } },
          ],
        },
      ],
      { temperature: 0 },
    );

    if (!result.ok) {
      console.log(`失败（${result.kind}）：${result.message.slice(0, 100)}`);
      appendRecord('garment-understanding', {
        workflow: 'garment-understanding',
        purpose: '小样本可行性：单图结构化字段提取',
        provider: profile.name,
        model: result.model,
        inputRefs: [imageRef],
        ok: false,
        latencyMs: result.latencyMs,
        error: { kind: result.kind, message: result.message },
      });
      continue;
    }

    const parsed = parseUnderstanding(result.content);
    if (parsed.ok) {
      okCount += 1;
      trackUnknown('category', parsed.value.category === '未知');
      trackUnknown('pattern', parsed.value.pattern === '未知');
      trackUnknown('neckline', parsed.value.neckline === '未知');
      trackUnknown('sleeve', parsed.value.sleeve === '未知');
      trackUnknown('fit', parsed.value.fit === '未知');
      console.log(
        `${parsed.value.category}/${parsed.value.categoryConfidence} ${parsed.value.colors
          .map((c) => c.name)
          .join('+')} 版型:${parsed.value.fit} 未知部位:${parsed.value.unclearParts.length}`,
      );
    } else {
      console.log(`解析失败：${parsed.error.slice(0, 100)}`);
    }

    appendRecord('garment-understanding', {
      workflow: 'garment-understanding',
      purpose: '小样本可行性：单图结构化字段提取',
      provider: profile.name,
      model: result.model,
      inputRefs: [imageRef],
      ok: true,
      latencyMs: result.latencyMs,
      raw: result.raw,
      parsed: parsed.ok ? parsed.value : undefined,
      parseError: parsed.ok ? undefined : parsed.error,
    });
  }

  console.log(`\n===== 小样本结果 =====`);
  console.log(`成功调用：${okCount}/${images.length}（全部记录见 records/garment-understanding/）`);
  console.log('字段未知率（低=模型在该字段可用；高=边界所在）：');
  for (const [field, stat] of fieldStats) {
    console.log(`  ${field}: ${stat.unknown}/${stat.total} 未知`);
  }
  console.log('\n下一步：人工逐条核对 records/ 中的 parsed 与图片，回填 review 后汇总《A-衣物理解小样本报告》。');
}

void main();
