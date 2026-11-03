// M6 批次 1 补充回归：手机定位服务（天气文档 §2"授权位置或手动选择"）。
// 覆盖：权限分支（已授予/拒绝不重复弹）、系统定位开关、平台逆地理 → 免 Key 解析 → "当前位置"降级链、
// 坐标降精度（4 位小数）。expo-location 与 fetch 全部注入假实现，不触真实定位与网络。
// 运行：仓库根 `node --test mobile/tests/location.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SRC = path.resolve(__dirname, '../src');

/** 注入 expo-location 与 fetch 假实现，加载 location.ts */
function loadLocation({ expoLocation, fetchImpl }) {
  const file = path.join(SRC, 'services/location.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module,
    exports: module.exports,
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    Error,
    fetch: fetchImpl,
    require(id) {
      if (id === 'expo-location') return expoLocation;
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return module.exports;
}

const granted = { granted: true, canAskAgain: true };
const denied = { granted: false, canAskAgain: false };
const undetermined = { granted: false, canAskAgain: true };

const fixAt = (lat, lon) => ({ coords: { latitude: lat, longitude: lon } });

/** 基础 expo-location 假实现：权限/开关/定位结果可覆盖 */
function baseExpo(over = {}) {
  return {
    getForegroundPermissionsAsync: async () => granted,
    requestForegroundPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
    hasServicesEnabledAsync: async () => true,
    getCurrentPositionAsync: async () => fixAt(30.123456, 120.654321),
    reverseGeocodeAsync: async () => [],
    Accuracy: { Balanced: 4 },
    ...over,
  };
}

const serviceHit = (city) => async (url) => ({
  ok: true,
  status: 200,
  json: async () => (String(url).includes('bigdatacloud') ? { city, locality: '备选' } : {}),
});

test('定位主链路：平台逆地理可用 → 直接采用，坐标降为 4 位小数', async () => {
  const expo = baseExpo({
    reverseGeocodeAsync: async () => [{ city: '杭州市', district: '西湖区', region: '浙江省' }],
  });
  const api = loadLocation({ expoLocation: expo, fetchImpl: async () => { throw new Error('不应调用解析服务'); } });
  const result = await api.locateCity(true);
  assert.equal(result.ok, true);
  assert.equal(result.place.label, '杭州市');
  assert.equal(result.place.lat, 30.1235);
  assert.equal(result.place.lon, 120.6543);
  assert.equal(result.place.resolved, true);
});

test('平台逆地理为空（无 GMS 常见）→ 免 Key 服务解析城市名', async () => {
  const api = loadLocation({
    expoLocation: baseExpo(),
    fetchImpl: serviceHit('嘉兴市'),
  });
  const result = await api.locateCity(true);
  assert.equal(result.ok, true);
  assert.equal(result.place.label, '嘉兴市');
  assert.equal(result.place.resolved, true);
});

test('两级解析都失败 → "当前位置"占位（天气按坐标查），不伪造城市名', async () => {
  const api = loadLocation({
    expoLocation: baseExpo(),
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const result = await api.locateCity(true);
  assert.equal(result.ok, true);
  assert.equal(result.place.label, '当前位置');
  assert.equal(result.place.resolved, false);
  assert.equal(result.place.lat, 30.1235);
});

test('权限拒绝且不可再问：不弹授权、不定位，返回 denied + 手动指引', async () => {
  let requested = 0;
  const expo = baseExpo({
    getForegroundPermissionsAsync: async () => denied,
    requestForegroundPermissionsAsync: async () => {
      requested += 1;
      return { granted: false, canAskAgain: false };
    },
  });
  const api = loadLocation({ expoLocation: expo, fetchImpl: async () => { throw new Error('不应调用'); } });
  const result = await api.locateCity(true);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'denied');
  assert.match(result.message, /手动填写/);
  assert.equal(requested, 0, '不可再问时不得重复弹授权');
});

test('权限未决定：弹一次授权；同意后继续定位；拒绝则 denied', async () => {
  let requested = 0;
  const expo = baseExpo({
    getForegroundPermissionsAsync: async () => undetermined,
    requestForegroundPermissionsAsync: async () => {
      requested += 1;
      return { granted: true, canAskAgain: true };
    },
  });
  const okApi = loadLocation({ expoLocation: expo, fetchImpl: serviceHit('杭州市') });
  const ok = await okApi.locateCity(true);
  assert.equal(ok.ok, true);
  assert.equal(requested, 1);

  const expoDenied = baseExpo({
    getForegroundPermissionsAsync: async () => undetermined,
    requestForegroundPermissionsAsync: async () => ({ granted: false, canAskAgain: false }),
  });
  const deniedApi = loadLocation({ expoLocation: expoDenied, fetchImpl: async () => { throw new Error('不应调用'); } });
  const deniedResult = await deniedApi.locateCity(true);
  assert.equal(deniedResult.ok, false);
  assert.equal(deniedResult.kind, 'denied');
});

test('系统定位服务关闭 → unavailable；定位超时 → timeout，均提示手动', async () => {
  const offApi = loadLocation({
    expoLocation: baseExpo({ hasServicesEnabledAsync: async () => false }),
    fetchImpl: async () => { throw new Error('不应调用'); },
  });
  const off = await offApi.locateCity(true);
  assert.equal(off.ok, false);
  assert.equal(off.kind, 'unavailable');

  const hangApi = loadLocation({
    expoLocation: baseExpo({
      getCurrentPositionAsync: () => new Promise(() => {}),
    }),
    fetchImpl: async () => { throw new Error('不应调用'); },
  });
  const timeout = await hangApi.locateCity(true);
  assert.equal(timeout.ok, false);
  assert.equal(timeout.kind, 'timeout');
});
