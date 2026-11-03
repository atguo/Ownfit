// M6 批次 2 回归：身材资料（身高/体重选填）存取语义（2026-11-03 项目用户决定内测前实现基础录入）。
// - 保存后可读取、数值一位小数、updatedAt 更新；两项都空视为清除（删记录）
// - 记录损坏/非法数值按"未填写"处理，不抛错
// - preferences 前缀纪律：body-profile 不带 pref- 前缀，不混入长期偏好读取
// 使用内存 SQLite 与真实 settingsRepository；不触碰真实文件与设备。
// 运行：仓库根 `node --test mobile/tests/bodyProfile.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createMemoryAdapter, loadDbModule } = require('./analysisMigration.test.cjs');
const { createLoader, SRC } = require('./garmentTasks.test.cjs');

const SETTINGS_REPOSITORY = path.join(SRC, 'data/repositories/settingsRepository.ts');

async function setup() {
  const { db, adapter, close } = createMemoryAdapter();
  const { runMigrations } = loadDbModule();
  await runMigrations(adapter);
  const repo = createLoader(adapter)(SETTINGS_REPOSITORY);
  return { repo, db, close };
}

test('身材资料：保存/更新/清除与一位小数规整', async () => {
  const { repo, close } = await setup();
  try {
    assert.equal(await repo.getBodyProfile(), null);

    const saved = await repo.saveBodyProfile({ heightCm: 170.44, weightKg: 60 });
    assert.equal(saved.heightCm, 170.4);
    assert.equal(saved.weightKg, 60);
    assert.ok(saved.updatedAt.length > 0);

    const loaded = await repo.getBodyProfile();
    assert.equal(loaded.heightCm, 170.4);
    assert.equal(loaded.weightKg, 60);

    // 部分更新：只留身高，体重移除
    const updated = await repo.saveBodyProfile({ heightCm: 171, weightKg: null });
    assert.equal(updated.heightCm, 171);
    assert.equal(updated.weightKg, undefined);
    assert.equal((await repo.getBodyProfile()).weightKg, undefined);

    // 两项都空视为清除
    assert.equal(await repo.saveBodyProfile({ heightCm: null, weightKg: null }), null);
    assert.equal(await repo.getBodyProfile(), null);
  } finally {
    close();
  }
});

test('身材资料：非法数值按未填写处理，损坏记录返回 null 不抛错', async () => {
  const { repo, db, close } = await setup();
  try {
    // 负数/0/NaN：存不进（两项都非法 → 记录被清除并返回 null）
    assert.equal(await repo.saveBodyProfile({ heightCm: -1, weightKg: 0 }), null);
    assert.equal(await repo.getBodyProfile(), null);

    await repo.saveBodyProfile({ heightCm: 170, weightKg: 60 });
    db.prepare('UPDATE preferences SET value = ? WHERE id = ?').run('{not json', 'body-profile');
    assert.equal(await repo.getBodyProfile(), null);

    db.prepare('UPDATE preferences SET value = ? WHERE id = ?').run('{"heightCm":"tall","weightKg":60}', 'body-profile');
    const repaired = await repo.getBodyProfile();
    assert.equal(repaired.heightCm, undefined);
    assert.equal(repaired.weightKg, 60);
  } finally {
    close();
  }
});

test('preferences 前缀纪律：body-profile 不混入长期偏好，偏好也不进身材资料', async () => {
  const { repo, close } = await setup();
  try {
    await repo.saveBodyProfile({ heightCm: 170 });
    await repo.setPreferences(['简约']);
    assert.deepEqual(await repo.getPreferences(), ['简约']);
    assert.equal((await repo.getBodyProfile()).heightCm, 170);
  } finally {
    close();
  }
});
