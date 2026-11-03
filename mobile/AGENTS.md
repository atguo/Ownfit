本目录属于“衣见”（Ownfit）项目。协作约束、架构边界与同步义务以仓库根目录 [AGENTS.md](../AGENTS.md) 为准；实施顺序与验收见 [docs/开发计划.md](../docs/开发计划.md)。

## 当前结构（2026-11-03 核对，M6 批次 1 后更新）

M0–M5 完成（M5 视同验收）；M6 进行中，批次 1（M5 登记缺口收尾）已实现，真机走查待项目用户执行，详见 [M6 实施计划](../docs/plans/2026-11-03-M6-真机质量验证与内测候选-实施计划.md)。下文带日期记录保留历史语境，不以历史“0 次调用/待验收”覆盖后续证据。

- `src/app/`：根 Stack + `(tabs)/` 四主入口 + `choose`、`outfit`、`add` + `ai/config`、`ai/config-edit` + `dev/components`、`dev/data-tools`。预览为 `PreviewSheet` 弹层，当前没有独立 `preview.tsx` 路由。
- `src/ui/`：设计令牌、图标、响应式页面容器与原生组件，真实搭配板为 `RealOutfitBoard`。
- `src/data/`：SQLCipher schema v6、密钥管理与 user_version 迁移；repositories 包含衣物/照片/属性/方案/分析任务/预览/推荐/维护/设置/颜色库。照片、人物参考和生成图保存在应用私有目录。
- `src/services/`：AI 配置、协议客户端及分析/预览/推荐执行器；`weather.ts` 提供可选城市天气查询。非敏感 AI 配置存本地库 `ai_configs` 表（v6，DB 为源 + 内存镜像），API Key 仍只在设备安全存储。
- `src/features/`：`outfitSession` 编辑会话（含会话来源 origin：manual/ai），分析/预览/推荐 store，`sheets/` 原生弹层。`demoStore` 承载当次场景等内存上下文；推荐已消费该当次场景（含温度来源区分，演示温度不进 AI）。

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

- `@ownfit/contract` 中衣物分析契约升至 `2.0.0-draft`（非搭配契约版本）：`attributes[{name,value}]` 动态清单（推荐键表仅引导）、颜色带 hex、非 single 只存诊断；`attributeRepository` 改为动态属性行读写（同名取最新、历史行保留、`deleteAttribute` 物理删除并递增 revision），新增 `colorLibraryRepository`（preferences 表 JSON）；`WardrobeItemSheet` 改动态属性行面板 + 测量填写；`garmentAnalysis.ts` 提示词 v3 强制属性名简体中文，`normalizeAnalysisPayload` 对常见英文键映射为中文并对同名去重（保留最后一条）。
- `garmentTaskRunner` 增 `onTaskSettled` 回调：任务领取/取消/stale/blocked/终态/启动恢复落库后通知（`garmentAnalysisStore` 接 `notifyAnalysisChanged`），修复任务完成后详情页停留「正在分析…」；执行意外异常兜底为 failed（发送前）/interrupted（发送后），不滞留 running。
- 真机已走通分析全链路（照片 → 分析 → 确认 → 持久化）；中文属性行与重新分析状态刷新已真机复测通过。截断治理（v5 + 40960）后重分析成功：19 项全中文属性；`WardrobeItemSheet.formatTime` 改本地时区（原 UTC 截取差 8 小时）。回归：`node --test mobile/tests/*.test.cjs`（60 项）、`pnpm typecheck`。
- `app/(tabs)/outfits.tsx`：FeedbackSheet 关闭时立即重载方案列表（页面未失焦 useFocusEffect 不会触发，否则「已穿过」徽章滞后）；M3 预验收（2026-10-30，adb 全程）通过，保存去重不看 basis 的语义待项目用户决定。
- `app/(tabs)/wardrobe.tsx`：`WardrobeItemSheet.onChanged` 只刷新列表不清空 detail——修复确认属性行后弹层被关闭（应关弹层的操作均显式调 `onClose`）。
- `features/sheets/WardrobeItemSheet.tsx`：名称建议「采纳」后同步名称输入框并按"当前名称 == 建议"显示已采纳态（按钮禁用）——修复采纳无反馈、以及采纳后「保存修改」用旧名覆盖的问题。状态行透出任务 errorSummary（失败/中断/配置不可用带原因）。新增「一键确认全部 AI 推断（N 项）」按钮：逐条写入 `user_confirmed`（全部确认后按钮隐藏），真机验证通过。
- `services/ai/garmentAnalysis.ts` 解析约定 v4/v5：接受整体 JSON、剥 `<think>` 思考段后的 JSON、正文恰好一个完整围栏块（前后允许说明文字）；拒绝多代码块与花括号截取修复，失败附内容摘要。提示词要求紧凑单行 JSON、条数够用即可；`ANALYSIS_MAX_TOKENS=40960`（项目用户指示；2048/4096 真机均被 finish_reason=length 截断，供应商拒绝该值会 400）。`openaiClient` 透出 `finishReason`，截断时失败原因明确指向截断而非格式错误。


### M4 本地数据可靠性与任务恢复（2026-10-30，真机验证通过，待验收）

- `data/repositories/maintenanceRepository.ts`：一致性扫描（缺文件/悬空主图引用/孤儿文件/可重建缩略图）、`cleanOrphanFiles`（调用时重扫、只删无记录引用者）、`rebuildMissingThumbnails`（原件缺失如实报失败）、`hasRoomForNewPhoto`（<50MB 拒绝，探测失败放行）。photoRepository 保存前接入容量检查。
- `app/dev/data-tools.tsx`（我的页开发入口）：扫描/清理/重建/schema 信息；清理有二次确认。
- `data/db.ts`：初始化失败记录阶段（open/key/migrate）与详情（`getLastDbInitFailure`）；`app/_layout.tsx` 启动探测，失败进安全模式横幅（资料保持原样+重试）。
- 照片与隐私弹层更新为真实存储/无云恢复告知。加密抽检与安全模式演练经 adb 完成；升级演练见 `node --test mobile/tests/analysisMigration.test.cjs`。回归：`node --test mobile/tests/*.test.cjs`（64 项）。


### M5 轨 A 上身预览（2026-10-30 实现完成，真机验证进行中）

- `data/repositories/previewRepository.ts`：人物参考（压缩落盘 + preferences 记录含自愈：文件在记录缺失时按 mtime 重建）；预览任务 CRUD（kind='try_on_preview'，item_id=basis、photo_id='none'，输入指纹=单品集+穿法+参考版本+配置）、`savePreviewResultImage`（下载落盘 files/previews/）。
- `services/ai/previewTaskRunner.ts`：串行执行器（与 garmentTaskRunner 同语义：发送前写 running、启动恢复标 interrupted 不重发、异常兜底不留 running）；`services/ai/visionConfig.ts` 增 `resolveImageGenConfig`（minimax+image_gen，默认失效不静默切换）。
- `features/previewStore.ts`（单例/入队/订阅）与 `features/sheets/PreviewSheet.tsx`（状态/结果/重试/历史与本方案标注、诚实文案）接通 outfit 页星形按钮。
- schema v4：活动任务唯一索引改 (kind, item_id, input_key)（原来只按 item_id 会跨类型互相阻塞）。
- preferences 共享表纪律：偏好项 id 必须 `pref-` 前缀（settingsRepository 读取/保存按前缀过滤）；其他用途（color-library、preview-reference）避开该前缀。
- 轨 B1/B2：数据工具页导出档案 JSON；`packages/experiments/src/outfit-recommendation/`（提示词/schema/跑批）。回归：`node --test mobile/tests/*.test.cjs`（73 项）。

### M6 批次 1：M5 登记缺口收尾（2026-11-03 实现完成，待真机走查）

依据 [M6 实施计划](../docs/plans/2026-11-03-M6-真机质量验证与内测候选-实施计划.md) 批次 1 落地四项：

- **1.1 契约标识统一**：`packages/contract` 内部常量与 package.json 去 draft 统一 1.0.0；公共入口改为从 `schema.ts` 转出唯一定义。
- **1.2 推荐当次输入与采用保存语义**：`loadSceneSnapshot` 改读首页当次 context（演示温度 tempSource='demo' 不进 AI；实时/手动温度带来源）；入队持久化输入快照（schema v5 增 `tasks.input_json`：当次场景 + 锁定单品别名），执行器按快照发送、不现读会话；提示词升 v2（锁定单品必须包含、温度标注来源）；`outfitSession` 增会话来源 origin，采用候选带 `source='ai'` + 理由，`planRepository` 按 Plan.source 落库（不再固定 manual）。
- **1.3 天气地点/日期失效**：SceneSheet 改城市/日期即清空已查天气；选「明天」时今日预报不适用（如实提示手动填写，不冒充明天天气）；地点/日期变化且无新温度时旧实时温度回退示例占位（明确标注），不静默沿用；`pickCurrentTemp` 纯函数化；获取时间存入 context 并本地时区展示（不再 UTC 截取）。
- **1.4 AI 非敏感配置迁数据库**：schema v6 新增 `ai_configs` 表；`configStore` 改为"DB 为源 + 内存镜像"，同步 getter 签名不变（任务执行器/路由层零改动）；启动时 `_layout` 先 `ensureConfigCache` 再启动分析执行器（避免镜像未就绪误判配置失效）；首次初始化表空且旧 JSON 可解析则搬入并删除旧文件（表非空后不再读旧文件，损坏文件保留不删按无配置处理）；API Key 仍只在 SecureStore；`callRevision` 语义不变；安全模式重试后重新加载镜像。
- **1.5 MiniMax 图像地址改完整地址直填**（2026-11-03 项目用户确认）：`endpointFor('minimax')` 返回用户输入的完整接口地址（不追加路径；原"基础地址自动拼 `/v1/image_generation`"会把 `/v1` 结尾的地址拼成 `/v1/v1/...` 404）；OpenAI 兼容仍自动拼 `/chat/completions`；配置表单按类型区分标签、占位与校验（minimax 要求含路径的完整地址）。回归：`endpoint.test.cjs` 2 项。**已有 MiniMax 配置需在 APP 内重新编辑为完整地址。**
- **1.6 天气定位为主、手动为辅**（2026-11-03 项目用户确认，实现功能文档"授权位置或手动选择"）：新增 `expo-location`（原生依赖，dev client 需重装）+ `services/location.ts`——打开 SceneSheet 自动定位（权限未决定弹一次系统授权，拒绝后不重复打扰），坐标降 4 位小数按坐标直查 open-meteo（`fetchTodayWeatherByCoords`）；城市名解析链=平台逆地理 → BigDataCloud 免 Key 客户端接口（国行无 GMS 时平台逆地理常不可用）→ 失败降级"当前位置"占位（天气照常按坐标查）；定位不准/拒绝/失败随时手动改（弹层内明示坐标用途）。回归：`location.test.cjs` 6 项 + weather 坐标用例 1 项。
- 回归：`recommendationInputs.test.cjs`（6 项）与 `configMigration.test.cjs`（6 项）新增；既有用例随 v5/v6 与配置语义更新（迁移断言至 v6、路由测试补 ensureConfigCache、损坏旧文件按 missing）。`pnpm typecheck`、契约样例（7+15 组）通过。
- **未验证边界**：真机走查待项目用户执行（旧 JSON 迁移、推荐带当次场景/锁定、天气失效表达、采用保存来源显示）。
