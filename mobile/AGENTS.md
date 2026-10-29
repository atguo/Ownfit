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

### 衣物删除联动（2026-10-29）

items.status 新增 deleted（文本字段，无 schema 变更）。purgeItem 保留最小删除标记，历史方案和穿着记录保留；历史列表展示已删除，复用与保存检查可用性。删除回归使用生产 schema 与内存 SQLite：`node --test mobile/tests/*.test.cjs`（仓库根运行）。

### 衣物 AI 分析接入（2026-10-29，实现完成，待真机验收）

数据库 schema 升至 **v3**：`items.revision`；`attributes` 增 `value_state`/`value_format`/`analysis_task_id`；新增 `tasks`（仅 kind=`garment_analysis`）与 `ai_task_preferences`。迁移步骤导出为 `schemaMigrations`/`runMigrations`（`src/data/db.ts`），与 `user_version` 同事务、失败回滚不清库。

- 新增仓库：`analysisTypes.ts`（任务/属性/视图跨批类型）、`taskRepository.ts`（`createGarmentTask` 幂等与同衣物去重、`updateTaskStatus` 条件更新、默认视觉模型读写、归档取消与删除清理）、`attributeRepository.ts`（`recordUserAttribute`、`getAnalysisView` 人工优先取值、`commitGarmentAnalysis` 原子提交与 stale/删除保护）。
- `photoRepository.getMainPhotoForAnalysis(itemId)`：按 `items.main_photo_id` 解析稳定分析输入，删除后返回 null；`readAnalysisImage(itemId)` 校验文件后返回内存 data URL（不返回 file URI）。
- 事务统一使用同一连接事务（`withTransactionAsync`）；**禁止** `withExclusiveTransactionAsync`（会新建未带 SQLCipher 密钥的连接）。理由见根 AGENTS 与 [分批执行手册](../docs/plans/2026-10-29-衣物AI分析-分批执行手册.md) D4。
- AI 服务层（P4，假网络验证，未真实调用）：`types.ts` 增 `callRevision`/`isVisionCandidate`；`configStore` 增 `loadConfigsStructured`；新增 `services/ai/visionConfig.ts`（视觉配置路由 ready/choose/missing/invalid）与 `services/ai/garmentAnalysis.ts`（分析提示词、单张图片请求、严格 JSON 解析、`鞋`→`鞋履` 适配、契约校验）。`openaiClient.chatCompletion` 追加第 5 个参数 `options{maxTokens,signal}`（前四参数与顺序不变）。
- 任务执行（P5）：`services/ai/garmentTaskRunner.ts`（依赖注入的串行执行器，`enqueueGarmentAnalysis`/`buildInputKey`/`createDefaultGarmentTaskRunnerDeps`；启动恢复、前后台门控、尽力中止、本地提交重试）与 `features/garmentAnalysisStore.ts`（`subscribeAnalysisChanges`/`notifyAnalysisChanged`、会话批次、`requestKeyFor`）。
- 页面接入（P6）：`app/_layout.tsx` 挂载执行器单例与 AppState 门控；`app/add.tsx` 保存后自动入队、模型提示与选择、AI 建议预填；`app/ai/config.tsx` 可设分析默认模型；`features/sheets/VisionModelSheet.tsx` 新增。
- 历史衣物与详情（P7）：`app/(tabs)/wardrobe.tsx` 增批量补分析入口与卡片分析状态；`features/sheets/WardrobeItemSheet.tsx` 增分析状态、逐字段修正、明确确认入口（每个未确认字段旁的“确认”按钮 + 顶部“确认全部分析结果（N 项）”，写入 `user_confirmed`、只落本机不重跑模型）、分析与重试、重试保存；`attributeRepository.recordUserAttribute` 递增 `items.revision`。
- 尚未真机验收（P8 待执行）；真实模型调用 0 次。回归：`node --test mobile/tests/*.test.cjs`。
