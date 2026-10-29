// P4 回归：视觉模型路由、callRevision、分析客户端与严格 JSON 解析（分批执行手册 P4）。
// 全部使用假 fetch；真实模型调用次数必须为 0。
// 运行：仓库根 `node --test mobile/tests/*.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const { createMemoryAdapter, loadDbModule } = require('./analysisMigration.test.cjs');

const SRC = path.resolve(__dirname, '../src');
const AI_DIR = path.join(SRC, 'services/ai');
const REPOSITORY_DIR = path.join(SRC, 'data/repositories');
const CONTRACT_ENTRY = path.resolve(__dirname, '../../packages/contract/src/index.ts');
const CONFIG_FILE_PATH = 'file:///document/ai-model-configs.json';
const nodeRequire = require;

/** 把 vm 上下文里创建的对象转为普通对象，便于 deepEqual */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 可注入的宿主 stub
// ---------------------------------------------------------------------------

/** 内存文件系统：只实现 configStore/photoRepository 用到的部分 */
function createFsStub(files = new Map()) {
  const toPath = (part) => (typeof part === 'string' ? part : (part && part.path) || '');
  class File {
    constructor(...parts) {
      this.path = parts.map(toPath).join('/');
    }
    get exists() {
      return files.has(this.path);
    }
    textSync() {
      return files.get(this.path);
    }
    writeSync(content) {
      files.set(this.path, content);
    }
    delete() {
      files.delete(this.path);
    }
    async base64() {
      return files.get(this.path);
    }
  }
  class Directory {
    constructor(...parts) {
      this.path = parts.map(toPath).join('/');
    }
    get exists() {
      return true;
    }
    create() {}
  }
  return { File, Directory, Paths: { document: { path: 'file:///document', uri: 'file:///document' } }, files };
}

function createSecureStoreStub(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
    store,
    async getItemAsync(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async setItemAsync(key, value) {
      store.set(key, value);
    },
    async deleteItemAsync(key) {
      store.delete(key);
    },
  };
}

/** 假 fetch：记录全部请求，真实网络调用数为 0 */
function createFakeFetch(handler) {
  const calls = [];
  const fake = async (url, init) => {
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    return handler({ url, init, body });
  };
  fake.calls = calls;
  return fake;
}

const okResponse = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
  text: async () => content,
});

const errorResponse = (status, text = 'error') => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => text,
});

/** 请求永不返回，直到 signal 被 abort（模拟超时/取消） */
function pendingUntilAbort(init) {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (init && init.signal) {
      if (init.signal.aborted) fail();
      else init.signal.addEventListener('abort', fail);
    }
  });
}

// ---------------------------------------------------------------------------
// 模块加载器：TS 转译 + 原生依赖 stub + 假 fetch
// ---------------------------------------------------------------------------

function resolveModule(candidate) {
  for (const suffix of ['.ts', '.tsx', '/index.ts', '']) {
    const file = candidate + suffix;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  throw new Error(`cannot resolve module: ${candidate}`);
}

function createAiLoader({ fileSystem, secureStore, fetch, adapter }) {
  const cache = new Map();
  const stubs = {
    'expo-file-system': fileSystem,
    'expo-secure-store': secureStore,
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, ImageManipulator: { manipulate: () => ({}) } },
    './minimaxClient': { generateImage: async () => ({ ok: false, latencyMs: 0, error: { kind: 'stub', message: 'not used' } }) },
  };

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
      require(id) {
        if (id in stubs) return stubs[id];
        if (id === '@ownfit/contract') return load(CONTRACT_ENTRY);
        if (id.startsWith('.')) {
          const resolved = resolveModule(path.resolve(dir, id));
          if (resolved === path.join(SRC, 'data', 'db.ts')) return { ...loadDbModule(), getDb: async () => adapter };
          return load(resolved);
        }
        // 其余裸模块（如 zod）交给宿主 Node 解析
        return nodeRequire(id);
      },
      // 注入宿主全局：使 openaiClient 的 AbortController / setTimeout / Error 行为与真机一致
      console,
      fetch,
      AbortController,
      setTimeout,
      clearTimeout,
      Error,
    });
    cache.set(filename, module.exports);
    return module.exports;
  }

  return { load, ai: (name) => load(path.join(AI_DIR, `${name}.ts`)), repo: (name) => load(path.join(REPOSITORY_DIR, `${name}.ts`)) };
}

async function setup(options = {}) {
  const fileSystem = createFsStub();
  const secureStore = createSecureStoreStub(options.keys);
  const fetch = createFakeFetch(options.handler ?? (() => okResponse('{}')));
  const { adapter } = createMemoryAdapter();
  const loader = createAiLoader({ fileSystem, secureStore, fetch, adapter });
  return { fileSystem, secureStore, fetch, adapter, ...loader };
}

const visionConfig = (over = {}) => ({
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
  ...over,
});

function seedConfigs(fileSystem, configs) {
  fileSystem.files.set(CONFIG_FILE_PATH, JSON.stringify(configs));
}

function seedConfigFileRaw(fileSystem, raw) {
  fileSystem.files.set(CONFIG_FILE_PATH, raw);
}

const validPayload = {
  targetStatus: 'single',
  suggestedName: { state: 'known', value: '白色衬衫' },
  category: { state: 'known', value: '上衣' },
  colors: { state: 'known', value: [{ name: '白色', isPrimary: true }] },
  pattern: { state: 'known', value: '纯色' },
  neckline: { state: 'unknown', value: null },
  sleeve: { state: 'known', value: '长袖' },
  fit: { state: 'not_applicable', value: null },
  stylingTags: { state: 'known', value: ['通勤'] },
  description: { state: 'known', value: '一件白色长袖衬衫。' },
  unclearParts: [],
};

const runInput = (over = {}) => ({
  config: { urlKind: 'openai', baseUrl: 'https://api.example.com/v1', modelId: 'glm-4v' },
  apiKey: 'sk-test',
  imageDataUrl: 'data:image/jpeg;base64,AAAA',
  ...over,
});

// ---------------------------------------------------------------------------
// 视觉模型路由（D1）
// ---------------------------------------------------------------------------

test('路由：无配置 / 只有文本模型 → missing', async () => {
  const noConfig = await setup();
  assert.equal((await noConfig.ai('visionConfig').resolveVisionConfig()).status, 'missing');

  const textOnly = await setup();
  seedConfigs(textOnly.fileSystem, [visionConfig({ capabilities: ['text'] })]);
  assert.equal((await textOnly.ai('visionConfig').resolveVisionConfig()).status, 'missing');
});

test('路由：配置损坏 → invalid(config_unreadable)，不改写原文件', async () => {
  const { fileSystem, ai } = await setup();
  seedConfigFileRaw(fileSystem, '{ 这不是 JSON');
  const resolution = await ai('visionConfig').resolveVisionConfig();
  assert.equal(resolution.status, 'invalid');
  assert.equal(resolution.reason, 'config_unreadable');
  assert.equal(fileSystem.files.get(CONFIG_FILE_PATH), '{ 这不是 JSON');
});

test('路由：地址或模型 ID 无效 → invalid(config_invalid)', async () => {
  const { fileSystem, ai } = await setup({ keys: { 'ai-key-cfg-1': 'sk-1' } });
  seedConfigs(fileSystem, [visionConfig({ baseUrl: 'not-a-url' })]);
  const resolution = await ai('visionConfig').resolveVisionConfig();
  assert.equal(resolution.status, 'invalid');
  assert.equal(resolution.reason, 'config_invalid');
});

test('路由：有视觉配置但读不到密钥 → invalid(key_missing)', async () => {
  const { fileSystem, ai } = await setup();
  seedConfigs(fileSystem, [visionConfig()]);
  const resolution = await ai('visionConfig').resolveVisionConfig();
  assert.equal(resolution.status, 'invalid');
  assert.equal(resolution.reason, 'key_missing');
});

test('路由：唯一候选且无默认 → ready；密钥以安全存储为准（hasKey 过期不影响）', async () => {
  const { fileSystem, ai } = await setup({ keys: { 'ai-key-cfg-1': 'sk-1' } });
  seedConfigs(fileSystem, [visionConfig({ hasKey: false })]);
  const resolution = await ai('visionConfig').resolveVisionConfig(null);
  assert.equal(resolution.status, 'ready');
  assert.equal(resolution.config.id, 'cfg-1');
  assert.equal(resolution.callRevision, 'rev-1');
});

test('路由：多个候选 → choose；默认仍有效 → ready', async () => {
  const configs = [
    visionConfig({ id: 'cfg-1', keyRef: 'ai-key-cfg-1' }),
    visionConfig({ id: 'cfg-2', keyRef: 'ai-key-cfg-2', name: 'Qwen 视觉' }),
  ];
  const keys = { 'ai-key-cfg-1': 'sk-1', 'ai-key-cfg-2': 'sk-2' };

  const choose = await setup({ keys });
  seedConfigs(choose.fileSystem, configs);
  const chooseResult = await choose.ai('visionConfig').resolveVisionConfig(null);
  assert.equal(chooseResult.status, 'choose');
  assert.deepEqual(plain(chooseResult.candidates.map((c) => c.id)), ['cfg-1', 'cfg-2']);

  const ready = await setup({ keys });
  seedConfigs(ready.fileSystem, configs);
  const readyResult = await ready.ai('visionConfig').resolveVisionConfig('cfg-2');
  assert.equal(readyResult.status, 'ready');
  assert.equal(readyResult.config.id, 'cfg-2');
});

test('路由：默认失效时即使只剩一个候选也要 choose，不静默切换供应商', async () => {
  const { fileSystem, ai } = await setup({ keys: { 'ai-key-cfg-1': 'sk-1' } });
  seedConfigs(fileSystem, [visionConfig({ id: 'cfg-1', keyRef: 'ai-key-cfg-1' })]);
  const resolution = await ai('visionConfig').resolveVisionConfig('cfg-已删除');
  assert.equal(resolution.status, 'choose');
  assert.deepEqual(plain(resolution.candidates.map((c) => c.id)), ['cfg-1']);
});

// ---------------------------------------------------------------------------
// callRevision（D2）
// ---------------------------------------------------------------------------

test('callRevision：新增生成版本；改地址/模型/能力/密钥会更新，改名与测试结果不更新', async () => {
  const { fileSystem, ai } = await setup();
  const store = ai('configStore');

  const created = await store.addConfig({
    name: 'GLM',
    urlKind: 'openai',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'glm-4v',
    capabilities: ['vision'],
    apiKey: 'sk-1',
  });
  assert.ok(created.callRevision && created.callRevision !== 'legacy');

  const base = {
    name: 'GLM 改名',
    urlKind: 'openai',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'glm-4v',
    capabilities: ['vision'],
  };
  const renamed = await store.updateConfig(created.id, base);
  assert.equal(renamed.callRevision, created.callRevision, '改名不更新 callRevision');

  await store.updateTestResult(created.id, { testStatus: 'passed' });
  assert.equal(store.getConfig(created.id).callRevision, created.callRevision, '连接测试不更新 callRevision');

  const movedUrl = await store.updateConfig(created.id, { ...base, baseUrl: 'https://other.example.com/v1' });
  assert.notEqual(movedUrl.callRevision, created.callRevision, '地址变化应更新');

  const movedModel = await store.updateConfig(created.id, { ...base, modelId: 'glm-4v-plus' });
  assert.notEqual(movedModel.callRevision, movedUrl.callRevision, '模型 ID 变化应更新');

  const movedCaps = await store.updateConfig(created.id, { ...base, capabilities: ['vision', 'text'] });
  assert.notEqual(movedCaps.callRevision, movedModel.callRevision, '能力标签变化应更新');

  const movedKey = await store.updateConfig(created.id, { ...base, apiKey: 'sk-2' });
  assert.notEqual(movedKey.callRevision, movedCaps.callRevision, '密钥变化应更新');

  // 旧配置（无 callRevision）按 legacy 处理
  const legacy = { ...created, callRevision: undefined };
  assert.equal(ai('types').callRevisionOf(legacy), 'legacy');
  void fileSystem;
});

// ---------------------------------------------------------------------------
// 分析客户端（R3）
// ---------------------------------------------------------------------------

test('分析请求：只有一件照片、参数为 2048、用 data URL 而不是 file URI', async () => {
  const { ai, fetch } = await setup({ handler: () => okResponse(JSON.stringify(validPayload)) });
  const result = await ai('garmentAnalysis').runGarmentAnalysis(runInput());
  assert.equal(result.ok, true);

  assert.equal(fetch.calls.length, 1);
  const { url, body, init } = fetch.calls[0];
  assert.equal(url, 'https://api.example.com/v1/chat/completions');
  assert.equal(body.max_tokens, 2048);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('file://'), false, '不得发送本地 file URI');
  const imageBlocks = (body.messages ?? [])
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((part) => part && part.type === 'image_url');
  assert.equal(imageBlocks.length, 1, '每次请求只发送本件这一张照片');
  assert.equal(imageBlocks[0].image_url.url.startsWith('data:image/jpeg;base64,'), true);
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
});

test('连接测试仍使用 16 个 token（与分析的 2048 区分）', async () => {
  const { ai, fetch } = await setup({ handler: () => okResponse('hi') });
  const chat = await ai('openaiClient').chatCompletion(
    { urlKind: 'openai', baseUrl: 'https://api.example.com/v1', modelId: 'glm-4v' },
    'sk-test',
    [{ role: 'user', content: 'hi' }],
  );
  assert.equal(chat.ok, true);
  assert.equal(fetch.calls[0].body.max_tokens, 16);
  assert.equal(ai('garmentAnalysis').ANALYSIS_MAX_TOKENS, 2048);
  assert.equal(ai('garmentAnalysis').ANALYSIS_TIMEOUT_MS, 90000);
});

test('解析：整段 JSON 与单层 ```json 围栏都可接受', async () => {
  const direct = await setup({ handler: () => okResponse(JSON.stringify(validPayload)) });
  assert.equal((await direct.ai('garmentAnalysis').runGarmentAnalysis(runInput())).ok, true);

  const fenced = await setup({
    handler: () => okResponse('```json\n' + JSON.stringify(validPayload) + '\n```'),
  });
  assert.equal((await fenced.ai('garmentAnalysis').runGarmentAnalysis(runInput())).ok, true);
});

test('解析：带解释文字、截断、非法契约都按 invalid_output 处理，不猜测修复', async () => {
  const withProse = await setup({
    handler: () => okResponse('这是结果：\n' + JSON.stringify(validPayload)),
  });
  const prose = await withProse.ai('garmentAnalysis').runGarmentAnalysis(runInput());
  assert.equal(prose.ok, false);
  assert.equal(prose.error.kind, 'invalid_output');

  const truncated = await setup({ handler: () => okResponse('{"targetStatus":"single","categor') });
  assert.equal((await truncated.ai('garmentAnalysis').runGarmentAnalysis(runInput())).error.kind, 'invalid_output');

  const badEnum = await setup({
    handler: () => okResponse(JSON.stringify({ ...validPayload, category: { state: 'known', value: '帽子' } })),
  });
  assert.equal((await badEnum.ai('garmentAnalysis').runGarmentAnalysis(runInput())).error.kind, 'invalid_output');
});

test('适配：供应商返回“鞋”时显式映射为契约的“鞋履”', async () => {
  const { ai } = await setup({
    handler: () =>
      okResponse(JSON.stringify({ ...validPayload, category: { state: 'known', value: '鞋' } })),
  });
  const result = await ai('garmentAnalysis').runGarmentAnalysis(runInput());
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.result.category), { state: 'known', value: '鞋履' });
});

test('空内容：HTTP 200 但无内容按分析失败处理（连接测试仍算可达）', async () => {
  const empty = await setup({ handler: () => okResponse('') });
  const analysis = await empty.ai('garmentAnalysis').runGarmentAnalysis(runInput());
  assert.equal(analysis.ok, false);
  assert.equal(analysis.error.kind, 'empty');

  const connection = await empty.ai('openaiClient').chatCompletion(
    { urlKind: 'openai', baseUrl: 'https://api.example.com/v1', modelId: 'm' },
    'sk',
    [{ role: 'user', content: 'hi' }],
  );
  assert.equal(connection.ok, true, '连接测试允许空文本');
});

test('错误分类：401 → auth、429 → rate_limit、500 → server、超时 → timeout、外部取消 → cancelled', async () => {
  const auth = await setup({ handler: () => errorResponse(401) });
  assert.equal((await auth.ai('garmentAnalysis').runGarmentAnalysis(runInput())).error.kind, 'auth');

  const limited = await setup({ handler: () => errorResponse(429) });
  assert.equal((await limited.ai('garmentAnalysis').runGarmentAnalysis(runInput())).error.kind, 'rate_limit');

  const server = await setup({ handler: () => errorResponse(503) });
  assert.equal((await server.ai('garmentAnalysis').runGarmentAnalysis(runInput())).error.kind, 'server');

  const timedOut = await setup({ handler: ({ init }) => pendingUntilAbort(init) });
  const timeoutResult = await timedOut.ai('garmentAnalysis').runGarmentAnalysis(runInput({ timeoutMs: 20 }));
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.error.kind, 'timeout');

  const cancelled = await setup({ handler: ({ init }) => pendingUntilAbort(init) });
  const controller = new AbortController();
  const pending = cancelled.ai('garmentAnalysis').runGarmentAnalysis(runInput({ signal: controller.signal }));
  controller.abort();
  const cancelledResult = await pending;
  assert.equal(cancelledResult.ok, false);
  assert.equal(cancelledResult.error.kind, 'cancelled');
});

// ---------------------------------------------------------------------------
// 图片读取（photoRepository）
// ---------------------------------------------------------------------------

test('图片读取：文件缺失 / 无主图分别报错；成功时返回 data URL', async () => {
  const { fileSystem, adapter, repo } = await setup();
  const { runMigrations } = loadDbModule();
  await runMigrations(adapter);
  adapter.execAsync(
    "PRAGMA foreign_keys = ON;" +
      "INSERT INTO items (id,status,category,name,source_type,main_photo_id,created_at,updated_at) VALUES ('a','active','上衣','衬衫','photo','p1','t','t');" +
      "INSERT INTO photos (id,item_id,kind,original_path,thumb_path,created_at) VALUES ('p1','a','main','photos/p1.jpg','thumbs/p1.jpg','t');" +
      "INSERT INTO items (id,status,category,name,source_type,main_photo_id,created_at,updated_at) VALUES ('b','active',NULL,'无图','photo',NULL,'t','t');",
  );
  const photos = repo('photoRepository');
  assert.deepEqual(plain(await photos.readAnalysisImage('b')), { ok: false, reason: 'photo_missing' });
  assert.deepEqual(plain(await photos.readAnalysisImage('a')), { ok: false, reason: 'file_missing' });

  fileSystem.files.set('file:///document/photos/p1.jpg', 'QUJD');
  assert.deepEqual(plain(await photos.readAnalysisImage('a')), {
    ok: true,
    photoId: 'p1',
    dataUrl: 'data:image/jpeg;base64,QUJD',
  });
});
