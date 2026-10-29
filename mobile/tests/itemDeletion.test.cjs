const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 迁移、适配器与模块加载器复用其他测试导出的实现（避免复制建表 SQL 与加载逻辑）。
const { createMemoryAdapter, loadDbModule } = require('./analysisMigration.test.cjs');
const { createLoader, SRC } = require('./garmentTasks.test.cjs');

const PHOTO_REPOSITORY = path.join(SRC, 'data/repositories/photoRepository.ts');
const ITEM_REPOSITORY = path.join(SRC, 'data/repositories/itemRepository.ts');

async function setup() {
  const { db, adapter } = createMemoryAdapter();
  // 用生产迁移建表（v1→v3），不在测试里另复制表结构。
  const { runMigrations } = loadDbModule();
  await runMigrations(adapter);

  db.exec(
    "PRAGMA foreign_keys = ON;" +
      "INSERT INTO items (id,status,category,name,source_type,main_photo_id,created_at,updated_at) VALUES ('a','active','上衣','衬衫','photo',NULL,'now','now');" +
      "INSERT INTO photos (id,item_id,kind,original_path,thumb_path,created_at) VALUES ('p','a','main','photos/a.jpg','thumbs/a.jpg','now');" +
      "INSERT INTO attributes (id,item_id,field,value,unit,source_type,source_ref,confirm_status,recorded_at,item_version) VALUES ('attr','a','category','上衣',NULL,'user','', 'confirmed','now',1);" +
      "INSERT INTO plans (id,basis_item_id,wear_style,created_at,updated_at) VALUES ('plan','a','自然垂放','now','now');" +
      "INSERT INTO plan_items (plan_id,item_id,role,position) VALUES ('plan','a','basis',0);" +
      "INSERT INTO worn_records (id,plan_id,worn_at,satisfied,note) VALUES ('worn','plan','now','yes',NULL);",
  );

  let failFiles = false;
  const removed = [];
  // 只替换照片文件操作（该回归要模拟文件清理失败）；任务仓库等使用生产实现。
  const photoStub = {
    ORIGINAL_MAX_DIMENSION: 2048,
    savePhotoFiles: async () => {
      throw new Error('not used in this test');
    },
    insertPhotoRecord: async () => {},
    deletePhotoFiles: (...paths) => {
      if (failFiles) throw new Error('file failed');
      removed.push(...paths);
    },
  };

  const load = createLoader(adapter, { [PHOTO_REPOSITORY]: photoStub });
  const api = load(ITEM_REPOSITORY);
  return { api, db, removed, fail: (v) => { failFiles = v; } };
}

test('删除清理照片和属性但保留历史关联，不能恢复或重新入库', async () => {
  const { api, db, removed } = await setup();
  try {
    await api.purgeItem('a');
    assert.equal((await api.getItem('a')).status, 'deleted');
    assert.equal((await api.getItem('a')).name, null);
    assert.equal(db.prepare('SELECT count(*) n FROM photos').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM attributes').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM plan_items').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM worn_records').get().n, 1);
    assert.equal(removed.length, 2);
    await api.restoreItem('a'); await api.archiveItem('a');
    assert.equal((await api.getItem('a')).status, 'deleted');
    await assert.rejects(api.confirmItem('a', { category: '上衣' }));
    assert.equal((await api.listItemIdsByStatus('active')).length, 0);
    await api.purgeItem('a');
  } finally { db.close(); }
});

test('文件清理失败仍标记不可用，保留路径供重试且不返回缩略图', async () => {
  const { api, db, fail } = await setup();
  try {
    fail(true);
    await assert.rejects(api.purgeItem('a'));
    assert.equal((await api.getItem('a')).status, 'deleted');
    assert.equal(await api.getMainThumb('a'), null);
    assert.equal(db.prepare('SELECT count(*) n FROM photos').get().n, 1);
    fail(false); await api.purgeItem('a');
    assert.equal(db.prepare('SELECT count(*) n FROM photos').get().n, 0);
  } finally { db.close(); }
});

test('彻底删除同时清理该衣物的分析任务，晚返回无处可写', async () => {
  const { api, db } = await setup();
  try {
    db.exec(
      "INSERT INTO tasks (id,kind,item_id,status,input_revision,attempt,photo_id,input_key,request_key,config_id,config_snapshot,config_revision,contract_version,prompt_version,created_at,updated_at) " +
        "VALUES ('t1','garment_analysis','a','succeeded',1,1,'p','k','r1','c','{}','legacy','1.0.0-draft','1','now','now')",
    );
    await api.purgeItem('a');
    assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, 0, '任务随资料删除清理');
    assert.equal(db.prepare('SELECT count(*) n FROM plan_items').get().n, 1, '收藏引用保留');
  } finally { db.close(); }
});
