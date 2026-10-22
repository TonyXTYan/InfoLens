/**
 * 成功使用计数 + 是否该弹满意度条（各扩展在加载前设 IL_ENGAGEMENT_NUDGE_KEY）。
 */
globalThis.IL_engagementNudge ||= (function () {
  const KEY = () => globalThis.IL_ENGAGEMENT_NUDGE_KEY || 'il_engagement_nudge';
  const FIRST = 10;
  const AGAIN = 10;
  const AGAIN_MS = 7 * 24 * 60 * 60 * 1000;

  /** 本地 config.js：每次成功分析都弹（仍尊重 mute / 不再提醒）。上架包勿开。 */
  function isDebug() {
    return !!(
      globalThis.IH_CONFIG?.engagementNudgeDebug ||
      globalThis.IL_CONFIG?.engagementNudgeDebug
    );
  }

  function empty() {
    return {
      successTotal: 0,
      lastPromptAt: 0,
      lastPromptTime: 0,
      mute: false,
      promptIndex: 0,
      /** 点过「以后再说」后为 2，再提醒间隔相对默认加倍 */
      intervalScale: 1,
    };
  }

  function normalize(raw) {
    const s = empty();
    if (!raw || typeof raw !== 'object') return s;
    const total = Math.floor(Number(raw.successTotal));
    s.successTotal = total > 0 ? total : 0;
    const lastAt = Math.floor(Number(raw.lastPromptAt));
    s.lastPromptAt = lastAt > 0 ? lastAt : 0;
    const lastTime = Math.floor(Number(raw.lastPromptTime));
    s.lastPromptTime = lastTime > 0 ? lastTime : 0;
    const idx = Math.floor(Number(raw.promptIndex));
    s.promptIndex = idx > 0 ? idx : 0;
    s.mute = raw.mute === true;
    const scale = Math.floor(Number(raw.intervalScale));
    s.intervalScale = scale >= 2 ? 2 : 1;
    return s;
  }

  function againCount(state) {
    return AGAIN * (state.intervalScale >= 2 ? 2 : 1);
  }

  function againMs(state) {
    return AGAIN_MS * (state.intervalScale >= 2 ? 2 : 1);
  }

  /** @param {ReturnType<typeof empty>} state @param {number} [now] */
  function shouldPrompt(state, now = Date.now()) {
    if (isDebug()) return !state.mute;
    if (state.mute) return false;
    if (state.successTotal < FIRST) return false;
    if (state.promptIndex === 0) return state.successTotal >= FIRST;
    if (state.successTotal - state.lastPromptAt < againCount(state)) return false;
    if (now - state.lastPromptTime < againMs(state)) return false;
    return true;
  }

  /**
   * @param {ReturnType<typeof empty>} state
   * @returns {{ state: ReturnType<typeof empty>, shouldPrompt: boolean }}
   */
  function noteSuccessState(state) {
    const next = normalize(state);
    if (next.mute) return { state: next, shouldPrompt: false };
    next.successTotal += 1;
    return { state: next, shouldPrompt: shouldPrompt(next) };
  }

  /**
   * 条已展示：递增 promptIndex（上报用）。
   * @param {ReturnType<typeof empty>} state
   */
  function markShownState(state) {
    const next = normalize(state);
    next.promptIndex += 1;
    return next;
  }

  /**
   * @param {ReturnType<typeof empty>} state
   * @param {'later' | 'feedback' | 'review' | 'dont_show_again'} action
   * @param {number} [now]
   */
  function dismissState(state, action, now = Date.now()) {
    const next = normalize(state);
    if (action === 'review' || action === 'dont_show_again') {
      next.mute = true;
      return next;
    }
    if (action === 'later') next.intervalScale = 2;
    next.lastPromptAt = next.successTotal;
    next.lastPromptTime = now;
    return next;
  }

  async function load() {
    const res = await chrome.storage.local.get({ [KEY()]: null });
    return normalize(res[KEY()]);
  }

  /** @param {ReturnType<typeof empty>} state */
  async function save(state) {
    await chrome.storage.local.set({ [KEY()]: normalize(state) });
  }

  async function noteSuccess() {
    const state = await load();
    const out = noteSuccessState(state);
    await save(out.state);
    return out;
  }

  /** @returns {Promise<{ promptIndex: number, successTotal: number } | null>} */
  async function markShown() {
    const state = await load();
    const next = markShownState(state);
    await save(next);
    return { promptIndex: next.promptIndex, successTotal: next.successTotal };
  }

  /**
   * @param {'later' | 'feedback' | 'review' | 'dont_show_again'} action
   * @param {{ promptIndex: number, successTotal: number }} meta
   */
  async function dismiss(action, meta) {
    const state = await load();
    const next = dismissState(state, action);
    await save(next);
    if (action === 'later') return;
    chrome.runtime.sendMessage(
      {
        type: 'il-engagement-nudge-report',
        action,
        prompt_index: meta.promptIndex,
        success_total: meta.successTotal,
      },
      () => {
        void chrome.runtime.lastError;
      },
    );
  }

  return {
    FIRST,
    AGAIN,
    AGAIN_MS,
    isDebug,
    empty,
    normalize,
    shouldPrompt,
    noteSuccessState,
    markShownState,
    dismissState,
    noteSuccess,
    markShown,
    dismiss,
  };
})();
