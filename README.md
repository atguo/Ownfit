# 今天穿什么 — 工程框架

pnpm workspace：`mobile/`（RN + Expo 客户端）、`packages/contract/`（业务契约与校验）、`packages/experiments/`（AI 验证实验脚本）。`prototype/` 为已认可原型，不纳入 workspace。规划与约束见 [AGENTS.md](AGENTS.md)、[docs/开发计划.md](docs/开发计划.md)。

```bash
pnpm install                          # 安装全部依赖
pnpm typecheck                        # 全部包类型检查
pnpm start                            # 启动 Expo 开发服务器（mobile）
```
