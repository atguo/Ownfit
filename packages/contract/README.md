# @ownfit/contract

衣见业务契约：搭配请求、方案结果与方案修改的稳定结构 + 可执行校验（zod）；衣物照片分析契约同包并存。
消费方：`mobile/`（界面与业务状态）、`packages/experiments/`（A 线真实模型样本校验）——**测试样例与真实适配结果必须通过同一套校验**。

## 版本与冻结状态

- 当前版本：**`1.0.0`**（2026-10-30 冻结，M3 验收；后续变更需新版本号与回归记录）
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
pnpm --filter @ownfit/contract test        # 边界样例断言（7 组搭配样例 + 12 组衣物分析样例）
pnpm --filter @ownfit/contract typecheck
```

APP 侧（Metro 直接编译 TS 源）：

```ts
import { parsePlan, planRequestSchema, CONTRACT_VERSION } from '@ownfit/contract';
import { parseGarmentAnalysis, GARMENT_ANALYSIS_VERSION } from '@ownfit/contract';
```

字段设计与变更规则见 [docs/开发计划.md](../../docs/开发计划.md) §6.3；真实输出适配的未决项登记在 A 线（packages/experiments）。衣物分析实现依据 [分批执行手册](../../docs/plans/2026-10-29-衣物AI分析-分批执行手册.md) §3.1。

## 衣物分析契约（GARMENT_ANALYSIS_VERSION = `1.0.0-draft`）

独立版本，与搭配契约并存，**不改变搭配字段与含义**。导出：`garmentAnalysisSchema`、`GarmentAnalysis`、`parseGarmentAnalysis(value)`（返回 `{ok,value}` 或 `{ok,error}`）。

| 键 | 取值 | 限制 |
| --- | --- | --- |
| `targetStatus` | `single` / `ambiguous` / `not_garment` / `unreadable` | 只有 `single` 允许产生可应用属性 |
| `suggestedName` | `Field<string>` | known 时 1-30 字；仅 known/unknown |
| `category` | `Field<上衣/下装/连衣裙/外套/鞋履/包/配饰>` | 仅 known/unknown；**契约只接受"鞋履"，实验里的"鞋"必须由适配器显式映射** |
| `colors` | `Field<{name,isPrimary}[]>` | known 时 1-4 项、名字 1-20 字、恰有一个主色；仅 known/unknown |
| `pattern` | `Field<纯色/条纹/格纹/印花/拼接/其他>` | 可 unknown/not_applicable |
| `neckline` | `Field<无领/圆领/V领/立领/翻领/连帽/一字领/其他>` | 可 unknown/not_applicable |
| `sleeve` | `Field<无袖/短袖/七分袖/长袖/其他>` | 可 unknown/not_applicable |
| `fit` | `Field<修身/合体/宽松/oversize>` | 外观版型，**不是真人合身结论**；可 unknown/not_applicable |
| `stylingTags` | `Field<string[]>` | known 时 0-6 项、每项 1-20 字（空数组=已知无标签，与未知不同） |
| `description` | `Field<string>` | known 时 1-120 字 |
| `unclearParts` | `string[]` | 0-6 项、每项 1-80 字；说明可见证据缺口 |

语义约束：

- `Field<T>` = `{state:'known';value:T}` | `{state:'unknown';value:null}` | `{state:'not_applicable';value:null}`。未知与不适用都用 `value=null`，**不用空串或 0 冒充**。
- 对象严格校验，**未知键拒绝**；所有键必需。
- `targetStatus` 非 `single` 时：所有属性必须 `unknown`，且 `unclearParts` 至少 1 项。
- 契约只保证结构与取值合法，**不能防止模型幻觉**；不存模型自报置信度，真机仍需逐项人工核对。
