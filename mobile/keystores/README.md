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
pnpm --filter @ownfit/mobile exec expo prebuild -p android
pnpm --filter @ownfit/mobile exec expo run:android --variant release   # 或 cd mobile/android && ./gradlew assembleRelease
```

prebuild 时 `plugins/withReleaseSigning.js` 会把 `ownfitReleaseSigning` 注入
`android/app/build.gradle` 的 release 构建型。注入核验：

```bash
grep -n "ownfitReleaseSigning" mobile/android/app/build.gradle   # 应命中 2 处（定义 + release 引用）
grep -n 'keystore.properties' mobile/android/app/build.gradle     # 路径应为 ../keystores/keystore.properties
```

**路径勘误（F5，2026-11-04）**：properties 相对路径以 Android rootProject（`mobile/android`）
为基准，正确值是 `../keystores/keystore.properties`（解析到本目录）。2026-11-04 之前生成的
`android/` 目录注入的是 `../../`（会解析到仓库根导致静默回退 debug 签名），需重跑
`expo prebuild -p android` 让插件升级注入（旧块会被自动修正路径并补校验）。

**release 构建强制正式签名（F5）**：`assembleRelease`/`bundleRelease` 任务在缺
`keystore.properties`、缺必填字段或 storeFile 不存在时会以不含密码的 GradleException
直接失败，不再静默回退 debug 签名；`assembleDebug` 与日常 prebuild 不受影响。

产物验签（确认不是 debug 签名）：

```bash
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs mobile/android/app/build/outputs/apk/release/app-release.apk
```

## 保管约定（2026-11-03 与项目用户确认）

- keystore 文件与密码只存构建机本机；**丢失后无法再以同一签名发布更新**，用户需卸载重装。
- 密码不在仓库、文档、聊天中登记；建议构建机用户自行记入个人密码管理器。
- 换 keystore = 换签名身份：只能新包重装，历史安装不能覆盖升级。
