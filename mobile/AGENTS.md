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

### 衣物分析 2.0 与通知修复（2026-10-29 重构，2026-10-30 验证修复）

- 契约 `@ownfit/contract` 升至 `2.0.0-draft`：`attributes[{name,value}]` 动态清单（推荐键表仅引导）、颜色带 hex、非 single 只存诊断；`attributeRepository` 改为动态属性行读写（同名取最新、历史行保留、`deleteAttribute` 物理删除并递增 revision），新增 `colorLibraryRepository`（preferences 表 JSON）；`WardrobeItemSheet` 改动态属性行面板 + 测量填写；`garmentAnalysis.ts` 提示词 v3 强制属性名简体中文，`normalizeAnalysisPayload` 对常见英文键映射为中文并对同名去重（保留最后一条）。
- `garmentTaskRunner` 增 `onTaskSettled` 回调：任务领取/取消/stale/blocked/终态/启动恢复落库后通知（`garmentAnalysisStore` 接 `notifyAnalysisChanged`），修复任务完成后详情页停留「正在分析…」；执行意外异常兜底为 failed（发送前）/interrupted（发送后），不滞留 running。
- 真机已走通分析全链路（照片 → 分析 → 确认 → 持久化）；中文属性行与重新分析状态刷新已真机复测通过。截断治理（v5 + 40960）后重分析成功：19 项全中文属性；`WardrobeItemSheet.formatTime` 改本地时区（原 UTC 截取差 8 小时）。回归：`node --test mobile/tests/*.test.cjs`（60 项）、`pnpm typecheck`。
- `app/(tabs)/wardrobe.tsx`：`WardrobeItemSheet.onChanged` 只刷新列表不清空 detail——修复确认属性行后弹层被关闭（应关弹层的操作均显式调 `onClose`）。
- `features/sheets/WardrobeItemSheet.tsx`：名称建议「采纳」后同步名称输入框并按"当前名称 == 建议"显示已采纳态（按钮禁用）——修复采纳无反馈、以及采纳后「保存修改」用旧名覆盖的问题。状态行透出任务 errorSummary（失败/中断/配置不可用带原因）。
- `services/ai/garmentAnalysis.ts` 解析约定 v4/v5：接受整体 JSON、剥 `<think>` 思考段后的 JSON、正文恰好一个完整围栏块（前后允许说明文字）；拒绝多代码块与花括号截取修复，失败附内容摘要。提示词要求紧凑单行 JSON、条数够用即可；`ANALYSIS_MAX_TOKENS=40960`（项目用户指示；2048/4096 真机均被 finish_reason=length 截断，供应商拒绝该值会 400）。`openaiClient` 透出 `finishReason`，截断时失败原因明确指向截断而非格式错误。
