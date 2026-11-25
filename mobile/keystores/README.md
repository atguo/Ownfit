# release 签名材料（本目录内容不入库）

`ownfit-release.jks` 与 `keystore.properties` 被 git 忽略，只在构建机本机存在。

## 一次性生成（构建机执行，需 JDK 的 keytool）

```bash
keytool -genkeypair -v \
  -keystore ownfit-release.jks \
  -alias ownfit \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass '<生成随机密码>' -keypass '<同一密码>' \
  -dname "CN=Ownfit, OU=Ownfit, O=atguo, C=CN"
```

## keystore.properties（与 jks 同目录，git 忽略）

```properties
storeFile=<本机绝对路径，Windows 用正斜杠，如 D:/workspace/Ownfit/mobile/keystores/ownfit-release.jks>
storePassword=<上面生成的密码>
keyAlias=ownfit
keyPassword=<同一密码>
```

## 构建（构建机执行）

```bash
# 本项目需要 node >= 18（SDK 58；项目默认高版本 node）。
# 本机用 nvm 切换：16.20.1 是为其他项目临时切的，构建前切回 22（需要管理员终端）：
nvm use 22.14.0
node -v   # 应显示 v22.14.0
pnpm --filter @ownfit/mobile exec expo prebuild -p android
cd mobile/android && ./gradlew assembleRelease
# 构建完成后如需还原其他项目环境：nvm use 16.20.1
```

> 兜底：若不便切 nvm（或 nvm 不可用），也可把任意 ≥18 的 node 前置到 PATH。
> **Git Bash 注意（2026-11-10 实测踩坑）**：前置路径必须用 POSIX 形式 `/d/nvm/v22.14.0`；
> 写成扁平盘符 `D:/nvm/v22.14.0` 会被 MSYS2 改写为 `D:\Git
vm22.14.0`（不存在），
> 结果仍落到 node 16，release JS 打包报 `ReferenceError: Blob is not defined`
> （Blob 仅 Node ≥18 为全局对象），任务以 `createBundleReleaseJsAndAssets exit 7` 失败。
> 构建前请用 `node -v` 自检确认版本再跑 gradle。
>
> 首次构建因 android/ 目录刚被 prebuild 重建，需全量编译原生库（约 24 分钟）；此后增量约 4 分钟。

prebuild 时 `plugins/withReleaseSigning.js` 会把 `ownfitReleaseSigning` 注入
`android/app/build.gradle` 的 release 构建型。注入核验：

```bash
grep -c "ownfitReleaseSigning" mobile/android/app/build.gradle   # 应命中 4 处（定义/引用/guard 注释与标记）
grep -n 'keystore.properties' mobile/android/app/build.gradle     # 路径应为 ../keystores/keystore.properties
```

**路径勘误（F5，2026-11-04）**：properties 相对路径以 Android rootProject（`mobile/android`）
为基准，正确值是 `../keystores/keystore.properties`（解析到本目录）。2026-11-04 之前生成的
`android/` 目录注入的是 `../../`（会解析到仓库根导致静默回退 debug 签名），需重跑
`expo prebuild -p android` 让插件升级注入（旧块会被自动修正路径并补校验）。

**release 构建强制正式签名（F5，2026-11-05 真实模板实测）**：guard 挂在
`gradle.taskGraph.whenReady`——`assembleRelease`/`bundleRelease` 在缺 `keystore.properties`、
缺必填字段或 storeFile 不存在时，于任务图就绪时立即以不含密码的 GradleException 失败
（实测无材料时 17 秒失败，早于依赖编译与 JS 打包），不再静默回退 debug 签名；
`assembleDebug` 与日常 prebuild 不受影响。

### 本机走查包（app-release-walkthrough.apk，不可分发）

2026-11-10：手机上原有 0.1.0 debug 安装，与本仓库 `mobile/android/app/debug.keystore` 同签名（指纹一致），
正式签名包无法覆盖安装（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）。为保留本机资料做真机走查，
用同一 debug key 将 release 构建重签为 `app-release-walkthrough.apk`（`apksigner sign --ks app/debug.keystore
--ks-pass pass:android --key-pass pass:android --out ...`）后 `pm install -r` 装机成功。

- **定位：仅供开发者本机走查，不是交付物；严禁分发**（分发件只有正式签名的 `app-release.apk`）。
- 后续决策（项目用户）：本机长期用走查包，或择期卸载一次换装正式签名包（卸载=清空本机衣橱资料，无云备份）。
- 2026-11-16 重建（配置列表刷新修复后走查）：同流程重签，versionCode 1 / 0.6.0-beta1，119,498,158 字节，SHA-256 `48fc4489351d8963e672c0f3dd6681ad9f80e9fdc6b0566bf4c3580dfbacb217`（CN=Android Debug），`pm install -r` 覆盖 2026-11-13 debug dev client 成功、资料保留；验签与 manifest 核验通过。同目录 outputs 下 `app-release.apk` 为当日正式签名构建（CN=Ownfit 证书，SHA-256 `fe546cf6…` 同 11-10 证书），未被重签污染。
- 2026-11-16 二次重建（追加"首击无 loading"修复：推荐/预览生成与 AI 替代按钮解析未就绪时静默返回）：SHA-256 `dbf6a87800fd193226c1cf006f4d02760ac31ee02809f564fda1f9e3aa7225ee`，覆盖安装成功并完成首击真机复核（单击即出现"AI 搭配中…"）；已被 11-25 重建取代。
- 2026-11-25 重建（工作区未提交的 openai_images 通用 OpenAI 图像兼容协议 + 多图参考显式图号绑定，即 imageClient.ts/openaiImagesClient.ts 新文件，支持火山方舟 Seedream 5.0 等多图参考接口）：119,543,214 字节，SHA-256 `f0e356b698eaff042ae3e00af823ba1e194bcb26c55c7813961b375b71eed2bb`，无线 adb push（2.0 MB/s，58s）+ `pm install -r` 覆盖安装成功，资料保留，应用启动进程正常（versionName 0.6.0-beta2 / versionCode 2，lastUpdateTime 2026-11-25 17:00:33）。**当前手机在装版本为此包**；`dbf6a878…` 版本已被取代。模型效果未经走查验证。

### 安装与 adb 的 Git Bash 路径坑（2026-11-10 实测）

`adb push/pull/shell` 的**设备端路径**同样会被 MSYS2 改写（`/data/local/tmp/...` → `D:/Git/data/...`），
导致推送"成功"但文件不在设备上、pm install 静默失败。解决：命令前加 `export MSYS_NO_PATHCONV=1`，
或整条命令走 `cmd /c`。无线传输 119MB 建议先 `adb push` 到 `/data/local/tmp/` 再 `pm install -r`，
流式 `adb install` 容易断流。

### 正式分发包记录（0.6.0-beta2，2026-11-16，M6 批次 5 交付）

- 产物：`mobile/android/app/build/outputs/apk/release/app-release.apk`，119,389,271 字节。
- 版本：com.atguo.ownfit，versionName=0.6.0-beta2 / versionCode=2（可覆盖安装 0.6.0-beta1/versionCode 1 及更早），targetSdk 36，应用名「衣见」。
- 包含 11-10 正式包之后的全部修复：H3-Image 接入、人物参考更新修复、配置列表刷新修复、首击无响应修复。
- SHA-256：`8bf6a799dde558ff9eec1b80d84be7863a18294e5b42eb370cbea07225c26115`。
- 验签：CN=Ownfit, OU=Ownfit, O=lipri, C=CN（正式证书，证书 SHA-256 `fe546cf6…` 与 11-10 一致）；manifest 未声明 usesCleartextTraffic 与 debuggable。
- 分发状态（项目用户 2026-11-16 决定）：**内测分发暂缓**——效果优化期，达标前不分发；本包为分发就绪候选件。
- 2026-11-25 重建（含 openai_images 多图参考改动）：119,433,199 字节，SHA-256 `f00bd48f7af181fd72f16a1e066a8ec8aa362ff416f038b6929c47e87e093701`（CN=Ownfit 正式证书），取代上条成为最新分发就绪候选件；versionName/versionCode 未变（0.6.0-beta2 / 2）。

## 已完成的首次正式构建记录（2026-11-10）
- 产物：`mobile/android/app/build/outputs/apk/release/app-release.apk`，119,376,219 字节（含 4 ABI 原生库）。
- 版本：com.atguo.ownfit，versionName=0.6.0-beta1 / versionCode=1，targetSdk 36，应用名「衣见」。
- SHA-256：`d9e2d4eb88dc940729f60d2ec5a88f4f00ef4b323a935f34160df89e782a4771`。
- 验签：`CN=Ownfit, OU=Ownfit, O=lipri, C=CN`（正式证书，非 androiddebugkey）；
  证书 SHA-256 `fe546cf68a84357a98f5224911cab08c20fc75ea27212af6082186203ff47dab`。
- manifest：未声明 `usesCleartextTraffic` 与 `debuggable`（内测包禁明文要求在真实产物上确认）。
- 尚待：覆盖安装与真机启动验证（安装若与既有 debug 安装签名冲突，回报冲突，勿卸载丢资料）。

产物验签（确认不是 debug 签名）：

```bash
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs mobile/android/app/build/outputs/apk/release/app-release.apk
```

## 保管约定（2026-11-03 与项目用户确认）

- keystore 文件与密码只存构建机本机；**丢失后无法再以同一签名发布更新**，用户需卸载重装。
- 密码不在仓库、文档、聊天中登记；建议构建机用户自行记入个人密码管理器。
- 换 keystore = 换签名身份：只能新包重装，历史安装不能覆盖升级。
