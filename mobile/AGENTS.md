本目录属于“衣见”（Ownfit）项目。协作约束、架构边界与同步义务以仓库根目录 [AGENTS.md](../AGENTS.md) 为准；实施顺序与验收见 [docs/开发计划.md](../docs/开发计划.md)。

## 当前结构（M1 已完成并验收，2026-10-27）

- 路由 `src/app/`（expo-router）：根 Stack + `(tabs)/` 四主入口（今天/衣橱/搭配/我的）+ 任务页 `choose`、`outfit`、`preview`、`add`（Stack 路由，系统返回即原型返回）+ 开发用组件展示 `dev/components`。
- `src/ui/`：`tokens.ts`（自原型 style.css 逐字提取的设计令牌）、`Icon.tsx`（react-native-svg，path 与原型一致）、`PageTop.tsx`、`Screen.tsx`（页面容器 + KeyboardAvoidingView）、`components/`（Button/Sheet/Toast/Basics/Rows/ItemArt/OutfitBoard/Field）。
- `src/features/`：`demoStore.ts`（M1 演示状态，仅内存）、`sheets/`（场景/详情/替换/穿法/预览/感受/我的页弹层）。
- `src/data/`：`demo.ts`（演示数据常量，与原型一致；不持久化，M2 接入本地数据库后替换）。
- `src/domain/`、`src/services/`：预留（M2/M3 起填充）。

## 命令

根目录：`pnpm install`、`pnpm typecheck`、`pnpm start`（Expo 开发服务器，dev client 连接用）。

本目录：`pnpm exec expo prebuild -p android`（原生工程变更后重建 `android/`，该目录 git 忽略）；`pnpm exec expo run:android`（构建并安装到已连接真机）；`pnpm exec expo-doctor` 体检。真机连接走无线 adb（同 Wi-Fi 自动发现）；dev client 可用 deep link `ownfit://expo-development-client/?url=<Metro 地址>` 直接拉起指定服务器。

构建依赖本机 Android Studio/SDK 与用户级环境变量（`ANDROID_HOME`、`JAVA_HOME`、`GRADLE_USER_HOME`），见根 AGENTS.md 第 5 节；支持系统版本 Android 12（minSdkVersion=31，经 `expo-build-properties` 配置于 app.json）。
