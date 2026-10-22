/**
 * probeWebGPU：本机 q4f16 需 shader-f16。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../local/state.js'), 'utf8'), {
  filename: 'state.js',
});
const { probeWebGPU, WEBGPU_BLOCK } = globalThis.IH_localState;

function mockGpu({ adapter = null, shaderF16 = true, deviceOk = true } = {}) {
  const features = new Set(shaderF16 ? ['shader-f16'] : []);
  const dev = deviceOk ? { destroy() {} } : null;
  globalThis.navigator = {
    gpu: {
      async requestAdapter() {
        if (adapter === null) return { features, requestDevice: async () => dev };
        return adapter;
      },
    },
  };
}

test.beforeEach(() => {
  delete globalThis.navigator;
});

test('无 navigator.gpu', async () => {
  globalThis.navigator = {};
  assert.deepEqual(await probeWebGPU(), { ok: false, reason: WEBGPU_BLOCK.no_api });
});

test('无 adapter', async () => {
  mockGpu({ adapter: undefined });
  globalThis.navigator.gpu.requestAdapter = async () => undefined;
  assert.deepEqual(await probeWebGPU(), { ok: false, reason: WEBGPU_BLOCK.no_adapter });
});

test('无 shader-f16', async () => {
  mockGpu({ shaderF16: false });
  assert.deepEqual(await probeWebGPU(), { ok: false, reason: WEBGPU_BLOCK.no_shader_f16 });
});

test('有 shader-f16 且能创建设备', async () => {
  mockGpu({ shaderF16: true });
  assert.deepEqual(await probeWebGPU(), { ok: true, reason: null });
});
