/**
 * 收藏弹窗：过程 log 按 key 原地更新，不等同于整段覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../library.js'), 'utf8');

test('收藏弹窗 log 按 key 更新，分析/打包/合计分行', () => {
  assert.match(src, /key: 'capture', label: tr\('Capture'\), pending: true \},\s*\{ key: 'analyze'/);
  assert.match(src, /ui\.lines/);
  assert.match(src, /height: calc\(8 \* 1\.55em\)/);
  assert.match(src, /overflow: hidden/);
  assert.match(src, /ih-library-cancel-save/);
  assert.match(src, /\.ih-lib-cancel/);
  assert.match(src, /renderLibraryLines/);
  assert.match(src, /\.ih-lib-hint\.is-off/);
  assert.match(src, /pending: true/);
  assert.match(src, /ih-lib-dots/);
  assert.match(src, /libraryLogPending/);
  assert.match(src, /libraryLog\(uiTabId, 'page'/);
  assert.match(src, /libraryLogPending\(uiTabId, 'images'/);
  assert.match(src, /libraryImagesLogDetail/);
  assert.match(src, /imgUrls\.length > LIBRARY_IMG_MAX_COUNT/);
  assert.doesNotMatch(src, /bgFound/);
  assert.match(src, /libraryImgTagHasDataSrc/);
  assert.match(src, /inlined\.imagesCap/);
  assert.match(src, /libraryTotalLogDetail/);
  assert.match(src, /totalChars > LIBRARY_MAX_CONTENT_CHARS/);
  assert.doesNotMatch(src, /imagesPacked, inlined\.imagesTotal/);
  assert.match(src, /LIBRARY_IMG_MAX_COUNT = 100/);
  assert.match(src, /maxCount: LIBRARY_IMG_MAX_COUNT/);
  assert.match(src, /maxInlineCount/);
  assert.match(src, /libraryLog\(\s*uiTabId,\s*'total'/);
  assert.match(src, /Saved to cloud\. Open on your phone\./);
  assert.match(src, /libraryLogPending\(tabId, 'result'/);
  assert.match(src, /async function postLibraryJson/);
  assert.doesNotMatch(src, /XMLHttpRequest/);
  assert.match(src, /isLibraryUploadNetworkError/);
  assert.match(src, /ih-library-retry-upload/);
  assert.match(src, /Retry upload/);
  assert.match(src, /libraryUploadStash/);
  assert.match(src, /key: 'result'/);
  assert.match(src, /next\.tone = 'success'/);
  assert.match(src, /\.ih-lib-line\.is-success/);
  assert.match(src, /\.ih-lib-line-full\.is-error/);
  assert.doesNotMatch(src, /\.ih-lib-status\.is-error/);
  assert.doesNotMatch(src, /Saving to phone…/);
  assert.doesNotMatch(src, /Packing page…/);
  assert.match(src, /\.ih-lib-foot/);
  assert.match(src, /readOnPhone/);
  assert.match(src, /readOnPhoneFollowUp/);
  assert.match(src, /readOnPhoneNote/);
  assert.match(src, /librarySaveErrDetail/);
  assert.match(src, /Library is full \(\{max\} items\)/);
  assert.match(src, /LIBRARY_PAGE_URL/);
  assert.match(src, /\.ih-lib-copy-btn/);
  assert.match(src, /copyMobileOpen/);
  assert.match(src, /buildLibraryMobileOpenUrl/);
  assert.match(src, /libraryMobileOpenUrl/);
  assert.match(src, /searchParams\.set\('key'/);
  assert.doesNotMatch(src, /searchParams\.set\('api'/);
  assert.match(src, /libraryMobileOpenUrl \|\| ui\.libraryMobileOpenUrl/);
  assert.match(src, /\.ih-lib-qr-wrap/);
  assert.match(src, /vendor\/qrcodegen\.js/);
  assert.match(src, /applyMobileOpenQr/);
  assert.match(src, /scanQrHint/);
  assert.match(src, /buildLibraryArticleOpenUrl/);
  assert.match(src, /pathname = '\/library\/' \+ encodeURIComponent\(cap\)/);
  assert.doesNotMatch(src, /searchParams\.set\('c',\s*cap\)/);
  assert.match(src, /ih-library-open-preview/);
  assert.match(src, /ih-lib-preview/);
  assert.match(src, /ih-lib-result-row/);
  assert.match(src, /libraryArticleUrl/);
  assert.match(src, /previewSavedArticle: tr\('Preview'\)/);
  assert.match(src, /deleteSavedArticle: tr\('Delete'\)/);
  assert.match(src, /ih-library-delete-saved/);
  assert.match(src, /\.ih-lib-delete/);
  assert.match(src, /libraryArticleId/);
  assert.match(src, /deleteLibraryItem/);
  assert.match(src, /LIBRARY_PREVIEW_WIDTH/);
  assert.match(src, /LIBRARY_PREVIEW_HEIGHT = 844/);
  assert.match(src, /libraryPreviewPopupBounds/);
  assert.match(src, /chrome\.windows\.getLastFocused/);
  assert.match(src, /sender\.tab\?\.windowId/);
});

test('阅读视图注入：定根与视觉重排脚本须齐备', () => {
  assert.match(src, /IL_reorderArticleBlocksByVisual/);
  assert.match(src, /visualBlockOrder\.js/);
  assert.match(src, /Visual reorder missing/);
});

test('收藏自动模式：仅白名单原页整页，其余阅读视图', () => {
  assert.match(src, /IH_libraryCaptureAllowlist/);
  assert.match(src, /libraryUrlOnFullCaptureAllowlist/);
  assert.match(src, /libraryAutoUseFullCapture/);
  assert.doesNotMatch(src, /hasDarkModeCssSignal/);
  assert.doesNotMatch(src, /hasResponsiveViewport/);
  const allowSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../library-capture-allowlist.js'), 'utf8');
  assert.match(allowSrc, /mp\.weixin\.qq\.com\/s\//);
});

test('收藏入口：受保护页与 PDF 静默跳过', () => {
  assert.match(src, /function librarySaveBlockedUrl/);
  assert.match(src, /saveBlockedUrl: librarySaveBlockedUrl/);
  assert.match(src, /if \(librarySaveBlockedUrl\(url\)\) return;/);
  assert.doesNotMatch(src, /can't run here/);
});
