// 衣见业务契约：搭配请求、方案结果与方案修改的稳定结构 + 可执行校验。
// 消费方：mobile/（界面）、packages/experiments/（A 线实验）——两侧共用同一套校验。
// 契约规则、冻结状态与缺省语义见本包 README.md；变更规则见 docs/开发计划.md §6.3。

export const CONTRACT_VERSION = '1.0.0-draft';

export {
  wearSlots,
  wearStyles,
  wearSchema,
  planItemRoleSchema,
  planItemSchema,
  sceneSnapshotSchema,
  gapSchema,
  gapKinds,
  planRequestSchema,
  planSchema,
  planFailureSchema,
  parsePlanRequest,
  parsePlan,
  parsePlanFailure,
} from './schema';
export type {
  WearSlot,
  WearStyle,
  Wear,
  PlanItemRole,
  PlanItem,
  SceneSnapshot,
  Gap,
  PlanRequest,
  Plan,
  PlanFailure,
  ParseResult,
} from './schema';
// 注意：samples.ts（边界样例与测试，依赖 Node 环境）不从此入口导出，
// 避免移动端编译引入 Node 依赖；测试经 `pnpm --filter @ownfit/contract test` 运行。

// 衣物分析契约（2.0.0-draft 动态属性模型）：独立版本，与搭配契约并存。
// 只导出结构、校验函数与推荐键表；测试断言在 samples.ts，不进此入口。
export {
  GARMENT_ANALYSIS_VERSION,
  garmentCategories,
  targetStatuses,
  garmentColorSchema,
  detailAttributeSchema,
  recommendedAttributeKeys,
  garmentAnalysisSchema,
  parseGarmentAnalysis,
} from './garmentAnalysis';
export type {
  GarmentCategory,
  TargetStatus,
  GarmentColor,
  DetailAttribute,
  GarmentAnalysis,
} from './garmentAnalysis';
