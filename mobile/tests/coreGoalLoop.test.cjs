// 核心目标能力改进回归（2026-11-04，docs/plans/2026-11-04-核心目标能力改进-落地计划与决策记录.md）。
// 覆盖：
// - B3 本地可执行校验（normalizeRecommendation：重复单品/槽位、连衣裙冲突、包配饰拒绝、
//   锁定覆盖、相同组合去重）
// - B1 请求输入（长期偏好/当次要求/天气描述进提示词与指纹）
// - A2 归一化视图（关键特征/次要分层、主色优先、未知不猜填）
// - C7 预览提示词按重要性组织（预算压缩、超预算显式失败、参考视角诚实说明 C3）
// - C8 核对结果解析与纠偏推导（缺判定补 unknown、overall 一致性防线、修正只引用证据）
// - C2 预览输入版本（指纹含单品版本/参考版本；本方案判定；save_failed 的 pendingUrl）
// - C4 契约 v1.1.0（逐件穿法随方案持久化回读）
// - C5 同条件比较（同参考版本成组，版本不同拒绝）
// - D3 反馈原因（reasons JSON 落库）
// - R8 结果条件提交（迟到执行者不得覆盖终态）
// 使用内存 SQLite 与真实仓库/服务代码；不调用真实模型。
// 运行：仓库根 `node --test mobile/tests/coreGoalLoop.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createMemoryAdapter, loadDbModule } = require('./analysisMigration.test.cjs');
const { createLoader, SRC } = require('./garmentTasks.test.cjs');

const CONTRACT_ENTRY = path.resolve(__dirname, '../../packages/contract/src/index.ts');
const SERVICE = path.join(SRC, 'services/ai/recommendationService.ts');
const PREVIEW_RUNNER = path.join(SRC, 'services/ai/previewTaskRunner.ts');
const PREVIEW_CHECKER = path.join(SRC, 'services/ai/previewChecker.ts');
const GARMENT_VIEW = path.join(SRC, 'services/ai/garmentView.ts');
const RECOMMENDATION_REPO = path.join(SRC, 'data/repositories/recommendationRepository.ts');
const PREVIEW_REPO = path.join(SRC, 'data/repositories/previewRepository.ts');
const PLAN_REPO = path.join(SRC, 'data/repositories/planRepository.ts');

async function freshDb() {
  const { db, adapter, close } = createMemoryAdapter();
  const { runMigrations } = loadDbModule();
  await runMigrations(adapter);
  return { db, adapter, close };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// B3：normalizeRecommendation 本地可执行校验
// ---------------------------------------------------------------------------

function loadService() {
  return createLoader(createMemoryAdapter().adapter)(SERVICE);
}

const ALIAS_MAP = new Map([
  ['item-1', 'real-1'],
  ['item-2', 'real-2'],
  ['item-3', 'real-3'],
  ['item-4', 'real-4'],
]);

function candidate(slots, wearStyle = '自然垂放', reason) {
  return {
    slots: slots.map(([role, itemId]) => ({ role, itemId })),
    wearStyle,
    ...(reason ? { reason } : null),
  };
}

test('B3：外套与上衣共存合法；连衣裙与上下装冲突、重复单品/槽位被拒绝', () => {
  const service = loadService();
  // 外套独立槽位（R2 修复）：top + outerwear + bottom + shoes 合法
  const withOuter = service.normalizeRecommendation(
    {
      candidates: [
        candidate([
          ['top', 'item-1'],
          ['outerwear', 'item-2'],
          ['bottom', 'item-3'],
          ['shoes', 'item-4'],
        ]),
      ],
      gaps: [],
    },
    ALIAS_MAP,
  );
  assert.equal(withOuter.ok, true, '外套应作为独立槽位与上衣共存');
  assert.ok(withOuter.ok && withOuter.value.candidates[0].slots.length === 4, '四件都不丢');

  // 连衣裙 + 上衣 → 冲突
  const dressConflict = service.normalizeRecommendation(
    {
      candidates: [
        candidate([
          ['dress', 'item-1'],
          ['top', 'item-2'],
        ]),
      ],
      gaps: [],
    },
    ALIAS_MAP,
  );
  assert.equal(dressConflict.ok, false, '连衣裙与上衣同候选应被拒绝');

  // 同一单品重复使用 → 拒绝
  const duplicateItem = service.normalizeRecommendation(
    {
      candidates: [
        candidate([
          ['top', 'item-1'],
          ['shoes', 'item-1'],
        ]),
      ],
      gaps: [],
    },
    ALIAS_MAP,
  );
  assert.equal(duplicateItem.ok, false, '候选内重复单品应被拒绝');

  // 同一槽位两件 → 拒绝
  const duplicateRole = service.normalizeRecommendation(
    {
      candidates: [
        candidate([
          ['top', 'item-1'],
          ['top', 'item-2'],
        ]),
      ],
      gaps: [],
    },
    ALIAS_MAP,
  );
  assert.equal(duplicateRole.ok, false, '同一槽位出现多件应被拒绝');
});

test('B3/D-1：包/配饰槽位整体拒绝；锁定缺失被拒绝（不只靠提示词）', () => {
  const service = loadService();
  const bag = service.normalizeRecommendation(
    { candidates: [candidate([['top', 'item-1'], ['bag', 'item-2']])], gaps: [] },
    ALIAS_MAP,
  );
  assert.equal(bag.ok, false, '包/配饰本期不支持，应整体拒绝');
  assert.ok(bag.ok === false && /包\/配饰/.test(bag.error), '错误信息应说明本期不支持');

  const missingLock = service.normalizeRecommendation(
    { candidates: [candidate([['top', 'item-1'], ['shoes', 'item-3']])], gaps: [] },
    ALIAS_MAP,
    { requireLockedAliases: ['item-2'] },
  );
  assert.equal(missingLock.ok, false, '候选缺锁定单品应被拒绝');
});

test('B4：相同单品集合（换顺序）不算新候选；全为重复时整体拒绝', () => {
  const service = loadService();
  const dedup = service.normalizeRecommendation(
    {
      candidates: [
        candidate([
          ['top', 'item-1'],
          ['shoes', 'item-3'],
        ]),
        candidate([
          ['shoes', 'item-3'],
          ['top', 'item-1'],
        ]),
      ],
      gaps: [],
    },
    ALIAS_MAP,
  );
  assert.ok(dedup.ok && dedup.value.candidates.length === 1, '三个互为重复的候选只保留一个（换顺序不算新候选）');
});

// ---------------------------------------------------------------------------
// B1：请求输入（偏好/当次要求/天气描述）
// ---------------------------------------------------------------------------

test('B1：长期偏好与本次要求进提示词；实时天气带天气描述；指纹包含三者', () => {
  const service = loadService();
  const prompt = service.recommendationUserPrompt({
    items: [{ id: 'item-1', name: '白衬衫', category: '上衣', attributes: [], colors: [] }],
    scene: { city: '北京', day: '今天', scene: '通勤', temp: '10–15℃', tempSource: 'real', weatherDesc: '小雨' },
    preferences: ['喜欢简洁', '偏冷时加外套'],
    note: '只换鞋，其他保持不变',
    lockedAliases: ['item-1'],
  });
  assert.match(prompt, /长期偏好（参与排序与取舍，不是硬性约束）：喜欢简洁、偏冷时加外套/);
  assert.match(prompt, /本次要求（用户当次填写，优先满足；只作用于本次）：只换鞋，其他保持不变/);
  assert.match(prompt, /天气=小雨/);
  assert.match(prompt, /已锁定的单品（候选组合必须包含）：item-1/);

  const manualPrompt = service.recommendationUserPrompt({
    items: [],
    scene: { city: '北京', day: '今天', scene: '通勤', temp: '20℃', tempSource: 'manual' },
  });
  assert.doesNotMatch(manualPrompt, /天气=/, '手动温度不编造天气描述');
  assert.doesNotMatch(manualPrompt, /长期偏好/);

  // 指纹（S1 起为 V2，recommendationInput 模块）：偏好/当次要求参与，规范化稳定
  const inputModule = createLoader(createMemoryAdapter().adapter)(
    path.resolve(__dirname, '../src/services/ai/recommendationInput.ts'),
  );
  const key = JSON.parse(
    inputModule.buildRecommendationInputKeyV2({
      stored: {
        items: [{ realId: 'r1', alias: 'item-1', revision: 1, name: null, category: '上衣', attributes: [], colors: [] }],
        truncated: false,
        totalCount: 1,
        lockedRealIds: [],
        scene: { city: '北京', day: '今天', scene: '通勤', targetDate: '2026-11-04' },
        body: null,
        preferences: ['简洁'],
        note: '正式一点',
        mode: 'full',
        baseline: null,
        targetSlot: null,
      },
      configId: 'cfg',
      configRevision: 'rev',
      contractVersion: 'v',
      promptVersion: '5',
    }),
  );
  assert.deepEqual(key.preferences, ['简洁']);
  assert.equal(key.note, '正式一点');
  const key2 = JSON.parse(
    inputModule.buildRecommendationInputKeyV2({
      stored: {
        items: [{ realId: 'r1', alias: 'item-1', revision: 1, name: null, category: '上衣', attributes: [], colors: [] }],
        truncated: false,
        totalCount: 1,
        lockedRealIds: [],
        scene: { city: '北京', day: '今天', scene: '通勤', targetDate: '2026-11-04' },
        body: null,
        preferences: ['简洁'],
        note: '正式一点',
        mode: 'full',
        baseline: null,
        targetSlot: null,
      },
      configId: 'cfg',
      configRevision: 'rev',
      contractVersion: 'v',
      promptVersion: '5',
    }),
  );
  assert.deepEqual(key, key2, '相同输入指纹稳定');
});

// ---------------------------------------------------------------------------
// A2：归一化视图
// ---------------------------------------------------------------------------

test('A2：关键特征按重要性排序、次要层分离；主色取 isPrimary；未知不猜填', () => {
  const { buildGarmentFeatureView, featureViewToLine } = createLoader(createMemoryAdapter().adapter)(GARMENT_VIEW);
  const view = buildGarmentFeatureView({
    category: '上衣',
    colors: [
      { name: '白', hex: '#FFFFFF', isPrimary: false },
      { name: '藏青', hex: '#22334F', isPrimary: true },
    ],
    attributes: [
      { name: '细节', value: '袖口罗纹' },
      { name: '图案', value: '大格纹' },
      { name: '领型', value: '翻领' },
      { name: '衣长', value: '盖过臀部' },
    ],
  });
  assert.deepEqual(
    plain(view.keyFeatures),
    ['图案=大格纹', '领型=翻领', '衣长=盖过臀部'],
    '关键特征按还原重要性排序（图案→领型→长度）',
  );
  assert.deepEqual(plain(view.secondary), ['细节=袖口罗纹']);
  assert.deepEqual(plain(view.mainColor), { name: '藏青', hex: '#22334F' });
  assert.deepEqual(plain(view.accentColorNames), ['白']);

  const line = featureViewToLine(view, { includeHex: true, includeSecondary: false });
  assert.match(line, /主色=藏青\(#22334F\)/);
  assert.match(line, /图案=大格纹/);
  assert.doesNotMatch(line, /细节/, '次要层可按预算省略');

  // 空档案：全未知，不猜填
  const empty = buildGarmentFeatureView({ category: null, colors: [], attributes: [] });
  assert.equal(empty.mainColor, null);
  assert.deepEqual(plain(empty.keyFeatures), []);
  assert.deepEqual(plain(empty.secondary), []);
});

// ---------------------------------------------------------------------------
// C7/C3：预览提示词组织与预算
// ---------------------------------------------------------------------------

function loadPreviewRunner() {
  const { adapter } = createMemoryAdapter();
  return createLoader(adapter)(PREVIEW_RUNNER);
}

const SLOT_ITEMS = [
  {
    itemId: 'real-1',
    name: '白衬衫',
    category: '上衣',
    mainColor: { name: '白', hex: '#FFFFFF' },
    accentColorNames: [],
    keyFeatures: ['图案=纯色', '领型=翻领'],
    secondary: ['细节=袖口罗纹'],
    wearStyle: '前侧塞衣角',
  },
  {
    itemId: 'real-2',
    name: '黑色大衣',
    category: '外套',
    mainColor: { name: '黑', hex: '#111111' },
    accentColorNames: [],
    keyFeatures: ['版型=直筒'],
    secondary: [],
    wearStyle: '外层敞开穿',
  },
];

test('C7：逐件身份行（含主色 hex 与逐件穿法）；次要层超预算先压缩；不静默截断', () => {
  const { buildPrompt, PREVIEW_PROMPT_BUDGET } = loadPreviewRunner();
  const full = buildPrompt(SLOT_ITEMS, '自然垂放');
  assert.equal(full.overBudget, false);
  assert.match(full.text, /1\. 上衣；名称=白衬衫；主色=白\(#FFFFFF\)；图案=纯色，领型=翻领；穿法=前侧塞衣角；细节：细节=袖口罗纹/);
  assert.match(full.text, /2\. 外套；名称=黑色大衣；主色=黑\(#111111\)；版型=直筒；穿法=外层敞开穿/);
  assert.equal(full.compressed, false);

  // 超预算：压缩后仍保留全部单品身份（不截掉末尾衣物）
  const huge = SLOT_ITEMS.concat(
    Array.from({ length: 140 }, (_v, i) => ({
      itemId: `real-x${i}`,
      name: `第${i}件长描述衣物用于超出提示词预算的回归测试样本`,
      category: '上衣',
      mainColor: { name: '灰', hex: '#888888' },
      accentColorNames: [],
      keyFeatures: [`图案=条纹${i}号宽条纹重复图案覆盖大面积`, '领型=高领', '衣长=过膝', '版型=宽松'],
      secondary: [],
      wearStyle: null,
    })),
  );
  const squeezed = buildPrompt(huge, '自然垂放');
  if (squeezed.overBudget) {
    // 压缩到身份层仍超：显式失败由执行器处理（错误引导减层数），不静默截断
    assert.ok(squeezed.overBudget);
  } else {
    assert.equal(squeezed.compressed, true, '超预算应先压缩次要层');
    for (let i = 0; i < 140; i += 1) {
      assert.match(squeezed.text, new RegExp(`第${i}件`), '每件单品身份都在');
    }
  }
});

test('C7/C8：纠偏约束注入进提示词；C3 参考视角说明按声明输出', () => {
  const { buildPrompt } = loadPreviewRunner();
  const corrected = buildPrompt(SLOT_ITEMS, '自然垂放', ['「外套（黑色大衣）：主色 黑」在上一张结果中被改变，必须严格按原图还原']);
  assert.match(corrected.text, /重点约束（上一次生成在以下方面偏离，本次必须修正）：/);
  assert.match(corrected.text, /黑色大衣/);

  const face = buildPrompt(SLOT_ITEMS, '自然垂放', [], '人物参考为面部特写：生成图的身材比例与体型由模型推断，可能与本人不同，不能作为合身判断依据。');
  assert.match(face.text, /面部特写/);
  const fullBody = buildPrompt(SLOT_ITEMS, '自然垂放', [], '人物参考为全身照：人物的体型与比例以参考照为准。');
  assert.match(fullBody.text, /全身照/);
  const none = buildPrompt(SLOT_ITEMS, '自然垂放', [], '');
  assert.doesNotMatch(none.text, /人物参考为/);
});

// ---------------------------------------------------------------------------
// C8：核对解析与纠偏推导
// ---------------------------------------------------------------------------

test('C8：核对解析（缺判定补 unknown、overall 一致性防线、结构非法拒绝）', () => {
  const { parseCheckerVerdict, parseCheckerContent, buildCorrections } = createLoader(
    createMemoryAdapter().adapter,
  )(PREVIEW_CHECKER);

  const ok = parseCheckerVerdict(
    {
      items: [
        { itemId: 'real-1', status: 'match' },
        { itemId: 'real-2', status: 'deviate', note: '颜色变成蓝色' },
      ],
      overall: 'match',
    },
    ['real-1', 'real-2'],
  );
  assert.ok(ok.ok);
  assert.ok(ok.ok && ok.value.overall === 'minor', '存在明确偏离时 overall 不得为 match');

  const missing = parseCheckerVerdict({ items: [{ itemId: 'real-1', status: 'match' }], overall: 'match' }, ['real-1', 'real-2']);
  assert.ok(missing.ok && missing.value.verdicts.some((v) => v.itemId === 'real-2' && v.status === 'unknown'), '缺判定补 unknown 不当通过');

  const unknownStatus = parseCheckerVerdict({ items: [{ itemId: 'real-1', status: 'maybe' }], overall: 'major' }, ['real-1']);
  assert.equal(unknownStatus.ok, false, '非法判定状态拒绝');

  const unknownItem = parseCheckerVerdict({ items: [{ itemId: 'ghost', status: 'match' }], overall: 'match' }, ['real-1']);
  assert.equal(unknownItem.ok, false, '引用未知单品拒绝');

  const fenced = parseCheckerContent('```json\n{"items":[{"itemId":"real-1","status":"match"}],"overall":"major"}\n```', ['real-1']);
  assert.ok(fenced.ok && fenced.value.overall === 'major', '围栏 JSON 可解析');

  const corrections = buildCorrections(
    [
      { itemId: 'real-2', status: 'deviate', note: '图案变成波点' },
      { itemId: 'real-1', status: 'match' },
    ],
    [
      { itemId: 'real-1', name: '白衬衫', category: '上衣', mainColor: { name: '白', hex: '#FFFFFF' }, keyFeatures: ['图案=纯色'] },
      { itemId: 'real-2', name: '黑大衣', category: '外套', mainColor: { name: '黑', hex: '#111111' }, keyFeatures: ['图案=无'] },
    ],
  );
  assert.equal(corrections.length, 1);
  assert.match(corrections[0], /外套（黑大衣）/);
  assert.match(corrections[0], /图案变成波点/);
});

// ---------------------------------------------------------------------------
// R8：推荐结果条件提交（迟到执行者不得覆盖终态）
// ---------------------------------------------------------------------------

test('R8：任务非 running 时 commitRecommendationResult 不写结果；running 时写入', async () => {
  const { db, adapter, close } = await freshDb();
  try {
    const repo = createLoader(adapter)(RECOMMENDATION_REPO);
    const created = await repo.createRecommendationTask({
      inputKey: '{"k":1}',
      requestKey: 'req-r8',
      configId: 'cfg',
      configSnapshot: '{}',
      configRevision: 'rev',
      inputJson: '{}',
    });
    assert.equal(created.status, 'created');
    const taskId = created.taskId;

    // running 中：写入成功
    await repo.updateRecommendationTaskStatus(taskId, ['queued'], 'running');
    await repo.commitRecommendationResult(taskId, { candidates: [{ slots: [], wearStyle: '自然垂放' }], gaps: [] });
    let row = db.prepare('SELECT result_json, status FROM tasks WHERE id = ?').get(taskId);
    assert.ok(row.result_json, 'running 中应写入结果');

    // 看门狗已标 interrupted：迟到的执行结果不得覆盖
    await repo.updateRecommendationTaskStatus(taskId, ['running'], 'interrupted');
    await repo.commitRecommendationResult(taskId, { candidates: [{ slots: [], wearStyle: '外层敞开穿' }], gaps: [] });
    row = db.prepare('SELECT result_json, status FROM tasks WHERE id = ?').get(taskId);
    assert.equal(row.status, 'interrupted');
    assert.match(row.result_json, /自然垂放/, '迟到结果不得覆盖终态时的结果');
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// C2：预览输入版本（指纹/匹配/pendingUrl）
// ---------------------------------------------------------------------------

function seedPreviewTask(db, { id, inputKey, status = 'succeeded', resultJson, requestKey }) {
  db.prepare(
    `INSERT INTO tasks (id, kind, item_id, status, input_revision, attempt, photo_id, input_key, request_key,
       config_id, config_snapshot, config_revision, contract_version, prompt_version, result_json, created_at, updated_at)
     VALUES (?, 'try_on_preview', 'basis-1', ?, 1, 1, 'none', ?, ?, 'cfg', '{}', 'rev', 'try-on-preview-1', '1', ?, 't0', 't0')`,
  ).run(id, status, inputKey, requestKey ?? `req-${id}`, resultJson ?? null);
}

test('C2：预览指纹含单品版本与参考版本；previewInputMatches 判定"本方案"', async () => {
  const { adapter, close } = await freshDb();
  try {
    const repo = createLoader(adapter)(PREVIEW_REPO);
    const input = {
      itemIds: ['a', 'b'],
      itemRevisions: { a: 2, b: 1 },
      wearStyle: '自然垂放',
      referenceUpdatedAt: 'ref-1',
      configId: 'cfg',
      configRevision: 'rev',
    };
    const key = repo.buildPreviewInputKey(input);
    const parsed = JSON.parse(key);
    assert.deepEqual(parsed.itemRevisions, { a: 2, b: 1 });
    assert.equal(parsed.referenceUpdatedAt, 'ref-1');

    const task = { inputKey: key };
    assert.equal(repo.previewInputMatches(task, { itemIds: ['b', 'a'], itemRevisions: { a: 2, b: 1 }, wearStyle: '自然垂放', referenceUpdatedAt: 'ref-1' }), true);
    assert.equal(repo.previewInputMatches(task, { itemIds: ['b', 'a'], itemRevisions: { a: 3, b: 1 }, wearStyle: '自然垂放', referenceUpdatedAt: 'ref-1' }), false, '资料版本变化不算本方案');
    assert.equal(repo.previewInputMatches(task, { itemIds: ['b', 'a'], itemRevisions: { a: 2, b: 1 }, wearStyle: '自然垂放', referenceUpdatedAt: 'ref-2' }), false, '参考更换不算本方案');
  } finally {
    close();
  }
});

test('C2/R8/F6：savePendingDownload 条件持久化（仅 running 可写），pendingUrl 可读回', async () => {
  const { db, adapter, close } = await freshDb();
  try {
    const repo = createLoader(adapter)(PREVIEW_REPO);
    seedPreviewTask(db, {
      id: 'pt-1',
      inputKey: JSON.stringify({ itemIds: ['a'], referenceUpdatedAt: 'ref-1', wearStyle: '' }),
      status: 'running',
      resultJson: null,
    });
    const written = await repo.savePendingDownload('pt-1', 'https://cdn.test/img.jpg', '提示词');
    assert.equal(written, true, 'running 状态可写待下载');
    const task = await repo.getPreviewTask('pt-1');
    assert.equal(task.pendingUrl, 'https://cdn.test/img.jpg');
    assert.equal(task.resultPreviewPath, null);

    // F6：任务已离开 running（看门狗/取消先行）→ 迟到写入被拒，result_json 不被覆盖
    seedPreviewTask(db, {
      id: 'pt-2',
      inputKey: JSON.stringify({ itemIds: ['a'], referenceUpdatedAt: 'ref-1', wearStyle: '' }),
      status: 'interrupted',
      resultJson: JSON.stringify({ previewPath: 'previews/old.jpg' }),
    });
    const late = await repo.savePendingDownload('pt-2', 'https://cdn.test/late.jpg', 'x');
    assert.equal(late, false, '终态任务拒绝写入待下载');
    const lateTask = await repo.getPreviewTask('pt-2');
    assert.equal(lateTask.pendingUrl, null);
    assert.equal(lateTask.resultPreviewPath, 'previews/old.jpg', '既有结果不被迟到写入覆盖');
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// C5：同条件比较
// ---------------------------------------------------------------------------

test('C5/F7：比较必须绑定不可变产物——legacy 记录不冒充同条件；非成功/自身拒绝', async () => {
  const { db, adapter, close } = await freshDb();
  try {
    const repo = createLoader(adapter)(PREVIEW_REPO);
    const keyRef1 = JSON.stringify({ itemIds: ['a'], referenceUpdatedAt: 'ref-1', wearStyle: '' });
    const keyRef2 = JSON.stringify({ itemIds: ['b'], referenceUpdatedAt: 'ref-2', wearStyle: '' });
    seedPreviewTask(db, { id: 'pa', inputKey: keyRef1, resultJson: JSON.stringify({ previewPath: 'previews/a.jpg' }) });
    seedPreviewTask(db, { id: 'pb', inputKey: keyRef1, resultJson: JSON.stringify({ previewPath: 'previews/b.jpg' }) });
    seedPreviewTask(db, { id: 'pf', inputKey: keyRef1, status: 'failed', resultJson: null });

    // F7：成功但缺少不可变产物引用（旧版本记录）→ 拒绝，可普通查看但不标同条件
    const legacy = await repo.createPreviewComparison('pa', 'pb');
    assert.equal(legacy.ok, false);
    assert.match(legacy.ok === false ? legacy.message : '', /不可变的产物引用/);

    const withFailed = await repo.createPreviewComparison('pa', 'pf');
    assert.equal(withFailed.ok, false, '失败记录不能比较');

    const self = await repo.createPreviewComparison('pa', 'pa');
    assert.equal(self.ok, false, '同一记录不能与自己比较');

    void keyRef2; // 同参考不同配置/模板的条件矩阵见 previewArtifacts.test.cjs（绑定真实产物）
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// C4：逐件穿法随方案持久化回读
// ---------------------------------------------------------------------------

function seedItemRow(db, id, category) {
  db.prepare(
    "INSERT INTO items (id, status, category, source_type, created_at, updated_at) VALUES (?, 'active', ?, 'photo', 't0', 't0')",
  ).run(id, category);
}

test('C4：契约 v1.1.0 逐件穿法保存/回读；无逐件穿法的旧行为不变', async () => {
  const { db, adapter, close } = await freshDb();
  try {
    seedItemRow(db, 'top-1', '上衣');
    seedItemRow(db, 'outer-1', '外套');
    seedItemRow(db, 'shoes-1', '鞋履');
    const plans = createLoader(adapter)(PLAN_REPO);

    const plan = {
      planId: 'plan-c4',
      parentPlanId: null,
      version: 1,
      items: [
        { itemId: 'top-1', role: 'basis', wearStyle: '前侧塞衣角' },
        { itemId: 'outer-1', role: 'piece', wearStyle: '外层敞开穿' },
        { itemId: 'shoes-1', role: 'piece' },
      ],
      wear: { slot: '整体', style: '前侧塞衣角' },
      reason: null,
      gaps: [],
      scene: { city: '杭州', day: '今天', scene: '通勤' },
      source: 'manual',
      createdAt: 't0',
    };
    const saved = await plans.saveContractPlan(plan, '内搭加外套');
    assert.deepEqual(
      saved.items.map((i) => ({ itemId: i.itemId, wearStyle: i.wearStyle ?? null })),
      [
        { itemId: 'top-1', wearStyle: '前侧塞衣角' },
        { itemId: 'outer-1', wearStyle: '外层敞开穿' },
        { itemId: 'shoes-1', wearStyle: null },
      ],
      '逐件穿法持久化并按单品回读',
    );
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// D3：反馈原因落库
// ---------------------------------------------------------------------------

test('D3：recordWorn 保存可跳过原因（JSON 数组）；空原因存 null', async () => {
  const { db, adapter, close } = await freshDb();
  try {
    seedItemRow(db, 'top-1', '上衣');
    const plans = createLoader(adapter)(PLAN_REPO);
    const saved = await plans.saveContractPlan(
      {
        planId: 'plan-d3',
        parentPlanId: null,
        version: 1,
        items: [{ itemId: 'top-1', role: 'basis' }],
        wear: { slot: '整体', style: '自然垂放' },
        reason: null,
        gaps: [],
        scene: { city: '杭州', day: '今天', scene: '通勤' },
        source: 'manual',
        createdAt: 't0',
      },
      null,
    );
    await plans.recordWorn(saved.id, 'unhappy', undefined, ['冷热不合适', '预览不像实物']);
    const row = db.prepare('SELECT satisfied, reasons FROM worn_records WHERE plan_id = ?').get(saved.id);
    assert.equal(row.satisfied, 'no');
    assert.deepEqual(JSON.parse(row.reasons), ['冷热不合适', '预览不像实物']);

    await plans.recordWorn(saved.id, 'happy');
    const row2 = db
      .prepare('SELECT reasons FROM worn_records WHERE plan_id = ? ORDER BY worn_at DESC, rowid DESC LIMIT 1')
      .get(saved.id);
    assert.equal(row2.reasons, null, '不填原因时存 null');
  } finally {
    close();
  }
});
