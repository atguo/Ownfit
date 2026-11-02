// M5 轨 C 回归：自动天气服务（open-meteo 假客户端）。
// 覆盖：geocoding 命中/未命中、forecast 映射、WMO 描述、超时/网络/服务错误分类、失败不伪造。
// 运行：仓库根 `node --test mobile/tests/weather.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SRC = path.resolve(__dirname, '../src');

function loadWeatherModule(fetchImpl) {
  const file = path.join(SRC, 'services/weather.ts');
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
  });
  return module.exports;
}

const jsonResponse = (value) => async () => ({
  ok: true,
  status: 200,
  json: async () => value,
});

const geoHit = jsonResponse({
  results: [{ latitude: 30.25, longitude: 120.17, name: '杭州', admin1: '浙江省' }],
});
const forecastHit = jsonResponse({
  daily: { temperature_2m_max: [19.4], temperature_2m_min: [11.6], weather_code: [2] },
});

test('查实时天气：城市命中 + 预报映射 + WMO 描述与温度摘要', async () => {
  let called = 0;
  const api = loadWeatherModule(async (url) => {
    called += 1;
    return String(url).includes('geocoding') ? geoHit() : forecastHit();
  });
  const result = await api.fetchTodayWeather('杭州');
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.tempRange, '12–19℃');
  assert.equal(result.snapshot.description, '多云');
  assert.equal(result.snapshot.minC, 11.6);
  assert.equal(result.snapshot.maxC, 19.4);
  assert.ok(result.snapshot.fetchedAt);
  assert.equal(called, 2, 'geocoding + forecast 各一次');
});

test('城市未命中：city_not_found，提示可手动填写', async () => {
  const api = loadWeatherModule(async () => jsonResponse({ results: [] })());
  const result = await api.fetchTodayWeather('不存在的城市');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'city_not_found');
  assert.equal(result.message.includes('手动填写'), true);
});

test('空城市名直接拒绝，不发网络请求', async () => {
  let called = 0;
  const api = loadWeatherModule(async () => {
    called += 1;
    return geoHit();
  });
  const result = await api.fetchTodayWeather('  ');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'city_not_found');
  assert.equal(called, 0);
});

test('网络失败与超时：分类返回，不伪造预报', async () => {
  const netFail = loadWeatherModule(async () => {
    throw new Error('connection refused');
  });
  const network = await netFail.fetchTodayWeather('杭州');
  assert.equal(network.ok, false);
  assert.equal(network.kind, 'network');

  const timeoutApi = loadWeatherModule((_url, init) =>
    new Promise((_resolve, reject) => {
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  );
  const timeout = await timeoutApi.fetchTodayWeather('杭州');
  assert.equal(timeout.ok, false);
  assert.equal(timeout.kind, 'timeout');
});

test('预报缺温度数据：no_data 如实返回', async () => {
  const api = loadWeatherModule(async (url) =>
    String(url).includes('geocoding') ? geoHit() : jsonResponse({ daily: {} })(),
  );
  const result = await api.fetchTodayWeather('杭州');
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'no_data');
});

test('WMO 描述映射：未知码不崩溃，给“未知天气”', async () => {
  const api = loadWeatherModule(async (url) =>
    String(url).includes('geocoding')
      ? geoHit()
      : jsonResponse({ daily: { temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [1234] } })(),
  );
  const result = await api.fetchTodayWeather('杭州');
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.description, '未知天气');
  assert.equal(result.snapshot.weatherCode, 1234);
});
