/**
 * 藏页前的本机分析：同时只放行一条，多条在等时先当前窗口的激活标签。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, '../background.js'), 'utf8');
const usageEnginePreamble = src.slice(
  src.indexOf('/** SYNC: analyzeRun.js / postUsageReport'),
  src.indexOf('/** 已知余额为 0'),
);
function slicePostAnalyze() {
  return usageEnginePreamble + src.slice(
    src.indexOf('async function postAnalyze'),
    src.indexOf('async function postCloudAnalyze'),
  );
}
function sliceFetchTokens() {
  return usageEnginePreamble + src.slice(
    src.indexOf('async function fetchTokens'),
    src.indexOf('async function handleAnalyze'),
  );
}
const start = src.indexOf('/** 已发出、还没进藏页的本机分析。');
const end = src.indexOf('function isOffscreenGone');
if (start < 0 || end < start) throw new Error('local admit block missing');

function loadAdmit() {
  const sandbox = {
    chrome: {
      tabs: {
        query() {
          return Promise.resolve([{ id: sandbox.activeTabId }]);
        },
      },
    },
    activeTabId: null,
  };
  runInNewContext(src.slice(start, end), sandbox, { filename: 'local-admit.js' });
  return sandbox;
}

test('有激活标签就挑它，否则挑最早的一条', () => {
  const sandbox = loadAdmit();
  const waiters = [{ tabId: 1 }, { tabId: 2 }, { tabId: 3 }];
  assert.equal(sandbox.pickLocalWaiter(waiters, 2), 1);
  assert.equal(sandbox.pickLocalWaiter(waiters, 9), 0);
  assert.equal(sandbox.pickLocalWaiter(waiters, null), 0);
});

test('放行时先跑激活标签，上一条出错后下一条仍跑', async () => {
  const sandbox = loadAdmit();
  sandbox.activeTabId = 2;
  const order = [];
  const first = sandbox.runLocalAnalyze(1, async () => {
    order.push('bg');
    throw new Error('bg failed');
  });
  const second = sandbox.runLocalAnalyze(2, async () => {
    order.push('fg');
    return 'ok';
  });
  await assert.rejects(first, /bg failed/);
  assert.equal(await second, 'ok');
  assert.deepEqual(order, ['fg', 'bg']);
});

test('免费队列和本机队列互不等待', async () => {
  const sandbox = loadAdmit();
  let release;
  const local = sandbox.runLocalAnalyze(1, () => new Promise((resolve) => {
    release = resolve;
  }));
  let started = false;
  const free = sandbox.runFreeAnalyze(2, async () => {
    started = true;
    return 'free';
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, true);
  assert.equal(await free, 'free');
  release('done');
  assert.equal(await local, 'done');
});

test('余额为 0 才进免费队列，路径在发起时定一次', () => {
  assert.match(src, /async function syncCreditState\(\)/);
  assert.match(src, /await syncCreditState\(\)/);
  assert.match(src, /const free = \(await ensureLastCreditBalance\(\)\) === 0;[\s\S]*?if \(free\) \{[\s\S]*?runFreeAnalyze\([\s\S]*?postCloudAnalyze\('\/v2\/analyze-free', text, model, false, tabId\)/);
  assert.match(src, /const paid = await postCloudAnalyze\('\/v2\/analyze', text, model, true, tabId\)/);
});

test('自定义 analyze API 根时直连 /api/analyze，不查额度', () => {
  assert.match(src, /if \(!IL_useFacadeV2Analyze\(\)\) \{[\s\S]*?postCloudAnalyze\('\/api\/analyze'/);
  assert.match(src, /fetch\(`\$\{IL_ANALYZE_API_BASE\}\$\{path\}`/);
});

test('官方 /v2/analyze-free 带 Bearer，withKey 仍为 false（不走 402  depleted）', () => {
  assert.match(src, /attachBearer = withKey \|\| path === '\/v2\/analyze-free'/);
  assert.match(src, /postCloudAnalyze\('\/v2\/analyze-free', text, model, false, tabId\)/);
});

const readCreditBalancePreamble = `const BILLING_ENFORCED_KEY = 'ih_billing_enforced';
const BALANCE_NOTICE_KEY = 'ih_balance_notice';
`;

function chromeStorageMock(stored = {}) {
  return {
    set: async (v) => { Object.assign(stored, v); },
    remove: async (keys) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete stored[k];
    },
  };
}

test('付费接口 402：余额记 0，这一段转免费接口；门面 notice 原样带出', async () => {
  const fn = slicePostAnalyze();
  let balance = 5;
  const calls = [];
  const facadeNotice = { zh: '云端额度已用完，已改走免费 API', en: 'Cloud credits are used up. Switched to the free API.' };
  const sandbox = {
    IL_API_BASE: '',
    IL_ANALYZE_API_BASE: '',
    IL_ensureApiBaseLoaded: async () => {},
    IL_useFacadeV2Analyze: () => true,
    analyzeRequestBody: () => '{}',
    syncCreditState: async () => {},
    ensureLastCreditBalance: async () => balance,
    persistCreditBalance: async (b) => { balance = b; },
    notifyAnalyzeNetworkWait: async () => { calls.push('notify'); },
    maybeNotifyFacadePolicyNotice: async () => {},
    runFreeAnalyze: (tabId, run) => run(),
    postCloudAnalyze: async (path) => {
      calls.push(path);
      if (path === '/v2/analyze') {
        return { depleted: true, notice: facadeNotice, credit_balance: 0 };
      }
      return { data: { status: 200 } };
    },
  };
  runInNewContext(fn, sandbox);
  const out = await sandbox.postAnalyze('t', 'm', 1, null);
  assert.equal(out.data.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(out.notice)), facadeNotice);
  assert.equal(balance, 0);
  assert.deepEqual(calls, ['notify', '/v2/analyze', 'notify', '/v2/analyze-free']);
});

test('免费路径不再本地决定是否提示；只转发门面 notice', async () => {
  const fn = slicePostAnalyze();
  const notified = [];
  const sandbox = {
    IL_ensureApiBaseLoaded: async () => {},
    IL_useFacadeV2Analyze: () => true,
    syncCreditState: async () => {},
    ensureLastCreditBalance: async () => 0,
    notifyAnalyzeNetworkWait: async () => { notified.push(true); },
    maybeNotifyFacadePolicyNotice: async () => { notified.push('policy'); },
    runFreeAnalyze: (tabId, run) => run(),
    postCloudAnalyze: async (path) => ({ data: path, notice: { zh: '限速', en: 'slow' } }),
  };
  runInNewContext(fn, sandbox);
  const out = await sandbox.postAnalyze('t', 'm', 1, null);
  assert.deepEqual(notified, [true, 'policy']);
  assert.equal(out.data, '/v2/analyze-free');
  assert.deepEqual(out.notice, { zh: '限速', en: 'slow' });
  assert.equal(out.usageEngine, 'cloud-free');
});

test('云端分析把门面 notice 带给页面，不再按限免屏蔽', async () => {
  const fn = sliceFetchTokens();
  const notice = { zh: '不多了', en: 'running low' };
  const sandbox = {
    postAnalyze: async () => ({
      data: { result: { bpe_strings: [], model: 'm' } },
      notice,
      credit_balance: 40,
      usageEngine: 'cloud-credit',
    }),
  };
  runInNewContext(fn, sandbox);
  const got = await sandbox.fetchTokens('cloud', 't', 'm', 1, null);
  assert.equal(got.usageEngine, 'cloud-credit');
  assert.deepEqual(got.notice, notice);
});

test('SW 启动后读一次余额接口；余额和收费状态都已知时不等它', async () => {
  const fn = src.slice(src.indexOf('let creditSync = null;'), src.indexOf('/** 已知余额为 0 走免费'));
  let reads = 0;
  let release;
  const sandbox = {
    known: true,
    readCreditBalance: () => {
      reads += 1;
      return new Promise((resolve) => { release = () => resolve({ credit_balance: 3 }); });
    },
    persistCreditBalance: async () => {},
    ensureLastCreditBalance: async () => (sandbox.known ? 3 : null),
  };
  runInNewContext(fn, sandbox);
  await sandbox.syncCreditState();
  await sandbox.syncCreditState();
  assert.equal(reads, 1);
  release();
  let done = false;
  runInNewContext('creditSync = null', sandbox);
  sandbox.known = false;
  const waiting = sandbox.syncCreditState().then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(done, false);
  release();
  await waiting;
  assert.equal(reads, 2);
});

test('余额接口必须带 billing_enforced: true', async () => {
  const fn = readCreditBalancePreamble + src.slice(src.indexOf('async function readCreditBalance'), src.indexOf('async function storedCreditOrder'));
  const stored = {};
  const sandbox = {
    fetchWithApiKey: async () => ({ ok: true, json: async () => ({ credit_balance: 2, orders: [], billing_enforced: true }) }),
    readCreditOrders: (v) => v,
    chrome: { storage: { local: chromeStorageMock(stored) } },
  };
  runInNewContext(fn, sandbox);
  const data = await sandbox.readCreditBalance();
  assert.equal(data.billing_enforced, true);
  assert.equal(stored.ih_billing_enforced, true);
  const bad = {
    fetchWithApiKey: async () => ({ ok: true, json: async () => ({ credit_balance: 2, orders: [], billing_enforced: false }) }),
    readCreditOrders: (v) => v,
    chrome: { storage: { local: chromeStorageMock() } },
  };
  runInNewContext(fn, bad);
  await assert.rejects(bad.readCreditBalance(), /Failed to read credits/);
});

test('余额接口的 notice 可选：{ zh, en } 原样带给选项页，格式不对当没有', async () => {
  const fn = readCreditBalancePreamble + src.slice(src.indexOf('async function readCreditBalance'), src.indexOf('async function storedCreditOrder'));
  for (const [notice, kept] of [[undefined, false], [{ zh: '限时免费', en: '' }, true], [{ zh: 1, en: '' }, false], ['<b>x</b>', false]]) {
    const stored = {};
    const sandbox = {
      fetchWithApiKey: async () => ({ ok: true, json: async () => ({ credit_balance: 2, orders: [], billing_enforced: true, notice }) }),
      readCreditOrders: (v) => v,
      chrome: { storage: { local: chromeStorageMock(stored) } },
    };
    runInNewContext(fn, sandbox);
    const data = await sandbox.readCreditBalance();
    assert.equal(data.credit_balance, 2);
    assert.equal('notice' in data, kept);
    if (kept) {
      assert.deepEqual(JSON.parse(JSON.stringify(data.notice)), notice);
      assert.deepEqual(stored.ih_balance_notice, notice);
    } else assert.equal(stored.ih_balance_notice, undefined);
  }
});

test('选项页公告：取界面语言那份，空则用另一份，都空不显示', () => {
  const opts = readFileSync(join(dir, '../options.js'), 'utf8');
  const sandbox = {};
  runInNewContext(opts.slice(opts.indexOf('function creditNoticeText'), opts.indexOf('/** 本机 key，不依赖额度接口')), sandbox);
  const pick = (notice, zh) => runInNewContext('creditNoticeText(n, z)', Object.assign(sandbox, { n: notice, z: zh }));
  assert.equal(pick({ zh: '中', en: 'En' }, true), '中');
  assert.equal(pick({ zh: '中', en: 'En' }, false), 'En');
  assert.equal(pick({ zh: '', en: 'En' }, true), 'En');
  assert.equal(pick({ zh: '中', en: '' }, false), '中');
  assert.equal(pick({ zh: '', en: '' }, true), '');
  assert.equal(pick(undefined, false), '');
  assert.match(opts, /el\.credits_notice\.textContent = creditNoticeText\(/);
  assert.doesNotMatch(opts, /credits_notice\.innerHTML/);
});

test('选项页点充值：经 /api/extension-usage 报一次，带 client_id 和收费状态', async () => {
  const fn = src.slice(src.indexOf('async function postCreditsAddClick'), src.indexOf('/** 匿名网站域名。'));
  const posted = [];
  const sandbox = {
    EXTENSION_ID: 'info-highlight',
    chrome: { runtime: { getManifest: () => ({ version: '9.9.9' }) } },
    readBillingEnforced: async () => true,
    IL_getClientId: async () => 'cid-1',
    IL_postKeepalive: (path, body) => posted.push([path, body]),
  };
  runInNewContext(fn, sandbox);
  await sandbox.postCreditsAddClick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [['/api/extension-usage', {
    extension: 'info-highlight',
    version: '9.9.9',
    event: 'credits_add_click',
    billing_enforced: true,
    client_id: 'cid-1',
  }]]);
});

test('免费接口 429：直接报错停下，不按 Retry-After 重发；用量错误类型固定', async () => {
  const fn = src.slice(src.indexOf('async function postCloudAnalyze'), src.indexOf('const CREDIT_ORDER_KEY'));
  let fetches = 0;
  const notice = { zh: '免费 API 请求过快，请稍后再试', en: 'Too many free API requests. Please try again later.' };
  const sandbox = {
    IL_API_BASE: '',
    IL_ANALYZE_API_BASE: 'https://api.example.test',
    IL_ensureApiBaseLoaded: async () => {},
    setTimeout,
    analyzeRequestBody: () => '{}',
    persistCreditBalance: async () => {},
    fetchWithApiKey: async () => {
      fetches += 1;
      return {
        status: 429,
        headers: new Headers({ 'Retry-After': '60' }),
        json: async () => ({ success: false, message: 'rate limit exceeded', notice }),
      };
    },
    fetch: async () => assert.fail('free facade analyze must use fetchWithApiKey'),
    readAnalyzeResponse: async () => assert.fail('429 must not go through readAnalyzeResponse'),
  };
  runInNewContext(fn, sandbox);
  await assert.rejects(
    () => sandbox.postCloudAnalyze('/v2/analyze-free', 't', 'm', false, 1),
    (err) => {
      assert.equal(err.message, 'free api rate limited');
      assert.deepEqual(JSON.parse(JSON.stringify(err.notice)), notice);
      return true;
    },
  );
  assert.equal(fetches, 1);
});

test('正在算的那条结束前，不放行下一条', async () => {
  const sandbox = loadAdmit();
  sandbox.activeTabId = 1;
  let release;
  const running = sandbox.runLocalAnalyze(1, () => new Promise((resolve) => {
    release = resolve;
  }));
  let started = false;
  const waiting = sandbox.runLocalAnalyze(2, async () => {
    started = true;
    return 'next';
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, false);
  release('done');
  assert.equal(await running, 'done');
  assert.equal(await waiting, 'next');
  assert.equal(started, true);
});
