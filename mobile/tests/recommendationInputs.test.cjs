// M6 批次 1.2 回归：推荐当次场景/温度/锁定输入端到端与采用保存语义。
// - loadSceneSnapshot 读当次 context（演示温度不进 AI；实时/手动温度带来源）
// - 入队持久化输入快照（场景 + 锁定别名），执行器按快照发送，不现读会话
// - 采用候选保留 AI 来源与理由（buildContractPlan source/reason；planRepository 落库）
// M6 批次 2 补充：身材资料（身高/体重选填）随入队快照进指纹与提示词，脏字段消毒。
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

function seedItem(db, id, category) {
  db.prepare(
    "INSERT INTO items (id, status, category, source_type, created_at, updated_at) VALUES (?, 'active', ?, 'photo', 't0', 't0')",
  ).run(id, category);
}

/** store + 仓库直连 adapter；runner 用捕获桩（执行器行为另有专项测试） */
async function loadStore() {
  const { db, adapter, close } = await freshDb();
  const demo = createDemoStoreStub(DEMO_CONTEXT);
  const configs = [
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
  const runnerCalls = { init: 0 };
  const loader = createLoader(adapter, {
    [path.join(SRC, 'features', 'demoStore.ts')]: demo.stub,
    [path.join(SRC, 'services', 'ai', 'configStore.ts')]: {
      getConfig: (id) => configs.find((c) => c.id === id),
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

test('当次场景快照：演示温度不进输入；实时/手动温度带来源', async () => {
  const { close, store, demo } = await loadStore();
  try {
    const snapshot = await store.loadSceneSnapshot();
    assert.deepEqual(plain(snapshot), { city: '北京', day: '明天', scene: '约会' });

    demo.set({ tempSource: 'real', temp: '10–15℃', weatherDesc: '小雨' });
    assert.deepEqual(plain(await store.loadSceneSnapshot()), {
      city: '北京',
      day: '明天',
      scene: '约会',
      temp: '10–15℃',
      tempSource: 'real',
    });

    demo.set({ tempSource: 'manual', temp: '20℃' });
    const manual = await store.loadSceneSnapshot();
    assert.equal(manual.temp, '20℃');
    assert.equal(manual.tempSource, 'manual');
  } finally {
    close();
  }
});

test('入队：锁定真实单品映射为别名，输入快照与指纹持久化；同输入去重', async () => {
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
    assert.deepEqual(snapshot.lockedAliases, ['item-2']); // 不在档案中的锁定项被忽略
    assert.deepEqual(snapshot.scene, {
      city: '北京',
      day: '今天',
      scene: '约会',
      temp: '10–15℃',
      tempSource: 'real',
    });
    assert.equal(snapshot.body, null); // 未填写身材资料
    const inputKey = JSON.parse(row.input_key);
    assert.deepEqual(inputKey.lockedAliases, ['item-2']);
    assert.equal(inputKey.body, null);
    assert.equal(inputKey.promptVersion, '3');

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

/** 执行器直连：注入 deps 与 chatCompletion 捕获，驱动前台循环 */
async function loadRunner(chatStub) {
  const loader = createLoader(
    { async getFirstAsync() { return null; }, async getAllAsync() { return []; }, async runAsync() {}, async execAsync() {}, async withTransactionAsync(fn) { await fn(); } },
    {
      [path.join(SRC, 'services', 'ai', 'openaiClient.ts')]: {
        chatCompletion: chatStub,
      },
    },
  );
  const { createRecommendationTaskRunner } = loader.load(
    path.join(SRC, 'services', 'ai', 'recommendationTaskRunner.ts'),
  );
  return createRecommendationTaskRunner;
}

const RUNNER_TASK_BASE = {
  id: 't1',
  kind: 'outfit_recommendation',
  itemId: 'outfit-recommendation',
  status: 'queued',
  configId: 'c1',
  configRevision: 'rev-1',
  errorKind: null,
  errorSummary: null,
  candidates: null,
  gaps: [],
  summary: null,
  createdAt: 't0',
  finishedAt: null,
};

function runnerDeps(overrides = {}) {
  const calls = { updates: [], commits: [], chat: null, loadSceneCalls: 0 };
  const deps = {
    // 与生产语义一致：只领取 queued（否则前台循环会无限重复领取同一任务）
    listQueued: async () => (task.status === 'queued' ? [task] : []),
    listRunning: async () => [],
    getTask: async (id) => task,
    markRunning: async () => true,
    updateStatus: async (id, allowed, to, patch) => {
      calls.updates.push({ to, patch });
      task = { ...task, status: to };
      return true;
    },
    getConfig: (id) => ({
      id,
      name: '文本模型',
      urlKind: 'openai',
      baseUrl: 'https://example.test',
      modelId: 'm-1',
      capabilities: ['text'],
      keyRef: 'k1',
      hasKey: true,
      testStatus: 'untested',
      callRevision: 'rev-1',
    }),
    getApiKey: async () => 'sk-test',
    loadProfile: async () => ({
      items: [
        { id: 'item-1', name: '白衬衫', category: '上衣', attributes: [], colors: [] },
        { id: 'item-2', name: '黑裤', category: '下装', attributes: [], colors: [] },
      ],
      idByAlias: new Map([
        ['item-1', 'item-real-1'],
        ['item-2', 'item-real-2'],
      ]),
    }),
    loadScene: async () => {
      calls.loadSceneCalls += 1;
      return { city: '上海', day: '今天', scene: '通勤' };
    },
    commitResult: async (taskId, result) => {
      calls.commits.push({ taskId, result });
    },
    ...overrides,
  };
  let task = { ...RUNNER_TASK_BASE };
  return { deps, calls, getTask: () => task };
}

const OK_CONTENT =
  '{"candidates":[{"slots":[{"role":"top","itemId":"item-1"},{"role":"bottom","itemId":"item-2"}],"wearStyle":"自然垂放","reason":"同色系沉稳"}],"gaps":[]}';

test('执行器（快照优先与回退；锁定行与温度来源进提示词）', async () => {
  async function run(taskOverrides) {
    let chatArg = null;
    const createRunner = await loadRunner(async (config, apiKey, messages) => {
      chatArg = messages;
      return { ok: true, content: OK_CONTENT };
    });
    const { deps, calls } = runnerDeps();
    // 覆盖任务输入；领取过滤与状态推进保持生产语义（否则前台循环会无限重复领取）
    let current = { ...RUNNER_TASK_BASE, ...taskOverrides };
    deps.listQueued = async () => (current.status === 'queued' ? [current] : []);
    const baseUpdateStatus = deps.updateStatus;
    deps.updateStatus = async (id, allowed, to, patch) => {
      current = { ...current, status: to };
      return baseUpdateStatus(id, allowed, to, patch);
    };
    const runner = createRunner(deps);
    runner.setForeground(true);
    for (let i = 0; i < 50 && calls.updates.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    runner.setForeground(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { chatArg, calls };
  }

  // 有快照：使用快照场景与锁定集；未知别名过滤；温度带来源标注
  {
    const { chatArg, calls } = await run({
      inputJson: JSON.stringify({
        scene: { city: '北京', day: '明天', scene: '约会', temp: '10–15℃', tempSource: 'real' },
        lockedAliases: ['item-2', 'item-x'],
      }),
    });
    assert.equal(calls.updates.at(-1).to, 'succeeded');
    const userPrompt = chatArg[1].content;
    assert.match(userPrompt, /城市=北京/);
    assert.match(userPrompt, /日期=明天/);
    assert.match(userPrompt, /温度=10–15℃（实时天气）/);
    assert.match(userPrompt, /已锁定的单品（候选组合必须包含）：item-2$/m);
    assert.doesNotMatch(userPrompt, /item-x/);
    assert.doesNotMatch(userPrompt, /身材资料/);
    assert.equal(calls.loadSceneCalls, 0);
    // 候选已回映真实单品 ID，理由保留
    assert.deepEqual(plain(calls.commits[0].result.candidates[0].slots.map((s) => s.itemId)), [
      'item-real-1',
      'item-real-2',
    ]);
    assert.equal(calls.commits[0].result.candidates[0].reason, '同色系沉稳');
  }

  // 无快照（旧任务）：回退现读场景
  {
    const { chatArg, calls } = await run({ inputJson: null });
    assert.equal(calls.loadSceneCalls, 1);
    assert.match(chatArg[1].content, /城市=上海/);
    assert.doesNotMatch(chatArg[1].content, /已锁定的单品/);
  }

  // 身材资料快照进提示词；脏字段消毒（非数值身高被剔除，M6 批次 2）
  {
    const { chatArg, calls } = await run({
      inputJson: JSON.stringify({
        scene: { city: '北京', day: '明天', scene: '约会' },
        body: { heightCm: 'tall', weightKg: 60 },
      }),
    });
    assert.equal(calls.updates.at(-1).to, 'succeeded');
    const userPrompt = chatArg[1].content;
    assert.match(userPrompt, /体重=60kg/);
    assert.doesNotMatch(userPrompt, /身高=/);
    assert.doesNotMatch(userPrompt, /tall/);
  }
});

test('提示词与输入指纹（纯函数）：温度来源与锁定集呈现', async () => {
  const { adapter } = createMemoryAdapter();
  const loader = createLoader(adapter);
  const service = loader.load(path.join(SRC, 'services', 'ai', 'recommendationService.ts'));

  const prompt = service.recommendationUserPrompt({
    items: [{ id: 'item-1', name: '白衬衫', category: '上衣', attributes: [], colors: [] }],
    scene: { city: '杭州', day: '今天', scene: '通勤', temp: '20℃', tempSource: 'manual' },
    lockedAliases: ['item-9'],
  });
  assert.match(prompt, /温度=20℃（手动填写）/);
  assert.match(prompt, /已锁定的单品（候选组合必须包含）：item-9/);

  const plain = service.recommendationUserPrompt({
    items: [],
    scene: { city: '杭州', day: '今天', scene: '通勤' },
  });
  assert.doesNotMatch(plain, /温度=/);
  assert.doesNotMatch(plain, /已锁定的单品/);
  assert.doesNotMatch(plain, /身材资料/);

  // 身材资料行：有有效数值才输出，明确不下合身结论（M6 批次 2）
  const withBody = service.recommendationUserPrompt({
    items: [],
    scene: { city: '杭州', day: '今天', scene: '通勤' },
    body: { heightCm: 170, weightKg: 60 },
  });
  assert.match(withBody, /身材资料（选填，仅作体型参考，不要给出合身结论）：身高=170cm，体重=60kg/);

  const zeroHeight = service.recommendationUserPrompt({
    items: [],
    scene: { city: '杭州', day: '今天', scene: '通勤' },
    body: { heightCm: 0, weightKg: 60 },
  });
  assert.doesNotMatch(zeroHeight, /身高=/);
  assert.match(zeroHeight, /体重=60kg/);

  const key = JSON.parse(
    service.buildRecommendationInputKey({
      aliasItemIds: ['item-2', 'item-1'],
      scene: { city: '杭州', day: '今天', scene: '通勤', tempSource: 'real', temp: '9–12℃' },
      lockedAliases: ['item-2', 'item-1'],
      configId: 'c',
      configRevision: 'r',
    }),
  );
  assert.deepEqual(key.itemIds, ['item-1', 'item-2']);
  assert.deepEqual(key.lockedAliases, ['item-1', 'item-2']);

  // 指纹：身材数值变化与缺失互相视为不同输入
  const sceneKey = { city: '杭州', day: '今天', scene: '通勤' };
  const keyBodyA = service.buildRecommendationInputKey({
    aliasItemIds: ['item-1'], scene: sceneKey, body: { heightCm: 170 }, configId: 'c', configRevision: 'r',
  });
  const keyBodyB = service.buildRecommendationInputKey({
    aliasItemIds: ['item-1'], scene: sceneKey, body: { heightCm: 172 }, configId: 'c', configRevision: 'r',
  });
  const keyNoBody = service.buildRecommendationInputKey({
    aliasItemIds: ['item-1'], scene: sceneKey, body: null, configId: 'c', configRevision: 'r',
  });
  assert.notEqual(keyBodyA, keyBodyB);
  assert.notEqual(keyBodyA, keyNoBody);
});

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
    shoes: { category: '鞋履' },
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
