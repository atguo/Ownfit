# @ownfit/contract

衣见业务契约：搭配请求、方案结果与方案修改的稳定结构 + 可执行校验（zod）；衣物照片分析契约同包并存。
消费方：`mobile/`（界面与业务状态）、`packages/experiments/`（A 线真实模型样本校验）——**测试样例与真实适配结果必须通过同一套校验**。

## 版本与冻结状态

- 冻结决定与版本标识：**`1.0.0`**（2026-10-30，M3 验收）。2026-11-03 已统一：`src/schema.ts` 常量为唯一定义，公共入口转出；package.json 同步 1.0.0（M6 批次 1.1）。
- 冻结规则（开发计划 §6.3）：M3 验收通过时冻结为 `1.0.0`；此后变更须记录原因、影响页面与状态、兼容方案及回归范围，升级版本并更新文档——不能为维持"冻结"而伪造数据
- ⚠️ **真实输出适配待验证**：契约字段基于业务结构（搭配生成文档 §5.1）设计，推荐已有 11-02 真实输出，但经过的是 experiments 独立候选校验；APP 采用保存已携带 `source='ai'` 与模型理由经 parsePlan 校验（M6 批次 1.2），候选声明的 gaps 仍只在面板展示、保存方案的 gaps 按缺失槽位生成。共用契约的 APP 真机端到端验收待补，不得宣称已完成

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
pnpm --filter @ownfit/contract test        # 边界样例断言（7 组搭配样例 + 15 组衣物分析样例）
pnpm --filter @ownfit/contract typecheck
```

APP 侧（Metro 直接编译 TS 源）：

```ts
import { parsePlan, planRequestSchema, CONTRACT_VERSION } from '@ownfit/contract';
import { parseGarmentAnalysis, GARMENT_ANALYSIS_VERSION } from '@ownfit/contract';
```

字段设计与变更规则见 [docs/开发计划.md](../../docs/开发计划.md) §6.3；真实输出适配的未决项登记在 A 线（packages/experiments）。衣物分析实现依据 [分批执行手册](../../docs/plans/2026-10-29-衣物AI分析-分批执行手册.md) §3.1。

## 衣物分析契约（GARMENT_ANALYSIS_VERSION = `2.0.0-draft`）

独立版本，不改变搭配字段。已取代 1.0 固定字段三态；实现依据为 [2.0 重构设计](../../docs/plans/2026-10-29-衣物分析字段与来源重构-设计.md)。

| 键 | 当前结构与约束 |
| --- | --- |
| targetStatus | single / ambiguous / not_garment / unreadable |
| category | 衣物大类或 null；鞋类使用“鞋履” |
| suggestedName | 1–30 字或 null |
| colors | 0–4 项；name 1–20 字、hex 为 #RRGGBB、isPrimary 布尔；非空恰有一个主色 |
| attributes | 0–40 项动态 name/value；名称 1–20 字且不重复，值 1–200 字 |
| unclearParts | 0–6 项，每项 1–80 字 |

严格对象拒绝未知键。非 single 时 category/suggestedName 必须为 null，colors/attributes 为空，unclearParts 至少一项。未提取属性不制造“未知”占位值；推荐键仅用于提示词引导。契约只保证结构合法，不能保证识别准确；已有真机分析记录不替代逐项效果验收。
