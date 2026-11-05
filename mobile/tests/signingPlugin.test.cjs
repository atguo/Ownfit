// F5 回归（评估 §8.7，2026-11-04）：release 签名插件注入正确性。
// - properties 相对路径以 Android rootProject（mobile/android）为基准解析到 mobile/keystores
// - release 块 signingConfig 替换、debug 块不变
// - release 打包任务缺正式签名时的构建失败校验块（doFirst GradleException，不含密码）
// - 幂等；旧注入块（../../ 错误路径）升级
// - 模板不匹配（无 buildTypes）不注入且保留原内容
// 运行：仓库根 `node --test mobile/tests/signingPlugin.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const plugin = require('../plugins/withReleaseSigning.js');
const applyReleaseSigning = plugin.applyReleaseSigning;
const PROPS_FILE = plugin.PROPS_FILE;

// 与 expo prebuild 生成的 android/app/build.gradle 结构一致的模板（节选）
const TEMPLATE = [
  'apply plugin: "com.android.application"',
  'apply plugin: "com.facebook.react"',
  '',
  'react {',
  '}',
  '',
  'def enableProguardInReleaseBuilds = false',
  '',
  'android {',
  '    ndkVersion rootProject.ext.ndkVersion',
  '',
  '    signingConfigs {',
  '        debug {',
  '            storeFile file("debug.keystore")',
  '            storePassword "android"',
  '            keyAlias "androiddebugkey"',
  '        }',
  '    }',
  '',
  '    buildTypes {',
  '        debug {',
  '            signingConfig signingConfigs.debug',
  '        }',
  '        release {',
  '            // caution: In practice, the signing config should be handled elsewhere',
  '            signingConfig signingConfigs.debug',
  '            minifyEnabled enableProguardInReleaseBuilds',
  '            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"',
  '        }',
  '    }',
  '}',
  '',
  'dependencies {',
  '    implementation("com.facebook.react:react-native")',
  '}',
].join('\n');

test('F5：properties 路径以 rootProject 解析到 mobile/keystores（不是仓库根）', () => {
  assert.equal(PROPS_FILE, '../keystores/keystore.properties');
  // 模拟 Gradle 的 rootProject.file（rootProject.dir = mobile/android）
  const androidRoot = path.resolve('/workspace/Ownfit/mobile/android');
  const resolveLikeGradle = (relative) => path.resolve(androidRoot, relative);
  const resolved = resolveLikeGradle(PROPS_FILE);
  assert.equal(resolved, path.resolve('/workspace/Ownfit/mobile/keystores/keystore.properties'));
  // 旧路径会错到仓库根（F5 缺陷回归：说明为什么必须改）
  assert.equal(
    resolveLikeGradle('../../keystores/keystore.properties'),
    path.resolve('/workspace/Ownfit/keystores/keystore.properties'),
  );
});

test('注入：release 块换正式签名、debug 块保持 debug、guard 校验块存在', () => {
  const patched = applyReleaseSigning(TEMPLATE);
  // release 块使用注入的签名配置变量
  assert.match(patched, /signingConfig ownfitReleaseSigning/);
  // debug 块保持 debug 签名不变
  assert.match(patched, /debug \{\s*signingConfig signingConfigs\.debug/);
  // properties 路径正确（不含旧 ../../）
  assert.ok(patched.includes('rootProject.file("../keystores/keystore.properties")'));
  assert.ok(!patched.includes('"../../keystores/keystore.properties"'));
  // 缺签名材料时在任务图就绪时立即失败（不含密码，早于依赖编译）
  assert.match(patched, /ownfitReleaseSigningGuard/);
  assert.match(patched, /gradle\.taskGraph\.whenReady/);
  assert.match(patched, /GradleException\("release 正式签名未配置：缺少 mobile\/keystores\/keystore\.properties/);
  assert.match(patched, /android\.signingConfigs\.findByName\("ownfitRelease"\) == null/);
  // 必填字段与 storeFile 存在性在配置阶段校验（缺字段不创建 ownfitRelease 签名 → guard 拦截）
  assert.match(patched, /findAll \{ !keystoreProps\[it\] \}/);
  assert.match(patched, /file\(ownfitStoreFile\)\.exists\(\)/);
});

test('幂等：二次应用输出不变（含 guard 块）', () => {
  const once = applyReleaseSigning(TEMPLATE);
  const twice = applyReleaseSigning(once);
  assert.equal(twice, once);
});

test('旧注入块升级：修正 ../../ 路径并补 guard，不重复注入配置块', () => {
  // 模拟 2026-11-04 前版本的注入产物（错误路径、无 guard、无必填字段校验）
  const legacy = TEMPLATE.replace(
    '        release {',
    [
      '        // release 正式签名（withReleaseSigning 插件注入；keystore 与密码不入库）',
      '        def keystorePropsFile = rootProject.file("../../keystores/keystore.properties")',
      '        def ownfitReleaseSigning = signingConfigs.debug',
      '        if (keystorePropsFile.exists()) {',
      '            def keystoreProps = new Properties()',
      '            keystorePropsFile.withInputStream { keystoreProps.load(it) }',
      '            ownfitReleaseSigning = signingConfigs.create("ownfitRelease") {',
      "                storeFile file(keystoreProps['storeFile'])",
      "                storePassword keystoreProps['storePassword']",
      "                keyAlias keystoreProps['keyAlias']",
      "                keyPassword keystoreProps['keyPassword']",
      '            }',
      '        }',
      '        release {',
    ].join('\n'),
  ).replace('signingConfig signingConfigs.debug\n            minifyEnabled', 'signingConfig ownfitReleaseSigning\n            minifyEnabled');
  const upgraded = applyReleaseSigning(legacy);
  // 路径已修正
  assert.ok(upgraded.includes('rootProject.file("../keystores/keystore.properties")'));
  assert.ok(!upgraded.includes('"../../keystores/keystore.properties"'));
  // guard 已补上
  assert.match(upgraded, /ownfitReleaseSigningGuard/);
  // 不重复注入第二份配置块（keystorePropsFile 定义只出现一次）
  assert.equal(upgraded.split('def keystorePropsFile =').length - 1, 1);
});

test('模板不匹配（无 buildTypes）：不注入，保留原内容', () => {
  const odd = 'apply plugin: "com.android.application"\n// buildTypes moved elsewhere\n';
  const patched = applyReleaseSigning(odd);
  assert.equal(patched.includes('ownfitReleaseSigning ='), false);
  // guard 不注入（签名配置没成功注入时，无意义的 guard 反而破坏无 keystore 机器的日常任务）
  assert.equal(patched.includes('ownfitReleaseSigningGuard'), false);
});
