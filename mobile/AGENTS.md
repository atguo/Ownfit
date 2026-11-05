本目录属于“衣见”（Ownfit）项目。协作约束、架构边界与同步义务以仓库根目录 [AGENTS.md](../AGENTS.md) 为准；实施顺序与验收见 [docs/开发计划.md](../docs/开发计划.md)。

## 当前结构（2026-11-03 核对，M6 批次 1 后更新）

M0–M5 完成（M5 视同验收）；M6 进行中：批次 1（M5 登记缺口收尾）已实现并经项目用户真机走查通过（2026-11-03）；批次 2 五项 M6 前决定已确认并落地，批次 3 本地部分（签名插件、版本号）完成，keystore 生成/构建/验签待构建机。详见 [M6 实施计划](../docs/plans/2026-11-03-M6-真机质量验证与内测候选-实施计划.md)。下文带日期记录保留历史语境，不以历史“0 次调用/待验收”覆盖后续证据。

- `src/app/`：根 Stack + `(tabs)/` 四主入口 + `choose`、`outfit`、`add` + `ai/config`、`ai/config-edit` + `dev/components`、`dev/data-tools`。预览为 `PreviewSheet` 弹层，当前没有独立 `preview.tsx` 路由。
- `src/ui/`：设计令牌、图标、响应式页面容器与原生组件，真实搭配板为 `RealOutfitBoard`。
- `src/data/`：SQLCipher schema v6、密钥管理与 user_version 迁移；repositories 包含衣物/照片/属性/方案/分析任务/预览/推荐/维护/设置（含长期偏好、场景默认、身材资料 body-profile）/颜色库。照片、人物参考和生成图保存在应用私有目录。
- `src/services/`：AI 配置、协议客户端及分析/预览/推荐执行器；`weather.ts` 提供可选城市天气查询，`location.ts` 提供定位。非敏感 AI 配置存本地库 `ai_configs` 表（v6，DB 为源 + 内存镜像），API Key 仍只在设备安全存储；服务地址仅接受 https（M6 批次 2 明文收敛）。
- `src/features/`：`outfitSession` 编辑会话（含会话来源 origin：manual/ai），分析/预览/推荐 store，`weatherAuto` 自动天气编排，`sheets/` 原生弹层。`demoStore` 承载当次场景等内存上下文；推荐已消费该当次场景（含温度来源区分，演示温度不进 AI）。
- `plugins/`：Expo 配置插件（`withReleaseSigning.js` 注入 release 正式签名，经 prebuild 生效）；`keystores/`（git 忽略，README 入库）存放构建机本机的签名材料。

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

### M6 批次 1：M5 登记缺口收尾（2026-11-03 实现完成，同日项目用户真机走查通过）

依据 [M6 实施计划](../docs/plans/2026-11-03-M6-真机质量验证与内测候选-实施计划.md) 批次 1 落地四项：

- **1.1 契约标识统一**：`packages/contract` 内部常量与 package.json 去 draft 统一 1.0.0；公共入口改为从 `schema.ts` 转出唯一定义。
- **1.2 推荐当次输入与采用保存语义**：`loadSceneSnapshot` 改读首页当次 context（演示温度 tempSource='demo' 不进 AI；实时/手动温度带来源）；入队持久化输入快照（schema v5 增 `tasks.input_json`：当次场景 + 锁定单品别名），执行器按快照发送、不现读会话；提示词升 v2（锁定单品必须包含、温度标注来源）；`outfitSession` 增会话来源 origin，采用候选带 `source='ai'` + 理由，`planRepository` 按 Plan.source 落库（不再固定 manual）。
- **1.3 天气地点/日期失效**：SceneSheet 改城市/日期即清空已查天气；选「明天」时今日预报不适用（如实提示手动填写，不冒充明天天气）；地点/日期变化且无新温度时旧实时温度回退示例占位（明确标注），不静默沿用；`pickCurrentTemp` 纯函数化；获取时间存入 context 并本地时区展示（不再 UTC 截取）。
- **1.4 AI 非敏感配置迁数据库**：schema v6 新增 `ai_configs` 表；`configStore` 改为"DB 为源 + 内存镜像"，同步 getter 签名不变（任务执行器/路由层零改动）；启动时 `_layout` 先 `ensureConfigCache` 再启动分析执行器（避免镜像未就绪误判配置失效）；首次初始化表空且旧 JSON 可解析则搬入并删除旧文件（表非空后不再读旧文件，损坏文件保留不删按无配置处理）；API Key 仍只在 SecureStore；`callRevision` 语义不变；安全模式重试后重新加载镜像。
- **1.5 MiniMax 图像地址改完整地址直填**（2026-11-03 项目用户确认）：`endpointFor('minimax')` 返回用户输入的完整接口地址（不追加路径；原"基础地址自动拼 `/v1/image_generation`"会把 `/v1` 结尾的地址拼成 `/v1/v1/...` 404）；OpenAI 兼容仍自动拼 `/chat/completions`；配置表单按类型区分标签、占位与校验（minimax 要求含路径的完整地址）。回归：`endpoint.test.cjs` 2 项。**已有 MiniMax 配置需在 APP 内重新编辑为完整地址。**
- **1.6 天气定位为主、手动为辅；打开 APP 自动查询**（2026-11-03 项目用户确认，实现功能文档"授权位置或手动选择"）：新增 `expo-location`（原生依赖，dev client 需重装）。`services/location.ts`：先取 10 分钟内缓存位置（秒出），无缓存再实定位（单次 15 秒、失败退避 2 秒重试一次——冷启动首修慢是真机超时主因）；权限未决定弹一次系统授权，拒绝后不重复打扰；坐标降 4 位小数按坐标直查 open-meteo（`fetchTodayWeatherByCoords`）；城市名解析链=平台逆地理 → BigDataCloud 免 Key 客户端接口（国行无 GMS 时平台逆地理常不可用）→ 失败降级"当前位置"占位。`features/weatherAuto.ts`：启动与回前台自动定位+查天气并写入当次 context（首页天气条直接实时），2 小时/跨日过期自动重查，并发防重入，失败保持占位不打扰；SceneSheet 与启动流程共用同一条链路（弹层内明示坐标用途，手动改城市按城市名查询）。回归：`location.test.cjs` 9 项 + `weatherAuto.test.cjs` 8 项 + weather 坐标用例。
- 回归：`recommendationInputs.test.cjs`（6 项）与 `configMigration.test.cjs`（6 项）新增；既有用例随 v5/v6 与配置语义更新（迁移断言至 v6、路由测试补 ensureConfigCache、损坏旧文件按 missing）。`pnpm typecheck`、契约样例（7+15 组）通过。
- **未验证边界**：真机走查经项目用户 2026-11-03 确认通过（旧 JSON 迁移、推荐带当次场景/锁定、天气失效表达与定位、采用保存来源显示、MiniMax 完整地址生成），批次 1 收口；端到端质量结论随批次 4 验证报告登记。

### M6 批次 2 决定落地与批次 3 本地部分（2026-11-03 项目用户确认，2026-11-04 实现）

五项 M6 前决定（详见 [M6 实施计划](../docs/plans/2026-11-03-M6-真机质量验证与内测候选-实施计划.md) 批次 2）：APK 直接分发；导出/备份本期不做；内测包禁明文；人体尺寸内测前实现基础录入；生成正式 keystore。

**身材资料基础录入**（归属[个人资料管理](../docs/functions/个人资料管理.md)）：

- `settingsRepository` 增 `BodyProfile`（`{heightCm?, weightKg?, updatedAt}`）与 `getBodyProfile`/`saveBodyProfile`：存 preferences 表 JSON（id=`body-profile`，避开 `pref-` 前缀纪律），数值一位小数规整、非正数拒存，两项全空视为清除记录（删行）；损坏/非法记录按"未填写"返回 null 不抛错。
- `ProfileSheets.BodySheet` 由说明页改为真实录入：身高 50–250cm、体重 20–300kg 选填，可清除记录；`(tabs)/profile.tsx` 行值显示"身高 Xcm · 体重 Ykg"。
- 推荐链路：`recommendationUserPrompt` 增 `body` 参数（输出"用户身材资料（选填，仅作体型参考，不要给出合身结论）：身高=…，体重=…"），`RECOMMENDATION_PROMPT_VERSION` 升 **v3**；`buildRecommendationInputKey` 纳入 body（数值变化视为新输入）；`enqueueRecommendation` 读取 body-profile 随入队快照（`input_json.body`）与指纹持久化；执行器 `sanitizeBody` 只放行正数值字段，脏数据不进提示词。

**明文收敛**（归属[AI模型配置与接入](../docs/functions/AI模型配置与接入.md)）：

- `app.json` 移除 `android.usesCleartextTraffic`（Android 默认禁明文）；`types.insecureUrlProblem(baseUrl)` 纯函数校验（https 放行、空值交必填校验），`ai/config-edit.tsx` 保存与测试前拒绝 `http://`。自部署模型需 https 或反向代理；旧 http 配置调用时被系统拦截需重新编辑。

**release 签名与版本号**：

- 新增 `plugins/withReleaseSigning.js`（Expo 配置插件，`expo/config-plugins` 的 `withAppBuildGradle`）：向 `android/app/build.gradle` 注入 `ownfitReleaseSigning`（读 `keystores/keystore.properties` 的 storeFile/storePassword/keyAlias/keyPassword），仅替换 release 块的 signingConfig；幂等，模板标记缺失时告警并保持原样（不阻断 prebuild）；properties 缺失时 release 退回 debug 签名。
- `keystores/`：keystore 与 properties 被 git 忽略（`/keystores/*` + 全局 `*.jks`），`keystores/README.md` 入库——keytool 生成命令、properties 模板（路径用绝对路径正斜杠）、prebuild 后 grep 核验、apksigner 验签、保管约定（丢失无法覆盖升级）。
- `app.json`：version=**0.6.0-beta1**、android.versionCode=**1**；约定每分发一包 versionCode+1。

验证：mobile 回归 **117/117**（新增 `bodyProfile.test.cjs` 3 项：存取/清除/损坏记录、前缀纪律；`endpoint.test.cjs` 增 https 校验；`recommendationInputs.test.cjs` 增身材入队快照与指纹、提示词身材段、执行器消毒断言，promptVersion 断言更新 v3）；契约样例 7+15 组通过；`pnpm typecheck` 通过——顺带修复 `src/ui/screen.tsx`→`Screen.tsx`（TS 6 强制一致命名报错；11 处导入均为 `Screen`，改名跟随导入侧与 Icon/PageTop 组件命名惯例）。本机 `expo prebuild -p android` 核验：`ownfitReleaseSigning` 注入 3 处、manifest 无 `usesCleartextTraffic`、版本号生效。

**未验证边界**：身材录入 UI 与提示词实际效果未真机走查；keystore 生成、`assembleRelease`、apksigner 验签与 release 真机启动验证须在构建机执行（当前开发机无 Android 工具链）；明文拦截的运行时错误表现未实测。完成前不宣称内测候选包就绪。

### 核心目标能力改进批次（2026-11-04 实现完成，待真机走查）

依据[能力改进建议](../docs/plans/2026-11-03-围绕核心目标的能力改进建议.md)与[计划落地代码评审](../docs/plans/2026-11-03-计划落地代码评审.md)，项目用户确认四项决定（任务范围=通勤/日常外出+上装/下装/鞋/外套≤2层、预览=文字路径+防偏闭环、D3 提前、放行口径=三层结论）后授权自主实施全部批次；实施决策 D-1～D-16 登记于[落地计划与决策记录](../docs/plans/2026-11-04-核心目标能力改进-落地计划与决策记录.md)。真实模型调用 0 次；效果结论未知。M6 批次 2 的身材链路在本批次中沿用并随提示词升 v4。

- **数据**：schema **v7**——`preview_checks`（C8 核对记录）、`preview_comparisons`（C5 比较组）、`plan_items.wear_style`（C4 逐件穿法）、`worn_records.reasons`（D3 反馈原因 JSON）。搭配契约升 **1.1.0**（`Plan.items` 可选 per-item wearStyle，顶层 wear 保留兼容；契约样例 9 组，package.json 同步 1.1.0）。
- **衣物证据（A1/A2/A3）**：`getAnalysisView` 有效值改为"同名人工行优先、AI 行其次"（重新分析不再静默覆盖人工确认值，历史行保留可比较）；推荐/预览名称用户名称优先；新增 `services/ai/garmentView.ts` 归一化视图（关键特征/次要分层、主色 hex，推荐/预览/核对三处同源）与 `services/ai/evidenceCheck.ts`（锁定单品证据缺口提示，可跳过，不全柜拦截）。
- **推荐（B1/B2/B4/B5/B6）**：请求摘要可见可改——锁定件数、选填"本次要求"（随快照入 `input_json`，仅当次）、长期偏好全部参与排序；提示词升 **v4**（锁定/偏好/当次要求/天气描述/截取说明）；档案超 40 件按"锁定优先+创建顺序"截取并如实注明（`loadProfileForRunner`，别名保持全柜编号不重排）；本地可执行校验进 `normalizeRecommendation`（重复单品/槽位、连衣裙冲突、包/配饰拒绝、锁定覆盖、相同组合去重）；`SlotReplaceSheet` 增"AI 推荐替代"（其余槽位随请求锁定，决策 D-6）；实时天气描述进场景文本（B6）。
- **槽位（B3/R2/R3）**：`OutfitSlot` 增加 `outer`（外套独立槽位，与上衣共存），采用/复用/保存按品类归槽不再丢外套；采用时保留请求锁定集与可用性/槽位冲突拒绝；包/配饰明确"本期不支持"（D-1；RealOutfitBoard 几何不变，外套在单品行呈现，D-16）。
- **预览（C2/C3/C5/C7/C8）**：入队快照（`input_json`）固定单品集+各单品 `items.revision`+穿法（含逐件）+参考版本与视角，执行前校验不一致标 `stale`（旧图不冒充当前输入）；"本方案"判定按完整输入版本（`previewInputMatches`）；提示词按重要性组织（身份层→次要层，预算 6000 字符，超限显式失败 `prompt_over_budget`），`minimaxClient` 去除 1500 字符静默截断（C7）；生成后自动视觉核对（`previewChecker.ts` + `preview_checks` 表）：单品原图+人物参考+生成图逐项 match/deviate/unknown，重大偏离自动纠偏最多 1 次（D-3），无视觉模型诚实登记 `unchecked`（核对路由复用衣物分析视觉默认配置，D-15）；参考照可声明"面部特写/全身照"（C3，视角变化视为参考版本变化）；`preview_comparisons` 同参考版本双方案并排比较（C5）。
- **反馈（D1/D3）**：FeedbackSheet 先等 `recordWorn` 落库成功再提示（失败保留用户选择）；满意/不满意后提供 4 个可跳过原因（看着不喜欢/穿着不舒服/冷热不合适/预览不像实物，可多选，关联方案版本）。
- **工程收口（R1/R6/R8/R9）**：三 runner（分析/推荐/预览）生命周期统一由 `app/_layout.tsx` 管理（启动恢复一次、前台跟随 AppState；面板只订阅，不再 recover/setForeground——生成中开关面板不再误标 interrupted）；`commitRecommendationResult` 条件提交（仅 running 可写，迟到结果不覆盖终态）；预览保存失败持久化 `pendingUrl`，面板可"仅重试下载"（不重新生成、不重复计费）；两执行器看门狗定时器清理；`weatherAuto` 天气绑定日期/城市/有效期（查看"明天"不写今日温度、城市变化后失败回退占位、过期刷新失败降级 demo 来源）；复用方案保留 source/reason/锁定/父版本与逐件穿法，换件后保存理由标"（搭配已修改，以下为原始推荐理由）"（R9/D-14）。
- 回归：`node --test mobile/tests/*.test.cjs` 全量通过（新增 `coreGoalLoop.test.cjs` 14 项：B1/B3/B4/A2/C3/C7/C8/C2/C4/C5/D3/R8；weatherAuto 增 R6 3 项；garmentTasks A1 语义更新；preview 用例随快照与新提示词形状更新；recommendationInputs promptVersion 断言升 v4）；`pnpm typecheck` 通过；契约样例 9+15 组通过。**真机走查待项目用户执行**；核对器质量需人工样本校准后才能宣称防偏有效。

### 全部计划评估修改方案 S0–S4（2026-11-04 实现完成，待真机走查）

依据[全部计划评估第 8 节修改方案](../docs/plans/2026-11-04-全部计划落地实施评估.md)实施 F1–F8 修复与其余缺口收尾；实施记录见评估第 9 节。真实模型调用 0 次；回归 167/167 通过；真机走查、release 构建/验签与模型效果校准待执行。

- **数据**：schema **v8**——`tasks.result_artifact_id`（当前产物指针，CAS 条件提交）、`preview_artifacts`（不可变产物：路径/实际 prompt/输入指纹/配置/尝试序号）、`preview_postprocess`（核对/纠偏生命周期 queued/checking/correcting/checked/unchecked/unknown/interrupted + 纠偏预算）、`pending_cleanup`（删除失败文件最小记录）、`preview_checks.artifact_id`（核对关联产物）、`preview_comparisons.artifact_a_id/artifact_b_id/conditions_json`（比较绑定产物与共同条件）。迁移与回读测试同批交付（`previewArtifacts.test.cjs`）。
- **推荐 S1（F2/F8）**：新增 `services/ai/recommendationInput.ts`（`RecommendationInputV2`、`canonicalJson`、V2 指纹、安全解析）与 `services/ai/canonical.ts`（规范化 JSON，推荐/预览共用）。入队生成不可变快照（实际发送档案、realId/alias/revision、锁定真实 ID、场景具体日期 `localTargetDate`、基线、targetSlot）存 `tasks.input_json`；执行器不再现读衣橱——`validateSnapshotItems` 整体校验（缺件/版本不符标 stale 保留原请求），旧格式 queued 标 stale 不自动重发；`normalizeRecommendation` 增品类↔槽位一致与局部替换可变范围校验（只允许目标槽位变化，禁止新增槽位/改动保留件）；`evaluateAdoption`（store 纯函数）按快照复核会话基线/锁定——整套采用保留原请求锁定，局部采用走 `replaceSlot` 单次变更（撤销一次恢复采用前状态），旧记录/会话已变化拒绝采用并提示重新推荐；`RecommendationSheet.adopt` 与 `outfit.tsx aiSwapSlot`（传 targetSlot+baseline）接线。提示词升 **v5**：属性带人工确认标记（A1）、日期带具体日期、局部替换显式说明；`buildRecommendationInputKey`（别名版）删除。
- **预览 S2（F3/F6→F1→F7）**：`effectiveSlotWear`（outfitSession，§8.3.1 单一出处：内搭/连衣裙取覆盖或主穿法、外套取覆盖或自然垂放、鞋履不继承）供 outfit 页组 props，入队原样存快照；`buildPreviewInputKey`/`previewInputMatches` 含逐件穿法与参考视角（canonical），预览提示词升 **v2**、核对规则升 **v2**（逐件穿法进约束、缺图标注附图索引）。`downloadAndCommitArtifact`：下载唯一新文件（60s 超时定时器竞速后清理）→ 短事务校验状态/指针 → 产物行+指针+后处理 queued 同事务落库，失败清文件不留悬空；`savePendingDownload` 仅 running 可写；`retryPreviewDownload` 领取本地执行权→条件提交→翻状态（翻不动则撤销产物）。runner 重构：生成成功落产物指针后由后处理循环领取核对——核对输入为刚提交产物路径（F1 修复）、单品**原图**作证据（不拿 480px 缩略图）、缺图件记 unknown 并显式标注（不 filter 重排）、人物参考缺失一致性 unknown；来源已删除/资料已变化撤销后续阶段；纠偏 = 指针 CAS 提交新产物（attempt+1）→ 队列重新核对新图，原产物与判定保留；启动恢复把遗留 checking/correcting 标 interrupted。`createPreviewComparison` 校验共同条件（参考版本/视角/配置/配置版本/提示词版本/比例）+产物文件可读，legacy（无产物）拒绝并如实提示。
- **天气 S3（F4）**：`demoStore` context 增 `conditionRevision`（用户改动递增、自动写回 internal 不递增）、`weatherTargetDate`、`weatherPlace`；`weatherAuto` 按请求版本条件写回（locate/请求期间用户改动→响应整体丢弃并如实提示）、写回绑定目标日期与归属地点、在途 force/条件变化排跟进执行；`isRealWeatherUsable`（recommendationStore 导出）供推荐输入与首页消费前校验（跨日/错位/超龄的 real 不进模型，首页标"已过期"）。
- **S4 工程**：`withReleaseSigning.js` properties 路径改 `../keystores/`（相对 Android rootProject；旧 `../../` 注入块自动升级），注入 release 打包任务 guard（缺 properties/字段/keystore 文件 → doFirst GradleException 不含密码；模板不匹配不加 guard）；`configStore` 迁移独立标记 `ai-configs-migrated-v6`（与导入同事务，删空配置不复活，损坏文件保留+`getLegacyMigrationProblem`）、`ensureConfigCache` 共享 Promise（失败可重试）、`updateConfig` 换 Key 写新 keyRef（随机后缀防同毫秒碰撞）→DB 提交→清旧凭证（DB 失败删新凭证）；`evidenceCheck` 接 targetStatus/unclearParts/文件可读性（A3），PreviewSheet 面板消费为可跳过提示；推荐档案选择改槽位保底配额（`RECOMMENDATION_SLOT_QUOTA=6`，B2）+ 次要层压缩（`splitAttributesByImportance`）+ 超预算显式拒绝（`RECOMMENDATION_PROMPT_BUDGET=8000`）；`profileLines`（A2）经 `buildGarmentFeatureView` 组档案行，与预览/核对同源；搭配页"选配色"入口恢复（`ColorHintSheet`，颜色库多选、会话软提示 `colorHints`、可清除、新会话清空，不发送给 AI）；维护扫描扩展 previews/preview-ref 孤儿（活动写入保护 1 小时窗）与 `retryPendingCleanup`；`keystores/README.md` 登记 F5 路径勘误与强制签名。
- 回归：`node --test mobile/tests/*.test.cjs` **167/167**（新增 previewArtifacts 8 项、signingPlugin 5 项；recommendationInputs 重写 18 项；weatherAuto 增 F4 5 项；configMigration 增 §8.8 4 项；coreGoalLoop/preview/analysisMigration 随新语义更新）；契约样例 9+15 组；`pnpm typecheck` 通过。**未验证边界**：真机走查（局部替换采用、预览核对状态行、天气丢弃提示、选配色）、release 构建/apksigner 验签/覆盖安装、模型效果（核对器校准、纠偏有效率、比较公平性）。

**M6 批次 3 预检补充（2026-11-05，本机真实模板）**：真实 `expo prebuild -p android` 后核验注入——`ownfitReleaseSigning` 4 处命中、properties 路径 `../keystores/`、guard 两段 GradleException 就位、debug 块保持 debug 签名、无旧 `../../` 残留；guard 从 assembleRelease 的 doFirst 改挂 `gradle.taskGraph.whenReady`（任务图就绪即失败，不再等依赖编译与 JS 打包后才暴露）——无 keystore 时 `assembleRelease` 实测 **17 秒**以不含密码的 GradleException 失败。环境事实（影响用户构建）：本机默认 PATH 的 node 16 无法完成 release JS 打包（`createBundleReleaseJsAndAssets` exit 7，22 分钟后才报错），构建时需把 node 24（codex runtime 路径）前置到 PATH；插件测试同步更新（5/5）。
