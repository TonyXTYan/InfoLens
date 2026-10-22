/**
 * PDF 信息量标记：viewer 提供阅读序全文和 textLayer 节点。
 * token 走 overlay 红线（色块会盖住 canvas 字形；highlightStyle.resolvePaintStyle 把 pdf 上回退成下划线）。
 * 分批分析见 analyzeRun.js。缩放后 textLayer 重建：IL_createPdfZoomIdle 停稳再贴已提交 token。
 */
(() => {
  if (!globalThis.IH_analyzeRun) {
    throw new Error('IH_analyzeRun missing — inject analyzeRun.js before highlight.js');
  }
  if (!globalThis.IH_anonymousSiteDomain) {
    throw new Error('IH_anonymousSiteDomain missing — inject anonymousSiteDomain.js before highlight.js');
  }
  if (!globalThis.IH_prefsReady) {
    throw new Error('IH_prefsReady missing — inject page-map.js before highlight.js');
  }
  if (!globalThis.IH_dynamicTrack) {
    throw new Error('IH_dynamicTrack missing — inject dynamicTrack.js before highlight.js');
  }
  const R = globalThis.IH_analyzeRun;
  const DT = globalThis.IH_dynamicTrack;
  if (typeof globalThis.IL_createPdfZoomIdle !== 'function') {
    throw new Error('IL_createPdfZoomIdle missing — load text-layer.js first');
  }
  const zoomIdle = globalThis.IL_createPdfZoomIdle();
  let generation = 0;
  let busy = false;
  let enabled = true;
  /** 本轮是怎么开跑的。查看器自己打开记 pdf-viewer。 */
  let trigger = '';
  /** @type {{ mapped: { text: string, pieces: unknown[], root: Element }, segs: { start: number, end: number, text: string }[], from: number, next: number, painted: number, tokensBySeg?: unknown[][], skipCache?: boolean, cloudModel?: string, resultCache?: unknown, continueBudget?: number, analyzed?: number } | null} */
  let session = null;
  /** 动态跟踪停在「继续」：未点之前不再自动补 */
  let continueArmed = false;
  /** 一次注入（一个页面）只上报一次成功；失败和取消每次都报。 */
  const usageOnce = { okSent: false };

  /** 每次新开会话时读一次动态跟踪开关。中途改设置，下一次重新分析才生效。 */
  let dynamic = false;
  function useDynamic() {
    return dynamic;
  }

  function extractPdfPage() {
    const data = globalThis.IL_pdfTextLayer.read();
    const pieces = globalThis.IL_pdfTextLayer.pieces(data);
    if (!pieces.length) throw new Error('PDF has no selectable text');
    return { text: data.pageText, pieces, root: globalThis.IL_pdfTextLayer.pagesRoot(data) };
  }

  /** PDF 无动态 DOM：跟网页共用视口轮询，不绑滚动容器。 */
  const track = DT.createTrack({
    live: () => enabled && !!session && !session.failed,
    useDynamic,
    isBusy: () => busy || continueArmed,
    session: () => session,
    run: () => runDynamicFill(),
  });

  function clear() {
    zoomIdle.cancel();
    track.stop();
    continueArmed = false;
    session = null;
    globalThis.IH_clearHighlights();
    globalThis.IH_clearProgress();
    globalThis.IH_beginAnalyzeRound?.();
  }

  async function pauseForContinue() {
    continueArmed = true;
    await globalThis.IH_setProgressSearching(false);
    await globalThis.IH_showPaused(continuePaused);
  }

  function continuePaused() {
    if (busy || !session || !enabled) return;
    continueArmed = false;
    session.armFirstAnalyze = true;
    if (useDynamic()) {
      session.continueBudget = DT.nextContinueBudget(session.analyzed);
      void runDynamicFill();
      return;
    }
    void runBatch(generation += 1, session.skipCache, session.cloudModel);
  }

  async function finish(lastAlignErr, report) {
    await R.afterPaint(
      session,
      lastAlignErr,
      'No tokens mapped onto the PDF text layer',
      () => globalThis.IH_showPaused(continuePaused),
      report,
    );
  }

  function job(myGeneration, work) {
    const still = () => myGeneration === generation;
    busy = true;
    let extracted = false;
    return R.runJob(still, {
      onFailed({ report, err }) {
        globalThis.IH_feedbackContext?.stash({ session, report, err, surface: 'pdf' });
      },
      fail(err) {
        // 出错就停跟踪，免得同一视口反复重试。重试会开新会话。
        if (session) session.failed = true;
        track.stop();
        // 分析报错保留已画高亮。文字层丢失 / 缩放后无法重贴才 clear()。
        if (!(session?.painted > 0)) {
          enabled = false;
          R.reportActionState('off');
        }
        return globalThis.IH_showError(err);
      },
      idle() {
        busy = false;
        if (!still()) return;
        if (!enabled) R.reportActionState('off');
        else if (session) R.reportActionState('on');
      },
      trigger,
      usageOnce,
      reportAnonymousSiteDomain(report) {
        if (!extracted) return;
        globalThis.IH_anonymousSiteDomain.fromAnalysis({
          href: window.__IL_PDF_SOURCE_HREF__ || '',
          kind: 'pdf',
          session,
          report,
        });
      },
    }, async (report) => {
      if (!session) extracted = true;
      await work(report);
    });
  }

  async function runDynamicFill() {
    if (!enabled || !useDynamic() || busy || document.hidden || continueArmed || !session) return;
    const myGeneration = generation;
    const still = () => myGeneration === generation && enabled;
    if (track.nextPaint(session) < 0) return;
    if (track.needsContinue(session)) {
      await pauseForContinue();
      return;
    }
    await job(myGeneration, async (report) => {
      await R.paintEach(session, track, still, {
        overlay: true,
        skipCache: session.skipCache,
      }, report);
      if (still() && track.needsContinue(session)) await pauseForContinue();
    });
  }

  async function runBatch(myGeneration, skipCache, cloudModel) {
    const still = () => myGeneration === generation;
    const skip = !!skipCache;
    const pinned = typeof cloudModel === 'string' ? cloudModel : '';
    await job(myGeneration, async (report) => {
      R.reportActionState('analyzing');
      await globalThis.IH_prefsReady;
      if (!still()) return;
      if (!session) {
        dynamic = !!globalThis.IH_isDynamicTrack();
        session = await R.beginSession(extractPdfPage(), 'PDF has no text to analyze');
        session.skipCache = skip;
        if (pinned) session.cloudModel = pinned;
        session.resultCache = new Map();
        session.continueBudget = DT.CONTINUE_AFTER_SEGMENTS;
      }
      if (useDynamic()) {
        const lastAlignErr = await R.paintEach(session, track, still, {
          overlay: true,
          skipCache: skip,
        }, report);
        if (!still()) return;
        await R.afterPaint(session, lastAlignErr, 'No tokens mapped onto the PDF text layer', () => {}, report, true);
        if (track.needsContinue(session)) await pauseForContinue();
        track.start();
        return;
      }
      const end = Math.min(session.next + R.MAX_SEGMENTS_PER_RUN, session.segs.length);
      const lastAlignErr = await R.paintRange(
        session, session.next, end, still, { overlay: true, skipCache: skip }, report,
      );
      if (!still()) return;
      session.next = end;
      await finish(lastAlignErr, report);
    });
  }

  /** 同文换节点：idle 已等过绘制。按时间片贴线。不分析、不改图标。暂停点不动。 */
  async function remount(myGeneration) {
    const still = () => myGeneration === generation;
    let mapped;
    try {
      mapped = extractPdfPage();
    } catch (error) {
      if (!still()) return;
      clear();
      enabled = false;
      await globalThis.IH_showError(error?.message || error);
      R.reportActionState('off');
      globalThis.IH_anonymousSiteDomain.fromAnalysis({
        href: window.__IL_PDF_SOURCE_HREF__ || '',
        kind: 'pdf',
        session: null,
        report: { outcome: 'failed', trigger },
      });
      return;
    }
    if (!session || mapped.text !== session.mapped.text) {
      session = null;
      await runBatch(myGeneration, false);
      return;
    }
    await globalThis.IH_bindProgress(mapped, session.segs);
    if (!still()) return;
    if (!(session.painted > 0 || session.analyzed > 0)) {
      session.mapped = mapped;
      await runBatch(myGeneration, session.skipCache);
      return;
    }
    R.reportActionState('on');
    try {
      globalThis.IH_clearError();
      await R.repaintPainted(session, mapped, true, still);
      if (!still()) return;
      if (useDynamic()) {
        track.start();
        await globalThis.IH_setProgressSearching(false);
      } else {
        await finish(undefined, { segments: 0 });
      }
    } catch (error) {
      if (!still()) return;
      clear();
      enabled = false;
      await globalThis.IH_showError(error?.message || error);
      R.reportActionState('off');
      return;
    }
    if (!still()) return;
    R.reportActionState('on');
  }

  function retryAnalyze() {
    enabled = true;
    busy = false;
    trigger = 'rerun';
    restart();
  }

  function restart() {
    if (!enabled) return;
    zoomIdle.cancel();
    track.stop();
    continueArmed = false;
    session = null;
    void runBatch(generation += 1, false);
  }

  function onRerendered() {
    if (!enabled) return;
    const g = generation += 1;
    zoomIdle.schedule(() => {
      if (!enabled || g !== generation) return;
      if (session) return remount(g);
      return runBatch(g, false);
    });
  }

  function toggle() {
    enabled = !enabled;
    if (enabled) {
      restart();
      return;
    }
    generation += 1;
    busy = false;
    clear();
    R.reportActionState('off');
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ih-pdf-toggle' && message?.type !== 'ih-pdf-force') return;
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id !== message.tabId) return;
      if (message.type === 'ih-pdf-force') {
        if (busy) {
          alert(R.FORCE_BUSY_MSG);
        } else {
          enabled = true;
          clear();
          const pinned = typeof message.cloudModel === 'string' ? message.cloudModel : '';
          trigger = message.trigger || 'rerun';
          void runBatch(generation += 1, true, pinned);
        }
      } else {
        if (message.trigger) trigger = message.trigger;
        toggle();
      }
      sendResponse({ ok: true });
    });
    return true;
  });

  function viewerSelfStart() {
    if (!trigger) trigger = 'pdf-viewer';
    restart();
  }

  globalThis.IH_retryAnalyze = retryAnalyze;
  window.addEventListener('il-pdf-ready', viewerSelfStart);
  window.addEventListener('il-pdf-rerendered', onRerendered);
  if (window.__IL_PDF_DATA__) viewerSelfStart();
})();
