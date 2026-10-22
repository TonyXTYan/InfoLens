/**
 * 部分站点（如九九藏书网）正文块在 DOM 里乱序，靠站点 CSS 排成阅读顺序。
 * 阅读视图收藏会剥掉外链样式，需按视口几何把同级块排回阅读顺序。
 * 高亮/分析在 collectTextMap 后对 mapped.text 做同一套视觉序（不改 live DOM）。
 */
(() => {
  const MIN_BLOCK_CHARS = 15;

  function blockTextLen(el) {
    return String(el.textContent || '').replace(/\s+/g, '').length;
  }

  /** @param {Element} parent */
  function significantChildren(parent) {
    return [...parent.children].filter((c) => {
      if (c.nodeType !== 1) return false;
      const tag = c.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return false;
      return blockTextLen(c) >= MIN_BLOCK_CHARS;
    });
  }

  /** @param {Element} el */
  function visualKey(el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return [r.top, r.left];
    }
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }

  /**
   * 同级块按视觉序重排；DOM 序已与视觉序一致则 null。两种消费方共用。
   * @param {Element[]} liveKids significantChildren(liveHost)
   * @returns {number[] | null} 视觉序下标 perm，不需重排则为 null
   */
  function visualPermutationForKids(liveKids) {
    if (liveKids.length < 4) return null;
    const visualOrder = [...liveKids.keys()].sort((a, b) => {
      const ka = visualKey(liveKids[a]);
      const kb = visualKey(liveKids[b]);
      return ka[0] - kb[0] || ka[1] - kb[1];
    });
    const identity = [...liveKids.keys()];
    if (visualOrder.every((v, i) => v === identity[i])) return null;
    return visualOrder;
  }

  /**
   * @param {Element} liveParent
   * @param {Element} snapParent
   * @returns {boolean}
   */
  function reorderChildrenByVisual(liveParent, snapParent) {
    const liveKids = significantChildren(liveParent);
    const snapKids = significantChildren(snapParent);
    if (liveKids.length !== snapKids.length) return false;
    const perm = visualPermutationForKids(liveKids);
    if (!perm) return false;
    for (const idx of perm) {
      snapParent.appendChild(snapKids[idx]);
    }
    return true;
  }

  /**
   * @param {Element} root
   * @returns {Element}
   */
  function findBlockHost(root) {
    const byId = root.querySelector('#content');
    if (byId) return byId;

    let best = root;
    let bestN = significantChildren(root).length;
    for (const el of root.querySelectorAll('*')) {
      const n = significantChildren(el).length;
      if (n > bestN) {
        bestN = n;
        best = el;
      }
    }
    return bestN >= 4 ? best : root;
  }

  /**
   * @param {Element} liveRoot
   * @param {Element} snapRoot
   */
  function reorderArticleBlocksByVisual(liveRoot, snapRoot) {
    if (!liveRoot || !snapRoot) return;
    const liveHost = findBlockHost(liveRoot);
    let snapHost = snapRoot;
    if (liveHost.id) {
      const q = snapRoot.querySelector(`#${CSS.escape(liveHost.id)}`);
      if (q) snapHost = q;
    } else if (liveHost !== liveRoot) {
      snapHost = findBlockHost(snapRoot);
    }
    reorderChildrenByVisual(liveHost, snapHost);
  }

  /**
   * @param {Text} node
   * @param {Element} host
   * @param {Element[]} liveKids
   */
  function blockIndexForTextNode(node, host, liveKids) {
    let el = node.parentElement;
    while (el && el !== host) {
      const idx = liveKids.indexOf(el);
      if (idx >= 0) return idx;
      el = el.parentElement;
    }
    return -1;
  }

  /**
   * @param {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root: Element }} mapped
   * @param {Element} host
   * @param {Element[]} liveKids
   * @param {number[]} perm
   */
  function remapPiecesInBlockOrder(mapped, host, liveKids, perm) {
    const buckets = new Map();
    for (const i of liveKids.keys()) buckets.set(i, []);
    buckets.set(-1, []);
    for (const p of mapped.pieces) {
      const node = p?.node;
      if (!node || node.nodeType !== 3) continue;
      const bi = blockIndexForTextNode(node, host, liveKids);
      buckets.get(bi >= 0 ? bi : -1).push(p);
    }
    for (const arr of buckets.values()) {
      arr.sort((a, b) => a.start - b.start);
    }

    const newPieces = [];
    let newText = '';
    for (const bi of [...perm, -1]) {
      for (const p of buckets.get(bi) || []) {
        const value = p.node.nodeValue;
        if (!value) continue;
        const start = newText.length;
        newText += value;
        newPieces.push({ node: p.node, start, end: newText.length });
      }
    }
    if (!newPieces.length) return mapped;
    return { text: newText, pieces: newPieces, root: mapped.root };
  }

  /**
   * @param {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root: Element }} mapped
   */
  function reorderMappedByVisual(mapped) {
    if (!mapped?.root?.isConnected || !Array.isArray(mapped.pieces) || !mapped.pieces.length) {
      return mapped;
    }
    const host = findBlockHost(mapped.root);
    const liveKids = significantChildren(host);
    const perm = visualPermutationForKids(liveKids);
    if (!perm) return mapped;
    return remapPiecesInBlockOrder(mapped, host, liveKids, perm);
  }

  globalThis.IL_reorderArticleBlocksByVisual = reorderArticleBlocksByVisual;
  globalThis.IL_reorderMappedByVisual = reorderMappedByVisual;
})();
