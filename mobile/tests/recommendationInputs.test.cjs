// 推荐输入与采用语义回归（M6 批次 1.2 + S1 评估 §8.2，2026-11-04）。
// - loadSceneSnapshot 读当次 context（演示温度不进 AI；实时/手动温度带来源）
// - 入队持久化 RecommendationInputV2 快照（实际发送档案 + 真实 ID/别名/版本 + 锁定 + 基线），
//   执行器按快照发送与校验，不按当前衣橱重建映射（F2 别名漂移回归）
// - 局部替换（F8）：候选只允许目标槽位变化；采用读取快照复核会话，不把旧候选覆盖新编辑
// 使用内存 SQLite 与真实 store/runner/service/仓库代码；不调用真实模型。
// 运行：仓库根 `node --test mobile/tests/recommendationInputs.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const { createMemoryAdapter, loadDbModule } = require('./analysisMigration.test.cjs');

const nodeRequire = require;
const SRC = path.resolve(__dirname, '../src');
const CONTRACT_ENTRY = path.resolve(__dirname, '../../packages/contract/src/index.ts');

/** 无副作用的前端/原生依赖 stub（测试不触碰真实文件与设备） */
const expoStubs = {
  'expo-sqlite': {},
  'expo-secure-store': {},
  'expo-crypto': {},
  'expo-file-system/legacy': {}, // maintenanceRepository 引入；stub 防止落到真实 ESM 包
  'expo-image-manipulator': {
    SaveFormat: { JPEG: 'jpeg' },
    ImageManipulator: {
      manipulate: () => ({
        resize: () => ({ renderAsync: async () => ({ saveAsync: async () => ({ uri: '' }) }) }),
        renderAsync: async () => ({ saveAsync: async () => ({ uri: '' }) }),
      }),
    },
  },
  'expo-file-system': {
    Paths: { document: { uri: 'file:///document' } },
    Directory: class {
      get exists() {
        return false;
      }
    },
    File: class {
      get exists() {
        return false;
      }
      textSync() {
        return '[]';
      }
      writeSync() {}
      delete() {}
    },
  },
};

/** 把 vm 上下文里创建的对象转为普通对象，便于 deepEqual（跨 realm 原型不同） */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveModule(candidate) {
  for (const suffix of ['.ts', '.tsx', '/index.ts', '']) {
    const file = candidate + suffix;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  throw new Error(`cannot resolve module: ${candidate}`);
}

/** 极简 CommonJS 加载器：transpile + 缓存；data/db 指向内存适配器；overrides 按解析后路径替换 */
function createLoader(adapter, overrides = {}) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const source = fs.readFileSync(filename, 'utf8');
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
    const module = { exports: {} };
    cache.set(filename, module.exports);
    const dir = path.dirname(filename);
    vm.runInNewContext(js, {
      module,
      exports: module.exports,
      console,
      AbortController,
      // 执行器看门狗用 90 秒真实定时器：测试里替换为永不触发的假定时器，
      // 避免用例被看门狗拖住或进程存活 90 秒（execute 的 Promise.race 由真实完成路径解决）
      setTimeout: () => 0,
      clearTimeout: () => {},
      Error,
      require(id) {
        if (id in expoStubs) return expoStubs[id];
        if (id === '@ownfit/contract') return load(CONTRACT_ENTRY);
        if (id.startsWith('.')) {
          const resolved = resolveModule(path.resolve(dir, id));
          if (resolved in overrides) return overrides[resolved];
          if (resolved === path.join(SRC, 'data', 'db.ts')) {
            return { ...loadDbModule(), getDb: async () => adapter };
          }
          return load(resolved);
        }
        return nodeRequire(id);
      },
    });
    cache.set(filename, module.exports);
    return module.exports;
  }
  return { load };
}

/** 可控当次 context stub（替代 demoStore 的 react 绑定） */
function createDemoStoreStub(initial) {
  let ctx = { ...initial };
  return {
    stub: {
      getContextSnapshot: () => ({ ...ctx }),
      setContext(change) {
        ctx = { ...ctx, ...change };
      },
    },
    set(change) {
      ctx = { ...ctx, ...change };
    },
    get: () => ({ ...ctx }),
  };
}

const DEMO_CONTEXT = {
  city: '北京',
  day: '明天',
  scene: '约会',
  temp: '18–24℃',
  weatherDesc: '晴间多云（演示）',
  tempSource: 'demo',
};

async function freshDb() {
  const { db, adapter, close } = createMemoryAdapter();
  const { runMigrations } = loadDbModule();
  await runMigrations(adapter);
  return { db, adapter, close };
}

function seedItem(db, id, category, revision = 1) {
  db.prepare(
    "INSERT INTO items (id, status, category, source_type, revision, created_at, updated_at) VALUES (?, 'active', ?, 'photo', ?, 't0', 't0')",
  ).run(id, category, revision);
}

const CONFIGS = [
  {
    id: 'cfg-1',
    name: '文本模型',
    urlKind: 'openai',
    baseUrl: 'https://example.test',
    modelId: 'm-1',
    capabilities: ['text'],
    keyRef: 'k1',
    hasKey: true,
    testStatus: 'untested',
    callRevision: 'rev-1',
    createdAt: 't0',
    updatedAt: 't0',
  },
];

/** store + 仓库直连 adapter；runner 用捕获桩（执行器行为另有专项测试） */
async function loadStore() {
  const { db, adapter, close } = await freshDb();
  const demo = createDemoStoreStub(DEMO_CONTEXT);
  const runnerCalls = { init: 0 };
  const loader = createLoader(adapter, {
    [path.join(SRC, 'features', 'demoStore.ts')]: demo.stub,
    [path.join(SRC, 'services', 'ai', 'configStore.ts')]: {
      getConfig: (id) => CONFIGS.find((c) => c.id === id),
      getApiKey: async () => 'sk-test',
    },
    [path.join(SRC, 'services', 'ai', 'recommendationTaskRunner.ts')]: {
      createRecommendationTaskRunner: (deps) => {
        runnerCalls.init += 1;
        runnerCalls.deps = deps;
        return { start() {}, setForeground() {}, recover: async () => {}, handleExternalChange: async () => {} };
      },
    },
  });
  const store = loader.load(path.join(SRC, 'features', 'recommendationStore.ts'));
  return { db, close, store, demo, runnerCalls };
}

/** 全链路装载：真实 store + 真实执行器 + 内存库 + chat 捕获桩（F2/F8 端到端回归用） */
async function loadPipeline(chatStub) {
  const { db, adapter, close } = await freshDb();
  const demo = createDemoStoreStub(DEMO_CONTEXT);
  const loader = createLoader(adapter, {
    [path.join(SRC, 'features', 'demoStore.ts')]: demo.stub,
    [path.join(SRC, 'services', 'ai', 'configStore.ts')]: {
      getConfig: (id) => CONFIGS.find((c) => c.id === id),
      getApiKey: async () => 'sk-test',
    },
    [path.join(SRC, 'services', 'ai', 'openaiClient.ts')]: { chatCompletion: chatStub },
  });
  const store = loader.load(path.join(SRC, 'features', 'recommendationStore.ts'));
  const runner = store.initRecommendationRunner();
  return { db, adapter, close, store, runner, demo };
}

/** 轮询任务直到落终态（执行器异步循环） */
async function waitForTerminal(db, taskId, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const row = db.prepare('SELECT status, error_kind, error_summary FROM tasks WHERE id = ?').get(taskId);
    if (
      row &&
      !['queued', 'running'].includes(row.status)
    ) {
      return row;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`任务未落终态：${JSON.stringify(row)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('当次场景快照：演示温度不进输入；实时/手动温度带来源', async () => {
  const { close, store, demo } = await loadStore();
  try {
    const snapshot = await store.loadSceneSnapshot();
    assert.deepEqual(plain(snapshot), { city: '北京', day: '明天', scene: '约会' });

    demo.set({
      tempSource: 'real',
      temp: '10–15℃',
      weatherDesc: '小雨',
      weatherFetchedAt: new Date().toISOString(),
      weatherTargetDate: '2026-11-04',
      weatherPlace: '北京',
    });
    const realSnapshot = await store.loadSceneSnapshot();
    assert.equal(realSnapshot.temp, '10–15℃');
    assert.equal(realSnapshot.tempSource, 'real');
    assert.equal(realSnapshot.weatherDesc, '小雨'); // B6：实时天气描述随场景进输入（参与选择）

    demo.set({ tempSource: 'manual', temp: '20℃' });
    const manual = await store.loadSceneSnapshot();
    assert.equal(manual.temp, '20℃');
    assert.equal(manual.tempSource, 'manual');
  } finally {
    close();
  }
});

test('当次场景快照（F4）：错位/过期的实时温度不进推荐输入', async () => {
  const { close, store, demo } = await loadStore();
  try {
    const now = new Date('2026-11-04T10:00:00');
    const pad = (n) => String(n).padStart(2, '0');
    const today = '2026-11-04';
    // 地点错位：天气归属地 ≠ 当次城市
    demo.set({
      tempSource: 'real',
      temp: '10–15℃',
      weatherDesc: '小雨',
      weatherFetchedAt: now.toISOString(),
      weatherTargetDate: today,
      weatherPlace: '上海',
    });
    demo.set({ city: '北京' });
    assert.equal(store.isRealWeatherUsable({ ...demo.get(), now }), false);
    assert.deepEqual(plain(await store.loadSceneSnapshot()), { city: '北京', day: '明天', scene: '约会' });

    // 地点匹配但目标日期是昨天（跨日过期）
    demo.set({ city: '北京', weatherPlace: '北京', weatherTargetDate: '2026-11-03' });
    assert.equal(store.isRealWeatherUsable({ ...demo.get(), now }), false);

    // 地点/日期匹配且新鲜 → 可用
    demo.set({ weatherTargetDate: today });
    assert.equal(store.isRealWeatherUsable({ ...demo.get(), now }), true);

    // 长期前台停留：获取时间超过 2 小时 → 过期
    demo.set({
      weatherFetchedAt: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(store.isRealWeatherUsable({ ...demo.get(), now }), false);

    // 手动值属于当前条件，不受时效限制
    demo.set({ tempSource: 'manual', temp: '20℃' });
    const manual = await store.loadSceneSnapshot();
    assert.equal(manual.temp, '20℃');
  } finally {
    close();
  }
});

test('入队（S1/V2）：真实 ID 快照与指纹持久化；同输入去重', async () => {
  const { db, close, store } = await loadStore();
  try {
    seedItem(db, 'item-real-1', '上衣');
    seedItem(db, 'item-real-2', '下装');
    seedItem(db, 'item-real-3', '鞋履');
    const result = await store.enqueueRecommendation({
      scene: { city: '北京', day: '今天', scene: '约会', temp: '10–15℃', tempSource: 'real' },
      lockedItemIds: ['item-real-2', 'item-not-exist'],
      configId: 'cfg-1',
    });
    assert.equal(result.status, 'created');

    const row = db
      .prepare("SELECT input_json, input_key FROM tasks WHERE kind = 'outfit_recommendation'")
      .get();
    const snapshot = JSON.parse(row.input_json);
    assert.equal(snapshot.inputVersion, 2);
    assert.deepEqual(snapshot.lockedRealIds, ['item-real-2']); // 真实 ID 全程保留；不在档案中的锁定项忽略
    assert.deepEqual(snapshot.scene, {
      city: '北京',
      day: '今天',
      scene: '约会',
      temp: '10–15℃',
      tempSource: 'real',
      targetDate: snapshot.scene.targetDate, // 具体日期入快照（跨日不重新解释）
    });
    assert.match(snapshot.scene.targetDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(snapshot.body, null); // 未填写身材资料
    assert.equal(snapshot.mode, 'full');
    assert.equal(snapshot.truncated, false);
    assert.deepEqual(
      snapshot.items.map((item) => [item.realId, item.alias]),
      [
        ['item-real-1', 'item-1'],
        ['item-real-2', 'item-2'],
        ['item-real-3', 'item-3'],
      ],
    );
    const inputKey = JSON.parse(row.input_key);
    assert.deepEqual(inputKey.lockedRealIds, ['item-real-2']);
    assert.equal(inputKey.body, null);
    assert.equal(inputKey.promptVersion, '5');

    const again = await store.enqueueRecommendation({
      scene: { city: '北京', day: '今天', scene: '约会', temp: '10–15℃', tempSource: 'real' },
      lockedItemIds: ['item-real-2'],
      configId: 'cfg-1',
    });
    assert.equal(again.status, 'existing');
  } finally {
    close();
  }
});

test('入队：身材资料进快照与指纹，数值变化视为新输入（M6 批次 2）', async () => {
  const { db, close, store } = await loadStore();
  try {
    seedItem(db, 'item-real-1', '上衣');
    seedItem(db, 'item-real-2', '下装');
    seedItem(db, 'item-real-3', '鞋履');
    db.prepare(
      "INSERT INTO preferences (id, value, source, created_at, updated_at) VALUES ('body-profile', ?, 'user_selected', 't0', 't0')",
    ).run('{"heightCm":170,"weightKg":60,"updatedAt":"t0"}');
    const scene = { city: '北京', day: '今天', scene: '约会' };

    const first = await store.enqueueRecommendation({ scene, configId: 'cfg-1' });
    assert.equal(first.status, 'created');
    const row = db
      .prepare("SELECT input_json, input_key FROM tasks WHERE kind = 'outfit_recommendation'")
      .get();
    assert.deepEqual(JSON.parse(row.input_json).body, { heightCm: 170, weightKg: 60 });
    assert.deepEqual(JSON.parse(row.input_key).body, { heightCm: 170, weightKg: 60 });

    // 身材变化 → 新输入，不与旧任务去重
    db.prepare("UPDATE preferences SET value = ? WHERE id = 'body-profile'").run(
      '{"heightCm":172,"updatedAt":"t1"}',
    );
    const second = await store.enqueueRecommendation({ scene, configId: 'cfg-1' });
    assert.equal(second.status, 'created');

    // 清除身材资料 → 又是另一种输入
    db.prepare("DELETE FROM preferences WHERE id = 'body-profile'").run();
    const third = await store.enqueueRecommendation({ scene, configId: 'cfg-1' });
    assert.equal(third.status, 'created');
  } finally {
    close();
  }
});

test('入队（F8）：局部替换记录目标槽位与基线；目标不同视为新输入', async () => {
  const { db, close, store } = await loadStore();
  try {
    seedItem(db, 'item-real-1', '上衣');
    seedItem(db, 'item-real-2', '下装');
    seedItem(db, 'item-real-3', '鞋履');
    const baseline = {
      slots: { top: 'item-real-1', bottom: 'item-real-2', shoes: 'item-real-3' },
      wear: '自然垂放',
      slotWear: { top: '前侧塞衣角' },
    };
    const scene = { city: '北京', day: '今天', scene: '约会' };
    const result = await store.enqueueRecommendation({
      scene,
      configId: 'cfg-1',
      lockedItemIds: ['item-real-1', 'item-real-2'],
      baseline,
      targetSlot: 'shoes',
    });
    assert.equal(result.status, 'created');
    const row = db.prepare("SELECT input_json, input_key FROM tasks WHERE id = ?").get(result.taskId);
    const snapshot = JSON.parse(row.input_json);
    assert.equal(snapshot.mode, 'replace_slot');
    assert.equal(snapshot.targetSlot, 'shoes');
    assert.deepEqual(snapshot.lockedRealIds, ['item-real-1', 'item-real-2']);
    assert.deepEqual(snapshot.baseline, baseline);

    // 目标槽位不同 → 新输入（允许变化范围参与指纹）
    const other = await store.enqueueRecommendation({
      scene,
      configId: 'cfg-1',
      lockedItemIds: ['item-real-1', 'item-real-2'],
      baseline,
      targetSlot: 'outer',
    });
    assert.equal(other.status, 'created');
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// F2 别名漂移回归：执行只依据入队快照，不按当前衣橱重建映射
// ---------------------------------------------------------------------------

const OK_CONTENT =
  '{"candidates":[{"slots":[{"role":"top","itemId":"item-1"},{"role":"bottom","itemId":"item-2"},{"role":"shoes","itemId":"item-3"}],"wearStyle":"自然垂放","reason":"同色系沉稳"}],"gaps":[]}';

test('F2：执行用快照档案与别名映射；归档快照内单品 → stale 保留原请求', async () => {
  let chatArg = null;
  const pipeline = await loadPipeline(async (_config, _key, messages) => {
    chatArg = messages;
    return { ok: true, content: OK_CONTENT };
  });
  const { db, store, runner, close } = pipeline;
  try {
    seedItem(db, 'item-real-1', '上衣');
    seedItem(db, 'item-real-2', '下装');
    seedItem(db, 'item-real-3', '鞋履');
    const enq = await store.enqueueRecommendation({
      scene: { city: '北京', day: '今天', scene: '约会' },
      lockedItemIds: ['item-real-2'],
      configId: 'cfg-1',
    });
    assert.equal(enq.status, 'created');

    runner.setForeground(true);
    const row = await waitForTerminal(db, enq.taskId);
    runner.setForeground(false);
    assert.equal(row.status, 'succeeded');
    // 提示词用快照别名（锁定 item-2=下装），日期带具体日期
    const userPrompt = chatArg[1].content;
    assert.match(userPrompt, /已锁定的单品（候选组合必须包含）：item-2/);
    assert.match(userPrompt, /日期=\d{4}-\d{2}-\d{2}（今天）/);
    // 候选已按快照映射回真实 ID
    const result = JSON.parse(db.prepare('SELECT result_json FROM tasks WHERE id = ?').get(enq.taskId).result_json);
    assert.deepEqual(
      plain(result.candidates[0].slots.map((s) => s.itemId)).sort(),
      ['item-real-1', 'item-real-2', 'item-real-3'],
    );

    // F2 复现路径：入队后归档 item-real-1（旧实现会把 item-2 重新解释成别的单品继续执行）
    seedItem(db, 'item-real-4', '外套', 1);
    const enq2 = await store.enqueueRecommendation({
      scene: { city: '北京', day: '今天', scene: '约会' },
      lockedItemIds: ['item-real-2'],
      configId: 'cfg-1',
    });
    db.prepare("UPDATE items SET status = 'archived' WHERE id = 'item-real-1'").run();
    chatArg = null;
    runner.setForeground(true);
    const row2 = await waitForTerminal(db, enq2.taskId);
    runner.setForeground(false);
    // 不静默舍弃锁定项后继续：整体标 stale，保留原请求供用户刷新
    assert.equal(row2.status, 'stale');
    assert.equal(row2.error_kind, 'input_changed');
    assert.match(row2.error_summary, /已删除或归档/);
    assert.equal(chatArg, null); // 未发送模型请求
  } finally {
    runner.setForeground(false);
    close();
  }
});

test('F2：快照内单品被改属性 → stale（版本不同不冒充当前资料）', async () => {
  const pipeline = await loadPipeline(async () => ({ ok: true, content: OK_CONTENT }));
  const { db, store, runner, close } = pipeline;
  try {
    seedItem(db, 'item-real-1', '上衣');
    seedItem(db, 'item-real-2', '下装');
    seedItem(db, 'item-real-3', '鞋履');
    const enq = await store.enqueueRecommendation({
      scene: { city: '北京', day: '今天', scene: '约会' },
      configId: 'cfg-1',
    });
    db.prepare("UPDATE items SET revision = 2 WHERE id = 'item-real-2'").run();
    runner.setForeground(true);
    const row = await waitForTerminal(db, enq.taskId);
    runner.setForeground(false);
    assert.equal(row.status, 'stale');
    assert.equal(row.error_kind, 'input_changed');
    assert.match(row.error_summary, /被修改/);
  } finally {
    runner.setForeground(false);
    close();
  }
});

test('历史兼容：旧格式 queued 请求标 stale，不自动重发', async () => {
  const pipeline = await loadPipeline(async () => {
    throw new Error('不应调用模型');
  });
  const { db, store, runner, close } = pipeline;
  try {
    seedItem(db, 'item-real-1', '上衣');
    seedItem(db, 'item-real-2', '下装');
    seedItem(db, 'item-real-3', '鞋履');
    const enq = await store.enqueueRecommendation({
      scene: { city: '北京', day: '今天', scene: '约会' },
      configId: 'cfg-1',
    });
    // 模拟旧版本任务：降级 input_json 为 V1 形状
    const row = db.prepare('SELECT input_json FROM tasks WHERE id = ?').get(enq.taskId);
    const legacy = JSON.parse(row.input_json);
    delete legacy.inputVersion;
    db.prepare('UPDATE tasks SET input_json = ? WHERE id = ?').run(JSON.stringify(legacy), enq.taskId);

    runner.setForeground(true);
    const done = await waitForTerminal(db, enq.taskId);
    runner.setForeground(false);
    assert.equal(done.status, 'stale');
    assert.equal(done.error_kind, 'legacy_input');
  } finally {
    runner.setForeground(false);
    close();
  }
});

// ---------------------------------------------------------------------------
// F8 局部替换：候选可变范围本地校验（只允许目标槽位变化）
// ---------------------------------------------------------------------------

function slotsJson(entries) {
  return JSON.stringify({
    candidates: [
      { slots: entries, wearStyle: '自然垂放', reason: '替换更轻便' },
    ],
    gaps: [],
  });
}

async function runReplaceSlot(content, lockedIds = ['item-real-1', 'item-real-2']) {
  const pipeline = await loadPipeline(async () => ({ ok: true, content }));
  const { db, store, runner, close } = pipeline;
  seedItem(db, 'item-real-1', '上衣');
  seedItem(db, 'item-real-2', '下装');
  seedItem(db, 'item-real-3', '鞋履');
  seedItem(db, 'item-real-4', '外套');
  seedItem(db, 'item-real-5', '鞋履');
  const enq = await store.enqueueRecommendation({
    scene: { city: '北京', day: '今天', scene: '约会' },
    configId: 'cfg-1',
    lockedItemIds: lockedIds,
    baseline: {
      slots: { top: 'item-real-1', bottom: 'item-real-2', shoes: 'item-real-3' },
      wear: '自然垂放',
      slotWear: {},
    },
    targetSlot: 'shoes',
  });
  runner.setForeground(true);
  const row = await waitForTerminal(db, enq.taskId);
  runner.setForeground(false);
  const resultRow = db.prepare('SELECT result_json FROM tasks WHERE id = ?').get(enq.taskId);
  close();
  return { row, result: resultRow?.result_json ? JSON.parse(resultRow.result_json) : null };
}

test('F8：只换目标槽位的候选通过，并回映真实 ID', async () => {
  const { row, result } = await runReplaceSlot(
    slotsJson([
      { role: 'top', itemId: 'item-1' },
      { role: 'bottom', itemId: 'item-2' },
      { role: 'shoes', itemId: 'item-5' },
    ]),
  );
  assert.equal(row.status, 'succeeded');
  assert.deepEqual(
    plain(result.candidates[0].slots.map((s) => [s.role, s.itemId])).sort(),
    [
      ['bottom', 'item-real-2'],
      ['shoes', 'item-real-5'],
      ['top', 'item-real-1'],
    ].sort(),
  );
});

test('F8：新增基线外槽位（加外套）的候选被拒绝', async () => {
  const { row } = await runReplaceSlot(
    slotsJson([
      { role: 'top', itemId: 'item-1' },
      { role: 'bottom', itemId: 'item-2' },
      { role: 'shoes', itemId: 'item-5' },
      { role: 'outerwear', itemId: 'item-4' },
    ]),
  );
  assert.equal(row.status, 'failed');
  assert.equal(row.error_kind, 'invalid_output');
  assert.match(row.error_summary, /不允许新增或改换槽位/);
});

test('F8：改动应保持不变单品的候选被拒绝', async () => {
  const pipeline = await loadPipeline(async () => ({
    ok: true,
    content: slotsJson([
      { role: 'top', itemId: 'item-1' },
      { role: 'bottom', itemId: 'item-6' }, // 下装应保持不变，被换成另一条下装（品类合法但超出允许范围）
      { role: 'shoes', itemId: 'item-5' },
    ]),
  }));
  const { db, store, runner, close } = pipeline;
  try {
    seedItem(db, 'item-real-1', '上衣');
    seedItem(db, 'item-real-2', '下装');
    seedItem(db, 'item-real-3', '鞋履');
    seedItem(db, 'item-real-4', '外套');
    seedItem(db, 'item-real-5', '鞋履');
    seedItem(db, 'item-real-6', '下装');
    const enq = await store.enqueueRecommendation({
      scene: { city: '北京', day: '今天', scene: '约会' },
      configId: 'cfg-1',
      lockedItemIds: ['item-real-1', 'item-real-2'],
      baseline: {
        slots: { top: 'item-real-1', bottom: 'item-real-2', shoes: 'item-real-3' },
        wear: '自然垂放',
        slotWear: {},
      },
      targetSlot: 'shoes',
    });
    runner.setForeground(true);
    const row = await waitForTerminal(db, enq.taskId);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_kind, 'invalid_output');
    // 保留件（锁定件）被换掉 → 拒绝（锁定缺失是第一道防线；基线复核为纵深防御）
    assert.match(row.error_summary, /锁定|应保持不变/);
  } finally {
    runner.setForeground(false);
    close();
  }
});

test('F8：品类与槽位不符的候选被拒绝（role 漂移防线）', async () => {
  const { row } = await runReplaceSlot(
    slotsJson([
      { role: 'top', itemId: 'item-1' },
      { role: 'bottom', itemId: 'item-2' },
      { role: 'top', itemId: 'item-5' }, // 鞋放进了上衣槽位
    ]),
  );
  assert.equal(row.status, 'failed');
  assert.match(row.error_summary, /不符的槽位|多件|重复|不符/);
});

// ---------------------------------------------------------------------------
// 采用决策（纯函数）：快照复核与会话基线
// ---------------------------------------------------------------------------

/** 会话直连（react 与数据库边界 stub，同 outfitSession.test.cjs） */
function loadSession() {
  const filename = path.resolve(__dirname, '../src/features/outfitSession.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const items = {
    A: { category: '上衣' },
    pants: { category: '下装' },
    pants2: { category: '下装' },
    shoes: { category: '鞋履' },
    shoes2: { category: '鞋履' },
  };
  const module = { exports: {} };
  vm.runInNewContext(js, {
    exports: module.exports,
    module,
    require(id) {
      if (id === 'react') return { useSyncExternalStore() {} };
      if (id === '../data/repositories/itemRepository') {
        return {
          getItem: async (id) => (items[id] ? { ...items[id], status: 'active' } : undefined),
          listItemIdsByStatus: async () => Object.keys(items),
        };
      }
      throw new Error(`Unexpected dependency: ${id}`);
    },
  }, { filename });
  return module.exports;
}

const SCENE = { city: '杭州', day: '今天', scene: '通勤' };

test('采用保存语义：AI 来源与理由进入契约 Plan；手动会话保持 manual/null', async () => {
  const s = loadSession();

  await s.startOutfitFrom('A');
  let plan = s.buildContractPlan('p1', SCENE);
  assert.equal(plan.source, 'manual');
  assert.equal(plan.reason, null);

  s.loadOutfitFrom({
    planId: '',
    name: null,
    basisId: 'A',
    slots: { top: 'A', bottom: 'pants', shoes: 'shoes' },
    wear: '自然垂放',
    itemIds: ['A', 'pants', 'shoes'],
    origin: { source: 'ai', reason: '同色系沉稳' },
  });
  plan = s.buildContractPlan('p2', SCENE);
  assert.equal(plan.source, 'ai');
  assert.equal(plan.reason, '同色系沉稳');
  // 编辑与撤销不改变来源；AI 理由缺省时保持 null 不编造
  s.replaceSlot('bottom', 'pants');
  assert.equal(s.buildContractPlan('p3', SCENE).source, 'ai');
  s.loadOutfitFrom({
    planId: '',
    name: null,
    basisId: 'A',
    slots: { top: 'A' },
    wear: '自然垂放',
    itemIds: ['A'],
    origin: { source: 'ai', reason: null },
  });
  assert.equal(s.buildContractPlan('p4', SCENE).reason, null);
});

test('采用决策（F8）：局部替换走会话单次变更，撤销一次恢复整个采用前状态', async () => {
  const { store } = await loadStore();
  const s = loadSession();
  await s.startOutfitFrom('A'); // top=A（锁定 basis），补 pants/shoes
  const stored = {
    inputVersion: 2,
    createdAt: 't0',
    items: [],
    truncated: false,
    totalCount: 0,
    lockedRealIds: ['A', 'pants'],
    scene: { city: '杭州', day: '今天', scene: '通勤', targetDate: '2026-11-04' },
    body: null,
    preferences: [],
    note: null,
    mode: 'replace_slot',
    baseline: {
      slots: { top: 'A', bottom: 'pants', shoes: 'shoes' },
      wear: '前侧塞衣角', // 与会话语义一致：内搭槽位设置穿法即主穿法
      slotWear: { top: '前侧塞衣角' },
    },
    targetSlot: 'shoes',
  };
  // 会话与基线一致 → 单次替换目标槽位
  s.setSlotWear('top', '前侧塞衣角');
  let decision = store.evaluateAdoption({
    stored,
    candidate: { slots: [{ role: 'shoes', itemId: 'shoes2' }], wearStyle: '自然垂放' },
    mappedSlots: { top: 'A', bottom: 'pants', shoes: 'shoes2' },
    session: s.getOutfitSession(),
  });
  assert.equal(decision.action, 'replace_slot');
  assert.deepEqual(plain(decision), { action: 'replace_slot', slot: 'shoes', itemId: 'shoes2' });

  const historyBefore = s.outfitHistoryLength();
  s.replaceSlot('shoes', 'shoes2');
  assert.equal(s.getOutfitSession().slots.shoes, 'shoes2');
  // 其他件与逐件穿法保持
  assert.deepEqual(plain(s.getOutfitSession().slotWear), { top: '前侧塞衣角' });
  // 撤销一次恢复整个采用前状态
  s.outfitUndo();
  assert.equal(s.getOutfitSession().slots.shoes, 'shoes');
  // 撤销后历史回到采用前长度（采用只占一格历史）
  assert.equal(s.outfitHistoryLength(), historyBefore);

  // 会话已变化（换掉下装）→ 拒绝采用
  s.replaceSlot('bottom', 'pants2');
  decision = store.evaluateAdoption({
    stored,
    candidate: { slots: [{ role: 'shoes', itemId: 'shoes2' }], wearStyle: '自然垂放' },
    mappedSlots: { top: 'A', bottom: 'pants', shoes: 'shoes2' },
    session: s.getOutfitSession(),
  });
  assert.equal(decision.action, 'blocked');
  assert.match(decision.message, /不再适用/);
});

test('采用决策：full 模式基线/锁定变化即阻止；旧记录不提供受约束采用', async () => {
  const { store } = await loadStore();
  const candidate = {
    slots: [
      { role: 'top', itemId: 'item-real-1' },
      { role: 'bottom', itemId: 'item-real-2' },
    ],
    wearStyle: '自然垂放',
    reason: '沉稳',
  };
  const stored = {
    inputVersion: 2,
    createdAt: 't0',
    items: [],
    truncated: false,
    totalCount: 0,
    lockedRealIds: ['item-real-1'],
    scene: { city: '杭州', day: '今天', scene: '通勤', targetDate: '2026-11-04' },
    body: null,
    preferences: [],
    note: null,
    mode: 'full',
    baseline: {
      slots: { top: 'item-real-1', bottom: 'item-real-2' },
      wear: '自然垂放',
      slotWear: {},
    },
    targetSlot: null,
  };
  // 会话与基线一致 → 整套采用并保留原请求锁定
  let decision = store.evaluateAdoption({
    stored,
    candidate,
    mappedSlots: { top: 'item-real-1', bottom: 'item-real-2' },
    session: {
      active: true,
      slots: { top: 'item-real-1', bottom: 'item-real-2' },
      locks: ['item-real-1'],
      wear: '自然垂放',
      slotWear: {},
    },
  });
  assert.equal(decision.action, 'load_full');
  assert.deepEqual(plain(decision.locks), ['item-real-1']);
  assert.equal(decision.reason, '沉稳');

  // 基线已变化（会话换了下装）→ 阻止
  decision = store.evaluateAdoption({
    stored,
    candidate,
    mappedSlots: { top: 'item-real-1', bottom: 'item-real-2' },
    session: {
      active: true,
      slots: { top: 'item-real-1', bottom: 'item-real-9' },
      locks: [],
      wear: '自然垂放',
      slotWear: {},
    },
  });
  assert.equal(decision.action, 'blocked');
  assert.match(decision.message, /不再对应/);

  // 锁定变化（请求锁定的单品已不在会话）→ 阻止
  decision = store.evaluateAdoption({
    stored,
    candidate,
    mappedSlots: { top: 'item-real-1', bottom: 'item-real-2' },
    session: {
      active: true,
      slots: { top: 'item-real-1', bottom: 'item-real-2' },
      locks: [],
      wear: '自然垂放',
      slotWear: {},
    },
  });
  assert.equal(decision.action, 'blocked');
  assert.match(decision.message, /锁定/);

  // 旧记录（无可核验快照）→ 不提供冒充受约束结果的一键采用
  decision = store.evaluateAdoption({
    stored: null,
    candidate,
    mappedSlots: { top: 'item-real-1', bottom: 'item-real-2' },
    session: null,
  });
  assert.equal(decision.action, 'blocked');
  assert.match(decision.message, /旧版本/);
});

// ---------------------------------------------------------------------------
// 提示词与指纹（纯函数）
// ---------------------------------------------------------------------------

test('提示词（v5）：人工确认标记、具体日期与局部替换说明', async () => {
  const { adapter } = createMemoryAdapter();
  const loader = createLoader(adapter);
  const service = loader.load(path.join(SRC, 'services', 'ai', 'recommendationService.ts'));

  const prompt = service.recommendationUserPrompt({
    items: [
      {
        id: 'item-1',
        name: '白衬衫',
        category: '上衣',
        attributes: [
          { name: '领型', value: '方领', source: 'user_confirmed' },
          { name: '厚薄', value: '薄款', source: 'ai_inferred' },
        ],
        colors: [],
      },
    ],
    scene: { city: '杭州', day: '今天', scene: '通勤', targetDate: '2026-11-04' },
    lockedAliases: ['item-9'],
    replacementNote: '本次是"只换鞋子"的局部替换任务：不要新增其他槽位的衣物。',
  });
  assert.match(prompt, /方领（已确认）/);
  assert.doesNotMatch(prompt, /薄款（已确认）/);
  assert.match(prompt, /日期=2026-11-04（今天）/);
  assert.match(prompt, /已锁定的单品（候选组合必须包含）：item-9/);
  assert.match(prompt, /只换鞋子.*局部替换任务/);
  assert.match(prompt, /不要新增其他槽位的衣物/);

  // 无具体日期（历史形状）回退 label；无替换说明不出现
  const plainPrompt = service.recommendationUserPrompt({
    items: [],
    scene: { city: '杭州', day: '今天', scene: '通勤' },
  });
  assert.match(plainPrompt, /日期=今天/);
  assert.doesNotMatch(plainPrompt, /局部替换任务/);

  // 温度来源呈现不变
  const tempPrompt = service.recommendationUserPrompt({
    items: [],
    scene: { city: '杭州', day: '今天', scene: '通勤', temp: '20℃', tempSource: 'manual' },
  });
  assert.match(tempPrompt, /温度=20℃（手动填写）/);
});

test('输入指纹 V2（§8.2.3）：键序无关；真实 ID/版本/锁定/基线/目标槽位全部参与', async () => {
  const { adapter } = createMemoryAdapter();
  const loader = createLoader(adapter);
  const inputModule = loader.load(path.join(SRC, 'services', 'ai', 'recommendationInput.ts'));
  const base = {
    items: [
      { realId: 'a', alias: 'item-1', revision: 2, name: null, category: '上衣', attributes: [], colors: [] },
      { realId: 'b', alias: 'item-2', revision: 1, name: null, category: '鞋履', attributes: [], colors: [] },
    ],
    truncated: false,
    totalCount: 2,
    lockedRealIds: ['b'],
    scene: { city: '杭州', day: '今天', scene: '通勤', targetDate: '2026-11-04' },
    body: null,
    preferences: ['正式'],
    note: null,
    mode: 'full',
    baseline: null,
    targetSlot: null,
  };
  const keyA = inputModule.buildRecommendationInputKeyV2({
    stored: base,
    configId: 'c',
    configRevision: 'r',
    contractVersion: 'v',
    promptVersion: '5',
  });
  // 对象键序不同 → 同一指纹（规范化序列化）
  const reordered = {
    ...base,
    scene: { targetDate: '2026-11-04', scene: '通勤', day: '今天', city: '杭州' },
    items: [base.items[1], base.items[0]],
  };
  const keyB = inputModule.buildRecommendationInputKeyV2({
    stored: reordered,
    configId: 'c',
    configRevision: 'r',
    contractVersion: 'v',
    promptVersion: '5',
  });
  assert.equal(keyA, keyB);

  // 衣物版本变化 → 新指纹
  const revisionChanged = JSON.parse(JSON.stringify(base));
  revisionChanged.items[0].revision = 3;
  assert.notEqual(
    keyA,
    inputModule.buildRecommendationInputKeyV2({
      stored: revisionChanged,
      configId: 'c',
      configRevision: 'r',
      contractVersion: 'v',
      promptVersion: '5',
    }),
  );

  // 目标日期跨日 → 新指纹（"今天"不重新解释）
  const dateChanged = JSON.parse(JSON.stringify(base));
  dateChanged.scene.targetDate = '2026-11-05';
  assert.notEqual(
    keyA,
    inputModule.buildRecommendationInputKeyV2({
      stored: dateChanged,
      configId: 'c',
      configRevision: 'r',
      contractVersion: 'v',
      promptVersion: '5',
    }),
  );

  // V2 解析：旧格式/损坏返回 null
  assert.equal(inputModule.parseRecommendationInputV2(JSON.stringify({ scene: {}, lockedAliases: [] })), null);
  assert.equal(inputModule.parseRecommendationInputV2('not-json'), null);
  assert.equal(inputModule.parseRecommendationInputV2(null), null);
  assert.equal(inputModule.parseRecommendationInputV2(JSON.stringify({ ...base, inputVersion: 2 })).mode, 'full');
});

/** planRepository 直连 adapter，契约用真实包 */
async function loadPlanRepository() {
  const { db, adapter, close } = await freshDb();
  const loader = createLoader(adapter);
  const repo = loader.load(path.join(SRC, 'data', 'repositories', 'planRepository.ts'));
  return { db, close, repo, adapter };
}

function contractPlan(overrides = {}) {
  return {
    planId: 'plan-1',
    parentPlanId: null,
    version: 1,
    items: [
      { itemId: 'item-real-1', role: 'basis' },
      { itemId: 'item-real-2', role: 'piece' },
    ],
    wear: { slot: '整体', style: '自然垂放' },
    reason: '同色系沉稳',
    gaps: [],
    scene: { city: '北京', day: '今天', scene: '约会' },
    source: 'ai',
    createdAt: 't0',
    ...overrides,
  };
}

test('方案落库：source/reason 持久化；更新分支同步 source', async () => {
  const { db, close, repo } = await loadPlanRepository();
  try {
    seedItem(db, 'item-real-1', '上衣');
    seedItem(db, 'item-real-2', '下装');
    await repo.saveContractPlan(contractPlan(), null);
    let row = db.prepare('SELECT source, reason FROM plans WHERE id = ?').get('plan-1');
    assert.equal(row.source, 'ai');
    assert.equal(row.reason, '同色系沉稳');

    // 同 id 保存（手动修改后另存覆盖场景）：source 随输入更新，不残留 ai
    await repo.saveContractPlan(
      contractPlan({ source: 'manual', reason: null, planId: 'plan-1' }),
      '手改版',
    );
    row = db.prepare('SELECT source, reason, name FROM plans WHERE id = ?').get('plan-1');
    assert.equal(row.source, 'manual');
    assert.equal(row.reason, null);
    assert.equal(row.name, '手改版');

    // 输入缺省 source 时按 manual 落库（兼容旧调用方）
    await repo.savePlan(
      {
        basisItemId: 'item-real-1',
        itemIds: [
          { itemId: 'item-real-1', role: 'basis' },
          { itemId: 'item-real-2', role: 'piece' },
        ],
        wear: { slot: '整体', style: '自然垂放' },
        scene: { city: '北京', day: '今天', scene: '约会' },
      },
      null,
    );
    const legacy = db.prepare('SELECT source FROM plans ORDER BY created_at DESC').get();
    assert.equal(legacy.source, 'manual');
  } finally {
    close();
  }
});
