// M6 批次 3：release 正式签名接入（2026-11-03 项目用户确认生成正式 keystore）。
// F5 修正（2026-11-04，评估 §8.7）：properties 相对路径以 Android rootProject（mobile/android）
// 为基准应为 ../keystores/keystore.properties（旧版 ../../ 会解析到仓库根，缺文件静默回退 debug）。
// 内测分发包必须以正式签名构建：release 打包任务（*Release）缺 properties/必填字段/keystore 文件
// 时在 doFirst 给出不含密码的构建错误，不回退 debug；debug 构建与日常 prebuild 不受影响。
// keystore 与密码不入库：mobile/keystores/keystore.properties（git 忽略）提供
// storeFile / storePassword / keyAlias / keyPassword 四项（路径建议绝对路径正斜杠）。
// 经 expo prebuild 注入 android/app/build.gradle（该目录整体重建，不能手改），重复 prebuild 幂等；
// 旧版注入块（错误路径）升级：仅修正路径并补校验块，不重复注入。
const { withAppBuildGradle } = require('expo/config-plugins');

const SIGNING_MARKER = 'ownfitReleaseSigning';
const GUARD_MARKER = 'ownfitReleaseSigningGuard';
// 以 Android rootProject（mobile/android）为基准；解析结果是 mobile/keystores/keystore.properties
const PROPS_FILE = '../keystores/keystore.properties';
const LEGACY_PROPS_FILE = '../../keystores/keystore.properties';

/** 注入签名配置块与 release signingConfig 替换；返回是否发生注入 */
function injectSigningConfig(contents) {
  if (contents.includes(SIGNING_MARKER)) {
    // 旧注入块升级：仅修正错误的 properties 相对路径（其余保持幂等）
    if (contents.includes(LEGACY_PROPS_FILE)) {
      return { contents: contents.replace(LEGACY_PROPS_FILE, PROPS_FILE), injected: true };
    }
    return { contents, injected: false };
  }
  const buildTypesIdx = contents.indexOf('buildTypes {');
  if (buildTypesIdx === -1) {
    console.warn('withReleaseSigning: build.gradle 中未找到 buildTypes，未注入 release 签名（模板变化需人工核对）');
    return { contents, injected: false };
  }
  const configBlock = [
    '        // release 正式签名（withReleaseSigning 插件注入；keystore 与密码不入库）',
    `        def keystorePropsFile = rootProject.file("${PROPS_FILE}")`,
    `        def ${SIGNING_MARKER} = signingConfigs.debug`,
    '        if (keystorePropsFile.exists()) {',
    '            def keystoreProps = new Properties()',
    '            keystorePropsFile.withInputStream { keystoreProps.load(it) }',
    "            def ownfitMissing = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'].findAll { !keystoreProps[it] }",
    "            def ownfitStoreFile = keystoreProps['storeFile']",
    '            if (ownfitMissing.isEmpty() && ownfitStoreFile && file(ownfitStoreFile).exists()) {',
    `                ${SIGNING_MARKER} = signingConfigs.create("ownfitRelease") {`,
    "                    storeFile file(keystoreProps['storeFile'])",
    "                    storePassword keystoreProps['storePassword']",
    "                    keyAlias keystoreProps['keyAlias']",
    "                    keyPassword keystoreProps['keyPassword']",
    '                }',
    '            }',
    '        }',
    '',
    '',
  ].join('\n');
  let patched = contents.slice(0, buildTypesIdx) + configBlock + contents.slice(buildTypesIdx);

  // 仅替换 release 块内的 signingConfig（debug 块保持 debug 签名不变）
  const releaseIdx = patched.indexOf('release {', buildTypesIdx);
  if (releaseIdx === -1) {
    console.warn('withReleaseSigning: 未找到 release 块，release 仍用 debug 签名（模板变化需人工核对）');
    return { contents: patched, injected: false };
  }
  const debugSigning = 'signingConfig signingConfigs.debug';
  const signIdx = patched.indexOf(debugSigning, releaseIdx);
  if (signIdx === -1) {
    console.warn('withReleaseSigning: release 块内未找到 debug 签名声明，未注入正式签名（模板变化需人工核对）');
    return { contents: patched, injected: false };
  }
  patched = patched.slice(0, signIdx) + `signingConfig ${SIGNING_MARKER}` + patched.slice(signIdx + debugSigning.length);
  return { contents: patched, injected: true };
}

/** 注入 release 打包校验（缺正式签名即失败；debug/prebuild 不受影响） */
function injectSigningGuard(contents) {
  if (contents.includes(GUARD_MARKER)) return contents;
  const guardBlock = [
    '',
    `// ${GUARD_MARKER}：分发构建必须使用正式签名（F5，2026-11-04）——`,
    '// release 打包任务缺 keystore.properties/必填字段/keystore 文件时立即失败（不含密码），',
    '// 不静默回退 debug 签名；debug 构建与不需要密钥的日常 prebuild 不受影响。',
    'tasks.matching { it.name.startsWith("assemble") && it.name.contains("Release") || it.name.startsWith("bundle") && it.name.contains("Release") }.configureEach {',
    '    doFirst {',
    `        def guardPropsFile = rootProject.file("${PROPS_FILE}")`,
    '        if (!guardPropsFile.exists()) {',
    '            throw new GradleException("release 正式签名未配置：缺少 mobile/keystores/keystore.properties（内测分发包禁止 debug 签名）。生成与保管步骤见 mobile/keystores/README.md")',
    '        }',
    '        if (android.signingConfigs.findByName("ownfitRelease") == null) {',
    '            throw new GradleException("release 正式签名未生效：keystore.properties 缺少必填字段或 storeFile 不存在。请核对 mobile/keystores/README.md（此错误不含密码信息）")',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  return `${contents}\n${guardBlock}`;
}

function applyReleaseSigning(contents) {
  const { contents: withSigning, injected } = injectSigningConfig(contents);
  // 签名配置未注入（模板不匹配）时不加 guard：避免破坏无 keystore 机器的日常任务
  if (!injected) return withSigning;
  return injectSigningGuard(withSigning);
}

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language === 'groovy') {
      mod.modResults.contents = applyReleaseSigning(mod.modResults.contents);
    } else {
      console.warn('withReleaseSigning: app/build.gradle 非 Groovy DSL，未注入 release 签名');
    }
    return mod;
  });

module.exports = withReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
module.exports.PROPS_FILE = PROPS_FILE;
