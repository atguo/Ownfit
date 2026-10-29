// 直接执行真实会话模块；仅替换 React 订阅与设备数据库边界，不加载原生运行时。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { test } = require('node:test');

function session() {
  const filename = path.resolve(__dirname, '../src/features/outfitSession.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const items = {
    A: { category: '上衣' }, B: { category: '上衣' }, C: { category: '上衣' },
    pants: { category: '下装' }, shoes: { category: '鞋履' }, shoes2: { category: '鞋履' },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    exports: module.exports, module,
    require(id) {
      if (id === 'react') return { useSyncExternalStore() { throw new Error('No UI in test'); } };
      if (id === '../data/repositories/itemRepository') return {
        getItem: async (id) => items[id] ? { ...items[id], status: 'active' } : undefined,
        listItemIdsByStatus: async () => ['A', 'pants', 'shoes', 'B', 'C', 'shoes2'],
      };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  }, { filename });
  return module.exports;
}

const scene = { city: '杭州', day: '今天', scene: '通勤' };
function assertSaved(s, basis, expected) {
  // buildContractPlan 是页面提交 saveContractPlan 前的实际保存输入。
  const plan = s.buildContractPlan('saved-plan', scene);
  assert.deepEqual(Array.from(plan.items, (i) => i.itemId).sort(), [...expected].sort());
  assert.equal(plan.items.filter((i) => i.role === 'basis').length, 1);
  assert.equal(plan.items.find((i) => i.role === 'basis').itemId, basis);
  assert.equal(s.getOutfitSession().basisId, basis);
}

test('锁定时拒绝替换；解锁换基础上衣后保存仍为三件；连续替换及撤销一致', async () => {
  const s = session();
  await s.startOutfitFrom('A');
  assert.equal(s.replaceSlot('top', 'B'), 'locked');
  assertSaved(s, 'A', ['A', 'pants', 'shoes']);
  s.toggleLock('A');
  assert.equal(s.replaceSlot('top', 'B'), 'ok');
  assertSaved(s, 'B', ['B', 'pants', 'shoes']);
  assert.equal(s.isLocked('B'), false);
  s.replaceSlot('top', 'C');
  assertSaved(s, 'C', ['C', 'pants', 'shoes']);
  assert.equal(s.outfitUndo(), true);
  assertSaved(s, 'B', ['B', 'pants', 'shoes']);
  assert.equal(s.outfitUndo(), true);
  assertSaved(s, 'A', ['A', 'pants', 'shoes']);
});

test('替换非基础槽位不改变基础单品，复用后替换与撤销仍一致', async () => {
  const s = session();
  await s.startOutfitFrom('A');
  s.replaceSlot('shoes', 'shoes2');
  assertSaved(s, 'A', ['A', 'pants', 'shoes2']);
  s.outfitUndo();
  assertSaved(s, 'A', ['A', 'pants', 'shoes']);
  s.loadOutfitFrom({ planId: 'parent', name: null, basisId: 'B',
    slots: { top: 'B', bottom: 'pants', shoes: 'shoes' },
    wear: '自然垂放', itemIds: ['B', 'pants', 'shoes'] });
  s.toggleLock('B');
  s.replaceSlot('top', 'C');
  assertSaved(s, 'C', ['C', 'pants', 'shoes']);
  assert.equal(s.buildContractPlan('next', scene).parentPlanId, 'parent');
  s.outfitUndo();
  assertSaved(s, 'B', ['B', 'pants', 'shoes']);
});
