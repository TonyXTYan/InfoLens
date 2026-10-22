/**
 * 捐助弹窗海外项的美元预设与金额范围。点数由门面写死，这里不算。
 * 金额精度：美分（最多两位小数）。
 */
globalThis.IH_creditCustomUsd = (function () {
  const CUSTOM_USD_MIN_CENTS = 200;
  const CUSTOM_USD_MAX_CENTS = 20000;
  const PRESET_CENTS = [300, 500, 1000];
  const DEFAULT_CENTS = 500;

  function moneyToCents(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
    const [yuan, frac = ''] = text.split('.');
    const cents = Number(yuan) * 100 + Number(frac.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents <= 0) return null;
    return cents;
  }

  function formatUsdCents(cents) {
    if (!Number.isInteger(cents) || cents < 0) return null;
    return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  }

  function inRange(cents) {
    return Number.isInteger(cents) && cents >= CUSTOM_USD_MIN_CENTS && cents <= CUSTOM_USD_MAX_CENTS;
  }

  return {
    CUSTOM_USD_MIN_CENTS,
    CUSTOM_USD_MAX_CENTS,
    PRESET_CENTS,
    DEFAULT_CENTS,
    moneyToCents,
    formatUsdCents,
    inRange,
  };
})();
