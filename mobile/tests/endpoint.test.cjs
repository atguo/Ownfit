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
const { endpointFor, insecureUrlProblem, isImageGenUrlKind } = mod.exports;

test('openai：基础地址自动拼接 /chat/completions，容忍结尾斜杠', () => {
  assert.equal(endpointFor('openai', 'https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
  assert.equal(endpointFor('openai', 'https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
});

test('openai_images：基础地址自动拼接 /images/generations，已填完整图像路径原样保留', () => {
  assert.equal(
    endpointFor('openai_images', 'https://ark.cn-beijing.volces.com/api/v3'),
    'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  );
  assert.equal(
    endpointFor('openai_images', 'https://ark.cn-beijing.volces.com/api/v3/'),
    'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  );
  assert.equal(
    endpointFor('openai_images', 'https://ark.cn-beijing.volces.com/api/v3/images/generations'),
    'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  );
  assert.equal(
    endpointFor('openai_images', 'https://gateway.example.com/v1/images/edits'),
    'https://gateway.example.com/v1/images/edits',
  );
  assert.equal(isImageGenUrlKind('openai_images'), true);
  assert.equal(isImageGenUrlKind('minimax'), true);
  assert.equal(isImageGenUrlKind('openai'), false);
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

// ---------------------------------------------------------------------------
// 通用 OpenAI 图像兼容协议（Seedream 5.0 Flash 等）+ 多图图号显式绑定回归
// ---------------------------------------------------------------------------
const oaiImgSource = fs.readFileSync(path.resolve(__dirname, '../src/services/ai/clients/openaiImagesClient.ts'), 'utf8');
const oaiImgJs = ts.transpileModule(oaiImgSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function loadOpenAIImages(fetchStub) {
  const modOai = { exports: {} };
  vm.runInNewContext(oaiImgJs, {
    exports: modOai.exports,
    module: modOai,
    fetch: fetchStub,
    AbortController,
    setTimeout,
    clearTimeout,
    require(id) {
      if (id === '../types') return { endpointFor };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  }, { filename: 'openaiImagesClient.ts' });
  return modOai.exports;
}

test('openai_images：多图参考（Seedream 5.0 形态）发 image 数组 + size=2K + watermark=false', async () => {
  let captured = null;
  const client = loadOpenAIImages(async (url, init) => {
    captured = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return new Response(JSON.stringify({ data: [{ url: 'https://tos.example.com/seedream-out.jpg' }] }), { status: 200 });
  });
  const res = await client.generateOpenAIImage(
    { urlKind: 'openai_images', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', modelId: 'doubao-seedream-5-0-flash-260915' },
    'ark-key',
    {
      prompt: '将图1的服装换为图2和图3的服装',
      personImage: 'data:image/jpeg;base64,PERSON',
      garmentImages: ['data:image/jpeg;base64,TOP', null, 'data:image/jpeg;base64,PANTS'],
    },
  );
  assert.equal(res.ok, true);
  assert.deepEqual([...res.imageUrls], ['https://tos.example.com/seedream-out.jpg']);
  assert.equal(captured.url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  assert.equal(captured.auth, 'Bearer ark-key');
  assert.equal(captured.body.model, 'doubao-seedream-5-0-flash-260915');
  assert.equal(captured.body.size, '2K');
  assert.equal(captured.body.watermark, false);
  assert.deepEqual([...captured.body.image], [
    'data:image/jpeg;base64,PERSON',
    'data:image/jpeg;base64,TOP',
    'data:image/jpeg;base64,PANTS',
  ]);
});

test('openai_images：无参考图（连接测试）不传 image 字段，兼容 b64_json 与标准 error', async () => {
  let captured = null;
  const client = loadOpenAIImages(async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: [{ b64_json: 'QUJD' }] }), { status: 200 });
  });
  const okRes = await client.generateOpenAIImage(
    { urlKind: 'openai_images', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', modelId: 'doubao-seedream-5-0-flash-260915' },
    'ark-key',
    { prompt: 'a simple green leaf' },
  );
  assert.equal(okRes.ok, true);
  assert.deepEqual([...okRes.imageUrls], ['data:image/png;base64,QUJD']);
  assert.equal(captured.body.image, undefined);

  const errClient = loadOpenAIImages(async () =>
    new Response(JSON.stringify({ error: { code: 'InvalidParameter', message: 'unsupported size' } }), { status: 400 }),
  );
  const errRes = await errClient.generateOpenAIImage(
    { urlKind: 'openai_images', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', modelId: 'doubao-seedream-5-0-flash-260915' },
    'ark-key',
    { prompt: 'x' },
  );
  assert.equal(errRes.ok, false);
  assert.equal(errRes.error.kind, 'invalid_request');
  assert.match(errRes.error.message, /InvalidParameter/);
});

test('buildPrompt：多图参考显式图号绑定，中间缺图不错位', () => {
  const runnerSrc = fs.readFileSync(path.resolve(__dirname, '../src/services/ai/runners/previewTaskRunner.ts'), 'utf8');
  const runnerJs = ts.transpileModule(runnerSrc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modRunner = { exports: {} };
  vm.runInNewContext(runnerJs, {
    exports: modRunner.exports,
    module: modRunner,
    require(id) {
      if (id === '../types') return { callRevisionOf: (c) => c.callRevision ?? 'legacy' };
      if (id === '../previewChecker') return {};
      if (id.includes('previewRepository')) return {};
      throw new Error(`Unexpected dependency: ${id}`);
    },
  }, { filename: 'previewTaskRunner.ts' });

  const built = modRunner.exports.buildPrompt(
    [
      { itemId: 'a', name: '白衬衫', category: '上装', mainColor: { name: '白', hex: '#FFFFFF' }, keyFeatures: ['尖领', '纯棉斜纹'], secondary: ['细节=珍珠扣'], photoDataUrl: 'data:image/jpeg;base64,A' },
      { itemId: 'b', name: '黑腰带裤', category: '下装', keyFeatures: ['直筒'], secondary: ['细节=高腰'], photoDataUrl: null },
      { itemId: 'c', name: '小白鞋', category: '鞋履', keyFeatures: ['低帮'], secondary: [], photoDataUrl: 'data:image/jpeg;base64,C' },
    ],
    '自然垂放',
    [],
    '',
    true,
  );
  assert.match(built.text, /图1为同一本人的唯一外观依据/);
  assert.match(built.text, /1\. \[参考图2\]；上装；名称=白衬衫；主色=白\(#FFFFFF\)/);
  assert.doesNotMatch(built.text, /珍珠扣/, '真图参考模式下有实拍图的单品不堆砌冗长次要描述');
  assert.doesNotMatch(built.text, /纯棉斜纹/, '真图参考模式下有实拍图的单品以参考图像素为主');
  assert.match(built.text, /2\. \[无实拍图，仅按文字\]；下装；名称=黑腰带裤；直筒；细节：细节=高腰/);
  assert.match(built.text, /3\. \[参考图3\]；鞋履；名称=小白鞋/);

  // 同一人多张人物参考照（2 张）：图1至图2为同一本人，衣物从 [参考图3] 顺延开始
  const multiPerson = modRunner.exports.buildPrompt(
    [
      { itemId: 'a', name: '白衬衫', category: '上装', mainColor: { name: '白', hex: '#FFFFFF' }, keyFeatures: [], secondary: [], photoDataUrl: 'data:image/jpeg;base64,A' },
      { itemId: 'c', name: '小白鞋', category: '鞋履', keyFeatures: [], secondary: [], photoDataUrl: 'data:image/jpeg;base64,C' },
    ],
    '自然垂放',
    [],
    '',
    true,
    2,
  );
  assert.match(multiPerson.text, /图1至图2为同一本人的唯一外观依据/);
  assert.match(multiPerson.text, /1\. \[参考图3\]；上装；名称=白衬衫/);
  assert.match(multiPerson.text, /2\. \[参考图4\]；鞋履；名称=小白鞋/);
});

test('openai_images：多张人物参考照（主图 + 补充照）按顺序排在衣物之前', async () => {
  let captured = null;
  const client = loadOpenAIImages(async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: [{ url: 'https://tos.example.com/multi-person.jpg' }] }), { status: 200 });
  });
  const res = await client.generateOpenAIImage(
    { urlKind: 'openai_images', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', modelId: 'doubao-seedream-5-0-flash-260915' },
    'ark-key',
    {
      prompt: '试穿',
      personImage: 'data:image/jpeg;base64,P_FULL',
      extraPersonImages: ['data:image/jpeg;base64,P_FACE'],
      garmentImages: ['data:image/jpeg;base64,TOP'],
    },
  );
  assert.equal(res.ok, true);
  assert.deepEqual([...captured.body.image], [
    'data:image/jpeg;base64,P_FULL',
    'data:image/jpeg;base64,P_FACE',
    'data:image/jpeg;base64,TOP',
  ]);
});
