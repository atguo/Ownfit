// M6 批次 1 补充回归：自动天气编排（打开 APP 自动定位+查天气，2026-11-03 项目用户确认）。
// 覆盖：成功链写 context、新鲜节流（ran=false）、超龄/跨日重查、定位失败不写天气、
// 天气失败只写城市、并发防重入、force 绕过节流。location/weather/demoStore 全部注入假实现。
// 运行：仓库根 `node --test mobile/tests/weatherAuto.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SRC = path.resolve(__dirname, '../src');

function createDemoStub(initial) {
  let ctx = { ...initial };
  let setCalls = [];
  return {
    stub: {
      getContextSnapshot: () => ({ ...ctx }),
      // 与生产 demoStore 同语义：用户改动递增 conditionRevision；internal（自动编排）不递增
      setContext(change, options = {}) {
        const base = ctx.conditionRevision ?? 0;
        const revision = options.internal ? base : base + 1;
        ctx = { ...ctx, ...change, conditionRevision: revision };
        setCalls.push({ ...change, internal: !!options.internal });
      },
    },
    ctx: () => ({ ...ctx }),
    setCalls,
    setCtx(next) {
      ctx = { ...ctx, ...next };
    },
  };
}

const SNAPSHOT = {
  tempRange: '12–19℃',
  minC: 12,
  maxC: 19,
  description: '多云',
  weatherCode: 2,
  fetchedAt: '2026-11-03T04:00:00.000Z',
};

/** 注入 location/weather/demoStore 假实现，加载 weatherAuto.ts */
function loadAuto({ locate, weather, demo }) {
  const file = path.join(SRC, 'features/weatherAuto.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module,
    exports: module.exports,
    console,
    Date,
    require(id) {
      if (id === './demoStore') return demo;
      if (id === '../services/location') return { locateCity: locate, LocatedPlace: {} };
      if (id === '../services/weather') return { fetchTodayWeatherByCoords: weather };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return module.exports;
}

function baseHarness({ locateOk = true, weatherOk = true, initialContext } = {}) {
  const counts = { locateCalls: 0, weatherCalls: 0 };
  const place = { label: '杭州市', lat: 30.1235, lon: 120.6543, resolved: true };
  const locateImpl = async () => {
    counts.locateCalls += 1;
    return locateOk
      ? { ok: true, place }
      : { ok: false, kind: 'denied', message: '未获得定位权限，可手动填写城市' };
  };
  const weatherImpl = async () => {
    counts.weatherCalls += 1;
    return weatherOk
      ? { ok: true, snapshot: { ...SNAPSHOT, fetchedAt: new Date().toISOString() } }
      : { ok: false, kind: 'network', message: '网络失败：断网' };
  };
  const demo = createDemoStub(initialContext ?? {
    city: '北京', day: '今天', scene: '日常通勤', temp: '18–24℃',
    weatherDesc: '晴间多云（演示）', tempSource: 'demo',
  });
  const auto = loadAuto({ locate: locateImpl, weather: weatherImpl, demo: demo.stub });
  return { auto, demo, counts, place };
}

test('启动刷新成功：context 写入实时天气与城市', async () => {
  const { auto, demo } = baseHarness();
  const result = await auto.refreshCurrentWeather();
  assert.equal(result.ran, true);
  assert.equal(result.place.label, '杭州市');
  assert.equal(result.weather.description, '多云');
  const ctx = demo.ctx();
  assert.equal(ctx.tempSource, 'real');
  assert.equal(ctx.city, '杭州市');
  assert.equal(ctx.temp, '12–19℃');
  assert.ok(ctx.weatherFetchedAt, '获取时间应写入 context');
});

test('节流：已有新鲜实时天气（2 小时内且未跨日）→ ran=false，不定位不请求', async () => {
  const { auto, counts } = baseHarness({
    initialContext: {
      city: '上海市', day: '今天', scene: '通勤', temp: '10–15℃',
      weatherDesc: '小雨', tempSource: 'real', weatherFetchedAt: new Date().toISOString(),
    },
  });
  const result = await auto.refreshCurrentWeather();
  assert.equal(result.ran, false);
  assert.equal(counts.locateCalls, 0);
  assert.equal(counts.weatherCalls, 0);
});

test('获取时间超过 2 小时 → 视为过期重新查询', async () => {
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { auto, counts, demo } = baseHarness({
    initialContext: {
      city: '上海市', day: '今天', scene: '通勤', temp: '10–15℃',
      weatherDesc: '小雨', tempSource: 'real', weatherFetchedAt: stale,
    },
  });
  const result = await auto.refreshCurrentWeather();
  assert.equal(result.ran, true);
  assert.equal(counts.locateCalls, 1);
  assert.equal(demo.ctx().city, '杭州市');
});

test('获取时间是昨天（跨日）→ 过期重新查询', async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { auto, counts } = baseHarness({
    initialContext: {
      city: '上海市', day: '今天', scene: '通勤', temp: '10–15℃',
      weatherDesc: '小雨', tempSource: 'real', weatherFetchedAt: yesterday,
    },
  });
  const result = await auto.refreshCurrentWeather();
  assert.equal(result.ran, true);
  assert.equal(counts.locateCalls, 1);
});

test('force=true 绕过节流', async () => {
  const { auto, counts } = baseHarness({
    initialContext: {
      city: '上海市', day: '今天', scene: '通勤', temp: '10–15℃',
      weatherDesc: '小雨', tempSource: 'real', weatherFetchedAt: new Date().toISOString(),
    },
  });
  const result = await auto.refreshCurrentWeather({ force: true });
  assert.equal(result.ran, true);
  assert.equal(counts.locateCalls, 1);
});

test('定位失败：不写任何天气到 context，返回手动指引', async () => {
  const { auto, demo } = baseHarness({ locateOk: false });
  const result = await auto.refreshCurrentWeather({ force: true });
  assert.equal(result.ran, true);
  assert.equal(result.place, null);
  assert.match(result.locateMessage, /手动填写/);
  assert.equal(demo.setCalls.length, 0, '定位失败不得改写 context');
});

test('天气失败：城市写回（可核对），温度保持现状不伪造', async () => {
  const { auto, demo } = baseHarness({ weatherOk: false });
  const result = await auto.refreshCurrentWeather({ force: true });
  assert.equal(result.ran, true);
  assert.equal(result.weather, null);
  assert.match(result.weatherMessage, /手动填写温度/);
  assert.equal(demo.ctx().city, '杭州市');
  assert.equal(demo.ctx().tempSource, 'demo', '温度来源不得变成 real');
});

test('并发防重入：同时多次调用只执行一次定位与请求', async () => {
  const harness = baseHarness();
  const { auto, counts } = harness;
  const [a, b] = await Promise.all([auto.refreshCurrentWeather(), auto.refreshCurrentWeather()]);
  assert.equal(counts.locateCalls, 1, '并发共享同一次执行');
  assert.equal(a.ran, true);
  assert.equal(b.ran, true);
});

// R6（2026-11-04）：天气绑定正确性——日期/城市/有效期

test('R6：查看「明天」时自动天气只写城市，不把今日温度冒充明天', async () => {
  const { auto, demo } = baseHarness({
    initialContext: {
      city: '上海市', day: '明天', scene: '外出', temp: '8–12℃',
      weatherDesc: '手动填写', tempSource: 'manual',
    },
  });
  const result = await auto.refreshCurrentWeather({ force: true });
  assert.equal(result.ran, true);
  const ctx = demo.ctx();
  assert.equal(ctx.city, '杭州市', '城市写回供核对');
  assert.equal(ctx.temp, '8–12℃', '手动温度保持现状');
  assert.equal(ctx.tempSource, 'manual', '今日预报不得写成明天的实时温度');
  assert.match(result.weatherMessage, /手动填写/);
});

test('R6：城市变化且天气失败时不再保留旧城市的实时温度（回退占位）', async () => {
  const { auto, demo } = baseHarness({
    weatherOk: false,
    initialContext: {
      city: '上海市', day: '今天', scene: '通勤', temp: '10–15℃',
      weatherDesc: '小雨', tempSource: 'real', weatherFetchedAt: new Date().toISOString(),
    },
  });
  const result = await auto.refreshCurrentWeather({ force: true });
  const ctx = demo.ctx();
  assert.equal(ctx.city, '杭州市');
  assert.equal(ctx.tempSource, 'demo', '旧城市的实时温度不得继续展示');
  assert.match(result.weatherMessage, /手动填写温度/);
});

test('R6：过期实时天气刷新失败 → 降级占位，不继续标 real', async () => {
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { auto, demo } = baseHarness({
    weatherOk: false,
    initialContext: {
      city: '杭州市', day: '今天', scene: '通勤', temp: '10–15℃',
      weatherDesc: '小雨', tempSource: 'real', weatherFetchedAt: stale,
    },
  });
  const result = await auto.refreshCurrentWeather();
  const ctx = demo.ctx();
  assert.equal(ctx.city, '杭州市');
  assert.equal(ctx.tempSource, 'demo', '过期且刷新失败不得保持 real 来源');
});

// ---------------------------------------------------------------------------
// F4（2026-11-04，评估 §8.6）：天气按目标日期与请求版本条件写回
// ---------------------------------------------------------------------------

/** F4 专用 harness：定位即时返回；defer=true 时天气请求由测试手动放行（可控 Promise），
 * 否则立即返回（用 weatherCalls 区分第几次请求） */
function f4Harness({ initialContext, defer = false } = {}) {
  const counts = { locateCalls: 0, weatherCalls: 0 };
  const place = { label: '杭州市', lat: 30.1235, lon: 120.6543, resolved: true };
  const locateImpl = async () => {
    counts.locateCalls += 1;
    return { ok: true, place };
  };
  let releaseWeather = null;
  const weatherImpl = async () => {
    counts.weatherCalls += 1;
    const index = counts.weatherCalls;
    if (defer) {
      await new Promise((resolve) => {
        releaseWeather = resolve;
      });
    }
    return {
      ok: true,
      snapshot: {
        tempRange: `1${index}–19℃`,
        minC: 10,
        maxC: 19,
        description: index === 1 ? '第一请求' : '第二请求',
        weatherCode: 2,
        fetchedAt: new Date().toISOString(),
      },
    };
  };
  const demo = createDemoStub(
    initialContext ?? {
      city: '北京', day: '今天', scene: '日常通勤', temp: '18–24℃',
      weatherDesc: '晴间多云（演示）', tempSource: 'demo',
    },
  );
  const auto = loadAuto({ locate: locateImpl, weather: weatherImpl, demo: demo.stub });
  return {
    auto,
    demo,
    counts,
    release: () => releaseWeather?.(),
  };
}

test('F4：成功写回绑定目标日期与归属地点，且为内部更新（不递增条件版本）', async () => {
  const { auto, demo } = f4Harness();
  const revisionBefore = demo.ctx().conditionRevision ?? 0;
  const result = await auto.refreshCurrentWeather({ force: true });
  assert.equal(result.ran, true);
  const ctx = demo.ctx();
  assert.equal(ctx.tempSource, 'real');
  assert.equal(ctx.weatherPlace, '杭州市');
  assert.match(ctx.weatherTargetDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(ctx.conditionRevision, revisionBefore, '自动写回不得递增条件版本');
});

test('F4：请求期间切到「明天」→ 迟到响应整体丢弃，不写温度也不改城市', async () => {
  const { auto, demo, release } = f4Harness({ defer: true });
  const pending = auto.refreshCurrentWeather({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // 用户操作：切到明天（版本递增）
  demo.stub.setContext({ day: '明天' });
  release();
  const result = await pending;
  const ctx = demo.ctx();
  assert.equal(ctx.day, '明天');
  assert.equal(ctx.city, '北京', '旧请求不得改写用户已改的城市/日期');
  assert.equal(ctx.tempSource, 'demo', '今日预报不得在切到明天后写入');
  assert.match(result.weatherMessage, /没有写入/);
});

test('F4：请求期间手动改城市 → 迟到响应作废，用户条件优先', async () => {
  const { auto, demo, release } = f4Harness({ defer: true });
  const pending = auto.refreshCurrentWeather({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  demo.stub.setContext({ city: '广州', temp: '25℃', tempSource: 'manual' });
  release();
  await pending;
  const ctx = demo.ctx();
  assert.equal(ctx.city, '广州', '用户手动城市必须优先');
  assert.equal(ctx.tempSource, 'manual', '手动值不得被迟到的自动结果覆盖');
  assert.equal(ctx.weatherPlace, undefined, '自动结果未写入（weatherPlace 不出现）');
});

test('F4：目标日期为昨天（跨日）的实时天气 → 节流失效，重新查询', async () => {
  const { auto, counts } = f4Harness({
    initialContext: {
      city: '上海市', day: '今天', scene: '通勤', temp: '10–15℃',
      weatherDesc: '小雨', tempSource: 'real', weatherFetchedAt: new Date().toISOString(),
      weatherTargetDate: '2026-11-03', weatherPlace: '上海市', conditionRevision: 0,
    },
  });
  const result = await auto.refreshCurrentWeather();
  assert.equal(result.ran, true, '跨日的实时天气按目标日期判定过期');
  assert.equal(counts.locateCalls, 1);
});

test('F4：在途请求期间 force → 排跟进执行，最终结果来自最新条件', async () => {
  const { auto, demo, counts, release } = f4Harness({ defer: true });
  const first = auto.refreshCurrentWeather({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = auto.refreshCurrentWeather({ force: true }); // force：不与在途共享
  release(); // 放行第一请求
  const firstResult = await first;
  assert.equal(firstResult.ran, true);
  await new Promise((resolve) => setTimeout(resolve, 10)); // 跟进执行发起第二请求
  release(); // 放行第二请求
  const secondResult = await second;
  assert.equal(secondResult.ran, true);
  assert.equal(counts.locateCalls, 2, 'force 在途触发跟进执行');
  const ctx = demo.ctx();
  assert.equal(ctx.weatherDesc, '第二请求', '最终 context 来自最新一次执行');
  assert.equal(ctx.city, '杭州市');
});
