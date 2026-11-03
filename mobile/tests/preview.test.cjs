// M5 轨 A 回归：上身预览任务管线（入队去重 / 状态机 / 落盘提交 / 失败与中断表达）。
// 使用内存 SQLite + 假生成器；不调用真实图像生成服务。
// 运行：仓库根 `node --test mobile/tests/preview.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const { createMemoryAdapter, loadDbModule } = require('./analysisMigration.test.cjs');

const nodeRequire = require;
const SRC = path.resolve(__dirname, '../src');

function resolveModule(candidate) {
  for (const suffix of ['.ts', '.tsx', '/index.ts', '']) {
    const file = candidate + suffix;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  throw new Error(`cannot resolve module: ${candidate}`);
}

/** 内存文件系统：支持 File/Directory 的 exists/delete/write/move/base64 */
function createFsStub() {
  const files = new Map();
  class File {
    constructor(...parts) {
      this.uri = parts
        .map((p) => (typeof p === 'string' ? p : p && p.uri ? p.uri.replace(/\/+$/, '') : ''))
        .filter(Boolean)
        .join('/');
    }
    get exists() {
      return files.has(this.uri);
    }
    get size() {
      const v = files.get(this.uri);
      return v === undefined ? null : v.length;
    }
    delete() {
      files.delete(this.uri);
    }
    move(target) {
      files.set(target.uri, files.get(this.uri));
      files.delete(this.uri);
    }
    write(content) {
      files.set(this.uri, content);
    }
    async base64() {
      return files.get(this.uri) ?? '';
    }
  }
  class Directory {
    constructor(...parts) {
      this.uri = parts
        .map((p) => (typeof p === 'string' ? p : p && p.uri ? p.uri.replace(/\/+$/, '') : ''))
        .filter(Boolean)
        .join('/');
    }
    get exists() {
      return files.has(this.uri);
    }
    create() {}
  }
  // savePreviewResultImage 使用官方下载 API（M5 轨 A 修复后）
  File.downloadFileAsync = async (url, directory) => {
    const name = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.jpg`;
    const target = new File(directory, name);
    files.set(target.uri, 'downloaded-jpeg-bytes');
    return target;
  };
  return {
    File,
    Directory,
    Paths: { document: { uri: 'file:///document' } },
    files,
  };
}

function createLoader(adapter, fsStub, fetchImpl) {
  const cache = new Map();
  const stubs = {
    'expo-file-system': fsStub,
    'expo-file-system/legacy': {},
    'expo-image-manipulator': {
      SaveFormat: { JPEG: 'jpeg' },
      ImageManipulator: {
        manipulate: () => ({
          resize: () => ({
            renderAsync: async () => ({
              saveAsync: async () => {
                fsStub.files.set('file:///cache/out.jpg', 'rendered-bytes');
                return { uri: 'file:///cache/out.jpg' };
              },
            }),
          }),
          renderAsync: async () => ({
            saveAsync: async () => {
              fsStub.files.set('file:///cache/out.jpg', 'rendered-bytes');
              return { uri: 'file:///cache/out.jpg' };
            },
          }),
        }),
      },
    },
    'expo-sqlite': {},
    'expo-secure-store': {},
    'expo-crypto': {},
  };
  return function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const source = fs.readFileSync(filename, 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    cache.set(filename, module.exports);
    const dir = path.dirname(filename);
    vm.runInNewContext(js, {
      module,
      exports: module.exports,
      console,
      setTimeout,
      clearTimeout,
      AbortController,
      Error,
      fetch: (url, init) => fetchImpl(url, init),
      require(id) {
        if (id in stubs) return stubs[id];
        if (id.startsWith('.')) {
          const resolved = resolveModule(path.resolve(dir, id));
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
  };
}

async function setup() {
  const { db, adapter, close } = createMemoryAdapter();
  const { runMigrations } = loadDbModule();
  await runMigrations(adapter);
  const fsStub = createFsStub();
  // 假下载：生成服务返回的是远程 URL，落盘时按假 fetch 取字节
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  });
  const load = createLoader(adapter, fsStub, fetchImpl);
  const preview = load(path.join(SRC, 'data/repositories/previewRepository.ts'));
  const recommendation = load(path.join(SRC, 'data/repositories/recommendationRepository.ts'));
  const settings = load(path.join(SRC, 'data/repositories/settingsRepository.ts'));
  const runnerModule = load(path.join(SRC, 'services/ai/previewTaskRunner.ts'));
  const config = {
    id: 'cfg-img',
    name: 'MiniMax 图像',
    urlKind: 'minimax',
    baseUrl: 'https://api.example.com',
    modelId: 'image-01',
    capabilities: ['image_gen'],
    keyRef: 'ai-key-cfg-img',
    hasKey: true,
    testStatus: 'passed',
    callRevision: 'rev-1',
    createdAt: 't',
    updatedAt: 't',
  };
  return { db, adapter, close, fsStub, load, preview, recommendation, settings, runnerModule, config };
}

/** vm 上下文对象转普通对象，便于 deepEqual */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseCreateInput(over = {}) {
  return {
    basisItemId: 'item-a',
    itemIds: ['item-a', 'item-b'],
    // C2：入队快照固定各单品资料版本（执行时校验，变化即 stale）
    itemRevisions: { 'item-a': 1, 'item-b': 1 },
    wearStyle: '自然垂放',
    referenceUpdatedAt: '2026-10-30T10:00:00.000Z',
    configId: 'cfg-img',
    configSnapshot: JSON.stringify(configSnapshotValue()),
    configRevision: 'rev-1',
    requestKey: 'req-1',
    ...over,
  };
}

/** C2/C8 执行器依赖桩：发送前复核放行、核对能力缺席（诚实未核对）、无待下载 */
function driftCheckStubs() {
  return {
    validateInput: async () => ({ ok: true }),
    savePendingDownload: async () => {},
    getChecker: async () => ({ status: 'missing' }),
    loadCheckImages: async () => ({ garments: [], person: null, result: null }),
    runCheck: async () => ({ ok: false, kind: 'none', message: '未配置' }),
    saveCheck: async () => {},
  };
}

function configSnapshotValue() {
  return { id: 'cfg-img', name: 'MiniMax 图像', urlKind: 'minimax', baseUrl: 'https://api.example.com', modelId: 'image-01' };
}

test('删除：预览任务删除后记录与生成图一并清除；推荐记录删除仅删行', async () => {
  const ctx = await setup();
  try {
    // 预览：创建 → running → 落盘 → succeeded → 删除 → 行与文件都消失
    const { taskId } = await ctx.preview.createPreviewTask(baseCreateInput());
    await ctx.preview.updatePreviewTaskStatus(taskId, ['queued'], 'running');
    await ctx.preview.savePreviewResultImage(taskId, 'https://cdn.example.com/gen.jpg', '提示词');
    await ctx.preview.updatePreviewTaskStatus(taskId, ['running'], 'succeeded');
    const before = await ctx.preview.getPreviewTask(taskId);
    assert.equal(before.status, 'succeeded');
    assert.ok(before.resultPreviewPath, '生成图路径已记录');
    assert.ok(ctx.fsStub.files.has(`file:///document/${before.resultPreviewPath}`), '生成图已落盘');

    await ctx.preview.deletePreviewTask(taskId);
    assert.equal(await ctx.preview.getPreviewTask(taskId), null, '任务行已删除');
    assert.equal(
      ctx.fsStub.files.has(`file:///document/${before.resultPreviewPath}`),
      false,
      '生成图文件一并删除',
    );

    // 推荐：创建 → 提交候选 → 删除 → 行消失（推荐结果无文件）
    const rec = await ctx.recommendation.createRecommendationTask(
      baseCreateInput({
        requestKey: 'rec-del-1',
        inputKey: JSON.stringify({ itemIds: ['item-a', 'item-b'], wearStyle: '自然垂放' }),
        // M6 批次 1.2 起：推荐任务入队必须携带输入快照（当次场景 + 锁定别名）
        inputJson: JSON.stringify({
          scene: { city: '杭州', day: '今天', scene: '通勤' },
          lockedAliases: [],
        }),
      }),
    );
    await ctx.recommendation.updateRecommendationTaskStatus(rec.taskId, ['queued'], 'running');
    await ctx.recommendation.commitRecommendationResult(rec.taskId, {
      candidates: [{ slots: [{ role: 'top', itemId: 'item-1' }], wearStyle: '自然垂放' }],
      gaps: [],
    });
    const recBefore = await ctx.recommendation.getRecommendationTask(rec.taskId);
    assert.equal(recBefore.candidates.length, 1);
    await ctx.recommendation.deleteRecommendationTask(rec.taskId);
    assert.equal(await ctx.recommendation.getRecommendationTask(rec.taskId), null);
  } finally {
    ctx.close();
  }
});

test('人物参考：保存后可读回（含版本），移除后文件与记录一并清除', async () => {
  const ctx = await setup();
  try {
    // preferences 表有 NOT NULL 的 source/created_at/updated_at —— 插入必须带全列
    const saved = await ctx.preview.savePreviewReference({
      sourceUri: 'file:///cache/in.jpg',
      sourceWidth: 800,
      sourceHeight: 600,
    });
    assert.equal(saved.path, 'preview-ref/reference.jpg');
    assert.ok(saved.updatedAt, '参考版本时间写入记录');

    const read = await ctx.preview.getPreviewReference();
    assert.equal(read.path, 'preview-ref/reference.jpg');
    assert.equal(read.updatedAt, saved.updatedAt);
    assert.equal(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM preferences WHERE id = 'preview-reference'").get().n,
      1,
      '记录已落库',
    );

    await ctx.preview.removePreviewReference();
    assert.equal(await ctx.preview.getPreviewReference(), null);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM preferences WHERE id = 'preview-reference'").get().n, 0);
  } finally {
    ctx.close();
  }
});

test('人物参考自愈：文件在但记录缺失时自动重建记录，不要求用户重选', async () => {
  const ctx = await setup();
  try {
    // 模拟"文件已落盘、记录写入失败"（曾发生的真实故障）
    ctx.fsStub.files.set('file:///document/preview-ref/reference.jpg', 'jpeg-bytes');
    assert.equal(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM preferences WHERE id = 'preview-reference'").get().n,
      0,
      '前置：记录不存在',
    );

    const recovered = await ctx.preview.getPreviewReference();
    assert.ok(recovered, '应从存在的文件恢复出参考');
    assert.equal(recovered.path, 'preview-ref/reference.jpg');
    assert.equal(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM preferences WHERE id = 'preview-reference'").get().n,
      1,
      '记录已重建',
    );

    // 文件也没有时不得凭空造参考
    ctx.fsStub.files.delete('file:///document/preview-ref/reference.jpg');
    await ctx.preview.removePreviewReference();
    assert.equal(await ctx.preview.getPreviewReference(), null);
  } finally {
    ctx.close();
  }
});

test('preferences 共享表：偏好项与颜色库/人物参考互不干扰（读取与删除都不越界）', async () => {
  const ctx = await setup();
  try {
    // 先写入人物参考（占用 preferences 表一行）
    ctx.fsStub.files.set('file:///document/preview-ref/reference.jpg', 'jpeg-bytes');
    await ctx.preview.getPreviewReference();
    assert.equal(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM preferences WHERE id = 'preview-reference'").get().n,
      1,
    );

    // 设置偏好：不得删除人物参考记录
    await ctx.settings.setPreferences(['简约日常']);
    assert.deepEqual(plain(await ctx.settings.getPreferences()), ['简约日常']);
    assert.equal(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM preferences WHERE id = 'preview-reference'").get().n,
      1,
      '设置偏好不得清掉其他用途的记录',
    );

    // 人物参考仍可读
    assert.ok(await ctx.preview.getPreviewReference());
  } finally {
    ctx.close();
  }
});

test('入队：requestKey 幂等；相同输入且有活动任务时去重；输入指纹含单品与参考版本', async () => {
  const ctx = await setup();
  try {
    const first = await ctx.preview.createPreviewTask(baseCreateInput());
    assert.equal(first.status, 'created');

    const same = await ctx.preview.createPreviewTask(baseCreateInput());
    assert.equal(same.status, 'existing');
    assert.equal(same.taskId, first.taskId);

    // 不同 requestKey 但相同输入（仍在 queued）→ 去重
    const dup = await ctx.preview.createPreviewTask(baseCreateInput({ requestKey: 'req-2' }));
    assert.equal(dup.status, 'existing');

    // 参考版本变化 → 输入指纹不同 → 新任务
    const other = await ctx.preview.createPreviewTask(
      baseCreateInput({ requestKey: 'req-3', referenceUpdatedAt: '2026-10-31T10:00:00.000Z' }),
    );
    assert.equal(other.status, 'created');
    assert.notEqual(other.taskId, first.taskId);
  } finally {
    ctx.close();
  }
});

test('执行器：生成成功后落盘并标 succeeded；结果路径可读', async () => {
  const ctx = await setup();
  try {
    const { taskId } = await ctx.preview.createPreviewTask(baseCreateInput());
    const calls = [];
    const runner = ctx.runnerModule.createPreviewTaskRunner({
      listQueued: () => ctx.preview.listPreviewTasksByStatus('queued'),
      listRunning: () => ctx.preview.listPreviewTasksByStatus('running'),
      getTask: ctx.preview.getPreviewTask,
      markRunning: (id) => ctx.preview.updatePreviewTaskStatus(id, ['queued'], 'running'),
      updateStatus: ctx.preview.updatePreviewTaskStatus,
      getConfig: () => ctx.config,
      getApiKey: async () => 'sk-test',
      readReferenceDataUrl: async () => ({ dataUrl: 'data:image/jpeg;base64,AAA', updatedAt: 'x' }),
      describeItems: async (ids) =>
        ids.map((id) => ({
          itemId: id,
          name: `衣${id}`,
          category: '上衣',
          mainColor: { name: '白', hex: '#FFFFFF' },
          accentColorNames: [],
          keyFeatures: ['图案=纯色', '领型=翻领'],
          secondary: [`描述=衣${id}描述`],
          wearStyle: null,
        })),
      generate: async (input) => {
        calls.push(input);
        return { ok: true, imageUrl: 'https://cdn.example.com/gen1.jpg' };
      },
      saveResultImage: (id, url, prompt) => ctx.preview.savePreviewResultImage(id, url, prompt),
      ...driftCheckStubs(),
    });

    runner.setForeground(true);
    await waitFor(async () => (await ctx.preview.getPreviewTask(taskId)).status === 'succeeded');

    const task = await ctx.preview.getPreviewTask(taskId);
    assert.equal(task.status, 'succeeded');
    assert.ok(task.resultPreviewPath, '结果路径已记录');
    assert.equal(calls.length, 1, '只调用一次生成');
    assert.equal(calls[0].personDataUrl.startsWith('data:image/jpeg'), true, '人物参考以 data URL 传入');
    // C7：提示词按重要性组织——单品身份行含品类/名称/主色 hex/关键特征
    assert.equal(
      calls[0].prompt.includes('1. 上衣；名称=衣item-a；主色=白(#FFFFFF)；图案=纯色，领型=翻领；细节：描述=衣item-a描述'),
      true,
      '提示词含单品身份行（品类/名称/主色/关键特征）',
    );
    assert.equal(calls[0].prompt.includes('从头到脚完整呈现'), true, '提示词要求全身完整不裁切');
  } finally {
    ctx.close();
  }
});

test('执行器：生成失败标 failed；结果未知（超时）标 interrupted 可重试', async () => {
  const ctx = await setup();
  try {
    const failedTask = await ctx.preview.createPreviewTask(baseCreateInput({ requestKey: 'r-fail' }));
    const failRunner = ctx.runnerModule.createPreviewTaskRunner({
      listQueued: () => ctx.preview.listPreviewTasksByStatus('queued'),
      listRunning: () => ctx.preview.listPreviewTasksByStatus('running'),
      getTask: ctx.preview.getPreviewTask,
      markRunning: (id) => ctx.preview.updatePreviewTaskStatus(id, ['queued'], 'running'),
      updateStatus: ctx.preview.updatePreviewTaskStatus,
      getConfig: () => ctx.config,
      getApiKey: async () => 'sk-test',
      readReferenceDataUrl: async () => ({ dataUrl: 'data:image/jpeg;base64,AAA', updatedAt: 'x' }),
      describeItems: async () => [],
      generate: async () => ({ ok: false, kind: 'auth', message: 'HTTP 401' }),
      saveResultImage: async () => '',
      ...driftCheckStubs(),
    });
    failRunner.setForeground(true);
    await waitFor(async () => (await ctx.preview.getPreviewTask(failedTask.taskId)).status === 'failed');
    const failed = await ctx.preview.getPreviewTask(failedTask.taskId);
    assert.equal(failed.errorKind, 'auth');
    assert.equal(failed.errorSummary, 'HTTP 401');

    // 超时 → interrupted（结果未知，不自动重发）
    const timeoutTask = await ctx.preview.createPreviewTask(baseCreateInput({ requestKey: 'r-timeout' }));
    const timeoutRunner = ctx.runnerModule.createPreviewTaskRunner({
      listQueued: () => ctx.preview.listPreviewTasksByStatus('queued'),
      listRunning: () => ctx.preview.listPreviewTasksByStatus('running'),
      getTask: ctx.preview.getPreviewTask,
      markRunning: (id) => ctx.preview.updatePreviewTaskStatus(id, ['queued'], 'running'),
      updateStatus: ctx.preview.updatePreviewTaskStatus,
      getConfig: () => ctx.config,
      getApiKey: async () => 'sk-test',
      readReferenceDataUrl: async () => ({ dataUrl: 'data:image/jpeg;base64,AAA', updatedAt: 'x' }),
      describeItems: async () => [],
      generate: async () => ({ ok: false, kind: 'timeout', message: '请求超时' }),
      saveResultImage: async () => '',
      ...driftCheckStubs(),
    });
    timeoutRunner.setForeground(true);
    await waitFor(async () => (await ctx.preview.getPreviewTask(timeoutTask.taskId)).status === 'interrupted');
    assert.equal((await ctx.preview.getPreviewTask(timeoutTask.taskId)).errorKind, 'timeout');
  } finally {
    ctx.close();
  }
});

test('执行器：人物参考缺失标 failed(reference_missing)，不发生成请求', async () => {
  const ctx = await setup();
  try {
    const task = await ctx.preview.createPreviewTask(baseCreateInput());
    let generated = 0;
    const runner = ctx.runnerModule.createPreviewTaskRunner({
      listQueued: () => ctx.preview.listPreviewTasksByStatus('queued'),
      listRunning: () => ctx.preview.listPreviewTasksByStatus('running'),
      getTask: ctx.preview.getPreviewTask,
      markRunning: (id) => ctx.preview.updatePreviewTaskStatus(id, ['queued'], 'running'),
      updateStatus: ctx.preview.updatePreviewTaskStatus,
      getConfig: () => ctx.config,
      getApiKey: async () => 'sk-test',
      readReferenceDataUrl: async () => null,
      describeItems: async () => [],
      generate: async () => {
        generated += 1;
        return { ok: true, imageUrl: 'https://cdn.example.com/x.jpg' };
      },
      saveResultImage: async () => '',
      ...driftCheckStubs(),
    });
    runner.setForeground(true);
    await waitFor(async () => (await ctx.preview.getPreviewTask(task.taskId)).status === 'failed');
    const failed = await ctx.preview.getPreviewTask(task.taskId);
    assert.equal(failed.errorKind, 'reference_missing');
    assert.equal(generated, 0, '缺参考时不得发起生成');
  } finally {
    ctx.close();
  }
});

test('执行器：启动恢复把遗留 running 标为 interrupted（不重发）', async () => {
  const ctx = await setup();
  try {
    const task = await ctx.preview.createPreviewTask(baseCreateInput());
    await ctx.preview.updatePreviewTaskStatus(task.taskId, ['queued'], 'running');

    let generated = 0;
    const runner = ctx.runnerModule.createPreviewTaskRunner({
      listQueued: () => ctx.preview.listPreviewTasksByStatus('queued'),
      listRunning: () => ctx.preview.listPreviewTasksByStatus('running'),
      getTask: ctx.preview.getPreviewTask,
      markRunning: (id) => ctx.preview.updatePreviewTaskStatus(id, ['queued'], 'running'),
      updateStatus: ctx.preview.updatePreviewTaskStatus,
      getConfig: () => ctx.config,
      getApiKey: async () => 'sk-test',
      readReferenceDataUrl: async () => ({ dataUrl: 'data:image/jpeg;base64,AAA', updatedAt: 'x' }),
      describeItems: async () => [],
      generate: async () => {
        generated += 1;
        return { ok: true, imageUrl: 'https://cdn.example.com/x.jpg' };
      },
      saveResultImage: async () => '',
      ...driftCheckStubs(),
    });
    await runner.recover();
    const recovered = await ctx.preview.getPreviewTask(task.taskId);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.errorKind, 'interrupted');
    assert.equal(generated, 0, '恢复不得重发');
  } finally {
    ctx.close();
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error('waitFor timed out');
}
