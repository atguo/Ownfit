// P2 回归：schema v3 迁移与任务数据基础（分批执行手册 P2）。
// 规则：
// - 迁移测试必须调用生产迁移步骤（db.ts 的 runMigrations / schemaMigrations），
//   不在测试里另复制一套建表 SQL。
// - 不打开或迁移手机数据库；不调用真实模型。
// 运行：仓库根 `node --test mobile/tests/*.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

/** 把 TS 源转译成 CommonJS 并在受控 require 环境中执行，返回模块导出 */
function loadTsModule(filename, resolver) {
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module,
    exports: module.exports,
    require: (id) => resolver(id),
    console,
    Date,
    Math,
    JSON,
  });
  return module.exports;
}

/**
 * 内存 SQLite 适配器：模拟 expo-sqlite 的异步 API 形状。
 * options.failOn：execAsync 的 SQL 命中该子串时抛错，用于注入迁移中途失败；可用 setFailOn 重置。
 */
function createMemoryAdapter(options = {}) {
  const db = new DatabaseSync(':memory:');
  let failOn = options.failOn ?? null;

  const adapter = {
    setFailOn(pattern) {
      failOn = pattern;
    },
    async execAsync(sql) {
      if (failOn && String(sql).includes(failOn)) throw new Error(`injected failure: ${failOn}`);
      db.exec(sql);
    },
    async getFirstAsync(sql, ...args) {
      const row = db.prepare(sql).get(...args);
      return row === undefined ? null : row;
    },
    async getAllAsync(sql, ...args) {
      return db.prepare(sql).all(...args);
    },
    async runAsync(sql, ...args) {
      const result = db.prepare(sql).run(...args);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async withTransactionAsync(fn) {
      db.exec('BEGIN');
      try {
        await fn();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async withExclusiveTransactionAsync(fn) {
      db.exec('BEGIN');
      try {
        await fn(adapter);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };

  return {
    db,
    adapter,
    close: () => db.close(),
  };
}

/** 载入 db.ts（生产迁移），stub 掉原生依赖 */
function loadDbModule() {
  return loadTsModule(path.resolve(__dirname, '../src/data/db.ts'), (id) => {
    if (id === 'expo-sqlite') return {};
    if (id === 'expo-secure-store') return {};
    if (id === 'expo-crypto') return {};
    throw new Error(`unexpected import: ${id}`);
  });
}

function loadAnalysisTypes() {
  return loadTsModule(path.resolve(__dirname, '../src/data/repositories/analysisTypes.ts'), (id) => {
    throw new Error(`unexpected import: ${id}`);
  });
}

/** 载入 taskRepository.ts，getDb 指向给定 adapter */
function loadTaskRepository(adapter) {
  const analysisTypes = loadAnalysisTypes();
  return loadTsModule(path.resolve(__dirname, '../src/data/repositories/taskRepository.ts'), (id) => {
    if (id === '../db') return { getDb: async () => adapter };
    if (id === './analysisTypes') return analysisTypes;
    throw new Error(`unexpected import: ${id}`);
  });
}

function userVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

const taskInput = (overrides = {}) => ({
  itemId: 'item-a',
  photoId: 'photo-a',
  inputRevision: 1,
  inputKey: '{"itemId":"item-a"}',
  requestKey: 'req-1',
  configId: 'cfg-1',
  configSnapshot: '{"id":"cfg-1","name":"GLM","urlKind":"openai","baseUrl":"https://x","modelId":"m"}',
  configRevision: 'legacy',
  contractVersion: '1.0.0-draft',
  promptVersion: '1',
  ...overrides,
});

// ---------------------------------------------------------------------------
// 测试（仅在本文件被直接运行时注册；被其他测试 require 时不注册）
// ---------------------------------------------------------------------------
if (require.main === module) {
  test('空库迁移到 v3：建 tasks 与 ai_task_preferences，items/attributes 增列', async () => {
    const { db, adapter, close } = createMemoryAdapter();
    try {
      const { runMigrations } = loadDbModule();
      await runMigrations(adapter);

      assert.equal(userVersion(db), 3);
      assert.equal(tableExists(db, 'tasks'), true);
      assert.equal(tableExists(db, 'ai_task_preferences'), true);
      assert.ok(columnNames(db, 'items').includes('revision'));
      const attrCols = columnNames(db, 'attributes');
      for (const col of ['value_state', 'value_format', 'analysis_task_id']) {
        assert.ok(attrCols.includes(col), `attributes 应包含 ${col}`);
      }
    } finally {
      close();
    }
  });

  test('v1 升级到 v3：旧资料保留，NULL value 回填 unknown，item_version/revision 保持', async () => {
    const { db, adapter, close } = createMemoryAdapter();
    try {
      const { runMigrations, schemaMigrations } = loadDbModule();
      await schemaMigrations[0].up(adapter); // 生产 v1 步骤
      assert.equal(userVersion(db), 1);

      db.exec("PRAGMA foreign_keys = ON");
      db.exec(
        "INSERT INTO items (id,status,category,name,source_type,main_photo_id,created_at,updated_at) " +
          "VALUES ('i1','active','上衣','旧衬衫','photo',NULL,'t1','t1')",
      );
      db.exec(
        "INSERT INTO photos (id,item_id,kind,original_path,thumb_path,created_at) " +
          "VALUES ('p1','i1','main','photos/i1.jpg','thumbs/i1.jpg','t1')",
      );
      db.exec(
        "INSERT INTO attributes (id,item_id,field,value,unit,source_type,source_ref,confirm_status,recorded_at,item_version) " +
          "VALUES ('a-null','i1','color',NULL,NULL,'user_confirmed',NULL,'confirmed','t1',1)",
      );
      db.exec(
        "INSERT INTO attributes (id,item_id,field,value,unit,source_type,source_ref,confirm_status,recorded_at,item_version) " +
          "VALUES ('a-val','i1','category','上衣',NULL,'user_confirmed',NULL,'confirmed','t2',1)",
      );

      await runMigrations(adapter);

      assert.equal(userVersion(db), 3);
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get('i1');
      assert.equal(item.name, '旧衬衫');
      assert.equal(item.category, '上衣');
      assert.equal(item.revision, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM photos').get().n, 1);
      assert.equal(db.prepare("SELECT value_state FROM attributes WHERE id = 'a-null'").get().value_state, 'unknown');
      assert.equal(db.prepare("SELECT value_state FROM attributes WHERE id = 'a-val'").get().value_state, 'known');
      // 不补造来源与时间
      assert.equal(db.prepare("SELECT recorded_at FROM attributes WHERE id = 'a-val'").get().recorded_at, 't2');
    } finally {
      close();
    }
  });

  test('v2 升级到 v3：方案/穿着/照片/属性全部保留', async () => {
    const { db, adapter, close } = createMemoryAdapter();
    try {
      const { runMigrations, schemaMigrations } = loadDbModule();
      await schemaMigrations[0].up(adapter);
      await schemaMigrations[1].up(adapter);
      assert.equal(userVersion(db), 2);

      db.exec("PRAGMA foreign_keys = ON");
      db.exec(
        "INSERT INTO items (id,status,category,name,source_type,main_photo_id,created_at,updated_at) " +
          "VALUES ('i2','active','下装','旧裤子','photo',NULL,'t1','t1')",
      );
      db.exec(
        "INSERT INTO plans (id,basis_item_id,wear_style,created_at,updated_at) " +
          "VALUES ('pl1','i2','自然垂放','t1','t1')",
      );
      db.exec("INSERT INTO plan_items (plan_id,item_id,role,position) VALUES ('pl1','i2','basis',0)");
      db.exec("INSERT INTO worn_records (id,plan_id,worn_at,satisfied,note) VALUES ('w1','pl1','t1','yes',NULL)");

      await runMigrations(adapter);

      assert.equal(userVersion(db), 3);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_items').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM worn_records').get().n, 1);
      assert.equal(db.prepare('SELECT basis_item_id FROM plans WHERE id = ?').get('pl1').basis_item_id, 'i2');
      assert.equal(db.prepare('SELECT revision FROM items WHERE id = ?').get('i2').revision, 1);
    } finally {
      close();
    }
  });

  test('重复打开：再跑一次迁移不报错、资料不变', async () => {
    const { db, adapter, close } = createMemoryAdapter();
    try {
      const { runMigrations } = loadDbModule();
      await runMigrations(adapter);
      await adapter.execAsync("INSERT INTO tasks (id,kind,item_id,status,input_revision,attempt,photo_id,input_key,request_key,config_id,config_snapshot,config_revision,contract_version,prompt_version,created_at,updated_at) VALUES ('t1','garment_analysis','i1','queued',1,1,'p1','k','r','c','{}','legacy','1.0.0-draft','1','now','now')");

      await runMigrations(adapter);

      assert.equal(userVersion(db), 3);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
    } finally {
      close();
    }
  });

  test('迁移中途失败：整体回滚，user_version 保持 2，无半成品结构与列', async () => {
    const { db, adapter, close } = createMemoryAdapter({ failOn: 'ai_task_preferences' });
    try {
      const { runMigrations, schemaMigrations } = loadDbModule();
      await schemaMigrations[0].up(adapter);
      await schemaMigrations[1].up(adapter);
      assert.equal(userVersion(db), 2);

      await assert.rejects(() => runMigrations(adapter), /injected failure/);

      assert.equal(userVersion(db), 2, '失败后 user_version 必须停留在 2');
      assert.equal(columnNames(db, 'items').includes('revision'), false, 'items.revision 应随事务回滚');
      assert.equal(columnNames(db, 'attributes').includes('value_state'), false, 'attributes.value_state 应随事务回滚');
      assert.equal(tableExists(db, 'tasks'), false, 'tasks 表不应残留');

      // 解除注入后重试应成功（不清库）
      adapter.setFailOn(null);
      await runMigrations(adapter);
      assert.equal(userVersion(db), 3);
      assert.equal(tableExists(db, 'tasks'), true);
    } finally {
      close();
    }
  });

  test('任务创建：request_key 幂等、同衣物 queued/running 去重、attempt 递增', async () => {
    const { db, adapter, close } = createMemoryAdapter();
    try {
      const { runMigrations } = loadDbModule();
      await runMigrations(adapter);
      const repo = loadTaskRepository(adapter);

      const first = await repo.createGarmentTask(taskInput({ requestKey: 'req-1' }));
      assert.equal(first.created, true);
      assert.equal(first.task.status, 'queued');
      assert.equal(first.task.attempt, 1);
      assert.equal(first.task.kind, 'garment_analysis');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);

      // 相同 request_key：返回既有任务，不重复插入
      const same = await repo.createGarmentTask(taskInput({ requestKey: 'req-1' }));
      assert.equal(same.created, false);
      assert.equal(same.task.id, first.task.id);

      // 同衣物仍有 queued：即使换 request_key 也返回既有任务（去重）
      const dup = await repo.createGarmentTask(taskInput({ requestKey: 'req-2' }));
      assert.equal(dup.created, false);
      assert.equal(dup.task.id, first.task.id);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);

      // running 也算活动状态，仍去重
      assert.equal(await repo.markTaskRunning(first.task.id), true);
      const dupRunning = await repo.createGarmentTask(taskInput({ requestKey: 'req-3' }));
      assert.equal(dupRunning.created, false);
      assert.equal(dupRunning.task.status, 'running');

      // 结束后可再次创建，attempt 递增
      assert.equal(await repo.updateTaskStatus(first.task.id, ['running'], 'failed', { errorKind: 'network' }), true);
      const next = await repo.createGarmentTask(taskInput({ requestKey: 'req-4' }));
      assert.equal(next.created, true);
      assert.equal(next.task.attempt, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 2);

      // request_key 唯一约束（数据库层）
      assert.throws(() =>
        db
          .prepare(
            "INSERT INTO tasks (id,kind,item_id,status,input_revision,attempt,photo_id,input_key,request_key,config_id,config_snapshot,config_revision,contract_version,prompt_version,created_at,updated_at) " +
              "VALUES ('t-dup','garment_analysis','item-a','queued',1,3,'p','k','req-1','c','{}','legacy','1.0.0-draft','1','now','now')",
          )
          .run(),
      );
    } finally {
      close();
    }
  });

  test('条件状态更新：不满足来源状态时不更新（竞态保护）', async () => {
    const { adapter, close } = createMemoryAdapter();
    try {
      const { runMigrations } = loadDbModule();
      await runMigrations(adapter);
      const repo = loadTaskRepository(adapter);

      const { task } = await repo.createGarmentTask(taskInput({ requestKey: 'req-cancel' }));
      assert.equal(await repo.updateTaskStatus(task.id, ['running'], 'cancelled'), false, 'queued 不能被按 running 取消');
      assert.equal(await repo.updateTaskStatus(task.id, ['queued'], 'cancelled'), true);
      assert.equal(await repo.markTaskRunning(task.id), false, '已取消的任务不能再进入 running');
      assert.equal((await repo.getTask(task.id)).status, 'cancelled');
    } finally {
      close();
    }
  });

  test('默认视觉模型读写：upsert 且按 kind 隔离', async () => {
    const { adapter, close } = createMemoryAdapter();
    try {
      const { runMigrations } = loadDbModule();
      await runMigrations(adapter);
      const repo = loadTaskRepository(adapter);

      assert.equal(await repo.getDefaultConfigId(), null);
      await repo.setDefaultConfigId('cfg-1');
      assert.equal(await repo.getDefaultConfigId(), 'cfg-1');
      await repo.setDefaultConfigId('cfg-2');
      assert.equal(await repo.getDefaultConfigId(), 'cfg-2');
      assert.equal(await repo.getDefaultConfigId('other_kind'), null);
    } finally {
      close();
    }
  });

  test('查询顺序：created_at 相同也稳定（rowid 兜底）', async () => {
    const { adapter, close } = createMemoryAdapter();
    try {
      const { runMigrations } = loadDbModule();
      await runMigrations(adapter);
      const repo = loadTaskRepository(adapter);

      const first = await repo.createGarmentTask(taskInput({ requestKey: 'req-a' }));
      await repo.updateTaskStatus(first.task.id, ['queued'], 'succeeded', { resultJson: '{}' });
      const second = await repo.createGarmentTask(taskInput({ requestKey: 'req-b' }));
      await repo.updateTaskStatus(second.task.id, ['queued'], 'failed', { errorKind: 'network' });

      const list = await repo.listTasksByItem('item-a');
      assert.equal(list.length, 2);
      assert.equal(list[0].id, first.task.id);
      assert.equal(list[1].id, second.task.id);

      const latest = await repo.getLatestTask('item-a');
      assert.equal(latest.id, second.task.id);
    } finally {
      close();
    }
  });
}

module.exports = {
  loadTsModule,
  createMemoryAdapter,
  loadDbModule,
  loadAnalysisTypes,
  loadTaskRepository,
  userVersion,
  columnNames,
  tableExists,
  taskInput,
};
