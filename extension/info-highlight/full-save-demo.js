/**
 * 强制原页整页收藏（跳过 auto 探测）。
 */
(() => {
  const MENU_ID = 'ih-save-phone-full';
  const { tr } = IH_i18n;

  async function saveFullToPhone(tab, hostPermPromise) {
    if (!tab?.id || !tab.url) return;
    const uiTabId = tab.id;
    if (IH_library.isSaving(uiTabId)) return;
    const url = tab.url;
    if (IH_library.saveBlockedUrl(url)) return;
    await IH_library.runPhoneLibrarySave(tab, tab.id, {
      overlayTitle: tr('Save to phone (original page)'),
      captureMode: 'full',
      hostPermPromise,
    });
  }

  function createMenu() {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: tr('Save to phone (original page)'),
      contexts: ['page', 'action'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  }

  function handleClick(info, tab) {
    if (info.menuItemId !== MENU_ID) return false;
    const hostPermPromise = IH_autoSites.requestAllSitesPermission();
    void saveFullToPhone(tab, hostPermPromise);
    return true;
  }

  globalThis.IH_fullSaveDemo = {
    MENU_ID,
    createMenu,
    handleClick,
    saveFullToPhone,
  };
})();
