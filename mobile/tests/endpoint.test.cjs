// M6 批次 1 补充回归：实际请求地址拼接规则（2026-11-03 项目用户确认调整）。
// - openai：基础地址（填到版本号为止）自动拼接 /chat/completions
// - minimax：完整接口地址直填、不再自动拼接——自动补路径会把
//   https://api.minimax.cn/v1 变成 /v1/v1/image_generation（真机 404 实证）
// M6 批次 2 补充回归：明文收敛——服务地址仅接受 https（insecureUrlProblem）。
// 运行：仓库根 `node --test mobile/tests/endpoint.test.cjs`

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../src/services/ai/types.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(js, {
  exports: mod.exports,
  module: mod,
  require(id) {
    throw new Error(`Unexpected dependency: ${id}`);
  },
}, { filename: 'types.ts' });
const { endpointFor, insecureUrlProblem } = mod.exports;

test('openai：基础地址自动拼接 /chat/completions，容忍结尾斜杠', () => {
  assert.equal(endpointFor('openai', 'https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
  assert.equal(endpointFor('openai', 'https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
});

test('minimax：完整接口地址直填，不追加任何路径', () => {
  assert.equal(endpointFor('minimax', 'https://api.minimax.cn/v1/image_generation'), 'https://api.minimax.cn/v1/image_generation');
  assert.equal(endpointFor('minimax', 'https://api.minimax.cn/v1/image_generation/'), 'https://api.minimax.cn/v1/image_generation');
  assert.equal(endpointFor('minimax', 'https://self-hosted.lan:8000/custom/path'), 'https://self-hosted.lan:8000/custom/path');
});

test('明文收敛：服务地址仅接受 https（M6 批次 2）', () => {
  assert.equal(insecureUrlProblem('https://api.example.com/v1'), null);
  assert.equal(insecureUrlProblem('HTTPS://api.example.com/v1/image_generation'), null);
  assert.match(insecureUrlProblem('http://192.168.1.10:8000/v1'), /https/);
  assert.match(insecureUrlProblem('ftp://example.com'), /https/);
  assert.match(insecureUrlProblem('api.example.com/v1'), /https/);
  assert.equal(insecureUrlProblem('   '), null); // 空值交由必填校验处理
});

// ---------------------------------------------------------------------------
// H3-Image 接入回归（2026-11-13）：模型代际分流、端点改写、请求形态与响应解析。
// ---------------------------------------------------------------------------
const mmSource = fs.readFileSync(path.resolve(__dirname, '../src/services/ai/clients/minimaxClient.ts'), 'utf8');
const mmJs = ts.transpileModule(mmSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function loadMinimax(fetchStub) {
  const modMm = { exports: {} };
  vm.runInNewContext(mmJs, {
    exports: modMm.exports, module: modMm,
    fetch: fetchStub,
    AbortController,
    setTimeout,
    clearTimeout,
    require(id) {
      if (id === '../types') return { endpointFor };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  }, { filename: 'minimaxClient.ts' });
  return modMm.exports;
}

test('H3 判定与端点改写：image_generation → edits/generations，已填目标接口原样', () => {
  const mm = loadMinimax(async () => new Response('{}'));
  assert.equal(mm.isH3ImageModel('MiniMax-H3-Image'), true);
  assert.equal(mm.isH3ImageModel('minimax-h3-image-highspeed'), true);
  assert.equal(mm.isH3ImageModel('image-01'), false);
  assert.equal(mm.h3EndpointFor('https://api.minimax.cn/v1/image_generation', true), 'https://api.minimax.cn/v1/images/edits');
  assert.equal(mm.h3EndpointFor('https://api.minimax.cn/v1/image_generation', false), 'https://api.minimax.cn/v1/images/generations');
  assert.equal(mm.h3EndpointFor('https://api.minimax.cn/v1/images/edits', true), 'https://api.minimax.cn/v1/images/edits');
  assert.equal(mm.h3EndpointFor('https://api.minimax.cn/v1/images/generations', true), 'https://api.minimax.cn/v1/images/edits');
  assert.equal(mm.h3EndpointFor('https://api.minimax.cn/v1/images/generations', false), 'https://api.minimax.cn/v1/images/generations');
});

test('H3 生成：人物+衣物走 edits，images 数组=1+N，data[].url 解析', async () => {
  let captured = null;
  const mm = loadMinimax(async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.com/out-0.jpg', size: '1536x2304' }] }), { status: 200 });
  });
  const result = await mm.generateImage(
    { urlKind: 'minimax', baseUrl: 'https://api.minimax.cn/v1/image_generation', modelId: 'MiniMax-H3-Image' },
    'sk-t',
    { prompt: '让人物穿上衣物', personImage: 'data:image/jpeg;base64,PERSON', garmentImages: ['data:image/jpeg;base64,A', null, 'data:image/jpeg;base64,B'], aspectRatio: '2:3', n: 1 },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.imageUrls, ['https://cdn.example.com/out-0.jpg']);
  assert.equal(captured.url, 'https://api.minimax.cn/v1/images/edits');
  assert.equal(captured.body.model, 'MiniMax-H3-Image');
  assert.equal(captured.body.images.length, 3); // 人物 1 + 衣物 2（null 已过滤）
  assert.equal(captured.body.images[0].image_url, 'data:image/jpeg;base64,PERSON');
  assert.equal(captured.body.aspect_ratio, '2:3');
  assert.equal(captured.body.subject_reference, undefined);
});

test('H3 无参考图走 generations（连接测试场景），部分失败读取 error 项', async () => {
  let captured = null;
  const mm = loadMinimax(async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: [{ error: { code: '1027', message: 'content safety' } }] }), { status: 200 });
  });
  const noImage = await mm.generateImage(
    { urlKind: 'minimax', baseUrl: 'https://api.minimax.cn/v1/image_generation', modelId: 'MiniMax-H3-Image' },
    'sk-t',
    { prompt: '测试图' },
  );
  assert.equal(captured.url, 'https://api.minimax.cn/v1/images/generations');
  assert.equal(captured.body.images, undefined);
  assert.equal(noImage.ok, false);
  assert.match(noImage.error.message, /1027/);

  const mm2 = loadMinimax(async () => new Response('{}', { status: 402 }));
  const quota = await mm2.generateImage(
    { urlKind: 'minimax', baseUrl: 'https://api.minimax.cn/v1/images/edits', modelId: 'MiniMax-H3-Image' },
    'sk-t',
    { prompt: 'x', personImage: 'data:image/jpeg;base64,P' },
  );
  assert.equal(quota.error.kind, 'quota');
});

test('旧 image-01 回归：subject_reference 形态不变，地址直填', async () => {
  let captured = null;
  const mm = loadMinimax(async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: { image_urls: ['https://cdn.example.com/legacy.jpg'] }, base_resp: { status_code: 0 } }), { status: 200 });
  });
  const result = await mm.generateImage(
    { urlKind: 'minimax', baseUrl: 'https://api.minimax.cn/v1/image_generation', modelId: 'image-01' },
    'sk-t',
    { prompt: '旧路径', personImage: 'data:image/jpeg;base64,P', garmentImages: ['data:image/jpeg;base64,IGNORED'], aspectRatio: '2:3' },
  );
  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://api.minimax.cn/v1/image_generation');
  assert.deepEqual(captured.body.subject_reference, [{ type: 'character', image_file: 'data:image/jpeg;base64,P' }]);
  assert.equal(captured.body.images, undefined); // 衣物图不进旧协议
});
