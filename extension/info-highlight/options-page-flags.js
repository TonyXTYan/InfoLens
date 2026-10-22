/**
 * 选项页跑网页管线：整页抽字、无悬停说明。须在 page-map / content 之前。
 * #cache_desc 的条数和体积会随本次分析变，抽进去则同一页对不上缓存。
 * 星级不是正文。
 */
globalThis.IH_OPTIONS_PAGE = true;
if (typeof globalThis.IL_TEXT_MAP_EXTRA_EXCLUDE !== 'string') {
  throw new Error('IL_TEXT_MAP_EXTRA_EXCLUDE missing — inject textMapConfig.js first');
}
globalThis.IL_TEXT_MAP_EXTRA_EXCLUDE += ', #cache_desc, .model-compare .stars';
globalThis.IH_tokenTip ||= {
  bind() {},
  add() {},
  clear() {},
  setModel() {},
};
