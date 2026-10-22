/**
 * 动态跟踪：旧段边界冻结、按视口附近补画。
 * 保证：视口停稳约两拍后，视口里尚未分析的段会开画（额度未用完时）。
 * 未分析：tokensBySeg[i] 不是数组。空数组只表示分析过没 token，或已画段对不上。
 * 可见时每 0.5s 量一次视口；未画段现量 Y。滑过的不画，滑回停稳再画。
 * 逐段现挑：视口内未画优先，其次视口下方一屏内（预取）。
 * 会话文可能落后于页面。手头空了、DOM 变动、切回可见后，停稳再抽一次现文。
 */
globalThis.IH_dynamicTrack ||= (function () {
  const KEY_DYNAMIC_TRACK = 'ih_dynamic_track';
  const POLL_MS = 500;
  const CONTINUE_AFTER_SEGMENTS = 32;
  /** 未改区间之外的字数占较长者低于此则重分析；≥ 则未改区间内 token 平移。 */
  const TWEAK_RATIO = 0.1;
  /** 一段目标约 1600 字节（中文约 500 字），取其 1/10。短段按此卡住。 */
  const TWEAK_ABS = 50;
  /** 中间再对上的一截至少这么长，且两边都只出现一次；对不上就丢掉。 */
  const RESYNC_LEN = 8;

  function normalizeSplit(text, origin, splitFn) {
    if (!text) return [];
    return splitFn(text).map((s) => {
      const t = s.text ?? '';
      return { start: origin + s.start, end: origin + s.start + t.length, text: t };
    });
  }

  function commonAffix(oldT, newT) {
    const n = oldT.length;
    const m = newT.length;
    let pre = 0;
    while (pre < n && pre < m && oldT.charCodeAt(pre) === newT.charCodeAt(pre)) pre += 1;
    let suf = 0;
    while (suf < n - pre && suf < m - pre
      && oldT.charCodeAt(n - 1 - suf) === newT.charCodeAt(m - 1 - suf)) suf += 1;
    return { pre, suf, n, m };
  }

  function findResync(a, b) {
    const k = RESYNC_LEN;
    if (a.length < k || b.length < k) return null;
    const seen = new Set();
    for (let ai = 0; ai <= a.length - k; ai++) {
      const key = a.slice(ai, ai + k);
      if (seen.has(key)) continue;
      seen.add(key);
      const bi = b.indexOf(key);
      if (bi < 0) continue;
      if (a.indexOf(key, ai + 1) >= 0 || b.indexOf(key, bi + 1) >= 0) continue;
      return { ai, bi };
    }
    return null;
  }

  function equalRuns(oldT, newT) {
    const prev = String(oldT || '');
    const next = String(newT || '');
    const runs = [];
    function walk(a0, a1, b0, b1) {
      if (a0 >= a1 && b0 >= b1) return;
      const a = prev.slice(a0, a1);
      const b = next.slice(b0, b1);
      if (a === b) {
        if (a0 < a1) runs.push({ old0: a0, old1: a1, new0: b0, new1: b1 });
        return;
      }
      const { pre, suf, n, m } = commonAffix(a, b);
      if (pre) runs.push({ old0: a0, old1: a0 + pre, new0: b0, new1: b0 + pre });
      const am0 = a0 + pre;
      const am1 = a0 + n - suf;
      const bm0 = b0 + pre;
      const bm1 = b0 + m - suf;
      if (am0 < am1 || bm0 < bm1) {
        const hit = findResync(prev.slice(am0, am1), next.slice(bm0, bm1));
        if (hit && (hit.ai > 0 || hit.bi > 0)) {
          walk(am0 + hit.ai, am1, bm0 + hit.bi, bm1);
        }
      }
      if (suf) runs.push({ old0: a0 + n - suf, old1: a0 + n, new0: b0 + m - suf, new1: b0 + m });
    }
    walk(0, prev.length, 0, next.length);
    return runs;
  }

  function tweakRuns(oldT, newT) {
    const prev = String(oldT || '');
    const next = String(newT || '');
    if (!prev || !next || prev === next) return null;
    const cap = Math.max(Math.max(prev.length, next.length) * TWEAK_RATIO, TWEAK_ABS);
    // 改动量至少是长度差：先挡掉，免得长空隙去跑 findResync
    if (Math.abs(prev.length - next.length) > cap) return null;
    const runs = equalRuns(prev, next);
    let keep = 0;
    for (const r of runs) keep += r.old1 - r.old0;
    if (Math.max(prev.length, next.length) - keep > cap) return null;
    return runs;
  }

  function isSmallTweak(oldStr, newStr) {
    return tweakRuns(oldStr, newStr) != null;
  }

  function keepTokensAfterTweak(tokens, oldSeg, newSeg) {
    const oldStart = Number(oldSeg?.start) || 0;
    const newStart = Number(newSeg?.start) || 0;
    const runs = newSeg.runs;
    const n = String(oldSeg?.text || '').length;
    const out = [];
    for (const tok of tokens || []) {
      const off = tok?.offset;
      if (!Array.isArray(off) || off.length < 2) continue;
      const loc0 = off[0] - oldStart;
      const loc1 = off[1] - oldStart;
      if (loc0 < 0 || loc1 > n || loc1 <= loc0) continue;
      for (const r of runs) {
        if (loc0 < r.old0 || loc1 > r.old1) continue;
        const d = r.new0 - r.old0;
        out.push({ ...tok, offset: [newStart + loc0 + d, newStart + loc1 + d] });
        break;
      }
    }
    return out;
  }

  function placeTweak(oldText, newText, cursor, bound) {
    if (cursor < 0 || cursor >= bound) return null;
    const gap = newText.slice(cursor, bound);
    const same = newText.slice(cursor, Math.min(bound, cursor + oldText.length));
    for (const text of same === gap ? [gap] : [gap, same]) {
      const runs = text && tweakRuns(oldText, text);
      if (runs) return { text, start: cursor, end: cursor + text.length, runs };
    }
    return null;
  }

  function placeOldSegs(oldSegs, newText) {
    const placed = [];
    let cursor = 0;
    const list = oldSegs || [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i]?.text;
      if (typeof t !== 'string' || !t) continue;
      const idx = newText.indexOf(t, cursor);
      if (idx >= 0) {
        placed.push({ text: t, start: idx, end: idx + t.length, oldIndex: i });
        cursor = idx + t.length;
        continue;
      }
      let bound = newText.length;
      for (let k = i + 1; k < list.length; k++) {
        const nt = list[k]?.text;
        if (typeof nt !== 'string' || !nt) continue;
        const nidx = newText.indexOf(nt, cursor);
        if (nidx >= 0) {
          bound = nidx;
          break;
        }
      }
      const hit = placeTweak(t, newText, cursor, bound);
      if (!hit) continue;
      placed.push({ ...hit, oldIndex: i });
      cursor = hit.end;
    }
    return placed;
  }

  function stitchSegs(placed, newText, splitFn) {
    const segs = [];
    let pos = 0;
    for (const p of placed) {
      if (p.start > pos) {
        for (const n of normalizeSplit(newText.slice(pos, p.start), pos, splitFn)) segs.push(n);
      }
      segs.push(p);
      pos = p.end;
    }
    if (pos < newText.length) {
      for (const n of normalizeSplit(newText.slice(pos), pos, splitFn)) segs.push(n);
    }
    return segs;
  }

  function reconcileSegments(oldSegs, oldText, newText, splitFn) {
    const next = String(newText || '');
    const prev = String(oldText || '');
    if (!next) return [];
    if (!prev) return normalizeSplit(next, 0, splitFn);
    if (prev === next) {
      return (oldSegs || []).map((s, i) => ({ start: s.start, end: s.end, text: s.text, oldIndex: i }));
    }
    return stitchSegs(placeOldSegs(oldSegs, next), next, splitFn);
  }

  function shiftTokenOffsets(tokens, delta) {
    const d = Number(delta) || 0;
    if (!d || !Array.isArray(tokens)) return tokens;
    return tokens.map((tok) => {
      const off = tok?.offset;
      if (!Array.isArray(off) || off.length < 2) return tok;
      return { ...tok, offset: [off[0] + d, off[1] + d] };
    });
  }

  /** token.offset 是全文码点，seg 与 DOM 是 UTF-16：段内小改动在 UTF-16 里算，进出各转一次。 */
  function mapOffsets(tokens, convert) {
    return tokens.map((tok) => {
      const off = tok?.offset;
      if (!Array.isArray(off) || off.length < 2) return tok;
      return { ...tok, offset: [convert(off[0]), convert(off[1])] };
    });
  }

  function remapCommitted(oldSegs, oldTokensBySeg, newSegs, oldText, newText) {
    const oldIdx = globalThis.IL_createTextIndex(oldText);
    const newIdx = globalThis.IL_createTextIndex(newText);
    const tokensBySeg = [];
    const painted = [];
    const old = oldSegs || [];
    const bags = oldTokensBySeg || [];
    for (let i = 0; i < (newSegs || []).length; i++) {
      const seg = newSegs[i];
      const found = Number.isInteger(seg?.oldIndex) ? seg.oldIndex : -1;
      if (found >= 0 && Array.isArray(bags[found])) {
        if (seg.runs) {
          const kept = keepTokensAfterTweak(mapOffsets(bags[found], oldIdx.cpToUtf16), old[found], seg);
          tokensBySeg[i] = mapOffsets(kept, newIdx.utf16ToCp);
        } else {
          const delta = newIdx.utf16ToCp(Number(seg.start) || 0) - oldIdx.utf16ToCp(Number(old[found].start) || 0);
          tokensBySeg[i] = shiftTokenOffsets(bags[found], delta);
        }
        painted[i] = true;
      } else {
        painted[i] = false;
      }
    }
    return { tokensBySeg, painted };
  }

  function shouldAskContinue(n, cap) {
    return (Number(n) || 0) >= (Number(cap) || CONTINUE_AFTER_SEGMENTS);
  }

  function nextContinueBudget(n) {
    return Math.max(0, Number(n) || 0) + CONTINUE_AFTER_SEGMENTS;
  }

  function mutationsWorthWatching(records) {
    const sel = globalThis.IL_EDITABLE_SEL;
    for (const r of records || []) {
      const n = r.target;
      if (!n) continue;
      const el = typeof n.closest === 'function' ? n : n.parentElement;
      if (el && el.closest(sel)) continue;
      return true;
    }
    return false;
  }

  function createPoller(hooks, timers) {
    const wait = timers?.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancel = timers?.clearTimeout || ((id) => clearTimeout(id));
    const intervalMs = hooks.intervalMs ?? POLL_MS;
    let pollId = 0;
    let stopped = false;
    let lastMark = null;
    let dirty = false;

    function canRun() {
      return !stopped && hooks.isEnabled();
    }

    function tick() {
      if (!canRun() || hooks.isHidden()) return;
      if (hooks.isBusy()) return;
      const snap = hooks.snapshot();
      const mark = String(snap?.mark ?? '');
      const settled = lastMark != null && lastMark === mark;
      lastMark = mark;
      if (!settled) return;
      if (dirty || snap?.run) {
        dirty = false;
        Promise.resolve().then(() => hooks.run()).catch((err) => console.error('[Info Highlight] dynamic fill', err));
      }
    }

    function armPoll() {
      if (stopped || pollId || hooks.isHidden()) return;
      pollId = wait(() => {
        pollId = 0;
        if (stopped || !hooks.isEnabled()) return;
        if (!hooks.isHidden()) tick();
        if (!stopped && hooks.isEnabled() && !hooks.isHidden()) armPoll();
      }, intervalMs);
    }

    return {
      start() {
        stopped = false;
        lastMark = null;
        dirty = false;
        armPoll();
      },
      stop() {
        stopped = true;
        lastMark = null;
        dirty = false;
        if (pollId) cancel(pollId);
        pollId = 0;
      },
      markDirty() {
        dirty = true;
      },
      onVisible() {
        if (!canRun()) return;
        lastMark = null;
        dirty = true;
        armPoll();
      },
    };
  }

  function createTrack(host) {
    let sched = null;

    /** inView / below 只留未画段；snap 是视口里实际看到的段（含已画）。 */
    function unpainted(session) {
      const snap = globalThis.IH_viewportSegments(
        session.mapped, session.segs, session.tokensBySeg,
      );
      const todo = (i) => !Array.isArray(session.tokensBySeg?.[i]);
      return { inView: snap.inView.filter(todo), below: snap.below.filter(todo), snap };
    }

    /** 下一段要画的：视口内未画优先，其次视口下方一屏内未画（近的先）；没有为 -1。 */
    function nextPaint(session) {
      const { inView, below } = unpainted(session);
      return inView[0] ?? below[0] ?? -1;
    }

    /** 视口内还没画的段数。 */
    function viewLeft(session) {
      return unpainted(session).inView.length;
    }

    /** 「继续」额度内的下一段；额度用完为 -1。 */
    function pickNext(session) {
      return shouldAskContinue(session.analyzed, session.continueBudget) ? -1 : nextPaint(session);
    }

    /** 额度用完且还有段要画：该停下问「继续」。 */
    function needsContinue(session) {
      return shouldAskContinue(session.analyzed, session.continueBudget) && nextPaint(session) >= 0;
    }

    /** 视口里实际看到的段（含已画）。滑动时会变，用来判断停稳。 */
    function viewSnap() {
      const session = host.session();
      if (!session?.segs?.length || !session.mapped) {
        return { mark: '', run: false };
      }
      try {
        const { inView, below, snap } = unpainted(session);
        const top = Number(snap.top);
        return {
          mark: `${Number.isFinite(top) ? Math.round(top) : ''}|${snap.inView.join(',')}|${snap.below.join(',')}|${session.segs.length}`,
          run: inView.length + below.length > 0,
        };
      } catch {
        return { mark: '', run: false };
      }
    }

    function onVisible() {
      if (!document.hidden) sched?.onVisible();
    }

    function stop() {
      sched?.stop();
      sched = null;
      host.onStop?.();
      document.removeEventListener('visibilitychange', onVisible);
    }

    function start() {
      if (!host.useDynamic() || !host.live()) {
        stop();
        return;
      }
      if (sched) return;
      sched = createPoller({
        intervalMs: POLL_MS,
        isHidden: () => document.hidden,
        isEnabled: () => host.live() && host.useDynamic(),
        isBusy: () => host.isBusy(),
        snapshot: viewSnap,
        run: () => host.run(),
      });
      sched.start();
      host.onStart?.();
      document.addEventListener('visibilitychange', onVisible);
    }

    return {
      nextPaint,
      viewLeft,
      pickNext,
      needsContinue,
      start,
      stop,
      markDirty: () => sched?.markDirty(),
    };
  }

  function planFill(input) {
    const incoming = String(input.newText || '');
    if (!incoming.trim()) return { segs: [], tokensBySeg: [] };

    const recon = reconcileSegments(
      input.oldSegs || [],
      input.oldText || '',
      incoming,
      input.splitFn,
    );
    if (!recon.length) return { segs: [], tokensBySeg: [] };

    const remapped = remapCommitted(input.oldSegs || [], input.tokensBySeg || [], recon, input.oldText, incoming);
    inheritAffixPainted(
      input.oldText, incoming, recon, remapped.tokensBySeg, input.oldSegs, input.tokensBySeg,
    );
    return {
      segs: recon.map((s) => ({ start: s.start, end: s.end, text: s.text })),
      tokensBySeg: remapped.tokensBySeg,
    };
  }

  /** 旧文 [from, to) 是否整段都被已画段盖住。 */
  function paintedOldRange(oldSegs, oldTokensBySeg, from, to) {
    if (to <= from) return false;
    let pos = from;
    for (let i = 0; i < (oldSegs || []).length; i++) {
      if (!Array.isArray(oldTokensBySeg?.[i])) continue;
      const a = Number(oldSegs[i]?.start) || 0;
      const b = Number(oldSegs[i]?.end) || 0;
      if (b <= pos || a >= to) continue;
      if (a > pos) return false;
      pos = Math.max(pos, b);
      if (pos >= to) return true;
    }
    return pos >= to;
  }

  /**
   * 旧段整段对不上时，落在全文公共前后缀里、旧文已画过的新段，继承旧 token。
   * 滑过没画的不能冒充已画；跨新段边界的 token 丢掉。
   */
  function inheritAffixPainted(oldText, newText, segs, tokensBySeg, oldSegs, oldTokensBySeg) {
    const prev = String(oldText || '');
    const next = String(newText || '');
    if (!prev || !next || prev === next) return;
    const { pre, suf, n, m } = commonAffix(prev, next);
    if (pre + suf <= 0) return;
    const delta = m - n;
    const sufNew = m - suf;
    let oldIdx;
    let newIdx;
    for (let i = 0; i < (segs || []).length; i++) {
      if (Array.isArray(tokensBySeg[i])) continue;
      const start = Number(segs[i]?.start) || 0;
      const end = Number(segs[i]?.end) || 0;
      let oldFrom;
      let oldTo;
      if (end <= pre) {
        oldFrom = start;
        oldTo = end;
      } else if (start >= sufNew) {
        oldFrom = start - delta;
        oldTo = end - delta;
      } else {
        continue;
      }
      if (!paintedOldRange(oldSegs, oldTokensBySeg, oldFrom, oldTo)) continue;
      oldIdx ||= globalThis.IL_createTextIndex(prev);
      newIdx ||= globalThis.IL_createTextIndex(next);
      const c0 = oldIdx.utf16ToCp(oldFrom);
      const c1 = oldIdx.utf16ToCp(oldTo);
      const inside = oldTokensBySeg.flat().filter((tok) => {
        const off = tok?.offset;
        return Array.isArray(off) && off[0] >= c0 && off[1] <= c1;
      });
      tokensBySeg[i] = shiftTokenOffsets(inside, newIdx.utf16ToCp(start) - c0);
    }
  }

  return {
    KEY_DYNAMIC_TRACK,
    POLL_MS,
    CONTINUE_AFTER_SEGMENTS,
    TWEAK_RATIO,
    TWEAK_ABS,
    isSmallTweak,
    reconcileSegments,
    remapCommitted,
    shouldAskContinue,
    nextContinueBudget,
    mutationsWorthWatching,
    createPoller,
    createTrack,
    planFill,
  };
})();
