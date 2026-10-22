/**
 * node --test extension/info-highlight/test/model-choice.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../local/state.js'), 'utf8'), { filename: 'state.js' });
const S = globalThis.IH_localState;

test('本机状态行型号：本机选项用该项，云端选项用 runtime 槽', () => {
  assert.equal(S.onDeviceStatusModelId(S.CHOICE_LOCAL_GEMMA), S.CLOUD_GEMMA);
  assert.equal(S.onDeviceStatusModelId(S.CHOICE_LOCAL_QWEN3), S.CLOUD_QWEN);
  assert.equal(S.onDeviceStatusModelId(S.CHOICE_CLOUD_QWEN), S.localRuntimeModelId());
  assert.equal(S.onDeviceStatusModelId(S.CHOICE_CLOUD_QWEN, S.CLOUD_QWEN), S.CLOUD_QWEN);
  assert.equal(S.modelLabel(S.CLOUD_GEMMA), 'Gemma 3 270M');
  assert.equal(S.modelLabel(S.CLOUD_QWEN), 'Qwen3 0.6B');
  assert.equal(S.localSpec(S.CLOUD_GEMMA).dtype, 'q4');
  assert.equal(S.localSpec(S.CLOUD_QWEN).hubId, 'dqy08/Qwen3-0.6B-Base-ONNX');
  assert.equal(S.localSpec(S.CLOUD_QWEN).dtype, 'q4');
  assert.equal(S.localSpec(S.CLOUD_QWEN).initDownloadSize, '920 MB');
  assert.deepEqual(S.onnxSessionOptions('q4', S.localSpec(S.CLOUD_QWEN)), {});
  assert.equal(S.onnxSessionOptions('q4f16').graphOptimizationLevel, 'basic');
  assert.deepEqual(S.onnxSessionOptions('q4'), {});
});

test('WebGPU 内存释放超时：10 / 60 / 600 / 3600 秒，默认 10', () => {
  assert.deepEqual(S.WEBGPU_LINGER_SECS, [10, 60, 600, 3600]);
  assert.equal(S.DEFAULT_WEBGPU_LINGER_SEC, 10);
  assert.equal(S.normalizeWebgpuLingerSec(10), 10);
  assert.equal(S.normalizeWebgpuLingerSec(60), 60);
  assert.equal(S.normalizeWebgpuLingerSec(600), 600);
  assert.equal(S.normalizeWebgpuLingerSec(3600), 3600);
  assert.equal(S.normalizeWebgpuLingerSec(30), 10);
  assert.equal(S.normalizeWebgpuLingerSec('60'), 60);
  assert.equal(S.webgpuLingerLabelKey(60), '1 minute');
  assert.equal(S.webgpuLingerLabelKey(600), '10 minutes');
});

test('云端两项和本机 Gemma、Qwen3', () => {
  assert.deepEqual(S.CHOICES.map((c) => c.id), [
    S.CHOICE_CLOUD_QWEN,
    S.CHOICE_CLOUD_GEMMA,
    S.CHOICE_LOCAL_QWEN3,
    S.CHOICE_LOCAL_GEMMA,
  ]);
  assert.equal(S.CHOICES.filter((c) => c.local).length, 2);
});

test('已移除的本机 Qwen2.5 选项收成 Qwen3', () => {
  assert.equal(S.storedChoice({ [S.KEYS.choice]: 'local:qwen2.5-0.5b' }), S.CHOICE_LOCAL_QWEN3);
});

test('旧的本机 / 云端收成现在的一项', () => {
  const pref = S.LEGACY_PREF;
  const model = S.LEGACY_CLOUD_MODEL;
  const ready = S.KEYS.ready;
  const webgpu = S.KEYS.webgpu;
  assert.equal(
    S.choiceFromLegacy({ [pref]: 'cloud', [model]: 'qwen3-0.6b', [ready]: true, [webgpu]: true }),
    S.CHOICE_CLOUD_QWEN,
  );
  assert.equal(
    S.choiceFromLegacy({ [pref]: 'cloud', [model]: 'gemma-3-270m' }),
    S.CHOICE_CLOUD_GEMMA,
  );
  assert.equal(
    S.choiceFromLegacy({ [pref]: 'local', [model]: 'qwen3-0.6b', [webgpu]: false }),
    S.CHOICE_LOCAL_GEMMA,
  );
  assert.equal(
    S.choiceFromLegacy({ [pref]: 'auto', [model]: 'gemma-3-270m', [ready]: true, [webgpu]: true }),
    S.CHOICE_CLOUD_QWEN,
  );
  assert.equal(
    S.choiceFromLegacy({ [pref]: 'auto', [model]: 'qwen3-0.6b', [ready]: true, [webgpu]: false }),
    S.CHOICE_CLOUD_QWEN,
  );
  assert.equal(
    S.choiceFromLegacy({ [model]: 'gemma-3-270m', [ready]: true, [webgpu]: true }),
    S.CHOICE_CLOUD_QWEN,
  );
});
