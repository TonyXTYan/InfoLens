/**
 * IL_getClientId：本地缓存 + 远程 /api/client-id（失败则本地 UUID）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_BASE_SRC = readFileSync(`${ROOT}shared/api-base.js`, 'utf8');
const SRC = readFileSync(`${ROOT}shared/sw/client-id.js`, 'utf8');
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plugins() {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${ROOT}${e.name}/manifest.json`))
    .map((e) => e.name);
}

function load({ store = {}, fetchImpl } = {}) {
  const sandbox = {
    URL,
    chrome: {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            for (const k of keys) out[k] = store[k];
            queueMicrotask(() => cb(out));
          },
          set: (obj, cb) => {
            Object.assign(store, obj);
            queueMicrotask(() => cb());
          },
        },
      },
    },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: {
      randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      getRandomValues: (buf) => {
        for (let i = 0; i < buf.length; i++) buf[i] = (i * 17) & 0xff;
        return buf;
      },
    },
    fetch:
      fetchImpl ||
      (async () => ({
        ok: true,
        json: async () => ({ success: true, client_id: '11111111-2222-4333-8444-555555555555' }),
      })),
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(API_BASE_SRC, ctx);
  vm.runInContext(SRC, ctx);
  return { sandbox, store };
}

test('两插件均引入 client-id，并预热上报', () => {
  for (const name of plugins()) {
    const bg = readFileSync(`${ROOT}${name}/background.js`, 'utf8');
    assert.match(bg, /importScripts\('sw\/client-id\.js'\)/, `${name} 未引入 client-id`);
    assert.match(bg, /IL_prepareClientIdReporting/, `${name} 未预热 client_id`);
  }
});

test('远程成功时采用服务端 client_id 并写入 storage', async () => {
  const { sandbox, store } = load();
  const id = await sandbox.IL_getClientId();
  assert.equal(id, '11111111-2222-4333-8444-555555555555');
  assert.equal(store.il_client_id, id);
});

test('远程失败时回退本地 UUID', async () => {
  const { sandbox, store } = load({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  const id = await sandbox.IL_getClientId();
  assert.match(id, UUID_RE);
  assert.equal(store.il_client_id, id);
});

test('有缓存时直接用本地 id，不打网络', async () => {
  const calls = [];
  const existing = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const { sandbox } = load({
    store: { il_client_id: existing },
    fetchImpl: async (url) => {
      calls.push(url);
      throw new Error('不该请求');
    },
  });
  assert.equal(await sandbox.IL_getClientId(), existing);
  assert.equal(calls.length, 0);
});

test('无缓存时带 Cookie GET 门面', async () => {
  const calls = [];
  const { sandbox } = load({
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method, credentials: opts.credentials });
      return {
        ok: true,
        json: async () => ({ success: true, client_id: '11111111-2222-4333-8444-555555555555' }),
      };
    },
  });
  await sandbox.IL_getClientId();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.info-lens.app/api/client-id');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].credentials, 'include');
});

test('取 client_id 不生成 API key；首次 IL_getApiKey 才生成 ih_ 前缀的 base64url', async () => {
  const { sandbox, store } = load();
  const id = await sandbox.IL_getClientId();
  assert.equal(store.ih_api_key, undefined);
  const key = await sandbox.IL_getApiKey();
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) bytes[i] = (i * 17) & 0xff;
  assert.equal(id, '11111111-2222-4333-8444-555555555555');
  assert.equal(key, `ih_${bytes.toString('base64url')}`);
  assert.equal(key.length, 46);
  assert.equal(store.ih_api_key, key);
  assert.equal(await sandbox.IL_getApiKey(), key);
});

test('已有 API key 时不重造', async () => {
  const key = `ih_${'A'.repeat(43)}`;
  let randoms = 0;
  const { sandbox, store } = load({
    store: {
      il_client_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      ih_api_key: key,
    },
  });
  const orig = sandbox.crypto.getRandomValues;
  sandbox.crypto.getRandomValues = (buf) => {
    randoms += 1;
    return orig(buf);
  };
  assert.equal(await sandbox.IL_getApiKey(), key);
  assert.equal(store.ih_api_key, key);
  assert.equal(randoms, 0);
});

test('坏的 API key 直接报错，不另造一把', async () => {
  const { sandbox, store } = load({ store: { ih_api_key: 'nope' } });
  await assert.rejects(() => sandbox.IL_getApiKey(), /stored api key is invalid/);
  assert.equal(store.ih_api_key, 'nope');
  assert.equal(await sandbox.IL_getClientId(), '11111111-2222-4333-8444-555555555555');
});

test('IL_replaceApiKey：校验格式并写入本地', async () => {
  const oldKey = `ih_${'A'.repeat(43)}`;
  const newKey = `ih_${'B'.repeat(43)}`;
  const { sandbox, store } = load({
    store: {
      il_client_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      ih_api_key: oldKey,
    },
  });
  await sandbox.IL_getApiKey();
  await sandbox.IL_replaceApiKey(newKey);
  assert.equal(store.ih_api_key, newKey);
  assert.equal(await sandbox.IL_getApiKey(), newKey);
  await assert.rejects(() => sandbox.IL_replaceApiKey('bad'), /invalid api key/);
  assert.equal(store.ih_api_key, newKey);
});

test('IL_replaceApiKey：记下被换掉的那一把', async () => {
  const a = `ih_${'A'.repeat(43)}`;
  const b = `ih_${'B'.repeat(43)}`;
  const { sandbox, store } = load({
    store: {
      il_client_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      ih_api_key: a,
    },
  });
  await sandbox.IL_replaceApiKey(b);
  assert.equal(store.ih_api_key, b);
  assert.equal(store.ih_api_key_prev, a);
  await sandbox.IL_replaceApiKey(a);
  assert.equal(store.ih_api_key, a);
  assert.equal(store.ih_api_key_prev, b);
});

test('用到 IL_API_BASE 的插件都引 api-base.js（e3894fa 起它只在那里定义）', () => {
  const plugins = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(`${ROOT}${e.name}/manifest.json`))
    .map((e) => e.name);
  for (const name of plugins) {
    const bg = readFileSync(`${ROOT}${name}/background.js`, 'utf8');
    const imports = [...bg.matchAll(/^importScripts\('([^']+)'\);$/gm)].map((m) => m[1]);
    // config.js 是构建时生成的，源码里没有
    const files = imports.filter((rel) => rel !== 'api-base.js')
      .map((rel) => [`${ROOT}${name}/${rel}`, `${ROOT}shared/${rel}`].find((f) => existsSync(f)))
      .filter(Boolean);
    const sources = [bg, ...files.map((f) => readFileSync(f, 'utf8'))];
    if (!sources.some((src) => /\bIL_API_BASE\b/.test(src))) continue;
    assert.ok(imports.includes('api-base.js'), `${name}/background.js 用到 IL_API_BASE 却没引 api-base.js`);
  }
});
