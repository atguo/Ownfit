// M6 批次 3：release 正式签名接入（2026-11-03 项目用户确认生成正式 keystore）。
// keystore 与密码不入库：mobile/keystores/keystore.properties（git 忽略）提供
// storeFile / storePassword / keyAlias / keyPassword 四项（路径建议绝对路径正斜杠）。
// properties 文件缺失时 release 退回 debug 签名，保证无 keystore 的机器仍可构建；
// 内测分发包必须确认以正式签名构建（验签步骤见 keystores/README.md）。
// 经 expo prebuild 注入 android/app/build.gradle（该目录整体重建，不能手改），重复 prebuild 幂等。
const { withAppBuildGradle } = require('expo/config-plugins');

const SIGNING_MARKER = 'ownfitReleaseSigning';
const PROPS_FILE = '../../keystores/keystore.properties';

function applyReleaseSigning(contents) {
  if (contents.includes(SIGNING_MARKER)) return contents; // 幂等
  const buildTypesIdx = contents.indexOf('buildTypes {');
  if (buildTypesIdx === -1) {
    console.warn('withReleaseSigning: build.gradle 中未找到 buildTypes，未注入 release 签名（模板变化需人工核对）');
    return contents;
  }
  const configBlock = [
    '        // release 正式签名（withReleaseSigning 插件注入；keystore 与密码不入库）',
    `        def keystorePropsFile = rootProject.file("${PROPS_FILE}")`,
    `        def ${SIGNING_MARKER} = signingConfigs.debug`,
    '        if (keystorePropsFile.exists()) {',
    '            def keystoreProps = new Properties()',
    '            keystorePropsFile.withInputStream { keystoreProps.load(it) }',
    `            ${SIGNING_MARKER} = signingConfigs.create("ownfitRelease") {`,
    "                storeFile file(keystoreProps['storeFile'])",
    "                storePassword keystoreProps['storePassword']",
    "                keyAlias keystoreProps['keyAlias']",
    "                keyPassword keystoreProps['keyPassword']",
    '            }',
    '        }',
    '',
    '',
  ].join('\n');
  const patched = contents.slice(0, buildTypesIdx) + configBlock + contents.slice(buildTypesIdx);

  // 仅替换 release 块内的 signingConfig（debug 块保持 debug 签名不变）
  const releaseIdx = patched.indexOf('release {', buildTypesIdx);
  if (releaseIdx === -1) {
    console.warn('withReleaseSigning: 未找到 release 块，release 仍用 debug 签名（模板变化需人工核对）');
    return patched;
  }
  const debugSigning = 'signingConfig signingConfigs.debug';
  const signIdx = patched.indexOf(debugSigning, releaseIdx);
  if (signIdx === -1) {
    console.warn('withReleaseSigning: release 块内未找到 debug 签名声明，未注入正式签名（模板变化需人工核对）');
    return patched;
  }
  return patched.slice(0, signIdx) + `signingConfig ${SIGNING_MARKER}` + patched.slice(signIdx + debugSigning.length);
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
