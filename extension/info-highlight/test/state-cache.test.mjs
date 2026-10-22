/**
 * 本机模型 Cache API 占用 / 清空。运行：node --test extension/info-highlight/test/state-cache.test.mjs
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
const S = globalThis.IH_localState;
const CACHE = S.MODEL_CACHE;
const MODEL = S.MODEL_ID;

function modelUrl(file) {
  return `https://huggingface.co/${MODEL}/resolve/main/${file}`;
}

function mockCaches(files) {
  const store = { [CACHE]: { ...files } };
  globalThis.caches = {
    async has(name) {
      return name in store;
    },
    async keys() {
      return Object.keys(store);
    },
    async open(name) {
      const bucket = store[name] || {};
      return {
        async keys() {
          return Object.keys(bucket).map((url) => ({ url }));
        },
        async match(req) {
          const key = typeof req === 'string' ? req : req.url;
          const rec = bucket[key];
          if (!rec) return undefined;
          const headers = rec.headers || {};
          return {
            headers: {
              get(k) {
                const hit = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase());
                return hit == null ? null : headers[hit];
              },
            },
            blob: async () => (rec.blob ? rec.blob : { size: rec.size }),
            arrayBuffer: async () => {
              if (rec.blob) return rec.blob.arrayBuffer();
              return new ArrayBuffer(rec.size || 0);
            },
          };
        },
        async delete(req) {
          const url = req.url || req;
          if (!(url in bucket)) return false;
          delete bucket[url];
          return true;
        },
        async put(url, res) {
          const u = url.url || url;
          const blob = await res.blob();
          bucket[u] = { blob, headers: {} };
          for (const [k, v] of res.headers.entries()) bucket[u].headers[k] = v;
        },
      };
    },
    async delete(name) {
      const had = name in store;
      delete store[name];
      return had;
    },
  };
  return store;
}

test.beforeEach(() => {
  delete globalThis.caches;
});

test('无缓存桶则占用为 0', async () => {
  globalThis.caches = {
    async has() {
      return false;
    },
  };
  assert.deepEqual(await S.modelCacheUsage(), { entries: 0, bytes: 0 });
});

test('按 Content-Length 累加本模型文件', async () => {
  mockCaches({
    [modelUrl('onnx/model_q4.onnx')]: { headers: { 'Content-Length': '839800000' } },
    [modelUrl('tokenizer.json')]: { headers: { 'Content-Length': '33400000' } },
    'https://huggingface.co/other/model/resolve/main/onnx/model.onnx': {
      headers: { 'Content-Length': '999' },
    },
  });
  assert.deepEqual(await S.modelCacheUsage(), { entries: 2, bytes: 873200000 });
});

test('没有 Content-Length 时用 blob.size', async () => {
  mockCaches({
    [modelUrl('config.json')]: { size: 1340 },
  });
  assert.deepEqual(await S.modelCacheUsage(), { entries: 1, bytes: 1340 });
});

test('normalizeHub 只认 modelscope，其余为 huggingface', () => {
  assert.equal(S.normalizeHub('modelscope'), 'modelscope');
  assert.equal(S.normalizeHub('huggingface'), 'huggingface');
  assert.equal(S.normalizeHub(undefined), 'huggingface');
});

test('normalizeCloudModel 只认名单内 id，其余为 Qwen', () => {
  assert.equal(S.normalizeCloudModel('gemma-3-270m'), 'gemma-3-270m');
  assert.equal(S.normalizeCloudModel('qwen3-0.6b'), 'qwen3-0.6b');
  assert.equal(S.normalizeCloudModel(undefined), 'qwen3-0.6b');
  assert.equal(S.normalizeCloudModel('default'), 'qwen3-0.6b');
});

test('hubRemoteHost / hubOrigins 按源区分', () => {
  assert.equal(S.hubRemoteHost('huggingface'), 'https://huggingface.co/');
  assert.equal(S.hubRemoteHost('modelscope'), 'https://www.modelscope.cn/models/');
  assert.ok(S.hubOrigins('huggingface').some((o) => o.includes('huggingface.co')));
  assert.deepEqual(S.hubOrigins('modelscope'), ['https://*.modelscope.cn/*']);
});

test('localModelHost 开启时 local 源指向本机', () => {
  const prev = globalThis.IH_CONFIG;
  globalThis.IH_CONFIG = { localModelHost: 'http://127.0.0.1:8765/' };
  assert.equal(S.hubRemoteHost('local'), 'http://127.0.0.1:8765/');
  assert.deepEqual(S.hubOrigins('local'), ['http://127.0.0.1:8765/*']);
  assert.equal(S.normalizeHub('local'), S.HUB_LOCAL);
  globalThis.IH_CONFIG = prev;
});

test('ModelScope URL 也计入本模型占用', async () => {
  mockCaches({
    [`https://www.modelscope.cn/models/${MODEL}/resolve/main/onnx/model_q4.onnx`]: {
      headers: { 'Content-Length': '10' },
    },
  });
  assert.deepEqual(await S.modelCacheUsage(), { entries: 1, bytes: 10 });
});

test('hubRepoId：Qwen 在 ModelScope 用 ddqy08', () => {
  const spec = S.localSpec(S.CLOUD_QWEN);
  assert.equal(S.hubRepoId('huggingface', spec), 'dqy08/Qwen3-0.6B-Base-ONNX');
  assert.equal(S.hubRepoId('modelscope', spec), 'ddqy08/Qwen3-0.6B-Base-ONNX');
  assert.equal(S.hubRepoId('huggingface', S.localSpec(S.CLOUD_GEMMA)), S.MODEL_ID);
});

test('Qwen ModelScope（ddqy08）计入占用且可单独清空', async () => {
  const ms = 'ddqy08/Qwen3-0.6B-Base-ONNX';
  const msUrl = `https://www.modelscope.cn/models/${ms}/resolve/main/onnx/model_q4.onnx`;
  const hf = S.localSpec(S.CLOUD_QWEN).hubId;
  const hfUrl = `https://huggingface.co/${hf}/resolve/main/onnx/model_q4.onnx`;
  mockCaches({
    [msUrl]: { headers: { 'Content-Length': '11' } },
    [hfUrl]: { headers: { 'Content-Length': '22' } },
  });
  assert.deepEqual(await S.modelCacheUsage(S.CLOUD_QWEN), { entries: 2, bytes: 33 });
  await S.dropModelCache(S.CLOUD_QWEN);
  assert.deepEqual(await S.modelCacheUsage(S.CLOUD_GEMMA), { entries: 0, bytes: 0 });
  assert.deepEqual(await S.modelCacheUsage(S.CLOUD_QWEN), { entries: 0, bytes: 0 });
});

test('dropModelCache 删掉整个缓存桶', async () => {
  const store = mockCaches({
    [modelUrl('onnx/model_q4.onnx')]: { headers: { 'Content-Length': '10' } },
  });
  await S.dropModelCache();
  assert.equal(CACHE in store, false);
  assert.deepEqual(await S.modelCacheUsage(), { entries: 0, bytes: 0 });
});

test('modelCacheUsage 按本机型号分开计', async () => {
  const qwen = S.localSpec(S.CLOUD_QWEN).hubId;
  mockCaches({
    [modelUrl('onnx/model_q4.onnx')]: { headers: { 'Content-Length': '10' } },
    [`https://huggingface.co/${qwen}/resolve/main/onnx/model_q4.onnx`]: {
      headers: { 'Content-Length': '20' },
    },
  });
  assert.deepEqual(await S.modelCacheUsage(S.CLOUD_GEMMA), { entries: 1, bytes: 10 });
  assert.deepEqual(await S.modelCacheUsage(S.CLOUD_QWEN), { entries: 1, bytes: 20 });
});

test('Qwen 首 token 前缀 logits 与权重同桶、同 needle 删除', async () => {
  const spec = S.localSpec(S.CLOUD_QWEN);
  const url = S.prefixFirstLogitsCacheUrl('huggingface', spec, 151643, 4);
  const floats = new Float32Array([1, 2, 3, 4]);
  mockCaches({});
  await S.savePrefixFirstLogits('huggingface', spec, 151643, 4, floats);
  const loaded = await S.loadPrefixFirstLogits('huggingface', spec, 151643, 4);
  assert.ok(loaded instanceof Float32Array);
  assert.deepEqual([...loaded], [1, 2, 3, 4]);
  assert.deepEqual(await S.modelCacheUsage(S.CLOUD_QWEN), { entries: 1, bytes: 16 });
  await S.dropModelCache(S.CLOUD_QWEN);
  assert.equal(await S.loadPrefixFirstLogits('huggingface', spec, 151643, 4), null);
});

test('dropModelCache(localId) 只删该型号', async () => {
  const qwen = S.localSpec(S.CLOUD_QWEN).hubId;
  const gemmaUrl = modelUrl('onnx/model_q4.onnx');
  const qwenUrl = `https://huggingface.co/${qwen}/resolve/main/onnx/model_q4.onnx`;
  const store = mockCaches({
    [gemmaUrl]: { headers: { 'Content-Length': '10' } },
    [qwenUrl]: { headers: { 'Content-Length': '20' } },
  });
  await S.dropModelCache(S.CLOUD_GEMMA);
  assert.equal(CACHE in store, true);
  assert.deepEqual(await S.modelCacheUsage(S.CLOUD_GEMMA), { entries: 0, bytes: 0 });
  assert.deepEqual(await S.modelCacheUsage(S.CLOUD_QWEN), { entries: 1, bytes: 20 });
});
