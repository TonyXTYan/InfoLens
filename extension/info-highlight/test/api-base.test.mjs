import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, '../../shared/api-base.js'), 'utf8');

function loadApiBase(ihConfig = {}) {
  const sandbox = {
    URL,
    chrome: {
      storage: {
        local: { get: (_keys, cb) => cb({}) },
        onChanged: { addListener() {} },
      },
    },
    IH_CONFIG: ihConfig,
  };
  runInNewContext(src, sandbox);
  return sandbox;
}

test('IL_normalizeCloudApiBase', () => {
  const s = loadApiBase();
  assert.equal(s.IL_normalizeCloudApiBase(''), '');
  assert.equal(s.IL_normalizeCloudApiBase('127.0.0.1:5001'), 'http://127.0.0.1:5001');
  assert.equal(s.IL_normalizeCloudApiBase('localhost:5001'), 'http://localhost:5001');
  assert.equal(s.IL_normalizeCloudApiBase('api.example.com'), 'https://api.example.com');
  assert.equal(s.IL_normalizeCloudApiBase('http://127.0.0.1:5001/'), 'http://127.0.0.1:5001');
  assert.equal(s.IL_normalizeCloudApiBase('ftp://x'), '');
});

test('用户 storage 覆盖只改 analyze 根，IL_API_BASE 仍官方', () => {
  const s = loadApiBase();
  s.IL_applyCloudApiBaseOverride('http://127.0.0.1:5001', true);
  assert.equal(s.IL_API_BASE, 'https://api.info-lens.app');
  assert.equal(s.IL_ANALYZE_API_BASE, 'http://127.0.0.1:5001');
  assert.equal(s.IL_useFacadeV2Analyze(), false);
});

test('开关关着时不生效，即使 storage 里留着 URL', () => {
  const s = loadApiBase();
  s.IL_applyCloudApiBaseOverride('http://127.0.0.1:5001', false);
  assert.equal(s.IL_ANALYZE_API_BASE, 'https://api.info-lens.app');
  assert.equal(s.IL_useFacadeV2Analyze(), true);
});

test('config apiBase 加载时即生效', () => {
  const s = loadApiBase({ apiBase: 'https://sandbox.example.test' });
  assert.equal(s.IL_API_BASE, 'https://sandbox.example.test');
  assert.equal(s.IL_ANALYZE_API_BASE, 'https://sandbox.example.test');
});

test('开关开：只走用户 URL，无效时也不回退门面', () => {
  const s = loadApiBase({ apiBase: 'https://sandbox.example.test' });
  s.IL_applyCloudApiBaseOverride('ftp://x', true);
  assert.equal(s.IL_API_BASE, 'https://sandbox.example.test');
  assert.equal(s.IL_ANALYZE_API_BASE, '');
  assert.equal(s.IL_useFacadeV2Analyze(), false);
});

test('config apiBase 沙箱 + 用户自建：额度仍沙箱，analyze 走自建', () => {
  const s = loadApiBase({ apiBase: 'https://sandbox.example.test' });
  s.IL_applyCloudApiBaseOverride('http://127.0.0.1:5001', true);
  assert.equal(s.IL_API_BASE, 'https://sandbox.example.test');
  assert.equal(s.IL_ANALYZE_API_BASE, 'http://127.0.0.1:5001');
  assert.equal(s.IL_useFacadeV2Analyze(), false);
});

test('IL_analyzeLatencyTarget', () => {
  const s = loadApiBase();
  const official = s.IL_analyzeLatencyTarget('', false);
  assert.equal(official.base, 'https://api.info-lens.app');
  assert.equal(official.path, '/backend-latency');
  assert.equal(official.needReached, true);
  const self = s.IL_analyzeLatencyTarget('http://127.0.0.1:5001', true);
  assert.equal(self.base, 'http://127.0.0.1:5001');
  assert.equal(self.path, '/api/health');
  assert.equal(self.needReached, false);
  const pending = s.IL_analyzeLatencyTarget('', true);
  assert.equal(pending.skip, true);
  assert.equal(pending.base, undefined);
  const sandbox = loadApiBase({ apiBase: 'https://sandbox.example.test' });
  const mixed = sandbox.IL_analyzeLatencyTarget('http://127.0.0.1:5001', true);
  assert.equal(mixed.base, 'http://127.0.0.1:5001');
  assert.equal(mixed.path, '/api/health');
});

test('自定义服务上选的模型只在开关开着时生效', () => {
  const s = loadApiBase();
  s.IL_applyCloudApiBaseOverride('http://127.0.0.1:5001', true, ' ollama/qwen3:0.6b ');
  assert.equal(s.IL_customApiModel(), 'ollama/qwen3:0.6b');
  s.IL_applyCloudApiBaseOverride('http://127.0.0.1:5001', false, 'ollama/qwen3:0.6b');
  assert.equal(s.IL_customApiModel(), '');
  s.IL_applyCloudApiBaseOverride('http://127.0.0.1:5001', true);
  assert.equal(s.IL_customApiModel(), '');
});

test('启动时从 storage 读出自定义服务的模型', async () => {
  const stored = {
    ih_cloud_api_base: 'http://127.0.0.1:5001',
    ih_cloud_api_base_enabled: true,
    ih_cloud_api_model: 'lmstudio/Qwen/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q8_0.gguf',
  };
  const sandbox = {
    URL,
    chrome: {
      runtime: {},
      storage: {
        local: { get: (keys, cb) => cb(Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]]))) },
        onChanged: { addListener() {} },
      },
    },
    IH_CONFIG: {},
  };
  runInNewContext(src, sandbox);
  await sandbox.IL_ensureApiBaseLoaded();
  assert.equal(sandbox.IL_customApiModel(), stored.ih_cloud_api_model);
  assert.equal(sandbox.IL_useFacadeV2Analyze(), false);
});
