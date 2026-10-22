/**
 * Info Highlight — webpage entry after toolbar inject.
 * 点击：按段流式分析并画热力图。再点清除。
 * 进度图：开跑亮空框，段回了加线；不跟滚、不跳最新段。
 * 注入可在加载中；抽正文和分析等 complete。
 *
 * 设计：`complete` 只表示可以开始抽，不表示正文已在 DOM。
 * 动态跟踪开着：马上跑，有会话就盯 DOM。手头空了、变动、切回可见后停稳再抽现文，晚到正文由跟踪补画。
 * 关掉：自动分析第一段结束、整轮 1 秒内再对拍，必要时整份重来；此后只丢掉映不回的高亮。
 */
(() => {
  // 注入只挂 API，开跑由 SW 显式调 toggle / start
  try {
    if (typeof window.__IH_DEMO__?.isLive === 'function' && window.__IH_DEMO__.isLive()) return;
  } catch {
    /* 扩展已重载：旧 API 作废 */
  }

  if (typeof globalThis.IH_extractPage !== 'function') {
    throw new Error('IH_extractPage missing — inject page-map.js before content.js');
  }
  if (!globalThis.IH_prefsReady) {
    throw new Error('IH_prefsReady missing — inject page-map.js first');
  }
  if (typeof globalThis.IH_watchHighlightLive !== 'function') {
    throw new Error('IH_watchHighlightLive missing — inject page-map.js first');
  }
  if (!globalThis.IH_tokenTip) {
    throw new Error('IH_tokenTip missing — inject tokenTip.js before content.js');
  }
  if (!globalThis.IH_analyzeRun) {
    throw new Error('IH_analyzeRun missing — inject analyzeRun.js before content.js');
  }
  if (!globalThis.IH_dynamicTrack) {
    throw new Error('IH_dynamicTrack missing — inject dynamicTrack.js before content.js');
  }
  if (!globalThis.IH_autoNudge) {
    throw new Error('IH_autoNudge missing — inject auto-nudge.js before content.js');
  }
  if (!globalThis.IH_autoSites) {
    throw new Error('IH_autoSites missing — inject auto-sites.js before content.js');
  }
  if (!globalThis.IH_anonymousSiteDomain) {
    throw new Error('IH_anonymousSiteDomain missing — inject anonymousSiteDomain.js before content.js');
  }

  const R = globalThis.IH_analyzeRun;
  const DT = globalThis.IH_dynamicTrack;
  /** 关掉动态跟踪时：自动分析开跑后再对拍这一窗 */
  const SETTLE_MS = 1000;
  let gen = 0;
  let busy = false;
  let active = false;
  /** 本轮是怎么开跑的。继续下一段不再改它。auto | icon | menu | rerun | other */
  let trigger = '';
  /** 这份抽字是否已过晚到窗口（手点即稳定；动态跟踪开着画完即稳定；关掉要等对拍窗） */
  let extractStable = false;
  /** 动态跟踪停在「继续」：未点之前不再自动补 */
  let continueArmed = false;
  /** 一次注入（一个页面）只上报一次成功；失败和取消每次都报。 */
  const usageOnce = { okSent: false };
  /** @type {{ mapped: { text: string, pieces: unknown[] }, segs: { start: number, end: number, text: string }[], from: number, next: number, painted: number, skipCache?: boolean, cloudModel?: string } | null} */
  let session = null;
  /** @type {MutationObserver | null} */
  let trackObs = null;

  /** 每次新开会话时读一次动态跟踪开关。中途改设置，下一次重新分析才生效。 */
  let dynamic = false;
  function useDynamic() {
    return dynamic;
  }

  const track = DT.createTrack({
    live: () => !!session && !session.failed,
    useDynamic,
    isBusy: () => busy || continueArmed,
    session: () => session,
    run: () => runDynamicFill(),
    onStart() {
      if (typeof MutationObserver !== 'function' || !document.documentElement) return;
      trackObs = new MutationObserver((records) => {
        if (!DT.mutationsWorthWatching(records)) return;
        globalThis.IH_pruneDetachedHighlights?.();
        globalThis.IH_dropSegYCache?.();
        track.markDirty();
      });
      trackObs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    },
    onStop() {
      trackObs?.disconnect();
      trackObs = null;
    },
  });

  function clearAll() {
    track.stop();
    continueArmed = false;
    busy = false;
    extractStable = false;
    session = null;
    globalThis.IH_clearHighlights();
    globalThis.IH_clearProgress();
    globalThis.IH_beginAnalyzeRound?.();
    globalThis.IH_tokenTip.clear();
    active = false;
    R.reportActionState('off');
  }

  /** 出错就停跟踪，免得同一视口反复重试。重试 / 重新分析会开新会话。 */
  function haltTrack() {
    if (session) session.failed = true;
    track.stop();
  }

  function markExtractStable() {
    extractStable = true;
    if (useDynamic()) track.start();
    else globalThis.IH_watchHighlightLive();
  }

  function whenComplete() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  }

  async function pauseForContinue() {
    continueArmed = true;
    await globalThis.IH_setProgressSearching(false);
    await globalThis.IH_showPaused(continuePaused);
    active = true;
  }

  function continuePaused() {
    if (busy || !session) return;
    continueArmed = false;
    session.continueBudget = DT.nextContinueBudget(session.analyzed);
    session.armFirstAnalyze = true;
    if (useDynamic()) {
      void runDynamicFill();
      return;
    }
    void runBatch(gen += 1, false, session.skipCache, session.cloudModel);
  }

  function pageText() {
    try {
      return globalThis.IH_extractPage().text;
    } catch {
      return '';
    }
  }

  async function openSession(skip, cloudModel) {
    const pinned = cloudModel || session?.cloudModel || '';
    session = await R.beginSession(globalThis.IH_extractPage(), 'No article text');
    session.skipCache = skip;
    if (pinned) session.cloudModel = pinned;
    session.resultCache = new Map();
    session.continueBudget = DT.CONTINUE_AFTER_SEGMENTS;
    globalThis.IH_tokenTip.bind(session.mapped);
    if (useDynamic()) track.start();
    else if (extractStable) globalThis.IH_watchHighlightLive();
  }

  /** 第一段画完立刻再抽：和开跑那份不同，视为正文刚进 DOM，丢掉骨架高亮重来。 */
  async function paintAfterFirstSegmentCheck(paintTo, cap, still) {
    let lastAlignErr = await paintTo(session.next + 1);
    if (!still()) return lastAlignErr;
    if (pageText() !== session.mapped.text) {
      await openSession(session.skipCache);
      return paintTo(Math.min(session.next + R.MAX_SEGMENTS_PER_RUN, session.segs.length));
    }
    if (session.next < cap) return paintTo(cap);
    return lastAlignErr;
  }

  async function paintViewportRound(report, still, skip, pinned, settle) {
    if (!session) await openSession(skip, pinned);
    const opts = { onTokens: (tokens) => globalThis.IH_tokenTip.add(tokens), skipCache: skip };
    const paintTo = async (to) => {
      const err = await R.paintRange(session, session.next, to, still, opts, report);
      if (still()) session.next = to;
      return err;
    };
    if (useDynamic()) {
      const lastAlignErr = await R.paintEach(session, track, still, {
        ...opts,
        onCaughtUp: () => syncDynamicSession(still),
      }, report);
      if (!still()) return;
      await R.afterPaint(session, lastAlignErr, 'No tokens mapped onto the page', () => {}, report, true);
      active = true;
      if (track.needsContinue(session)) await pauseForContinue();
      return;
    }
    const cap = Math.min(session.next + R.MAX_SEGMENTS_PER_RUN, session.segs.length);
    const lastAlignErr = (settle && !extractStable && session.next === session.from && cap > session.next)
      ? await paintAfterFirstSegmentCheck(paintTo, cap, still)
      : await paintTo(cap);
    if (!still()) return;
    await R.afterPaint(session, lastAlignErr, 'No tokens mapped onto the page', () => {
      return globalThis.IH_showPaused(continuePaused);
    }, report);
    active = true;
  }

  async function runBatch(myGen, settle, skipCache, cloudModel) {
    const still = () => myGen === gen;
    const skip = !!skipCache;
    const pinned = typeof cloudModel === 'string' ? cloudModel : '';
    busy = true;
    R.reportActionState('analyzing');
    // 手点刚开跑、人还在等。继续下一段和自动分析都不计。
    if (!settle && !session) void globalThis.IH_autoNudge.offer(location.href);
    await whenComplete();
    await globalThis.IH_prefsReady;
    if (!still()) return;
    if (!session) dynamic = !!globalThis.IH_isDynamicTrack() && !globalThis.IH_OPTIONS_PAGE;
    const t0 = Date.now();
    let heldErr = null;

    const onFailed = ({ report, err }) => {
      globalThis.IH_feedbackContext?.stash({ session, report, err, surface: 'web' });
    };
    const fail = (err) => {
      haltTrack();
      // 报错保留已经画好的高亮。用户点停止 / 重试 / 强制重跑才清。
      if (session?.painted > 0) active = true;
      else R.reportActionState('off');
      return globalThis.IH_showError(err);
    };
    const idle = () => {
      busy = false;
      if (!still() || !active) return;
      if (!useDynamic() || track.viewLeft(session) <= 0) R.reportActionState('on');
    };
    // 一次抽出记一笔。自动分析先记下，对拍采用哪一轮再发。续跑没抽新正文则不报。
    let domainReport = null;
    let extracted = false;
    const sendDomain = (report) => {
      globalThis.IH_anonymousSiteDomain.fromAnalysis({
        href: location.href,
        doc: document,
        session,
        report,
      });
    };
    const reportAnonymousSiteDomain = (report) => {
      if (!extracted) return;
      if (settle) {
        domainReport = report;
        return;
      }
      sendDomain(report);
    };
    const flushDomain = () => {
      const report = domainReport;
      if (!report) return;
      domainReport = null;
      sendDomain(report);
    };
    // settle：idle 延到对拍窗结束，图标一直显示分析中
    const hooks = settle
      ? { fail: (err) => { heldErr = err; }, idle() {}, onFailed, trigger, reportAnonymousSiteDomain, usageOnce }
      : { fail, idle, onFailed, trigger, reportAnonymousSiteDomain, usageOnce };
    const job = async (report) => {
      if (!settle) extractStable = true;
      if (!session) extracted = true;
      await paintViewportRound(report, still, skip, pinned, settle);
      if (session?.painted > 0) globalThis.IH_maybeShowPaintNotices();
    };

    await R.runJob(still, hooks, job);
    if (still() && !settle) {
      markExtractStable();
      return;
    }
    if (still() && settle && !useDynamic()) {
      const left = SETTLE_MS - (Date.now() - t0);
      if (left > 0) {
        await new Promise((r) => setTimeout(r, left));
        if (still() && pageText() !== (session?.mapped?.text || '')) {
          heldErr = null;
          domainReport = null;
          extracted = false;
          session = null;
          active = false;
          await R.runJob(still, hooks, job);
        }
      }
    }
    flushDomain();
    if (!still()) return;
    if (heldErr) {
      await fail(heldErr);
      idle();
      return;
    }
    markExtractStable();
    idle();
  }

  /** 正文坐标变了：悬浮提示和进度条按已画段的 token 重建。 */
  async function rebindViews() {
    const { mapped, segs, tokensBySeg } = session;
    globalThis.IH_tokenTip.bind(mapped);
    await globalThis.IH_bindProgress(mapped, segs);
    for (let i = 0; i < segs.length; i++) {
      if (!Array.isArray(tokensBySeg[i])) continue;
      globalThis.IH_tokenTip.add(tokensBySeg[i]);
      globalThis.IH_appendProgress(tokensBySeg[i], segs[i]);
    }
  }

  /**
   * 重新抽字、旧段重映射。返回是否还有要画的段。
   * 有节点被换掉才重画已画段；否则旧 range 仍在原节点上，只把重绘缓冲换成新坐标。
   */
  async function syncDynamicSession(still) {
    let mapped;
    try {
      mapped = globalThis.IH_extractPage();
    } catch {
      return false;
    }
    if (!still()) return false;
    const dead = session.mapped.pieces.some((p) => !p.node.isConnected);
    if (mapped.text === session.mapped.text && !dead) {
      return track.nextPaint(session) >= 0;
    }
    const plan = DT.planFill({
      oldText: session.mapped.text,
      oldSegs: session.segs,
      newText: mapped.text,
      splitFn: (text) => globalThis.IH_splitSegments(text),
      tokensBySeg: session.tokensBySeg,
    });
    if (!plan.segs.length) return false;

    session.mapped = mapped;
    session.segs = plan.segs;
    session.tokensBySeg = plan.tokensBySeg;
    if (dead) await R.repaintPainted(session, mapped, false, still);
    else globalThis.IH_resetPaintBuf(mapped, plan.tokensBySeg);
    if (!still()) return false;
    await rebindViews();
    return track.nextPaint(session) >= 0;
  }

  async function runDynamicFill() {
    if (!active || !useDynamic() || busy || document.hidden || continueArmed || !session) return;
    const myGen = gen;
    const still = () => myGen === gen && active;
    busy = true;
    const fail = (err) => {
      haltTrack();
      return globalThis.IH_showError(err?.message || err);
    };
    let hasWork;
    try {
      hasWork = await syncDynamicSession(still);
    } catch (err) {
      busy = false;
      if (still()) await fail(err);
      return;
    }
    if (!hasWork || !still()) {
      busy = false;
      return;
    }
    if (track.needsContinue(session)) {
      busy = false;
      await pauseForContinue();
      return;
    }
    await R.runJob(still, {
      fail,
      idle() {
        busy = false;
        if (active && track.viewLeft(session) <= 0) R.reportActionState('on');
      },
      onFailed: ({ report, err }) => {
        globalThis.IH_feedbackContext?.stash({ session, report, err, surface: 'web' });
      },
      trigger: trigger || 'dynamic',
      usageOnce,
    }, async (report) => {
      const opts = { onTokens: (tokens) => globalThis.IH_tokenTip.add(tokens), skipCache: session.skipCache };
      await R.paintEach(session, track, still, {
        ...opts,
        onCaughtUp: () => syncDynamicSession(still),
      }, report);
      if (!still()) return;
      await globalThis.IH_setProgressSearching(false);
      if (track.needsContinue(session)) await pauseForContinue();
    });
  }

  function retryAnalyze() {
    gen += 1;
    busy = false;
    clearAll();
    trigger = 'rerun';
    void runBatch(gen, false, false);
  }

  function setEnabled(on, why) {
    if (on) {
      if (busy || active) return;
      trigger = why || 'other';
      void runBatch(gen += 1, false, false);
      return;
    }
    if (busy || active) {
      gen += 1;
      busy = false;
      clearAll();
    }
  }

  function toggle(why) {
    setEnabled(!(busy || active), why);
  }

  function force(cloudModel, why) {
    if (busy) {
      alert(R.FORCE_BUSY_MSG);
      return;
    }
    if (active) clearAll();
    trigger = why || 'rerun';
    const pinned = typeof cloudModel === 'string' ? cloudModel : '';
    void runBatch(gen += 1, false, true, pinned);
  }

  function isLive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  /** 收藏：从第 0 段 paintRange 到上限。不跟视口、不等「继续」；已画段走会话缓存。 */
  async function fillLibrarySegments() {
    const to = Math.min(session.segs.length, R.LIBRARY_MAX_SEGMENTS);
    const myGen = gen;
    const deadline = Date.now() + 180_000;
    let timedOut = false;
    const still = () => {
      if (Date.now() >= deadline) timedOut = true;
      return myGen === gen && !!session && !timedOut;
    };
    busy = true;
    continueArmed = false;
    globalThis.IH_clearError();
    R.reportActionState('analyzing');
    await R.runJob(still, {
      fail: async (err) => {
        haltTrack();
        if (session?.painted > 0) active = true;
        throw err;
      },
      idle() {
        busy = false;
        if (myGen !== gen || !session || !(session.painted > 0)) return;
        active = true;
        markExtractStable();
        R.reportActionState('on');
      },
      onFailed: ({ report, err }) => {
        globalThis.IH_feedbackContext?.stash({ session, report, err, surface: 'web' });
      },
      trigger: 'library',
      usageOnce,
    }, async (report) => {
      await R.paintRange(session, 0, to, still, {
        onTokens: (tokens) => globalThis.IH_tokenTip.add(tokens),
        onSegment(i, total) {
          window.__IH_LIBRARY_UI?.({
            key: 'analyze',
            label: globalThis.IH_i18n.tr('Analyze'),
            detail: `${i + 1} / ${total}`,
            pending: false,
          });
        },
        skipCache: false,
      }, report);
      session.next = Math.max(Number(session.next) || 0, to);
      await globalThis.IH_setProgressSearching(false);
    });
    if (timedOut) throw new Error('Analyze timed out');
    if (myGen !== gen || !session) throw new Error('Analyze failed');
  }

  /** 收藏：有会话就从头再走一遍（缓存命中已画段）；没有则开一轮走到上限。 */
  async function ensureForLibrary() {
    await globalThis.IH_prefsReady;
    if (session?.failed && !(session.painted > 0)) clearAll();
    const waitUntil = Date.now() + 180_000;
    while (busy) {
      if (Date.now() > waitUntil) throw new Error('Analyze timed out');
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!session) {
      await whenComplete();
      await openSession(false);
    }
    if (!session || (session.failed && !(session.painted > 0))) {
      throw new Error('Analyze failed');
    }
    await fillLibrarySegments();
    if (!(session.painted > 0)) {
      throw new Error('No tokens mapped onto the page');
    }
    return true;
  }

  /** 自动分析用：开跑返回 true；已有一轮在跑返回 'busy'、已画好返回 'painted'（都不动它）。 */
  function start() {
    if (busy) return 'busy';
    if (active) return 'painted';
    trigger = 'auto';
    void runBatch(gen += 1, true, false);
    return true;
  }

  // SYNC: background.js → pageCsPeek 的 data-ih-cs
  document.documentElement.setAttribute('data-ih-cs', '');
  globalThis.IH_retryAnalyze = retryAnalyze;
  function toggleExtractPreview() {
    return globalThis.IH_toggleExtractPreview();
  }

  function isExtractPreviewOn() {
    return !!globalThis.IH_isExtractPreviewOn?.();
  }

  window.__IH_DEMO__ = {
    toggle,
    start,
    force,
    isLive,
    setEnabled,
    ensureForLibrary,
    isAnalyzeBusy: () => busy,
    toggleExtractPreview,
    isExtractPreviewOn,
  };
})();
