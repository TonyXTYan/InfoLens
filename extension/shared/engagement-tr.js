/** 内容页满意度条文案（与选项页 About 共用 zh 表）。 */
(function () {
  if (globalThis.IL_engagementTr) return;
  if (!globalThis.IL_optionsI18n) {
    throw new Error('IL_optionsI18n missing — inject options-i18n.js before engagement-tr.js');
  }
  const about = globalThis.IL_optionsAbout_zh;
  if (!about) throw new Error('IL_optionsAbout_zh missing — inject options-about-zh.js');
  const extra = globalThis.IL_engagement_zh;
  const zhTable = extra ? Object.assign({}, about, extra) : about;
  const cfg = globalThis.IL_CONFIG || globalThis.IH_CONFIG || {};
  globalThis.IL_engagementTr = globalThis.IL_optionsI18n.create(zhTable, cfg).tr;
})();
