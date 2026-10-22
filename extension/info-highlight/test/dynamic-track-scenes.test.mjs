/**
 * 动态跟踪补充场景：虚拟列表、上方插入、改写、防抖、大变动、同窗换文、hidden、N 屏、继续、开关。
 * 运行：node --test extension/info-highlight/test/dynamic-track-scenes.test.mjs
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

/** 给 paintEach 的 track：按给定顺序逐个挑，用完返回 -1；inView 为视口内的段。 */
function listTrack(list, inView = []) {
  let k = 0;
  return {
    pickNext: () => (k < list.length ? list[k++] : -1),
    viewLeft: (s) => inView.filter((i) => !Array.isArray(s.tokensBySeg?.[i])).length,
  };
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
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    fire() {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
    },
  };
}

test('1. 信息流节点回收：同文重建命中哈希，不重复请求', async () => {
  const text = 'HelloHello';
  const oldSegs = [
    { start: 0, end: 5, text: 'Hello' },
    { start: 5, end: 10, text: 'Hello' },
  ];
  const recon = DT.reconcileSegments(oldSegs, text, text, splitBy(5));
  const remapped = DT.remapCommitted(oldSegs, [[{ p: 0.1 }], [{ p: 0.2 }]], recon, text, text);
  assert.deepEqual(remapped.painted, [true, true]);
  const plan = planned({
    oldText: text,
    oldSegs,
    newText: text,
    splitFn: splitBy(5),
    tokensBySeg: [[{ p: 0.1 }], [{ p: 0.2 }]],
    viewportStart: 0,
    nScreens: 2,
  });
  assert.deepEqual(plan.paint, []);

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
  globalThis.IH_segmentWindow = (_t, segs, i) => ({
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
    mapped: { text, pieces: [{ node: { isConnected: true } }] },
    segs: oldSegs,
    painted: 0,
    resultCache,
  };
  const blank = () => ({
    segments: 0, segments_ok: 0, cached: 0, engine: null,
    tokens_in: 0, tokens_skip_level: 0, tokens_skip_empty_range: 0, painted: 0, align_fail_n: 0,
  });
  await R.paintRange(session, 0, 1, () => true, {}, blank());
  assert.equal(messages.filter((m) => m.type === 'ih-analyze').length, 1);
  const recycled = {
    mapped: { text, pieces: [{ node: { isConnected: true } }] },
    segs: [
      { start: 0, end: 5, text: 'Hello' },
      { start: 5, end: 10, text: 'Hello' },
    ],
    painted: 0,
    resultCache,
  };
  const report = blank();
  await R.paintRange(recycled, 0, 2, () => true, {}, report);
  assert.equal(messages.filter((m) => m.type === 'ih-analyze').length, 1);
  assert.equal(report.cached, 2);
});

test('2. 上方插入新内容：旧段边界平移且文本不变，新段只在旧边界外', () => {
  const oldText = 'AAAABBBBCCCC';
  const oldSegs = segsOf(oldText, 4);
  const prefix = 'TOPP';
  const newText = prefix + oldText;
  const recon = DT.reconcileSegments(oldSegs, oldText, newText, splitBy(4));
  const kept = recon.filter((s) => oldSegs.some((o) => o.text === s.text));
  assert.deepEqual(kept.map((s) => s.text), ['AAAA', 'BBBB', 'CCCC']);
  assert.equal(kept[0].start, prefix.length);
  assert.equal(kept[0].end, prefix.length + 4);
  assert.equal(kept[2].end, newText.length);
  const fresh = recon.filter((s) => !oldSegs.some((o) => o.text === s.text));
  assert.ok(fresh.length > 0);
  assert.ok(fresh.every((s) => s.end <= prefix.length));
  const remapped = DT.remapCommitted(oldSegs, [['a'], ['b'], ['c']], recon, oldText, newText);
  assert.equal(remapped.painted[0], false);
  assert.deepEqual(remapped.tokensBySeg.slice(1, 4), [['a'], ['b'], ['c']]);

  const oldTokens = [
    [{ offset: [0, 4], p: 0.1, raw: 'AAAA' }],
    [{ offset: [4, 8], p: 0.2, raw: 'BBBB' }],
    [{ offset: [8, 12], p: 0.3, raw: 'CCCC' }],
  ];
  const shifted = DT.remapCommitted(oldSegs, oldTokens, recon, oldText, newText);
  assert.equal(shifted.painted[0], false);
  const moved = shifted.tokensBySeg.slice(1, 4);
  assert.deepEqual(moved[0][0].offset, [4, 8]);
  assert.deepEqual(moved[1][0].offset, [8, 12]);
  assert.deepEqual(moved[2][0].offset, [12, 16]);
  assert.equal(newText.slice(moved[0][0].offset[0], moved[0][0].offset[1]), 'AAAA');
  assert.equal(newText.slice(moved[2][0].offset[0], moved[2][0].offset[1]), 'CCCC');
  assert.notEqual(moved[0][0], oldTokens[0][0], '起点变了要新 offset，不能只换 bags 引用');
});

test('3. 同一位置文本被改写：旧段失效，不复用旧哈希', () => {
  const A = 'A'.repeat(60);
  const B = 'B'.repeat(60);
  const C = 'C'.repeat(60);
  const Z = 'Z'.repeat(60);
  const oldText = A + B + C;
  const oldSegs = segsOf(oldText, 60);
  const newText = A + Z + C;
  const recon = DT.reconcileSegments(oldSegs, oldText, newText, splitBy(60));
  const remapped = DT.remapCommitted(oldSegs, [['A'], ['B'], ['C']], recon, oldText, newText);
  const z = recon.findIndex((s) => s.text === Z);
  assert.ok(z >= 0);
  assert.equal(remapped.painted[z], false);
  assert.notEqual(remapped.tokensBySeg[z], 'B');
  assert.ok(recon.some((s) => s.text === A));
  assert.ok(recon.some((s) => s.text === C));
  assert.notEqual(B, Z);
  const cache = new Map();
  cache.set(B, [{ p: 0.9 }]);
  assert.equal(cache.has(Z), false);
  const plan = planned({
    oldText,
    oldSegs,
    newText,
    splitFn: splitBy(60),
    tokensBySeg: [['A'], ['B'], ['C']],
    viewportStart: 1,
    nScreens: 2,
  });
  assert.ok(plan.paint.includes(z));
});

test('4. 快速连续 DOM：只标 dirty，停稳后跑一次；忙时不并发', async () => {
  let runs = 0;
  let running = 0;
  let max = 0;
  let busy = false;
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = fakeTimers();
  const sched = DT.createPoller({
    intervalMs: 500,
    isHidden: () => false,
    isEnabled: () => true,
    isBusy: () => busy,
    snapshot: () => ({ mark: 0, run: true }),
    async run() {
      busy = true;
      running += 1;
      max = Math.max(max, running);
      runs += 1;
      await gate;
      running -= 1;
      busy = false;
    },
  }, t.api);
  sched.start();
  sched.markDirty();
  sched.markDirty();
  sched.markDirty();
  t.fire();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1);
  sched.markDirty();
  sched.markDirty();
  t.fire();
  await Promise.resolve();
  assert.equal(max, 1);
  release();
  await Promise.resolve();
  await Promise.resolve();
});

test('5. 整块内容换成另一篇：旧段丢掉，从视口补画', () => {
  const oldText = 'A'.repeat(60) + 'B'.repeat(60) + 'C'.repeat(60);
  const newText = 'X'.repeat(60) + 'Y'.repeat(60) + 'Z'.repeat(60);
  const oldSegs = segsOf(oldText, 60);
  const recon = DT.reconcileSegments(oldSegs, oldText, newText, splitBy(60));
  assert.ok(recon.every((s) => !oldSegs.some((o) => o.text === s.text)));
  const plan = planned({
    oldText,
    oldSegs,
    newText,
    splitFn: splitBy(60),
    tokensBySeg: oldSegs.map(() => [{}]),
    viewportStart: 0,
    nScreens: 2,
  });
  assert.ok(plan.paint.includes(0));
  assert.ok(plan.painted.every((p) => !p));
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(content, /new MutationObserver/);
  assert.doesNotMatch(content, /pendingReplace|mutationsLookLikeReplace|forceReplace/);
});

test('6. 同窗换文：旧段对不上就丢掉，从视口补；不看 href', () => {
  const oldText = 'F'.repeat(60) + 'G'.repeat(60);
  const newText = 'S'.repeat(60) + 'T'.repeat(60);
  const oldSegs = segsOf(oldText, 60);
  const plan = planned({
    oldText,
    oldSegs,
    newText,
    splitFn: splitBy(60),
    tokensBySeg: oldSegs.map(() => [{}]),
    viewportStart: 1,
    nScreens: 2,
  });
  assert.ok(plan.paint.every((i) => i >= 1));
  assert.ok(plan.painted.every((p) => !p));
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const dt = readFileSync(join(dir, '../dynamicTrack.js'), 'utf8');
  assert.doesNotMatch(content, /hrefKey|pageHref/);
  assert.doesNotMatch(dt, /hrefKey|pageHref/);
  assert.doesNotMatch(content, /session\.analyzed = 0/);
  assert.match(content, /new MutationObserver/);
  assert.doesNotMatch(content, /pushState|replaceState|popstate|onSpaNav|hookSpaNav|pendingReplace|forceReplace/);
});

test('7. hidden → visible：恢复轮询，停稳后补画视口内未画段', async () => {
  let hidden = true;
  let runs = 0;
  const t = fakeTimers();
  const sched = DT.createPoller({
    intervalMs: 500,
    isHidden: () => hidden,
    isEnabled: () => true,
    isBusy: () => false,
    snapshot: () => ({ mark: '2:4', run: true }),
    run: () => { runs += 1; },
  }, t.api);
  sched.markDirty();
  await Promise.resolve();
  assert.equal(runs, 0);
  hidden = false;
  sched.onVisible();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0, '可见后第一次轮询只记位置');
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1);

  const t2 = fakeTimers();
  let runs2 = 0;
  const idle = DT.createPoller({
    intervalMs: 500,
    isHidden: () => false,
    isEnabled: () => true,
    isBusy: () => false,
    snapshot: () => ({ mark: '0:1', run: true }),
    run: () => { runs2 += 1; },
  }, t2.api);
  idle.onVisible();
  t2.fire();
  await Promise.resolve();
  assert.equal(runs2, 0);
  t2.fire();
  await Promise.resolve();
  assert.equal(runs2, 1, '切回可见后停稳才补一次视口');

  const plan = planned({
    oldText: 'AAAABBBBCCCCDDDD',
    oldSegs: segsOf('AAAABBBBCCCCDDDD', 4),
    newText: 'AAAABBBBCCCCDDDD',
    splitFn: splitBy(4),
    tokensBySeg: [[], []],
    viewportStart: 1,
    inViewEnd: 3,
    below: [3],
  });
  // 视口内未画 [2]，再画下方一屏内的 3
  assert.deepEqual(plan.paint, [2, 3]);
});

test('8. 视口内画完才轮到下方一屏；一屏外不补', () => {
  assert.deepEqual(fillOrder({ segsLength: 10, inView: [4], below: [5, 6] }), [4, 5, 6]);
  const done4 = [];
  done4[4] = [];
  assert.deepEqual(fillOrder({ segsLength: 10, tokensBySeg: done4, inView: [4], below: [5] }), [5]);
  assert.deepEqual(fillOrder({ segsLength: 10, tokensBySeg: Array(10).fill([]), inView: [4], below: [5] }), []);
  assert.deepEqual(fillOrder({ segsLength: 12, inView: [2, 9], below: [3, 10] }), [2, 9, 3, 10]);
});

test('9. 「继续」后重置额度并跟随；不点则不再分析', async () => {
  assert.equal(DT.nextContinueBudget(32), 64);
  assert.equal(DT.nextContinueBudget(0), 32);
  const segs = segsOf('A'.repeat(40), 1);
  const asked = planned({
    oldText: 'A'.repeat(40),
    oldSegs: segs,
    newText: 'A'.repeat(40),
    splitFn: splitBy(1),
    tokensBySeg: Array.from({ length: 32 }, () => [{}]),
    viewportStart: 32,
    below: [33],
  });
  assert.ok(asked.paint.length > 0);
  assert.equal(DT.shouldAskContinue(32, 32) && asked.paint.length > 0, true);
  const afterClick = planned({
    oldText: 'A'.repeat(40),
    oldSegs: segs,
    newText: 'A'.repeat(40),
    splitFn: splitBy(1),
    tokensBySeg: Array.from({ length: 32 }, () => [{}]),
    viewportStart: 32,
    below: [33],
  });
  assert.equal(DT.shouldAskContinue(32, DT.nextContinueBudget(32)), false);
  assert.deepEqual(afterClick.paint, [32, 33]);

  let continueArmed = true;
  let runs = 0;
  const t = fakeTimers();
  const sched = DT.createPoller({
    intervalMs: 10,
    isHidden: () => false,
    isEnabled: () => true,
    isBusy: () => continueArmed,
    snapshot: () => ({ mark: 0, run: true }),
    run: () => { runs += 1; },
  }, t.api);
  sched.start();
  t.fire();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0);
  continueArmed = false;
  sched.markDirty();
  t.fire();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(content, /nextContinueBudget/);
  assert.match(content, /continueArmed = true/);
});

test('10. 动态跟踪开关只在新开会话时读一次；轮询停了能重新起', async () => {
  const segs = segsOf('AAAABBBBCCCCDDDD', 4);
  const on = planned({
    oldText: 'AAAABBBBCCCCDDDD',
    oldSegs: segs,
    newText: 'AAAABBBBCCCCDDDD',
    splitFn: splitBy(4),
    tokensBySeg: [[], []],
    viewportStart: 2,
    below: [3],
  });
  assert.deepEqual(on.paint, [2, 3]);

  let dynamicOn = true;
  let runs = 0;
  const t = fakeTimers();
  const sched = DT.createPoller({
    intervalMs: 10,
    isHidden: () => false,
    isEnabled: () => dynamicOn,
    isBusy: () => false,
    snapshot: () => ({ mark: 0, run: true }),
    run: () => { runs += 1; },
  }, t.api);
  dynamicOn = false;
  sched.stop();
  sched.markDirty();
  t.fire();
  assert.equal(t.timers.size, 0);
  dynamicOn = true;
  sched.start();
  t.fire();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const pdf = readFileSync(join(dir, '../pdf/highlight.js'), 'utf8');
  assert.match(content, /if \(!session\) dynamic = /);
  assert.match(pdf, /dynamic = !!globalThis\.IH_isDynamicTrack\(\)/);
  assert.doesNotMatch(content + pdf, /listenStorage/);
});

test('11. contenteditable / 输入框内变化不触发分析', () => {
  const box = (key) => ({
    closest(sel) {
      return String(sel).includes(key) ? this : null;
    },
  });
  assert.equal(DT.mutationsWorthWatching([{ target: box('contenteditable') }]), false);
  assert.equal(DT.mutationsWorthWatching([{ target: box('input') }]), false);
  assert.equal(DT.mutationsWorthWatching([{ target: box('textarea') }]), false);
  assert.equal(DT.mutationsWorthWatching([{ target: box('select') }]), false);
  assert.equal(DT.mutationsWorthWatching([{ target: { closest() { return null; } } }]), true);
  const cfg = readFileSync(join(dir, '../textMapConfig.js'), 'utf8');
  assert.match(cfg, /contenteditable/);
  assert.match(cfg, /input/);
});

test('12. 页面很短或空白：不报错、不发请求', () => {
  assert.deepEqual(DT.planFill({
    oldText: '',
    oldSegs: [],
    newText: '',
    splitFn: splitBy(4),
  }).segs, []);
  assert.deepEqual(DT.planFill({
    oldText: 'AAAABBBB',
    oldSegs: segsOf('AAAABBBB', 4),
    newText: '   ',
    splitFn: splitBy(4),
  }).segs, []);
  const short = planned({
    oldText: '',
    oldSegs: [],
    newText: 'Hi',
    splitFn: splitBy(4),
    viewportStart: 0,
    nScreens: 2,
  });
  assert.deepEqual(short.paint, [0]);
  assert.doesNotThrow(() => DT.planFill({
    newText: '',
  }));
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(content, /!plan\.segs\.length/);
  assert.match(content, /catch \{\s*return false;/);
});

test('13. 从视口起画，不追更远上方', () => {
  const done = [];
  done[5] = [];
  done[6] = [];
  const paint = fillOrder({ segsLength: 12, tokensBySeg: done, inView: [3, 4], below: [5, 6, 7] });
  assert.deepEqual(paint, [3, 4, 7]);
  assert.ok(!paint.some((i) => i < 3));
});

test('14. PDF 动态跟踪：开着滚动补画视口未画段；关掉静态批处理；不挂 DOM 监听', () => {
  const pdf = readFileSync(join(dir, '../pdf/highlight.js'), 'utf8');
  const viewer = readFileSync(join(dir, '../pdf/viewer.html'), 'utf8');
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');

  const done = [[], []];
  assert.deepEqual(fillOrder({ segsLength: 6, tokensBySeg: done, inView: [2, 3] }), [2, 3]);
  // 视口 [0,2) 已画完：画下方一屏内未画段
  assert.deepEqual(fillOrder({ segsLength: 6, tokensBySeg: done, inView: [0, 1], below: [2, 3] }), [2, 3]);

  assert.match(pdf, /function runDynamicFill/);
  assert.match(pdf, /createTrack/);
  assert.match(pdf, /R\.paintEach\(session, track, still/);
  assert.match(pdf, /IH_isDynamicTrack/);
  assert.match(pdf, /CONTINUE_AFTER_SEGMENTS/);
  assert.match(pdf, /new Map\(\)/);
  assert.match(pdf, /useDynamic/);
  assert.match(pdf, /session\.next \+ R\.MAX_SEGMENTS_PER_RUN/);
  assert.match(pdf, /PDF 无动态 DOM：跟网页共用视口轮询，不绑滚动容器/);
  assert.doesNotMatch(pdf, /addEventListener\('scroll'/);
  assert.doesNotMatch(pdf, /scheduleScroll/);
  assert.doesNotMatch(pdf, /MutationObserver\s*\(/);
  assert.doesNotMatch(pdf, /new MutationObserver/);
  assert.doesNotMatch(pdf, /mutationsWorthWatching/);
  assert.doesNotMatch(pdf, /mutationsLookLikeReplace/);
  assert.doesNotMatch(pdf, /pendingReplace/);
  assert.doesNotMatch(pdf, /pushState|replaceState|popstate|onSpaNav/);
  assert.match(viewer, /src="\.\.\/dynamicTrack\.js"/);
  assert.ok(viewer.indexOf('dynamicTrack.js') < viewer.indexOf('page-map.js'));
  assert.match(pageMap, /return dynamicTrack \|\| fromViewport;/);
  assert.doesNotMatch(pageMap, /isPdfViewerPage/);
});

test('15. 段内小改动：前后缀 ≥90% 不发请求；跨改动 token 丢掉；不足则重分析', async () => {
  assert.equal(DT.TWEAK_RATIO, 0.1);
  assert.equal(DT.TWEAK_ABS, 50);
  const defs = readFileSync(join(dir, '../optionDefaults.js'), 'utf8');
  const catalog = readFileSync(join(dir, '../options-catalog.js'), 'utf8');
  assert.doesNotMatch(defs, /tweak|TWEAK_RATIO|ih_tweak/i);
  assert.doesNotMatch(catalog, /tweak|TWEAK_RATIO|ih_tweak/i);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.doesNotMatch(content, /plan\.tweaked/);
  const src = readFileSync(join(dir, '../dynamicTrack.js'), 'utf8');
  assert.doesNotMatch(src, /editDistance|alignOldToNew|bestTweakWindow|TWEAK_DP_MAX_LEN/);

  const prefix = 'PREPRE';
  const body = 'abcdefghij0123456789';
  const suffix = 'SUFSUF';
  assert.equal(body.length, 20);
  const oldText = prefix + body + suffix;
  const oldSegs = [
    { start: 0, end: 6, text: prefix },
    { start: 6, end: 26, text: body },
    { start: 26, end: 32, text: suffix },
  ];
  const oldTokens = [
    [{ offset: [0, 6], p: 0.8, raw: prefix }],
    [
      { offset: [6, 15], p: 0.7, raw: 'abcdefghi' },
      { offset: [15, 16], p: 0.9, raw: 'j' },
      { offset: [16, 26], p: 0.6, raw: '0123456789' },
    ],
    [{ offset: [26, 32], p: 0.8, raw: suffix }],
  ];

  const smallBody = 'abcdefghix0123456789';
  assert.equal(DT.isSmallTweak(body, smallBody), true, '前缀 9 + 后缀 10 = 95%');
  const smallText = prefix + smallBody + suffix;
  const smallRecon = DT.reconcileSegments(oldSegs, oldText, smallText, splitBy(20));
  assert.deepEqual(smallRecon.map((s) => s.text), [prefix, smallBody, suffix]);
  const smallRemap = DT.remapCommitted(oldSegs, oldTokens, smallRecon, oldText, smallText);
  assert.deepEqual(smallRemap.painted, [true, true, true]);
  const kept = smallRemap.tokensBySeg[1];
  assert.ok(kept.every((t) => smallText.slice(t.offset[0], t.offset[1]) === t.raw));
  assert.ok(!kept.some((t) => t.raw === 'j'), '跨改动处的 token 丢掉');
  assert.ok(kept.some((t) => t.raw === 'abcdefghi'), '前缀内 token 不动');
  assert.ok(kept.some((t) => t.raw === '0123456789'), '后缀内 token 平移（此处长度差为 0）');
  assert.ok(!kept.some((t) => t.offset[0] <= 15 && t.offset[1] > 15));
  const prefTok = kept.find((t) => t.raw === 'abcdefghi');
  const sufTok = kept.find((t) => t.raw === '0123456789');
  assert.deepEqual(prefTok.offset, [6, 15]);
  assert.deepEqual(sufTok.offset, [16, 26]);

  const smallPlan = planned({
    oldText,
    oldSegs,
    newText: smallText,
    splitFn: splitBy(20),
    tokensBySeg: oldTokens,
    viewportStart: 0,
    below: [1, 2],
  });
  assert.deepEqual(smallPlan.paint, []);

  const shortRewrite = 'abcdefghijXXXXXXXXXX';
  assert.equal(DT.isSmallTweak(body, shortRewrite), true, '短段改 10 字仍低于 50');

  const longBody = body.repeat(4);
  assert.equal(longBody.length, 80);
  const longOldText = prefix + longBody + suffix;
  const longOldSegs = [
    { start: 0, end: 6, text: prefix },
    { start: 6, end: 86, text: longBody },
    { start: 86, end: 92, text: suffix },
  ];
  const longOldTokens = [
    oldTokens[0],
    [{ offset: [6, 16], p: 0.7, raw: 'abcdefghij' }],
    [{ offset: [86, 92], p: 0.8, raw: suffix }],
  ];
  const bigBody = `${body.slice(0, 10)}${'X'.repeat(70)}`;
  assert.equal(bigBody.length, 80);
  assert.equal(DT.isSmallTweak(longBody, bigBody), false, '实际改动超过 50 字且超过 10%');
  const bigText = prefix + bigBody + suffix;
  const bigRecon = DT.reconcileSegments(longOldSegs, longOldText, bigText, splitBy(200));
  assert.ok(bigRecon.some((s) => s.text === prefix));
  assert.ok(bigRecon.some((s) => s.text === suffix));
  const z = bigRecon.findIndex((s) => s.text === bigBody);
  assert.ok(z >= 0);
  const bigRemap = DT.remapCommitted(longOldSegs, longOldTokens, bigRecon, longOldText, bigText);
  assert.equal(bigRemap.painted[z], false);
  assert.ok(bigRemap.painted[0]);
  assert.ok(bigRemap.painted[bigRemap.painted.length - 1]);

  const bigPlan = planned({
    oldText: longOldText,
    oldSegs: longOldSegs,
    newText: bigText,
    splitFn: splitBy(200),
    tokensBySeg: longOldTokens,
    viewportStart: 0,
    below: [1, 2],
  });
  assert.ok(bigPlan.paint.includes(z));
  assert.ok(!bigPlan.paint.includes(0));
  assert.ok(!bigPlan.paint.includes(bigPlan.segs.length - 1));

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
  const blank = () => ({
    segments: 0, segments_ok: 0, cached: 0, engine: null,
    tokens_in: 0, tokens_skip_level: 0, tokens_skip_empty_range: 0, painted: 0, align_fail_n: 0,
  });

  const smallSession = {
    mapped: { text: smallText, pieces: [{}] },
    segs: smallPlan.segs,
    painted: 0,
    resultCache: new Map(),
    tokensBySeg: smallPlan.tokensBySeg,
  };
  await R.paintEach(smallSession, listTrack(smallPlan.paint), () => true, {}, blank());
  assert.equal(messages.filter((m) => m.type === 'ih-analyze').length, 0, '前后缀 ≥90% 不发分析请求');

  const bigSession = {
    mapped: { text: bigText, pieces: [{}] },
    segs: bigPlan.segs,
    painted: 0,
    resultCache: new Map(),
  };
  await R.paintEach(bigSession, listTrack(bigPlan.paint), () => true, {}, blank());
  assert.ok(
    messages.filter((m) => m.type === 'ih-analyze').some((m) => m.text === bigBody),
    '实际改动超过 50 字且超过 10% 重新分析该段',
  );

  const icons = async (list, inView) => {
    messages.length = 0;
    const session = { mapped: { text: bigText, pieces: [{}] }, segs: bigPlan.segs, painted: 0, resultCache: new Map() };
    await R.paintEach(session, listTrack(list, inView), () => true, {}, blank());
    return messages.filter((m) => m.type === 'ih-action-state').map((m) => (m.state === 'analyzing' ? m.filled : m.state));
  };
  assert.deepEqual(await icons([0, 1, 2], [0, 1]), [0, 4, 'on', 'on'], '两段视口一段四瓦，视口画完即完成，预取不回到分析中');
  assert.deepEqual(await icons([2], []), ['on', 'on'], '只有预取不进分析中');

  const midBody = 'abcdefghiXX0123456789';
  assert.equal(DT.isSmallTweak(body, midBody), true, '前缀 9 + 后缀 10 = 95%');
  const midText = prefix + midBody + suffix;
  const midRecon = DT.reconcileSegments(oldSegs, oldText, midText, splitBy(20));
  const midRemap = DT.remapCommitted(oldSegs, oldTokens, midRecon, oldText, midText);
  const midKept = midRemap.tokensBySeg[1];
  assert.deepEqual(midKept.find((t) => t.raw === 'abcdefghi')?.offset, [6, 15]);
  assert.deepEqual(midKept.find((t) => t.raw === '0123456789')?.offset, [17, 27]);
  assert.equal(midText.slice(17, 27), '0123456789');
  assert.ok(!midKept.some((t) => t.raw === 'j'));
});

test('两处小改：按实际改动量判定，中间未改 token 平移且切字对得上', () => {
  const left = 'L'.repeat(40);
  const mid = 'MIDDLETEXT';
  const right = 'R'.repeat(40);
  const oldBody = `${left}111${mid}222${right}`;
  const newBody = `${left}99${mid}88${right}`;
  assert.equal(DT.isSmallTweak(oldBody, newBody), true);
  const oldSegs = [{ start: 0, end: oldBody.length, text: oldBody }];
  const midStart = left.length + 3;
  const remapped = DT.remapCommitted(
    oldSegs,
    [[{ offset: [midStart, midStart + mid.length], raw: mid }]],
    DT.reconcileSegments(oldSegs, oldBody, newBody, (t) => [{ start: 0, end: t.length, text: t }]),
    oldBody,
    newBody,
  );
  assert.equal(remapped.painted[0], true);
  const tok = remapped.tokensBySeg[0][0];
  assert.equal(tok.raw, mid);
  assert.equal(newBody.slice(tok.offset[0], tok.offset[1]), mid);
});

test('节点被换才重画已画段；没换只把重绘缓冲换成新坐标', () => {
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const sync = content.slice(content.indexOf('async function syncDynamicSession'), content.indexOf('async function runDynamicFill'));
  assert.match(sync, /const dead = session\.mapped\.pieces\.some\(\(p\) => !p\.node\.isConnected\)/);
  assert.match(sync, /if \(dead\) await R\.repaintPainted\(session, mapped, false, still\);/);
  assert.match(sync, /else globalThis\.IH_resetPaintBuf\(mapped, plan\.tokensBySeg\);/);
  assert.doesNotMatch(content, /_lastPieces|wipe/);
});

test('出错就停跟踪：同一视口不反复重试', async () => {
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const pdf = readFileSync(join(dir, '../pdf/highlight.js'), 'utf8');
  assert.match(content, /live: \(\) => !!session && !session\.failed/);
  assert.match(pdf, /live: \(\) => enabled && !!session && !session\.failed/);
  assert.equal(content.match(/haltTrack\(\);/g)?.length, 3, 'runBatch、runDynamicFill、收藏补画的 fail 都停');
  assert.match(pdf, /session\.failed = true;\s*track\.stop\(\);/);

  let live = true;
  let runs = 0;
  const t = fakeTimers();
  const poller = DT.createPoller({
    intervalMs: 500,
    isHidden: () => false,
    isEnabled: () => live,
    isBusy: () => false,
    snapshot: () => ({ mark: 'same', run: true }),
    run: () => { runs += 1; live = false; },
  }, t.api);
  poller.start();
  t.fire();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1);
  t.fire();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1, '标记失败后轮询不再起');
  assert.equal(t.timers.size, 0);
});

test('长空隙不跑整段比对：长度差超上限直接判为大改', () => {
  const seg = 'x'.repeat(500);
  const gap = 'y'.repeat(60000);
  const t0 = Date.now();
  assert.equal(DT.isSmallTweak(seg, gap), false);
  assert.ok(Date.now() - t0 < 5, `应立即返回，实际 ${Date.now() - t0}ms`);
});

test('前后缀继承：带上旧 token，不是空数组', () => {
  const A = 'A'.repeat(60);
  const B = 'B'.repeat(60);
  const X = 'X'.repeat(60);
  const oldText = A + B;
  const newText = A + X + B;
  const plan = DT.planFill({
    oldText,
    oldSegs: segsOf(oldText, 120),
    newText,
    splitFn: splitBy(60),
    tokensBySeg: [[
      { offset: [0, 10], raw: 'A'.repeat(10) },
      { offset: [55, 65], raw: 'AAAAABBBBB' },
      { offset: [110, 120], raw: 'B'.repeat(10) },
    ]],
  });
  const first = plan.tokensBySeg[0];
  const last = plan.tokensBySeg[plan.tokensBySeg.length - 1];
  assert.deepEqual(first.map((t) => t.offset), [[0, 10]]);
  assert.deepEqual(last.map((t) => t.offset), [[170, 180]], '后缀按长度差平移');
  assert.equal(newText.slice(170, 180), 'B'.repeat(10));
});

test('15b. 最后一段小改动且后面追加长文：新增尾巴不并进旧段、不算已画', () => {
  const oldText = 'abcdefghij0123456789';
  const newText = 'abcdefghij012345678X' + 'TAIL'.repeat(50);
  const plan = DT.planFill({
    oldText,
    oldSegs: [{ start: 0, end: 20, text: oldText }],
    newText,
    splitFn: splitBy(20),
    tokensBySeg: [[{ offset: [0, 10], raw: 'abcdefghij' }]],
  });
  assert.equal(plan.segs[0].end, 20);
  assert.ok(plan.segs.length > 1);
  assert.equal(plan.segs[plan.segs.length - 1].end, newText.length);
  assert.ok(plan.tokensBySeg.slice(1).every((bag) => !Array.isArray(bag)));
});

test('15c. token.offset 是码点：含补充平面字符时，平移与段内小改动仍对齐', () => {
  const shiftOld = '😀AAAABBBB';
  const shifted = DT.planFill({
    oldText: shiftOld,
    oldSegs: [
      { start: 0, end: 6, text: '😀AAAA' },
      { start: 6, end: 10, text: 'BBBB' },
    ],
    newText: '😀😀' + shiftOld,
    splitFn: splitBy(100),
    tokensBySeg: [[{ offset: [0, 5] }], [{ offset: [5, 9] }]],
  });
  const b = shifted.segs.findIndex((s) => s.text === 'BBBB');
  assert.deepEqual(shifted.tokensBySeg[b][0].offset, [7, 11]);

  const body = 'abcdefghij0123456789';
  const tweakBody = 'abcdefghix0123456789';
  const tweaked = DT.planFill({
    oldText: '😀😀' + body,
    oldSegs: [
      { start: 0, end: 4, text: '😀😀' },
      { start: 4, end: 24, text: body },
    ],
    newText: '😀😀' + tweakBody,
    splitFn: splitBy(20),
    tokensBySeg: [
      [{ offset: [0, 2] }],
      [{ offset: [2, 11], raw: 'abcdefghi' }, { offset: [12, 22], raw: '0123456789' }],
    ],
  });
  assert.deepEqual(tweaked.tokensBySeg[1].map((t) => t.offset), [[2, 11], [12, 22]]);
});

test('16. 视口贴边必选中；轮询停稳后分析未画段', async () => {
  const afterScroll = fillOrder({ segsLength: 8, tokensBySeg: [[], [], [], []], inView: range(2, 6) });
  assert.ok(afterScroll.includes(4));
  assert.ok(afterScroll.includes(5));
  assert.deepEqual(afterScroll, [4, 5]);

  const plan = planned({
    oldText: 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
    oldSegs: segsOf('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', 4),
    newText: 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
    splitFn: splitBy(4),
    tokensBySeg: [[{}], [{}], [{}], [{}]],
    viewportStart: 2,
    inViewEnd: 6,
  });
  assert.deepEqual(plan.paint, [4, 5]);

  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const pdf = readFileSync(join(dir, '../pdf/highlight.js'), 'utf8');
  assert.match(content, /createTrack/);
  assert.match(pdf, /createTrack/);
  assert.match(content, /R\.paintEach\(session, track, still/);
  assert.doesNotMatch(content, /viewportStart:\s*0/);
  assert.doesNotMatch(content, /bindTrackScrollRoot/);
  assert.doesNotMatch(content, /scheduleScroll/);
  assert.doesNotMatch(pdf, /scheduleScroll/);
});

test('17. 轮询：视口持续变化不发请求；停稳后发一次；已画 / hidden 不跑', async () => {
  const near = { segsLength: 4, tokensBySeg: [[], []], inView: [2], below: [3] };
  const needsFill = (opts) => fillOrder(opts).length > 0;
  assert.equal(needsFill(near), true);
  assert.equal(needsFill({ ...near, tokensBySeg: [[], [], [], []] }), false);

  let mark = 0;
  let runs = 0;
  const t = fakeTimers();
  const poller = DT.createPoller({
    intervalMs: 500,
    isHidden: () => false,
    isEnabled: () => true,
    isBusy: () => false,
    snapshot: () => ({ mark, run: needsFill(near) }),
    run: () => { runs += 1; },
  }, t.api);
  poller.start();
  mark = 1;
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0, '第一次只记位置');
  mark = 2;
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0, '视口还在动不发请求');
  mark = 3;
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0);
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1, '连续两次相同才发一次');

  let idleRuns = 0;
  const tIdle = fakeTimers();
  const idle = DT.createPoller({
    intervalMs: 500,
    isHidden: () => false,
    isEnabled: () => true,
    isBusy: () => false,
    snapshot: () => ({
      mark: '0:0:1',
      run: needsFill({ segsLength: 4, tokensBySeg: [[], [], [], []], inView: [0], below: [1] }),
    }),
    run: () => { idleRuns += 1; },
  }, tIdle.api);
  idle.start();
  tIdle.fire();
  await Promise.resolve();
  assert.equal(idleRuns, 0, '第一次只记位置');
  tIdle.fire();
  await Promise.resolve();
  assert.equal(idleRuns, 0, '附近都已画且不 dirty 不跑');

  let hiddenRuns = 0;
  const tHid = fakeTimers();
  const hid = DT.createPoller({
    intervalMs: 500,
    isHidden: () => true,
    isEnabled: () => true,
    isBusy: () => false,
    snapshot: () => ({ mark: '0:0:1', run: true }),
    run: () => { hiddenRuns += 1; },
  }, tHid.api);
  hid.start();
  tHid.fire();
  tHid.fire();
  await Promise.resolve();
  assert.equal(hiddenRuns, 0, 'hidden 不轮询');

  const src = readFileSync(join(dir, '../dynamicTrack.js'), 'utf8');
  assert.match(src, /lastMark != null && lastMark === mark/);
});

test('20. 视口指纹：滑动中不分析；停稳后有未画就跑，同一视口还能再跑', async () => {
  let mark = '1';
  let runs = 0;
  const t = fakeTimers();
  const poller = DT.createPoller({
    intervalMs: 500,
    isHidden: () => false,
    isEnabled: () => true,
    isBusy: () => false,
    snapshot: () => ({ mark, run: true }),
    run: () => { runs += 1; },
  }, t.api);
  poller.start();
  t.fire();
  mark = '2';
  t.fire();
  mark = '3';
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0, '视口一直在变不分析');
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1, '停稳后分析一次');
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 2, '同一视口还有未画段再跑');

  const dt = readFileSync(join(dir, '../dynamicTrack.js'), 'utf8');
  assert.match(dt, /snapshot: viewSnap/);
  assert.doesNotMatch(dt, /scrollend/);
  assert.doesNotMatch(dt, /lastCheckedMark/);
  assert.doesNotMatch(dt, /host\.scrollTop/);
});

test('18. 段内小改动是 O(n) 前后缀，不再走整段 DP', () => {
  const n = 20000;
  const a = 'a'.repeat(n);
  const b = 'b'.repeat(n);
  const t0 = Date.now();
  assert.equal(DT.isSmallTweak(a, b), false);
  assert.ok(Date.now() - t0 < 50, `大输入应很快，实际 ${Date.now() - t0}ms`);
  assert.equal(DT.isSmallTweak(a, `${a}zzz`), true);

  const src = readFileSync(join(dir, '../dynamicTrack.js'), 'utf8');
  assert.doesNotMatch(src, /editDistance|alignOldToNew|bestTweakWindow|TWEAK_DP_MAX_LEN|tweakDpTooHeavy/);
  assert.match(src, /function commonAffix/);
});

test('19. 视口和选段在调用方只做一次', () => {
  const oldText = 'AAAABBBBCCCCDDDDEEEEFFFF';
  const oldSegs = segsOf(oldText, 4);
  const plan = DT.planFill({
    oldText,
    oldSegs,
    newText: oldText,
    splitFn: splitBy(4),
    tokensBySeg: [[{}], [{}], [{}], [{}]],
  });
  assert.equal('paint' in plan, false);
  assert.equal('action' in plan, false);
  assert.equal('viewportStart' in plan, false);
  const paint = fillOrder({ segsLength: plan.segs.length, tokensBySeg: plan.tokensBySeg, inView: [4, 5] });
  assert.deepEqual(paint, [4, 5]);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(content, /R\.paintEach\(session, track, still/);
  assert.doesNotMatch(content, /analyzedCount/);
});

test('21. 计数只增不减：旧段被丢后仍能到 32 问继续', () => {
  let analyzed = 30;
  const budget = 32;
  const oldSegs = segsOf('A'.repeat(60), 60);
  const plan = planned({
    oldText: 'A'.repeat(60),
    oldSegs,
    newText: 'B'.repeat(180),
    splitFn: splitBy(60),
    tokensBySeg: oldSegs.map(() => [{}]),
    viewportStart: 0,
    inViewEnd: 2,
  });
  assert.ok(plan.segs.length > 0);
  assert.ok(plan.painted.filter(Boolean).length < 5, '旧段丢掉后已画数缩水');
  assert.ok(plan.paint.length > 0);
  assert.equal(DT.shouldAskContinue(analyzed, budget), false);
  analyzed += plan.paint.length;
  assert.ok(analyzed >= 32);
  assert.equal(DT.shouldAskContinue(analyzed, budget), true);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const run = readFileSync(join(dir, '../analyzeRun.js'), 'utf8');
  assert.match(content, /session\.analyzed/);
  assert.doesNotMatch(content, /session\.analyzed = 0/);
  assert.doesNotMatch(content, /countPainted\(session\)/);
  assert.match(run, /session\.analyzed = \(Number\(session\.analyzed\) \|\| 0\) \+ 1/);
  assert.match(run, /resultCache\?\.get\(requestText\)/);
});

test('23. 持续小 DOM 变动且无可画段时不切图标、不发请求', async () => {
  let runs = 0;
  let mark = 'still';
  const t = fakeTimers();
  const poller = DT.createPoller({
    intervalMs: 500,
    isHidden: () => false,
    isEnabled: () => true,
    isBusy: () => false,
    snapshot: () => ({ mark, run: false }),
    run: () => { runs += 1; },
  }, t.api);
  poller.start();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0, '第一次只记位置');
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0, '无可画段且不 dirty 不跑');
  poller.markDirty();
  poller.markDirty();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1, 'dirty 停稳后对账一次');
  t.fire();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1, '标记没变且没有 dirty 不再检查');

  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const fill = content.slice(content.indexOf('async function runDynamicFill'));
  assert.doesNotMatch(fill.slice(0, fill.indexOf('function retryAnalyze')), /reportActionState\('analyzing'\)/, '分析中图标交给 paintEach 按视口定');
  assert.match(content, /track\.markDirty\(\)/);
  assert.match(content, /IH_dropSegYCache/);
  assert.doesNotMatch(content, /track\.schedule/);
  const dt = readFileSync(join(dir, '../dynamicTrack.js'), 'utf8');
  assert.doesNotMatch(dt, /lastCheckedMark/);
  assert.doesNotMatch(dt, /\bschedule\(/);
  assert.doesNotMatch(dt, /flush\(true\)/);
});

test('24. 信息流顶部节点回收导致下标变小时仍按视口补画', () => {
  assert.deepEqual(fillOrder({ segsLength: 8, inView: [0, 1], below: [2] }), [0, 1, 2]);
  const done = [];
  done[2] = [];
  assert.deepEqual(fillOrder({ segsLength: 20, tokensBySeg: done, inView: [2, 3], below: [4, 5] }), [3, 4, 5]);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const pdf = readFileSync(join(dir, '../pdf/highlight.js'), 'utf8');
  assert.doesNotMatch(content, /direction:\s*'up'|lastViewStart/);
  assert.doesNotMatch(pdf, /direction:\s*'up'|lastViewStart/);
  assert.doesNotMatch(readFileSync(join(dir, '../dynamicTrack.js'), 'utf8'), /direction === 'up'/);
});

test('25. 逐段现挑：每画完一段重看视口，滚走后下一段先画新视口', () => {
  let view = { inView: [2, 3], below: [4, 5] };
  const prev = globalThis.IH_viewportSegments;
  globalThis.IH_viewportSegments = () => view;
  try {
    const track = DT.createTrack({ useDynamic: () => true, live: () => false });
    const session = { mapped: {}, segs: Array(40).fill({}), tokensBySeg: [] };
    const order = [];
    for (let i = track.nextPaint(session); i >= 0; i = track.nextPaint(session)) {
      order.push(i);
      session.tokensBySeg[i] = [];
      if (order.length === 1) view = { inView: [20, 21], below: [22] };
    }
    assert.deepEqual(order, [2, 20, 21, 22]);
  } finally {
    globalThis.IH_viewportSegments = prev;
  }
  const ar = readFileSync(join(dir, '../analyzeRun.js'), 'utf8');
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const pdf = readFileSync(join(dir, '../pdf/highlight.js'), 'utf8');
  assert.match(ar, /async function paintEach\(session, track, still, opts, report\)/);
  for (const src of [content, pdf]) {
    assert.match(src, /R\.paintEach\(session, track, still/);
    assert.doesNotMatch(src, /shouldStartSeg|queueCoversWant|pickUnpainted/);
  }
});

test('26. 现文变长：已画旧段保留，新正文变成未画；开跑即跟踪', () => {
  const oldText = '首页资讯快讯行情日历';
  const newText = `${oldText}钯金年内大跌之际供应风险正被忽视`;
  const oldSegs = segsOf(oldText, 8);
  const plan = DT.planFill({
    oldText,
    oldSegs,
    newText,
    splitFn: splitBy(8),
    tokensBySeg: oldSegs.map(() => [{}]),
  });
  assert.ok(plan.segs.length > oldSegs.length);
  const painted = (plan.tokensBySeg || []).filter(Array.isArray).length;
  assert.ok(painted > 0 && painted < plan.segs.length);

  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const open = content.slice(content.indexOf('async function openSession'), content.indexOf('async function paintAfterFirstSegmentCheck'));
  const paint = content.slice(content.indexOf('async function paintViewportRound'), content.indexOf('async function runBatch'));
  const fill = content.slice(content.indexOf('async function runDynamicFill'), content.indexOf('function retryAnalyze'));
  assert.match(open, /if \(useDynamic\(\)\) track\.start\(\)/);
  assert.doesNotMatch(open, /if \(extractStable\) \{[\s\S]*track\.start/);
  assert.match(paint, /onCaughtUp/);
  assert.match(paint, /onCaughtUp: \(\) => syncDynamicSession\(still\)/);
  assert.doesNotMatch(paint, /holdIcon/);
  assert.doesNotMatch(paint, /track\.markDirty\(\)/);
  assert.match(fill, /onCaughtUp/);
  assert.doesNotMatch(fill, /track\.markDirty\(\)/);
  assert.match(content, /live: \(\) => !!session/);
  assert.match(content, /mapped\.text === session\.mapped\.text/);
  assert.match(content, /track\.markDirty\(\)/);
  assert.doesNotMatch(content, /if \(!busy && !continueArmed\) track\.markDirty\(\)/);
  const ar = readFileSync(join(dir, '../analyzeRun.js'), 'utf8');
  assert.match(ar, /onCaughtUp/);
  assert.doesNotMatch(ar, /holdIcon/);
});

test('27. 中间插入新文：整段对不上时，前后重合段不重分析', () => {
  const A = 'A'.repeat(60);
  const B = 'B'.repeat(60);
  const X = 'X'.repeat(60);
  const oldText = A + B;
  const newText = A + X + B;
  const plan = DT.planFill({
    oldText,
    oldSegs: segsOf(oldText, 120),
    newText,
    splitFn: splitBy(60),
    tokensBySeg: [[{}]],
  });
  assert.ok(Array.isArray(plan.tokensBySeg[0]), '前缀不重分析');
  assert.ok(Array.isArray(plan.tokensBySeg[plan.tokensBySeg.length - 1]), '后缀不重分析');
  const mid = plan.segs.findIndex((s) => s.text === X);
  assert.ok(mid >= 0);
  assert.equal(Array.isArray(plan.tokensBySeg[mid]), false);
});

test('29. 往下画完再滑回：停稳后视口内未画段会开跑', async () => {
  const oldText = 'AAAABBBBCCCC';
  const plan = DT.planFill({
    oldText,
    oldSegs: segsOf(oldText, 4),
    newText: `${oldText}DDDD`,
    splitFn: splitBy(4),
    tokensBySeg: [undefined, undefined, [{}]],
  });
  plan.tokensBySeg[3] = [{}];
  assert.equal(Array.isArray(plan.tokensBySeg[0]), false);
  assert.equal(Array.isArray(plan.tokensBySeg[1]), false);
  assert.ok(Array.isArray(plan.tokensBySeg[2]) && Array.isArray(plan.tokensBySeg[3]));
  const todo = (i) => !Array.isArray(plan.tokensBySeg[i]);
  let inView = [2, 3];
  let below = [];
  let runs = 0;
  const t = fakeTimers();
  const poller = DT.createPoller({
    intervalMs: 200,
    isHidden: () => false,
    isEnabled: () => true,
    isBusy: () => false,
    snapshot: () => ({
      mark: `${inView.join(',')}|${below.join(',')}|${plan.segs.length}`,
      run: inView.some(todo) || below.some(todo),
    }),
    run: () => { runs += 1; },
  }, t.api);
  poller.start();
  t.fire();
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0, '视口里都已画不跑');

  inView = [0, 1];
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 0, '刚滑回未画段，先停稳');
  t.fire();
  await Promise.resolve();
  assert.equal(runs, 1, '停稳后对视口内未画段开跑');
  assert.deepEqual(
    fillOrder({ segsLength: plan.segs.length, tokensBySeg: plan.tokensBySeg, inView, below }),
    [0, 1],
  );

  const dt = readFileSync(join(dir, '../dynamicTrack.js'), 'utf8');
  assert.match(dt, /Math\.round\(top\)/);
  assert.match(dt, /session\.tokensBySeg/);
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  assert.match(pageMap, /Array\.isArray\(tokensBySeg\?\.\[i\]\) \? segYCache : new Map\(\)/);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(content, /track\.viewLeft\(session\) <= 0/);
  assert.doesNotMatch(content, /if \(!busy && !continueArmed\) track\.markDirty\(\)/);
});

test('28. 下方追加：滑过没画的上方面前缀不标成已画，滑回视口还能补', () => {
  const oldText = 'AAAABBBBCCCC';
  const oldSegs = segsOf(oldText, 4);
  const plan = DT.planFill({
    oldText,
    oldSegs,
    newText: `${oldText}DDDD`,
    splitFn: splitBy(4),
    tokensBySeg: [undefined, undefined, [{}]],
  });
  assert.equal(plan.segs.map((s) => s.text).join(','), 'AAAA,BBBB,CCCC,DDDD');
  assert.equal(Array.isArray(plan.tokensBySeg[0]), false, '未画的 AAAA 不能当成已画');
  assert.equal(Array.isArray(plan.tokensBySeg[1]), false, '未画的 BBBB 不能当成已画');
  assert.ok(Array.isArray(plan.tokensBySeg[2]), '已画的 CCCC 仍保留');
  assert.equal(Array.isArray(plan.tokensBySeg[3]), false);
  assert.deepEqual(
    fillOrder({ segsLength: plan.segs.length, tokensBySeg: plan.tokensBySeg, inView: [0, 1], below: [] }),
    [0, 1],
    '滑回未画段应再分析',
  );
});
