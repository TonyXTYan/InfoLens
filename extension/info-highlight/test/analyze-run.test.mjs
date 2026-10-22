/**
 * analyzeRun：paint 计数跨段累加；painted===0 把 detail 挂到 fail 上报。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));

const messages = [];
globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage(msg, cb) {
      messages.push(msg);
      if (msg?.type === 'ih-analyze') {
        const raw = globalThis.__ihAnalyzeTokens || [{ offset: [0, 5], p: 0.01 }];
        cb({
          ok: true,
          data: { result: { bpe_strings: raw, model: 'qwen3-0.6b' } },
          inferred: true,
          engine: 'cloud-free',
        });
        return;
      }
      cb?.();
    },
  },
};

globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);

globalThis.IH_setProgressSearching = async () => {};
globalThis.IH_appendProgress = () => {};
globalThis.IH_beginAnalyzeRound = () => {};
globalThis.IH_segmentWindow = () => ({
  requestText: 'Hello',
  originCp: 0,
  segStartCp: 0,
  segEndCp: 5,
});
globalThis.IH_tokensInSegment = (raw) => {
  if (globalThis.__ihAlignFail) throw new Error('token offset align failed');
  return raw;
};
globalThis.IH_paintTokens = (tokens) => globalThis.__ihPaintStats?.(tokens) || {
  painted: 0,
  tokens_in: Array.isArray(tokens) ? tokens.length : 0,
  tokens_skip_level: Array.isArray(tokens) ? tokens.length : 0,
  tokens_skip_empty_range: 0,
};

runInThisContext(readFileSync(join(dir, '../analyzeRun.js'), 'utf8'), {
  filename: 'analyzeRun.js',
});
const R = globalThis.IH_analyzeRun;

test('收藏补画上限独立于一轮批处理段数', () => {
  assert.equal(R.MAX_SEGMENTS_PER_RUN, 32);
  assert.equal(R.LIBRARY_MAX_SEGMENTS, 32);
});

function newReport() {
  return {
    segments: 0,
    segments_ok: 0,
    cached: 0,
    engine: null,
    outcome: null,
    error: null,
    duration_ms: 0,
    align_fail_n: 0,
    tokens_in: 0,
    tokens_skip_level: 0,
    tokens_skip_empty_range: 0,
    painted: 0,
    last_align_err: null,
    detail: null,
  };
}

test.beforeEach(() => {
  messages.length = 0;
  globalThis.__ihAlignFail = false;
  globalThis.__ihAnalyzeTokens = [{ offset: [0, 5], p: 0.01 }];
  globalThis.__ihPaintStats = undefined;
  globalThis.CSS = { highlights: new Map() };
  globalThis.IH_dropTokenRangesOverlapping = () => {};
  globalThis.IH_tokenTip = {
    models: [],
    setModel(name) {
      this.models.push(name);
    },
  };
});

test('画一段之前先删掉落在这段上的旧高亮', async () => {
  const order = [];
  globalThis.IH_dropTokenRangesOverlapping = (mapped, start, end) => {
    order.push(['drop', mapped.text, start, end]);
  };
  globalThis.__ihPaintStats = () => {
    order.push(['paint']);
    return { painted: 1, tokens_in: 1, tokens_skip_level: 0, tokens_skip_empty_range: 0 };
  };
  const session = {
    mapped: { text: 'Hello world', pieces: [{}] },
    segs: [
      { start: 0, end: 5, text: 'Hello' },
      { start: 6, end: 11, text: 'world' },
    ],
    painted: 0,
  };
  await R.paintRange(session, 0, 2, () => true, {}, newReport());
  assert.deepEqual(order, [
    ['drop', 'Hello world', 0, 5],
    ['paint'],
    ['drop', 'Hello world', 6, 11],
    ['paint'],
  ]);
});

test('paintRange：累加 skip_level / painted，align_fail_n 计入跳过段', async () => {
  const session = {
    mapped: { text: 'Hello world', pieces: [{}, {}] },
    segs: [
      { start: 0, end: 5, text: 'Hello' },
      { start: 6, end: 11, text: 'world' },
    ],
    painted: 0,
  };
  const report = newReport();
  let n = 0;
  globalThis.__ihPaintStats = (tokens) => {
    n += 1;
    return {
      painted: 0,
      tokens_in: tokens.length,
      tokens_skip_level: tokens.length,
      tokens_skip_empty_range: 0,
    };
  };
  const align = await R.paintRange(session, 0, 2, () => true, {}, report);
  assert.equal(align, undefined);
  assert.equal(n, 2);
  assert.equal(report.segments, 2);
  assert.equal(report.segments_ok, 2);
  assert.equal(report.tokens_in, 2);
  assert.equal(report.tokens_skip_level, 2);
  assert.equal(report.painted, 0);
  assert.equal(session.painted, 0);
  assert.equal(report.align_fail_n, 0);
  assert.equal(report.engine, 'cloud-free');
  assert.equal(report.model, 'qwen3-0.6b');
  assert.deepEqual(globalThis.IH_tokenTip.models, ['qwen3-0.6b', 'qwen3-0.6b']);

  globalThis.__ihAlignFail = true;
  const report2 = newReport();
  const session2 = { ...session, painted: 0 };
  const last = await R.paintRange(session2, 0, 1, () => true, {}, report2);
  assert.match(String(last?.message || last), /token offset align failed/);
  assert.equal(report2.align_fail_n, 1);
  assert.equal(report2.segments_ok, 0);
  assert.equal(report2.last_align_err, 'token offset align failed');
});

test('paintRange：每段分析前调 onSegment', async () => {
  const seen = [];
  const session = {
    mapped: { text: 'Hello world', pieces: [{}] },
    segs: [
      { start: 0, end: 5, text: 'Hello' },
      { start: 6, end: 11, text: 'world' },
    ],
    painted: 0,
  };
  globalThis.__ihPaintStats = () => ({
    painted: 1, tokens_in: 1, tokens_skip_level: 0, tokens_skip_empty_range: 0,
  });
  await R.paintRange(session, 0, 2, () => true, {
    onSegment(i, to) { seen.push([i, to]); },
  }, newReport());
  assert.deepEqual(seen, [[0, 2], [1, 2]]);
});

test('paintRange：opts.skipCache 写进 ih-analyze', async () => {
  const session = {
    mapped: { text: 'Hello', pieces: [{}] },
    segs: [{ start: 0, end: 5, text: 'Hello' }],
    painted: 0,
  };
  globalThis.__ihPaintStats = () => ({
    painted: 1, tokens_in: 1, tokens_skip_level: 0, tokens_skip_empty_range: 0,
  });
  session.cloudModel = 'qwen3-0.6b';
  await R.paintRange(session, 0, 1, () => true, { skipCache: true }, newReport());
  const analyze = messages.filter((m) => m.type === 'ih-analyze');
  assert.equal(analyze.length, 1);
  assert.equal(analyze[0].skipCache, true);
  assert.equal(analyze[0].cloudModel, 'qwen3-0.6b');
});

test('paintRange：缓存命中不发请求、不计请求数、不消耗首次等云端', async () => {
  const session = {
    mapped: { text: 'Hello', pieces: [{}] },
    segs: [{ start: 0, end: 5, text: 'Hello' }],
    painted: 0,
    armFirstAnalyze: true,
    analyzed: 0,
    resultCache: new Map([['Hello', [{ offset: [0, 5], p: 0.01 }]]]),
  };
  const report = newReport();
  await R.paintRange(session, 0, 1, () => true, {}, report);
  assert.equal(messages.filter((m) => m.type === 'ih-analyze').length, 0);
  assert.equal(session.analyzed, 0);
  assert.equal(session.armFirstAnalyze, true);
  assert.equal(report.cached, 1);
});

test('afterPaint：painted===0 挂 detail；对用户只抛 emptyMsg', async () => {
  const session = {
    next: 1,
    segs: [{}],
    painted: 0,
    mapped: { text: 'Hello', pieces: [1, 2, 3] },
  };
  const report = newReport();
  report.segments = 1;
  report.segments_ok = 1;
  report.tokens_in = 12;
  report.tokens_skip_level = 12;
  await assert.rejects(
    () => R.afterPaint(session, null, 'No tokens mapped onto the page', () => {}, report),
    /No tokens mapped onto the page/,
  );
  assert.equal(report.error, 'No tokens mapped onto the page');
  assert.doesNotMatch(String(report.error), /skip_lvl=/);
  assert.equal(report.detail.tokens_in, 12);
  assert.equal(report.detail.tokens_skip_level, 12);
  assert.equal(report.detail.tokens_skip_empty_range, 0);
  assert.equal(report.detail.painted, 0);
  assert.equal(report.detail.mapped_chars, 5);
  assert.equal(report.detail.mapped_pieces, 3);
  assert.equal(report.detail.highlights_ok, true);
  assert.equal(report.detail.segments, 1);
  assert.equal('page_url' in report.detail, false);
  assert.equal('page_text' in report.detail, false);
});

test('afterPaint：painted===0 时 detail 带 last_align_err，对用户仍用 emptyMsg', async () => {
  const session = {
    next: 1,
    segs: [{}],
    painted: 0,
    mapped: { text: 'ab', pieces: [{}] },
  };
  const report = newReport();
  report.align_fail_n = 2;
  const alignErr = new Error('token offset align failed');
  await assert.rejects(
    () => R.afterPaint(session, alignErr, 'No tokens mapped onto the page', () => {}, report),
    /No tokens mapped onto the page/,
  );
  assert.equal(report.error, 'No tokens mapped onto the page');
  assert.equal(report.detail.align_fail_n, 2);
  assert.equal(report.detail.last_align_err, 'token offset align failed');
  assert.equal(report.detail.painted, 0);
});

test('paintRange：按段写入 tokensBySeg；align_fail 记空数组', async () => {
  const toks = [{ offset: [0, 5], p: 0.01 }];
  globalThis.__ihAnalyzeTokens = toks;
  globalThis.__ihPaintStats = () => ({
    painted: 1, tokens_in: 1, tokens_skip_level: 0, tokens_skip_empty_range: 0,
  });
  const session = {
    mapped: { text: 'Hello world', pieces: [{}, {}] },
    segs: [
      { start: 0, end: 5, text: 'Hello' },
      { start: 6, end: 11, text: 'world' },
    ],
    painted: 0,
  };
  await R.paintRange(session, 0, 2, () => true, {}, newReport());
  assert.deepEqual(session.tokensBySeg, [toks, toks]);

  globalThis.__ihAlignFail = true;
  const skipped = { mapped: { text: 'Hello', pieces: [{}] }, segs: [{ start: 0, end: 5, text: 'Hello' }], painted: 0 };
  await R.paintRange(skipped, 0, 1, () => true, {}, newReport());
  assert.deepEqual(skipped.tokensBySeg, [[]]);
});

test('repaintPainted：已画段重画，空洞跳过，不发 ih-analyze', async () => {
  const paints = [];
  const progress = [];
  const prevAppend = globalThis.IH_appendProgress;
  globalThis.__ihPaintStats = (tokens) => {
    paints.push(tokens);
    return { painted: tokens.length, tokens_in: tokens.length, tokens_skip_level: 0, tokens_skip_empty_range: 0 };
  };
  globalThis.IH_appendProgress = (tokens, seg) => {
    progress.push({ tokens, start: seg.start });
  };
  const session = {
    mapped: { text: 'old', pieces: [] },
    segs: [
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'b' },
      { start: 2, end: 3, text: 'c' },
    ],
    from: 0,
    next: 2,
    painted: 9,
    tokensBySeg: [
      [{ offset: [0, 1], p: 0.1 }],
      [{ offset: [1, 2], p: 0.2 }],
    ],
  };
  const mapped = { text: 'old', pieces: [{}], root: {} };
  const before = messages.filter((m) => m.type === 'ih-analyze').length;
  try {
    await R.repaintPainted(session, mapped, true);
  } finally {
    globalThis.IH_appendProgress = prevAppend;
  }
  assert.equal(messages.filter((m) => m.type === 'ih-analyze').length, before);
  assert.equal(paints.length, 2);
  assert.equal(session.mapped, mapped);
  assert.equal(session.painted, 2);
  assert.deepEqual(progress.map((p) => p.start), [0, 1]);
});

test('repaintPainted：缺 token 的段跳过不抛错', async () => {
  const session = {
    mapped: { text: 'x', pieces: [] },
    segs: [{ start: 0, end: 1, text: 'x' }],
    from: 0,
    next: 1,
    painted: 1,
    tokensBySeg: [],
  };
  await assert.doesNotReject(() => R.repaintPainted(session, session.mapped, true));
  assert.equal(session.painted, 0);
});

test('afterPaint：起点之后还有段才继续；走到文末不再继续', async () => {
  const segs = [{}, {}, {}];
  let more = 0;
  await R.afterPaint({ next: 2, segs, painted: 1, mapped: { text: 'ab', pieces: [{}] } }, null, 'x', async () => { more += 1; }, newReport());
  assert.equal(more, 1);
  more = 0;
  await R.afterPaint({ from: 2, next: 3, segs, painted: 1, mapped: { text: 'abc', pieces: [{}] } }, null, 'x', async () => { more += 1; }, newReport());
  assert.equal(more, 0);
  more = 0;
  await R.afterPaint({ next: 2, segs, painted: 1, mapped: { text: 'ab', pieces: [{}] } }, null, 'x', async () => { more += 1; }, newReport(), true);
  assert.equal(more, 0);
});

test('repaintPainted：still 为假则停，不画', async () => {
  const paints = [];
  globalThis.__ihPaintStats = (tokens) => {
    paints.push(tokens);
    return { painted: 1, tokens_in: 1, tokens_skip_level: 0, tokens_skip_empty_range: 0 };
  };
  const session = {
    mapped: { text: 'ab', pieces: [] },
    segs: [
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'b' },
    ],
    from: 0,
    next: 2,
    painted: 0,
    tokensBySeg: [[{ offset: [0, 1], p: 0.1 }], [{ offset: [1, 2], p: 0.2 }]],
  };
  await R.repaintPainted(session, { text: 'ab', pieces: [{}] }, true, () => false);
  assert.equal(paints.length, 0);
});

test('runJob：failed 时 ih-usage-report 带 detail；ok 时不带', async () => {
  await R.runJob(
    () => true,
    { fail: async () => {}, idle: () => {} },
    async (report) => {
      report.segments = 1;
      report.tokens_in = 3;
      report.tokens_skip_level = 3;
      const session = {
        next: 1,
        segs: [{}],
        painted: 0,
        mapped: { text: 'Hi', pieces: [{}] },
      };
      await R.afterPaint(session, null, 'No tokens mapped onto the page', () => {}, report);
    },
  );
  const failMsg = messages.find((m) => m.type === 'ih-usage-report');
  assert.equal(failMsg.outcome, 'failed');
  assert.equal(failMsg.detail.tokens_in, 3);
  assert.equal(failMsg.detail.painted, 0);
  assert.equal(failMsg.error, 'No tokens mapped onto the page');
  assert.equal(failMsg.segments, 1);
  assert.equal('trigger' in failMsg, false);

  messages.length = 0;
  await R.runJob(
    () => true,
    { fail: async () => {}, idle: () => {} },
    async (report) => {
      report.segments = 1;
      report.detail = { tokens_in: 9 };
    },
  );
  const okMsg = messages.find((m) => m.type === 'ih-usage-report');
  assert.equal(okMsg.outcome, 'ok');
  assert.equal('detail' in okMsg, false);
  assert.equal('error' in okMsg, false);
});

test('runJob：onFailed 在 fail 之前收到 report', async () => {
  let seen = null;
  await R.runJob(
    () => true,
    {
      onFailed: ({ report }) => {
        seen = report.outcome;
      },
      fail: async () => {},
      idle: () => {},
    },
    async (report) => {
      report.segments = 1;
      throw new Error('boom');
    },
  );
  assert.equal(seen, 'failed');
});

test('runJob：hooks.trigger 写入 ih-usage-report', async () => {
  await R.runJob(
    () => true,
    { fail: async () => {}, idle: () => {}, trigger: 'icon' },
    async (report) => {
      report.segments = 1;
    },
  );
  const iconMsg = messages.find((m) => m.type === 'ih-usage-report');
  assert.equal(iconMsg.trigger, 'icon');
});

test('runJob：usageOnce 只上报一次成功，失败每次都报', async () => {
  messages.length = 0;
  const hooks = { fail: async () => {}, idle: () => {}, usageOnce: { okSent: false } };
  const ok = async (report) => {
    report.segments = 1;
  };
  const boom = async () => {
    throw new Error('boom');
  };
  await R.runJob(() => true, hooks, ok);
  await R.runJob(() => true, hooks, ok);
  await R.runJob(() => true, hooks, boom);
  await R.runJob(() => true, hooks, boom);
  const outcomes = messages.filter((m) => m.type === 'ih-usage-report').map((m) => m.outcome);
  assert.deepEqual(outcomes, ['ok', 'failed', 'failed']);
});

test('runJob：全缓存取消也不上报', async () => {
  messages.length = 0;
  await R.runJob(
    () => false,
    { fail: async () => {}, idle: () => {} },
    async (report) => {
      report.segments = 1;
      report.cached = 1;
    },
  );
  assert.equal(messages.filter((m) => m.type === 'ih-usage-report').length, 0);
});

test('runJob：全缓存成功不上报；usageOnce 仍可在后续非全缓存成功时上报', async () => {
  messages.length = 0;
  const hooks = { fail: async () => {}, idle: () => {}, usageOnce: { okSent: false } };
  await R.runJob(() => true, hooks, async (report) => {
    report.segments = 2;
    report.cached = 2;
    report.segments_ok = 2;
  });
  assert.equal(messages.filter((m) => m.type === 'ih-usage-report').length, 0);
  assert.equal(hooks.usageOnce.okSent, false);

  await R.runJob(() => true, hooks, async (report) => {
    report.segments = 1;
    report.cached = 0;
    report.segments_ok = 1;
  });
  const reports = messages.filter((m) => m.type === 'ih-usage-report');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, 'ok');
  assert.equal(hooks.usageOnce.okSent, true);
});

test('runJob：未切段失败仍发一条 ih-usage-report', async () => {
  await R.runJob(
    () => true,
    { fail: async () => {}, idle: () => {} },
    async () => {
      throw new Error('No article text');
    },
  );
  const reports = messages.filter((m) => m.type === 'ih-usage-report');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, 'failed');
  assert.equal(reports[0].segments, 0);
  assert.equal(reports[0].error, 'No article text');
});

test('runJob：首段前取消仍发一条 ih-usage-report', async () => {
  await R.runJob(
    () => false,
    { fail: async () => {}, idle: () => {} },
    async () => {},
  );
  const reports = messages.filter((m) => m.type === 'ih-usage-report');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, 'cancelled');
  assert.equal(reports[0].segments, 0);
  assert.equal('error' in reports[0], false);
});

test('runJob：空白段跳过、painted===0 时 failed 且 segments=0', async () => {
  const session = {
    mapped: { text: '   ', pieces: [{}] },
    segs: [{ start: 0, end: 3, text: '   ' }],
    painted: 0,
    next: 0,
  };
  await R.runJob(
    () => true,
    { fail: async () => {}, idle: () => {} },
    async (report) => {
      await R.paintRange(session, 0, 1, () => true, {}, report);
      session.next = 1;
      await R.afterPaint(session, undefined, 'No tokens mapped onto the page', () => {}, report);
    },
  );
  const reports = messages.filter((m) => m.type === 'ih-usage-report');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, 'failed');
  assert.equal(reports[0].segments, 0);
  assert.equal(reports[0].error, 'No tokens mapped onto the page');
});

test('background.js：失败时 error/detail 写进同一条 /api/extension-usage', () => {
  const src = readFileSync(join(dir, '../background.js'), 'utf8');
  const fn = src.match(/async function postUsageReport\(body\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'postUsageReport missing');
  assert.match(fn[0], /IL_postKeepalive\('\/api\/extension-usage', payload/);
  assert.match(src, /il-extension-feedback/);
  assert.match(fn[0], /if \(model\) payload\.model = model/);
  assert.match(fn[0], /payload\.error = err/);
  assert.match(fn[0], /payload\.detail = detail/);
  assert.match(fn[0], /payload\.options = options/);
  assert.match(fn[0], /if \(engine\) payload\.engine = engine/);
  assert.doesNotMatch(fn[0], /resolveUsageEngine/);
  assert.match(src, /USAGE_ENGINE_CLOUD_FREE = 'cloud-free'/);
  assert.match(readFileSync(join(dir, '../analyzeRun.js'), 'utf8'), /isUsageReportEngine/);
  assert.match(fn[0], /body\.trigger\.trim\(\)/);
  assert.match(fn[0], /: 'other'/);
  assert.match(fn[0], /outcome,\s*trigger,\s*segments,/);
  assert.doesNotMatch(fn[0], /segments < 1/);
  assert.doesNotMatch(fn[0], /ui_lang/);
  assert.doesNotMatch(fn[0], /\btz\b/);
  const run = readFileSync(join(dir, '../analyzeRun.js'), 'utf8');
  assert.doesNotMatch(run, /report\.segments < 1/);
  const badge = src.match(/async function setBadgeError\(tabId, brief, trigger\) \{[\s\S]*?\n\}/);
  assert.ok(badge, 'setBadgeError missing');
  assert.match(badge[0], /await postUsageReport\(\{/);
  assert.match(badge[0], /outcome: 'failed'/);
  assert.match(badge[0], /segments: 0/);
  assert.match(badge[0], /trigger,/);
  assert.match(badge[0], /await postAnonymousSiteDomainForTab\(tabId, trigger\)/);
  assert.match(src, /IL_isRestrictedUrl\(url\)[\s\S]*?setBadgeError\(tab\.id, "can't run here — this page is protected", why\)[\s\S]*?openRestrictedPageWindow/);
  assert.match(src, /setBadgeError\(tab\.id, 'inject', why\)/);
  assert.match(src, /setBadgeError\(tab\.id, access\.brief, why\)/);
  assert.match(src, /refuseStalePage\(tab\.id, why\)/);
  assert.doesNotMatch(src, /await refuseStalePage\(tabId/);
  assert.doesNotMatch(src, /refuseStalePage\(tabId, 'auto'\)/);
  const auto = src.slice(src.indexOf('扩展重载后的过期标签静默跳过'), src.indexOf('chrome.action.onClicked'));
  assert.match(auto, /async function maybeAutoAnalyze/);
  assert.match(auto, /if \(peek\.state === 'stale'\) \{[\s\S]*?return;/);
  assert.doesNotMatch(auto, /refuseStalePage/);
  assert.doesNotMatch(auto, /setBadgeError\(tabId, 'refresh this page'/);
  assert.match(src, /setBadgeError\(tabId, 'inject', 'auto'\)/);
  assert.doesNotMatch(badge[0], /fresh\.url|tab\.url|pageUrl/);
  assert.match(src, /auto_sites: sites\.length/);
  assert.match(src, /void activateTab\(tab, false, '', 'icon'\)/);
  assert.match(src, /void activateTab\(tab, false, '', 'menu'\)/);
  assert.match(src, /void activateTab\(tab, true, '', 'rerun'\)/);
  assert.doesNotMatch(src, /triggerByTab/);
  assert.doesNotMatch(src, /USAGE_TRIGGERS/);
  assert.doesNotMatch(src, /function usageModelId/);
  assert.doesNotMatch(src, /\/api\/extension-analysis-fail/);
});

test('paintRange：免费接口 429 停下，用量 error 为 free api rate limited，Error 带 notice', async () => {
  const orig = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = (msg, cb) => {
    if (msg?.type === 'ih-analyze') {
      cb({
        ok: false,
        error: 'free api rate limited',
        notice: { zh: '免费 API 请求过快，请稍后再试', en: 'Too many free API requests. Please try again later.' },
      });
      return;
    }
    orig.call(globalThis.chrome.runtime, msg, cb);
  };
  const session = {
    mapped: { text: 'Hello', pieces: [{}] },
    segs: [{ start: 0, end: 5, text: 'Hello' }],
    painted: 0,
  };
  let caught;
  try {
    await R.runJob(
      () => true,
      { fail: async (err) => { caught = err; }, idle: () => {} },
      async (report) => {
        await R.paintRange(session, 0, 1, () => true, {}, report);
      },
    );
  } finally {
    globalThis.chrome.runtime.sendMessage = orig;
  }
  assert.equal(caught.message, 'free api rate limited');
  assert.deepEqual(caught.notice, { zh: '免费 API 请求过快，请稍后再试', en: 'Too many free API requests. Please try again later.' });
  const failMsg = messages.find((m) => m.type === 'ih-usage-report');
  assert.equal(failMsg.outcome, 'failed');
  assert.equal(failMsg.error, 'free api rate limited');
});
