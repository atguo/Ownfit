# @ownfit/experiments

A 工作线（AI 可行性与试穿验证）的实验脚本位置：衣物理解、搭配推荐、上身预览分别跟踪。实验产出为真实模型返回样本与边界记录，是 M3 契约草案与 M5 接入的直接输入。

**当前状态（2026-10-27，A 线提前为主线）**：

| 工作流 | 状态 |
| --- | --- |
| A-衣物理解 | 脚本就绪（`src/garment-understanding/`），等真实样本 |
| A-上身预览 | **脚本就绪，选型已定 MiniMax `image-01`**（`src/try-on-preview/`；人物参考照就位即可跑，服装描述走 A1 记录或 `--desc`） |
| A-搭配推荐 | 顺延（衣物理解与上身预览为必要能力先行；顺延原因见根 AGENTS.md §8） |

## 首次使用

1. 复制 `.env.example` 为 `.env`，填入你自己的服务凭证（GLM 图像理解 + DeepSeek 文本；均走 OpenAI 兼容接口）。`.env` 已 git 忽略，Key 不进版本库与日志。
2. 按 [samples/README.md](samples/README.md) 拍摄并放入样本（`samples/` 已 git 忽略）。
3. 冒烟：`pnpm --filter @ownfit/experiments exec tsx src/sanity.ts`
4. 衣物理解小样本：`pnpm --filter @ownfit/experiments exec tsx src/garment-understanding/run.ts`（先看调用数，加 `--yes` 真跑）。

## 纪律

实验规则与红线见本包 [AGENTS.md](AGENTS.md)；真实样本与评价方法见 [docs/开发计划.md](../../docs/开发计划.md) A 工作线与 [docs/functions/AI上身预览.md](../../docs/functions/AI上身预览.md)。

说明：`records/` 下的 JSONL 是实验证据资产（原始返回 + 解析结果 + 人工核对），随版本库保存；`samples/` 只存本机。契约说明：实验内 zod schema 依据功能文档字段归纳，**不是 M3 业务契约**；契约包保持占位，M3 前形成草案。
