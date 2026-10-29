本目录属于“衣见”（Ownfit）项目。协作约束、架构边界与同步义务以仓库根目录 [AGENTS.md](../AGENTS.md) 为准；实施顺序与验收见 [docs/开发计划.md](../docs/开发计划.md)。

## 当前结构（M2 已实现，2026-10-29）

- 路由 `src/app/`（expo-router）：根 Stack + `(tabs)/` 四主入口（今天/衣橱/搭配/我的）+ 任务页 `choose`、`outfit`、`preview`、`add`（Stack 路由，系统返回即原型返回）+ `ai/config`、`ai/config-edit`（AI 服务配置）+ 开发用组件展示 `dev/components`。
- `src/ui/`：`tokens.ts`（自原型 style.css 逐字提取的设计令牌）、`Icon.tsx`（react-native-svg，path 与原型一致）、`PageTop.tsx`、`Screen.tsx`（页面容器 + KeyboardAvoidingView）、`components/`（Button/Sheet/Toast/Basics/Rows/ItemArt/OutfitBoard/Field）。
- `src/data/`：`db.ts`（SQLCipher 加密库 + 密钥管理 + user_version 迁移）、`demo.ts`（演示常量）、`repositories/`（item/photo/settings 仓库）。数据库经 `expo-sqlite` 插件 `useSQLCipher` 编译启用，密钥存设备安全存储；照片原件与缩略图在应用私有目录（photos/、thumbs/），写入失败回滚不留半成品。
- `src/domain/`、`src/services/`：`services/ai/`（AI 配置存储与两类协议客户端，提前自 M5 落地）已实现；`domain/` 业务规则仍随 M3 填充。
- `src/features/`：`demoStore.ts`（M1 演示状态，仅内存；真实衣橱出自 repositories，两者零交集）、`sheets/`（场景/详情/替换/穿法/预览/感受/衣橱单品/我的页弹层）。

## 命令

根目录：`pnpm install`、`pnpm typecheck`、`pnpm start`（Expo 开发服务器，dev client 连接用）。

本目录：`pnpm exec expo prebuild -p android`（原生工程变更后重建 `android/`，该目录 git 忽略）；`pnpm exec expo run:android`（构建并安装到已连接真机）；`pnpm exec expo-doctor` 体检。真机连接走无线 adb（同 Wi-Fi 自动发现）；dev client 可用 deep link `ownfit://expo-development-client/?url=<Metro 地址>` 直接拉起指定服务器。

构建依赖本机 Android Studio/SDK 与用户级环境变量（`ANDROID_HOME`、`JAVA_HOME`、`GRADLE_USER_HOME`），见根 AGENTS.md 第 5 节；支持系统版本 Android 12（minSdkVersion=31，经 `expo-build-properties` 配置于 app.json）。
