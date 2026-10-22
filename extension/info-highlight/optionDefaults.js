/**
 * 选项的 chrome.storage.local 默认值，只在这里写。
 * 须在 highlightStyle.js 之后注入：高亮色相默认是 HUE_RED。
 * options.html 里复选框的 checked 只画脚本执行前那一帧。
 */
(() => {
  const HS = globalThis.IH_highlightStyle;
  if (!HS) throw new Error('IH_highlightStyle missing — inject highlightStyle.js first');

  const defaults = Object.freeze({
    [HS.KEY_TWO_TIER]: false,
    [HS.KEY_THRESHOLD_PCT]: 25,
    [HS.KEY_MAX_ALPHA_DEPTH]: 100,
    [HS.KEY_FADE_MIN_PCT]: HS.FADE_MIN_DEFAULT,
    [HS.KEY_FADE_NORM]: true,
    [HS.KEY_FADE_NORM_PCT]: HS.FADE_NORM_PCT_DEFAULT,
    [HS.KEY_PAINT_STYLE]: HS.PAINT_FADE,
    [HS.KEY_HIGHLIGHT_COLOR]: HS.HUE_RED,
    [HS.KEY_TEXT_COLOR]: 'red',
    ih_article_only: false,
    ih_dynamic_track: true,
    ih_from_viewport: true,
    show_progress: false,
    show_token_tip: true,
    ih_word_merge: false,
    ih_highlight_options_page: false,
    ih_library_close_tab: false,
  });

  /** 键不在 storage 里时用默认。get(defaults) 会填缺键；删键时 onChanged 的 newValue 是 undefined。 */
  function optionStored(key, stored) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`unknown option ${key}`);
    return stored === undefined ? defaults[key] : stored;
  }

  globalThis.IH_optionDefaults = defaults;
  globalThis.IH_optionStored = optionStored;
})();
