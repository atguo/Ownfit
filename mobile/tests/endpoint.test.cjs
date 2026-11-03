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
