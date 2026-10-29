# @ownfit/contract

衣见业务契约：搭配请求、方案结果与方案修改的稳定结构 + 可执行校验（zod）。
消费方：`mobile/`（界面与业务状态）、`packages/experiments/`（A 线真实模型样本校验）——**测试样例与真实适配结果必须通过同一套校验**。

## 版本与冻结状态

- 当前版本：**`1.0.0-draft`**（草案）
- 冻结规则（开发计划 §6.3）：M3 验收通过时冻结为 `1.0.0`；此后变更须记录原因、影响页面与状态、兼容方案及回归范围，升级版本并更新文档——不能为维持"冻结"而伪造数据
- ⚠️ **真实输出适配待验证**：契约字段基于业务结构（搭配生成文档 §5.1）设计，尚未经过 A 线真实模型返回样本校验；A1/A2 实验产出后回填适配结论，在此之前不得宣称联调通过

## 结构概要

| 结构 | 用途 | 关键规则 |
| --- | --- | --- |
| `PlanRequest` | 搭配请求：basis + 锁定集合 + 场景快照 | basis 必须在锁定集合中；锁定集合无重复 |
| `Plan` | 方案结果（版本节点）：单品引用+角色、穿法（部位+粒度）、reason、gaps、场景快照、来源、父版本 | 恰好 1 件 basis；version 正整数；reason=null=未提供；gaps=[]=无缺口 |
| `Wear` | 穿法：slot（部位，当前仅"整体"）+ style（支持清单） | 不在清单内的穿法被校验拒绝 |
| `PlanFailure` | 失败结果：kind + message | 失败不产出部分有效的 Plan |

缺省语义（未知值、空列表、失败不混用）：

- `reason: null` → 推荐原因未提供，UI 显示缺省文案，**不得编造理由**
- `gaps: []` → 无缺口；缺口条目必须带 kind + message（如 `missing_category`："已录入衣橱中暂未找到外套"）
- 穿过未评价 → `satisfied: null`（记录层），**收藏不自动标记穿过，跳过评价保留未知**
- 修改与撤销：编辑会话内撤销由会话栈负责；已保存方案的修改保存为**新版本**（`parentPlanId` 指向父版本），过期版本由消费方按当前会话版本比较拒绝

## 使用

```bash
pnpm --filter @ownfit/contract test        # 边界样例断言（7 组：正常/品类缺失/原因缺失/
                                           # 不支持穿法/全锁定/过期版本/失败）
pnpm --filter @ownfit/contract typecheck
```

APP 侧（Metro 直接编译 TS 源）：

```ts
import { parsePlan, planRequestSchema, CONTRACT_VERSION } from '@ownfit/contract';
```

字段设计与变更规则见 [docs/开发计划.md](../../docs/开发计划.md) §6.3；真实输出适配的未决项登记在 A 线（packages/experiments）。
