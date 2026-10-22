/**
 * 强制阅读视图收藏：分析并烘高亮 → Readability 定根 → 内联 reader CSS 快照上传。
 */
(() => {
  const MENU_ID = 'ih-save-phone-reader-demo';
  const { tr } = IH_i18n;

  async function saveReaderToPhone(tab, hostPermPromise) {
    if (!tab?.id || !tab.url) return;
    const uiTabId = tab.id;
    if (IH_library.isSaving(uiTabId)) return;
    const url = tab.url;
    if (IH_library.saveBlockedUrl(url)) return;
    await IH_library.runPhoneLibrarySave(tab, tab.id, {
      overlayTitle: tr('Save to phone (reader view)'),
      captureMode: 'reader',
      hostPermPromise,
    });
  }

  function createMenu() {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: tr('Save to phone (reader view)'),
      contexts: ['page', 'action'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  }

  function handleClick(info, tab) {
    if (info.menuItemId !== MENU_ID) return false;
    const hostPermPromise = IH_autoSites.requestAllSitesPermission();
    void saveReaderToPhone(tab, hostPermPromise);
    return true;
  }

  globalThis.IH_readerSaveDemo = {
    MENU_ID,
    createMenu,
    handleClick,
    saveReaderToPhone,
  };
})();
