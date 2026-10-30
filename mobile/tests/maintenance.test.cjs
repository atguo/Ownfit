// M4 批 1 回归：数据一致性维护（扫描 / 孤儿清理 / 缩略图重建 / 容量检查）。
// 使用内存 SQLite + 可编程内存文件系统；不触碰真实文件，不调用真实图像处理。
// 运行：仓库根 `node --test mobile/tests/maintenance.test.cjs`

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

/**
 * 可编程内存文件系统：
 * - File：exists/size/name/delete/move/textSync/writeSync
 * - Directory：exists（有文件或被 create 过）/create/list
 * - freeBytes 可编程（容量检查）；freeThrows 模拟系统接口失败
 */
function createHarness() {
  const files = new Map();
  const dirCreated = new Set();
  let freeBytes = 200 * 1024 * 1024;
  let freeThrows = false;
  let genCount = 0;
  let manipulatorFails = false;

  function toUri(parts) {
    let out = '';
    for (const part of parts.map((p) =>
      typeof p === 'string' ? p : p && typeof p.uri === 'string' ? p.uri.replace(/\/+$/, '') : '',
    )) {
      if (!part) continue;
      out = out.endsWith('/') ? out + part.replace(/^\/+/, '') : out ? `${out}/${part.replace(/^\/+/, '')}` : part;
    }
    return out;
  }

  class File {
    constructor(...parts) {
      this.uri = toUri(parts);
    }
    get name() {
      return this.uri.split('/').pop();
    }
    get exists() {
      return files.has(this.uri);
    }
    get size() {
      const content = files.get(this.uri);
      return content === undefined ? null : content.length;
    }
    delete() {
      files.delete(this.uri);
    }
    move(target) {
      const content = files.get(this.uri);
      if (content === undefined) throw new Error(`move source missing: ${this.uri}`);
      files.set(target.uri, content);
      files.delete(this.uri);
    }
    textSync() {
      return files.get(this.uri) ?? '';
    }
    writeSync(content) {
      files.set(this.uri, String(content));
    }
    async base64() {
      return files.get(this.uri) ?? '';
    }
  }

  class Directory {
    constructor(...parts) {
      this.uri = toUri(parts);
    }
    get name() {
      return this.uri.split('/').pop();
    }
    get exists() {
      if (dirCreated.has(this.uri)) return true;
      const prefix = this.uri + '/';
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) return true;
      }
      return this.uri === 'file:///document';
    }
    create() {
      dirCreated.add(this.uri);
    }
    list() {
      const prefix = this.uri + '/';
      const out = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          out.push(new File(key));
        }
      }
      return out;
    }
  }

  const fileSystemStub = { File, Directory, Paths: { document: { uri: 'file:///document' } } };
  const legacyStub = {
    getFreeDiskStorageAsync: async () => {
      if (freeThrows) throw new Error('storage probe unavailable');
      return freeBytes;
    },
  };
  const manipulatorStub = {
    SaveFormat: { JPEG: 'jpeg' },
    ImageManipulator: {
      manipulate: (uri) => ({
        resize: () => ({
          renderAsync: async () => ({
            saveAsync: async () => {
              if (manipulatorFails) throw new Error('render failed');
              const out = `file:///cache/generated-${++genCount}.jpg`;
              files.set(out, 'generated-jpeg-bytes');
              return { uri: out };
            },
          }),
        }),
      }),
    },
  };

  function createLoader(adapter) {
    const cache = new Map();
    const stubs = {
      'expo-file-system': fileSystemStub,
      'expo-file-system/legacy': legacyStub,
      'expo-image-manipulator': manipulatorStub,
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

  return {
    files,
    File,
    setFreeBytes: (n) => {
      freeBytes = n;
    },
    setFreeThrows: (v) => {
      freeThrows = v;
    },
    setManipulatorFails: (v) => {
      manipulatorFails = v;
    },
    createLoader,
  };
}

/** 把 vm 上下文里创建的对象转为普通对象，便于跨 realm deepEqual */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function setup() {
  const { db, adapter, close } = createMemoryAdapter();
  const { runMigrations } = loadDbModule();
  await runMigrations(adapter);
  const harness = createHarness();
  const load = harness.createLoader(adapter);
  db.exec('PRAGMA foreign_keys = ON');
  const repos = {
    maintenance: load(path.join(SRC, 'data/repositories/maintenanceRepository.ts')),
    photos: load(path.join(SRC, 'data/repositories/photoRepository.ts')),
  };
  function seedItem(id, mainPhotoId) {
    db.exec(
      `INSERT INTO items (id,status,category,name,source_type,main_photo_id,revision,created_at,updated_at)
       VALUES ('${id}','active','上衣','衣服','photo',${mainPhotoId ? `'${mainPhotoId}'` : 'NULL'},1,'t','t')`,
    );
  }
  function seedPhoto(id, itemId, originalPath, thumbPath) {
    db.exec(
      `INSERT INTO photos (id,item_id,kind,original_path,thumb_path,created_at)
       VALUES ('${id}','${itemId}','main','${originalPath}','${thumbPath}','t')`,
    );
  }
  function putFile(relativePath, content = 'jpeg-bytes') {
    harness.files.set(`file:///document/${relativePath}`, content);
  }
  return { db, adapter, close, harness, files: harness.files, load, repos, seedItem, seedPhoto, putFile };
}

test('扫描：健康库全部为空；缺原件/缺缩略图/悬空主图/孤儿文件逐项报出', async () => {
  const ctx = await setup();
  try {
    ctx.seedItem('item-a', 'p1');
    ctx.seedPhoto('p1', 'item-a', 'photos/p1.jpg', 'thumbs/p1.jpg');
    ctx.putFile('photos/p1.jpg');
    ctx.putFile('thumbs/p1.jpg');

    const healthy = await ctx.repos.maintenance.scanConsistency();
    assert.deepEqual(plain(healthy.missingFiles), []);
    assert.deepEqual(plain(healthy.danglingMainRefs), []);
    assert.deepEqual(plain(healthy.orphanFiles), []);
    assert.deepEqual(plain(healthy.rebuildableThumbs), []);

    // 原件缺失 → missing(['original'])，不可重建
    ctx.harness.files.delete('file:///document/photos/p1.jpg');
    // 缩略图缺失（另一条记录）→ 可重建
    ctx.seedItem('item-b', 'p2');
    ctx.seedPhoto('p2', 'item-b', 'photos/p2.jpg', 'thumbs/p2.jpg');
    ctx.putFile('photos/p2.jpg');
    // 悬空主图引用
    ctx.seedItem('item-c', 'p-missing');
    // 孤儿文件
    ctx.putFile('photos/orphan.jpg');
    ctx.putFile('thumbs/orphan.jpg');

    const report = await ctx.repos.maintenance.scanConsistency();
    assert.equal(report.missingFiles.length, 2);
    const p1 = plain(report.missingFiles).find((m) => m.photoId === 'p1');
    assert.deepEqual(p1.missing, ['original']);
    const p2 = plain(report.missingFiles).find((m) => m.photoId === 'p2');
    assert.deepEqual(p2.missing, ['thumb']);
    assert.deepEqual(plain(report.rebuildableThumbs), ['p2'], '原件缺失的不可重建');
    assert.deepEqual(plain(report.danglingMainRefs), [{ itemId: 'item-c', mainPhotoId: 'p-missing' }]);
    assert.deepEqual(plain(report.orphanFiles).sort(), ['photos/orphan.jpg', 'thumbs/orphan.jpg']);
  } finally {
    ctx.close();
  }
});

test('清理：只删无引用文件，被引用文件保留；清理后无孤儿', async () => {
  const ctx = await setup();
  try {
    ctx.seedItem('item-a', 'p1');
    ctx.seedPhoto('p1', 'item-a', 'photos/p1.jpg', 'thumbs/p1.jpg');
    ctx.putFile('photos/p1.jpg');
    ctx.putFile('thumbs/p1.jpg');
    ctx.putFile('photos/orphan.jpg');

    const { deleted } = await ctx.repos.maintenance.cleanOrphanFiles();
    assert.deepEqual(plain(deleted), ['photos/orphan.jpg']);
    assert.equal(ctx.files.has('file:///document/photos/p1.jpg'), true, '被引用原件必须保留');
    assert.equal(ctx.files.has('file:///document/photos/orphan.jpg'), false);

    const report = await ctx.repos.maintenance.scanConsistency();
    assert.deepEqual(plain(report.orphanFiles), []);
  } finally {
    ctx.close();
  }
});

test('缩略图重建：从原件再生并落位；重建失败如实报告', async () => {
  const ctx = await setup();
  try {
    ctx.seedItem('item-a', 'p1');
    ctx.seedPhoto('p1', 'item-a', 'photos/p1.jpg', 'thumbs/p1.jpg');
    ctx.putFile('photos/p1.jpg'); // 缩略图缺失，原件在

    const { rebuilt, failed } = await ctx.repos.maintenance.rebuildMissingThumbnails();
    assert.deepEqual(plain(rebuilt), ['p1']);
    assert.deepEqual(plain(failed), []);
    assert.equal(ctx.files.has('file:///document/thumbs/p1.jpg'), true, '缩略图应写回原路径');

    const report = await ctx.repos.maintenance.scanConsistency();
    assert.deepEqual(plain(report.rebuildableThumbs), []);

    // 处理失败如实报告，不伪装成功
    ctx.harness.files.delete('file:///document/thumbs/p1.jpg');
    ctx.harness.setManipulatorFails(true);
    const second = await ctx.repos.maintenance.rebuildMissingThumbnails();
    assert.deepEqual(plain(second.rebuilt), []);
    assert.deepEqual(plain(second.failed), ['p1']);
  } finally {
    ctx.close();
  }
});

test('容量：低于阈值拒绝保存并明确报错；探测失败不阻断（由写入失败兜底）', async () => {
  const ctx = await setup();
  try {
    ctx.harness.setFreeBytes(10 * 1024 * 1024);
    await assert.rejects(
      () =>
        ctx.repos.photos.savePhotoFiles({ sourceUri: 'file:///cache/in.jpg', sourceWidth: 800, sourceHeight: 600 }),
      /存储空间不足/,
    );

    ctx.harness.setFreeBytes(200 * 1024 * 1024);
    ctx.harness.setFreeThrows(true);
    // 探测失败放行：不再因容量检查抛错（后续写入是另一层兜底；
    // 这里 ImageManipulator stub 会继续走，因此只断言不因容量被拒）
    let rejectedForCapacity = false;
    try {
      await ctx.repos.photos.savePhotoFiles({ sourceUri: 'file:///cache/in.jpg', sourceWidth: 800, sourceHeight: 600 });
    } catch (error) {
      rejectedForCapacity = /存储空间不足/.test(error instanceof Error ? error.message : String(error));
    }
    assert.equal(rejectedForCapacity, false, '探测失败不得以容量为由拒绝');
  } finally {
    ctx.close();
  }
});
