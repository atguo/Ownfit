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
import { parseGarmentAnalysis } from './garmentAnalysis';

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

// ---------------------------------------------------------------------------
// 衣物分析契约边界样例（2.0.0-draft 动态属性模型必测项）。
// 覆盖：正常 single、非 single 诊断、颜色（hex/主色/0 项）、动态属性
// （多条/重名/超长/未知键）、缺字段、品类"鞋"、非对象输入。
// ---------------------------------------------------------------------------

/** 正常：single，含内置字段与动态细节属性 */
const validAnalysis = {
  targetStatus: 'single',
  category: '上衣',
  suggestedName: '奶油白针织衫',
  colors: [
    { name: '奶油白', hex: '#F5F0E1', isPrimary: true },
    { name: '藏青', hex: '#22334F', isPrimary: false },
  ],
  attributes: [
    { name: '领型', value: '圆领' },
    { name: '袖型', value: '长袖' },
    { name: '版型', value: '宽松' },
  ],
  unclearParts: [],
};

/** single 但信息不足：内置字段 null、动态属性空、unclearParts 至少 1 项 */
const underAnalyzed = {
  targetStatus: 'single',
  category: null,
  suggestedName: null,
  colors: [],
  attributes: [],
  unclearParts: ['面料质感看不清'],
};

/** 非 single 诊断：只保留 unclearParts */
const ambiguousAnalysis = {
  targetStatus: 'ambiguous',
  category: null,
  suggestedName: null,
  colors: [],
  attributes: [],
  unclearParts: ['画面中有两件衣服，无法确定目标单品'],
};

/** 非 single 但带已知品类 → 必须拒绝 */
const ambiguousWithKnown = { ...ambiguousAnalysis, category: '上衣' };

/** 非 single 但 unclearParts 为空 → 必须拒绝 */
const ambiguousNoUnclear = { ...ambiguousAnalysis, unclearParts: [] };

/** 颜色 hex 非法 → 必须拒绝 */
const colorBadHex = {
  ...validAnalysis,
  colors: [{ name: '奶油白', hex: 'F5F0E1', isPrimary: true }],
};

/** 颜色无主色 → 必须拒绝 */
const colorsNoPrimary = {
  ...validAnalysis,
  colors: [
    { name: '奶油白', hex: '#F5F0E1', isPrimary: false },
    { name: '藏青', hex: '#22334F', isPrimary: false },
  ],
};

/** 颜色两个主色 → 必须拒绝 */
const colorsTwoPrimary = {
  ...validAnalysis,
  colors: [
    { name: '奶油白', hex: '#F5F0E1', isPrimary: true },
    { name: '米色', hex: '#EFE8DC', isPrimary: true },
  ],
};

/** 属性重名 → 必须拒绝 */
const duplicateAttribute = {
  ...validAnalysis,
  attributes: [
    { name: '领型', value: '圆领' },
    { name: '领型', value: 'V领' },
  ],
};

/** 属性值超长（201 字）→ 必须拒绝 */
const longValue = {
  ...validAnalysis,
  attributes: [{ name: '细节', value: '详'.repeat(201) }],
};

/** 未知键 → 必须拒绝（严格对象） */
const extraKey = { ...validAnalysis, confidence: 0.9 };

/** attributes 超 40 条 → 必须拒绝 */
const tooManyAttributes = {
  ...validAnalysis,
  attributes: Array.from({ length: 41 }, (_unused, index) => ({
    name: `属性${index + 1}`,
    value: '值',
  })),
};

/** 缺字段（缺 targetStatus）→ 必须拒绝 */
const { targetStatus: _omitTarget, ...missingTarget } = validAnalysis;

/** 品类为实验用"鞋" → 必须拒绝（契约只接受"鞋履"） */
const shoeCategory = { ...validAnalysis, category: '鞋' };

/** 非对象输入（含模型常返回的围栏文本）→ 拒绝 */
const notAnObject = '```json\n{"targetStatus":"single"}\n```';

export const garmentAnalysisSamples = {
  validAnalysis,
  underAnalyzed,
  ambiguousAnalysis,
  ambiguousWithKnown,
  ambiguousNoUnclear,
  colorBadHex,
  colorsNoPrimary,
  colorsTwoPrimary,
  duplicateAttribute,
  longValue,
  extraKey,
  tooManyAttributes,
  missingTarget,
  shoeCategory,
  notAnObject,
};

export function runGarmentAnalysisTests(): void {
  // 正常 single：内置字段 + 动态属性齐全
  assert.deepEqual(parseGarmentAnalysis(validAnalysis).ok, true, '正常 single 分析应通过');
  const parsed = parseGarmentAnalysis(validAnalysis);
  assert.ok(
    parsed.ok && parsed.value.category === '上衣' && parsed.value.attributes.length === 3,
    '正常 single 解析应保留动态属性',
  );

  // 非 single 约束
  assert.deepEqual(parseGarmentAnalysis(underAnalyzed).ok, true, 'single 但信息不足应通过');
  assert.deepEqual(parseGarmentAnalysis(ambiguousAnalysis).ok, true, '非 single 诊断应通过');
  assert.deepEqual(parseGarmentAnalysis(ambiguousWithKnown).ok, false, '非 single 带 known 品类应被拒绝');
  assert.deepEqual(parseGarmentAnalysis(ambiguousNoUnclear).ok, false, '非 single 空 unclearParts 应被拒绝');

  // 颜色约束
  assert.deepEqual(parseGarmentAnalysis(colorBadHex).ok, false, '非法 hex 应被拒绝');
  assert.deepEqual(parseGarmentAnalysis(colorsNoPrimary).ok, false, '颜色无主色应被拒绝');
  assert.deepEqual(parseGarmentAnalysis(colorsTwoPrimary).ok, false, '颜色两个主色应被拒绝');

  // 动态属性约束
  assert.deepEqual(parseGarmentAnalysis(duplicateAttribute).ok, false, '属性重名应被拒绝');
  assert.deepEqual(parseGarmentAnalysis(longValue).ok, false, '属性值超长应被拒绝');
  assert.deepEqual(parseGarmentAnalysis(tooManyAttributes).ok, false, '属性超 40 条应被拒绝');

  // 结构与取值边界
  assert.deepEqual(parseGarmentAnalysis(extraKey).ok, false, '未知键应被拒绝');
  assert.deepEqual(parseGarmentAnalysis(missingTarget).ok, false, '缺 targetStatus 应被拒绝');
  assert.deepEqual(parseGarmentAnalysis(shoeCategory).ok, false, '品类"鞋"应被拒绝');

  // 非对象输入
  assert.deepEqual(parseGarmentAnalysis(notAnObject).ok, false, '非对象文本应被拒绝');
}

if (process.argv[1]?.includes('test') || process.argv[1]?.includes('samples')) {
  runContractTests();
  runGarmentAnalysisTests();
  console.log(
    `契约样例测试通过（CONTRACT_VERSION=1.0.0-draft，7 组搭配样例；GARMENT_ANALYSIS_VERSION=2.0.0-draft，15 组衣物分析样例）。`,
  );
}
