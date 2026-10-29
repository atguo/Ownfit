// 契约边界样例（开发计划 §6.3 要求的 7 组）与断言测试。
// 运行：pnpm --filter @ownfit/contract test
// 测试样例与真实模型适配结果必须通过同一套校验（消费/提供两侧共用）。

import assert from 'node:assert/strict';
import {
  parsePlan,
  parsePlanRequest,
  parsePlanFailure,
  planRequestSchema,
  type Plan,
  type PlanRequest,
} from './schema';

const scene = { city: '杭州', day: '今天', scene: '日常通勤' } as const;

/** 1. 正常组合：合法请求 + 合法方案 */
const validRequest: PlanRequest = {
  basisItemId: 'item-knit',
  lockedItemIds: ['item-knit', 'item-pants'],
  scene,
};

const validPlan: Plan = {
  planId: 'plan-001',
  parentPlanId: null,
  version: 1,
  items: [
    { itemId: 'item-knit', role: 'basis' },
    { itemId: 'item-pants', role: 'locked' },
    { itemId: 'item-shoes', role: 'piece' },
  ],
  wear: { slot: '整体', style: '自然垂放' },
  reason: null,
  gaps: [],
  scene,
  source: 'manual',
  createdAt: '2026-10-29T10:00:00.000Z',
};

/** 2. 部分品类缺失：缺口合法表达（gaps 条目），不冒充完整方案 */
const planWithGap: Plan = {
  ...validPlan,
  planId: 'plan-002',
  gaps: [{ kind: 'missing_category', message: '已录入衣橱中暂未找到外套。' }],
};

/** 3. 原因缺失：reason = null 合法（UI 显缺省，不编造理由） */
const planWithoutReason: Plan = { ...validPlan, planId: 'plan-003', reason: null };

/** 4. 不支持某穿法：wear.style 不在支持清单 → 方案校验必须拒绝 */
const planWithUnsupportedWear = {
  ...validPlan,
  planId: 'plan-004',
  wear: { slot: '整体', style: '系成斗篷' },
};

/** 5. 全部锁定产生冲突：结构上合法（用户可全部锁定）；替换时无可选项由 UI 按缺口表达 */
const allLockedRequest: PlanRequest = {
  basisItemId: 'item-knit',
  lockedItemIds: ['item-knit', 'item-pants', 'item-shoes'],
  scene,
};

/** 6. 过期版本：version 必须为正整数；过期判定由消费方按当前会话版本比较 */
const expiredVersionPlan = { ...validPlan, planId: 'plan-006', version: 0 };

/** 7. 失败：basis 不在锁定集合 → 请求被拒绝（不产出部分有效的 Plan） */
const basisNotLockedRequest = {
  basisItemId: 'item-knit',
  lockedItemIds: ['item-pants'],
  scene,
};

const failure = parsePlanFailure({
  kind: 'basis_not_locked',
  message: 'basisItemId 必须包含在 lockedItemIds 中',
});
assert.equal(failure.ok, true, '失败结果样例应通过校验');

export const contractSamples = {
  validRequest,
  validPlan,
  planWithGap,
  planWithoutReason,
  planWithUnsupportedWear,
  allLockedRequest,
  expiredVersionPlan,
  basisNotLockedRequest,
  failure,
};

export function runContractTests(): void {
  // 1. 正常组合
  assert.deepEqual(parsePlanRequest(validRequest).ok, true, '正常请求应通过');
  assert.deepEqual(parsePlan(validPlan).ok, true, '正常方案应通过');

  // 2. 部分品类缺失：gaps 条目合法
  assert.deepEqual(parsePlan(planWithGap).ok, true, '含缺口的方案应通过');

  // 3. 原因缺失
  assert.deepEqual(parsePlan(planWithoutReason).ok, true, 'reason=null 应通过');
  const parsedNoReason = parsePlan(planWithoutReason);
  assert.ok(parsedNoReason.ok && parsedNoReason.value.reason === null, 'reason 应保持 null');

  // 4. 不支持某穿法：必须被拒绝
  assert.deepEqual(parsePlan(planWithUnsupportedWear).ok, false, '不支持的穿法应被拒绝');

  // 5. 全部锁定：结构合法
  assert.deepEqual(planRequestSchema.safeParse(allLockedRequest).success, true, '全锁定请求结构合法');

  // 6. 过期版本：version=0 非正整数，必须被拒绝
  assert.deepEqual(parsePlan(expiredVersionPlan).ok, false, 'version=0 应被拒绝');

  // 7. 失败结果
  assert.deepEqual(parsePlanFailure(basisNotLockedRequest).ok, false, '请求不是失败结果的结构');
  assert.equal(failure.ok && failure.value.kind, 'basis_not_locked');
}

if (process.argv[1]?.includes('test')) {
  runContractTests();
  console.log(`契约边界样例测试通过（CONTRACT_VERSION=${'1.0.0-draft'}，7 组样例）。`);
}
