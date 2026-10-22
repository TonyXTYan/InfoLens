(() => {
  const { tr } = globalThis.IH_i18n;
  if (!globalThis.IH_analyzeCache) {
    throw new Error('IH_analyzeCache missing — inject analyzeCache.js before options.js');
  }
  if (!globalThis.IH_localState) {
    throw new Error('IH_localState missing — inject state.js before options.js');
  }
  if (!globalThis.IH_highlightStyle) {
    throw new Error('IH_highlightStyle missing — inject highlightStyle.js before options.js');
  }
  if (!globalThis.IH_optionDefaults || typeof globalThis.IH_optionStored !== 'function') {
    throw new Error('IH_optionDefaults missing — inject optionDefaults.js before options.js');
  }
  if (!globalThis.IH_autoSites) {
    throw new Error('IH_autoSites missing — inject auto-sites.js before options.js');
  }
  if (!globalThis.IL_optionsAbout) {
    throw new Error('IL_optionsAbout missing — inject options-about.js before options.js');
  }
  if (typeof globalThis.IL_setActionIconDotted !== 'function') {
    throw new Error('IL_setActionIconDotted missing — inject action-dot.js before options.js');
  }
  if (!globalThis.IH_creditCustomUsd) {
    throw new Error('IH_creditCustomUsd missing — inject creditCustomUsd.js before options.js');
  }
  if (!globalThis.IH_dynamicTrack) {
    throw new Error('IH_dynamicTrack missing — inject dynamicTrack.js before options.js');
  }
  // 右键工具栏图标 → 选项：Chrome 不发手势事件，只能在选项页打开时灭蓝点
  IL_setActionIconDotted(false);

  const HS = globalThis.IH_highlightStyle;
  const optionDefaults = globalThis.IH_optionDefaults;
  const optionStored = globalThis.IH_optionStored;

  let resolvePageReady;
  globalThis.IH_optionsPageReady = new Promise((r) => { resolvePageReady = r; });

  /** 复选框 id 即 chrome.storage.local 的键；默认值在 optionDefaults.js */
  const TOGGLE_KEYS = [
    'ih_article_only',
    'ih_dynamic_track',
    'ih_from_viewport',
    'show_progress',
    'show_token_tip',
    HS.KEY_TWO_TIER,
    HS.KEY_FADE_NORM,
    'ih_word_merge',
    'ih_highlight_options_page',
  ];

  const ids = [
    'brand_icon', 'brand_name', 'brand_version', 'welcome_open',
    'analyze_pref',
    'ih_cloud_api_base_row', 'ih_cloud_api_base_enabled', 'ih_cloud_api_base_wrap',
    'ih_cloud_latency_row',
    'ih_cloud_api_base', 'ih_cloud_api_base_error',
    'latency_edge', 'latency_backend', 'latency_retry',
    'webgpu_desc', 'local_models_hint', 'local_models_list', 'webgpu_linger_sec',
    'auto_sites', 'auto_site_input', 'auto_site_add', 'auto_site_error',
    'cache_desc', 'cache_clear',
    'credits_notice', 'credits_balance', 'credits_api_key', 'credits_refresh', 'credits_status', 'credits_orders', 'credits_add', 'credits_copy',
    'credits_replace_key', 'credits_replace_warn_dialog', 'credits_replace_warn_go', 'credits_replace_input_dialog',
    'credits_replace_form', 'credits_replace_input', 'credits_replace_history_wrap', 'credits_replace_history', 'credits_replace_error', 'credits_replace_submit',
    'credits_purchase_dialog', 'credits_pack_list', 'credits_currency', 'credits_pay_list', 'credits_purchase_go',
    'donate_dialog', 'donate_title', 'donate_note', 'donate_currency', 'donate_cny_wrap', 'donate_pay_list', 'donate_qr_wrap', 'donate_qr',
    'donate_intl_wrap', 'donate_intl_presets', 'donate_intl_custom', 'donate_intl_range', 'donate_intl_error', 'donate_intl_go',
    'ih_threshold_row', 'ih_threshold_value', 'ih_highlight_threshold_pct',
    'ih_depth_value', 'ih_max_highlight_alpha',
    'ih_fade_value', 'ih_fade_min_pct',
    'ih_fade_norm_row', 'ih_fade_norm_value', 'ih_fade_norm_pct',
    'ih_paint_style', 'ih_highlight_color', 'ih_highlight_swatches',
    'ih_text_swatches',
    'restore_recommended',
  ];
  const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  if (ids.some((id) => !el[id])) {
    throw new Error('options page missing required elements');
  }

  const manifest = chrome.runtime.getManifest();
  const name = manifest.name;
  const version = manifest.version;
  const iconRel = manifest.icons?.['48'] || manifest.icons?.['32'] || manifest.icons?.['128'];
  if (!name) throw new Error('manifest name missing');
  if (!version) throw new Error('manifest version missing');
  if (!iconRel) throw new Error('manifest icons missing');
  document.title = name;
  el.brand_name.textContent = name;
  el.brand_version.textContent = version;
  el.brand_icon.src = iconRel;
  el.brand_icon.alt = name;

  function openWelcome() {
    chrome.runtime.sendMessage({ type: 'ih-open-welcome' });
  }
  el.welcome_open.addEventListener('click', openWelcome);
  const pageParams = new URLSearchParams(location.search);
  const openWelcomeOnLoad = pageParams.has('welcome');
  const openPurchaseOnLoad = pageParams.has('purchase');
  if (openWelcomeOnLoad || openPurchaseOnLoad) {
    pageParams.delete('welcome');
    pageParams.delete('purchase');
    const rest = pageParams.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  }
  if (openWelcomeOnLoad) openWelcome();

  // Qwen3-0.6B-Base surprisal bits。勾选归一化时，只用这段预览自己的文字定最强档。
  const DEMO_TOKENS = [
    ['Try', 12.39], [' Info', 14.04], [' Highlight', 19], ['.', 7.28],
    [' It', 4.64], [' uses', 7.4], [' large', 11.11], [' language', 6.03],
    [' models', 0.11], [' to', 0.81], [' analyze', 4.5], [' text', 3.03],
    [' information', 9.97], [' density', 17.48], [' and', 1.37],
    [' visual', 8.31], ['izes', 10.65], [' where', 10.72], [' the', 2.28],
    [' important', 8.38], [' parts', 3.45], [' are', 1.44], ['.\n', 3.78],
    ['The', 5.26], [' color', 10.57], [' intensity', 5.06], [' of', 1.15],
    [' each', 2.34], [' token', 8.51], [' indicates', 4.09], [' how', 2.69],
    [' much', 2.39], [' information', 1.68], [' it', 1.82], [' carries', 2.91],
    ['.', 1.13], [' Try', 8.72], [' it', 3.01], [' yourself', 4.29], ['!', 3.91],
  ];
  let demoFadeScale = null;

  function demoTextWeight(raw) {
    let n = 0;
    for (const ch of raw) {
      if (!/\s/u.test(ch)) n += 1;
    }
    return n;
  }

  function fadeNormOn() {
    return !!document.getElementById(HS.KEY_FADE_NORM)?.checked;
  }

  function syncDemoFadeScale() {
    demoFadeScale = fadeNormOn()
      ? HS.fadeNormScaleBits(DEMO_TOKENS.map(([raw, bits]) => ({
        bits,
        weight: demoTextWeight(raw),
      })), HS.clampFadeNormPct(el.ih_fade_norm_pct.value))
      : null;
  }

  function demoPFor(bits, style) {
    if (style === HS.PAINT_FADE) {
      const level = HS.tokenLevelForFade(bits, demoFadeScale);
      if (level < 0) return HS.clampFadeMinPct(el.ih_fade_min_pct.value) / 100;
      return HS.fadeOpacityForLevel(
        level,
        HS.clampFadeMinPct(el.ih_fade_min_pct.value),
      );
    }
    const twoTier = !!document.getElementById(HS.KEY_TWO_TIER)?.checked;
    const level = HS.tokenLevelFromBits(bits, {
      twoTier,
      thresholdPct: HS.clampThresholdPct(el.ih_highlight_threshold_pct.value),
    });
    if (level < 0) return 0;
    return twoTier ? 1 : level / HS.TOKEN_LEVELS;
  }

  function syncPaintDemo() {
    syncDemoFadeScale();
    for (const card of el.ih_paint_style.querySelectorAll('.ih-paint-card')) {
      const style = card.dataset.style;
      for (const s of card.querySelectorAll('.ih-paint-demo span')) {
        s.style.setProperty('--ih-p', String(demoPFor(Number(s.dataset.bits), style)));
      }
    }
  }

  function rowFor(optionId) {
    return document.querySelector(`[data-option-id="${optionId}"]`);
  }

  function syncTwoTierUi(on) {
    const fade = paintStyle === HS.PAINT_FADE;
    const twoTierRow = rowFor(HS.KEY_TWO_TIER);
    if (twoTierRow) twoTierRow.hidden = fade;
    el.ih_threshold_row.hidden = fade || !on;
    syncPaintDemo();
  }

  function syncPaintColorUi() {
    const text = paintStyle === HS.PAINT_TEXT;
    const fade = paintStyle === HS.PAINT_FADE;
    el.ih_highlight_swatches.closest('.row').hidden = text || fade;
    el.ih_text_swatches.closest('.row').hidden = !text;
    const intensityRow = rowFor(HS.KEY_MAX_ALPHA_DEPTH);
    if (intensityRow) intensityRow.hidden = fade;
    const fadeRow = rowFor(HS.KEY_FADE_MIN_PCT);
    if (fadeRow) fadeRow.hidden = !fade;
    syncFadeNormUi();
  }

  function syncFadeNormUi() {
    const fade = paintStyle === HS.PAINT_FADE;
    const fadeNormRow = rowFor(HS.KEY_FADE_NORM);
    if (fadeNormRow) fadeNormRow.hidden = !fade;
    el.ih_fade_norm_row.hidden = !fade || !fadeNormOn();
    syncPaintDemo();
  }

  function syncPaintStyle(v) {
    paintStyle = HS.normalizePaintStyle(v);
    for (const btn of el.ih_paint_style.querySelectorAll('.ih-paint-card')) {
      btn.setAttribute('aria-checked', btn.dataset.style === paintStyle ? 'true' : 'false');
    }
    syncPaintColorUi();
    syncTwoTierUi(!!document.getElementById(HS.KEY_TWO_TIER)?.checked);
  }

  function syncThresholdLabel(pct) {
    el.ih_threshold_value.textContent = HS.formatThresholdLabel(pct);
    syncPaintDemo();
  }

  let paintStyle = HS.PAINT_FADE;
  let highlightColor = HS.HUE_RED;
  let lastHue = HS.HUE_RED;
  let textColor = 'red';

  const PAINT_CARD_LABEL = Object.freeze({
    [HS.PAINT_BLOCK]: tr('Color blocks'),
    [HS.PAINT_UNDERLINE]: tr('Underline'),
    [HS.PAINT_TEXT]: tr('Text color'),
    [HS.PAINT_FADE]: tr('Fade unimportant'),
  });

  function hueNear(a, b) {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d) <= 8;
  }

  function parseRgb(rgb) {
    return rgb.split(',').map((s) => Number(s.trim()));
  }

  function activeRgb() {
    return paintStyle === HS.PAINT_TEXT
      ? HS.rgbForTextColor(textColor)
      : HS.rgbForColor(highlightColor);
  }

  /** 滑条 accent 合成到页面底色上，观感接近正文里的高亮 */
  function intensityAccent(depth) {
    const a = HS.depthToMaxAlpha(depth, paintStyle);
    const [r, g, b] = parseRgb(activeRgb());
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/\d+/g);
    if (!m || m.length < 3) return `rgba(${r}, ${g}, ${b}, ${a})`;
    const [br, bgG, bb] = m.map(Number);
    return `rgb(${Math.round(br * (1 - a) + r * a)}, ${Math.round(bgG * (1 - a) + g * a)}, ${Math.round(bb * (1 - a) + b * a)})`;
  }

  function syncHighlightColor(v) {
    highlightColor = HS.normalizeHighlightColor(v);
    const ink = HS.isInk(highlightColor);
    if (!ink) lastHue = highlightColor;
    el.ih_highlight_color.value = String(lastHue);
    el.ih_highlight_color.hidden = ink;
    const rgb = activeRgb();
    document.documentElement.style.setProperty('--ih-highlight-rgb', rgb);
    document.documentElement.style.setProperty('--ih-mark-rgb', HS.rgbForColor(highlightColor));
    el.ih_highlight_color.style.setProperty('--ih-hue-track', HS.hueTrackCss());
    for (const btn of el.ih_highlight_swatches.querySelectorAll('.ih-color-swatch')) {
      const id = btn.dataset.color;
      const on = id === HS.COLOR_INK
        ? ink
        : !ink && hueNear(HS.hueForColorId(id), lastHue);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    syncDepthLabel(HS.clampMaxAlphaDepth(el.ih_max_highlight_alpha.value));
  }

  function syncTextColor(v) {
    textColor = HS.normalizeTextColor(v);
    for (const btn of el.ih_text_swatches.querySelectorAll('.ih-color-swatch')) {
      btn.setAttribute('aria-checked', btn.dataset.color === textColor ? 'true' : 'false');
    }
    document.documentElement.style.setProperty('--ih-ink-rgb', HS.rgbForTextColor(textColor));
    if (paintStyle === HS.PAINT_TEXT) {
      document.documentElement.style.setProperty('--ih-highlight-rgb', HS.rgbForTextColor(textColor));
    }
    syncDepthLabel(HS.clampMaxAlphaDepth(el.ih_max_highlight_alpha.value));
  }

  function syncDepthLabel(depth) {
    el.ih_depth_value.textContent = HS.formatDepthLabel(depth);
    const input = el.ih_max_highlight_alpha;
    const min = Number(input.min);
    const max = Number(input.max);
    const pct = max === min ? 100 : ((depth - min) / (max - min)) * 100;
    input.style.setProperty('--ih-intensity-accent', intensityAccent(depth));
    input.style.setProperty('--ih-intensity-pct', `${pct}%`);
    const root = document.documentElement;
    root.style.setProperty('--ih-block-max', String(HS.depthToMaxAlpha(depth, HS.PAINT_BLOCK)));
    root.style.setProperty('--ih-line-max', String(HS.depthToMaxAlpha(depth, HS.PAINT_UNDERLINE)));
    root.style.setProperty('--ih-ink-max', String(HS.depthToMaxAlpha(depth, HS.PAINT_TEXT)));
  }

  HS.watchColorScheme(() => {
    syncHighlightColor(highlightColor);
    syncTextColor(textColor);
  });

  function loadToggles() {
    for (const key of TOGGLE_KEYS) {
      const box = document.getElementById(key);
      if (!box) throw new Error(`options page missing checkbox: ${key}`);
      box.addEventListener('change', () => {
        chrome.storage.local.set({ [key]: box.checked });
        if (key === HS.KEY_TWO_TIER) syncTwoTierUi(box.checked);
        if (key === HS.KEY_FADE_NORM) syncFadeNormUi();
        if (key === 'ih_dynamic_track') syncDynamicTrackUi(box.checked);
      });
    }
    return new Promise((resolve) => {
      chrome.storage.local.get(optionDefaults, (res) => {
        for (const key of TOGGLE_KEYS) {
          const box = document.getElementById(key);
          box.checked = !!optionStored(key, res?.[key]);
          if (key === HS.KEY_TWO_TIER) syncTwoTierUi(box.checked);
          if (key === HS.KEY_FADE_NORM) syncFadeNormUi();
          if (key === 'ih_dynamic_track') syncDynamicTrackUi(box.checked);
        }
        resolve();
      });
    });
  }

  function loadSliders() {
    return new Promise((resolve) => {
      chrome.storage.local.get(optionDefaults, (res) => {
        applyHighlightForm(HS.normalizePrefs(res));
        resolve();
      });
    });
  }

  function syncDynamicTrackUi(on) {
    const fromRow = rowFor('ih_from_viewport');
    if (fromRow) fromRow.hidden = !!on;
  }


  function applyHighlightForm(prefs) {
    el.ih_highlight_threshold_pct.value = String(prefs.thresholdPct);
    syncThresholdLabel(prefs.thresholdPct);
    syncPaintStyle(prefs.paintStyle);
    el.ih_max_highlight_alpha.value = String(prefs.maxAlphaDepth);
    syncHighlightColor(prefs.highlightColor);
    syncTextColor(prefs.textColor);
    syncFadeLabel(prefs.fadeMinPct);
    syncFadeNormLabel(prefs.fadeNormPct);
    syncTwoTierUi(prefs.twoTier);
    syncFadeNormUi();
  }

  function syncFadeLabel(pct) {
    const p = HS.clampFadeMinPct(pct);
    el.ih_fade_min_pct.value = String(p);
    el.ih_fade_value.textContent = HS.formatFadeLabel(p);
    const input = el.ih_fade_min_pct;
    const min = Number(input.min);
    const max = Number(input.max);
    const fill = max === min ? 100 : ((p - min) / (max - min)) * 100;
    input.style.setProperty('--ih-intensity-pct', `${fill}%`);
    syncPaintDemo();
  }

  function syncFadeNormLabel(pct) {
    const p = HS.clampFadeNormPct(pct);
    el.ih_fade_norm_pct.value = String(p);
    el.ih_fade_norm_value.textContent = HS.formatFadeNormLabel(p);
    const input = el.ih_fade_norm_pct;
    const min = Number(input.min);
    const max = Number(input.max);
    const fill = max === min ? 100 : ((p - min) / (max - min)) * 100;
    input.style.setProperty('--ih-intensity-pct', `${fill}%`);
    syncPaintDemo();
  }

  el.ih_highlight_threshold_pct.addEventListener('input', () => {
    const pct = HS.clampThresholdPct(el.ih_highlight_threshold_pct.value);
    el.ih_highlight_threshold_pct.value = String(pct);
    syncThresholdLabel(pct);
    chrome.storage.local.set({ [HS.KEY_THRESHOLD_PCT]: pct });
  });

  el.ih_max_highlight_alpha.addEventListener('input', () => {
    const depth = HS.clampMaxAlphaDepth(el.ih_max_highlight_alpha.value);
    el.ih_max_highlight_alpha.value = String(depth);
    syncDepthLabel(depth);
    chrome.storage.local.set({ [HS.KEY_MAX_ALPHA_DEPTH]: depth });
  });

  el.ih_fade_min_pct.addEventListener('input', () => {
    const pct = HS.clampFadeMinPct(el.ih_fade_min_pct.value);
    syncFadeLabel(pct);
    chrome.storage.local.set({ [HS.KEY_FADE_MIN_PCT]: pct });
  });

  el.ih_fade_norm_pct.addEventListener('input', () => {
    const pct = HS.clampFadeNormPct(el.ih_fade_norm_pct.value);
    syncFadeNormLabel(pct);
    chrome.storage.local.set({ [HS.KEY_FADE_NORM_PCT]: pct });
  });


  el.restore_recommended.addEventListener('click', () => {
    if (!confirm(tr('Restore recommended settings? Auto-analyze sites stay.'))) return;
    for (const key of TOGGLE_KEYS) {
      document.getElementById(key).checked = !!optionDefaults[key];
    }
    applyHighlightForm(HS.normalizePrefs({}));
    syncDynamicTrackUi(!!optionDefaults.ih_dynamic_track);
    const keys = [
      ...Object.keys(optionDefaults),
      IH_localState.LEGACY_PREF,
      IH_localState.LEGACY_CLOUD_MODEL,
    ];
    void IH_localState.get().then((st) => {
      const engineChanged = st.choice !== IH_localState.CHOICE_CLOUD_QWEN;
      chrome.storage.local.remove([...new Set(keys)], () => {
        void IH_localState.set({ choice: IH_localState.CHOICE_CLOUD_QWEN }).then(() => {
          if (!engineChanged) {
            loadBackend();
            return;
          }
          void IH_analyzeCache.dropAll().finally(() => loadBackend());
        });
      });
    });
  });

  function pickPaint(v) {
    syncPaintStyle(v);
    chrome.storage.local.set({ [HS.KEY_PAINT_STYLE]: paintStyle });
    syncHighlightColor(highlightColor);
    syncTextColor(textColor);
  }

  function paintDemo(style) {
    const demo = document.createElement('span');
    demo.className = 'ih-paint-demo';
    demo.setAttribute('aria-hidden', 'true');
    for (const [raw, bits] of DEMO_TOKENS) {
      const s = document.createElement('span');
      s.dataset.bits = String(bits);
      s.style.setProperty('--ih-p', String(demoPFor(bits, style ?? paintStyle)));
      s.textContent = raw;
      demo.append(s);
    }
    return demo;
  }

  for (const id of HS.PAINT_STYLES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ih-paint-card';
    btn.dataset.style = id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', PAINT_CARD_LABEL[id]);
    btn.append(paintDemo(id));
    btn.addEventListener('click', () => pickPaint(id));
    el.ih_paint_style.append(btn);
  }

  el.ih_highlight_color.addEventListener('input', () => {
    syncHighlightColor(el.ih_highlight_color.value);
    chrome.storage.local.set({ [HS.KEY_HIGHLIGHT_COLOR]: highlightColor });
  });

  function appendColorSwatch(id, label, rgb) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ih-color-swatch';
    btn.dataset.color = id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', label);
    if (id === HS.COLOR_INK) btn.classList.add('ih-color-swatch-ink');
    else btn.style.setProperty('--ih-swatch-rgb', rgb);
    btn.addEventListener('click', () => {
      syncHighlightColor(id === HS.COLOR_INK ? HS.COLOR_INK : HS.hueForColorId(id));
      chrome.storage.local.set({ [HS.KEY_HIGHLIGHT_COLOR]: highlightColor });
    });
    el.ih_highlight_swatches.append(btn);
  }
  for (const id of HS.COLOR_IDS) {
    appendColorSwatch(id, `${id[0].toUpperCase()}${id.slice(1)}`, HS.rgbForHue(HS.hueForColorId(id)));
  }
  appendColorSwatch(HS.COLOR_INK, 'Black / white');

  for (const id of HS.TEXT_COLOR_IDS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ih-color-swatch';
    btn.dataset.color = id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', `${id[0].toUpperCase()}${id.slice(1)}`);
    btn.style.setProperty('--ih-swatch-rgb', HS.rgbForTextColor(id));
    btn.addEventListener('click', () => {
      syncTextColor(id);
      chrome.storage.local.set({ [HS.KEY_TEXT_COLOR]: textColor });
    });
    el.ih_text_swatches.append(btn);
  }

  function modelDisplayName(modelId) {
    return IH_localState.modelLabel(modelId);
  }

  function choiceLabel(choice, unavailable) {
    if (choice.id === IH_localState.CHOICE_CLOUD_QWEN) return tr('Cloud - Qwen3 0.6B');
    if (choice.id === IH_localState.CHOICE_CLOUD_GEMMA) return tr('Cloud - Gemma 3 270M');
    if (choice.id === IH_localState.CHOICE_LOCAL_GEMMA) {
      return unavailable
        ? tr('On-device - Gemma 3 270M (unavailable)')
        : tr('On-device - Gemma 3 270M');
    }
    if (choice.id === IH_localState.CHOICE_LOCAL_QWEN3) {
      return unavailable
        ? tr('On-device - Qwen3 0.6B (unavailable)')
        : tr('On-device - Qwen3 0.6B');
    }
    throw new Error(`bad model choice: ${choice.id}`);
  }

  function fillModelChoices(webgpuOk) {
    const unavailable = webgpuOk === false;
    el.analyze_pref.replaceChildren();
    for (const choice of IH_localState.CHOICES) {
      const opt = document.createElement('option');
      opt.value = choice.id;
      opt.textContent = choiceLabel(choice, unavailable);
      opt.disabled = choice.local && unavailable;
      el.analyze_pref.append(opt);
    }
  }

  let webgpuLingerSelectFilled = false;
  function ensureWebgpuLingerSelect() {
    if (webgpuLingerSelectFilled) return;
    webgpuLingerSelectFilled = true;
    for (const sec of IH_localState.WEBGPU_LINGER_SECS) {
      const opt = document.createElement('option');
      opt.value = String(sec);
      const labelKey = IH_localState.webgpuLingerLabelKey(sec);
      if (labelKey === '10 seconds') opt.textContent = tr('10 seconds');
      else if (labelKey === '1 minute') opt.textContent = tr('1 minute');
      else if (labelKey === '10 minutes') opt.textContent = tr('10 minutes');
      else if (labelKey === '60 minutes') opt.textContent = tr('60 minutes');
      else opt.textContent = tr('10 seconds');
      el.webgpu_linger_sec.append(opt);
    }
  }

  const localModelRows = new Map();
  let modelCacheGen = 0;
  let downloadLocalId = null;

  function ensureLocalModelRows() {
    if (localModelRows.size > 0) return;
    for (const localId of IH_localState.LOCAL_MODEL_IDS) {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.localId = localId;
      const text = document.createElement('div');
      text.className = 'row-text';
      const title = document.createElement('div');
      title.className = 'row-title';
      title.textContent = modelDisplayName(localId);
      const desc = document.createElement('p');
      desc.className = 'row-desc';
      desc.textContent = tr('Reading…');
      text.append(title, desc);
      const btns = document.createElement('div');
      btns.className = 'row-btns';
      const prepareBtn = document.createElement('button');
      prepareBtn.type = 'button';
      prepareBtn.textContent = tr('Prepare');
      prepareBtn.addEventListener('click', () => startPrepare(localId));
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = tr('Clear');
      clearBtn.disabled = true;
      clearBtn.addEventListener('click', () => clearLocalModel(localId));
      btns.append(prepareBtn, clearBtn);
      row.append(text, btns);
      el.local_models_list.append(row);
      localModelRows.set(localId, { desc, prepareBtn, clearBtn });
    }
  }

  function localModelStatusText(localId, readyIds, webgpu) {
    if (!webgpu) return tr('This computer cannot run the on-device model');
    if (readyIds.includes(localId)) return tr('Ready');
    return tr('Not prepared');
  }

  function syncCloudOnlyUi(choiceId) {
    const show = !IH_localState.choiceById(choiceId).local;
    el.ih_cloud_api_base_row.hidden = !show;
    el.ih_cloud_latency_row.hidden = !show;
    if (!show) el.ih_cloud_api_base_wrap.hidden = true;
    else syncCloudApiBaseWrapVisible();
  }

  function applyBackend(st) {
    ensureLocalModelRows();
    ensureWebgpuLingerSelect();
    const webgpu = st.webgpuOk === true;
    el.webgpu_desc.textContent = IH_userErrors.webgpuStatusLine(st);
    if (!webgpu) {
      el.local_models_hint.hidden = false;
      el.local_models_hint.textContent = tr('This computer cannot run the on-device model');
    } else {
      el.local_models_hint.hidden = true;
      el.local_models_hint.textContent = '';
    }
    fillModelChoices(st.webgpuOk);
    el.analyze_pref.value = st.choice;
    syncCloudOnlyUi(st.choice);
    el.webgpu_linger_sec.value = String(st.webgpuLingerSec);
    const readyIds = st.readyIds || [];
    const gen = ++modelCacheGen;
    for (const localId of IH_localState.LOCAL_MODEL_IDS) {
      const ui = localModelRows.get(localId);
      if (!ui) continue;
      const base = localModelStatusText(localId, readyIds, webgpu);
      ui.desc.textContent = base;
      ui.prepareBtn.disabled = !webgpu || readyIds.includes(localId) || downloadLocalId != null;
      ui.clearBtn.disabled = true;
    }
    const usagePromises = IH_localState.LOCAL_MODEL_IDS.map((localId) =>
      globalThis.IH_localState.modelCacheUsage(localId).then(({ bytes }) => ({ localId, bytes })),
    );
    return Promise.all(usagePromises).then((rows) => {
      if (gen !== modelCacheGen) return;
      for (const { localId, bytes } of rows) {
        const ui = localModelRows.get(localId);
        if (!ui) continue;
        const base = localModelStatusText(localId, readyIds, webgpu);
        ui.desc.textContent = bytes > 0 ? `${base} · ${formatBytes(bytes)}` : base;
        ui.clearBtn.disabled = bytes === 0 && !readyIds.includes(localId);
        if (downloadLocalId === localId) {
          ui.prepareBtn.disabled = true;
          ui.clearBtn.disabled = true;
        }
      }
    }).catch(() => {
      if (gen !== modelCacheGen) return;
      for (const localId of IH_localState.LOCAL_MODEL_IDS) {
        const ui = localModelRows.get(localId);
        if (!ui) continue;
        ui.clearBtn.disabled = !readyIds.includes(localId);
      }
    });
  }

  function syncNewDotsPaused(overlay) {
    globalThis.IL_optionsNewDots?.setPaused(!!overlay);
  }

  function loadBackend() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'ih-local-status' }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          el.webgpu_desc.textContent = res?.error || chrome.runtime.lastError?.message || tr('Failed to read status');
          for (const ui of localModelRows.values()) {
            ui.prepareBtn.disabled = true;
            ui.clearBtn.disabled = true;
          }
          resolve();
          return;
        }
        syncNewDotsPaused(res.initOverlay);
        void Promise.resolve(applyBackend(res)).finally(resolve);
      });
    });
  }

  el.analyze_pref.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'ih-local-set-choice', id: el.analyze_pref.value }, () => {
      loadBackend();
    });
  });

  el.webgpu_linger_sec.addEventListener('change', () => {
    const sec = IH_localState.normalizeWebgpuLingerSec(el.webgpu_linger_sec.value);
    void IH_localState.set({ webgpuLingerSec: sec }).catch((err) => {
      console.error('[Info Highlight] webgpu linger', err);
    });
  });

  function startPrepare(localId) {
    syncNewDotsPaused(true);
    downloadLocalId = localId;
    for (const ui of localModelRows.values()) {
      ui.prepareBtn.disabled = true;
      ui.clearBtn.disabled = true;
    }
    chrome.runtime.sendMessage({ type: 'ih-local-open-init', localId }, () => {
      if (chrome.runtime.lastError) downloadLocalId = null;
      loadBackend();
    });
  }

  function clearLocalModel(localId) {
    const model = modelDisplayName(localId);
    if (!confirm(tr('Clear {model}? Using it next time will download the weights again.', { model }))) return;
    const ui = localModelRows.get(localId);
    if (ui) {
      ui.clearBtn.disabled = true;
      ui.prepareBtn.disabled = true;
    }
    chrome.runtime.sendMessage({ type: 'ih-local-drop-model', localId }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        if (ui) ui.desc.textContent = res?.error || chrome.runtime.lastError?.message || tr('Failed to clear');
        loadBackend();
        return;
      }
      loadBackend();
    });
  }

  function autoSiteRow(host) {
    const li = document.createElement('li');
    li.className = 'row';
    const text = document.createElement('div');
    text.className = 'row-text';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = host;
    text.append(title);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = tr('Remove');
    btn.addEventListener('click', () => {
      btn.disabled = true;
      // 名单变了由 storage.onChanged 重绘
      globalThis.IH_autoSites.remove(host).catch((err) => {
        btn.disabled = false;
        showAutoSiteError(String(err?.message || err));
      });
    });
    li.append(text, btn);
    return li;
  }

  function loadAutoSites() {
    return globalThis.IH_autoSites.list().then((hosts) => {
      el.auto_sites.replaceChildren(...hosts.map(autoSiteRow));
    });
  }

  function showAutoSiteError(msg) {
    el.auto_site_error.hidden = !msg;
    el.auto_site_error.textContent = msg || '';
  }

  async function addAutoSite() {
    showAutoSiteError('');
    const host = globalThis.IH_autoSites.parseHost(el.auto_site_input.value);
    if (!host) {
      showAutoSiteError(tr('Enter a site like example.com, *.example.com, or * for every site'));
      return;
    }
    // 选项页点 Add 本身就是手势，可直接 request
    const granted = await globalThis.IH_autoSites.requestAllSitesPermission();
    if (!granted) return;
    // 名单变了由 storage.onChanged 重绘
    await globalThis.IH_autoSites.add(host);
    el.auto_site_input.value = '';
  }

  function submitAutoSite() {
    addAutoSite().catch((err) => showAutoSiteError(String(err?.message || err)));
  }

  el.auto_site_add.addEventListener('click', submitAutoSite);
  el.auto_site_input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAutoSite();
    }
  });

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) throw new Error(`bad cache size: ${n}`);
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) {
      const kb = n / 1024;
      return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    }
    const mb = n / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }

  async function refresh() {
    const { entries, bytes } = await globalThis.IH_analyzeCache.usage();
    el.cache_desc.textContent = tr('{entries} entries · {size}', { entries, size: formatBytes(bytes) });
    el.cache_clear.disabled = entries === 0;
  }

  function showCacheError(err) {
    el.cache_desc.textContent = err?.message || String(err);
    el.cache_clear.disabled = true;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ih-local-init-overlay') {
      syncNewDotsPaused(msg.active);
      return;
    }
    if (msg?.type === 'ih-local-init-outcome') {
      downloadLocalId = null;
      loadBackend();
      return;
    }
    if (msg?.type !== 'ih-local-progress') return;
    const info = msg.info;
    for (const ui of localModelRows.values()) {
      ui.prepareBtn.disabled = true;
      ui.clearBtn.disabled = true;
    }
    const activeId = downloadLocalId;
    const ui = activeId ? localModelRows.get(activeId) : null;
    if (!ui) return;
    if (info && Number.isFinite(info.loaded) && Number.isFinite(info.total) && info.total > 0) {
      const file = info.file || info.name || '';
      ui.desc.textContent = tr('Downloading {file} · {loaded} / {total}', {
        file, loaded: formatBytes(info.loaded), total: formatBytes(info.total),
      });
    } else {
      ui.desc.textContent = tr('Downloading on-device model…');
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (
      changes.ih_webgpu_ok
      || changes[IH_localState.KEYS.webgpuBlockReason]
      || changes[IH_localState.KEYS.choice]
      || changes.ih_local_ready
    ) {
      loadBackend();
    }
    if (changes[globalThis.IH_autoSites.KEY]) void loadAutoSites();
    if (Object.keys(changes).some((k) => k.startsWith(globalThis.IH_analyzeCache.PREFIX))) {
      void refresh().catch(showCacheError);
    }
  });

  const ABOUT_LEAD =
    'Info Highlight is part of <a class="about-home" href="https://info-lens.app/" target="_blank" rel="noopener noreferrer">Info Lens</a>, a toolbox for exploring the informational nature of LLMs and language.';
  const STORE_REVIEWS =
    'https://chromewebstore.google.com/detail/gemajnklkebeikmfphiddpjfimahacdk/reviews';
  const aboutSection = document.getElementById('about');
  if (!aboutSection) throw new Error('options page missing #about');
  globalThis.IL_optionsAbout.mount(aboutSection, {
    tr,
    leadHtml: tr(ABOUT_LEAD),
    storeReviewUrl: STORE_REVIEWS,
    async sendNote(note) {
      const res = await chrome.runtime.sendMessage({ type: 'ih-author-note', ...note });
      if (!res?.ok) throw new Error(res?.error || 'Could not send');
    },
  });
  const reviewLink = aboutSection.querySelector('.about-actions > a.about-pill');
  if (!reviewLink) throw new Error('about review link missing');
  const donateOpen = document.createElement('button');
  donateOpen.type = 'button';
  donateOpen.id = 'donate_open';
  donateOpen.className = 'about-pill';
  donateOpen.textContent = tr('Donate');
  reviewLink.after(donateOpen);
  el.donate_open = donateOpen;

  const sampleFooter = document.createElement('p');
  sampleFooter.className = 'about-sample-footer';
  const sampleLink = document.createElement('a');
  sampleLink.href = 'https://info-lens.app/info-highlight-preview';
  sampleLink.target = '_blank';
  sampleLink.rel = 'noopener noreferrer';
  sampleLink.textContent = tr('Editable preview page');
  sampleFooter.append(sampleLink);
  aboutSection.append(sampleFooter);

  void globalThis.IL_optionsAbout.applyOpenFeedbackIfRequested?.();

  el.cache_clear.addEventListener('click', async () => {
    el.cache_clear.disabled = true;
    try {
      await globalThis.IH_analyzeCache.dropAll();
      await refresh();
    } catch (err) {
      el.cache_desc.textContent = err?.message || String(err);
      el.cache_clear.disabled = false;
    }
  });

  let creditsGen = 0;
  let creditsShown = false;
  let creditsApiKey = '';
  let creditOrders = [];
  /** @type {{ order_id: string, pay_url: string } | null} */
  let creditStoredPay = null;
  /** 后台自动查单失败的那笔，在它那一行显示「查询失败」 */
  let creditConfirmFailedId = '';
  let refreshFlight = null;

  function recentPendingOrderId(orders) {
    for (const order of orders) {
      if (order.payment_status === 'pending') return order.order_id;
    }
    return '';
  }

  function readCreditPay(value) {
    const orderId = value?.order_id;
    const payUrl = value?.pay_url;
    if (typeof orderId !== 'string' || typeof payUrl !== 'string' || !payUrl.startsWith('https://')) return null;
    return { order_id: orderId, pay_url: payUrl };
  }

  function orderTime(ms) {
    if (!Number.isInteger(ms) || ms <= 0) return '';
    const date = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  function formatPoints(n) {
    return tr('{points} points', { points: n });
  }

  function setCreditsApiKey(key) {
    creditsApiKey = key;
    el.credits_api_key.textContent = `${key.slice(0, 7)}…${key.slice(-4)}`;
    el.credits_api_key.title = key;
    el.credits_api_key.classList.remove('is-pending');
    el.credits_api_key.removeAttribute('aria-hidden');
  }

  function orderCurrencyLabel(currency) {
    if (globalThis.IH_i18n.zh) return currency === 'USD' ? '美元' : '元';
    return currency;
  }

  function appendCell(parent, className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    parent.append(span);
    return span;
  }

  function appendNumericGroup(parent, groupClass, numberClass, numberText, unitClass, unitText) {
    const group = document.createElement('span');
    group.className = groupClass;
    appendCell(group, numberClass, numberText);
    appendCell(group, unitClass, unitText);
    parent.append(group);
  }

  const PAY_BY_CURRENCY = {
    CNY: ['alipay', 'waffo_cny'],
    USD: ['waffo'],
  };
  let purchasePack = null;
  let purchasePacks = [];
  /** @type {{ CNY: object[], USD: object[] } | null} */
  let purchaseCatalog = null;

  function packPriceParts(offer, currency) {
    const amount = offer?.amount ?? '—';
    if (globalThis.IH_i18n.zh) {
      return { symbol: currency === 'USD' ? '$' : '¥', amount, code: '' };
    }
    return { symbol: '', amount, code: currency };
  }

  function packLabelText(pack) {
    return creditNoticeText(pack?.label, globalThis.IH_i18n.zh);
  }

  function defaultPurchaseCurrency(preferred) {
    return preferred === 'USD' || preferred === 'CNY'
      ? preferred
      : (globalThis.IH_i18n.zh ? 'CNY' : 'USD');
  }

  function selectedCurrency(container) {
    const currency = container.querySelector('button[aria-pressed="true"]')?.dataset.currency;
    return currency === 'USD' ? 'USD' : 'CNY';
  }

  function selectedPurchaseCurrency() {
    return selectedCurrency(el.credits_currency);
  }

  function packPriceOffer(pack, currency) {
    if (currency === 'USD') return pack.payments.waffo;
    return pack.payments.alipay || pack.payments.waffo_cny;
  }

  function paymentChoiceLabel(provider) {
    if (provider === 'waffo') return tr('Card / Apple Pay / Google Pay');
    if (provider === 'waffo_cny') return tr('WeChat Pay');
    return tr('Alipay');
  }

  function paymentChoiceNote(provider) {
    return provider === 'alipay' ? '' : tr('Via payment partner');
  }

  function checkedPurchaseValue(list, name) {
    const value = list.querySelector(`input[name="${name}"]:checked`)?.value;
    if (!value) throw new Error('Could not start payment.');
    return value;
  }

  function textColumnUnits(text) {
    let units = 0;
    for (const ch of text) {
      units += /[^\x00-\xff]/.test(ch) ? 2 : 1;
    }
    return units;
  }

  /** 一列里最宽那项的宽度 */
  function textColumnWidth(texts) {
    const units = Math.max(0, ...texts.map(textColumnUnits));
    return units ? `${units}ch` : '0px';
  }

  function packPriceText(parts) {
    return parts.symbol ? `${parts.symbol}${parts.amount}` : `${parts.amount} ${parts.code}`;
  }

  function renderPurchasePacks() {
    const currency = selectedPurchaseCurrency();
    const selectedId = purchasePack?.id ?? purchasePacks[0]?.id;
    const rows = purchasePacks.map((pack) => ({
      pack,
      discount: packLabelText(pack),
      price: packPriceParts(packPriceOffer(pack, currency), currency),
    }));
    el.credits_pack_list.style.setProperty('--pack-discount-width', textColumnWidth(rows.map((row) => row.discount)));
    el.credits_pack_list.style.setProperty('--pack-price-width', textColumnWidth(rows.map((row) => packPriceText(row.price))));
    el.credits_pack_list.style.setProperty('--pack-credits-width', textColumnWidth(purchasePacks.map((pack) => String(pack.credits))));
    el.credits_pack_list.replaceChildren(...rows.map(({ pack, discount, price }) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'row';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'credits_pack';
      input.value = pack.id;
      input.checked = pack.id === selectedId;
      input.disabled = purchasePacks.length <= 1;
      const line = document.createElement('span');
      line.className = 'pack-line';
      appendNumericGroup(line, 'pack-points', 'pack-credits', String(pack.credits), 'pack-unit', tr('points'));
      const trailing = document.createElement('span');
      trailing.className = 'pack-trailing';
      appendCell(trailing, 'pack-discount', discount);
      const priceGroup = document.createElement('span');
      priceGroup.className = 'pack-price';
      if (price.symbol) {
        appendCell(priceGroup, 'pack-symbol', price.symbol);
        appendCell(priceGroup, 'pack-amount', price.amount);
      } else {
        appendCell(priceGroup, 'pack-amount', price.amount);
        appendCell(priceGroup, 'pack-code', price.code);
      }
      trailing.append(priceGroup);
      line.append(trailing);
      label.append(input, line);
      li.append(label);
      return li;
    }));
    purchasePack = purchasePacks.find((item) => item.id === selectedId) || purchasePacks[0];
  }

  function packsForPurchaseCurrency(catalog, currency) {
    const list = currency === 'USD' ? catalog?.USD : catalog?.CNY;
    return Array.isArray(list) ? list.filter((pack) => pack?.payments) : [];
  }

  function applyPurchaseCurrency(currency) {
    if (!purchaseCatalog) return;
    const packs = packsForPurchaseCurrency(purchaseCatalog, currency);
    if (!packs.length) return;
    const keepId = purchasePack?.id;
    purchasePacks = packs;
    purchasePack = (keepId && packs.find((p) => p.id === keepId)) || packs[0];
    setCurrencyPressed(el.credits_currency, currency);
    renderPurchasePacks();
    renderPayChoices();
  }

  function renderPurchaseChoices(catalog, opts = {}) {
    purchaseCatalog = catalog;
    let currency = defaultPurchaseCurrency(opts.currency);
    let packs = packsForPurchaseCurrency(catalog, currency);
    if (!packs.length) {
      const fallback = currency === 'CNY' ? 'USD' : 'CNY';
      packs = packsForPurchaseCurrency(catalog, fallback);
      if (packs.length) currency = fallback;
    }
    if (!packs.length) throw new Error('Could not start payment.');
    purchasePacks = packs;
    purchasePack = packs[0];
    layoutCurrencyButtons(el.credits_currency, defaultPurchaseCurrency(opts.currency));
    setCurrencyPressed(el.credits_currency, currency);
    renderPurchasePacks();
    renderPayChoices();
  }

  function layoutCurrencyButtons(container, firstCurrency) {
    const buttons = [...container.querySelectorAll('button[data-currency]')];
    buttons.sort((a, b) => {
      if (a.dataset.currency === firstCurrency) return -1;
      if (b.dataset.currency === firstCurrency) return 1;
      return 0;
    });
    container.replaceChildren(...buttons);
  }

  function setCurrencyPressed(container, currency) {
    for (const btn of container.querySelectorAll('button[data-currency]')) {
      btn.setAttribute('aria-pressed', btn.dataset.currency === currency ? 'true' : 'false');
    }
  }

  function renderPayChoices() {
    const pack = purchasePack;
    const currency = selectedPurchaseCurrency();
    const providers = (PAY_BY_CURRENCY[currency] || []).filter((id) => pack?.payments[id]);
    el.credits_pay_list.replaceChildren(...providers.map((id, index) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'row credits-pay';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'credits_provider';
      input.value = id;
      input.checked = index === 0;
      const copy = document.createElement('span');
      copy.className = 'credits-pay-copy';
      const title = document.createElement('span');
      title.textContent = paymentChoiceLabel(id);
      copy.append(title);
      const note = paymentChoiceNote(id);
      if (note) {
        const sub = document.createElement('span');
        sub.className = 'credits-pay-note';
        sub.textContent = note;
        copy.append(sub);
      }
      label.append(input, copy);
      li.append(label);
      return li;
    }));
    el.credits_purchase_go.disabled = providers.length === 0;
  }

  async function openPurchaseDialog(opts = {}) {
    el.credits_status.hidden = true;
    el.credits_add.disabled = true;
    el.donate_intl_go.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ih-credits-catalog' });
      if (!res?.ok || !Array.isArray(res.CNY) || !Array.isArray(res.USD) || (!res.CNY.length && !res.USD.length)) {
        throw new Error('Could not start payment.');
      }
      renderPurchaseChoices({ CNY: res.CNY, USD: res.USD }, opts);
      if (el.donate_dialog.open) el.donate_dialog.close();
      el.credits_purchase_dialog.showModal();
    } catch {
      if (el.donate_dialog.open) el.donate_dialog.close();
      showCreditsStatus(tr('Could not start payment.'));
    } finally {
      el.credits_add.disabled = false;
      el.donate_intl_go.disabled = false;
    }
  }

  function beginCreditsPurchase(opts) {
    void chrome.runtime.sendMessage({ type: 'ih-credits-add-click' });
    void openPurchaseDialog(opts);
  }
  if (openPurchaseOnLoad) beginCreditsPurchase();

  function orderStatusText(order) {
    if (order.payment_status === 'pending') {
      return order.order_id === creditConfirmFailedId ? tr('Query failed') : tr('Unpaid');
    }
    if (!order.refunded_cents) return tr('Paid');
    return order.refunded_cents >= moneyToCents(order.amount) ? tr('Refunded') : tr('Partially refunded');
  }

  function isCustomAmountOrder(order) {
    return order?.amount_kind === 'custom';
  }

  function isPromoGiftOrder(order) {
    return order?.amount_kind === 'promo';
  }

  function promoGiftLabel(order) {
    const t = typeof order?.promo_label === 'string' ? order.promo_label.trim() : '';
    return t || tr('Gift');
  }

  function renderCreditOrders(orders) {
    creditOrders = orders.slice(0, 3);
    el.credits_orders.replaceChildren(...creditOrders.map((order) => {
      const li = document.createElement('li');
      li.className = 'row';
      const currency = order.currency === 'USD' ? 'USD' : 'CNY';
      appendCell(li, 'order-time', orderTime(order.created_at));
      if (isPromoGiftOrder(order)) {
        appendCell(li, 'order-money', promoGiftLabel(order));
      } else {
        appendNumericGroup(li, 'order-money', 'order-amount', order.amount, 'order-currency', orderCurrencyLabel(currency));
      }
      if (isCustomAmountOrder(order)) {
        appendCell(li, 'order-thanks', tr('Thank you for your support.'));
      } else {
        appendNumericGroup(li, 'order-points', 'order-credits', String(order.order_credits), 'order-unit', tr('points'));
      }
      appendCell(li, 'order-status', orderStatusText(order));
      if (order.payment_status === 'pending') {
        const actions = document.createElement('span');
        actions.className = 'order-actions';
        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.textContent = tr('Refresh status');
        refreshBtn.addEventListener('click', () => { void confirmCreditOrder(order.order_id, refreshBtn); });
        actions.append(refreshBtn);
        const recentPendingId = recentPendingOrderId(creditOrders);
        if (recentPendingId === order.order_id && creditStoredPay?.order_id === order.order_id) {
          const payBtn = document.createElement('button');
          payBtn.type = 'button';
          payBtn.textContent = tr('Continue to pay');
          payBtn.addEventListener('click', () => { void chrome.tabs.create({ url: creditStoredPay.pay_url }); });
          actions.append(payBtn);
        }
        li.append(actions);
      }
      return li;
    }));
  }

  function showCreditsStatus(message) {
    el.credits_status.hidden = false;
    el.credits_status.textContent = message;
  }

  /** 门面公告：取界面语言那份，空则用另一份；都空或没有为 ''。 */
  function creditNoticeText(notice, zh) {
    if (!notice) return '';
    return zh ? notice.zh || notice.en : notice.en || notice.zh;
  }

  /** 本机 key，不依赖额度接口；避免云端刷新失败时 API Key 一直隐藏 */
  async function loadCreditsApiKey() {
    const res = await chrome.runtime.sendMessage({ type: 'ih-api-key' });
    if (!res?.ok || typeof res.api_key !== 'string') throw new Error(res?.error || 'Could not read the API key.');
    setCreditsApiKey(res.api_key);
  }

  async function runCredits(type) {
    const gen = ++creditsGen;
    el.credits_refresh.disabled = true;
    el.credits_refresh.classList.add('refreshing');
    el.credits_orders.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
    try {
      const res = await chrome.runtime.sendMessage({ type });
      if (gen !== creditsGen) return;
      if (!res?.ok || !Number.isInteger(res.credit_balance) || res.credit_balance < 0
        || !Array.isArray(res.orders) || typeof res.api_key !== 'string') {
        throw new Error('Failed to read credits');
      }
      el.credits_balance.textContent = formatPoints(res.credit_balance);
      el.credits_notice.textContent = creditNoticeText(res.notice, globalThis.IH_i18n.zh);
      el.credits_notice.hidden = !el.credits_notice.textContent;
      setCreditsApiKey(res.api_key);
      creditsShown = true;
      el.credits_status.hidden = true;
      creditStoredPay = readCreditPay(res.credit_pay);
      creditConfirmFailedId = res.confirm_failed_order || '';
      renderCreditOrders(res.orders);
    } catch {
      if (gen !== creditsGen) return;
      if (!creditsShown) el.credits_balance.textContent = tr('Failed to read credits');
    } finally {
      if (gen !== creditsGen) return;
      el.credits_refresh.classList.remove('refreshing');
      el.credits_refresh.disabled = false;
      el.credits_orders.querySelectorAll('button').forEach((btn) => { btn.disabled = false; });
    }
  }

  // focus 和 visibilitychange 会接连触发，进行中的刷新只打一次。
  function refreshCredits() {
    if (!refreshFlight) {
      refreshFlight = runCredits('ih-credits-refresh').finally(() => { refreshFlight = null; });
    }
    return refreshFlight;
  }

  async function confirmCreditOrder(orderId, btn) {
    const gen = ++creditsGen;
    btn.disabled = true;
    el.credits_status.hidden = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ih-credits-confirm', order_id: orderId });
      if (gen !== creditsGen) return;
      if (!res?.ok || !Number.isInteger(res.credit_balance) || res.credit_balance < 0
        || (res.payment_status !== 'paid' && res.payment_status !== 'pending')) {
        throw new Error('Could not confirm payment.');
      }
      el.credits_balance.textContent = formatPoints(res.credit_balance);
      creditsShown = true;
      if (orderId === creditConfirmFailedId) creditConfirmFailedId = '';
      const next = creditOrders.map((order) => (
        order.order_id === orderId ? { ...order, payment_status: res.payment_status } : order
      ));
      renderCreditOrders(next);
      const confirmed = next.find((order) => order.order_id === orderId);
      if (res.payment_status === 'paid' && isCustomAmountOrder(confirmed)) {
        showCreditsStatus(tr('Thank you for your support.'));
      }
    } catch {
      if (gen !== creditsGen) return;
      showCreditsStatus(tr('Could not confirm payment.'));
      btn.disabled = false;
    }
  }

  el.credits_refresh.addEventListener('click', () => { void refreshCredits(); });

  el.credits_add.addEventListener('click', () => {
    beginCreditsPurchase();
  });

  const DONATE_QR = {
    alipay: chrome.runtime.getURL('donate/alipay.png'),
    wechat: chrome.runtime.getURL('donate/wechat.png'),
  };
  const donateUsd = globalThis.IH_creditCustomUsd;

  function donateQrAlt(provider) {
    return provider === 'alipay' ? tr('Alipay QR code') : tr('WeChat Pay QR code');
  }

  function selectedDonateProvider() {
    return el.donate_pay_list.querySelector('input[name="donate_provider"]:checked')?.value || '';
  }

  function setDonatePreset(cents) {
    for (const btn of el.donate_intl_presets.querySelectorAll('button[data-cents]')) {
      btn.setAttribute('aria-pressed', Number(btn.dataset.cents) === cents ? 'true' : 'false');
    }
  }

  function donateIntlAmount() {
    const customText = el.donate_intl_custom.value.trim();
    if (customText) {
      const cents = donateUsd.moneyToCents(customText);
      if (cents == null || !donateUsd.inRange(cents)) return { ok: false };
      return { ok: true, cents };
    }
    const pressed = el.donate_intl_presets.querySelector('button[aria-pressed="true"]');
    const cents = Number(pressed?.dataset.cents);
    if (!donateUsd.inRange(cents)) return { ok: false };
    return { ok: true, cents };
  }

  function syncDonateIntlAmount() {
    const customText = el.donate_intl_custom.value.trim();
    let showRange = false;
    if (customText) {
      setDonatePreset(null);
      const cents = donateUsd.moneyToCents(customText);
      showRange = cents == null || !donateUsd.inRange(cents);
    } else if (!el.donate_intl_presets.querySelector('button[aria-pressed="true"]')) {
      setDonatePreset(donateUsd.DEFAULT_CENTS);
    }
    el.donate_intl_range.hidden = !showRange;
    el.donate_intl_go.disabled = !donateIntlAmount().ok;
  }

  function resetDonateIntl() {
    el.donate_intl_custom.value = '';
    setDonatePreset(donateUsd.DEFAULT_CENTS);
    el.donate_intl_range.hidden = true;
    el.donate_intl_error.hidden = true;
    el.donate_intl_go.disabled = false;
  }

  function clearDonateQr() {
    el.donate_qr.removeAttribute('src');
    el.donate_qr.alt = '';
    el.donate_qr_wrap.hidden = true;
  }

  function clearDonatePay() {
    for (const input of el.donate_pay_list.querySelectorAll('input[name="donate_provider"]')) {
      input.checked = false;
    }
    clearDonateQr();
  }

  function resetDonateDialog() {
    const currency = defaultPurchaseCurrency();
    layoutCurrencyButtons(el.donate_currency, currency);
    setCurrencyPressed(el.donate_currency, currency);
    clearDonatePay();
    resetDonateIntl();
    syncDonatePanel();
  }

  function syncDonatePanel() {
    const isUsd = selectedCurrency(el.donate_currency) === 'USD';
    // 标题统一「支持开发」；美元走自定义金额买额度，界面不能出现捐助字样（Waffo AUP）
    el.donate_title.textContent = tr('Support development');
    el.donate_note.hidden = false;
    el.donate_cny_wrap.hidden = isUsd;
    el.donate_intl_wrap.hidden = !isUsd;
    el.donate_intl_go.hidden = !isUsd;
    if (isUsd) {
      clearDonateQr();
      resetDonateIntl();
      return;
    }
    const provider = selectedDonateProvider();
    if (provider === 'alipay' || provider === 'wechat') {
      el.donate_qr.src = DONATE_QR[provider];
      el.donate_qr.alt = donateQrAlt(provider);
      el.donate_qr_wrap.hidden = false;
      return;
    }
    clearDonateQr();
  }

  el.donate_open.addEventListener('click', () => {
    resetDonateDialog();
    el.donate_dialog.showModal();
  });

  el.donate_currency.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-currency]');
    const currency = btn?.dataset.currency;
    if (currency !== 'CNY' && currency !== 'USD') return;
    if (btn.getAttribute('aria-pressed') === 'true') return;
    setCurrencyPressed(el.donate_currency, currency);
    clearDonatePay();
    syncDonatePanel();
  });

  el.donate_pay_list.addEventListener('change', syncDonatePanel);
  el.donate_dialog.addEventListener('close', resetDonateDialog);
  el.donate_intl_presets.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-cents]');
    if (!btn) return;
    const cents = Number(btn.dataset.cents);
    if (!donateUsd.inRange(cents)) return;
    el.donate_intl_custom.value = '';
    setDonatePreset(cents);
    syncDonateIntlAmount();
  });
  el.donate_intl_custom.addEventListener('input', syncDonateIntlAmount);
  el.donate_intl_custom.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!el.donate_intl_go.hidden && !el.donate_intl_go.disabled) el.donate_intl_go.click();
  });
  el.donate_intl_go.addEventListener('click', async () => {
    const amount = donateIntlAmount();
    if (!amount.ok) {
      el.donate_intl_range.hidden = false;
      return;
    }
    el.donate_intl_go.disabled = true;
    el.donate_intl_error.hidden = true;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ih-credits-purchase',
        provider: 'waffo',
        amount_usd: donateUsd.formatUsdCents(amount.cents),
      });
      if (!res?.ok || typeof res.pay_url !== 'string') throw new Error('Could not start payment.');
      await chrome.tabs.create({ url: res.pay_url });
      void runCredits('ih-credits-balance');
    } catch {
      el.donate_intl_error.hidden = false;
      el.donate_intl_error.textContent = tr('Could not start payment.');
    } finally {
      el.donate_intl_go.disabled = false;
    }
  });

  el.credits_pack_list.addEventListener('change', (event) => {
    const id = event.target?.value;
    const pack = purchasePacks.find((item) => item.id === id);
    if (!pack || pack === purchasePack) return;
    purchasePack = pack;
    renderPayChoices();
  });

  el.credits_currency.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    const currency = btn?.dataset.currency;
    if (!purchaseCatalog || (currency !== 'CNY' && currency !== 'USD')) return;
    if (btn.getAttribute('aria-pressed') === 'true') return;
    applyPurchaseCurrency(currency);
  });

  el.credits_purchase_go.addEventListener('click', async () => {
    el.credits_purchase_go.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ih-credits-purchase',
        provider: checkedPurchaseValue(el.credits_pay_list, 'credits_provider'),
        pack: checkedPurchaseValue(el.credits_pack_list, 'credits_pack'),
      });
      if (!res?.ok || typeof res.pay_url !== 'string') throw new Error('Could not start payment.');
      await chrome.tabs.create({ url: res.pay_url });
      void runCredits('ih-credits-balance');
    } catch {
      showCreditsStatus(tr('Could not start payment.'));
    } finally {
      // 出错时也关掉弹窗，否则提示被弹窗挡住
      el.credits_purchase_dialog.close();
      el.credits_purchase_go.disabled = false;
    }
  });

  let copyTimer = 0;

  function setCopyBtnCopied(copied) {
    el.credits_copy.classList.toggle('is-copied', copied);
    el.credits_copy.setAttribute('aria-label', copied ? tr('Copied') : tr('Copy API key'));
  }

  el.credits_replace_key.addEventListener('click', () => {
    el.credits_replace_warn_dialog.showModal();
  });

  el.credits_replace_history.addEventListener('click', (event) => {
    event.preventDefault();
    const prev = el.credits_replace_history.dataset.key;
    if (!prev) return;
    el.credits_replace_input.value = prev;
    el.credits_replace_input.focus();
  });

  el.credits_replace_warn_go.addEventListener('click', () => {
    el.credits_replace_warn_dialog.close();
    el.credits_replace_input.value = '';
    el.credits_replace_error.hidden = true;
    el.credits_replace_history_wrap.hidden = true;
    delete el.credits_replace_history.dataset.key;
    el.credits_replace_history.textContent = '';
    chrome.storage.local.get('ih_api_key_prev', (res) => {
      const prev = res?.ih_api_key_prev;
      if (typeof prev !== 'string' || !prev || prev === creditsApiKey) return;
      el.credits_replace_history.dataset.key = prev;
      el.credits_replace_history.textContent = `${prev.slice(0, 7)}…${prev.slice(-4)}`;
      el.credits_replace_history_wrap.hidden = false;
    });
    el.credits_replace_input_dialog.showModal();
    el.credits_replace_input.focus();
  });

  el.credits_replace_form.addEventListener('submit', (event) => {
    if (event.submitter?.value !== 'save') return;
    event.preventDefault();
    void (async () => {
      el.credits_replace_error.hidden = true;
      el.credits_replace_submit.disabled = true;
      try {
        const api_key = el.credits_replace_input.value.trim();
        // 同一把 key 不走覆盖，免得清掉本机记着的待付订单
        if (api_key === creditsApiKey) return el.credits_replace_input_dialog.close();
        const check = await chrome.runtime.sendMessage({ type: 'ih-credits-check-key', api_key });
        if (!check?.ok) {
          // 格式不对是 key 无效，其余是没查到
          el.credits_replace_error.hidden = false;
          el.credits_replace_error.textContent = check?.error === 'Invalid API key.' ? tr('Invalid API key.') : tr('Failed to read credits');
          return;
        }
        if (check.credit_balance === 0 && !check.orders.length
          && !confirm(tr('This API key has no credits or orders. Use it anyway?'))) return;
        const res = await chrome.runtime.sendMessage({ type: 'ih-api-key-replace', api_key });
        if (!res?.ok) throw new Error(typeof res?.error === 'string' ? res.error : 'Invalid API key.');
        el.credits_replace_input_dialog.close();
        setCreditsApiKey(api_key);
        // 不复用进行中的刷新：它可能读的还是旧 key 的额度
        void runCredits('ih-credits-refresh');
      } catch {
        el.credits_replace_error.hidden = false;
        el.credits_replace_error.textContent = tr('Invalid API key.');
      } finally {
        el.credits_replace_submit.disabled = false;
      }
    })();
  });

  el.credits_copy.addEventListener('click', async () => {
    try {
      if (!creditsApiKey) await loadCreditsApiKey();
      await navigator.clipboard.writeText(creditsApiKey);
      setCopyBtnCopied(true);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => setCopyBtnCopied(false), 1200);
    } catch {
      setCopyBtnCopied(false);
      showCreditsStatus(tr('Could not copy the API key.'));
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshCredits();
  });
  window.addEventListener('focus', () => {
    if (document.visibilityState === 'visible') void refreshCredits();
  });

  void Promise.all([
    loadToggles(),
    loadSliders(),
    loadBackend(),
    loadAutoSites(),
    refresh().catch(showCacheError),
  ]).finally(() => resolvePageReady());
  // 额度要联网，不能挡住本页预览高亮
  loadCreditsApiKey().catch(console.error);
  void refreshCredits();

  const EDGE_API_BASE = IL_normalizeCloudApiBase(globalThis.IH_CONFIG?.apiBase || '')
    || IL_DEFAULT_API_BASE;
  const LATENCY_MS = 8000;

  function setCloudApiBaseError(msg) {
    if (!msg) {
      el.ih_cloud_api_base_error.hidden = true;
      el.ih_cloud_api_base_error.textContent = '';
      return;
    }
    el.ih_cloud_api_base_error.hidden = false;
    el.ih_cloud_api_base_error.textContent = msg;
  }

  function syncCloudApiBaseWrapVisible() {
    el.ih_cloud_api_base_wrap.hidden = !el.ih_cloud_api_base_enabled.checked;
  }

  function applyCloudApiBaseFromUi() {
    const enabled = el.ih_cloud_api_base_enabled.checked;
    const raw = el.ih_cloud_api_base.value.trim();
    IL_applyCloudApiBaseOverride(raw, enabled);
    measureCloudLatency();
  }

  function loadCloudApiBaseField() {
    return new Promise((resolve) => {
      chrome.storage.local.get([IL_CLOUD_API_BASE_KEY, IL_CLOUD_API_BASE_ENABLED_KEY], (res) => {
        const raw = res?.[IL_CLOUD_API_BASE_KEY];
        el.ih_cloud_api_base.value = typeof raw === 'string' ? raw : '';
        el.ih_cloud_api_base_enabled.checked = res?.[IL_CLOUD_API_BASE_ENABLED_KEY] === true;
        syncCloudApiBaseWrapVisible();
        setCloudApiBaseError('');
        applyCloudApiBaseFromUi();
        resolve();
      });
    });
  }

  function persistCloudApiBaseEnabled() {
    const enabled = el.ih_cloud_api_base_enabled.checked;
    syncCloudApiBaseWrapVisible();
    setCloudApiBaseError('');
    chrome.storage.local.set({ [IL_CLOUD_API_BASE_ENABLED_KEY]: enabled }, () => {
      if (!enabled) {
        applyCloudApiBaseFromUi();
        return;
      }
      if (!el.ih_cloud_api_base.value.trim()) {
        applyCloudApiBaseFromUi();
        el.ih_cloud_api_base.focus();
        return;
      }
      persistCloudApiBaseFromField().catch(console.error);
    });
  }

  async function persistCloudApiBaseFromField() {
    if (!el.ih_cloud_api_base_enabled.checked) return;
    const raw = el.ih_cloud_api_base.value.trim();
    setCloudApiBaseError('');
    const normalized = IL_normalizeCloudApiBase(raw);
    if (!normalized) {
      setCloudApiBaseError(tr('Enter a valid http(s) URL, e.g. http://127.0.0.1:5001'));
      return;
    }
    const granted = await chrome.permissions
      .request({ origins: [`${normalized}/*`] })
      .catch(() => false);
    if (!granted) {
      setCloudApiBaseError(tr('Allow access to this service URL to use a custom API.'));
      return;
    }
    chrome.storage.local.set({ [IL_CLOUD_API_BASE_KEY]: raw, [IL_CLOUD_API_BASE_ENABLED_KEY]: true }, () => {
      applyCloudApiBaseFromUi();
    });
  }

  el.ih_cloud_api_base_enabled.addEventListener('change', persistCloudApiBaseEnabled);
  el.ih_cloud_api_base.addEventListener('change', () => {
    persistCloudApiBaseFromField().catch(console.error);
  });
  el.ih_cloud_api_base.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      persistCloudApiBaseFromField()
        .catch(console.error)
        .finally(() => el.ih_cloud_api_base.blur());
    }
  });
  void loadCloudApiBaseField();

  function latencyText(name, ms) {
    if (ms === 'measuring') return tr('{label}…', { label: name });
    if (ms == null) return tr('{label} failed', { label: name });
    return tr('{label} {ms} ms', { label: name, ms });
  }

  async function timeLatency(apiBase, path, needReached) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LATENCY_MS);
    const t0 = performance.now();
    try {
      const res = await fetch(`${apiBase}${path}`, { cache: 'no-store', signal: ctrl.signal });
      const ms = Math.round(performance.now() - t0);
      if (needReached) {
        return res.headers.get('X-Infolens-Reached') === '1' ? ms : null;
      }
      if (!res.ok) return null;
      return ms;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  let latencyGen = 0;
  function measureCloudLatency() {
    const gen = ++latencyGen;
    el.latency_retry.disabled = true;
    el.latency_edge.textContent = latencyText(tr('Edge server'), 'measuring');
    el.latency_backend.textContent = latencyText(tr('Compute server'), 'measuring');
    const storedRaw = el.ih_cloud_api_base.value.trim();
    const enabled = el.ih_cloud_api_base_enabled.checked;
    const backendTarget = IL_analyzeLatencyTarget(storedRaw, enabled);
    const backendProbe = backendTarget.skip
      ? Promise.resolve(null)
      : timeLatency(backendTarget.base, backendTarget.path, backendTarget.needReached);
    let pending = 2;
    function finishProbe() {
      if (gen !== latencyGen) return;
      pending -= 1;
      if (pending === 0) el.latency_retry.disabled = false;
    }
    void timeLatency(EDGE_API_BASE, '/facade-health', false).then((edge) => {
      if (gen !== latencyGen) return;
      el.latency_edge.textContent = latencyText(tr('Edge server'), edge);
      finishProbe();
    });
    void backendProbe.then((backend) => {
      if (gen !== latencyGen) return;
      el.latency_backend.textContent = latencyText(tr('Compute server'), backend);
      finishProbe();
    });
  }

  el.latency_retry.addEventListener('click', measureCloudLatency);

  if (!globalThis.IL_optionsNav) {
    throw new Error('IL_optionsNav missing — inject options-nav.js before options.js');
  }
  globalThis.IL_optionsNav.init();
})();
