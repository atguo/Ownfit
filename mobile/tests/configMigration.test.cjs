// M6 批次 1.4 回归：AI 非敏感配置从私有 JSON 迁入本地库（schema v6）。
// - v5/v6/v7 迁移：tasks.input_json 列、ai_configs 表与 v7 表/列；中途失败回滚不清库
// - 首次缓存初始化：表空 + JSON 可解析 → 搬入并删旧文件；表非空不再读旧文件
// - 读写路径：增改删同步落库与镜像；镜像未加载时结构化读取报 unreadable
// 使用内存 SQLite 与真实 configStore 代码；不触碰真实文件与设备。
// 运行：仓库根 `node --test mobile/tests/configMigration.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const { createMemoryAdapter, loadDbModule } = require('./analysisMigration.test.cjs');

const nodeRequire = require;
const SRC = path.resolve(__dirname, '../src');
const CONFIG_PATH = 'file:///document/ai-model-configs.json';

/** 把 vm 上下文里创建的对象转为普通对象，便于 deepEqual（跨 realm 原型不同） */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 内存文件系统：只实现 configStore 用到的 File/Paths 部分 */
function createFsStub(files = new Map()) {
  const toPath = (part) => (typeof part === 'string' ? part : (part && part.path) || '');
  const deleted = [];
  return {
    deleted,
    files,
    Paths: { document: { path: 'file:///document', uri: 'file:///document' } },
    File: class {
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
        deleted.push(this.path);
      }
    },
  };
}

function createSecureStoreStub(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
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

/** 极简 CommonJS 加载器：db 指向内存适配器，expo 依赖指向内存 stub */
function createLoader(adapter, fileSystem, secureStore) {
  const cache = new Map();
  return function load(filename) {
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
      require(id) {
        if (id === 'expo-file-system') return fileSystem;
        if (id === 'expo-secure-store') return secureStore;
        if (id === 'expo-sqlite') return {}; // 真实 db.ts 万一被加载时兜底，防止落到真实 ESM 包
        if (id === 'expo-crypto') return {};
        if (id.startsWith('.')) {
          const resolved = path.resolve(dir, id);
          const candidate = [resolved, `${resolved}.ts`, path.join(resolved, 'index.ts')].find(
            (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
          );
          if (!candidate) throw new Error(`cannot resolve: ${id}`);
          if (candidate === path.join(SRC, 'data', 'db.ts')) {
            return { ...loadDbModule(), getDb: async () => adapter };
          }
          return load(candidate);
        }
        return nodeRequire(id);
      },
    });
    cache.set(filename, module.exports);
    return module.exports;
  };
}

const sampleConfig = (over = {}) => ({
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

/** 迁移到 v6 的内存库 + 已加载的 configStore */
async function setup({ jsonConfigs, raw } = {}) {
  const { db, adapter, close } = createMemoryAdapter();
  await loadDbModule().runMigrations(adapter);
  const fileSystem = createFsStub();
  if (raw !== undefined) fileSystem.files.set(CONFIG_PATH, raw);
  else if (jsonConfigs) fileSystem.files.set(CONFIG_PATH, JSON.stringify(jsonConfigs));
  const secureStore = createSecureStoreStub({ 'ai-key-cfg-1': 'sk-1' });
  const load = createLoader(adapter, fileSystem, secureStore);
  const configStore = load(path.join(SRC, 'services/ai/configStore.ts'));
  return { db, adapter, close, fileSystem, secureStore, configStore };
}

test('v5/v6 迁移：tasks.input_json 列与 ai_configs 表存在；中途失败回滚不清库', async () => {
  const { db, adapter, close } = createMemoryAdapter();
  try {
    const { runMigrations, schemaMigrations } = loadDbModule();
    // 只推进到 v4，再单独执行 v5/v6，验证各自回滚边界
    for (const step of schemaMigrations.slice(0, 4)) await step.up(adapter);

    const columns = () => db.prepare('PRAGMA table_info(tasks)').all().map((r) => r.name);
    await schemaMigrations[4].up(adapter);
    assert.ok(columns().includes('input_json'), 'v5 应添加 tasks.input_json');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);

    adapter.setFailOn('ai_configs');
    await assert.rejects(() => schemaMigrations[5].up(adapter), /injected failure/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5, 'v6 失败停留在 5');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ai_configs'").get().n,
      0,
      'ai_configs 不应残留',
    );

    adapter.setFailOn(null);
    await runMigrations(adapter);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ai_configs'").get().n,
      1,
    );
  } finally {
    close();
  }
});

test('镜像未加载：结构化读取报 unreadable；加载后空库为合法空列表', async () => {
  const { close, configStore } = await setup();
  try {
    assert.deepEqual(plain(configStore.loadConfigsStructured()), { ok: false, reason: 'unreadable' });
    assert.deepEqual(plain(configStore.loadConfigs()), []);

    const ready = await configStore.ensureConfigCache();
    assert.equal(ready, true);
    assert.deepEqual(plain(configStore.loadConfigsStructured()), { ok: true, configs: [] });
    assert.equal(configStore.getConfig('cfg-1'), undefined);
  } finally {
    close();
  }
});

test('首次迁移：表空 + JSON 可解析 → 搬入并删旧文件；配置经镜像可读', async () => {
  const legacy = [sampleConfig(), sampleConfig({ id: 'cfg-2', name: 'DeepSeek 文本', capabilities: ['text'], keyRef: 'ai-key-cfg-2' })];
  const { db, close, fileSystem, configStore } = await setup({ jsonConfigs: legacy });
  try {
    const ready = await configStore.ensureConfigCache();
    assert.equal(ready, true);
    const configs = configStore.loadConfigs();
    assert.deepEqual(plain(configs.map((c) => c.id)), ['cfg-1', 'cfg-2']);
    assert.equal(configs[0].baseUrl, 'https://api.example.com/v1');
    assert.equal(configs[0].capabilities[0], 'vision');

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n, 2);
    assert.deepEqual(fileSystem.deleted, [CONFIG_PATH], '迁移成功后删除旧 JSON');
    assert.equal(fileSystem.files.has(CONFIG_PATH), false);
  } finally {
    close();
  }
});

test('表非空不再读旧文件：残留 JSON 不覆盖数据库中的后续修改', async () => {
  const legacy = [sampleConfig()];
  const { close, fileSystem, configStore } = await setup({ jsonConfigs: legacy });
  try {
    await configStore.ensureConfigCache();
    // 模拟删除失败残留 + 用户在数据库里改名
    fileSystem.files.set(CONFIG_PATH, JSON.stringify([sampleConfig({ name: '旧名' })]));
    await configStore.updateConfig('cfg-1', {
      name: '新名',
      urlKind: 'openai',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'glm-4v',
      capabilities: ['vision'],
    });

    await configStore.ensureConfigCache();
    assert.equal(configStore.getConfig('cfg-1').name, '新名', '残留文件不得回灌旧值');
    assert.deepEqual([...fileSystem.deleted], [CONFIG_PATH], '表非空时不重复删除/迁移');
  } finally {
    close();
  }
});

test('读写路径：增改删落库并同步镜像；测试结果不影响 callRevision', async () => {
  const { db, close, configStore } = await setup();
  try {
    await configStore.ensureConfigCache();
    const created = await configStore.addConfig({
      name: 'GLM',
      urlKind: 'openai',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'glm-4v',
      capabilities: ['vision', 'text'],
      apiKey: 'sk-new',
    });
    assert.ok(created.callRevision && created.callRevision !== 'legacy');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n, 1);
    assert.equal(configStore.getConfig(created.id).name, 'GLM', '镜像已同步');

    await configStore.updateTestResult(created.id, { testStatus: 'passed', testMessage: 'ok' });
    const afterTest = configStore.getConfig(created.id);
    assert.equal(afterTest.testStatus, 'passed');
    assert.equal(afterTest.callRevision, created.callRevision, '连接测试不更新 callRevision');
    const row = db.prepare('SELECT test_status, test_message FROM ai_configs WHERE id = ?').get(created.id);
    assert.equal(row.test_status, 'passed');
    assert.equal(row.test_message, 'ok');

    const moved = await configStore.updateConfig(created.id, {
      name: 'GLM',
      urlKind: 'openai',
      baseUrl: 'https://other.example.com/v1',
      modelId: 'glm-4v',
      capabilities: ['vision'],
    });
    assert.notEqual(moved.callRevision, created.callRevision, '改地址必须更新 callRevision');

    await configStore.deleteConfig(created.id);
    assert.equal(configStore.getConfig(created.id), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_configs').get().n, 0);
  } finally {
    close();
  }
});

test('数据库不可用：ensureConfigCache 失败返回 false，镜像保持未加载', async () => {
  const { adapter, close } = createMemoryAdapter();
  const fileSystem = createFsStub();
  const secureStore = createSecureStoreStub();
  const load = createLoader(adapter, fileSystem, secureStore);
  const configStore = load(path.join(SRC, 'services/ai/configStore.ts'));
  try {
    // adapter 未跑迁移：ai_configs 不存在 → ensure 失败
    const ready = await configStore.ensureConfigCache();
    assert.equal(ready, false);
    assert.deepEqual(plain(configStore.loadConfigsStructured()), { ok: false, reason: 'unreadable' });
    assert.equal(configStore.getConfig('cfg-1'), undefined);
  } finally {
    close();
  }
});
