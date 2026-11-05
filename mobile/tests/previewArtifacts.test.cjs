// S2 回归（评估 §8.3/§8.4/§8.5，2026-11-04）：
// - F3：预览输入指纹含有效逐件穿法（仅改外套穿法=新输入；键序无关）；提示词版本 2
// - F6：产物条件提交（状态+指针 CAS）；迟到执行者不得写入；仅重试下载走条件提交
// - F1：核对针对刚提交的产物（真实 runner+仓库联动贯通 ready 路径）
// - 纠偏：重大偏离 → 至多一次纠偏 → 新产物重新核对；原产物与判定保留
// - F7：比较绑定不可变产物并校验共同条件（同参考不同配置拒绝）
// - 启动恢复：遗留 checking/correcting 后处理标 interrupted；queued 可继续
// 使用内存 SQLite + 内存文件系统 + 假生成/核对；不调用真实模型。
// 运行：仓库根 `node --test mobile/tests/previewArtifacts.test.cjs`

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

/** 内存文件系统：File/Directory + modificationTime（活动写入保护用；oldFiles 标记足够老的文件） */
function createFsStub() {
  const files = new Map();
  const oldFiles = new Set();
  class File {
    constructor(...parts) {
      this.uri = parts
        .map((p) => (typeof p === 'string' ? p : p && p.uri ? p.uri.replace(/\/+$/, '') : ''))
        .filter(Boolean)
        .join('/');
    }
    get name() {
      return this.uri.split('/').pop() ?? '';
    }
    get modificationTime() {
      return oldFiles.has(this.uri) ? Date.now() - 2 * 60 * 60 * 1000 : Date.now();
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
      const v = files.get(this.uri);
      if (v === undefined) throw new Error('file missing');
      return Buffer.from(v).toString('base64');
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
      return files.has(this.uri) || [...files.keys()].some((k) => k.startsWith(`${this.uri}/`));
    }
    create() {}
    list() {
      return [...files.keys()]
        .filter((k) => k.startsWith(`${this.uri}/`))
        .map((k) => new File(k));
    }
  }
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
    oldFiles,
  };
}

function createLoader(adapter, fsStub) {
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
  const load = createLoader(adapter, fsStub);
  const preview = load(path.join(SRC, 'data/repositories/previewRepository.ts'));
  const postprocess = load(path.join(SRC, 'data/repositories/previewPostprocessRepository.ts'));
  const checks = load(path.join(SRC, 'data/repositories/previewCheckRepository.ts'));
  const maintenance = load(path.join(SRC, 'data/repositories/maintenanceRepository.ts'));
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
  return { db, adapter, close, fsStub, load, preview, postprocess, checks, maintenance, runnerModule, config };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error('waitFor timed out');
}

function baseCreateInput(over = {}) {
  return {
    basisItemId: 'item-a',
    itemIds: ['item-a', 'item-b'],
    itemRevisions: { 'item-a': 1, 'item-b': 1 },
    wearStyle: '自然垂放',
    itemWear: {},
    referenceKind: 'full_body',
    referenceUpdatedAt: '2026-11-04T10:00:00.000Z',
    configId: 'cfg-img',
    configSnapshot: JSON.stringify({ id: 'cfg-img', name: 'MiniMax 图像', urlKind: 'minimax', baseUrl: 'https://api.example.com', modelId: 'image-01' }),
    configRevision: 'rev-1',
    requestKey: `req-${Math.random().toString(36).slice(2, 8)}`,
    ...over,
  };
}

/** 生成一个 succeeded 任务并绑定产物（比较/纠偏测试的前置） */
async function createSucceededTask(ctx, over = {}) {
  const { taskId } = await ctx.preview.createPreviewTask(baseCreateInput(over));
  await ctx.preview.updatePreviewTaskStatus(taskId, ['queued'], 'running');
  const committed = await ctx.preview.downloadAndCommitArtifact({
    taskId,
    remoteUrl: `https://cdn.example.com/${taskId}.jpg`,
    prompt: '提示词',
    inputKey: (await ctx.preview.getPreviewTask(taskId)).inputKey,
    configId: over.configId ?? 'cfg-img',
    attempt: 0,
    expectedStatus: ['running'],
  });
  assert.ok(committed.ok, '前置：产物提交成功');
  await ctx.preview.updatePreviewTaskStatus(taskId, ['running'], 'succeeded');
  return { taskId, artifact: committed.artifact };
}

// ---------------------------------------------------------------------------
// F3：输入指纹与匹配
// ---------------------------------------------------------------------------

test('F3：仅改逐件穿法产生新指纹；键序无关；previewInputMatches 含逐件穿法', async () => {
  const ctx = await setup();
  try {
    const base = { itemIds: ['item-a', 'item-b'], itemRevisions: { 'item-a': 1, 'item-b': 1 }, wearStyle: '自然垂放', itemWear: {}, referenceUpdatedAt: 'r1' };
    const keyNone = ctx.preview.buildPreviewInputKey({ ...base, configId: 'c', configRevision: 'r' });
    const keyOrder = ctx.preview.buildPreviewInputKey({
      ...base,
      itemRevisions: { 'item-b': 1, 'item-a': 1 },
      itemIds: ['item-b', 'item-a'],
      configId: 'c',
      configRevision: 'r',
    });
    assert.equal(keyNone, keyOrder, '键序/数组顺序变化不产生新指纹');

    // 只把外套穿法从自然垂放改为敞开 → 新指纹（F3 缺陷回归）
    const keyOpen = ctx.preview.buildPreviewInputKey({ ...base, itemWear: { 'item-b': '外层敞开穿' }, configId: 'c', configRevision: 'r' });
    assert.notEqual(keyNone, keyOpen);

    const task = await ctx.preview.createPreviewTask(
      baseCreateInput({ itemWear: { 'item-b': '外层敞开穿' }, requestKey: 'f3-1' }),
    );
    const stored = JSON.parse((await ctx.preview.getPreviewTask(task.taskId)).inputJson);
    assert.equal(stored.inputVersion, 2);
    assert.deepEqual(stored.itemWear, { 'item-b': '外层敞开穿' });

    const inputKey = (await ctx.preview.getPreviewTask(task.taskId)).inputKey;
    assert.equal(
      ctx.preview.previewInputMatches(
        { inputKey },
        {
          itemIds: ['item-a', 'item-b'],
          itemRevisions: { 'item-a': 1, 'item-b': 1 },
          wearStyle: '自然垂放',
          itemWear: { 'item-b': '外层敞开穿' },
          referenceUpdatedAt: '2026-11-04T10:00:00.000Z',
          referenceKind: 'full_body',
        },
      ),
      true,
      '逐件穿法一致 → 本方案',
    );
    assert.equal(
      ctx.preview.previewInputMatches(
        { inputKey },
        {
          itemIds: ['item-a', 'item-b'],
          itemRevisions: { 'item-a': 1, 'item-b': 1 },
          wearStyle: '自然垂放',
          itemWear: {},
          referenceUpdatedAt: '2026-11-04T10:00:00.000Z',
          referenceKind: 'full_body',
        },
      ),
      false,
      '仅外套穿法不同 → 方案已变化（F3 缺陷回归）',
    );
    assert.equal(ctx.preview.PREVIEW_PROMPT_VERSION, '2', '提示词版本已升级（不冒充历史 v1）');
  } finally {
    ctx.close();
  }
});

// ---------------------------------------------------------------------------
// F6：条件提交
// ---------------------------------------------------------------------------

test('F6：running 状态条件提交成功；任务已终态时迟到提交被拒且文件清理', async () => {
  const ctx = await setup();
  try {
    const { taskId } = await ctx.preview.createPreviewTask(baseCreateInput({ requestKey: 'f6-a' }));
    await ctx.preview.updatePreviewTaskStatus(taskId, ['queued'], 'running');
    const committed = await ctx.preview.downloadAndCommitArtifact({
      taskId,
      remoteUrl: 'https://cdn.example.com/1.jpg',
      prompt: 'p',
      inputKey: 'k',
      configId: 'cfg-img',
      attempt: 0,
      expectedStatus: ['running'],
    });
    assert.ok(committed.ok);
    const artifactRow = ctx.db.prepare('SELECT * FROM preview_artifacts WHERE id = ?').get(committed.artifact.artifactId);
    assert.equal(artifactRow.attempt, 0);
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM preview_postprocess WHERE artifact_id = ?').get(committed.artifact.artifactId).n,
      1,
      '产物提交即入队后处理',
    );

    // 任务已 interrupted（看门狗/取消先行）→ 迟到提交拒绝，下载产物被清理
    const task2 = await ctx.preview.createPreviewTask(baseCreateInput({ requestKey: 'f6-b' }));
    await ctx.preview.updatePreviewTaskStatus(task2.taskId, ['queued'], 'running');
    await ctx.preview.updatePreviewTaskStatus(task2.taskId, ['running'], 'interrupted', { finishedAt: 't' });
    const before = [...ctx.fsStub.files.keys()].filter((k) => k.includes('/previews/')).length;
    const late = await ctx.preview.downloadAndCommitArtifact({
      taskId: task2.taskId,
      remoteUrl: 'https://cdn.example.com/2.jpg',
      prompt: 'p',
      inputKey: 'k',
      configId: 'cfg-img',
      attempt: 0,
      expectedStatus: ['running'],
    });
    assert.deepEqual(plain(late), { ok: false, reason: 'state_changed' });
    const after = [...ctx.fsStub.files.keys()].filter((k) => k.includes('/previews/')).length;
    assert.equal(after, before, '迟到下载产物已清理');

    // 指针 CAS：已有产物时无 CAS 的重复提交被拒
    const dup = await ctx.preview.downloadAndCommitArtifact({
      taskId,
      remoteUrl: 'https://cdn.example.com/3.jpg',
      prompt: 'p',
      inputKey: 'k',
      configId: 'cfg-img',
      attempt: 0,
      expectedStatus: ['succeeded'],
    });
    assert.deepEqual(plain(dup), { ok: false, reason: 'state_changed' }, '已有指针时拒绝新产物');
  } finally {
    ctx.close();
  }
});

test('F6：仅重试下载走条件提交（failed → succeeded + 后处理入队）', async () => {
  const ctx = await setup();
  try {
    const { taskId } = await ctx.preview.createPreviewTask(baseCreateInput({ requestKey: 'f6-retry' }));
    await ctx.preview.updatePreviewTaskStatus(taskId, ['queued'], 'running');
    // 模拟"生成成功但保存失败"：写入 pendingUrl，任务 failed
    await ctx.preview.savePendingDownload(taskId, 'https://cdn.example.com/pending.jpg', '提示词');
    await ctx.preview.updatePreviewTaskStatus(taskId, ['running'], 'failed', {
      finishedAt: 't',
      errorKind: 'save_failed',
      errorSummary: '落盘失败',
    });
    // 迟到的 savePendingDownload 不得覆盖已终态任务
    const lateWrite = await ctx.preview.savePendingDownload(taskId, 'https://cdn.example.com/late.jpg', 'x');
    assert.equal(lateWrite, false, '终态任务拒绝写入待下载');

    const path = await ctx.preview.retryPreviewDownload(taskId);
    const task = await ctx.preview.getPreviewTask(taskId);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.resultPreviewPath, path);
    assert.ok(task.resultArtifactId, '重试下载也形成产物');
    assert.equal(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM preview_postprocess WHERE task_id = ?').get(taskId).n,
      1,
      '重试成功后进入同一待核对流程',
    );
  } finally {
    ctx.close();
  }
});

// ---------------------------------------------------------------------------
// F1：核对针对刚提交的产物（真实 runner + 仓库联动）
// ---------------------------------------------------------------------------

function runnerDeps(ctx, hooks = {}) {
  const generateCalls = [];
  const checkCalls = [];
  const captured = { artifactPaths: [] };
  const deps = {
    listQueued: () => ctx.preview.listPreviewTasksByStatus('queued'),
    listRunning: () => ctx.preview.listPreviewTasksByStatus('running'),
    getTask: ctx.preview.getPreviewTask,
    markRunning: (id) => ctx.preview.updatePreviewTaskStatus(id, ['queued'], 'running'),
    updateStatus: ctx.preview.updatePreviewTaskStatus,
    getConfig: () => ctx.config,
    getApiKey: async () => 'sk-test',
    readReferenceDataUrl: async () => ({ dataUrl: 'data:image/jpeg;base64,PERSON', updatedAt: '2026-11-04T10:00:00.000Z' }),
    describeItems: async (ids, itemWear) =>
      ids.map((id) => ({
        itemId: id,
        name: `衣${id}`,
        category: '上衣',
        mainColor: { name: '白', hex: '#FFFFFF' },
        accentColorNames: [],
        keyFeatures: ['领型=翻领'],
        secondary: [],
        wearStyle: itemWear?.[id] ?? null,
      })),
    validateInput: async () => ({ ok: true }),
    generate: async (input) => {
      generateCalls.push(input);
      return { ok: true, imageUrl: `https://cdn.example.com/gen-${generateCalls.length}.jpg` };
    },
    commitArtifact: (input) => ctx.preview.downloadAndCommitArtifact(input),
    savePendingDownload: (taskId, url, prompt) => ctx.preview.savePendingDownload(taskId, url, prompt),
    postprocess: {
      claim: () => ctx.postprocess.claimNextPostProcess(),
      updateStage: (id, allowedFrom, to, patch) => ctx.postprocess.updatePostProcessStage(id, allowedFrom, to, patch),
      getArtifact: (artifactId) => ctx.preview.getPreviewArtifact(artifactId),
      recoverInFlight: () => ctx.postprocess.recoverInFlightPostProcess(),
    },
    getChecker: async () => ({
      status: 'ready',
      config: { id: 'chk', urlKind: 'openai', baseUrl: 'https://chk.example.com', modelId: 'vision' },
      apiKey: 'sk-chk',
      callRevision: 'chk-rev-1',
    }),
    loadCheckImages: async ({ artifactPath }) => {
      captured.artifactPaths.push(artifactPath);
      return {
        garments: [
          { itemId: 'item-a', dataUrl: 'data:image/jpeg;base64,AAA', imageIndex: 1 },
          { itemId: 'item-b', dataUrl: null, imageIndex: null }, // 缺原图：显式 null，不过滤重排
        ],
        person: 'data:image/jpeg;base64,PERSON',
        result: 'data:image/jpeg;base64,RESULT',
      };
    },
    runCheck: async (input) => {
      checkCalls.push(input);
      return hooks.checkContent
        ? { ok: true, content: hooks.checkContent(checkCalls.length) }
        : { ok: true, content: '{"items":[{"itemId":"item-a","status":"match"},{"itemId":"item-b","status":"unknown","note":"未附原图"}],"overall":"match"}' };
    },
    saveCheck: (record) => ctx.checks.savePreviewCheck(record),
    ...hooks.override,
  };
  return { deps, generateCalls, checkCalls, captured };
}

test('F1：生成→条件提交→核对刚保存的产物→checked（记录关联产物与附图索引）', async () => {
  const ctx = await setup();
  try {
    const { taskId } = await ctx.preview.createPreviewTask(
      baseCreateInput({ requestKey: 'f1-a', itemWear: { 'item-b': '外层敞开穿' } }),
    );
    const harness = runnerDeps(ctx);
    const runner = ctx.runnerModule.createPreviewTaskRunner(harness.deps);
    runner.setForeground(true);
    await waitFor(async () => {
      const post = await ctx.postprocess.getLatestPostProcess(taskId);
      return post && ['checked', 'unchecked', 'unknown', 'interrupted'].includes(post.stage);
    });
    runner.setForeground(false);

    const task = await ctx.preview.getPreviewTask(taskId);
    assert.equal(task.status, 'succeeded');
    const post = await ctx.postprocess.getLatestPostProcess(taskId);
    assert.equal(post.stage, 'checked');
    // F1：核对读取的是刚提交产物的路径（生成前 task.resultPreviewPath 为 null）
    assert.equal(harness.captured.artifactPaths.length, 1);
    assert.equal(harness.captured.artifactPaths[0], task.resultPreviewPath);
    assert.equal(task.resultArtifactId, post.artifactId);
    const check = await ctx.checks.getLatestPreviewCheck(taskId);
    assert.equal(check.artifactId, task.resultArtifactId, '核对记录关联具体产物');
    assert.equal(check.overall, 'match');
    // 附图索引进入约束（缺图件 null，不过滤重排）
    assert.match(harness.checkCalls[0].userPrompt, /图1=单品「衣item-a」/);
    assert.match(harness.checkCalls[0].userPrompt, /（本次未附原图[^）]*）=单品「衣item-b」/);
    assert.equal(harness.checkCalls[0].images.length, 3, '1 张原图 + 人物参考 + 生成结果');
    // 逐件穿法进核对约束
    assert.match(harness.checkCalls[0].userPrompt, /穿法=外层敞开穿/);
    assert.equal(harness.generateCalls.length, 1, '无重大偏离不纠偏');
  } finally {
    ctx.close();
  }
});

test('纠偏：重大偏离 → 至多一次纠偏 → 新产物重新核对；原产物与判定保留', async () => {
  const ctx = await setup();
  try {
    const { taskId } = await ctx.preview.createPreviewTask(baseCreateInput({ requestKey: 'corr-1' }));
    const majorVerdicts =
      '{"items":[{"itemId":"item-a","status":"deviate","note":"颜色变了"},{"itemId":"item-b","status":"match"}],"overall":"major"}';
    const matchVerdicts =
      '{"items":[{"itemId":"item-a","status":"match"},{"itemId":"item-b","status":"match"}],"overall":"match"}';
    const harness = runnerDeps(ctx, {
      checkContent: (callIndex) => (callIndex === 1 ? majorVerdicts : matchVerdicts),
    });
    const runner = ctx.runnerModule.createPreviewTaskRunner(harness.deps);
    runner.setForeground(true);
    await waitFor(async () => {
      const rows = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM preview_postprocess WHERE task_id = ? AND stage = 'checked'")
        .get(taskId).n;
      const latest = await ctx.checks.getLatestPreviewCheck(taskId);
      return rows >= 2 && latest && latest.overall === 'match';
    });
    runner.setForeground(false);

    // 两次生成；第二次提示词带纠偏约束
    assert.equal(harness.generateCalls.length, 2, '重大偏离只自动纠偏一次');
    assert.match(harness.generateCalls[1].prompt, /重点约束/);
    assert.match(harness.generateCalls[1].prompt, /颜色变了/);
    // 新旧产物都在（不可变），指针指向新产物
    const artifacts = ctx.db.prepare('SELECT id, attempt, path FROM preview_artifacts WHERE task_id = ? ORDER BY attempt ASC').all(taskId);
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[0].attempt, 0);
    assert.equal(artifacts[1].attempt, 1);
    const task = await ctx.preview.getPreviewTask(taskId);
    assert.equal(task.resultArtifactId, artifacts[1].id, '指针指向纠偏新产物');
    // 两条核对记录各自关联产物；最新为对新产物的 match
    const allChecks = ctx.db.prepare('SELECT artifact_id, overall FROM preview_checks WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
    assert.equal(allChecks.length, 2);
    assert.equal(allChecks[0].artifact_id, artifacts[0].id);
    assert.equal(allChecks[0].overall, 'major');
    assert.equal(allChecks[1].artifact_id, artifacts[1].id);
    assert.equal(allChecks[1].overall, 'match');
    // 第二次核对读取的是新产物路径
    assert.equal(harness.captured.artifactPaths[1], artifacts[1].path);
  } finally {
    ctx.close();
  }
});

test('启动恢复：遗留 checking 后处理标 interrupted；queued 不受影响', async () => {
  const ctx = await setup();
  try {
    const { taskId, artifact } = await createSucceededTask(ctx, { requestKey: 'rec-1' });
    const ppId = await ctx.postprocess.createPreviewPostProcess({ taskId, artifactId: artifact.artifactId, attempt: 0 });
    await ctx.postprocess.updatePostProcessStage(ppId, ['queued'], 'checking');
    // 另一条保持 queued
    const { taskId: task2, artifact: artifact2 } = await createSucceededTask(ctx, { requestKey: 'rec-2', referenceUpdatedAt: '2026-11-04T11:00:00.000Z' });
    await ctx.postprocess.createPreviewPostProcess({ taskId: task2, artifactId: artifact2.artifactId, attempt: 0 });

    const runnerDepsStub = runnerDeps(ctx);
    const runner = ctx.runnerModule.createPreviewTaskRunner(runnerDepsStub.deps);
    await runner.recover();
    const recovered = await ctx.postprocess.getLatestPostProcess(taskId);
    assert.equal(recovered.stage, 'interrupted');
    const queuedRow = await ctx.postprocess.getLatestPostProcess(task2);
    assert.equal(queuedRow.stage, 'queued', '未发送的核对可继续');
  } finally {
    ctx.close();
  }
});

// ---------------------------------------------------------------------------
// F7：比较绑定不可变产物并校验共同条件
// ---------------------------------------------------------------------------

test('F7：同条件可比并绑定产物；不同配置拒绝；legacy（无产物）不冒充同条件', async () => {
  const ctx = await setup();
  try {
    const a = await createSucceededTask(ctx, { requestKey: 'cmp-a' });
    const b = await createSucceededTask(ctx, { requestKey: 'cmp-b', referenceUpdatedAt: '2026-11-04T10:00:00.000Z' });
    const ok = await ctx.preview.createPreviewComparison(a.taskId, b.taskId);
    assert.ok(ok.ok, '同参考同配置可比');
    assert.equal(ok.comparison.artifactAId, a.artifact.artifactId);
    assert.equal(ok.comparison.artifactBId, b.artifact.artifactId);
    assert.equal(ok.comparison.conditions.configId, 'cfg-img');
    assert.equal(ok.comparison.conditions.promptVersion, '2');
    assert.equal(ok.comparison.conditions.aspectRatio, '2:3');

    // 纠偏/指针移动后旧比较仍指原图（产物不可变）
    await ctx.db.prepare('UPDATE tasks SET result_artifact_id = ? WHERE id = ?').run('moved-artifact', a.taskId);
    const reread = await ctx.preview.getPreviewComparison(ok.comparison.id);
    assert.equal(reread.artifactAId, a.artifact.artifactId, '比较绑定的是当时的不可变产物');

    // 不同配置 → 拒绝（不把模型差异误当成搭配差异）
    const c = await createSucceededTask(ctx, { requestKey: 'cmp-c', configId: 'cfg-other', configRevision: 'rev-9' });
    const diff = await ctx.preview.createPreviewComparison(a.taskId, c.taskId);
    assert.equal(diff.ok, false);
    assert.match(diff.message, /条件不同/);
    assert.match(diff.message, /模型配置/);

    // legacy：无产物指针的旧记录 → 拒绝
    await ctx.db.prepare('UPDATE tasks SET result_artifact_id = NULL WHERE id = ?').run(b.taskId);
    const legacy = await ctx.preview.createPreviewComparison(a.taskId, b.taskId);
    assert.equal(legacy.ok, false);
    assert.match(legacy.message, /不可变的产物引用/);
  } finally {
    ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 文件保护：参考替换唯一文件名 + 旧文件清理；维护扫描预览孤儿
// ---------------------------------------------------------------------------

test('文件保护：参考替换用唯一新文件并清旧；孤儿扫描覆盖 previews 并保护新文件', async () => {
  const ctx = await setup();
  try {
    const first = await ctx.preview.savePreviewReference({
      sourceUri: 'file:///cache/in.jpg',
      sourceWidth: 800,
      sourceHeight: 600,
    });
    const firstPath = first.path;
    assert.ok(ctx.fsStub.files.has(`file:///document/${firstPath}`));

    const second = await ctx.preview.savePreviewReference({
      sourceUri: 'file:///cache/in.jpg',
      sourceWidth: 800,
      sourceHeight: 600,
    });
    assert.notEqual(second.path, firstPath, '唯一文件名，不覆盖旧文件');
    assert.equal(ctx.fsStub.files.has(`file:///document/${firstPath}`), false, '提交新引用后清旧文件');
    assert.equal(ctx.fsStub.files.has(`file:///document/${second.path}`), true);

    // 维护扫描：previews/ 下无产物引用的文件进入孤儿报告；
    // 活动写入保护——刚下载的新文件保留，足够老的孤儿被清理
    const { taskId } = await ctx.preview.createPreviewTask(baseCreateInput({ requestKey: 'fs-1' }));
    await ctx.preview.updatePreviewTaskStatus(taskId, ['queued'], 'running');
    await ctx.preview.downloadAndCommitArtifact({
      taskId,
      remoteUrl: 'https://cdn.example.com/live.jpg',
      prompt: 'p',
      inputKey: 'k',
      configId: 'cfg-img',
      attempt: 0,
      expectedStatus: ['running'],
    });
    // 一个足够老的孤儿（文件在、无任何记录引用、修改时间在保护窗口外）
    ctx.fsStub.files.set('file:///document/previews/orphan-old.jpg', 'old-bytes');
    ctx.fsStub.oldFiles.add('file:///document/previews/orphan-old.jpg');

    const report = await ctx.maintenance.scanConsistency();
    assert.equal(report.previewOrphanFiles.includes('previews/orphan-old.jpg'), true, '无引用文件进入孤儿报告');
    // 新下载产物（有引用）不在孤儿报告
    const liveArtifact = ctx.db.prepare('SELECT path FROM preview_artifacts WHERE task_id = ?').get(taskId);
    assert.equal(report.previewOrphanFiles.includes(liveArtifact.path), false, '被产物引用的文件不是孤儿');

    await ctx.maintenance.cleanOrphanFiles();
    assert.equal(ctx.fsStub.files.has('file:///document/previews/orphan-old.jpg'), false, '足够老的孤儿被清理');
    assert.equal(
      ctx.fsStub.files.has(`file:///document/${liveArtifact.path}`),
      true,
      '被引用产物不被清理',
    );
  } finally {
    ctx.close();
  }
});
