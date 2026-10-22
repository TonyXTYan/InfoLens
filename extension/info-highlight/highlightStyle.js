/**
 * 高亮色阶、两档密度、绘制形式。
 * RGB 与站点 SurprisalColorConfig 同步；100% 强度的 alpha 见 PAINT_CAP。
 * storage 默认值在 optionDefaults.js。
 */
globalThis.IH_highlightStyle ||= (function () {
  const TOKEN_LEVELS = 16;
  /** SYNC: client/src/shared/cross/surprisalMath.ts → REFERENCE_MAX_SURPRISAL_BITS */
  const MAX_SURPRISAL_BITS = 18;
  /** SYNC: SurprisalColorConfig → SURPRISAL_RED_RGB；色相滑条的 S/L 锁在这颗红上 */
  const SURPRISAL_RED_RGB = '255, 71, 64';

  const KEY_TWO_TIER = 'ih_two_tier';
  const KEY_THRESHOLD_PCT = 'ih_highlight_threshold_pct';
  /** 用户侧强度 5–150%；100% = PAINT_CAP[该表面实际形式]，再高按比例加深，α 上限 1 */
  const KEY_MAX_ALPHA_DEPTH = 'ih_max_highlight_alpha';
  /** 淡去下限 0–50%：最不重要的字保留的不透明度；只有 0 才全透明 */
  const KEY_FADE_MIN_PCT = 'ih_fade_min_pct';
  const FADE_MIN_DEFAULT = 30;
  const FADE_MIN_MAX = 50;
  /** 勾选后，本段文字里惊讶度最高的这一比例落到最强档 */
  const KEY_FADE_NORM = 'ih_fade_norm';
  /** 落到最强档的文字比例，1–50%，默认 10% */
  const KEY_FADE_NORM_PCT = 'ih_fade_norm_pct';
  const FADE_NORM_PCT_MIN = 1;
  const FADE_NORM_PCT_MAX = 50;
  const FADE_NORM_PCT_DEFAULT = 10;
  const KEY_PAINT_STYLE = 'ih_paint_style';
  const KEY_HIGHLIGHT_COLOR = 'ih_highlight_color';
  const KEY_TEXT_COLOR = 'ih_text_color';

  const PAINT_BLOCK = 'block';
  const PAINT_UNDERLINE = 'underline';
  const PAINT_TEXT = 'text';
  const PAINT_FADE = 'fade';
  const PAINT_STYLES = Object.freeze([PAINT_FADE, PAINT_TEXT, PAINT_UNDERLINE, PAINT_BLOCK]);
  /** 表面画不了所选形式时回退。PDF 色块会盖住 canvas 字形；字色、淡去都改不了 canvas。 */
  const PAINT_FALLBACK = Object.freeze({
    pdf: Object.freeze({
      [PAINT_BLOCK]: PAINT_UNDERLINE,
      [PAINT_TEXT]: PAINT_UNDERLINE,
      [PAINT_FADE]: PAINT_UNDERLINE,
    }),
  });

  const INTENSITY_MIN = 5;
  const INTENSITY_MAX = 150;
  /** 各形式 100% 强度对应的 alpha。色块 SYNC: surprisalColorWeakenManager → WEAKENED_SURPRISAL_MAX_ALPHA */
  const PAINT_CAP = Object.freeze({
    [PAINT_BLOCK]: 0.5,
    [PAINT_UNDERLINE]: 1,
    [PAINT_TEXT]: 1,
    [PAINT_FADE]: 1,
  });
  /** 下划线相对 used font-size（16px 时网页 = 2px 粗 / 3px 距） */
  const UNDERLINE_THICKNESS = 0.125;
  const UNDERLINE_OFFSET = 0.1875;
  /** PDF overlay：rect.bottom 低于基线，相对盒底再上移（16px 时 1px） */
  const UNDERLINE_OVERLAY_LIFT = 0.0625;

  function clampInt(n, lo, hi) {
    const x = Math.round(Number(n));
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
  }

  function clampThresholdPct(n) {
    return clampInt(n, 0, 100);
  }

  function clampMaxAlphaDepth(n) {
    return clampInt(n, INTENSITY_MIN, INTENSITY_MAX);
  }

  function clampFadeMinPct(n) {
    return clampInt(n, 0, FADE_MIN_MAX);
  }

  function clampFadeNormPct(n) {
    return clampInt(n, FADE_NORM_PCT_MIN, FADE_NORM_PCT_MAX);
  }

  function capAlpha(paintStyle) {
    return PAINT_CAP[normalizePaintStyle(paintStyle)];
  }

  function depthToMaxAlpha(depth, paintStyle, surface) {
    return Math.min(
      1,
      (clampMaxAlphaDepth(depth) / 100) * capAlpha(resolvePaintStyle(paintStyle, surface)),
    );
  }

  /** @param {() => void} onChange */
  function watchColorScheme(onChange) {
    const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq || typeof mq.addEventListener !== 'function') return;
    mq.addEventListener('change', onChange);
  }

  function thresholdBits(pct) {
    return (clampThresholdPct(pct) / 100) * MAX_SURPRISAL_BITS;
  }

  function formatThresholdLabel(pct) {
    const p = clampThresholdPct(pct);
    const bits = thresholdBits(p);
    const bitStr = Number.isInteger(bits) ? String(bits) : (Math.round(bits * 10) / 10).toFixed(1);
    return `${p}% (${bitStr} bit)`;
  }

  function formatDepthLabel(depth) {
    return `${clampMaxAlphaDepth(depth)}%`;
  }

  function formatFadeLabel(pct) {
    return `${clampFadeMinPct(pct)}%`;
  }

  function formatFadeNormLabel(pct) {
    return globalThis.IH_i18n.tr('{pct}% at full highlight', { pct: clampFadeNormPct(pct) });
  }

  function normalizePaintStyle(v) {
    return PAINT_STYLES.includes(v) ? v : PAINT_FADE;
  }

  function parseRgbParts(rgb) {
    const p = String(rgb).split(',').map((s) => Number(s.trim()));
    if (p.length < 3 || p.some((n) => !Number.isFinite(n))) {
      throw new Error(`bad rgb: ${rgb}`);
    }
    return p;
  }

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h * 360, s, l };
  }

  function hslToRgb(h, s, l) {
    const hue = ((Number(h) % 360) + 360) % 360;
    const f = (n) => {
      const k = (n + hue / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [
      Math.round(f(0) * 255),
      Math.round(f(8) * 255),
      Math.round(f(4) * 255),
    ];
  }

  const RED_HSL = rgbToHsl(...parseRgbParts(SURPRISAL_RED_RGB));
  /** 与默认红同一档：够见、不发白。色相滑条只动 H。 */
  const HIGHLIGHT_S = RED_HSL.s;
  const HIGHLIGHT_L = RED_HSL.l;
  const HUE_RED = Math.round(RED_HSL.h);
  const HUE_MIN = 0;
  const HUE_MAX = 359;

  /** 色相轴上的典型色（约 30° 一档）；琥珀/金并进橙与黄，玫红并进红。 */
  const COLOR_HUE = Object.freeze({
    red: 0,
    orange: 30,
    yellow: 60,
    lime: 90,
    green: 120,
    teal: 150,
    cyan: 180,
    azure: 210,
    blue: 240,
    purple: 270,
    magenta: 300,
    pink: 330,
  });
  const COLOR_IDS = Object.freeze(Object.keys(COLOR_HUE));
  /** 无色相：中性灰，靠 alpha 在深浅底上显形；不进色相滑条。 */
  const COLOR_INK = 'ink';
  const RGB_INK = '128, 128, 128';
  const LEGACY_COLOR_HUE = Object.freeze({
    ...COLOR_HUE,
    amber: 30,
    gold: 60,
    rose: 0,
  });

  function hueForColorId(id) {
    return Object.hasOwn(COLOR_HUE, id) ? COLOR_HUE[id] : HUE_RED;
  }

  function wrapHue(n) {
    const x = Math.round(Number(n));
    if (!Number.isFinite(x)) return HUE_RED;
    return ((x % 360) + 360) % 360;
  }

  function isInk(v) {
    return v === COLOR_INK;
  }

  function normalizeHighlightHue(v) {
    if (typeof v === 'string' && Object.hasOwn(LEGACY_COLOR_HUE, v)) return LEGACY_COLOR_HUE[v];
    return wrapHue(v);
  }

  function normalizeHighlightColor(v) {
    return isInk(v) ? COLOR_INK : normalizeHighlightHue(v);
  }

  function rgbForHue(v) {
    const [r, g, b] = hslToRgb(normalizeHighlightHue(v), HIGHLIGHT_S, HIGHLIGHT_L);
    return `${r}, ${g}, ${b}`;
  }

  function rgbForColor(v) {
    if (isInk(v)) return RGB_INK;
    return rgbForHue(v);
  }

  /**
   * 字色终点：红绿蓝。红、蓝钉在相对亮度 ≈ 0.18（对白/对黑约 4.5）；
   * 绿在同一明度会发闷，单独抬到 ≈ 0.38，白底对比会弱一些。
   * 彩度取该明度、该色相在 sRGB 内的上沿。
   */
  const TEXT_COLOR = Object.freeze({
    red: '234, 0, 33',
    green: '0, 191, 67',
    blue: '0, 114, 233',
  });
  const TEXT_COLOR_IDS = Object.freeze(Object.keys(TEXT_COLOR));

  function normalizeTextColor(v) {
    return Object.hasOwn(TEXT_COLOR, v) ? v : 'red';
  }

  function rgbForTextColor(id) {
    return TEXT_COLOR[normalizeTextColor(id)];
  }

  function hueTrackCss() {
    const parts = [];
    for (let i = 0; i <= 12; i++) {
      parts.push(`rgb(${rgbForHue(i * 30)}) ${(i / 12) * 100}%`);
    }
    return `linear-gradient(to right, ${parts.join(', ')})`;
  }

  /**
   * @param {string} requested
   * @param {string} surface `'web'` | `'pdf'`
   */
  function resolvePaintStyle(requested, surface) {
    const style = normalizePaintStyle(requested);
    return PAINT_FALLBACK[surface]?.[style] ?? style;
  }

  /**
   * @param {number} level 0..TOKEN_LEVELS-1
   * @param {number} maxAlpha
   * @param {boolean} twoTier
   */
  function alphaForLevel(level, maxAlpha, twoTier) {
    if (twoTier) return level === TOKEN_LEVELS - 1 ? maxAlpha : 0;
    return (level / TOKEN_LEVELS) * maxAlpha;
  }

  /**
   * @param {number} bits
   * @param {{ twoTier: boolean, thresholdPct: number }} prefs
   * @returns {number} level，或 -1 表示不画
   */
  function tokenLevelFromBits(bits, prefs) {
    if (!Number.isFinite(bits)) return -1;
    if (prefs.twoTier) {
      return bits >= thresholdBits(prefs.thresholdPct) ? TOKEN_LEVELS - 1 : -1;
    }
    const t = Math.max(0, Math.min(1, bits / MAX_SURPRISAL_BITS));
    const level = Math.min(TOKEN_LEVELS - 1, Math.floor(t * TOKEN_LEVELS));
    return level < 1 ? -1 : level;
  }

  /**
   * 淡去档位：不过滤低分，0..TOKEN_LEVELS-1 全画；只有 bits 非法才 -1。
   * scaleBits 有值时，把它当成最强档的下沿（含），其下线性铺到其余档。
   * @param {number} bits
   * @param {number | null} [scaleBits]
   * @returns {number} level，或 -1 表示不画
   */
  function tokenLevelForFade(bits, scaleBits) {
    if (!Number.isFinite(bits)) return -1;
    if (scaleBits == null || !Number.isFinite(scaleBits)) {
      const t = Math.max(0, Math.min(1, bits / MAX_SURPRISAL_BITS));
      return Math.min(TOKEN_LEVELS - 1, Math.floor(t * TOKEN_LEVELS));
    }
    if (!(scaleBits > 0) || bits >= scaleBits) return TOKEN_LEVELS - 1;
    const t = Math.max(0, bits / scaleBits);
    return Math.min(TOKEN_LEVELS - 2, Math.floor(t * (TOKEN_LEVELS - 1)));
  }

  /**
   * 按文字权重从高到低累加，跨过前 topPct% 的那一档 bits。
   * 并列时最强档会略多于这一比例。没有正权重则 null。
   * @param {Array<{ bits: number, weight: number }>} samples
   * @param {number} [topPct] 1–50，缺省为 FADE_NORM_PCT_DEFAULT
   * @returns {number | null}
   */
  function fadeNormScaleBits(samples, topPct) {
    const rows = [];
    let total = 0;
    for (const s of samples) {
      const bits = Number(s?.bits);
      const weight = Number(s?.weight);
      if (!Number.isFinite(bits) || !(weight > 0)) continue;
      rows.push({ bits, weight });
      total += weight;
    }
    if (!(total > 0)) return null;
    rows.sort((a, b) => b.bits - a.bits);
    const need = total * (clampFadeNormPct(topPct ?? FADE_NORM_PCT_DEFAULT) / 100);
    let acc = 0;
    for (const row of rows) {
      acc += row.weight;
      if (acc >= need) return row.bits;
    }
    return rows[rows.length - 1].bits;
  }

  /**
   * 淡去不透明度：最重要的字始终 1，最不重要的字停在下限 m；只有 m=0 才全透明。
   * @param {number} level 0..TOKEN_LEVELS-1
   * @param {number} fadeMinPct 0..100
   * @returns {number} 0..1
   */
  function fadeOpacityForLevel(level, fadeMinPct) {
    const m = clampFadeMinPct(fadeMinPct) / 100;
    const t = Math.max(0, Math.min(1, Number(level) / (TOKEN_LEVELS - 1)));
    if (!Number.isFinite(t)) return m;
    return m + (1 - m) * t;
  }

  /** @param {Record<string, unknown>} raw storage get 结果；缺键走 optionDefaults.js */
  function normalizePrefs(raw) {
    const pick = globalThis.IH_optionStored;
    if (typeof pick !== 'function') {
      throw new Error('IH_optionStored missing — inject optionDefaults.js');
    }
    return {
      twoTier: !!pick(KEY_TWO_TIER, raw?.[KEY_TWO_TIER]),
      thresholdPct: clampThresholdPct(pick(KEY_THRESHOLD_PCT, raw?.[KEY_THRESHOLD_PCT])),
      maxAlphaDepth: clampMaxAlphaDepth(pick(KEY_MAX_ALPHA_DEPTH, raw?.[KEY_MAX_ALPHA_DEPTH])),
      fadeMinPct: clampFadeMinPct(pick(KEY_FADE_MIN_PCT, raw?.[KEY_FADE_MIN_PCT])),
      fadeNorm: !!pick(KEY_FADE_NORM, raw?.[KEY_FADE_NORM]),
      fadeNormPct: clampFadeNormPct(pick(KEY_FADE_NORM_PCT, raw?.[KEY_FADE_NORM_PCT])),
      paintStyle: normalizePaintStyle(pick(KEY_PAINT_STYLE, raw?.[KEY_PAINT_STYLE])),
      highlightColor: normalizeHighlightColor(pick(KEY_HIGHLIGHT_COLOR, raw?.[KEY_HIGHLIGHT_COLOR])),
      textColor: normalizeTextColor(pick(KEY_TEXT_COLOR, raw?.[KEY_TEXT_COLOR])),
    };
  }

  /**
   * 收藏快照用：把当前高亮偏好编成 <mark class="ih-token-N"> 的 CSS。
   * 淡去/字色混 currentColor，随原页深浅色变；色块/下划线用用户选的色，不写死当时算出来的 RGB。
   * @param {{ twoTier: boolean, maxAlphaDepth: number, fadeMinPct?: number, paintStyle: string, highlightColor?: number | string, textColor?: string }} prefs
   */
  function libraryMarkCss(prefs) {
    const paintStyle = normalizePaintStyle(prefs.paintStyle);
    const fade = paintStyle === PAINT_FADE;
    const text = paintStyle === PAINT_TEXT;
    const underline = paintStyle === PAINT_UNDERLINE;
    const rgb = text ? rgbForTextColor(prefs.textColor) : rgbForColor(prefs.highlightColor);
    const maxAlpha = depthToMaxAlpha(prefs.maxAlphaDepth, paintStyle);
    const thick = `${UNDERLINE_THICKNESS * 100}%`;
    const off = `${UNDERLINE_OFFSET * 100}%`;
    const rules = ['mark[class^="ih-token-"]{background:transparent;color:inherit}'];
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      const sel = `mark.ih-token-${i}`;
      if (fade) {
        const pct = (fadeOpacityForLevel(i, prefs.fadeMinPct) * 100).toFixed(2);
        rules.push(`${sel}{color:color-mix(in srgb,currentColor ${pct}%,transparent)}`);
        continue;
      }
      const a = alphaForLevel(i, maxAlpha, !!prefs.twoTier);
      if (!(a > 0)) continue;
      if (text) {
        rules.push(`${sel}{color:color-mix(in srgb-linear,rgb(${rgb}) ${(a * 100).toFixed(2)}%,currentColor)}`);
      } else if (underline) {
        rules.push(
          `${sel}{text-decoration-line:underline;text-decoration-style:solid;text-decoration-color:rgba(${rgb},${a.toFixed(4)});text-decoration-thickness:${thick};text-underline-offset:${off};text-decoration-skip-ink:none}`,
        );
      } else {
        rules.push(`${sel}{background:rgba(${rgb},${a.toFixed(4)})}`);
      }
    }
    return rules.join('');
  }

  /**
   * 写入色阶变量（block/下划线/选项页预览用）。
   * 淡去/字色的 mix 比例不在此写 --ih-fade-pct-* / --ih-token-pct-*：改由 page-map insertRule 写死，避免超大页插表慢；
   * 且该写法在 Dark Reader 下须配合 textFgSheet 的 class darkreader，见 page-map.js。
   * @param {HTMLElement} [root]
   * @param {{ twoTier: boolean, maxAlphaDepth: number, fadeMinPct?: number, paintStyle: string, highlightColor?: number | string, textColor?: string }} prefs
   */
  function applyCssVars(root, prefs) {
    const el = root || document.documentElement;
    const paintStyle = normalizePaintStyle(prefs.paintStyle);
    const text = paintStyle === PAINT_TEXT;
    const fade = paintStyle === PAINT_FADE;
    const rgb = text ? rgbForTextColor(prefs.textColor) : rgbForColor(prefs.highlightColor);
    const underline = paintStyle === PAINT_UNDERLINE;
    const maxAlpha = depthToMaxAlpha(prefs.maxAlphaDepth, paintStyle);
    el.style.setProperty('--ih-highlight-rgb', rgb);
    el.style.setProperty('--ih-paint-deco', underline ? 'underline' : 'none');
    el.style.setProperty('--ih-underline-thickness', `${UNDERLINE_THICKNESS * 100}%`);
    el.style.setProperty('--ih-underline-offset', `${UNDERLINE_OFFSET * 100}%`);
    for (let i = 0; i < TOKEN_LEVELS; i++) {
      const a = alphaForLevel(i, maxAlpha, !!prefs.twoTier);
      const color = `rgba(${rgb}, ${a})`;
      el.style.setProperty(`--ih-token-${i}`, color);
      el.style.setProperty(`--ih-token-bg-${i}`, underline || text || fade ? 'transparent' : color);
    }
  }

  /**
   * PDF overlay：text layer 的 client rect 贴字形底；线贴盒底内侧再上移 UNDERLINE_OVERLAY_LIFT。
   * 粗细 = 字盒高 × UNDERLINE_THICKNESS。
   * @param {{ left: number, bottom: number, width: number, height: number }} rect
   * @param {{ left: number, top: number }} hostRect
   */
  function underlineOverlayBox(rect, hostRect) {
    const thickness = rect.height * UNDERLINE_THICKNESS;
    const lift = rect.height * UNDERLINE_OVERLAY_LIFT;
    return {
      x: rect.left - hostRect.left,
      y: rect.bottom - hostRect.top - thickness - lift,
      width: rect.width,
      height: thickness,
    };
  }

  return {
    TOKEN_LEVELS,
    MAX_SURPRISAL_BITS,
    SURPRISAL_RED_RGB,
    HIGHLIGHT_S,
    HIGHLIGHT_L,
    HUE_RED,
    HUE_MIN,
    HUE_MAX,
    COLOR_IDS,
    COLOR_INK,
    TEXT_COLOR_IDS,
    KEY_TWO_TIER,
    KEY_THRESHOLD_PCT,
    KEY_MAX_ALPHA_DEPTH,
    KEY_FADE_MIN_PCT,
    FADE_MIN_DEFAULT,
    FADE_MIN_MAX,
    KEY_FADE_NORM,
    KEY_FADE_NORM_PCT,
    FADE_NORM_PCT_MIN,
    FADE_NORM_PCT_MAX,
    FADE_NORM_PCT_DEFAULT,
    KEY_PAINT_STYLE,
    KEY_HIGHLIGHT_COLOR,
    KEY_TEXT_COLOR,
    PAINT_BLOCK,
    PAINT_UNDERLINE,
    PAINT_TEXT,
    PAINT_FADE,
    PAINT_STYLES,
    INTENSITY_MIN,
    INTENSITY_MAX,
    PAINT_CAP,
    UNDERLINE_THICKNESS,
    UNDERLINE_OFFSET,
    UNDERLINE_OVERLAY_LIFT,
    clampThresholdPct,
    clampMaxAlphaDepth,
    clampFadeMinPct,
    clampFadeNormPct,
    capAlpha,
    depthToMaxAlpha,
    watchColorScheme,
    thresholdBits,
    formatThresholdLabel,
    formatDepthLabel,
    formatFadeLabel,
    formatFadeNormLabel,
    normalizePaintStyle,
    normalizeHighlightHue,
    normalizeHighlightColor,
    isInk,
    hueForColorId,
    rgbForHue,
    rgbForColor,
    normalizeTextColor,
    rgbForTextColor,
    hueTrackCss,
    resolvePaintStyle,
    alphaForLevel,
    tokenLevelFromBits,
    tokenLevelForFade,
    fadeNormScaleBits,
    fadeOpacityForLevel,
    normalizePrefs,
    libraryMarkCss,
    applyCssVars,
    underlineOverlayBox,
  };
})();
