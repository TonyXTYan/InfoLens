/**
 * 网页 / PDF 共用：向 SW 要 token、按段画、对齐失败跳过；一轮结束上报用量。
 */
globalThis.IH_analyzeRun ||= (function () {
  /** 一轮 UI 批处理最多连续处理的段数。SYNC: dynamicTrack.js CONTINUE_AFTER_SEGMENTS */
  const MAX_SEGMENTS_PER_RUN = 32;
  /** 收藏从头补到尾的段数上限。每段约 1600 字节（中文约 500 字），32 段约 1.6 万字；再长多半是评论区。 */
  const LIBRARY_MAX_SEGMENTS = 32;
  /** SYNC: local/scoring.js → alignUtf16Offsets fail() */
  const ALIGN_FAIL = 'token offset align failed';
  /** SYNC: background.js USAGE_ENGINE_* */
  function isUsageReportEngine(engine) {
    return engine === 'local'
      || engine === 'cloud-free'
      || engine === 'cloud-credit'
      || engine === 'cloud-self-api';
  }

  let analyzeWaitSeq = 0;
  /** @type {Map<number, { finished: boolean, timer: ReturnType<typeof setTimeout> | null, waitMs: number }>} */
  const pendingAnalyzeWaits = new Map();

  function ensureAnalyzeNetworkWaitListener() {
    if (globalThis.__ihAnalyzeNetworkWaitListener) return;
    const onMessage = chrome.runtime?.onMessage;
    if (!onMessage?.addListener) return;
    globalThis.__ihAnalyzeNetworkWaitListener = true;
    onMessage.addListener((msg) => {
      if (msg?.type === 'ih-facade-policy-notice') {
        if (msg.notice && typeof msg.notice.zh === 'string' && typeof msg.notice.en === 'string') {
          void globalThis.IH_showFacadePolicyNotice?.(msg.notice);
        }
        return;
      }
      if (msg?.type !== 'ih-analyze-network-wait') return;
      const waitGen = Number(msg.waitGen);
      const pending = pendingAnalyzeWaits.get(waitGen);
      if (!pending || pending.finished) return;
      if (msg.armCloudWait && !globalThis.IH_OPTIONS_PAGE && !pending.finished && pending.timer == null) {
        pending.timer = setTimeout(() => void globalThis.IH_showCloudWait?.(), pending.waitMs);
      }
    });
  }

  function sendAnalyze(text, skipCache, { armCloudWait = false, cloudModel = '' } = {}) {
    ensureAnalyzeNetworkWaitListener();
    const waitMs = globalThis.IH_cloudWait?.FIRST_SEGMENT_WAIT_MS ?? 2000;
    const waitGen = ++analyzeWaitSeq;
    const pending = { finished: false, timer: null, waitMs };
    pendingAnalyzeWaits.set(waitGen, pending);
    const finishWaitUi = () => {
      pending.finished = true;
      if (pending.timer != null) {
        clearTimeout(pending.timer);
        pending.timer = null;
      }
      pendingAnalyzeWaits.delete(waitGen);
      globalThis.IH_clearCloudWait?.();
    };
    return new Promise((resolve, reject) => {
      const msg = { type: 'ih-analyze', text, waitGen };
      if (armCloudWait) msg.armCloudWait = true;
      if (skipCache) msg.skipCache = true;
      if (cloudModel) msg.cloudModel = cloudModel;
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          finishWaitUi();
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res?.ok) {
          finishWaitUi();
          const err = new Error(res?.error || 'Analyze failed');
          if (res?.notice && typeof res.notice.zh === 'string' && typeof res.notice.en === 'string') {
            err.notice = res.notice;
          }
          reject(err);
          return;
        }
        globalThis.IH_applyAnalyzeBillingUi?.(res);
        finishWaitUi();
        const model = typeof res.data?.result?.model === 'string' ? res.data.result.model.trim() : '';
        const device = typeof res.data?.result?.device === 'string' ? res.data.result.device.trim() : '';
        if (model) globalThis.IH_tokenTip?.setModel?.(model, device);
        resolve({
          data: res.data,
          inferred: !!res.inferred,
          engine: isUsageReportEngine(res.engine) ? res.engine : null,
          model: model || null,
        });
      });
    });
  }

  /** SYNC: action-state.js TILES。分析中最多 7 瓦；8 瓦全亮是未激活标。 */
  const ACTION_TILES = 8;

  /** @param {'off' | 'analyzing' | 'on'} state @param {number} [filled] */
  function reportActionState(state, filled) {
    if (globalThis.IH_OPTIONS_PAGE) return;
    const msg = { type: 'ih-action-state', state };
    if (state === 'analyzing') {
      const v = Math.floor(Number(filled));
      msg.filled = Number.isFinite(v) && v > 0 ? Math.min(ACTION_TILES - 1, v) : 0;
    }
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
    });
  }

  function reportActionFilled(done, total) {
    const n = Number(total);
    const d = Number(done);
    if (!(n > 0) || !(d > 0)) {
      reportActionState('analyzing', 0);
      return;
    }
    // 按 done/total 比例亮瓦。4 段则一段两瓦。分析中最多 7 瓦，满了由调用方打勾。
    const filled = Math.min(ACTION_TILES - 1, Math.max(1, Math.round((d / n) * ACTION_TILES)));
    reportActionState('analyzing', filled);
  }

  /** 每段都 cache hit（inferred===false）；与用量看板 usage_record 同口径。 */
  function isFullCacheUsageReport(report) {
    if (!report) return false;
    const seg = Number(report.segments) || 0;
    if (seg <= 0) return false;
    return (Number(report.cached) || 0) === seg;
  }

  /** 一轮结束后上报。失败时附带截断后的 error（不含页面 URL/正文）。 */
  function reportUsage(report) {
    if (!report) return;
    const msg = {
      type: 'ih-usage-report',
      engine: report.engine,
      outcome: report.outcome || 'ok',
      segments: report.segments,
      segments_ok: report.segments_ok,
      cached: report.cached,
      duration_ms: Math.max(0, Math.round(Number(report.duration_ms) || 0)),
    };
    if (report.trigger) msg.trigger = String(report.trigger);
    if (report.model) msg.model = String(report.model);
    if (report.outcome === 'failed' && report.error) {
      msg.error = String(report.error).slice(0, 500);
    }
    if (report.outcome === 'failed' && report.detail && typeof report.detail === 'object' && !Array.isArray(report.detail)) {
      msg.detail = report.detail;
    }
    chrome.runtime.sendMessage(msg, () => {
      void chrome.runtime.lastError;
    });
  }

  function newUsageReport() {
    return {
      segments: 0,
      segments_ok: 0,
      cached: 0,
      engine: null,
      model: null,
      trigger: null,
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

  function addPaintStats(report, stats) {
    if (!report || !stats) return;
    report.painted += Number(stats.painted) || 0;
    report.tokens_in += Number(stats.tokens_in) || 0;
    report.tokens_skip_level += Number(stats.tokens_skip_level) || 0;
    report.tokens_skip_empty_range += Number(stats.tokens_skip_empty_range) || 0;
  }

  function clipAlignErr(err) {
    const t = String(err?.message || err || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > 200 ? t.slice(0, 199) + '…' : t;
  }

  function highlightsOk() {
    try {
      return !!(globalThis.CSS && globalThis.CSS.highlights);
    } catch {
      return false;
    }
  }

  /** painted===0 诊断：只有数字/布尔/短字符串，无页面 URL/正文。 */
  function buildPaintFailDetail(session, report, lastAlignErr) {
    const mapped = session?.mapped;
    const detail = {
      segments: Number(report?.segments) || 0,
      segments_ok: Number(report?.segments_ok) || 0,
      align_fail_n: Number(report?.align_fail_n) || 0,
      tokens_in: Number(report?.tokens_in) || 0,
      tokens_skip_level: Number(report?.tokens_skip_level) || 0,
      tokens_skip_empty_range: Number(report?.tokens_skip_empty_range) || 0,
      painted: Number(session?.painted) || 0,
      mapped_chars: mapped?.text ? mapped.text.length : 0,
      mapped_pieces: Array.isArray(mapped?.pieces) ? mapped.pieces.length : 0,
      highlights_ok: highlightsOk(),
    };
    const align = clipAlignErr(lastAlignErr || report?.last_align_err);
    if (align) detail.last_align_err = align;
    return detail;
  }

  /** @param {boolean | null} inferred 仅 `false` 计为 cache hit；`null` 表示未知（失败路径） */
  function noteAttempt(report, inferred, engine, model) {
    if (!report) return;
    report.segments += 1;
    if (inferred === false) report.cached += 1;
    if (engine) report.engine = engine;
    if (model) report.model = model;
  }

  /** 取一段的原始分析结果。会话相关的状态（缓存、请求数、引擎、模型、首次等云端）都收在这里。 */
  async function fetchRaw(session, requestText, skipCache) {
    const hit = !skipCache && session?.resultCache?.get(requestText);
    if (Array.isArray(hit)) {
      return { raw: hit, inferred: false, engine: session.lastEngine || null, model: session.lastModel || null };
    }
    const armCloudWait = !!session?.armFirstAnalyze;
    if (armCloudWait) session.armFirstAnalyze = false;
    if (session) session.analyzed = (Number(session.analyzed) || 0) + 1;
    const { data, inferred, engine, model } = await sendAnalyze(requestText, skipCache, {
      armCloudWait,
      cloudModel: typeof session?.cloudModel === 'string' ? session.cloudModel : '',
    });
    if (session) {
      if (engine) session.lastEngine = engine;
      if (model) session.lastModel = model;
    }
    const raw = data?.result?.bpe_strings;
    if (Array.isArray(raw) && !skipCache) session?.resultCache?.set(requestText, raw);
    return { raw, inferred, engine, model };
  }

  /**
   * @returns {Promise<
   *   | { kind: 'empty' }
   *   | { kind: 'ok', tokens: unknown[], inferred: boolean, engine: string | null, model: string | null }
   *   | { kind: 'align_fail', err: Error, inferred: boolean, engine: string | null, model: string | null }
   *   | { kind: 'error', err: Error, inferred: boolean, engine: string | null, model: string | null }
   * >}
   */
  async function analyzeSegment(text, segs, i, skipCache, session) {
    if (!/\S/.test(segs[i].text)) return { kind: 'empty' };
    const win = globalThis.IH_segmentWindow(text, segs, i);
    const { raw, inferred, engine, model } = await fetchRaw(session, win.requestText, skipCache);
    if (!Array.isArray(raw)) {
      return { kind: 'error', err: new Error('Analyze returned no tokens'), inferred, engine, model };
    }
    try {
      return {
        kind: 'ok',
        tokens: globalThis.IH_tokensInSegment(raw, win),
        inferred,
        engine,
        model,
      };
    } catch (err) {
      if (String(err?.message || err).includes(ALIGN_FAIL)) {
        return { kind: 'align_fail', err, inferred, engine, model };
      }
      throw err;
    }
  }

  /** 当前任务结束并完成一次绘制后再继续。单次 rAF 会在绘制前执行，挡不住高亮。 */
  function waitForPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  }

  function commitSegTokens(session, i, tokens) {
    if (!session.tokensBySeg) session.tokensBySeg = [];
    session.tokensBySeg[i] = tokens;
  }

  function applyTokens(session, tokens, i, opts, report) {
    commitSegTokens(session, i, tokens);
    const seg = session.segs[i];
    globalThis.IH_dropTokenRangesOverlapping(session.mapped, seg.start, seg.end);
    const stats = globalThis.IH_paintTokens(tokens, session.mapped, {
      append: true,
      overlay: !!opts?.overlay,
    });
    session.painted += Number(stats?.painted) || 0;
    addPaintStats(report, stats);
    opts?.onTokens?.(tokens, i);
    globalThis.IH_appendProgress(tokens, session.segs[i]);
  }

  /**
   * @param {{ mapped: { text: string }, segs: unknown[], painted: number }} session
   * @param {number} from
   * @param {number} to
   * @param {() => boolean} still
   * @param {{ overlay?: boolean, onTokens?: (tokens: unknown[], i: number) => void, onSegment?: (i: number, to: number) => void, skipCache?: boolean }} [opts]
   * @param {{ segments: number, segments_ok: number, cached: number, engine: string | null, error?: string | null, duration_ms?: number, align_fail_n?: number, tokens_in?: number, tokens_skip_level?: number, tokens_skip_empty_range?: number, painted?: number, detail?: object | null }} report
   * @returns {Promise<Error | undefined>}
   */
  async function paintRange(session, from, to, still, opts, report) {
    const batch = to - from;
    const quietIcon = !!opts?.quietIcon;
    if (!quietIcon) reportActionFilled(0, batch);
    let lastAlignErr;
    for (let i = from; i < to; i++) {
      if (!still()) return lastAlignErr;
      opts?.onSegment?.(i, to);
      let got;
      try {
        got = await analyzeSegment(session.mapped.text, session.segs, i, opts?.skipCache, session);
      } catch (err) {
        if (!still()) return lastAlignErr;
        // SW/通道失败：计入尝试，但不记 cached（inferred 未知）
        noteAttempt(report, null, null);
        throw err;
      }
      if (!still()) return lastAlignErr;
      if (got.kind === 'empty') {
        applyTokens(session, [], i, opts, report);
        if (!quietIcon) reportActionFilled(i + 1 - from, batch);
        continue;
      }
      noteAttempt(report, got.inferred, got.engine, got.model);
      if (got.kind === 'error') throw got.err;
      if (got.kind === 'align_fail') {
        console.warn('[Info Highlight] skip segment', i, got.err);
        lastAlignErr = got.err;
        commitSegTokens(session, i, []);
        if (report) {
          report.align_fail_n = (report.align_fail_n || 0) + 1;
          report.last_align_err = clipAlignErr(got.err);
        }
        if (!quietIcon) reportActionFilled(i + 1 - from, batch);
        continue;
      }
      if (report) report.segments_ok += 1;
      applyTokens(session, got.tokens, i, opts, report);
      if (!quietIcon) reportActionFilled(i + 1 - from, batch);
    }
    return lastAlignErr;
  }

  /**
   * 已画段按新 mapped 重画。不请求分析。先等页面画出，再按时间片贴线。取消则停。
   * @param {() => boolean} [still]
   */
  async function repaintPainted(session, mapped, overlay, still) {
    const bags = session.tokensBySeg;
    if (!Array.isArray(bags)) return;
    session.mapped = mapped;
    session.painted = 0;
    const keep = overlay ? null : [];
    if (!overlay) globalThis.IH_pruneDetachedHighlights?.();
    await waitForPaint();
    if (still && !still()) return;
    const idx = globalThis.IL_createTextIndex?.(mapped.text);
    let append = false;
    let t0 = performance.now();
    const budgetMs = 8;
    const batch = 8;
    for (let i = 0; i < session.segs.length; i++) {
      if (!Array.isArray(bags[i])) continue;
      const list = globalThis.IH_tokensForPaint
        ? globalThis.IH_tokensForPaint(bags[i], mapped.text)
        : bags[i];
      globalThis.IH_appendProgress(bags[i], session.segs[i]);
      for (let j = 0; j < list.length; ) {
        if (performance.now() - t0 >= budgetMs) {
          await waitForPaint();
          if (still && !still()) return;
          t0 = performance.now();
        }
        const end = Math.min(j + batch, list.length);
        const stats = globalThis.IH_paintTokens(list.slice(j, end), mapped, {
          append,
          overlay: !!overlay,
          keepExisting: !overlay,
          keep,
          skipMerge: true,
          index: idx,
          scaleFrom: list,
          bag: j === 0 ? bags[i] : undefined,
        });
        append = true;
        session.painted += Number(stats?.painted) || 0;
        j = end;
      }
    }
    if (keep && session.painted > 0) globalThis.IH_dropHighlightRangesExcept?.(keep);
  }

  /**
   * 逐段画：每画完一段再调 track.pickNext 现挑下一段，返回 -1 或取消即停。
   * 图标只算视口内：按已画/未画比例亮瓦，视口画完即显示完成，预取不占图标。
   * onCaughtUp：手头没未画段时再对现文；有新段则同一轮接着画，图标计数不清零。对完现文前不打勾。
   */
  async function paintEach(session, track, still, opts, report) {
    const childOpts = { ...(opts || {}), quietIcon: true };
    let lastAlignErr;
    let done = 0;
    const showIcon = () => {
      const left = track.viewLeft(session);
      if (left > 0) reportActionFilled(done, done + left);
      else if (typeof opts?.onCaughtUp !== 'function') reportActionState('on');
      return left;
    };
    let left = showIcon();
    for (;;) {
      if (!still()) break;
      const i = track.pickNext(session);
      if (i < 0) {
        if (typeof opts?.onCaughtUp !== 'function') break;
        const more = await opts.onCaughtUp();
        if (!more || !still() || track.pickNext(session) < 0) break;
        left = showIcon();
        continue;
      }
      const err = await paintRange(session, i, i + 1, still, childOpts, report);
      if (err) lastAlignErr = err;
      if (!still()) break;
      if (left > 0) done += 1;
      left = showIcon();
    }
    return lastAlignErr;
  }

  async function beginSession(mapped, emptyMsg) {
    const segs = globalThis.IH_splitSegments(mapped.text);
    if (!segs.length) throw new Error(emptyMsg);
    globalThis.IH_clearHighlights();
    await globalThis.IH_bindProgress(mapped, segs);
    if (typeof globalThis.IH_viewportSegmentStart !== 'function') {
      throw new Error('IH_viewportSegmentStart missing — inject page-map.js first');
    }
    const from = globalThis.IH_viewportSegmentStart(mapped, segs);
    if (!Number.isInteger(from) || from < 0 || from >= segs.length) {
      throw new Error('viewport segment start out of range');
    }
    return { mapped, segs, from, next: from, painted: 0, tokensBySeg: [], armFirstAnalyze: true, analyzed: 0 };
  }

  async function afterPaint(session, lastAlignErr, emptyMsg, onMore, report, skipContinue) {
    await globalThis.IH_setProgressSearching(false);
    if (!skipContinue && session.next < session.segs.length) {
      await onMore();
      return;
    }
    if (!session.painted) {
      const detail = buildPaintFailDetail(session, report, lastAlignErr);
      if (report) {
        report.detail = detail;
        report.error = emptyMsg;
      }
      throw new Error(emptyMsg);
    }
  }

  /**
   * @param {() => boolean} still
   * @param {{ fail: (err: unknown) => void | Promise<void>, idle: () => void, onFailed?: (args: { err: unknown, report: ReturnType<typeof newUsageReport> }) => void, trigger?: string }} hooks
   * @param {(report: ReturnType<typeof newUsageReport>) => Promise<void>} job
   */
  async function runJob(still, hooks, job) {
    const { fail, idle, onFailed } = hooks;
    globalThis.IH_beginAnalyzeRound?.();
    await globalThis.IH_setProgressSearching(true);
    const report = newUsageReport();
    report.trigger = hooks.trigger || null;
    const t0 = Date.now();
    let failedErr = null;
    try {
      await job(report);
      report.outcome = still() ? 'ok' : 'cancelled';
      if (report.outcome === 'ok' && !globalThis.IH_OPTIONS_PAGE && globalThis.IL_engagementNudge) {
        const used = (Number(report.segments_ok) || 0) >= 1 || (Number(report.painted) || 0) > 0;
        if (used) {
          try {
            const out = await globalThis.IL_engagementNudge.noteSuccess();
            if (out.shouldPrompt) void globalThis.IH_maybeShowEngagementNudge?.();
          } catch (err) {
            console.error('[Info Highlight] engagement nudge', err);
          }
        }
      }
    } catch (err) {
      if (!still()) {
        report.outcome = 'cancelled';
      } else {
        report.outcome = 'failed';
        report.error = String(err?.message || err).slice(0, 500);
        onFailed?.({ err, report });
        failedErr = err;
      }
    } finally {
      // 取消/失败/成功都带墙钟。域名统计要在 fail 清掉正文之前。
      report.duration_ms = Math.max(0, Date.now() - t0);
      const once = hooks.usageOnce;
      const skipUsage = isFullCacheUsageReport(report);
      if ((report.outcome !== 'ok' || !once?.okSent) && !skipUsage) reportUsage(report);
      if (report.outcome === 'ok' && once && !skipUsage) once.okSent = true;
      try {
        hooks.reportAnonymousSiteDomain?.(report);
      } catch (err) {
        console.error('[Info Highlight] anonymous site domain', err);
      }
      try {
        if (failedErr) await fail(failedErr);
      } finally {
        idle();
      }
    }
  }

  return {
    MAX_SEGMENTS_PER_RUN,
    LIBRARY_MAX_SEGMENTS,
    FORCE_BUSY_MSG: 'Info Highlight is still analyzing this page. Try again when it finishes.',
    reportActionState,
    beginSession,
    paintRange,
    paintEach,
    repaintPainted,
    afterPaint,
    runJob,
  };
})();
