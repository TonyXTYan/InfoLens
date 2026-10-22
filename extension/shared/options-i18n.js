/**
 * 选项页 i18n：英文原文为 key，中文表查不到则用英文。
 * data-i18n / data-i18n-html / data-i18n-attr 与 Info Highlight 选项页一致。
 */
globalThis.IL_optionsI18n = {
  create(zhTable, config = {}) {
    if (!zhTable) throw new Error('options i18n: zh table missing');
    const forced = config.lang || '';
    if (forced !== '' && forced !== 'en' && forced !== 'zh') {
      throw new Error('config.lang must be "en" or "zh"');
    }
    const ui = (forced || globalThis.chrome?.i18n?.getUILanguage?.() || '').toLowerCase().replaceAll('_', '-');
    const zh = /^zh/.test(ui);

    /** @param {string} en @param {Record<string, string | number>} [vars] */
    function tr(en, vars) {
      const s = zh ? (zhTable[en] ?? en) : en;
      if (!vars) return s;
      return s.replace(/\{(\w+)\}/g, (_, k) => {
        if (!(k in vars)) throw new Error(`i18n: missing {${k}} for "${en}"`);
        return String(vars[k]);
      });
    }

    function apply(root) {
      root.documentElement.lang = 'zh-CN';
      root.querySelectorAll('[data-i18n]').forEach((el) => {
        el.textContent = tr(el.textContent.trim());
      });
      root.querySelectorAll('[data-i18n-html]').forEach((el) => {
        el.innerHTML = tr(el.innerHTML.trim());
      });
      root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
        for (const name of el.getAttribute('data-i18n-attr').split(',')) {
          el.setAttribute(name, tr(el.getAttribute(name)));
        }
      });
    }

    return { zh, tr, apply };
  },
};

(function bootSemanticOptionsI18n() {
  const root = globalThis.document?.documentElement;
  if (!root || root.dataset.optionsI18n !== '1') return;
  const zhTable = globalThis.IL_options_zh;
  if (!zhTable) throw new Error('IL_options_zh missing — inject zh.js before options-i18n.js');
  const i18n = globalThis.IL_optionsI18n.create(zhTable, globalThis.IL_CONFIG || {});
  globalThis.IL_optionsTr = i18n.tr;
  if (i18n.zh) i18n.apply(document);
})();
