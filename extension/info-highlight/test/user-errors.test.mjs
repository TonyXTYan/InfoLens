/**
 * node --test extension/info-highlight/test/user-errors.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../local/state.js'), 'utf8'), { filename: 'state.js' });
runInThisContext(readFileSync(join(dir, '../zh.js'), 'utf8'), { filename: 'zh.js' });
runInThisContext(readFileSync(join(dir, '../../shared/options-i18n.js'), 'utf8'), { filename: 'options-i18n.js' });
runInThisContext(readFileSync(join(dir, '../i18n.js'), 'utf8'), { filename: 'i18n.js' });
runInThisContext(readFileSync(join(dir, '../local/userErrors.js'), 'utf8'), {
  filename: 'user-errors.js',
});
const U = globalThis.IH_userErrors;

const TECH = /webgpu|adapter|HTTP \d|application\/json|bpe_strings|offscreen|ORT|setEnd/i;

function assertNoTech(userMsg) {
  assert.doesNotMatch(userMsg, TECH);
}

test('localOnlyFailure：GPU 原文不露出', () => {
  const msg = U.localOnlyFailure(new Error('no available backend found. ERR: [webgpu] Failed to get GPU adapter'));
  assert.equal(msg, 'This computer cannot run the on-device model.');
  assertNoTech(msg);
});

test('localOnlyBlock：未 Prepare', () => {
  const msg = U.localOnlyBlock({
    choice: globalThis.IH_localState.CHOICE_LOCAL_GEMMA,
    webgpuOk: true,
    ready: false,
  });
  assert.match(msg, /not ready/i);
  assert.match(msg, /Prepare/i);
});

test('webgpuStatusLine：不可用时附带首要原因', () => {
  const line = U.webgpuStatusLine({
    webgpuOk: false,
    webgpuBlockReason: globalThis.IH_localState.WEBGPU_BLOCK.no_shader_f16,
  });
  assert.match(line, /^Not available\n/);
  assert.match(line, /shader-f16/i);
});

test('localOnlyBlock：没有 WebGPU 只报短句，不改偏好文案', () => {
  const msg = U.localOnlyBlock({
    choice: globalThis.IH_localState.CHOICE_LOCAL_GEMMA,
    webgpuOk: false,
    ready: true,
  });
  assert.equal(msg, 'This computer cannot run the on-device model.');
});

test('pageAnalyzeError：正文抽取与高亮映射分开', () => {
  assert.equal(U.pageAnalyzeError('No article text'), 'No readable article text on this page.');
  const noHl =
    'No highlights could be placed on this page. Try again or choose another model in extension options.';
  const alignMsg =
    'On-device scoring could not match this text. Try a cloud model in extension options, or another on-device model.';
  assert.equal(U.pageAnalyzeError('No tokens mapped onto the page'), noHl);
  assert.equal(U.pageAnalyzeError('token offset align failed at 3 for id=42'), alignMsg);
  assert.equal(
    U.pageAnalyzeError('本机打分无法与这段正文对齐。请在扩展选项里改用云端模型，或换另一个本机模型。'),
    alignMsg,
  );
  assert.equal(
    U.pageAnalyzeError('local analyze failed: token offset align failed at 0 for id=1'),
    alignMsg,
  );
  assert.match(
    U.localOnlyFailure(new Error('local analyze failed: token offset align failed at 0')),
    /could not match this text/i,
  );
});

test('pageAnalyzeError：网络与云端', () => {
  const net = U.pageAnalyzeError('Failed to fetch');
  assert.equal(net, 'Cannot reach the analyze server. Try again later.');
  assertNoTech(net);
  const http = U.pageAnalyzeError('HTTP 502: expected application/json, got text/html');
  assert.equal(http, 'The analyze server returned an error. Try again later.');
  assertNoTech(http);
});

test('pageAnalyzeError：本机与扩展通道', () => {
  const gpu = U.pageAnalyzeError('On-device WebGPU is unavailable. On-device only is selected, so cloud will not be used.');
  assert.equal(gpu, 'This computer cannot run the on-device model.');
  assertNoTech(gpu);
  const port = U.pageAnalyzeError(
    'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received',
  );
  assert.match(port, /refresh/i);
  assertNoTech(port);
});

test('isRetryable：连不上、上游错误、未知失败可以重试', () => {
  assert.equal(U.isRetryable('Failed to fetch'), true);
  assert.equal(U.isRetryable('HTTP 502: expected application/json, got text/html'), true);
  assert.equal(U.isRetryable('IH_appendProgress before IH_bindProgress'), true);
  assert.equal(U.isRetryable('No article text'), false);
  assert.equal(U.isRetryable('no available backend found. ERR: [webgpu] Failed to get GPU adapter'), false);
  assert.equal(U.isRetryable('free api rate limited'), false);
  assert.equal(U.pageAnalyzeError('free api rate limited'), 'Too many free API requests. Please try again later.');
  assert.equal(U.pageAnalyzeError('rate limit exceeded'), 'Too many free API requests. Please try again later.');
});

test('pageAnalyzeError：未知错误不泄露原文', () => {
  const raw = 'IH_appendProgress before IH_bindProgress';
  const out = U.pageAnalyzeError(raw);
  assert.equal(out, 'Analysis could not finish. Try again.');
  assertNoTech(out);
  assert.doesNotMatch(out, /IH_/);
});
