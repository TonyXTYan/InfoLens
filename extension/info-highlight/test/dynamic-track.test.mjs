/**
 * 动态跟踪主逻辑：视口补画、DOM 增减、旧段冻结、哈希缓存、开关与 hidden。
 * 运行：node --test extension/info-highlight/test/dynamic-track.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../../shared/page/textIndex.js'), 'utf8'), {
  filename: 'textIndex.js',
});
runInThisContext(readFileSync(join(dir, '../dynamicTrack.js'), 'utf8'), {
  filename: 'dynamicTrack.js',
});
const DT = globalThis.IH_dynamicTrack;
globalThis.IL_EDITABLE_SEL = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function splitBy(size) {
  return (text) => {
    const segs = [];
    for (let i = 0; i < text.length; i += size) {
      const t = text.slice(i, i + size);
      segs.push({ start: i, end: i + t.length, text: t });
    }
    return segs;
  };
}

function segsOf(text, size = 4) {
  return splitBy(size)(text);
}

function mask(n, painted) {
  const out = Array.from({ length: n }, () => false);
  for (const i of painted) out[i] = true;
  return out;
}

function range(a, b) {
  return Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
}

/** 按 track.nextPaint 逐段现挑直到没有可画段，返回画的顺序。inView / below 模拟视口内与下方一屏内的段。 */
function fillOrder({ segsLength, tokensBySeg = [], inView = [], below = [] }) {
  const prev = globalThis.IH_viewportSegments;
  globalThis.IH_viewportSegments = () => ({ inView, below });
  try {
    const track = DT.createTrack({ useDynamic: () => true, live: () => false });
    const session = { mapped: {}, segs: Array(segsLength).fill({}), tokensBySeg: tokensBySeg.slice() };
    const out = [];
    for (let i = track.nextPaint(session); i >= 0; i = track.nextPaint(session)) {
      out.push(i);
      session.tokensBySeg[i] = [];
    }
    return out;
  } finally {
    globalThis.IH_viewportSegments = prev;
  }
}

function bags(painted) {
  return painted.map((p) => (p ? [] : undefined));
}

function planned(input) {
  const plan = DT.planFill(input);
  const painted = (plan.tokensBySeg || []).map((bag) => Array.isArray(bag));
  const n = plan.segs.length;
  const start = input.viewportStart | 0;
  const paint = n
    ? fillOrder({
        segsLength: n,
        tokensBySeg: plan.tokensBySeg,
        inView: input.inView ?? range(start, Math.min(n, input.inViewEnd ?? start + 1)),
        below: (input.below ?? []).filter((i) => i < n),
      })
    : [];
  return { ...plan, painted, paint };
}

function fakeTimers() {
  const timers = new Map();
  let seq = 0;
  return {
    timers,
    api: {
      setTimeout(fn) {
        const id = ++seq;
        timers.set(id, fn);
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
    },
    fire() {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
    },
  };
}

test('1. 滚动停下后只分析视口内与下方一屏内的未画段', () => {
  const segs = segsOf('AAAABBBBCCCCDDDDEEEEFFFF', 4);
  assert.deepEqual(fillOrder({
    segsLength: segs.length,
    tokensBySeg: bags(mask(segs.length, [0, 1])),
    inView: [2],
    below: [3],
  }), [2, 3]);
  const plan = planned({
    oldText: 'AAAABBBBCCCCDDDDEEEEFFFF',
    oldSegs: segs,
    newText: 'AAAABBBBCCCCDDDDEEEEFFFF',
    splitFn: splitBy(4),
    tokensBySeg: [[], []],
    viewportStart: 2,
    below: [3],
  });
  assert.deepEqual(plan.paint, [2, 3]);
});

test('2. DOM 增长：下方插入新正文，已在视口附近时自动补', () => {
  const oldText = 'AAAABBBBCCCC';
  const oldSegs = segsOf(oldText, 4);
  const newText = oldText + 'DDDDEEEE';
  const recon = DT.reconcileSegments(oldSegs, oldText, newText, splitBy(4));
  assert.deepEqual(recon.slice(0, 3).map((s) => ({ start: s.start, end: s.end, text: s.text })), oldSegs);
  assert.equal(recon[0].start, 0);
  assert.equal(recon[2].end, oldText.length);
  assert.ok(recon.some((s) => s.start >= oldText.length));
  const remapped = DT.remapCommitted(oldSegs, [[1], [2], [3]], recon, oldText, newText);
  assert.deepEqual(remapped.painted.slice(0, 3), [true, true, true]);
  assert.deepEqual(fillOrder({
    segsLength: recon.length,
    tokensBySeg: bags(remapped.painted),
    inView: [2],
    below: [3, 4],
  }), [3, 4]);
});

test('3. 视口未滚、大块内容被替换 → 旧段丢掉，从视口补新段', () => {
  const oldText = 'O'.repeat(60) + 'L'.repeat(60);
  const oldSegs = segsOf(oldText, 60);
  const newText = 'N'.repeat(60) + 'W'.repeat(60);
  const recon = DT.reconcileSegments(oldSegs, oldText, newText, splitBy(60));
  assert.ok(recon.every((s) => !oldSegs.some((o) => o.text === s.text)), '旧段找不到就丢掉');
  const remapped = DT.remapCommitted(oldSegs, oldSegs.map(() => [{}]), recon, oldText, newText);
  assert.ok(remapped.painted.every((p) => !p));
  const plan = planned({
    oldText,
    oldSegs,
    newText,
    splitFn: splitBy(60),
    tokensBySeg: oldSegs.map(() => [{}]),
    viewportStart: 1,
    nScreens: 2,
  });
  assert.ok(plan.paint.length > 0);
  assert.ok(plan.paint[0] >= 1);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const dtSrc = readFileSync(join(dir, '../dynamicTrack.js'), 'utf8');
  assert.match(content, /R\.paintEach\(session, track, still/);
  assert.match(dtSrc, /IH_viewportSegments/);
  assert.doesNotMatch(content, /pendingReplace|forceReplace|mutationsLookLikeReplace/);
});

test('4. 视口内未画优先，其次下方一屏内近的先；多列不填中间空洞', () => {
  assert.deepEqual(fillOrder({
    segsLength: 10,
    tokensBySeg: bags(mask(10, [5, 6, 7])),
    inView: [2, 3],
    below: [4, 5, 8],
  }), [2, 3, 4, 8]);
  assert.deepEqual(fillOrder({
    segsLength: 12,
    inView: [2, 9],
    below: [3, 10],
  }), [2, 9, 3, 10]);
});

test('5. 旧段边界不被新内容切开；新段只在旧边界外', () => {
  const oldText = 'AAAA' + 'BBBB' + 'CCCC';
  const oldSegs = segsOf(oldText, 4);
  const inserted = 'XXXXYYYY';
  const newText = 'AAAA' + inserted + 'BBBBCCCC';
  const recon = DT.reconcileSegments(oldSegs, oldText, newText, splitBy(4));
  const kept = recon.filter((s) => oldSegs.some((o) => o.text === s.text));
  assert.deepEqual(kept.map((s) => s.text), ['AAAA', 'BBBB', 'CCCC']);
  for (const old of oldSegs) {
    const hit = recon.find((s) => s.text === old.text);
    assert.ok(hit);
    assert.equal(hit.end - hit.start, old.text.length);
    assert.equal(hit.text, old.text);
  }
  const gap = recon.filter((s) => !oldSegs.some((o) => o.text === s.text));
  assert.ok(gap.length > 0);
  assert.ok(gap.every((s) => s.start >= 4 && s.end <= 4 + inserted.length));
  const firstOldEnd = recon.find((s) => s.text === 'AAAA').end;
  const secondOldStart = recon.find((s) => s.text === 'BBBB').start;
  assert.ok(gap.every((s) => s.start >= firstOldEnd && s.end <= secondOldStart));
});

test('6. 同文本命中缓存，不重复发起分析请求', async () => {
  const cache = new Map();
  const text = 'context + this segment';
  const tokens = [{ offset: [0, 4], p: 0.2 }];
  assert.equal(cache.has(text), false);
  cache.set(text, tokens);
  assert.equal(cache.has(text), true);
  assert.equal(cache.get(text), tokens);
  assert.equal(cache.get(text + '!'), undefined);

  const messages = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        messages.push(msg);
        if (msg?.type === 'ih-analyze') {
          cb({
            ok: true,
            data: { result: { bpe_strings: [{ offset: [0, 5], p: 0.01 }], model: 'qwen3-0.6b' } },
            inferred: true,
            engine: 'cloud',
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
  globalThis.IH_segmentWindow = (_text, segs, i) => ({
    requestText: segs[i].text,
    originCp: 0,
    segStartCp: 0,
    segEndCp: segs[i].text.length,
  });
  globalThis.IH_tokensInSegment = (raw) => raw;
  globalThis.IH_paintTokens = () => ({
    painted: 1, tokens_in: 1, tokens_skip_level: 0, tokens_skip_empty_range: 0,
  });
  globalThis.IH_dropTokenRangesOverlapping = () => {};
  runInThisContext(readFileSync(join(dir, '../analyzeRun.js'), 'utf8'), {
    filename: 'analyzeRun.js',
  });
  const R = globalThis.IH_analyzeRun;
  const resultCache = new Map();
  const session = {
    mapped: { text: 'HelloHello', pieces: [{}] },
    segs: [
      { start: 0, end: 5, text: 'Hello' },
      { start: 5, end: 10, text: 'Hello' },
    ],
    painted: 0,
    resultCache,
  };
  await R.paintRange(session, 0, 1, () => true, {}, {
    segments: 0, segments_ok: 0, cached: 0, engine: null,
    tokens_in: 0, tokens_skip_level: 0, tokens_skip_empty_range: 0, painted: 0, align_fail_n: 0,
  });
  const afterFirst = messages.filter((m) => m.type === 'ih-analyze').length;
  assert.equal(afterFirst, 1);
  const report2 = {
    segments: 0, segments_ok: 0, cached: 0, engine: null,
    tokens_in: 0, tokens_skip_level: 0, tokens_skip_empty_range: 0, painted: 0, align_fail_n: 0,
  };
  await R.paintRange(session, 1, 2, () => true, {}, report2);
  assert.equal(messages.filter((m) => m.type === 'ih-analyze').length, 1);
  assert.equal(report2.cached, 1);
});

test('7. 动态跟踪关 → 静态批处理与继续预算同为 32 段；开 → 隐藏从当前屏幕位置开始', () => {
  const html = readFileSync(join(dir, '../options.html'), 'utf8');
  const opts = readFileSync(join(dir, '../options.js'), 'utf8');
  assert.match(html, /data-option-id="ih_dynamic_track"/);
  assert.match(html, /id="ih_dynamic_track" checked/);
  assert.match(html, /data-option-id="ih_from_viewport" hidden/);
  assert.match(opts, /function syncDynamicTrackUi/);
  assert.match(opts, /fromRow\.hidden = !!on/);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const dt = readFileSync(join(dir, '../dynamicTrack.js'), 'utf8');
  assert.match(content, /session\.next \+ R\.MAX_SEGMENTS_PER_RUN/);
  assert.match(content, /useDynamic\(\)/);
});

test('8. document.hidden 时不发起分析', async () => {
  let runs = 0;
  const t = fakeTimers();
  const sched = DT.createPoller({
    intervalMs: 500,
    isHidden: () => true,
    isEnabled: () => true,
    isBusy: () => false,
    snapshot: () => ({ mark: 0, run: true }),
    run: () => { runs += 1; },
  }, t.api);
  sched.markDirty();
  await Promise.resolve();
  assert.equal(runs, 0);
  sched.start();
  t.fire();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0);
});

test('9. 累计约 32 段触发「继续」询问', () => {
  assert.equal(DT.CONTINUE_AFTER_SEGMENTS, 32);
  assert.equal(DT.shouldAskContinue(31), false);
  assert.equal(DT.shouldAskContinue(32), true);
  assert.equal(DT.shouldAskContinue(40, 64), false);
  const segs = segsOf('A'.repeat(40), 1);
  const plan = planned({
    oldText: 'A'.repeat(40),
    oldSegs: segs,
    newText: 'A'.repeat(40),
    splitFn: splitBy(1),
    tokensBySeg: Array.from({ length: 32 }, () => [{}]),
    viewportStart: 32,
    below: [33],
  });
  assert.deepEqual(plan.paint, [32, 33]);
  const prev = globalThis.IH_viewportSegments;
  globalThis.IH_viewportSegments = () => ({ inView: [32], below: [33] });
  try {
    const track = DT.createTrack({ useDynamic: () => true, live: () => false });
    const session = { mapped: {}, segs, tokensBySeg: plan.tokensBySeg, analyzed: 32, continueBudget: 32 };
    assert.equal(track.pickNext(session), -1);
    assert.equal(track.needsContinue(session), true);
    session.continueBudget = DT.nextContinueBudget(32);
    assert.equal(track.pickNext(session), 32);
    assert.equal(track.needsContinue(session), false);
  } finally {
    globalThis.IH_viewportSegments = prev;
  }
});

test('10. 关掉高亮后不再触发分析', async () => {
  let runs = 0;
  let enabled = true;
  const t = fakeTimers();
  const sched = DT.createPoller({
    intervalMs: 500,
    isHidden: () => false,
    isEnabled: () => enabled,
    isBusy: () => false,
    snapshot: () => ({ mark: 0, run: true }),
    run: () => { runs += 1; },
  }, t.api);
  enabled = false;
  sched.stop();
  sched.markDirty();
  t.fire();
  await Promise.resolve();
  assert.equal(t.timers.size, 0);
  assert.equal(runs, 0);

  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(content, /function clearAll\(\) \{\s*track\.stop/);
  assert.match(content, /live: \(\) => !!session/);
});

test('调度：忙时跳过，不并发', async () => {
  let running = 0;
  let max = 0;
  let busy = false;
  let resolveRun;
  const gate = new Promise((r) => { resolveRun = r; });
  const t = fakeTimers();
  const sched = DT.createPoller({
    intervalMs: 10,
    isHidden: () => false,
    isEnabled: () => true,
    isBusy: () => busy,
    snapshot: () => ({ mark: 0, run: true }),
    async run() {
      busy = true;
      running += 1;
      max = Math.max(max, running);
      await gate;
      running -= 1;
      busy = false;
    },
  }, t.api);
  sched.start();
  t.fire();
  t.fire();
  await Promise.resolve();
  t.fire();
  t.fire();
  await Promise.resolve();
  assert.equal(max, 1);
  resolveRun();
  await Promise.resolve();
  await Promise.resolve();
});

test('输入框 / contenteditable 的 mutation 不触发', () => {
  const editable = {
    closest(sel) {
      return String(sel).includes('contenteditable') ? this : null;
    },
  };
  const input = {
    closest(sel) {
      return String(sel).includes('input') ? this : null;
    },
  };
  const body = { closest() { return null; } };
  assert.equal(DT.mutationsWorthWatching([{ target: editable }]), false);
  assert.equal(DT.mutationsWorthWatching([{ target: input }]), false);
  assert.equal(DT.mutationsWorthWatching([{ target: body }]), true);
  assert.equal(DT.mutationsWorthWatching([{ target: editable }, { target: body }]), true);
});

test('选项默认值、文案、注入顺序与提醒', () => {
  const defs = readFileSync(join(dir, '../optionDefaults.js'), 'utf8');
  const catalog = readFileSync(join(dir, '../options-catalog.js'), 'utf8');
  const zh = readFileSync(join(dir, '../zh.js'), 'utf8');
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  const html = readFileSync(join(dir, '../options.html'), 'utf8');
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(defs, /ih_dynamic_track: true/);
  assert.match(catalog, /'ih_dynamic_track'/);
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_dynamic_track/,
  );
  assert.match(zh, /动态跟踪模式/);
  assert.match(zh, /高亮会跟着滚动和页面变化自动补画/);
  assert.match(html, /src="dynamicTrack\.js"/);
  assert.ok(html.indexOf('src="dynamicTrack.js"') < html.indexOf('src="page-map.js"'));
  assert.match(bg, /'dynamicTrack\.js'/);
  assert.ok(bg.indexOf("'dynamicTrack.js'") < bg.indexOf("'page-map.js'"));
  assert.doesNotMatch(bg, /armDynamicTrackNotice/);
  assert.match(pageMap, /ih_dynamic_track_notice/);
  assert.match(pageMap, /maybeShowDynamicTrackNotice/);
  assert.match(pageMap, /data-ih-dynamic-notice/);
  assert.match(pageMap, /dynamicTrack \|\| fromViewport/);
  assert.match(pageMap, /if \(dynamicTrack \|\| viewportNoticeDismissed/);
  const dt = readFileSync(join(dir, '../dynamicTrack.js'), 'utf8');
  assert.match(dt, /POLL_MS/);
  assert.match(content, /CONTINUE_AFTER_SEGMENTS/);
  assert.match(content, /document\.hidden/);
  assert.match(content, /function runDynamicFill/);
  assert.equal(DT.POLL_MS, 500);
});

test('收藏补画从头走到上限，不跟批处理/继续，不跳过已画段', () => {
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const fillAt = content.indexOf('async function fillLibrarySegments');
  const ensureAt = content.indexOf('async function ensureForLibrary');
  const startAt = content.indexOf('\n  function start(');
  assert.ok(fillAt >= 0 && ensureAt > fillAt && startAt > ensureAt);
  const fill = content.slice(fillAt, ensureAt);
  const ensure = content.slice(ensureAt, startAt);
  assert.match(fill, /R\.paintRange\(session, 0, to/);
  assert.match(fill, /R\.LIBRARY_MAX_SEGMENTS/);
  assert.match(fill, /skipCache: false/);
  assert.match(fill, /onSegment/);
  assert.match(fill, /__IH_LIBRARY_UI/);
  assert.match(fill, /key: 'analyze'/);
  assert.match(fill, /tr\('Analyze'\)/);
  assert.match(fill, /continueArmed = false/);
  assert.doesNotMatch(fill, /tokensBySeg/);
  assert.doesNotMatch(fill, /MAX_SEGMENTS_PER_RUN/);
  assert.doesNotMatch(fill, /pauseForContinue/);
  assert.doesNotMatch(fill, /useDynamic\(\)/);
  assert.match(ensure, /openSession\(false\)/);
  assert.match(ensure, /fillLibrarySegments\(\)/);
  assert.doesNotMatch(ensure, /setEnabled\(true, 'library'\)/);
});
