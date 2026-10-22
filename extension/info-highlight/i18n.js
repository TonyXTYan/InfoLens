/**
 * 界面文案以英文原文为 key：中文界面查 zh.js，查不到用英文。
 * 带 data-ih-i18n 的扩展页面，按元素里原有英文替换 data-i18n / data-i18n-html / data-i18n-attr；
 * 普通网页不带这个标记，注入时不会改到别人的 data-i18n。
 */
globalThis.IH_i18n ||= (function () {
  if (!globalThis.IL_optionsI18n) {
    throw new Error('IL_optionsI18n missing — inject options-i18n.js before i18n.js');
  }
  if (!globalThis.IH_zh) throw new Error('IH_zh missing — inject zh.js before i18n.js');
  const i18n = globalThis.IL_optionsI18n.create(globalThis.IH_zh, globalThis.IH_CONFIG || {});
  if (i18n.zh && globalThis.document?.documentElement?.dataset.ihI18n === '1') {
    i18n.apply(document);
  }
  return i18n;
})();
