// A-搭配推荐跑批：从衣物档案 JSON（APP 数据工具导出）+ 场景 → 文本模型 → 契约校验 → 记录与统计。
// 运行：pnpm --filter @ownfit/experiments exec tsx src/outfit-recommendation/run.ts --profile <档案.json> [--yes] [--scene 日常通勤]
// 不带 --yes 时只打印将发生的调用数后退出（费用走项目用户的账号）。
// 凭证只从 .env 读取；记录文件只引用档案路径与原始返回，不含凭证。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProfileWith } from '../lib/config';
import { chatCompletion } from '../lib/client';
import { appendRecord } from '../lib/records';
import { recommendationSystemPrompt, recommendationUserPrompt, type ProfileItem } from './prompt';
import { checkCandidateItemIds, parseRecommendation, RECOMMENDATION_VERSION } from './schema';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Args {
  yes: boolean;
  profilePath?: string;
  scene: string;
  city: string;
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
    profilePath: get('--profile'),
    scene: get('--scene') ?? '日常通勤',
    city: get('--city') ?? '杭州',
    provider: get('--provider'),
  };
}

/** 严格解析模型返回：整体 JSON 或单层围栏；不猜测修复 */
export function parseContent(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = content.trim();
  const withoutThink = trimmed.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  for (const candidate of [trimmed, withoutThink]) {
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      try {
        return { ok: true, value: JSON.parse(candidate) };
      } catch {
        /* 继续尝试围栏 */
      }
    }
  }
  for (const candidate of [trimmed, withoutThink]) {
    const blocks = [...candidate.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((text) => text.startsWith('{') && text.endsWith('}'));
    if (blocks.length === 1) {
      try {
        return { ok: true, value: JSON.parse(blocks[0]) };
      } catch (error) {
        return { ok: false, error: `围栏内容不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (blocks.length > 1) return { ok: false, error: `返回包含 ${blocks.length} 个代码块，无法确定结果` };
  }
  return { ok: false, error: `返回内容不是完整 JSON：${trimmed.slice(0, 80)}` };
}

async function main() {
  const args = parseArgs();
  if (!args.profilePath) {
    console.error('用法：--profile <档案.json>（用 APP 数据工具页「导出档案 JSON」生成）');
    process.exit(1);
  }
  const profileFile = path.resolve(process.cwd(), args.profilePath);
  if (!fs.existsSync(profileFile)) {
    console.error(`找不到档案文件：${profileFile}`);
    process.exit(1);
  }
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf-8')) as {
    exportedAt?: string;
    items: ProfileItem[];
  };
  const items = profile.items ?? [];
  if (items.length === 0) {
    console.error('档案里没有已入库衣物，无法跑推荐。请先在 APP 衣橱录入并确认品类。');
    process.exit(1);
  }

  const service = findProfileWith('text');
  console.log(`服务：[${service.name}] ${service.modelId}`);
  console.log(`档案：${items.length} 件（${path.basename(profileFile)}${profile.exportedAt ? `，导出于 ${profile.exportedAt}` : ''}）`);
  console.log(`场景：${args.city} · ${args.scene}`);
  console.log(`将发生 1 次 API 调用（费用走你的账号）。`);
  if (!args.yes) {
    console.error('\n确认无误后加 --yes 重新运行。');
    process.exit(0);
  }

  const started = Date.now();
  const chat = await chatCompletion(
    service,
    [
      { role: 'system', content: recommendationSystemPrompt },
      {
        role: 'user',
        content: recommendationUserPrompt({
          items,
          scene: { city: args.city, day: '今天', scene: args.scene },
        }),
      },
    ],
    { temperature: 0.4 },
  );
  const latencyMs = Date.now() - started;

  if (!chat.ok) {
    appendRecord('outfit-recommendation', {
      workflow: 'outfit-recommendation',
      purpose: `${args.scene} 推荐跑批（${RECOMMENDATION_VERSION}）`,
      provider: service.name,
      model: service.modelId,
      inputRefs: [path.relative(pkgRoot, profileFile)],
      ok: false,
      latencyMs,
      error: { kind: chat.kind, message: chat.message },
    });
    console.error(`调用失败：${chat.kind} — ${chat.message}`);
    process.exit(1);
  }

  const parsedContent = parseContent(chat.content);
  const parsed = parsedContent.ok ? parseRecommendation(parsedContent.value) : { ok: false as const, error: parsedContent.error };
  const availableIds = items.map((item) => item.id);
  const missing = parsed.ok ? checkCandidateItemIds(parsed.value, availableIds).missingItemIds : [];

  appendRecord('outfit-recommendation', {
    workflow: 'outfit-recommendation',
    purpose: `${args.scene} 推荐跑批（${RECOMMENDATION_VERSION}）`,
    provider: service.name,
    model: service.modelId,
    inputRefs: [path.relative(pkgRoot, profileFile)],
    ok: parsed.ok,
    latencyMs,
    raw: chat.raw,
    ...(parsed.ok ? { parsed: parsed.value } : { parseError: parsed.error }),
  });

  if (!parsed.ok) {
    console.error(`解析失败：${parsed.error}`);
    console.error(`原始返回开头：${chat.content.slice(0, 200)}`);
    process.exit(1);
  }

  const result = parsed.value;
  console.log(`\n校验通过：候选 ${result.candidates.length} 个，缺口 ${result.gaps.length} 条`);
  if (missing.length > 0) {
    console.error(`⚠ 候选引用了不存在的单品 ID：${missing.join(', ')}（模型幻觉，不可用）`);
  }
  for (const [index, candidate] of result.candidates.entries()) {
    console.log(`\n候选 ${index + 1}：${candidate.wearStyle}`);
    for (const slot of candidate.slots) {
      const item = items.find((i) => i.id === slot.itemId);
      console.log(`  - ${slot.role}: ${item ? `${item.category ?? ''} ${item.name ?? slot.itemId}` : slot.itemId}${slot.note ? `（${slot.note}）` : ''}`);
    }
    if (candidate.reason) console.log(`  理由：${candidate.reason}`);
  }
  if (result.gaps.length > 0) {
    console.log(`\n缺口：${result.gaps.join('；')}`);
  }
  if (result.summary) console.log(`\n总述：${result.summary}`);
  console.log('\n记录已写入 records/outfit-recommendation/（人工核对回填 review 字段）。');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
