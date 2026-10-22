/**
 * 正文提取 + 码点偏移 → Range；网页 token 只绑 CSS Custom Highlight（勿 getClientRects）。
 * PDF：canvas 已含字形；色块会盖在字上、字色也改不了 canvas，resolvePaintStyle 回退成 overlay 红线（粗细随字盒高）。
 * 进度图量段 Y 例外，想法来自 extension/semantic-highlight/semantic/find.js（横轴=文档 Y / 视口带 / 点击跳转）。
 *
 * 段：切分力度 = 语义 800 字节 × 倍数。每次送 1 段前文 + 本段（1:1），只画本段。
 * 太短则左文不够、预测不准；太长则单次内存/耗时上去、首块上色更晚。约 400 token/段、800 token/窗，离 max_length=2000 仍宽裕，不必对齐本机 128 / 远程 256 的推理切块。
 * 骑在段界上的 BPE token：offset 裁进本段，不画进前文、也不丢掉本段侧。
 * 进度图：竖轴默认 4–8 bit；分析中亮空框，段回了加线；后一段从上一线终点起；不自动跟滚。
 */
(() => {
  if (!globalThis.IH_highlightStyle) {
    throw new Error('IH_highlightStyle missing — inject highlightStyle.js first');
  }
  if (!globalThis.IH_optionDefaults || typeof globalThis.IH_optionStored !== 'function') {
    throw new Error('IH_optionDefaults missing — inject optionDefaults.js first');
  }
  if (typeof globalThis.IH_mergeWordTokens !== 'function') {
    throw new Error('IH_mergeWordTokens missing — inject wordMerge.js first');
  }
  if (!globalThis.IH_cloudWait) {
    throw new Error('IH_cloudWait missing — inject cloudWait.js first');
  }
  if (!globalThis.IH_dynamicTrack) {
    throw new Error('IH_dynamicTrack missing — inject dynamicTrack.js first');
  }
  const { tr } = globalThis.IH_i18n;
  const HS = globalThis.IH_highlightStyle;
  const optionStored = globalThis.IH_optionStored;
  /** SYNC: client/src/shared/core/constants.ts → SEMANTIC_CHUNK_BYTES */
  const UNIT_BYTES = 800;
  const UNIT_MULTIPLIER = 2;
  const CONTEXT_UNITS = 1;
  const TOKEN_LEVELS = HS.TOKEN_LEVELS;
  const HL_PREFIX = 'ih-token-';
  /** SYNC: extension/semantic-highlight/semantic/find.js → HL_UNDERLINE（命名空间 ih-，避免和语义插件互踩） */
  const HL_UNDERLINE = 'ih-underline';
  /** debug：右键「划出可提取文本」；整份 mapped.text → ::highlight */
  const HL_EXTRACT_PREVIEW = 'ih-extract-preview';
  let extractPreviewOn = false;
  const HOST_ID = 'ih-progress-host';
  const HOST_CSS = `
:host {
  all: initial;
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 2147483646;
  display: block;
  width: max-content;
  max-width: calc(100vw - 32px);
  pointer-events: none;
}
.semantic-find-bar-host {
  position: static;
  margin: 0;
  padding: 0;
  width: 338px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  box-sizing: border-box;
  pointer-events: none;
}
.semantic-match-progress {
  margin-top: 0;
  height: 36px;
}
.semantic-match-progress[hidden] + .semantic-find-status-list > :first-child {
  margin-top: 0;
}
`;
  /** SYNC: client/src/shared/cross/surprisalMath.ts → REFERENCE_MAX_SURPRISAL_BITS */
  const MAX_SURPRISAL_BITS = HS.MAX_SURPRISAL_BITS;
  const PROGRESS_BITS_MIN = 4;
  const PROGRESS_BITS_MAX = 8;
  /** SYNC: extension/semantic-highlight/semantic/find.js → PROGRESS_MIN_WIDTH_PX / VIEWPORT_FOCUS_Y_RATIO / CHUNK_START_MAX_Y_RATIO */
  const PROGRESS_MIN_WIDTH_PX = 2;
  const VIEWPORT_FOCUS_Y_RATIO = 0.5;
  const CHUNK_START_MAX_Y_RATIO = 0.2;
  const SELECT_HOLD_MS = 1000;
  /** shared/page/scrollGeometry.js：滚动容器与文档 Y 的换算 */
  const geo = () => globalThis.IL_scrollGeometry;
  const progressAxis = globalThis.IL_progressAxis;
  if (!progressAxis) throw new Error('IL_progressAxis missing — inject progressAxis.js first');

  function requireOverlay() {
    if (!globalThis.IL_overlay) throw new Error('IL_overlay missing — inject overlay.js first');
    return globalThis.IL_overlay;
  }

  function requireFns() {
    if (typeof globalThis.IL_findArticleRoot !== 'function') {
      throw new Error('IL_findArticleRoot missing — inject articleRoot.js first');
    }
    if (typeof globalThis.IL_collectTextMap !== 'function') {
      throw new Error('IL_collectTextMap missing — inject collectTextMap.js first');
    }
  }

  const DT = globalThis.IH_dynamicTrack;
  const KEY_ARTICLE_ONLY = 'ih_article_only';
  const KEY_FROM_VIEWPORT = 'ih_from_viewport';
  const KEY_WORD_MERGE = 'ih_word_merge';
  const KEY_DYNAMIC_TRACK = DT.KEY_DYNAMIC_TRACK;
  let articleOnly = globalThis.IH_optionDefaults[KEY_ARTICLE_ONLY];
  let fromViewport = globalThis.IH_optionDefaults[KEY_FROM_VIEWPORT];
  let wordMerge = globalThis.IH_optionDefaults[KEY_WORD_MERGE];
  let dynamicTrack = globalThis.IH_optionDefaults[KEY_DYNAMIC_TRACK];

  function extractPage() {
    requireFns();
    const root = globalThis.IL_findArticleRoot(document, {
      articleOnly: globalThis.IH_OPTIONS_PAGE ? false : articleOnly,
    });
    let mapped = globalThis.IL_collectTextMap(root);
    const reorderMapped = globalThis.IL_reorderMappedByVisual;
    if (typeof reorderMapped === 'function') mapped = reorderMapped(mapped);
    if (!mapped.text || !mapped.pieces.length) {
      throw new Error('No article text');
    }
    return mapped;
  }

  function useFromViewport() {
    // 网页和 PDF 一样：动态跟踪开着时从视口起；关掉则看「从当前屏幕位置开始」。
    return dynamicTrack || fromViewport;
  }

  /** 段在文档里的 Y。已画段滚动复用；未画段每次现量。换 mapped、布局变、清进度才丢。 */
  let segYCache = new Map();
  let segYMapped = null;
  let segYRo = null;

  function dropSegYCache() {
    segYCache = new Map();
  }

  function unbindSegYObserver() {
    segYRo?.disconnect();
    segYRo = null;
    window.removeEventListener('resize', dropSegYCache);
    window.visualViewport?.removeEventListener('resize', dropSegYCache);
  }

  function bindSegYObserver(root) {
    unbindSegYObserver();
    if (typeof ResizeObserver === 'function' && root) {
      segYRo = new ResizeObserver(dropSegYCache);
      segYRo.observe(root);
    }
    window.addEventListener('resize', dropSegYCache);
    window.visualViewport?.addEventListener('resize', dropSegYCache);
  }

  function clearSegYCache() {
    unbindSegYObserver();
    dropSegYCache();
    segYMapped = null;
  }

  /** 每段的内容坐标 y（量不到为空）与当前视口。tokensBySeg 有则未画段不走缓存。 */
  function measureSegsInViewport(mapped, segs, tokensBySeg) {
    const scrollRoot = geo().findScrollRoot(mapped.root);
    const view = geo().viewportContentY(scrollRoot);
    if (segYMapped !== mapped) {
      dropSegYCache();
      segYMapped = mapped;
      bindSegYObserver(mapped.root);
    }
    const rangesOf = (u0, u1) => rangesFromUtf16(mapped.pieces, mapped.text, u0, u1);
    const ys = segs.map((seg, i) => progressAxis.measureChunkContentY(
      seg,
      scrollRoot,
      Array.isArray(tokensBySeg?.[i]) ? segYCache : new Map(),
      rangesOf,
    ));
    return { ys, view };
  }

  /**
   * 勾选「从当前屏幕位置开始」时，视口上沿起的段下标。未勾选、或一段都量不到，为 0。
   * 要扫完全部段：屏幕上的页眉可能排在已经滚出视口的正文前面。
   * @param {{ pieces: { node: Text, start: number, end: number }[], text: string, root: Element }} mapped
   * @param {{ start: number, end: number }[]} segs utf16 偏移
   */
  function viewportSegmentStart(mapped, segs) {
    if (!useFromViewport()) {
      lastViewportFrom = 0;
      return 0;
    }
    if (!mapped?.root?.isConnected || !Array.isArray(segs) || segs.length === 0) return 0;
    const { ys, view } = measureSegsInViewport(mapped, segs);
    lastViewportFrom = geo().segmentIndexFromViewportTop(ys, view.top);
    return lastViewportFrom;
  }

  /**
   * inView：与视口相交的段（多列可跳跃）；一段都不相交则退回视口上沿那一段。
   * below：视口下方一屏内的段，离视口近的在前。
   * tokensBySeg 有则未画段现量 Y，滑回时不用旧坐标。
   * @returns {{ inView: number[], below: number[], top: number }}
   */
  function viewportSegments(mapped, segs, tokensBySeg) {
    if (!mapped?.root?.isConnected || !Array.isArray(segs) || segs.length === 0) {
      return { inView: [], below: [], top: 0 };
    }
    const { ys, view } = measureSegsInViewport(mapped, segs, tokensBySeg);
    const reach = view.bottom + (view.bottom - view.top);
    const inView = [];
    const below = [];
    for (let i = 0; i < ys.length; i++) {
      const cy = ys[i];
      if (!cy || cy.y1 < view.top || cy.y0 > reach) continue;
      (cy.y0 > view.bottom ? below : inView).push(i);
    }
    below.sort((a, b) => ys[a].y0 - ys[b].y0);
    if (!inView.length) inView.push(geo().segmentIndexFromViewportTop(ys, view.top));
    return { inView, below, top: view.top };
  }

  /** @param {string} text */
  function splitSegments(text) {
    const split = globalThis.IL_splitTextToChunks;
    if (typeof split !== 'function') {
      throw new Error('IL_splitTextToChunks missing — inject splitTextToChunks.js first');
    }
    return split(text, UNIT_BYTES * UNIT_MULTIPLIER).map((raw) => ({
      start: raw.startOffset,
      end: raw.startOffset + raw.text.length,
      text: raw.text,
    }));
  }

  /**
   * 请求文本 = 原文连续切片（前文 + 本段），避免拼段造成新的 BPE 边界。
   * @param {string} text
   * @param {{ start: number, end: number, text: string }[]} segs
   * @param {number} i
   */
  function segmentWindow(text, segs, i) {
    if (i < 0 || i >= segs.length) throw new Error('segment index out of range');
    const idx = globalThis.IL_createTextIndex(text);
    const ctxFrom = Math.max(0, i - CONTEXT_UNITS);
    const utf16Start = segs[ctxFrom].start;
    return {
      requestText: text.slice(utf16Start, segs[i].end),
      originCp: idx.utf16ToCp(utf16Start),
      segStartCp: idx.utf16ToCp(segs[i].start),
      segEndCp: idx.utf16ToCp(segs[i].end),
    };
  }

  /**
   * 请求坐标 → 全文码点；只保留与本段相交的部分。
   * @param {Array<{ offset: [number, number] }>} tokens
   * @param {{ originCp: number, segStartCp: number, segEndCp: number }} win
   */
  function tokensInSegment(tokens, win) {
    const out = [];
    for (const tok of tokens) {
      const off = tok.offset;
      if (!Array.isArray(off) || off.length < 2) {
        throw new Error('Analyze token missing offset');
      }
      const s = off[0] + win.originCp;
      const e = off[1] + win.originCp;
      const c0 = Math.max(s, win.segStartCp);
      const c1 = Math.min(e, win.segEndCp);
      if (c1 <= c0) continue;
      out.push({ ...tok, offset: [c0, c1] });
    }
    return out;
  }

  /**
   * @param {{ node: Text, start: number, end: number }[]} pieces
   * @param {string} text
   * @param {number} u0
   * @param {number} u1
   * @returns {Range[]}
   */
  /**
   * 单 piece 上建 Range；节点失效或偏移越界则跳过（不抛），便于动态页局部放弃。
   */
  function rangeForPiece(p, text, seg0, seg1) {
    if (!p?.node?.isConnected) return null;
    const nodeText = p.node.nodeValue ?? p.node.data;
    if (nodeText == null) return null;
    const nodeLen = nodeText.length;
    const startOff = seg0 - p.start;
    const endOff = seg1 - p.start;
    if (startOff < 0 || endOff > nodeLen || endOff <= startOff) return null;
    if (!/\S/.test(text.slice(seg0, seg1))) return null;
    const r = document.createRange();
    try {
      r.setStart(p.node, startOff);
      r.setEnd(p.node, endOff);
    } catch {
      return null;
    }
    return r.collapsed ? null : r;
  }

  function rangesFromUtf16(pieces, text, u0, u1) {
    if (u1 <= u0) return [];
    let i = globalThis.IL_findPieceIndex(pieces, u0);
    if (i < 0) return [];
    const out = [];
    for (; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.start >= u1) break;
      const seg0 = Math.max(u0, p.start);
      const seg1 = Math.min(u1, p.end);
      if (seg1 <= seg0) continue;
      const r = rangeForPiece(p, text, seg0, seg1);
      if (r) out.push(r);
    }
    return out;
  }

  function requireHighlightApi() {
    if (!CSS.highlights || typeof Highlight !== 'function') {
      throw new Error('CSS Custom Highlight API missing');
    }
  }

  let originColorByEl = new WeakMap();

  function originCssColor(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) throw new Error('origin color: no element');
    const hit = originColorByEl.get(el);
    if (hit) return hit;
    const c = getComputedStyle(el).color;
    if (!c) throw new Error('origin color empty');
    originColorByEl.set(el, c);
    return c;
  }

  /**
   * 改样式表前先读完原文色。边画边 getComputedStyle 会撞上刚插入的 ::highlight，整页重算。
   * 淡去/字色比例写进 insertRule（不用 :root 的 var），超大页插表才快；见 textFgSheet 与 Dark Reader。
   */
  function rememberOriginColors(mapped) {
    for (const p of mapped.pieces) {
      if (!p?.node?.isConnected) continue;
      originCssColor(p.node);
    }
  }

  function tokenHighlightNames() {
    const keys = CSS.highlights.keys?.();
    if (!keys) {
      return Array.from({ length: TOKEN_LEVELS }, (_, i) => HL_PREFIX + i);
    }
    return [...keys].filter((name) => name.startsWith(HL_PREFIX));
  }

  function textFgSheet() {
    let el = document.getElementById('ih-text-fg-css');
    if (el) return el.sheet;
    el = document.createElement('style');
    el.id = 'ih-text-fg-css';
    // Dark Reader：class darkreader 的 <style> 它不改。淡去/字色规则里写死 rgb 与百分比（为插表性能不用 var）。
    // 改前用 var(--ih-fade-pct-*) 时实测 DR 下正常；改后字面量规则会被 DR 二次改色，须保留本 class，与性能优化不冲突。
    el.className = 'darkreader';
    document.documentElement.appendChild(el);
    return el.sheet;
  }

  /** 字色/淡去规则写死了当时的原文色；主题变了必须丢掉再画。 */
  function forgetTextFg() {
    originColorByEl = new WeakMap();
    document.getElementById('ih-text-fg-css')?.remove();
    if (!CSS.highlights?.delete) return;
    const base = new RegExp(`^${HL_PREFIX}\\d+$`);
    for (const name of tokenHighlightNames()) {
      if (base.test(name)) continue;
      CSS.highlights.delete(name);
    }
  }

  /** 原文色/rgb 进 Highlight 名前先洗成合法标识，两处共用，改一处即全改 */
  function identForHighlightName(s) {
    return String(s).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function textCoveragePct(level) {
    const maxAlpha = HS.depthToMaxAlpha(highlightPrefs.maxAlphaDepth, HS.PAINT_TEXT);
    return HS.alphaForLevel(level, maxAlpha, highlightPrefs.twoTier) * 100;
  }

  function highlightForTextRange(range, level) {
    const origin = originCssColor(range.startContainer);
    const rgb = HS.rgbForTextColor(highlightPrefs.textColor);
    const name = `${HL_PREFIX}${level}-${identForHighlightName(origin)}-${identForHighlightName(rgb)}`;
    if (!CSS.highlights.has(name)) {
      const h = new Highlight();
      h.priority = level;
      CSS.highlights.set(name, h);
      const sheet = textFgSheet();
      sheet.insertRule(
        // 覆盖率：线性光 lerp。Oklab 会把前半段混成浑浊深色。
        `::highlight(${name}){background-color:transparent;color:color-mix(in srgb-linear,rgb(${rgb}) ${textCoveragePct(level)}%,${origin})}`,
        sheet.cssRules.length,
      );
    }
    const h = CSS.highlights.get(name);
    if (!h) throw new Error(`highlight missing: ${name}`);
    return h;
  }

  /** 淡去：只混原文色与透明；不透明度写进规则（改 fadeMinPct 要重画），勿改回 var 除非同时验证超大页性能与 DR。 */
  function highlightForFadeRange(range, level) {
    const origin = originCssColor(range.startContainer);
    const name = `${HL_PREFIX}fade-${level}-${identForHighlightName(origin)}`;
    if (!CSS.highlights.has(name)) {
      const h = new Highlight();
      h.priority = level;
      CSS.highlights.set(name, h);
      const pct = HS.fadeOpacityForLevel(level, highlightPrefs.fadeMinPct) * 100;
      const sheet = textFgSheet();
      sheet.insertRule(
        `::highlight(${name}){background-color:transparent;color:color-mix(in srgb,${origin} ${pct}%,transparent)}`,
        sheet.cssRules.length,
      );
    }
    const h = CSS.highlights.get(name);
    if (!h) throw new Error(`highlight missing: ${name}`);
    return h;
  }

  function ensureHighlightRegistry() {
    requireHighlightApi();
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      const name = HL_PREFIX + i;
      if (!CSS.highlights.has(name)) {
        const h = new Highlight();
        h.priority = i;
        CSS.highlights.set(name, h);
      }
    }
    if (!CSS.highlights.has(HL_UNDERLINE)) {
      const h = new Highlight();
      h.priority = TOKEN_LEVELS + 2;
      CSS.highlights.set(HL_UNDERLINE, h);
    }
    if (!CSS.highlights.has(HL_EXTRACT_PREVIEW)) {
      const h = new Highlight();
      h.priority = TOKEN_LEVELS + 3;
      CSS.highlights.set(HL_EXTRACT_PREVIEW, h);
    }
  }

  function clearUnderline() {
    CSS.highlights?.get(HL_UNDERLINE)?.clear();
  }

  let extractPreviewSched = null;
  let extractPreviewObs = null;
  /** @type {(() => void) | null} */
  let extractPreviewOnVisible = null;

  function stopExtractPreviewLive() {
    extractPreviewSched?.stop();
    extractPreviewSched = null;
    extractPreviewObs?.disconnect();
    extractPreviewObs = null;
    if (extractPreviewOnVisible) {
      document.removeEventListener('visibilitychange', extractPreviewOnVisible);
      extractPreviewOnVisible = null;
    }
  }

  function clearExtractPreview() {
    stopExtractPreviewLive();
    CSS.highlights?.get(HL_EXTRACT_PREVIEW)?.clear();
    extractPreviewOn = false;
  }

  function refreshExtractPreview() {
    try {
      paintExtractPreview(extractPage());
    } catch (err) {
      console.warn('[Info Highlight] extract preview', err);
      clearExtractPreview();
    }
  }

  /** 与动态跟踪一致：关 = 开时抽一次；开 = 变动停稳后 IH_extractPage 再划线。 */
  function startExtractPreviewLive() {
    stopExtractPreviewLive();
    if (!globalThis.IH_isDynamicTrack?.()) return;
    const DT = globalThis.IH_dynamicTrack;
    if (!DT?.createPoller) return;
    extractPreviewSched = DT.createPoller({
      intervalMs: DT.POLL_MS,
      isEnabled: () => extractPreviewOn,
      isHidden: () => document.hidden,
      isBusy: () => false,
      snapshot: () => ({
        mark: `${window.scrollY}|${document.documentElement?.innerHTML?.length ?? 0}`,
        run: true,
      }),
      run: () => refreshExtractPreview(),
    });
    extractPreviewSched.start();
    extractPreviewOnVisible = () => {
      if (!document.hidden && extractPreviewOn) extractPreviewSched?.onVisible();
    };
    document.addEventListener('visibilitychange', extractPreviewOnVisible);
    if (typeof MutationObserver === 'function' && document.documentElement) {
      extractPreviewObs = new MutationObserver((records) => {
        if (!DT.mutationsWorthWatching(records)) return;
        globalThis.IH_pruneDetachedHighlights?.();
        extractPreviewSched?.markDirty();
      });
      extractPreviewObs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  /** @param {Highlight} h @param {number} cp0 @param {number} cp1 */
  function addCpRangesToUnderlineHighlight(h, cp0, cp1) {
    if (!progressMapped || !progressIdx || cp1 <= cp0) return;
    const u0 = progressIdx.cpToUtf16(cp0);
    const u1 = progressIdx.cpToUtf16(cp1);
    for (const range of rangesFromUtf16(progressMapped.pieces, progressMapped.text, u0, u1)) {
      if (!/\S/.test(range.toString())) continue;
      h.add(range);
    }
  }

  /** @param {{ text: string, pieces: Array<{ node: Text, start: number, end: number }> }} mapped */
  function paintExtractPreview(mapped) {
    ensureHighlightRegistry();
    const h = CSS.highlights.get(HL_EXTRACT_PREVIEW);
    if (!h) throw new Error(`highlight missing: ${HL_EXTRACT_PREVIEW}`);
    h.clear();
    const len = mapped?.text?.length || 0;
    if (!len || !mapped.pieces?.length) return;
    for (const range of rangesFromUtf16(mapped.pieces, mapped.text, 0, len)) {
      if (!/\S/.test(range.toString())) continue;
      h.add(range);
    }
    extractPreviewOn = true;
  }

  /** @returns {boolean} 开为 true，关为 false */
  function toggleExtractPreview() {
    if (extractPreviewOn) {
      clearExtractPreview();
      return false;
    }
    refreshExtractPreview();
    if (!extractPreviewOn) return false;
    startExtractPreviewLive();
    return true;
  }

  /**
   * SYNC: extension/semantic-highlight/semantic/find.js → setCurrentUnderlines / addCpRangeToHighlight
   * @param {{ start: number, end: number }[]} chunks
   */
  function paintUnderlines(chunks) {
    ensureHighlightRegistry();
    const h = CSS.highlights.get(HL_UNDERLINE);
    if (!h) throw new Error(`highlight missing: ${HL_UNDERLINE}`);
    h.clear();
    if (!progressMapped || !progressIdx) return;
    for (const chunk of chunks) {
      addCpRangesToUnderlineHighlight(h, chunk.start, chunk.end);
    }
  }

  /**
   * PDF：canvas 已含字形，::highlight 底色会盖在字上，token 改画 overlay 红线。
   * 缩放后 viewer 会 replaceChildren 掉整棵页树，这些线随之消失，重画即自愈。
   * @type {HTMLElement[]}
   */
  let tokenOverlayEls = [];

  /** @type {{ bags: unknown[][], mapped: { text: string, pieces: unknown[], root?: Element } | null, overlay: boolean }} */
  let paintBuf = { bags: [], mapped: null, overlay: false };

  /** @type {{ twoTier: boolean, thresholdPct: number, maxAlphaDepth: number, fadeMinPct: number, fadeNorm: boolean, fadeNormPct: number, paintStyle: string }} */
  let highlightPrefs = HS.normalizePrefs(globalThis.IH_optionDefaults);

  function emptyPaintBuf() {
    return { bags: [], mapped: null, overlay: false };
  }

  function paintBufReady() {
    return !!(paintBuf.mapped && paintBuf.bags.length);
  }

  /** 正文坐标变了、页面上 range 没动时：重绘缓冲换成新坐标的 token。 */
  function resetPaintBuf(mapped, tokensBySeg) {
    paintBuf = { bags: tokensBySeg.filter((bag) => bag?.length), mapped, overlay: false };
  }

  function tokenMaxAlpha() {
    return HS.depthToMaxAlpha(highlightPrefs.maxAlphaDepth, highlightPrefs.paintStyle, 'pdf');
  }

  function applyTokenColors() {
    HS.applyCssVars(document.documentElement, highlightPrefs);
  }

  function clearTokenOverlays() {
    for (const el of tokenOverlayEls) el.remove();
    tokenOverlayEls = [];
  }

  /** 清 token 画布（Highlight + PDF 线），保留进度下划线与 paintBuf */
  function clearTokenPaints() {
    clearTokenOverlays();
    if (!CSS.highlights) return;
    for (const name of tokenHighlightNames()) {
      CSS.highlights.get(name)?.clear();
    }
    forgetTextFg();
  }

  function tokenOverlayMount(root) {
    if (typeof root.querySelector !== 'function') return root;
    let host = root.querySelector('#ih-token-overlay');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'ih-token-overlay';
    root.appendChild(host);
    return host;
  }

  /** 线相对 pages root；粗细随字盒高，见 HS.underlineOverlayBox */
  function tokenOverlayContext(root) {
    if (!root) throw new Error('token overlay root missing');
    const mount = tokenOverlayMount(root);
    return {
      root: mount,
      rect: root.getBoundingClientRect(),
    };
  }

  function appendTokenUnderline(rect, level, ctx, parent) {
    const box = HS.underlineOverlayBox(rect, ctx.rect);
    const el = document.createElement('div');
    el.className = 'il-token-underline';
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.style.transform = 'none';
    const a = HS.alphaForLevel(
      level,
      tokenMaxAlpha(),
      highlightPrefs.twoTier,
    );
    el.style.backgroundColor = `rgba(${HS.rgbForColor(highlightPrefs.highlightColor)}, ${a})`;
    (parent || ctx.root).appendChild(el);
    tokenOverlayEls.push(el);
  }

  function rangeLive(range) {
    const a = range.startContainer;
    const b = range.endContainer;
    return !!(a && b && a.isConnected && b.isConnected && !range.collapsed);
  }

  /** 画完之后 DOM 再变：只丢掉映不回的 range，不重抽、不重画。只动本插件登记。 */
  function pruneDetachedHighlights() {
    if (!CSS.highlights) return;
    const visit = (h) => {
      if (!h || typeof h.delete !== 'function') return;
      for (const range of [...h]) {
        if (!rangeLive(range)) h.delete(range);
      }
    };
    for (const name of tokenHighlightNames()) visit(CSS.highlights.get(name));
    visit(CSS.highlights.get(HL_UNDERLINE));
    visit(CSS.highlights.get(HL_EXTRACT_PREVIEW));
  }

  /**
   * 重画这一段前：删掉与 [start, end) 重叠的旧 token 高亮。
   * 只贴着边界的邻段留下。不碰进度下划线。
   */
  function dropTokenRangesOverlapping(mapped, start, end) {
    if (!CSS.highlights || !(end > start)) return;
    const pieces = mapped?.pieces;
    if (!pieces?.length) return;
    const at = (node, offset) => {
      for (const p of pieces) {
        if (p.node !== node) continue;
        const span = p.end - p.start;
        if (offset < 0 || offset > span) continue;
        return p.start + offset;
      }
      return null;
    };
    const visit = (h) => {
      if (!h || typeof h.delete !== 'function') return;
      for (const range of [...h]) {
        const a = at(range.startContainer, range.startOffset);
        const b = at(range.endContainer, range.endOffset);
        if (a == null || b == null || !(a < end && start < b)) continue;
        h.delete(range);
      }
    };
    for (const name of tokenHighlightNames()) visit(CSS.highlights.get(name));
  }

  /** 只丢掉这次重画覆盖到的节点上的旧 range，别的段不动。 */
  function dropHighlightRangesExcept(keep) {
    if (!CSS.highlights) return;
    const keepSet = new Set(keep || []);
    const nodes = new Set();
    for (const range of keepSet) {
      if (range.startContainer) nodes.add(range.startContainer);
      if (range.endContainer) nodes.add(range.endContainer);
    }
    const visit = (h) => {
      if (!h || typeof h.delete !== 'function') return;
      for (const range of [...h]) {
        if (keepSet.has(range)) continue;
        if (!nodes.has(range.startContainer) && !nodes.has(range.endContainer)) continue;
        h.delete(range);
      }
    };
    for (const name of tokenHighlightNames()) visit(CSS.highlights.get(name));
    visit(CSS.highlights.get(HL_UNDERLINE));
  }

  let liveWatch = null;
  let liveWatchTimer = 0;

  function stopHighlightLiveWatch() {
    liveWatch?.disconnect();
    liveWatch = null;
    if (liveWatchTimer) {
      clearTimeout(liveWatchTimer);
      liveWatchTimer = 0;
    }
  }

  function watchHighlightLive() {
    stopHighlightLiveWatch();
    const root = document.documentElement;
    if (!root || typeof MutationObserver !== 'function') return;
    liveWatch = new MutationObserver(() => {
      if (liveWatchTimer) return;
      liveWatchTimer = window.setTimeout(() => {
        liveWatchTimer = 0;
        pruneDetachedHighlights();
      }, 120);
    });
    liveWatch.observe(root, { childList: true, subtree: true });
  }

  function clearHighlights() {
    stopHighlightLiveWatch();
    clearTokenPaints();
    clearUnderline();
    clearExtractPreview();
    paintBuf = emptyPaintBuf();
  }

  /** 非空白字符数；没有 raw 时用 offset 跨度 */
  function fadeTextWeight(tok) {
    if (typeof tok?.raw === 'string' && tok.raw) {
      let n = 0;
      for (const ch of tok.raw) {
        if (!/\s/u.test(ch)) n += 1;
      }
      return n;
    }
    const off = tok?.offset;
    if (Array.isArray(off) && off.length >= 2 && off[1] > off[0]) return off[1] - off[0];
    return 0;
  }

  function fadeScaleBitsFor(list) {
    if (!highlightPrefs.fadeNorm || highlightPrefs.paintStyle !== HS.PAINT_FADE) return null;
    const samples = [];
    for (const tok of list) {
      const bits = tokenBits(tok);
      const weight = fadeTextWeight(tok);
      if (bits == null || !(weight > 0)) continue;
      samples.push({ bits, weight });
    }
    return HS.fadeNormScaleBits(samples, highlightPrefs.fadeNormPct);
  }

  /**
   * classic = token bits（站点默认 tokenRenderStyle）。
   * SYNC: client/src/shared/core/Util.ts → calculateSurprisal（p≤0 用 EPSILON 托底）
   * @param {{ p?: number | null, real_topk?: [number, number] | null }} tok
   * @returns {number | null}
   */
  function tokenBits(tok) {
    const p = Number.isFinite(tok?.p) ? tok.p : tok?.real_topk?.[1];
    if (!Number.isFinite(p)) return null;
    return -Math.log2(Math.max(p, Number.EPSILON));
  }

  /** @param {{ p?: number | null, real_topk?: [number, number] | null }} tok */
  function tokenLevel(tok, scaleBits) {
    const bits = tokenBits(tok);
    if (bits == null) return -1;
    if (highlightPrefs.paintStyle === HS.PAINT_FADE) return HS.tokenLevelForFade(bits, scaleBits);
    return HS.tokenLevelFromBits(bits, highlightPrefs);
  }

  /** @param {Array<{ real_topk?: [number, number] | null }>} tokens */
  function averageBits(tokens) {
    let sum = 0;
    let n = 0;
    for (const tok of tokens) {
      const bits = tokenBits(tok);
      if (bits == null) continue;
      sum += bits;
      n += 1;
    }
    return n ? sum / n : null;
  }

  function repaintFromBuffer() {
    const { bags, mapped, overlay } = paintBuf;
    if (!mapped || !bags.length) return;
    clearTokenPaints();
    paintBuf = emptyPaintBuf();
    for (const bag of bags) {
      paintTokens(bag, mapped, { append: true, overlay });
    }
  }

  /**
   * @param {Array<{ offset: [number, number], raw?: string, real_topk?: [number, number] | null }>} tokens
   * @param {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root?: Element }} mapped
   * @param {{ append?: boolean, overlay?: boolean, keepExisting?: boolean, keep?: Range[], skipMerge?: boolean, index?: unknown, scaleFrom?: unknown[], bag?: unknown[] }} [opts]
   * @returns {{ painted: number, tokens_in: number, tokens_skip_level: number, tokens_skip_empty_range: number }}
   */
  function paintTokens(tokens, mapped, opts) {
    ensureHighlightRegistry();
    if (!opts?.append) {
      if (!opts?.keepExisting) clearTokenPaints();
      paintBuf = emptyPaintBuf();
    }
    paintBuf.mapped = mapped;
    paintBuf.overlay = !!opts?.overlay;
    const incoming = Array.isArray(tokens) ? tokens : [];
    if (opts?.bag?.length) paintBuf.bags.push(opts.bag);
    else if (!opts?.skipMerge && incoming.length) paintBuf.bags.push(incoming);

    const overlay = opts?.overlay ? tokenOverlayContext(mapped.root) : null;
    if (overlay && HS.resolvePaintStyle(highlightPrefs.paintStyle, 'pdf') !== HS.PAINT_UNDERLINE) {
      throw new Error('PDF paint fallback is underline only');
    }
    const idx = opts?.index || globalThis.IL_createTextIndex(mapped.text);
    const list = opts?.skipMerge ? incoming : tokensForPaint(incoming, mapped.text);
    const scaleBits = fadeScaleBitsFor(Array.isArray(opts?.scaleFrom) ? opts.scaleFrom : list);
    const overlayParent = overlay ? document.createDocumentFragment() : null;
    const fadePaint = !overlay && highlightPrefs.paintStyle === HS.PAINT_FADE;
    const textPaint = !overlay && highlightPrefs.paintStyle === HS.PAINT_TEXT;
    if (fadePaint || textPaint) rememberOriginColors(mapped);
    const stats = {
      painted: 0,
      tokens_in: list.length,
      tokens_skip_level: 0,
      tokens_skip_empty_range: 0,
    };
    for (const tok of list) {
      const level = tokenLevel(tok, scaleBits);
      if (fadePaint ? level < 0 : level < 1) {
        stats.tokens_skip_level += 1;
        continue;
      }
      const off = tok.offset;
      if (!Array.isArray(off) || off.length < 2) {
        throw new Error('Analyze token missing offset');
      }
      const u0 = idx.cpToUtf16(off[0]);
      const u1 = idx.cpToUtf16(off[1]);
      const h = overlay || textPaint || fadePaint ? null : CSS.highlights.get(HL_PREFIX + level);
      if (!overlay && !textPaint && !fadePaint && !h) {
        throw new Error(`highlight missing: ${HL_PREFIX}${level}`);
      }
      let n = 0;
      for (const range of rangesFromUtf16(mapped.pieces, mapped.text, u0, u1)) {
        if (!/\S/.test(range.toString())) continue;
        if (!overlay) {
          const dest = fadePaint
            ? highlightForFadeRange(range, level)
            : textPaint
              ? highlightForTextRange(range, level)
              : h;
          dest.add(range);
          if (opts?.keep) opts.keep.push(range);
          n += 1;
          continue;
        }
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          appendTokenUnderline(r, level, overlay, overlayParent);
          n += 1;
        }
      }
      if (n === 0) stats.tokens_skip_empty_range += 1;
      else stats.painted += n;
    }
    if (overlayParent) overlay.root.appendChild(overlayParent);
    return stats;
  }

  function tokensForPaint(tokens, text) {
    const incoming = Array.isArray(tokens) ? tokens : [];
    return wordMerge ? globalThis.IH_mergeWordTokens(incoming, text) : incoming;
  }

  function libraryChildIndex(node) {
    let i = 0;
    for (let n = node.parentNode?.firstChild; n && n !== node; n = n.nextSibling) i += 1;
    return i;
  }

  function libraryPathFrom(node, until) {
    const path = [];
    let n = node;
    while (n && n !== until) {
      const parent = n.parentNode;
      if (!parent) return null;
      path.push(libraryChildIndex(n));
      n = parent;
    }
    return n === until ? path.reverse() : null;
  }

  function libraryNodeAt(root, path) {
    let n = root;
    for (const i of path) {
      n = n.childNodes[i];
      if (!n) return null;
    }
    return n;
  }

  /** 收藏：live 节点在 documentElement 克隆上的对应节点（烘 mark 后用）。 */
  function libraryTwinInClone(liveNode, cloneRoot, until) {
    const root = until || document.documentElement;
    const path = libraryPathFrom(liveNode, root);
    if (!path) return null;
    return libraryNodeAt(cloneRoot, path);
  }

  function libraryStripIhVars(el) {
    const st = el?.style;
    if (!st) return;
    const names = [];
    for (let i = 0; i < st.length; i++) {
      const n = st[i];
      if (n.startsWith('--ih-')) names.push(n);
    }
    for (const n of names) st.removeProperty(n);
  }

  /**
   * 把当前页已画 token 烘进 documentElement 克隆：<mark class="ih-token-N"> + 偏好 CSS。
   * 先烘再剥脚本/插件层，路径才能对上。
   * @param {Element} cloneHtml
   */
  function bakeLibraryMarks(cloneHtml) {
    if (!cloneHtml || !paintBufReady()) return;
    const mapped = paintBuf.mapped;
    const liveHtml = document.documentElement;
    if (!mapped?.pieces?.length || !liveHtml) return;
    const idx = globalThis.IL_createTextIndex(mapped.text);
    const fadePaint = highlightPrefs.paintStyle === HS.PAINT_FADE;
    const planned = [];
    for (const bag of paintBuf.bags) {
      const list = tokensForPaint(bag, mapped.text);
      const scaleBits = fadeScaleBitsFor(list);
      for (const tok of list) {
        const level = tokenLevel(tok, scaleBits);
        if (fadePaint ? level < 0 : level < 1) continue;
        const off = tok.offset;
        if (!Array.isArray(off) || off.length < 2) continue;
        const u0 = idx.cpToUtf16(off[0]);
        const u1 = idx.cpToUtf16(off[1]);
        if (!(u1 > u0) || !/\S/.test(mapped.text.slice(u0, u1))) continue;
        planned.push({ u0, u1, level });
      }
    }
    planned.sort((a, b) => a.u0 - b.u0 || b.u1 - a.u1);
    const filtered = [];
    let cursor = 0;
    for (const m of planned) {
      if (m.u0 < cursor) continue;
      filtered.push(m);
      cursor = m.u1;
    }
    const twins = mapped.pieces.map((p) => {
      const path = p?.node ? libraryPathFrom(p.node, liveHtml) : null;
      if (!path) return null;
      const twin = libraryNodeAt(cloneHtml, path);
      if (!twin || twin.nodeType !== 3) return null;
      if (twin.nodeValue !== p.node.nodeValue) return null;
      return twin;
    });
    const byPiece = new Map();
    for (const m of filtered) {
      let i = globalThis.IL_findPieceIndex(mapped.pieces, m.u0);
      if (i < 0) continue;
      for (; i < mapped.pieces.length; i++) {
        const p = mapped.pieces[i];
        if (p.start >= m.u1) break;
        const twin = twins[i];
        if (!twin) continue;
        const localStart = Math.max(0, m.u0 - p.start);
        const localEnd = Math.min(twin.nodeValue.length, m.u1 - p.start);
        if (localEnd <= localStart) continue;
        if (!/\S/.test(twin.nodeValue.slice(localStart, localEnd))) continue;
        const rows = byPiece.get(i) || [];
        rows.push({ start: localStart, end: localEnd, level: m.level });
        byPiece.set(i, rows);
      }
    }
    const doc = cloneHtml.ownerDocument;
    for (const [i, slices] of byPiece) {
      const twin = twins[i];
      const parent = twin?.parentNode;
      if (!twin || !parent || !slices.length) continue;
      slices.sort((a, b) => a.start - b.start);
      const text = twin.nodeValue;
      const frag = doc.createDocumentFragment();
      let at = 0;
      for (const s of slices) {
        if (s.start < at) continue;
        if (s.start > at) frag.appendChild(doc.createTextNode(text.slice(at, s.start)));
        const mark = doc.createElement('mark');
        mark.className = `ih-token-${s.level}`;
        mark.textContent = text.slice(s.start, s.end);
        frag.appendChild(mark);
        at = s.end;
      }
      if (at < text.length) frag.appendChild(doc.createTextNode(text.slice(at)));
      parent.replaceChild(frag, twin);
    }
    libraryStripIhVars(cloneHtml);
    libraryStripIhVars(cloneHtml.querySelector('body'));
    cloneHtml.removeAttribute('data-ih-cs');
    let head = cloneHtml.querySelector('head');
    if (!head) {
      head = doc.createElement('head');
      cloneHtml.insertBefore(head, cloneHtml.firstChild);
    }
    head.querySelector('#ih-library-marks')?.remove();
    const el = doc.createElement('style');
    el.id = 'ih-library-marks';
    el.textContent = HS.libraryMarkCss(highlightPrefs);
    head.appendChild(el);
  }

  function applyHighlightPrefs(raw) {
    const next = HS.normalizePrefs(raw);
    // 淡去模式下强度/阈值/颜色行已隐藏，改它们不用重画；切画法自会重画。
    const fadeInvolved = next.paintStyle === HS.PAINT_FADE
      || highlightPrefs.paintStyle === HS.PAINT_FADE;
    const levelChanged = !fadeInvolved && (
      next.twoTier !== highlightPrefs.twoTier
      || next.thresholdPct !== highlightPrefs.thresholdPct
    );
    const paintStyleChanged = next.paintStyle !== highlightPrefs.paintStyle;
    const alphaChanged = !fadeInvolved && (next.maxAlphaDepth !== highlightPrefs.maxAlphaDepth
      || paintStyleChanged);
    const colorChanged = !fadeInvolved && (next.highlightColor !== highlightPrefs.highlightColor
      || next.textColor !== highlightPrefs.textColor);
    const fadeAmountChanged = next.paintStyle === HS.PAINT_FADE
      && next.fadeMinPct !== highlightPrefs.fadeMinPct;
    const fadeNormChanged = next.paintStyle === HS.PAINT_FADE
      && (next.fadeNorm !== highlightPrefs.fadeNorm
        || next.fadeNormPct !== highlightPrefs.fadeNormPct);
    highlightPrefs = next;
    applyTokenColors();
    if (
      levelChanged
      || paintStyleChanged
      || fadeNormChanged
      || ((alphaChanged || colorChanged) && paintBuf.overlay)
      || fadeAmountChanged
      || ((alphaChanged || colorChanged) && next.paintStyle === HS.PAINT_TEXT)
    ) {
      repaintFromBuffer();
    }
  }

  const prefsReady = new Promise((resolve) => {
    const get = chrome.storage?.local?.get;
    if (typeof get !== 'function') {
      resolve();
      return;
    }
    get.call(chrome.storage.local, globalThis.IH_optionDefaults, (res) => {
      applyHighlightPrefs(res);
      articleOnly = optionStored(KEY_ARTICLE_ONLY, res?.[KEY_ARTICLE_ONLY]);
      fromViewport = optionStored(KEY_FROM_VIEWPORT, res?.[KEY_FROM_VIEWPORT]);
      wordMerge = optionStored(KEY_WORD_MERGE, res?.[KEY_WORD_MERGE]);
      dynamicTrack = optionStored(KEY_DYNAMIC_TRACK, res?.[KEY_DYNAMIC_TRACK]);
      resolve();
    });
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area && area !== 'local') return;
    if (KEY_ARTICLE_ONLY in changes) {
      articleOnly = optionStored(KEY_ARTICLE_ONLY, changes[KEY_ARTICLE_ONLY].newValue);
    }
    if (KEY_FROM_VIEWPORT in changes) {
      fromViewport = optionStored(KEY_FROM_VIEWPORT, changes[KEY_FROM_VIEWPORT].newValue);
    }
    if (KEY_DYNAMIC_TRACK in changes) {
      dynamicTrack = optionStored(KEY_DYNAMIC_TRACK, changes[KEY_DYNAMIC_TRACK].newValue);
    }
    if (KEY_WORD_MERGE in changes) {
      const next = optionStored(KEY_WORD_MERGE, changes[KEY_WORD_MERGE].newValue);
      if (next !== wordMerge) {
        wordMerge = next;
        if (paintBufReady()) repaintFromBuffer();
      }
    }
    if (
      !(HS.KEY_TWO_TIER in changes)
      && !(HS.KEY_THRESHOLD_PCT in changes)
      && !(HS.KEY_MAX_ALPHA_DEPTH in changes)
      && !(HS.KEY_FADE_MIN_PCT in changes)
      && !(HS.KEY_FADE_NORM in changes)
      && !(HS.KEY_FADE_NORM_PCT in changes)
      && !(HS.KEY_PAINT_STYLE in changes)
      && !(HS.KEY_HIGHLIGHT_COLOR in changes)
      && !(HS.KEY_TEXT_COLOR in changes)
    ) {
      return;
    }
    chrome.storage.local.get(globalThis.IH_optionDefaults, (res) => {
      applyHighlightPrefs(res);
    });
  });

  HS.watchColorScheme(() => {
    applyTokenColors();
    if (
      highlightPrefs.paintStyle !== HS.PAINT_TEXT
      && highlightPrefs.paintStyle !== HS.PAINT_FADE
    ) {
      return;
    }
    if (!paintBufReady()) return;
    requestAnimationFrame(() => repaintFromBuffer());
  });

  function shortError(msg) {
    if (globalThis.IH_userErrors?.pageAnalyzeError) {
      return globalThis.IH_userErrors.pageAnalyzeError(msg);
    }
    let t = String(msg || 'Analyze failed').replace(/\s+/g, ' ').trim();
    if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(t)) {
      t = 'Cannot reach the analyze server. Try again later.';
    }
    return t.length > 120 ? t.slice(0, 119) + '…' : t;
  }

  async function noticeList() {
    await ensureHost();
    const list = ui$('ih-status-list');
    if (!list) throw new Error('ih-status-list missing');
    return list;
  }

  /** 只去掉会随新一轮分析替换的条，计费/慢速等可叠加保留。 */
  function removeStatusMatches(list, selector) {
    for (const el of list.querySelectorAll(selector)) el.remove();
  }

  function attachErrorFeedback(el, userDetail) {
    const feedback = globalThis.IL_statusFeedback;
    const ctx = globalThis.IH_feedbackContext;
    if (!feedback || !ctx) return;
    const feedbackBtn = el.querySelector('.semantic-find-status-feedback');
    if (!(feedbackBtn instanceof HTMLButtonElement)) return;
    feedback.resetButton(feedbackBtn);
    feedbackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      feedback.sendReport(
        feedbackBtn,
        ctx.buildUserReport({ label: 'Failed', detail: userDetail }),
      );
    });
  }

  let cloudWaitGen = 0;
  let cloudWaitDotTimer = null;

  function stopCloudWaitDots() {
    if (cloudWaitDotTimer != null) {
      clearInterval(cloudWaitDotTimer);
      cloudWaitDotTimer = null;
    }
  }

  function invalidateCloudWait() {
    cloudWaitGen += 1;
    stopCloudWaitDots();
  }

  /** 跟最近一次冷启动等待。分析请求一旦返回结果就清掉，不留到绘制。 */
  async function showCloudWait() {
    const gen = ++cloudWaitGen;
    stopCloudWaitDots();
    const wait = globalThis.IH_cloudWait;
    const copy = wait.status(0);
    const list = await noticeList();
    if (gen !== cloudWaitGen) return;
    removeStatusMatches(list, '[data-ih-cloud-wait]');
    const el = requireOverlay().createStatus({
      label: copy.label,
      detail: copy.detail,
      tone: 'info',
      continueHidden: true,
      feedbackHidden: true,
      onClose: clearCloudWait,
    });
    el.dataset.ihCloudWait = '1';
    list.appendChild(el);
    const labelEl = el.querySelector('.semantic-find-status-label');
    const textEl = el.querySelector('.semantic-find-status-text');
    let dot = 0;
    cloudWaitDotTimer = setInterval(() => {
      if (gen !== cloudWaitGen) return;
      dot = (dot + 1) % 3;
      const next = wait.status(dot);
      if (labelEl) labelEl.textContent = next.label;
      if (textEl) textEl.title = next.label;
    }, wait.DOT_INTERVAL_MS);
  }

  function clearCloudWait() {
    invalidateCloudWait();
    const list = ui$('ih-status-list');
    if (!list) return;
    removeStatusMatches(list, '[data-ih-cloud-wait]');
  }

  /** 一轮分析画出高亮后调用：升级带来的默认变化，没看过就提醒一次。 */
  function maybeShowPaintNotices() {
    maybeShowFadeDefaultNotice();
    maybeShowDynamicTrackNotice();
    maybeShowViewportDefaultNotice();
  }

  /** SYNC: background.js FADE_DEFAULT_NOTICE */
  const FADE_DEFAULT_NOTICE = 'ih_fade_default_notice';
  let fadeNoticeChecked = false;

  function maybeShowFadeDefaultNotice() {
    if (fadeNoticeChecked) return;
    fadeNoticeChecked = true;
    chrome.storage.local.get([FADE_DEFAULT_NOTICE, HS.KEY_PAINT_STYLE], (res) => {
      if (res?.[FADE_DEFAULT_NOTICE] !== 'pending' || HS.PAINT_STYLES.includes(res?.[HS.KEY_PAINT_STYLE])) {
        if (res?.[FADE_DEFAULT_NOTICE] === 'pending') {
          chrome.storage.local.set({ [FADE_DEFAULT_NOTICE]: 'seen' });
        }
        return;
      }
      void showFadeDefaultNotice();
    });
  }

  function dismissFadeDefaultNotice() {
    fadeNoticeChecked = true;
    chrome.storage.local.set({ [FADE_DEFAULT_NOTICE]: 'seen' });
    ui$('ih-status-list')?.parentElement?.querySelector('[data-ih-fade-notice]')?.remove();
  }

  /** 默认从视口开始是新功能：只在真正跳过内容的那一轮提醒一次。 */
  const VIEWPORT_DEFAULT_NOTICE = 'ih_viewport_default_notice';
  /** 点过 OK / 去设置后不再提醒；之前每次真跳过内容都提醒。 */
  let viewportNoticeDismissed = false;
  let lastViewportFrom = 0;

  function oneTimeNotice(key, { skip, onSeen, show }) {
    if (skip()) return;
    chrome.storage.local.get([key], (res) => {
      if (chrome.runtime?.lastError) return;
      if (res?.[key] === 'seen') {
        onSeen();
        return;
      }
      void show();
    });
  }

  function maybeShowViewportDefaultNotice() {
    if (dynamicTrack || viewportNoticeDismissed || !fromViewport || !(lastViewportFrom > 0)) return;
    oneTimeNotice(VIEWPORT_DEFAULT_NOTICE, {
      skip: () => false,
      onSeen: () => { viewportNoticeDismissed = true; },
      show: showViewportDefaultNotice,
    });
  }

  function dismissViewportDefaultNotice() {
    viewportNoticeDismissed = true;
    chrome.storage.local.set({ [VIEWPORT_DEFAULT_NOTICE]: 'seen' });
    ui$('ih-status-list')?.parentElement?.querySelector('[data-ih-viewport-notice]')?.remove();
  }

  /** 动态跟踪提醒：没看过就显示一次。 */
  const DYNAMIC_TRACK_NOTICE = 'ih_dynamic_track_notice';
  let dynamicTrackNoticeDismissed = false;

  function maybeShowDynamicTrackNotice() {
    oneTimeNotice(DYNAMIC_TRACK_NOTICE, {
      skip: () => dynamicTrackNoticeDismissed || !dynamicTrack,
      onSeen: () => { dynamicTrackNoticeDismissed = true; },
      show: showDynamicTrackNotice,
    });
  }

  function dismissDynamicTrackNotice() {
    dynamicTrackNoticeDismissed = true;
    chrome.storage.local.set({ [DYNAMIC_TRACK_NOTICE]: 'seen' });
    ui$('ih-status-list')?.parentElement?.querySelector('[data-ih-dynamic-notice]')?.remove();
  }

  async function showDynamicTrackNotice() {
    const list = await noticeList();
    const parent = list.parentElement;
    if (!parent || parent.querySelector('[data-ih-dynamic-notice]')) return;
    const el = requireOverlay().createStatus({
      label: tr('Highlight'),
      detail: tr('New: highlighting now follows scrolling and page updates. You can turn it off in settings.'),
      tone: 'info',
      continueHidden: true,
      feedbackHidden: true,
    });
    el.dataset.ihDynamicNotice = '1';
    el.querySelector('.semantic-find-status-close')?.remove();
    const actions = el.querySelector('.semantic-find-status-actions');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'semantic-find-status-continue';
    ok.textContent = tr('OK');
    ok.addEventListener('click', dismissDynamicTrackNotice);
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'semantic-find-status-continue';
    settings.textContent = tr('Go to settings');
    settings.addEventListener('click', () => {
      dismissDynamicTrackNotice();
      openOptionsSection('content');
    });
    actions?.append(settings, ok);
    parent.insertBefore(el, list);
  }

  /** SYNC: background.js — 余额公告版本 id；与选项页 notice 同源，文案变则再弹状态条。 */
  const FACADE_NOTICE_SEEN_ID_KEY = 'ih_facade_notice_seen_id';

  /** 分析提示「今天不再提示」：按文案（zh+en）记当天已静音的 key。跨天清空。 */
  const ANALYZE_NOTICE_SILENCE = 'ih_analyze_notice_silence';
  /** 本轮已出过的分析 notice key（含用户 × 关掉）；新 round 在 beginAnalyzeRound 重置。 */
  const analyzeNoticeShownThisRound = new Set();

  function localYmd() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function analyzeNoticeKey(notice) {
    return `${notice?.zh || ''}\n${notice?.en || ''}`;
  }

  function analyzeNoticeText(notice, zh) {
    if (!notice) return '';
    return zh ? (notice.zh || notice.en) : (notice.en || notice.zh);
  }

  function readAnalyzeNoticeSilence() {
    return new Promise((resolve) => {
      chrome.storage.local.get(ANALYZE_NOTICE_SILENCE, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ day: localYmd(), keys: [] });
          return;
        }
        const raw = res?.[ANALYZE_NOTICE_SILENCE];
        const day = localYmd();
        if (!raw || raw.day !== day || !Array.isArray(raw.keys)) {
          resolve({ day, keys: [] });
          return;
        }
        resolve({ day, keys: raw.keys.filter((k) => typeof k === 'string') });
      });
    });
  }

  function analyzeNoticeSilencedToday(key) {
    return readAnalyzeNoticeSilence().then((state) => state.keys.includes(key));
  }

  function silenceAnalyzeNoticeToday(key) {
    return readAnalyzeNoticeSilence().then((state) => {
      if (!state.keys.includes(key)) state.keys.push(key);
      chrome.storage.local.set({ [ANALYZE_NOTICE_SILENCE]: state });
    });
  }

  function openOptionsSection(section, opts) {
    const msg = { type: 'ih-open-highlight-options', section };
    if (opts?.purchase) msg.purchase = true;
    chrome.runtime.sendMessage(msg);
  }

  const IH_STORE_REVIEWS =
    'https://chromewebstore.google.com/detail/gemajnklkebeikmfphiddpjfimahacdk/reviews';

  async function engagementNudgeBlocked() {
    if (globalThis.IH_OPTIONS_PAGE) return true;
    const list = await noticeList();
    if (list.querySelector('[data-il-engagement-nudge]')) return true;
    if (list.querySelector('[data-ih-analyze-notice]')) return true;
    return false;
  }

  async function maybeShowEngagementNudge() {
    if (!globalThis.IL_engagementNudge || !globalThis.IL_engagementNudgeUi) return;
    if (await engagementNudgeBlocked()) return;
    const trFn = globalThis.IH_i18n?.tr;
    if (!trFn) return;
    const meta = await globalThis.IL_engagementNudge.markShown();
    if (!meta) return;
    globalThis.IL_engagementNudgeUi.show({
      list: await noticeList(),
      tr: trFn,
      storeReviewUrl: IH_STORE_REVIEWS,
      promptIndex: meta.promptIndex,
      successTotal: meta.successTotal,
      onDone: (action) => {
        void globalThis.IL_engagementNudge.dismiss(action, meta);
      },
    });
  }

  function statusButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'semantic-find-status-continue';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function markFacadePolicyNoticeSeen(key) {
    chrome.storage.local.set({ [FACADE_NOTICE_SEEN_ID_KEY]: key });
  }

  /**
   * 余额通用公告：0 额度首次走云端分析时状态条弹一次；公告文案未变不再弹，变了再弹。选项页常驻同源 notice。
   */
  async function showFacadePolicyNotice(notice) {
    if (globalThis.IH_OPTIONS_PAGE) return;
    const detail = analyzeNoticeText(notice, globalThis.IH_i18n?.zh);
    if (!detail) return;
    const key = analyzeNoticeKey(notice);
    const seen = await new Promise((resolve) => {
      chrome.storage.local.get(FACADE_NOTICE_SEEN_ID_KEY, (res) => {
        resolve(chrome.runtime.lastError ? '' : res?.[FACADE_NOTICE_SEEN_ID_KEY]);
      });
    });
    if (seen === key) return;
    const list = await noticeList();
    const parent = list.parentElement;
    if ([...list.querySelectorAll('[data-ih-facade-policy-notice]')].some(
      (el) => el.dataset.ihFacadePolicyNoticeKey === key,
    )) return;
    invalidateCloudWait();
    const dismiss = (el) => {
      markFacadePolicyNoticeSeen(key);
      el.remove();
    };
    const el = requireOverlay().createStatus({
      label: tr('Reminder'),
      detail,
      tone: 'info',
      continueHidden: true,
      feedbackHidden: true,
      onClose: () => dismiss(el),
    });
    el.dataset.ihFacadePolicyNotice = '1';
    el.dataset.ihFacadePolicyNoticeKey = key;
    el.classList.add('is-engagement-nudge');
    const actions = el.querySelector('.semantic-find-status-actions');
    if (!actions) throw new Error('facade policy notice: status strip incomplete');
    const closeBtn = actions.querySelector('.semantic-find-status-close');
    const buy = statusButton(tr('Buy credits'), () => {
      dismiss(el);
      openOptionsSection('cloud-credits', { purchase: true });
    });
    const settings = statusButton(tr('Go to settings'), () => {
      dismiss(el);
      openOptionsSection('analysis');
    });
    const ok = statusButton(tr('OK'), () => dismiss(el));
    if (closeBtn) actions.insertBefore(buy, closeBtn);
    else actions.append(buy);
    if (closeBtn) actions.insertBefore(settings, closeBtn);
    else actions.append(settings);
    if (closeBtn) actions.insertBefore(ok, closeBtn);
    else actions.append(ok);
    list.appendChild(el);
  }

  /**
   * 门面分析 notice：有就显示，没有就不显示。限速和额度同一条样式。
   * 按文案去重：一轮只弹一次；「今天不再提示」按这条文案当天不再弹。
   */
  async function showAnalyzeNotice(notice) {
    if (globalThis.IH_OPTIONS_PAGE) return;
    const label = analyzeNoticeText(notice, globalThis.IH_i18n?.zh);
    if (!label) return;
    const key = analyzeNoticeKey(notice);
    if (analyzeNoticeShownThisRound.has(key)) return;
    if (await analyzeNoticeSilencedToday(key)) {
      analyzeNoticeShownThisRound.add(key);
      return;
    }
    const list = await noticeList();
    if ([...list.querySelectorAll('[data-ih-analyze-notice]')].some((el) => el.dataset.ihAnalyzeNotice === key)) {
      analyzeNoticeShownThisRound.add(key);
      return;
    }
    invalidateCloudWait();
    let el;
    el = requireOverlay().createStatus({
      label,
      tone: 'info',
      continueHidden: true,
      feedbackHidden: true,
      onClose: () => el.remove(),
    });
    el.dataset.ihAnalyzeNotice = key;
    el.classList.add('is-engagement-nudge');
    const actions = el.querySelector('.semantic-find-status-actions');
    if (!actions) throw new Error('analyze notice: status strip incomplete');
    const closeBtn = actions.querySelector('.semantic-find-status-close');
    const buy = statusButton(tr('Buy credits'), () => {
      el.remove();
      openOptionsSection('cloud-credits', { purchase: true });
    });
    const settings = statusButton(tr('Go to settings'), () => {
      el.remove();
      openOptionsSection('analysis');
    });
    if (closeBtn) actions.insertBefore(buy, closeBtn);
    else actions.append(buy);
    if (closeBtn) actions.insertBefore(settings, closeBtn);
    else actions.append(settings);
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'il-engagement-nudge-mute';
    mute.textContent = tr("Don't show again today");
    mute.addEventListener('click', () => {
      void silenceAnalyzeNoticeToday(key);
      el.remove();
    });
    const row = document.createElement('div');
    row.className = 'il-engagement-nudge-actions-row';
    el.removeChild(actions);
    row.append(mute, actions);
    el.append(row);
    list.appendChild(el);
    analyzeNoticeShownThisRound.add(key);
  }

  async function showFadeDefaultNotice() {
    const list = await noticeList();
    const parent = list.parentElement;
    if (!parent || parent.querySelector('[data-ih-fade-notice]')) return;
    fadeNoticeChecked = true;
    const el = requireOverlay().createStatus({
      label: tr('Highlight'),
      detail: tr('The default style is now "Fade".'),
      tone: 'info',
      continueHidden: true,
      feedbackHidden: true,
    });
    el.dataset.ihFadeNotice = '1';
    el.querySelector('.semantic-find-status-close')?.remove();
    const actions = el.querySelector('.semantic-find-status-actions');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'semantic-find-status-continue';
    ok.textContent = tr('OK');
    ok.addEventListener('click', dismissFadeDefaultNotice);
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'semantic-find-status-continue';
    settings.textContent = tr('Go to settings');
    settings.addEventListener('click', () => {
      dismissFadeDefaultNotice();
      chrome.runtime.sendMessage({ type: 'ih-open-highlight-options' });
    });
    actions?.append(settings, ok);
    parent.insertBefore(el, list);
  }

  async function showViewportDefaultNotice() {
    const list = await noticeList();
    const parent = list.parentElement;
    if (!parent || parent.querySelector('[data-ih-viewport-notice]')) return;
    const el = requireOverlay().createStatus({
      label: tr('Highlight'),
      detail: tr('Content above the screen is skipped; only this screen and below is analyzed. You can turn this off in settings.'),
      tone: 'info',
      continueHidden: true,
      feedbackHidden: true,
    });
    el.dataset.ihViewportNotice = '1';
    el.querySelector('.semantic-find-status-close')?.remove();
    const actions = el.querySelector('.semantic-find-status-actions');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'semantic-find-status-continue';
    ok.textContent = tr('OK');
    ok.addEventListener('click', dismissViewportDefaultNotice);
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'semantic-find-status-continue';
    settings.textContent = tr('Go to settings');
    settings.addEventListener('click', () => {
      dismissViewportDefaultNotice();
      openOptionsSection('content');
    });
    actions?.append(settings, ok);
    parent.insertBefore(el, list);
  }

  async function showError(msg) {
    invalidateCloudWait();
    const notice = msg && typeof msg === 'object' ? msg.notice : null;
    const raw = msg?.message || msg;
    const ctx = globalThis.IH_feedbackContext;
    if (ctx && !ctx.peek()) ctx.stashMinimal(raw, 'web');
    const userDetail = tr(analyzeNoticeText(notice, globalThis.IH_i18n?.zh) || shortError(raw));
    const retry = globalThis.IH_userErrors?.isRetryable?.(raw) === true
      && typeof globalThis.IH_retryAnalyze === 'function';
    const list = await noticeList();
    removeStatusMatches(list, '[data-ih-error]');
    let el;
    el = requireOverlay().createStatus({
      label: tr('Failed'),
      detail: userDetail,
      tone: 'error',
      continueHidden: !retry,
      continueLabel: retry ? tr('Retry') : undefined,
      feedbackHidden: false,
      feedbackLabel: tr('Feedback'),
      onContinue: retry ? () => {
        el.remove();
        globalThis.IH_retryAnalyze();
      } : undefined,
      onClose: () => el.remove(),
    });
    el.dataset.ihError = '1';
    attachErrorFeedback(el, userDetail);
    list.appendChild(el);
  }

  async function showPaused(onContinue) {
    invalidateCloudWait();
    const list = await noticeList();
    removeStatusMatches(list, '[data-ih-paused]');
    let el;
    el = requireOverlay().createStatus({
      label: tr('Paused'),
      detail: tr('Continue to highlight more'),
      continueLabel: tr('Continue'),
      continueHidden: false,
      feedbackHidden: true,
      onContinue: () => {
        el.remove();
        onContinue();
      },
      onClose: () => el.remove(),
    });
    el.dataset.ihPaused = '1';
    list.appendChild(el);
  }

  /** 只清错误/等待/暂停；同一次分析里可与计费条叠加。 */
  function clearError() {
    invalidateCloudWait();
    const list = ui$('ih-status-list');
    if (!list) return;
    removeStatusMatches(list, '[data-ih-error], [data-ih-cloud-wait], [data-ih-paused]');
  }

  /** 新开一轮分析：清掉上一轮留下的状态条（含门面 notice）。 */
  function beginAnalyzeRound() {
    analyzeNoticeShownThisRound.clear();
    invalidateCloudWait();
    const list = ui$('ih-status-list');
    if (!list) return;
    removeStatusMatches(list, '[data-ih-error], [data-ih-cloud-wait], [data-ih-paused], [data-ih-analyze-notice]');
  }

  /** @type {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root: Element } | null} */
  let progressMapped = null;
  /** @type {ReturnType<typeof globalThis.IL_createTextIndex> | null} */
  let progressIdx = null;
  /** @type {{ start: number, end: number, bits: number }[]} */
  let progressRows = [];
  let progressSearching = false;
  let progressEnabled = globalThis.IH_optionDefaults.show_progress;
  chrome.storage?.local?.get(globalThis.IH_optionDefaults, (res) => {
    progressEnabled = optionStored('show_progress', res?.show_progress);
  });
  chrome.storage?.onChanged?.addListener((changes) => {
    if ('show_progress' in changes) {
      progressEnabled = optionStored('show_progress', changes.show_progress.newValue);
      renderProgress();
    }
  });
  /** @type {Map<number, { y0: number, y1: number }>} */
  let progressYCache = new Map();
  /** @type {Set<number>} */
  let selectedStarts = new Set();
  /** @type {number | null} */
  let hoveredStart = null;
  let selectHoldTimer = 0;
  let hostWired = false;
  let windowFollowBound = false;
  /** @type {ShadowRoot | null} */
  let uiShadow = null;
  /** @type {Promise<HTMLElement> | null} */
  let hostReady = null;
  let hostEpoch = 0;
  /** @type {Element | null} */
  let innerScrollBound = null;
  let viewportRaf = 0;

  function ui$(id) {
    return uiShadow?.getElementById(id) ?? null;
  }

  function findScrollRoot() {
    return geo().findScrollRoot(progressMapped?.root);
  }

  function progressAxisYRange() {
    return geo().axisYRange(progressMapped?.root, findScrollRoot());
  }

  /** 本插件的码点 → Range；几何见 shared/page/progressAxis.js */
  function rangesFromChunkCp(cp0, cp1) {
    if (!progressMapped || !progressIdx || cp1 <= cp0) return [];
    return rangesFromUtf16(
      progressMapped.pieces,
      progressMapped.text,
      progressIdx.cpToUtf16(cp0),
      progressIdx.cpToUtf16(cp1),
    );
  }

  function measureChunkContentY(chunk, scrollRoot) {
    return progressAxis.measureChunkContentY(chunk, scrollRoot, progressYCache, rangesFromChunkCp);
  }

  function tiledProgress(scrollRoot) {
    const rows = [];
    for (const chunk of progressRows) {
      const cy = measureChunkContentY(chunk, scrollRoot);
      if (cy) rows.push({ chunk, cy });
    }
    return progressAxis.tileProgressRows(rows);
  }

  function chunksCoveringContentY(contentY, scrollRoot) {
    const hits = [];
    for (const { chunk, axisY } of tiledProgress(scrollRoot)) {
      if (axisY.y0 <= contentY && contentY <= axisY.y1) hits.push(chunk);
    }
    return hits;
  }

  function scrollToContentY(contentY, highlightChunks) {
    const root = progressMapped?.root;
    if (contentY == null || !root) return;
    const scrollRoot = findScrollRoot();
    const focus = geo().scrollTopAtContentY(contentY, scrollRoot, VIEWPORT_FOCUS_Y_RATIO);
    let top = focus.top;
    if (highlightChunks.length) {
      let startY = null;
      for (const chunk of highlightChunks) {
        const cy = measureChunkContentY(chunk, scrollRoot);
        if (cy && (startY == null || cy.y0 < startY)) startY = cy.y0;
      }
      if (startY != null) {
        top = Math.min(
          top,
          geo().scrollTopAtContentY(startY, scrollRoot, CHUNK_START_MAX_Y_RATIO).top,
        );
      }
    }
    focus.target.scrollTo({ top, behavior: 'auto' });
  }

  function applyProgressSelectedClass() {
    const lines = ui$('ih-progress-lines');
    if (!(lines instanceof SVGGElement)) return;
    for (const el of lines.children) {
      if (!(el instanceof SVGGElement) || el.dataset.progressStart == null) continue;
      el.querySelector('.semantic-match-progress-line')?.classList.toggle(
        'is-selected',
        selectedStarts.has(Number(el.dataset.progressStart)),
      );
    }
  }

  function clearSelected() {
    if (selectHoldTimer) {
      clearTimeout(selectHoldTimer);
      selectHoldTimer = 0;
    }
    clearUnderline();
    if (!selectedStarts.size) return;
    selectedStarts = new Set();
    applyProgressSelectedClass();
  }

  function revealAtContentY(contentY) {
    clearSelected();
    const scrollRoot = findScrollRoot();
    const chunks = contentY != null ? chunksCoveringContentY(contentY, scrollRoot) : [];
    requestAnimationFrame(() => {
      if (contentY != null) scrollToContentY(contentY, chunks);
      selectedStarts = new Set(chunks.map((c) => c.start));
      applyProgressSelectedClass();
      paintUnderlines(chunks);
      if (!chunks.length) return;
      selectHoldTimer = window.setTimeout(() => {
        selectHoldTimer = 0;
        clearSelected();
      }, SELECT_HOLD_MS);
    });
  }

  function chartEls() {
    const chart = ui$('ih-progress');
    const lines = ui$('ih-progress-lines');
    const band = ui$('ih-progress-viewport');
    if (!(chart instanceof SVGSVGElement) || !(lines instanceof SVGGElement) || !(band instanceof SVGRectElement)) {
      return null;
    }
    return { chart, lines, band };
  }

  function progressChartLayout(chart) {
    const width = Math.max(1, Math.round(chart.clientWidth));
    const height = Math.max(1, Math.round(chart.clientHeight));
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    return { x0: 4, x1: width - 4, y0: height - 7, y1: 4, axis: progressAxisYRange() };
  }

  function setHoveredProgress(start) {
    if (hoveredStart === start) return;
    const ui = chartEls();
    if (!ui) return;
    const previous = hoveredStart;
    hoveredStart = start;
    for (const chunkStart of [previous, start]) {
      if (chunkStart == null) continue;
      const group = [...ui.lines.children].find((el) => el.dataset.progressStart === String(chunkStart));
      group?.querySelector('.semantic-match-progress-line')?.classList.toggle('is-hovered', chunkStart === start);
      group?.querySelector('.semantic-match-progress-label')?.toggleAttribute('hidden', chunkStart !== start);
    }
  }

  function upsertProgressLine(layout, chunk, axisY, group) {
    const ui = chartEls();
    if (!ui) return;
    const { x0, x1, y0, y1, axis } = layout;
    if (!axis) return;
    const degree = Math.max(
      0,
      Math.min(1, (chunk.bits - PROGRESS_BITS_MIN) / (PROGRESS_BITS_MAX - PROGRESS_BITS_MIN)),
    );
    const yStart = Math.max(axis.y0, Math.min(axis.y1, axisY.y0));
    const yEnd = Math.max(axis.y0, Math.min(axis.y1, axisY.y1));
    const start = geo().xFromContentY(yStart, x0, x1, axis);
    const end = geo().xFromContentY(yEnd, x0, x1, axis);
    if (!group) {
      group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.dataset.progressStart = String(chunk.start);
      const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      lineEl.classList.add('semantic-match-progress-line');
      group.appendChild(lineEl);
      const labelEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      labelEl.classList.add('semantic-match-progress-label');
      labelEl.setAttribute('text-anchor', 'middle');
      labelEl.setAttribute('hidden', '');
      group.appendChild(labelEl);
      const hitEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      hitEl.classList.add('semantic-match-progress-hit-area');
      hitEl.addEventListener('mouseenter', () => setHoveredProgress(chunk.start));
      hitEl.addEventListener('mouseleave', () => {
        if (hoveredStart === chunk.start) setHoveredProgress(null);
      });
      group.appendChild(hitEl);
      ui.lines.appendChild(group);
    }
    const line = /** @type {SVGPathElement} */ (group.querySelector('.semantic-match-progress-line'));
    const label = /** @type {SVGTextElement} */ (group.querySelector('.semantic-match-progress-label'));
    const hitArea = /** @type {SVGRectElement} */ (group.querySelector('.semantic-match-progress-hit-area'));
    line.classList.toggle('is-selected', selectedStarts.has(chunk.start));
    line.classList.toggle('is-hovered', hoveredStart === chunk.start);
    const lineEnd = end > start ? end : start + PROGRESS_MIN_WIDTH_PX;
    const y = y0 - (y0 - y1) * degree;
    line.setAttribute('d', `M${start} ${y}H${lineEnd}`);
    label.setAttribute('x', String((start + lineEnd) / 2));
    label.setAttribute('y', String(Math.max(y1 + 10, y - 4)));
    label.textContent = `${chunk.bits.toFixed(1)} bits`;
    label.toggleAttribute('hidden', hoveredStart !== chunk.start);
    hitArea.setAttribute('x', String(start));
    hitArea.setAttribute('y', String(y1));
    hitArea.setAttribute('width', String(lineEnd - start));
    hitArea.setAttribute('height', String(y0 - y1));
  }

  function applyProgressViewportBand() {
    const ui = chartEls();
    if (!ui) return;
    if (ui.chart.hasAttribute('hidden')) {
      ui.band.setAttribute('hidden', '');
      return;
    }
    const axis = progressAxisYRange();
    if (!axis) {
      ui.band.setAttribute('hidden', '');
      return;
    }
    const view = geo().viewportContentY(axis.scrollRoot);
    const startY = Math.max(axis.y0, view.top);
    const endY = Math.min(axis.y1, view.bottom);
    if (!(startY < endY)) {
      ui.band.setAttribute('hidden', '');
      return;
    }
    const width = Math.max(1, Math.round(ui.chart.clientWidth));
    const height = Math.max(1, Math.round(ui.chart.clientHeight));
    const x0 = 4;
    const x1 = width - 4;
    const xStart = geo().xFromContentY(startY, x0, x1, axis);
    const xEnd = geo().xFromContentY(endY, x0, x1, axis);
    ui.band.removeAttribute('hidden');
    ui.band.setAttribute('x', String(xStart));
    ui.band.setAttribute('y', '0');
    ui.band.setAttribute('width', String(Math.max(PROGRESS_MIN_WIDTH_PX, xEnd - xStart)));
    ui.band.setAttribute('height', String(height));
  }

  function scheduleViewportBand() {
    if (progressRows.length === 0 && !progressSearching) return;
    if (viewportRaf) return;
    viewportRaf = requestAnimationFrame(() => {
      viewportRaf = 0;
      applyProgressViewportBand();
    });
  }

  function unbindInnerScroll() {
    if (!innerScrollBound) return;
    innerScrollBound.removeEventListener('scroll', scheduleViewportBand);
    innerScrollBound = null;
  }

  function unbindFollow() {
    if (windowFollowBound) {
      window.removeEventListener('scroll', scheduleViewportBand, true);
      window.removeEventListener('resize', onProgressResize);
      windowFollowBound = false;
    }
    unbindInnerScroll();
  }

  function onProgressResize() {
    progressYCache = new Map();
    clearSegYCache();
    renderProgress();
  }

  function bindFollow() {
    const need = progressEnabled && (progressSearching || progressRows.length > 0);
    if (!need) {
      unbindFollow();
      return;
    }
    if (!windowFollowBound) {
      window.addEventListener('scroll', scheduleViewportBand, { passive: true, capture: true });
      window.addEventListener('resize', onProgressResize);
      windowFollowBound = true;
    }
    const root = findScrollRoot();
    if (!root || geo().isWindowScrollRoot(root)) {
      unbindInnerScroll();
      return;
    }
    if (innerScrollBound === root) return;
    unbindInnerScroll();
    innerScrollBound = root;
    root.addEventListener('scroll', scheduleViewportBand, { passive: true });
  }

  function renderProgress() {
    const ui = chartEls();
    if (!ui) return;
    if (!progressEnabled) {
      ui.chart.setAttribute('hidden', '');
      ui.band.setAttribute('hidden', '');
      ui.lines.replaceChildren();
      unbindFollow();
      return;
    }
    const hidden = progressRows.length === 0 && !progressSearching;
    ui.chart.toggleAttribute('hidden', hidden);
    if (progressRows.length === 0) {
      ui.lines.replaceChildren();
      if (hidden) ui.band.setAttribute('hidden', '');
      bindFollow();
      if (!hidden) applyProgressViewportBand();
      return;
    }
    const layout = progressChartLayout(ui.chart);
    const groupsByStart = new Map(
      [...ui.lines.children]
        .filter((el) => el instanceof SVGGElement && el.dataset.progressStart != null)
        .map((el) => [Number(el.dataset.progressStart), el]),
    );
    const liveStarts = new Set();
    const tiled = layout.axis ? tiledProgress(layout.axis.scrollRoot) : [];
    for (const { chunk, axisY } of tiled) {
      liveStarts.add(chunk.start);
      upsertProgressLine(layout, chunk, axisY, groupsByStart.get(chunk.start));
    }
    for (const [start, group] of groupsByStart) {
      if (!liveStarts.has(start)) group.remove();
    }
    bindFollow();
    applyProgressViewportBand();
  }

  function onChartPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const ui = chartEls();
    const axis = progressAxisYRange();
    if (!ui || !axis) return;
    const ctm = ui.chart.getScreenCTM();
    if (!ctm) return;
    const x = new DOMPoint(event.clientX, 0).matrixTransform(ctm.inverse()).x;
    const width = Math.max(1, Math.round(ui.chart.clientWidth));
    revealAtContentY(geo().contentYFromX(x, 4, width - 4, axis));
  }

  function attachExistingHost(host) {
    uiShadow = host.shadowRoot;
    if (!uiShadow) throw new Error('ih-progress-host shadow missing');
    return host;
  }

  async function buildHost(epoch) {
    const css = await requireOverlay().loadCss();
    if (epoch !== hostEpoch) throw new Error('ih-progress-host cleared');
    const existing = document.getElementById(HOST_ID);
    if (existing) return attachExistingHost(existing);
    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    uiShadow = shadow;
    const style = document.createElement('style');
    style.textContent = css + '\n' + HOST_CSS;
    const wrap = document.createElement('div');
    wrap.className = 'semantic-find-bar-host';
    const uiOverlay = requireOverlay();
    uiOverlay.applyTheme(wrap);
    uiOverlay.watchTheme(wrap);
    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chart.id = 'ih-progress';
    chart.classList.add('semantic-match-progress');
    chart.setAttribute('viewBox', '0 0 100 100');
    chart.setAttribute('aria-label', 'Information progress');
    chart.setAttribute('hidden', '');
    const band = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    band.id = 'ih-progress-viewport';
    band.classList.add('semantic-match-progress-viewport');
    band.setAttribute('hidden', '');
    const lines = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    lines.id = 'ih-progress-lines';
    chart.append(band, lines);
    const list = document.createElement('div');
    list.id = 'ih-status-list';
    list.className = 'semantic-find-status-list';
    wrap.append(chart, list);
    shadow.append(style, wrap);
    if (epoch !== hostEpoch) throw new Error('ih-progress-host cleared');
    document.documentElement.appendChild(host);
    if (!hostWired) {
      hostWired = true;
      chart.addEventListener('pointerdown', onChartPointerDown);
    }
    return host;
  }

  async function ensureHost() {
    const existing = document.getElementById(HOST_ID);
    if (existing) return attachExistingHost(existing);
    if (!hostReady) {
      const epoch = hostEpoch;
      hostReady = buildHost(epoch);
      hostReady.catch(() => {
        if (epoch === hostEpoch) hostReady = null;
      });
    }
    return hostReady;
  }

  /**
   * @param {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root: Element }} mapped
   * @param {{ start: number, end: number }[]} segs
   */
  async function bindProgress(mapped, segs) {
    await prefsReady;
    progressMapped = mapped;
    progressIdx = globalThis.IL_createTextIndex(mapped.text);
    progressYCache = new Map();
    clearSegYCache();
    progressRows = [];
    selectedStarts = new Set();
    hoveredStart = null;
    await ensureHost();
    renderProgress();
  }

  async function setProgressSearching(on) {
    progressSearching = !!on;
    await ensureHost();
    renderProgress();
  }

  /**
   * @param {Array<{ real_topk?: [number, number] | null }>} tokens
   * @param {{ start: number, end: number }} seg
   */
  function appendProgress(tokens, seg) {
    if (!progressMapped || !progressIdx) {
      throw new Error('IH_appendProgress before IH_bindProgress');
    }
    const bits = averageBits(tokens);
    if (bits == null) return;
    progressRows.push({
      start: progressIdx.utf16ToCp(seg.start),
      end: progressIdx.utf16ToCp(seg.end),
      bits,
    });
    renderProgress();
  }

  function clearProgress() {
    progressSearching = false;
    progressMapped = null;
    progressIdx = null;
    progressRows = [];
    progressYCache = new Map();
    clearSegYCache();
    selectedStarts = new Set();
    hoveredStart = null;
    if (selectHoldTimer) {
      clearTimeout(selectHoldTimer);
      selectHoldTimer = 0;
    }
    if (viewportRaf) {
      cancelAnimationFrame(viewportRaf);
      viewportRaf = 0;
    }
    unbindFollow();
    hostWired = false;
    uiShadow = null;
    hostEpoch += 1;
    hostReady = null;
    clearUnderline();
    clearExtractPreview();
    document.getElementById(HOST_ID)?.remove();
  }

  globalThis.IH_extractPage = extractPage;
  globalThis.IH_prefsReady = prefsReady;
  globalThis.IH_watchHighlightLive = watchHighlightLive;
  globalThis.IH_pruneDetachedHighlights = pruneDetachedHighlights;
  globalThis.IH_dropHighlightRangesExcept = dropHighlightRangesExcept;
  globalThis.IH_dropTokenRangesOverlapping = dropTokenRangesOverlapping;
  globalThis.IH_resetPaintBuf = resetPaintBuf;
  globalThis.IH_splitSegments = splitSegments;
  globalThis.IH_viewportSegmentStart = viewportSegmentStart;
  globalThis.IH_viewportSegments = viewportSegments;
  globalThis.IH_dropSegYCache = dropSegYCache;
  globalThis.IH_isDynamicTrack = () => dynamicTrack;
  globalThis.IH_segmentWindow = segmentWindow;
  globalThis.IH_tokensInSegment = tokensInSegment;
  globalThis.IH_paintTokens = paintTokens;
  globalThis.IH_bakeLibraryMarks = bakeLibraryMarks;
  globalThis.IH_libraryTwinInClone = libraryTwinInClone;
  globalThis.IH_maybeShowPaintNotices = maybeShowPaintNotices;
  globalThis.IH_tokensForPaint = tokensForPaint;
  globalThis.IH_tokenBits = tokenBits;
  globalThis.IH_rangesFromUtf16 = rangesFromUtf16;
  globalThis.IH_clearHighlights = clearHighlights;
  globalThis.IH_showError = showError;
  globalThis.IH_showPaused = showPaused;
  globalThis.IH_clearError = clearError;
  globalThis.IH_beginAnalyzeRound = beginAnalyzeRound;
  globalThis.IH_maybeShowEngagementNudge = maybeShowEngagementNudge;
  globalThis.IH_showCloudWait = showCloudWait;
  globalThis.IH_clearCloudWait = clearCloudWait;
  globalThis.IH_bindProgress = bindProgress;
  globalThis.IH_toggleExtractPreview = toggleExtractPreview;
  globalThis.IH_isExtractPreviewOn = () => extractPreviewOn;
  globalThis.IH_setProgressSearching = setProgressSearching;
  globalThis.IH_appendProgress = appendProgress;
  globalThis.IH_clearProgress = clearProgress;

  globalThis.IH_showFacadePolicyNotice = showFacadePolicyNotice;
  globalThis.IH_applyAnalyzeBillingUi = function IH_applyAnalyzeBillingUi(res) {
    if (!res || globalThis.IH_OPTIONS_PAGE) return;
    if (res.notice) void showAnalyzeNotice(res.notice);
  };
})();
