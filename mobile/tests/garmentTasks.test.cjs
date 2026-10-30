// P3 回归：属性取值优先级、结果原子提交、版本/删除保护（分批执行手册 P3）。
// 使用内存 SQLite 与真实仓库代码；不调用真实模型。
// 运行：仓库根 `node --test mobile/tests/*.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const { createMemoryAdapter, loadDbModule, taskInput } = require('./analysisMigration.test.cjs');

const nodeRequire = require;
const SRC = path.resolve(__dirname, '../src');
const CONTRACT_ENTRY = path.resolve(__dirname, '../../packages/contract/src/index.ts');

/** 无副作用的前端/原生依赖 stub（测试不触碰真实文件与设备） */
const expoStubs = {
  'expo-sqlite': {},
  'expo-secure-store': {},
  'expo-crypto': {},
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
      constructor() {}
      get exists() {
        return false;
      }
      create() {}
    },
    File: class {
      constructor() {}
      get exists() {
        return false;
      }
      delete() {}
      move() {}
      textSync() {
        return '[]';
      }
      writeSync() {}
    },
  },
};

function resolveModule(candidate) {
  for (const suffix of ['.ts', '.tsx', '/index.ts', '']) {
    const file = candidate + suffix;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  throw new Error(`cannot resolve module: ${candidate}`);
}

/** 极简 CommonJS 加载器：transpile + 缓存，'../db' 指向内存适配器；overrides 按解析后路径替换模块 */
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
      // 执行器使用 AbortController 尽力中止请求；注入宿主实现使行为与真机一致
      AbortController,
      setTimeout,
      clearTimeout,
      Error,
      require(id) {
        if (id in expoStubs) return expoStubs[id];
        // 契约包 main 指向 TS 源，Node require 无法加载，改走本加载器转译
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
  return load;
}

/** 把 vm 上下文里创建的对象转为普通对象，便于 deepEqual */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function seedItem(db, { id = 'item-a', status = 'active', revision = 1, photoId = 'photo-a' } = {}) {
  const category = status === 'draft' ? 'NULL' : "'上衣'";
  const name = status === 'draft' ? 'NULL' : "'衬衫'";
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    `INSERT INTO items (id,status,category,name,source_type,main_photo_id,revision,created_at,updated_at) ` +
      `VALUES ('${id}','${status}',${category},${name},'photo',${photoId ? `'${photoId}'` : 'NULL'},${revision},'t1','t1')`,
  );
  if (photoId) {
    db.exec(
      `INSERT INTO photos (id,item_id,kind,original_path,thumb_path,created_at) ` +
        `VALUES ('${photoId}','${id}','main','photos/${photoId}.jpg','thumbs/${photoId}.jpg','t1')`,
    );
  }
}

/** 2.0.0-draft 契约形状：动态属性清单 + hex 颜色（3 条动态属性行） */
const singleResult = {
  targetStatus: 'single',
  category: '上衣',
  suggestedName: '白色衬衫',
  colors: [{ name: '白色', hex: '#F5F5F0', isPrimary: true }],
  attributes: [
    { name: '领型', value: '翻领' },
    { name: '袖型', value: '长袖' },
    { name: '图案', value: '纯色' },
  ],
  unclearParts: [],
};

/** 非 single：只存诊断，不写任何属性行 */
const diagnosticResult = {
  targetStatus: 'ambiguous',
  category: null,
  suggestedName: null,
  colors: [],
  attributes: [],
  unclearParts: ['画面中有两件衣服，无法确定目标单品'],
};

async function setup(seedOptions) {
  const { db, adapter, close } = createMemoryAdapter();
  const { runMigrations } = loadDbModule();
  await runMigrations(adapter);
  const load = createLoader(adapter);
  const repos = {
    items: load(path.join(SRC, 'data/repositories/itemRepository.ts')),
    tasks: load(path.join(SRC, 'data/repositories/taskRepository.ts')),
    attributes: load(path.join(SRC, 'data/repositories/attributeRepository.ts')),
    photos: load(path.join(SRC, 'data/repositories/photoRepository.ts')),
  };
  seedItem(db, seedOptions);
  return { db, adapter, close, ...repos };
}

/** 创建并进入 running 的任务（模拟执行器已领取） */
async function startTask(tasks, overrides = {}) {
  const { task } = await tasks.createGarmentTask(taskInput(overrides));
  await tasks.markTaskRunning(task.id);
  return task;
}

function aiAttributeCount(db, taskId) {
  return db.prepare('SELECT COUNT(*) AS n FROM attributes WHERE analysis_task_id = ?').get(taskId).n;
}

// ---------------------------------------------------------------------------
// 测试（仅在本文件被直接运行时注册；被其他测试 require 时只导出 helper）
// ---------------------------------------------------------------------------
if (require.main === module) {
  test('提交成功：写入动态属性行，view 返回属性、颜色与上次有效结果', async () => {
  const { db, close, tasks, attributes } = await setup();
  try {
    const task = await startTask(tasks);
    assert.equal(await attributes.commitGarmentAnalysis(task.id, singleResult), 'applied');
    assert.equal(aiAttributeCount(db, task.id), 3, '只写 attributes 清单；品类/名称/颜色是内置字段不入动态行');

    const view = await attributes.getAnalysisView('item-a');
    assert.equal(view.latestTask.status, 'succeeded');
    assert.deepEqual(
      plain(view.attributes.map((a) => a.name)),
      ['领型', '袖型', '图案'],
      '按品类推荐键排序',
    );
    assert.equal(view.attributes[0].source, 'ai_inferred');
    assert.equal(view.attributes[0].value, '翻领');
    assert.equal(view.colors.source, 'ai_inferred');
    assert.deepEqual(plain(view.colors.value), [{ name: '白色', hex: '#F5F5F0', isPrimary: true }]);
    assert.equal(view.suggestedName.value, '白色衬衫');
    assert.equal(view.category.value, '上衣');
    assert.equal(view.lastValidResult.taskId, task.id);
    assert.equal(view.lastValidResult.modelName, 'GLM');
  } finally {
    close();
  }
});

test('同名属性行取最新：用户确认覆盖 AI 显示，AI 重新分析再取最新，历史行保留', async () => {
  const { db, close, tasks, attributes } = await setup();
  try {
    const first = await startTask(tasks);
    await attributes.commitGarmentAnalysis(first.id, singleResult);

    await attributes.recordUserAttribute({
      itemId: 'item-a',
      field: '领型',
      value: '立领',
      sourceType: 'user_confirmed',
      sourceRef: '详情确认分析结果',
    });
    let view = await attributes.getAnalysisView('item-a');
    const confirmed = view.attributes.find((a) => a.name === '领型');
    assert.equal(confirmed.source, 'user_confirmed');
    assert.equal(confirmed.value, '立领');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM attributes WHERE item_id = 'item-a' AND field = '领型'").get().n,
      2,
      'AI 行与用户行都保留（同名取最新展示）',
    );

    // 用户修改推进 revision 后，重新分析以新输入为准，同名再取最新
    const second = await startTask(tasks, { requestKey: 'req-2', inputRevision: 2 });
    await attributes.commitGarmentAnalysis(second.id, {
      ...singleResult,
      attributes: [{ name: '领型', value: '翻领（重拍后）' }],
    });
    view = await attributes.getAnalysisView('item-a');
    const latest = view.attributes.find((a) => a.name === '领型');
    assert.equal(latest.source, 'ai_inferred');
    assert.equal(latest.value, '翻领（重拍后）');
    assert.equal(view.lastValidResult.taskId, second.id);
  } finally {
    close();
  }
});

test('等待期间修改资料：提交判定 stale，不应用任何属性', async () => {
  const { close, tasks, items, attributes } = await setup();
  try {
    const task = await startTask(tasks); // inputRevision = 1
    await items.updateItemBasics('item-a', { name: '改名后的衬衫' }); // revision -> 2

    assert.equal(await attributes.commitGarmentAnalysis(task.id, singleResult), 'stale');
    assert.equal((await tasks.getTask(task.id)).status, 'stale');

    const view = await attributes.getAnalysisView('item-a');
    assert.equal(view.attributes.length, 0, 'stale 结果不写任何属性行');
    assert.equal(view.lastValidResult, null);
  } finally {
    close();
  }
});

test('颜色：用户确认行优先，否则回退当前照片最新 AI 结果', async () => {
  const { close, tasks, attributes } = await setup();
  try {
    const first = await startTask(tasks, { requestKey: 'req-1' });
    await attributes.commitGarmentAnalysis(first.id, singleResult);

    await attributes.recordUserAttribute({
      itemId: 'item-a',
      field: 'colors',
      value: [{ name: '藏青', hex: '#2B3A4A', isPrimary: true }],
      sourceType: 'user_confirmed',
      sourceRef: '单品详情确认颜色',
    });

    const view = await attributes.getAnalysisView('item-a');
    assert.equal(view.colors.source, 'user_confirmed');
    assert.deepEqual(plain(view.colors.value), [{ name: '藏青', hex: '#2B3A4A', isPrimary: true }]);
    assert.equal(view.lastValidResult.taskId, first.id);
  } finally {
    close();
  }
});

test('新任务失败保留上次成功结果，并同时暴露失败状态', async () => {
  const { close, tasks, attributes } = await setup();
  try {
    const ok = await startTask(tasks, { requestKey: 'req-ok' });
    await attributes.commitGarmentAnalysis(ok.id, singleResult);

    const failed = await startTask(tasks, { requestKey: 'req-fail' });
    await tasks.updateTaskStatus(failed.id, ['running'], 'failed', { errorKind: 'network' });

    const view = await attributes.getAnalysisView('item-a');
    assert.equal(view.latestTask.status, 'failed');
    assert.equal(view.lastValidResult.taskId, ok.id);
    assert.equal(view.attributes.find((a) => a.name === '领型').value, '翻领');
  } finally {
    close();
  }
});

test('照片不同不应用：提交判 stale，读取也不跨照片取旧结果', async () => {
  const { db, close, tasks, attributes } = await setup();
  try {
    const ok = await startTask(tasks, { requestKey: 'req-photo-1' });
    assert.equal(await attributes.commitGarmentAnalysis(ok.id, singleResult), 'applied');
    assert.notEqual((await attributes.getAnalysisView('item-a')).lastValidResult, null);

    // 模拟主图被更换（本批不新增换图 UI）
    db.exec("INSERT INTO photos (id,item_id,kind,original_path,thumb_path,created_at) VALUES ('photo-b','item-a','main','photos/photo-b.jpg','thumbs/photo-b.jpg','t2')");
    db.exec("UPDATE items SET main_photo_id = 'photo-b' WHERE id = 'item-a'");

    const view = await attributes.getAnalysisView('item-a');
    assert.equal(view.lastValidResult, null, '当前照片没有结果时不回退旧照片推断');
    assert.equal(view.suggestedName, null);

    const stale = await startTask(tasks, { requestKey: 'req-photo-2', photoId: 'photo-a' });
    assert.equal(await attributes.commitGarmentAnalysis(stale.id, singleResult), 'stale');
  } finally {
    close();
  }
});

test('重复提交：第二次 discarded，属性不重复写入', async () => {
  const { db, close, tasks, attributes } = await setup();
  try {
    const task = await startTask(tasks);
    assert.equal(await attributes.commitGarmentAnalysis(task.id, singleResult), 'applied');
    assert.equal(await attributes.commitGarmentAnalysis(task.id, singleResult), 'discarded');
    assert.equal(aiAttributeCount(db, task.id), 3);
  } finally {
    close();
  }
});

test('非 single 结果：任务成功但只存诊断，不写属性、不显示识别成功', async () => {
  const { db, close, tasks, attributes } = await setup();
  try {
    const task = await startTask(tasks);
    assert.equal(await attributes.commitGarmentAnalysis(task.id, diagnosticResult), 'applied');
    assert.equal(aiAttributeCount(db, task.id), 0);

    const view = await attributes.getAnalysisView('item-a');
    assert.equal(view.latestTask.status, 'succeeded');
    assert.equal(view.lastValidResult, null);
    assert.equal(view.attributes.length, 0);
  } finally {
    close();
  }
});

test('归档：取消进行中任务、保留已成功结果，晚返回不写库', async () => {
  const { db, close, tasks, items, attributes } = await setup();
  try {
    const ok = await startTask(tasks, { requestKey: 'req-done' });
    await attributes.commitGarmentAnalysis(ok.id, singleResult);

    const running = await startTask(tasks, { requestKey: 'req-running' });
    await items.archiveItem('item-a');
    assert.equal((await tasks.getTask(running.id)).status, 'cancelled');

    assert.equal(await attributes.commitGarmentAnalysis(running.id, singleResult), 'discarded');
    assert.equal(aiAttributeCount(db, running.id), 0);

    const view = await attributes.getAnalysisView('item-a');
    assert.equal(view.lastValidResult.taskId, ok.id, '归档后仍可查看历史成功结果');
  } finally {
    close();
  }
});

test('彻底删除：资料事务内清理任务与属性，保留收藏与穿着记录，晚返回不复活', async () => {
  const { db, close, tasks, items, attributes } = await setup();
  try {
    db.exec("INSERT INTO plans (id,basis_item_id,wear_style,created_at,updated_at) VALUES ('pl1','item-a','自然垂放','t1','t1')");
    db.exec("INSERT INTO plan_items (plan_id,item_id,role,position) VALUES ('pl1','item-a','basis',0)");
    db.exec("INSERT INTO worn_records (id,plan_id,worn_at,satisfied,note) VALUES ('w1','pl1','t1','yes',NULL)");

    const ok = await startTask(tasks, { requestKey: 'req-del-1' });
    await attributes.commitGarmentAnalysis(ok.id, singleResult);
    const running = await startTask(tasks, { requestKey: 'req-del-2' });

    await items.purgeItem('item-a');

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, '任务随资料删除清理');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attributes').get().n, 0, '属性随资料删除清理');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_items').get().n, 1, '收藏引用保留');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM worn_records').get().n, 1, '穿着记录保留');

    assert.equal(await attributes.commitGarmentAnalysis(running.id, singleResult), 'discarded');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attributes').get().n, 0, '晚返回不得写回任何属性');
    assert.equal((await items.getItem('item-a')).status, 'deleted');
  } finally {
    close();
  }
});

test('revision 递增：确认入库幂等、修改才递增、归档/恢复递增', async () => {
  const { close, items } = await setup({ id: 'item-a', status: 'draft', revision: 1 });
  try {
    await items.confirmItem('item-a', { category: '上衣', name: '衬衫' });
    assert.equal((await items.getItem('item-a')).revision, 2);
    await items.confirmItem('item-a', { category: '上衣', name: '衬衫' });
    assert.equal((await items.getItem('item-a')).revision, 2, '重复确认不递增');

    await items.updateItemBasics('item-a', { name: '衬衫' });
    assert.equal((await items.getItem('item-a')).revision, 2, '无变化不递增');

    await items.updateItemBasics('item-a', { name: '白衬衫' });
    assert.equal((await items.getItem('item-a')).revision, 3);

    await items.archiveItem('item-a');
    assert.equal((await items.getItem('item-a')).revision, 4);
    await items.restoreItem('item-a');
    assert.equal((await items.getItem('item-a')).revision, 5);
    assert.equal((await items.getItem('item-a')).status, 'active');
  } finally {
    close();
  }
});

test('按 main_photo_id 解析分析输入照片；删除后返回 null', async () => {
  const { close, items, photos } = await setup();
  try {
    const found = await photos.getMainPhotoForAnalysis('item-a');
    assert.deepEqual(plain(found), { photoId: 'photo-a', originalPath: 'photos/photo-a.jpg' });
    await items.purgeItem('item-a');
    assert.equal(await photos.getMainPhotoForAnalysis('item-a'), null);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// P5：独立串行执行器
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error('waitFor timed out');
}

/** 组装执行器：仓库用真实实现（内存 SQLite），模型调用与密钥用注入的假实现 */
async function setupRunner(options = {}) {
  const { db, adapter, close } = createMemoryAdapter();
  const { runMigrations } = loadDbModule();
  await runMigrations(adapter);
  const load = createLoader(adapter);
  const repos = {
    items: load(path.join(SRC, 'data/repositories/itemRepository.ts')),
    tasks: load(path.join(SRC, 'data/repositories/taskRepository.ts')),
    attributes: load(path.join(SRC, 'data/repositories/attributeRepository.ts')),
    photos: load(path.join(SRC, 'data/repositories/photoRepository.ts')),
  };
  const runnerModule = load(path.join(SRC, 'services/ai/garmentTaskRunner.ts'));
  const configs = new Map();
  if (options.config) configs.set(options.config.id, options.config);

  const analysisCalls = [];
  const runningDuringCall = [];
  const defaultAnalysis = async (input) => {
    analysisCalls.push(input);
    runningDuringCall.push((await repos.tasks.listTasksByStatus('running')).length);
    return { ok: true, result: singleResult };
  };

  const listeners = new Set();
  const subscribeChanges = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  let savedDefault = null;
  const deps = {
    resolveVisionConfig: async () => options.resolution ?? { status: 'missing' },
    getDefaultConfigId: async () => null,
    setDefaultConfigId: async (id) => {
      savedDefault = id;
    },
    getItem: repos.items.getItem,
    getConfig: (id) => configs.get(id),
    getApiKey: async (keyRef) => options.keys?.[keyRef] ?? 'sk-test',
    getMainPhotoForAnalysis: repos.photos.getMainPhotoForAnalysis,
    readAnalysisImage: async () => ({ ok: true, photoId: 'photo-a', dataUrl: 'data:image/jpeg;base64,AAAA' }),
    createGarmentTask: repos.tasks.createGarmentTask,
    listTasksByStatus: repos.tasks.listTasksByStatus,
    getTask: repos.tasks.getTask,
    markTaskRunning: repos.tasks.markTaskRunning,
    updateTaskStatus: repos.tasks.updateTaskStatus,
    runGarmentAnalysis: options.runGarmentAnalysis ?? defaultAnalysis,
    commitGarmentAnalysis: options.commitGarmentAnalysis ?? repos.attributes.commitGarmentAnalysis,
    subscribeChanges,
  };
  const runner = runnerModule.createGarmentTaskRunner(deps);
  return {
    db,
    adapter,
    close,
    repos,
    configs,
    deps,
    runner,
    runnerModule,
    analysisCalls,
    runningDuringCall,
    notify,
    getSavedDefault: () => savedDefault,
  };
}

const runnerConfig = {
  id: 'cfg-1',
  name: 'GLM 视觉',
  urlKind: 'openai',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'glm-4v',
  capabilities: ['vision'],
  keyRef: 'ai-key-cfg-1',
  hasKey: true,
  testStatus: 'untested',
  callRevision: 'rev-1',
  createdAt: 't1',
  updatedAt: 't1',
};

test('执行器：串行（并发最大 1）、重复启动仍只有一个循环、发送前已写 running', async () => {
  const ctx = await setupRunner({ config: runnerConfig });
  seedItem(ctx.db, {});
  ctx.db.exec(
    "INSERT INTO items (id,status,category,name,source_type,main_photo_id,revision,created_at,updated_at) VALUES ('item-b','active','上衣','衬衫','photo','photo-b','1','t1','t1')",
  );
  ctx.db.exec(
    "INSERT INTO photos (id,item_id,kind,original_path,thumb_path,created_at) VALUES ('photo-b','item-b','main','photos/b.jpg','thumbs/b.jpg','t1')",
  );
  try {
    let concurrent = 0;
    let maxConcurrent = 0;
    ctx.deps.runGarmentAnalysis = async (input) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      ctx.analysisCalls.push(input);
      await delay(15);
      concurrent -= 1;
      return { ok: true, result: singleResult };
    };

    ctx.runner.start();
    ctx.runner.start();
    ctx.runner.start();
    ctx.runner.setForeground(true);

    const first = await ctx.runner.enqueueGarmentAnalysis({
      itemId: 'item-a',
      configId: 'cfg-1',
      trigger: 'auto',
      requestKey: 'act-1:item-a',
    });
    const second = await ctx.runner.enqueueGarmentAnalysis({
      itemId: 'item-b',
      configId: 'cfg-1',
      trigger: 'auto',
      requestKey: 'act-1:item-b',
    });
    assert.equal(first.status, 'created');
    assert.equal(second.status, 'created');

    await waitFor(async () => ctx.analysisCalls.length === 2 && ctx.runner.getPendingCommitCount() === 0);
    await waitFor(async () => (await ctx.repos.tasks.listTasksByStatus('succeeded')).length === 2);

    assert.equal(maxConcurrent, 1, '并发必须为 1');
    assert.equal(ctx.analysisCalls.length, 2, '每件只调用一次（重复启动不得重复执行）');
  } finally {
    ctx.close();
  }
});

test('执行器：启动恢复把遗留 running 标为 interrupted 且不重发', async () => {
  const ctx = await setupRunner({ config: runnerConfig });
  seedItem(ctx.db, {});
  try {
    ctx.db.exec(
      "INSERT INTO tasks (id,kind,item_id,status,input_revision,attempt,photo_id,input_key,request_key,config_id,config_snapshot,config_revision,contract_version,prompt_version,created_at,updated_at,started_at) " +
        "VALUES ('t-run','garment_analysis','item-a','running',1,1,'photo-a','k','r-run','cfg-1','{}','rev-1','1.0.0-draft','1','t1','t1','t1')",
    );

    await ctx.runner.recover();
    const interrupted = await ctx.repos.tasks.listTasksByStatus('interrupted');
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].id, 't-run');

    ctx.runner.setForeground(true);
    await delay(30);
    assert.equal(ctx.analysisCalls.length, 0, '重启后不得重发遗留任务');
  } finally {
    ctx.close();
  }
});

test('执行器：后台不领取；queued 的资料被改过则 stale 且零调用', async () => {
  const ctx = await setupRunner({ config: runnerConfig });
  seedItem(ctx.db, {});
  try {
    const { task } = await ctx.runner.enqueueGarmentAnalysis({
      itemId: 'item-a',
      configId: 'cfg-1',
      trigger: 'auto',
      requestKey: 'act-2:item-a',
    });
    await delay(20);
    assert.equal(ctx.analysisCalls.length, 0, '前台未激活时不领取');
    assert.equal((await ctx.repos.tasks.getTask(task.id)).status, 'queued');

    // 等待期间用户改了资料 → revision 变化
    await ctx.repos.items.updateItemBasics('item-a', { name: '改名后的衬衫' });
    ctx.runner.setForeground(true);
    await waitFor(async () => (await ctx.repos.tasks.getTask(task.id)).status === 'stale');
    assert.equal(ctx.analysisCalls.length, 0, '发送前发现 revision 变化不得发起请求');
  } finally {
    ctx.close();
  }
});

test('执行器：发送前发现配置被改过则 blocked，不把请求改发到新地址', async () => {
  const ctx = await setupRunner({ config: runnerConfig });
  seedItem(ctx.db, {});
  try {
    const { task } = await ctx.runner.enqueueGarmentAnalysis({
      itemId: 'item-a',
      configId: 'cfg-1',
      trigger: 'manual',
      requestKey: 'act-3:item-a',
    });
    ctx.configs.set('cfg-1', { ...runnerConfig, callRevision: 'rev-2', baseUrl: 'https://other.example.com/v1' });

    ctx.runner.setForeground(true);
    await waitFor(async () => (await ctx.repos.tasks.getTask(task.id)).status === 'blocked');
    assert.equal(ctx.analysisCalls.length, 0);
  } finally {
    ctx.close();
  }
});

test('执行器：分析中归档 → 中止在途请求且不提交结果', async () => {
  const ctx = await setupRunner({ config: runnerConfig });
  seedItem(ctx.db, {});
  try {
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    ctx.deps.runGarmentAnalysis = (input) =>
      new Promise((resolve) => {
        started();
        input.signal.addEventListener('abort', () =>
          resolve({ ok: false, error: { kind: 'cancelled', message: '请求已取消' } }),
        );
      });

    ctx.runner.start();
    ctx.runner.setForeground(true);
    const { task } = await ctx.runner.enqueueGarmentAnalysis({
      itemId: 'item-a',
      configId: 'cfg-1',
      trigger: 'auto',
      requestKey: 'act-4:item-a',
    });
    await startedPromise;

    await ctx.repos.items.archiveItem('item-a');
    ctx.notify(); // 通知到达执行器
    await waitFor(async () => (await ctx.repos.tasks.getTask(task.id)).status === 'cancelled');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM attributes').get().n, 0, '归档后不得留下分析属性');
    assert.equal(ctx.runner.getPendingCommitCount(), 0);
  } finally {
    ctx.close();
  }
});

test('执行器：删除后即使中止失败也不可提交（不复活资料）', async () => {
  const ctx = await setupRunner({ config: runnerConfig });
  seedItem(ctx.db, {});
  try {
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    // 假实现故意忽略 signal：模拟“中止失败但请求仍返回”
    ctx.deps.runGarmentAnalysis = async () => {
      started();
      await delay(25);
      return { ok: true, result: singleResult };
    };

    ctx.runner.setForeground(true);
    const { task } = await ctx.runner.enqueueGarmentAnalysis({
      itemId: 'item-a',
      configId: 'cfg-1',
      trigger: 'auto',
      requestKey: 'act-5:item-a',
    });
    await startedPromise;

    await ctx.repos.items.purgeItem('item-a');
    ctx.notify();
    await delay(60);

    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0, '任务随资料删除清理');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM attributes').get().n, 0, '晚返回不得写回任何结果');
    assert.equal((await ctx.repos.items.getItem('item-a')).status, 'deleted');
    assert.equal(ctx.runner.getPendingCommitCount(), 0, 'discarded 的结果不留在内存');
    void task;
  } finally {
    ctx.close();
  }
});

test('执行器：本地提交失败只重试提交，不重新调用模型', async () => {
  const ctx = await setupRunner({ config: runnerConfig });
  seedItem(ctx.db, {});
  try {
    let failOnce = true;
    const realCommit = ctx.repos.attributes.commitGarmentAnalysis;
    ctx.deps.commitGarmentAnalysis = async (taskId, result) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('本地数据库故障');
      }
      return realCommit(taskId, result);
    };

    ctx.runner.setForeground(true);
    const { task } = await ctx.runner.enqueueGarmentAnalysis({
      itemId: 'item-a',
      configId: 'cfg-1',
      trigger: 'auto',
      requestKey: 'act-6:item-a',
    });

    await waitFor(async () => ctx.runner.getPendingCommitCount() === 1);
    assert.equal(ctx.analysisCalls.length, 1, '保存失败不得重新调用模型');
    assert.equal((await ctx.repos.tasks.getTask(task.id)).status, 'running', '任务仍停在 running 等待本地重试');

    await ctx.runner.retryPendingCommits();
    assert.equal(ctx.runner.getPendingCommitCount(), 0);
    assert.equal((await ctx.repos.tasks.getTask(task.id)).status, 'succeeded');
    assert.equal(ctx.analysisCalls.length, 1, '重试只提交本地结果');
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM attributes WHERE analysis_task_id = ?').get(task.id).n,
      3,
    );
  } finally {
    ctx.close();
  }
});

test('执行器：enqueue 的拒绝路径与幂等', async () => {
  const ctx = await setupRunner({ config: runnerConfig });
  seedItem(ctx.db, {});
  try {
    ctx.db.exec(
      "INSERT INTO items (id,status,category,name,source_type,main_photo_id,revision,created_at,updated_at) VALUES ('item-noimg','active',NULL,'无图','photo',NULL,'1','t1','t1')",
    );
    ctx.db.exec(
      "INSERT INTO items (id,status,category,name,source_type,main_photo_id,revision,created_at,updated_at) VALUES ('item-arch','archived','上衣','归档件','photo',NULL,'1','t1','t1')",
    );

    assert.equal((await ctx.runner.enqueueGarmentAnalysis({ itemId: 'missing', configId: 'cfg-1', trigger: 'manual', requestKey: 'k1' })).reason, 'item_missing');
    assert.equal((await ctx.runner.enqueueGarmentAnalysis({ itemId: 'item-arch', configId: 'cfg-1', trigger: 'manual', requestKey: 'k2' })).reason, 'item_unavailable');
    assert.equal((await ctx.runner.enqueueGarmentAnalysis({ itemId: 'item-noimg', configId: 'cfg-1', trigger: 'manual', requestKey: 'k3' })).reason, 'photo_missing');
    assert.equal((await ctx.runner.enqueueGarmentAnalysis({ itemId: 'item-a', configId: 'nope', trigger: 'manual', requestKey: 'k4' })).reason, 'config_invalid');
    assert.equal(
      (await ctx.runner.enqueueGarmentAnalysis({ itemId: 'item-a', configId: 'cfg-1', trigger: 'retry', requestKey: 'k5', retryOfTaskId: 'nope' })).reason,
      'retry_target_invalid',
    );

    // 未指定 configId 且路由未就绪 → config_missing
    assert.equal((await ctx.runner.enqueueGarmentAnalysis({ itemId: 'item-a', trigger: 'auto', requestKey: 'k6' })).reason, 'config_missing');

    // 未指定 configId 但路由就绪 → created 并记住默认
    ctx.deps.resolveVisionConfig = async () => ({ status: 'ready', config: runnerConfig, callRevision: 'rev-1' });
    const ready = await ctx.runner.enqueueGarmentAnalysis({ itemId: 'item-a', trigger: 'auto', requestKey: 'k7' });
    assert.equal(ready.status, 'created');
    assert.equal(ctx.getSavedDefault(), 'cfg-1');

    // 相同 requestKey / 同衣物已有 queued → existing（不重复创建）
    const sameKey = await ctx.runner.enqueueGarmentAnalysis({ itemId: 'item-a', configId: 'cfg-1', trigger: 'auto', requestKey: 'k7' });
    assert.equal(sameKey.status, 'existing');
    const sameItem = await ctx.runner.enqueueGarmentAnalysis({ itemId: 'item-a', configId: 'cfg-1', trigger: 'auto', requestKey: 'k8' });
    assert.equal(sameItem.status, 'existing');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
    assert.equal(ctx.analysisCalls.length, 0, '前台未激活时只排队不调用');
  } finally {
    ctx.close();
  }
});

test('执行器：任务领取与终态落库后触发 onTaskSettled（页面据此刷新）', async () => {
  const ctx = await setupRunner({ config: runnerConfig });
  seedItem(ctx.db, {});
  try {
    let settled = 0;
    ctx.deps.onTaskSettled = () => {
      settled += 1;
    };
    ctx.runner.setForeground(true);
    const { task } = await ctx.runner.enqueueGarmentAnalysis({
      itemId: 'item-a',
      configId: 'cfg-1',
      trigger: 'auto',
      requestKey: 'act-settle:item-a',
    });
    await waitFor(async () => (await ctx.repos.tasks.getTask(task.id)).status === 'succeeded');
    assert.ok(settled >= 2, '领取（running）与完成（succeeded）都应通知页面');
  } finally {
    ctx.close();
  }
});

test('执行器：意外异常不把任务留在 running（发送前 failed，发送后 interrupted）', async () => {
  const before = await setupRunner({ config: runnerConfig });
  seedItem(before.db, {});
  try {
    before.deps.readAnalysisImage = async () => {
      throw new Error('读取照片失败');
    };
    before.runner.setForeground(true);
    const { task } = await before.runner.enqueueGarmentAnalysis({
      itemId: 'item-a',
      configId: 'cfg-1',
      trigger: 'auto',
      requestKey: 'act-err-1',
    });
    await waitFor(async () => (await before.repos.tasks.getTask(task.id)).status === 'failed');
    const failedTask = await before.repos.tasks.getTask(task.id);
    assert.equal(failedTask.errorKind, 'internal', '发送前失败不涉及计费，标 failed');
  } finally {
    before.close();
  }

  const after = await setupRunner({ config: runnerConfig });
  seedItem(after.db, {});
  try {
    after.deps.runGarmentAnalysis = async () => {
      throw new Error('请求发出后宿主异常');
    };
    after.runner.setForeground(true);
    const { task } = await after.runner.enqueueGarmentAnalysis({
      itemId: 'item-a',
      configId: 'cfg-1',
      trigger: 'auto',
      requestKey: 'act-err-2',
    });
    await waitFor(async () => (await after.repos.tasks.getTask(task.id)).status === 'interrupted');
    const interrupted = await after.repos.tasks.getTask(task.id);
    assert.equal(interrupted.errorKind, 'internal', '发送后失败结果未知，标 interrupted 留给用户重试');
  } finally {
    after.close();
  }
});

test('会话辅助：requestKey 与批次记录（P6/P7 复用）', async () => {
  const ctx = await setupRunner();
  try {
    const analysisStore = createLoader(ctx.adapter)(path.join(SRC, 'features/garmentAnalysisStore.ts'));

    const actionId = analysisStore.createActionId();
    assert.equal(analysisStore.requestKeyFor(actionId, 'item-a'), `${actionId}:item-a`);

    analysisStore.setSessionBatch({ actionId, itemIds: ['item-a', 'item-b'] });
    assert.deepEqual(plain(analysisStore.getSessionBatch()), { actionId, itemIds: ['item-a', 'item-b'] });
    analysisStore.removeFromSessionBatch('item-a');
    assert.deepEqual(plain(analysisStore.getSessionBatch().itemIds), ['item-b']);
    analysisStore.clearSessionBatch();
    assert.equal(analysisStore.getSessionBatch(), null);

    let notified = 0;
    const unsubscribe = analysisStore.subscribeAnalysisChanges(() => {
      notified += 1;
    });
    analysisStore.notifyAnalysisChanged();
    analysisStore.notifyAnalysisChanged();
    unsubscribe();
    analysisStore.notifyAnalysisChanged();
    assert.equal(notified, 2);
  } finally {
    ctx.close();
  }
});

test('执行器单例与默认模型记录（P6 录入页与配置页共用）', async () => {
  const ctx = await setupRunner();
  try {
    const analysisStore = createLoader(ctx.adapter)(path.join(SRC, 'features/garmentAnalysisStore.ts'));

    const first = analysisStore.initGarmentTaskRunner();
    const second = analysisStore.initGarmentTaskRunner();
    assert.equal(first, second, '重复初始化必须返回同一执行器单例');
    assert.equal(analysisStore.getGarmentTaskRunner(), first);

    // 未配置视觉模型时解析结果为 missing（配置读自注入的空文件系统）
    assert.equal((await analysisStore.resolveVisionForAnalysis()).status, 'missing');

    assert.equal(await analysisStore.getRememberedVisionConfigId(), null);
    await analysisStore.rememberDefaultVisionConfig('cfg-x');
    assert.equal(await analysisStore.getRememberedVisionConfigId(), 'cfg-x');
    assert.equal(
      ctx.db.prepare("SELECT default_config_id FROM ai_task_preferences WHERE kind = 'garment_analysis'").get()
        .default_config_id,
      'cfg-x',
      '默认模型记在本地任务偏好表',
    );
  } finally {
    ctx.close();
  }
});

test('人工属性写入递增 revision，且不允许写入已删除衣物', async () => {
  const { close, items, attributes } = await setup();
  try {
    assert.equal((await items.getItem('item-a')).revision, 1);

    await attributes.recordUserAttribute({
      itemId: 'item-a',
      field: 'colors',
      value: [{ name: '藏青', hex: '#2B3A4A', isPrimary: true }],
      sourceType: 'user_confirmed',
      sourceRef: '单品详情手动修改',
    });
    assert.equal((await items.getItem('item-a')).revision, 2, '用户修改应推进版本');

    await attributes.recordUserAttribute({
      itemId: 'item-a',
      field: '图案',
      value: '条纹',
      sourceType: 'user_entered',
      sourceRef: '单品详情手动修改',
    });
    assert.equal((await items.getItem('item-a')).revision, 3);

    const view = await attributes.getAnalysisView('item-a');
    assert.equal(view.colors.source, 'user_confirmed');
    assert.deepEqual(plain(view.colors.value), [{ name: '藏青', hex: '#2B3A4A', isPrimary: true }]);
    const pattern = view.attributes.find((a) => a.name === '图案');
    assert.equal(pattern.source, 'user_entered');
    assert.equal(pattern.value, '条纹');

    await items.purgeItem('item-a');
    await assert.rejects(() =>
      attributes.recordUserAttribute({
        itemId: 'item-a',
        field: '图案',
        value: '条纹',
        sourceType: 'user_entered',
        sourceRef: '单品详情手动修改',
      }),
    );
  } finally {
    close();
  }
});

test('人工属性修改使在途分析结果过期（stale），不覆盖用户修改', async () => {
  const { db, close, tasks, attributes } = await setup();
  try {
    const task = await startTask(tasks); // inputRevision = 1
    await attributes.recordUserAttribute({
      itemId: 'item-a',
      field: '图案',
      value: '条纹',
      sourceType: 'user_entered',
      sourceRef: '单品详情手动修改',
    });

    assert.equal(await attributes.commitGarmentAnalysis(task.id, singleResult), 'stale');
    assert.equal((await tasks.getTask(task.id)).status, 'stale');
    assert.equal(aiAttributeCount(db, task.id), 0, '过期结果不得写入任何属性');

    const view = await attributes.getAnalysisView('item-a');
    assert.equal(view.attributes.find((a) => a.name === '图案').value, '条纹', '用户的值保持');
  } finally {
    close();
  }
});
}

module.exports = { createLoader, expoStubs, SRC, CONTRACT_ENTRY, plain, seedItem, setup, startTask, taskInput };
