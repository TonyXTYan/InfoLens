/**
 * 浏览器不让注入的页面。这是关于 Chrome / Safari 的事实，不是某个插件的策略——新版禁哪些，两边一起改。
 */
/** Safari 扩展完全碰不到 file:（没有「允许访问文件网址」开关），当受限页处理，别走 Chrome 的开关说明页。 */
function IL_isSafariExtension() {
  return globalThis.chrome?.runtime?.getURL?.('').startsWith('safari-web-extension:') === true;
}

globalThis.IL_isRestrictedUrl = function IL_isRestrictedUrl(url) {
  if (!url) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const proto = u.protocol;
  if (
    proto === 'chrome:' ||
    proto === 'chrome-extension:' ||
    proto === 'chrome-search:' ||
    proto === 'chrome-untrusted:' ||
    proto === 'devtools:' ||
    proto === 'edge:' ||
    proto === 'about:' ||
    proto === 'view-source:' ||
    proto === 'safari-web-extension:' ||
    proto === 'safari-resource:' ||
    proto === 'favorites:'
  ) {
    return true;
  }
  if (proto === 'file:' && IL_isSafariExtension()) return true;
  // Web Store：主 frame 常无法注入
  if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
  if (u.hostname === 'chromewebstore.google.com') return true;
  return false;
};
