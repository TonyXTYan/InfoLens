/**
 * 工具栏点击 / 右键菜单 → 注入 content（activeTab 手势）。已注入则 toggle。
 * 分析：本机 WebGPU（已就绪），或云端。官方门面：余额至少 1 点走 /v2/analyze，为 0 走 /v2/analyze-free。选项自定义 API 根时走 POST /api/analyze。
 * PDF：整条流程在 pdf/sw.js（共享），本文件只负责在网页管线里的何处插入它。
 */

importScripts('sw/restricted-url.js');
importScripts('sw/action-dot.js');
importScripts('options-attention.js');
importScripts('options-catalog.js');
importScripts('config.js');
importScripts('api-base.js');
importScripts('sw/lifecycle-events.js');
importScripts('open-about-feedback.js');
importScripts('sw/client-id.js');
importScripts('sw/author-note.js');
importScripts('sw/inject.js');
importScripts('auto-sites.js');
importScripts('anonymousSiteDomain.js');
importScripts('pdf/stash-db.js');
importScripts('pdf/sw.js');
importScripts('cache/ring-store.js');
importScripts('analyzeCache.js');
importScripts('local/state.js');
importScripts('highlightStyle.js');
importScripts('optionDefaults.js');
importScripts('zh.js');
importScripts('options-i18n.js');
importScripts('i18n.js');
importScripts('local/userErrors.js');
importScripts('cloudWait.js');
importScripts('init-window-bounds.js');
importScripts('action-state.js');
importScripts('library-capture-allowlist.js');
importScripts('library.js');
importScripts('full-save-demo.js');
importScripts('reader-save-demo.js');

const EXTENSION_ID = 'info-highlight';
const { tr } = IH_i18n;

if (!globalThis.IH_localState) throw new Error('IH_localState missing');
if (!globalThis.IH_highlightStyle) throw new Error('IH_highlightStyle missing');
if (!globalThis.IH_optionDefaults) throw new Error('IH_optionDefaults missing');
if (!globalThis.IH_userErrors) throw new Error('IH_userErrors missing');
if (!globalThis.IH_cloudWait) throw new Error('IH_cloudWait missing');
if (!globalThis.IH_analyzeCache) throw new Error('IH_analyzeCache missing');
if (!globalThis.IH_initWindowBounds) throw new Error('IH_initWindowBounds missing');
if (!globalThis.IH_actionState) throw new Error('IH_actionState missing');
if (!globalThis.IH_autoSites) throw new Error('IH_autoSites missing');
if (!globalThis.IH_anonymousSiteDomain) throw new Error('IH_anonymousSiteDomain missing');
if (!globalThis.IH_libraryCaptureAllowlist) throw new Error('IH_libraryCaptureAllowlist missing');
if (!globalThis.IH_library) throw new Error('IH_library missing');
if (!globalThis.IH_fullSaveDemo) throw new Error('IH_fullSaveDemo missing');
if (!globalThis.IH_readerSaveDemo) throw new Error('IH_readerSaveDemo missing');

void IL_ensureApiBaseLoaded().then(() => IL_prepareClientIdReporting(EXTENSION_ID));

async function fetchWithApiKey(path, init, apiKey) {
  await IL_ensureApiBaseLoaded();
  apiKey ??= await IL_getApiKey();
  const headers = new Headers(init?.headers || {});
  headers.set('Authorization', `Bearer ${apiKey}`);
  return fetch(`${IL_API_BASE}${path}`, { ...init, headers });
}

const CONTENT_CSS = ['content.css'];
/** SYNC: options.html 网页管线脚本（无 drop-stale / tokenTip；另加 options-page-flags.js） */
const CONTENT_JS = [
  'drop-stale.js',
  'vendor/Readability.js',
  'extractRootPatches.js',
  'articleRoot.js',
  'visualBlockOrder.js',
  'textMapConfig.js',
  'collectTextMap.js',
  'splitTextToChunks.js',
  'textIndex.js',
  'scrollGeometry.js',
  'progressAxis.js',
  'overlay.js',
  'statusFeedback.js',
  'feedbackContext.js',
  'highlightStyle.js',
  'optionDefaults.js',
  'wordMerge.js',
  'config.js',
  'options-about-zh.js',
  'zh.js',
  'options-i18n.js',
  'i18n.js',
  'local/userErrors.js',
  'cloudWait.js',
  'dynamicTrack.js',
  'page-map.js',
  'tokenTip.js',
  'analyzeRun.js',
  'auto-sites.js',
  'auto-nudge.js',
  'engagement-nudge-key.js',
  'engagement-nudge.js',
  'engagement-nudge-ui.js',
  'anonymousSiteDomain.js',
  'content.js',
];

/**
 * 本世界 API 活着则可选调用 toggle/start；否则看 DOM 是否还有网页管线上次注入的痕迹。
 * live / stale / empty。重载后旧隔离世界互不可见，只能靠标记。
 * SYNC: content.js 的 data-ih-cs。PDF 入口节点由 entry.js 同 id 回收，不当 stale。
 * @param {'toggle' | 'start' | 'force' | ''} [method]
 * @param {string} [cloudModel] force 时钉住的云端模型 id；空则走当前偏好
 * @param {string} [trigger] auto | icon | menu | rerun | other
 * @returns {Promise<{ state: 'live' | 'stale' | 'empty', result?: unknown }>}
 */
async function pageCsPeek(tabId, method, cloudModel, trigger) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      args: [method || '', typeof cloudModel === 'string' ? cloudModel : '', typeof trigger === 'string' ? trigger : ''],
      func: (m, model, why) => {
        const demo = window.__IH_DEMO__;
        const pdf = window.__IH_PDF_ENTRY__;
        let live = false;
        try {
          live = typeof demo?.isLive === 'function' && !!demo.isLive();
        } catch {
          /* 作废 */
        }
        if (!live) {
          try {
            live = typeof pdf?.isLive === 'function' && !!pdf.isLive();
          } catch {
            /* 作废 */
          }
        }
        if (live) {
          if (m === 'start' && typeof demo?.start === 'function') {
            return { state: 'live', result: demo.start() };
          }
          if (m === 'force' && typeof demo?.force === 'function') {
            demo.force(model, why);
            return { state: 'live', result: true };
          }
          if (m === 'toggle' && typeof demo?.toggle === 'function') {
            demo.toggle(why);
            return { state: 'live', result: true };
          }
          return { state: 'live' };
        }
        const marked = document.documentElement.hasAttribute('data-ih-cs');
        return { state: marked ? 'stale' : 'empty' };
      },
    });
    const v = results?.[0]?.result;
    if (v?.state === 'live' || v?.state === 'stale') return v;
    return { state: 'empty' };
  } catch {
    return { state: 'empty' };
  }
}

const STALE_PAGE_MSG =
  'A previous version of Info Highlight is still on this page. Please refresh the page and try again.';
/** SYNC: analyzeRun.js → FORCE_BUSY_MSG */
const FORCE_BUSY_MSG =
  'Info Highlight is still analyzing this page. Try again when it finishes.';

async function pageAlert(tabId, msg) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (msg) => { alert(msg); },
      args: [msg],
    });
  } catch {
    /* 页上 alert 不了 */
  }
}

async function refuseStalePage(tabId, trigger) {
  await setBadgeError(tabId, 'refresh this page', trigger);
  await pageAlert(tabId, STALE_PAGE_MSG);
}

/** 收藏：注入网页管线，从头画到上限（已画段走会话缓存）。过期页返回 false（已提示刷新）。 */
async function ensureLibraryAnalyzed(id) {
  const peek = await pageCsPeek(id);
  if (peek.state === 'stale') {
    await refuseStalePage(id, 'library');
    return false;
  }
  if (peek.state !== 'live') {
    await IL_injectWithRetry(id, { css: CONTENT_CSS, js: CONTENT_JS }, {
      logLabel: 'Info Highlight',
      waitComplete: false,
    });
    const after = await pageCsPeek(id);
    if (after.state === 'stale') {
      await refuseStalePage(id, 'library');
      return false;
    }
    if (after.state !== 'live') throw new Error('inject');
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: id, frameIds: [0] },
    func: async () => {
      const fn = window.__IH_DEMO__?.ensureForLibrary;
      if (typeof fn !== 'function') throw new Error('ensureForLibrary missing');
      await fn();
      return true;
    },
  });
  if (!results?.[0]?.result) throw new Error('Analyze failed');
  return true;
}

function clearBadge(tabId) {
  void chrome.action.setBadgeText({ text: '', tabId });
}

async function setBadgeError(tabId, brief, trigger) {
  try {
    IH_actionState.set(tabId, 'off');
    await chrome.action.setBadgeBackgroundColor({ color: '#c0392b', tabId });
    await chrome.action.setBadgeText({ text: '!', tabId });
    await chrome.action.setTitle({ title: `Info Highlight: ${brief}`, tabId });
  } catch {
    /* ignore */
  }
  try {
    await postUsageReport({
      outcome: 'failed',
      segments: 0,
      error: String(brief || '').slice(0, 500),
      trigger,
    });
  } catch {
    /* ignore */
  }
  try {
    await postAnonymousSiteDomainForTab(tabId, trigger);
  } catch {
    /* ignore */
  }
}

async function activateTab(tab, force, cloudModel, trigger) {
  if (!tab?.id) return;
  const pinned = force ? knownCloudModel(cloudModel) : '';
  const why = typeof trigger === 'string' ? trigger : '';
  // optional file:// request 必须在手势同步阶段启动；前面不能有 await
  const fileHostPromise = IL_pdfSw.isFileUrl(tab.url) ? IL_pdfSw.requestFileHostFromGesture() : null;
  IL_setActionIconDotted(false);
  if (!force && IH_actionState.shouldIgnoreClick(tab.id)) return;
  if (force && IH_actionState.get(tab.id) === 'analyzing') {
    await pageAlert(tab.id, FORCE_BUSY_MSG);
    return;
  }
  try {
    const fresh = await chrome.tabs.get(tab.id);
    const url = fresh.url || tab.url || '';
    if (IL_pdfSw.isOwnViewerUrl(url)) {
      IH_actionState.markAnalyzingIfIdle(tab.id);
      const ok = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: force ? 'ih-pdf-force' : 'ih-pdf-toggle',
          tabId: tab.id,
          ...(pinned ? { cloudModel: pinned } : {}),
          ...(why ? { trigger: why } : {}),
        }, (res) => {
          resolve(!chrome.runtime.lastError && res?.ok === true);
        });
      });
      if (!ok) {
        await setBadgeError(tab.id, 'inject', why);
        return;
      }
      clearBadge(tab.id);
      return;
    }
    if (IL_isRestrictedUrl(url)) {
      console.warn('[Info Highlight] cannot run on this page:', url);
      await setBadgeError(tab.id, "can't run here — this page is protected", why);
      try {
        await openRestrictedPageWindow(fresh.windowId ?? tab.windowId);
      } catch (err) {
        console.warn('[Info Highlight] restricted-page notice', err);
      }
      return;
    }
    const access = await IL_pdfSw.ensureFileUrlAccess(url, fileHostPromise);
    if (!access.ok) {
      await setBadgeError(tab.id, access.brief, why);
      return;
    }
    if (IL_pdfSw.isPdfUrl(url)) {
      const peek = await pageCsPeek(tab.id);
      if (peek.state === 'stale') {
        await refuseStalePage(tab.id, why);
        return;
      }
      await IL_pdfSw.injectEntry(tab.id);
      clearBadge(tab.id);
      return;
    }
    // 无 .pdf 后缀时先由页内按 Content-Type / 魔数确认，再退回网页管线
    {
      const peek = await pageCsPeek(tab.id, force ? 'force' : 'toggle', pinned, why);
      if (peek.state === 'stale') {
        await refuseStalePage(tab.id, why);
        return;
      }
      // result 表示页内 demo.toggle / force 已执行。仅 PDF 入口 live 时没有 result，要落到下面切按钮。
      if (peek.state === 'live' && peek.result) {
        manualTabs.add(tab.id);
        clearBadge(tab.id);
        return;
      }
    }
    if (await IL_pdfSw.injectEntryAndOffered(tab.id)) {
      clearBadge(tab.id);
      return;
    }
    IH_actionState.markAnalyzingIfIdle(tab.id);
    manualTabs.add(tab.id);
    IH_actionState.set(tab.id, 'analyzing');
    const okTab = await IL_injectWithRetry(tab.id, { css: CONTENT_CSS, js: CONTENT_JS }, {
      logLabel: 'Info Highlight',
      waitComplete: false,
    });
    const after = await pageCsPeek(tab.id, force ? 'force' : 'toggle', pinned, why);
    if (after.state !== 'live') {
      await setBadgeError(tab.id, 'inject', why);
      return;
    }
    console.info('[Info Highlight] injected into', okTab.url);
    clearBadge(tab.id);
  } catch (err) {
    try {
      if (await IL_pdfSw.injectEntryAndOffered(tab.id)) {
        clearBadge(tab.id);
        return;
      }
    } catch (pdfErr) {
      console.error('[Info Highlight] pdf-entry inject failed', pdfErr);
    }
    console.error('[Info Highlight] inject failed', err);
    await setBadgeError(tab.id, 'inject', why);
  }
}

const CONTEXT_MENU_ID = 'ih-highlight';
const FORCE_MENU_ID = 'ih-force-analyze';
const FORCE_MODEL_PREFIX = 'ih-force-model:';
const AUTO_MENU_ID = 'ih-auto-site';
const OPTIONS_MENU_ID = 'ih-options';
const EXTRACT_PREVIEW_MENU_ID = 'ih-extract-preview';
const ANALYZE_MENU_TITLE = tr('Analyze this page');
const FORCE_ANALYZE_MENU_TITLE = tr('Reanalyze this page');

function knownCloudModel(id) {
  if (typeof id !== 'string' || !id) return '';
  return IH_localState.CLOUD_MODELS.some((m) => m.id === id) ? id : '';
}

/** SYNC: page-map.js FADE_DEFAULT_NOTICE。没存过形式的升级用户，下次网页高亮时提醒一次。 */
const FADE_DEFAULT_NOTICE = 'ih_fade_default_notice';
/** 最低可见度默认 30%：升级时覆盖已有值，不弹提示；只写一次，以免以后用户再改又被盖掉。 */
const FADE_MIN_FORCE_30 = 'ih_fade_min_force_30';

/** SYNC: options.html 侧栏锚点 */
const OPTIONS_PAGE_SECTIONS = new Set([
  'highlight',
  'display',
  'content',
  'analysis',
  'cloud-credits',
  'credit-orders',
  'auto-analyze',
  'storage',
  'settings-restore',
  'about',
]);

async function armFadeDefaultNotice(details) {
  const paintKey = IH_highlightStyle.KEY_PAINT_STYLE;
  const cur = await chrome.storage.local.get([paintKey, FADE_DEFAULT_NOTICE]);
  const mark = cur[FADE_DEFAULT_NOTICE];
  if (mark === 'seen' || mark === 'pending') return;
  const stored = cur[paintKey];
  const hasStyle = IH_highlightStyle.PAINT_STYLES.includes(stored);
  if (details.reason === 'install' || hasStyle) {
    await chrome.storage.local.set({ [FADE_DEFAULT_NOTICE]: 'seen' });
    return;
  }
  if (details.reason === 'update') {
    await chrome.storage.local.set({ [FADE_DEFAULT_NOTICE]: 'pending' });
  }
}

async function applyFadeMinDefault(details) {
  if (details.reason !== 'install' && details.reason !== 'update') return;
  const cur = await chrome.storage.local.get([FADE_MIN_FORCE_30]);
  if (cur[FADE_MIN_FORCE_30]) return;
  const patch = { [FADE_MIN_FORCE_30]: true };
  if (details.reason === 'update') {
    patch[IH_highlightStyle.KEY_FADE_MIN_PCT] = IH_highlightStyle.FADE_MIN_DEFAULT;
  }
  await chrome.storage.local.set(patch);
}

function autoMenuTitle(host, on) {
  return on ? tr('Stop always analyzing {host}', { host }) : tr('Always analyze {host}', { host });
}

function extractPreviewMenuTitle(on) {
  return on
    ? tr('(Debug) Stop outlining extractable text')
    : tr('(Debug) Outline extractable text');
}

/** 人工点过图标的标签：自动分析别再插手，直到下次导航 */
const manualTabs = new Set();
/** tabId -> 导航代数；reset 时 +1，过期的自动分析不再改状态 */
const autoGenByTab = new Map();
/** 同一 tabId 的 maybeAutoAnalyze 互斥：onActivated / onUpdated(complete) 可能几乎同时触发 */
const autoAnalyzeInFlight = new Set();

/**
 * 无 tabs 权限时只看得见已授权站点的 url；看不见即未授权，正好是要显示「添加」的情形。
 * @param {number} tabId
 */
async function syncAutoMenu(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const host = IH_autoSites.hostOf(tab?.url || '');
  if (!host) {
    // 看不见 url（未授权）或非 http(s)：标题用不到，点下去才从 pageUrl 取 host
    chrome.contextMenus.update(AUTO_MENU_ID, { title: tr('Always analyze this site') }, () => {
      void chrome.runtime.lastError;
    });
    return;
  }
  const on = await IH_autoSites.hasExact(host);
  chrome.contextMenus.update(AUTO_MENU_ID, { title: autoMenuTitle(host, on) }, () => {
    void chrome.runtime.lastError;
  });
}

/** 普通 http(s) 网页；PDF / 受保护页 / 插件页等不展示「划出可提取文本」。 */
function extractPreviewSupportedUrl(url) {
  if (!url || IL_isRestrictedUrl(url)) return false;
  if (IL_pdfSw.isPdfUrl(url) || IL_pdfSw.isOwnViewerUrl(url)) return false;
  return /^https?:\/\//i.test(url);
}

/** 受保护页 / PDF 等：不展示「收藏到手机」入口。 */
function syncLibraryMenu(tabId) {
  void chrome.tabs.get(tabId).then((tab) => {
    const visible = !IH_library.saveBlockedUrl(tab?.url || '');
    chrome.contextMenus.update(IH_library.MENU_ID, { visible }, () => {
      void chrome.runtime.lastError;
    });
  }).catch(() => {
    chrome.contextMenus.update(IH_library.MENU_ID, { visible: false }, () => {
      void chrome.runtime.lastError;
    });
  });
}

function syncTabContextMenus(tabId) {
  void syncAutoMenu(tabId);
  syncLibraryMenu(tabId);
  void syncExtractPreviewMenu(tabId);
}

async function syncExtractPreviewMenu(tabId) {
  const setMenu = (patch) => {
    chrome.contextMenus.update(EXTRACT_PREVIEW_MENU_ID, patch, () => {
      void chrome.runtime.lastError;
    });
  };
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!extractPreviewSupportedUrl(tab?.url || '')) {
      setMenu({ visible: false, title: extractPreviewMenuTitle(false) });
      return;
    }
    setMenu({ visible: true });
    const peek = await pageCsPeek(tabId);
    if (peek.state !== 'live') {
      setMenu({ title: extractPreviewMenuTitle(false) });
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => !!window.__IH_DEMO__?.isExtractPreviewOn?.(),
    });
    setMenu({ title: extractPreviewMenuTitle(!!results?.[0]?.result) });
  } catch {
    setMenu({ visible: false, title: extractPreviewMenuTitle(false) });
  }
}

async function toggleExtractPreviewOnTab(tab) {
  if (!tab?.id) return;
  const tabId = tab.id;
  if (!extractPreviewSupportedUrl(tab.url || '')) return;
  const peek = await pageCsPeek(tabId);
  if (peek.state === 'stale') {
    void refuseStalePage(tab.id, 'menu');
    return;
  }
  if (peek.state !== 'live') {
    const okTab = await IL_injectWithRetry(tabId, { css: CONTENT_CSS, js: CONTENT_JS }, {
      logLabel: 'Info Highlight',
      waitComplete: false,
    });
    const after = await pageCsPeek(tabId);
    if (after.state === 'stale') {
      void refuseStalePage(tab.id, 'menu');
      return;
    }
    if (after.state !== 'live') {
      await setBadgeError(tabId, 'inject', 'menu');
      console.error('[Info Highlight] inject failed for extract preview', okTab?.url);
      return;
    }
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const fn = window.__IH_DEMO__?.toggleExtractPreview;
        if (typeof fn !== 'function') throw new Error('toggleExtractPreview missing');
        return fn();
      },
    });
    const on = !!results?.[0]?.result;
    chrome.contextMenus.update(EXTRACT_PREVIEW_MENU_ID, { title: extractPreviewMenuTitle(on) }, () => {
      void chrome.runtime.lastError;
    });
  } catch (err) {
    console.error('[Info Highlight] extract preview', err);
    await pageAlert(tabId, String(err?.message || err));
  }
}

const AUTO_SITE_PENDING_KEY = 'ih_auto_site_pending';

async function settleAutoSitePending() {
  const res = await chrome.storage.session.get({ [AUTO_SITE_PENDING_KEY]: null });
  const pending = res[AUTO_SITE_PENDING_KEY];
  if (!pending || typeof pending.host !== 'string' || typeof pending.tabId !== 'number') return;
  const hasPerm = await IH_autoSites.hasAllSitesPermission();
  if (!hasPerm) return;
  manualTabs.delete(pending.tabId);
  await IH_autoSites.add(pending.host);
  await chrome.storage.session.remove(AUTO_SITE_PENDING_KEY);
  await maybeAutoAnalyze(pending.tabId);
  await syncAutoMenu(pending.tabId);
}

async function toggleAutoSite(info, tabId, tabUrl) {
  // 网页右键带 pageUrl。图标菜单的点击参数是空的，host 用这次点击授予的 tab.url。
  const url = info.pageUrl || tabUrl || '';
  const host = IH_autoSites.hostOf(url);
  if (!host) throw new Error(`auto-site menu on unsupported url: ${url || '(none)'}`);
  const origin = IH_autoSites.allSitesPermissionRequest();
  // 手势同步阶段发起；已授权时不弹窗直接 true，故开关两向都先发它
  const requested = IH_autoSites.requestAllSitesPermission();
  const wasOn = await IH_autoSites.hasExact(host);
  // 用户刚在菜单里表了态，之前点图标的操作不再压制自动分析
  manualTabs.delete(tabId);
  if (wasOn) {
    await requested;
    await IH_autoSites.remove(host);
    await syncAutoMenu(tabId);
    return;
  }
  // 弹窗期间 SW 可能被掐掉，request 的 true 回不来；意图先写入 session，授权到了再补名单。
  await chrome.storage.session.set({ [AUTO_SITE_PENDING_KEY]: { host, tabId } });
  const granted = await requested.catch(() => false);
  if (granted || (await chrome.permissions.contains(origin))) {
    await settleAutoSitePending();
    return;
  }
  await chrome.storage.session.remove(AUTO_SITE_PENDING_KEY);
  await syncAutoMenu(tabId);
}

/** 网页里的脚本决定要问时，只负责把窗打开。选择由窗自己写存储。 */
const NUDGE_WIDTH = 540;
const NUDGE_HEIGHT = 360;
const WELCOME_WIDTH = 540;
const WELCOME_HEIGHT = 360;

/**
 * 绑在宿主窗口上的 popup。窗关了就忘掉；焦点回到宿主时，按登记顺序把还开着的第一扇拉到前面。
 * Prepare 的开窗、等待、失败重试仍在下面，这里只登记它的窗和宿主。
 * @type {{ id: number | null, host: number | null, onClose?: () => void }[]}
 */
const hostBoundPopups = [];

/** @param {(() => void) | undefined} onClose */
function hostBoundPopup(onClose) {
  const slot = { id: null, host: null, onClose };
  hostBoundPopups.push(slot);
  return slot;
}

function releaseHostPopup(slot) {
  if (slot.id == null) return;
  slot.id = null;
  slot.host = null;
  slot.onClose?.();
}

/** 同时开着时：Prepare、引导页、自动分析询问、受保护页说明。 */
const initPopup = hostBoundPopup(() => notifyOptionsInitOverlay(false));
const welcomePopup = hostBoundPopup();
const autoNudgePopup = hostBoundPopup();
const restrictedPagePopup = hostBoundPopup();

chrome.windows.onRemoved.addListener((windowId) => {
  for (const slot of hostBoundPopups) {
    if (slot.id === windowId) releaseHostPopup(slot);
  }
});

/** 焦点回到打开弹窗时的宿主窗 → 再把弹窗拉到前面。 */
function focusPopupIfHostFocused(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (hostBoundPopups.some((slot) => slot.id != null && windowId === slot.id)) return;
  const hit = hostBoundPopups.find(
    (slot) => slot.id != null && slot.host != null && windowId === slot.host,
  );
  if (hit) void chrome.windows.update(hit.id, { focused: true }).catch(() => {});
}

chrome.windows.onFocusChanged.addListener(focusPopupIfHostFocused);

/** 已开着就只聚焦。窗已经没了则清掉登记，调用方再开一扇。不走 onClose。 */
async function focusHeld(slot) {
  if (slot.id == null) return false;
  try {
    await chrome.windows.update(slot.id, { focused: true });
    return true;
  } catch {
    slot.id = null;
    slot.host = null;
    return false;
  }
}

/**
 * @param {{ url: string, width: number, height: number, host?: chrome.windows.Window | null }} spec
 * 坐标被拒时去掉 left/top 再开一次。
 */
async function createClampedPopup(spec) {
  /** @type {chrome.windows.CreateData} */
  const create = {
    url: spec.url,
    type: 'popup',
    width: spec.width,
    height: spec.height,
    focused: true,
  };
  const pos = spec.host
    ? IH_initWindowBounds.clampPopupToHost(spec.host, spec.width, spec.height)
    : null;
  if (pos) {
    create.left = pos.left;
    create.top = pos.top;
  }
  let win;
  try {
    win = await chrome.windows.create(create);
  } catch (err) {
    if (!IH_initWindowBounds.isBoundsError(err) || create.left == null) throw err;
    delete create.left;
    delete create.top;
    win = await chrome.windows.create(create);
  }
  if (win?.id == null) throw new Error('Popup create returned no id');
  return win.id;
}

/** @param {number | undefined} hostWindowId 选项页标签所在窗口 */
async function openWelcomeWindow(hostWindowId) {
  if (typeof hostWindowId !== 'number') throw new Error('Welcome window requires the options window');
  if (await focusHeld(welcomePopup)) return;
  const id = await createClampedPopup({
    url: chrome.runtime.getURL('welcome.html'),
    width: WELCOME_WIDTH,
    height: WELCOME_HEIGHT,
    host: await chrome.windows.get(hostWindowId),
  });
  welcomePopup.id = id;
  welcomePopup.host = hostWindowId;
}

async function openAskWindow(url, hostWindowId) {
  /** @type {chrome.windows.Window | null} */
  let host = null;
  try {
    host = typeof hostWindowId === 'number'
      ? await chrome.windows.get(hostWindowId)
      : await chrome.windows.getLastFocused();
  } catch {
    /* 没有宿主窗口时让浏览器自己放 */
  }
  return createClampedPopup({
    url,
    width: NUDGE_WIDTH,
    height: NUDGE_HEIGHT,
    host,
  });
}

/** 同一站点已开着就只聚焦。另一个站点够次数时另开一扇，抢焦点跟到新的这扇。 */
async function openNudgeWindow(host, hostWindowId) {
  if (autoNudgePopup.site === host && await focusHeld(autoNudgePopup)) return;
  const id = await openAskWindow(
    chrome.runtime.getURL('auto-nudge.html') + `?host=${encodeURIComponent(host)}`,
    hostWindowId,
  );
  autoNudgePopup.id = id;
  autoNudgePopup.host = typeof hostWindowId === 'number' ? hostWindowId : null;
  autoNudgePopup.site = host;
}

/** 受保护页：扩展自己的说明窗，不往页面里注入。已开着就只聚焦。 */
async function openRestrictedPageWindow(hostWindowId) {
  if (await focusHeld(restrictedPagePopup)) return;
  const id = await openAskWindow(chrome.runtime.getURL('restricted-page.html'), hostWindowId);
  restrictedPagePopup.id = id;
  restrictedPagePopup.host = typeof hostWindowId === 'number' ? hostWindowId : null;
}

function resetAutoForTab(tabId) {
  manualTabs.delete(tabId);
  autoGenByTab.set(tabId, (autoGenByTab.get(tabId) || 0) + 1);
  if (IH_actionState.get(tabId) !== 'off') IH_actionState.set(tabId, 'off');
}

/**
 * 命中名单的前台、已 complete 的标签即可分析。PDF / file: 不进。
 * 重复触发是幂等的：页内已在跑返回 'busy'、已画好返回 'painted'，都不动它。
 * 扩展重载后的过期标签静默跳过：不弹刷新、不算失败（用户点图标/菜单才提示）。
 * @param {number} tabId
 */
async function maybeAutoAnalyze(tabId) {
  // onActivated / onUpdated(complete) 可能几乎同时触发；不互斥会各自把 content.js 注入一遍，
  // 两份独立的页面管线各跑一次分析，对同一段正文重复发请求。
  if (autoAnalyzeInFlight.has(tabId)) return;
  autoAnalyzeInFlight.add(tabId);
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.active || tab.status !== 'complete' || manualTabs.has(tabId)) return;
    const url = tab.url || '';
    const host = IH_autoSites.hostOf(url);
    if (!host || IL_isRestrictedUrl(url) || IL_pdfSw.isPdfUrl(url)) return;
    if (!(await IH_autoSites.granted(host))) return;
    const gen = autoGenByTab.get(tabId) || 0;
    const stillCurrent = () => (autoGenByTab.get(tabId) || 0) === gen;
    try {
      const peek = await pageCsPeek(tabId, 'start');
      if (!stillCurrent()) return;
      if (peek.state === 'stale') {
        // 旧隔离世界没法再注入。自动分析不弹窗、不记失败。
        return;
      }
      if (peek.state === 'live') {
        const started = peek.result;
        if (started === 'painted') IH_actionState.set(tabId, 'on');
        if (started && started !== 'busy') clearBadge(tabId);
        return;
      }
      IH_actionState.set(tabId, 'analyzing');
      await IL_injectWithRetry(tabId, { css: CONTENT_CSS, js: CONTENT_JS }, {
        logLabel: 'Info Highlight auto',
        waitComplete: false,
        isStale: () => !stillCurrent(),
      });
      if (!stillCurrent()) return;
      const after = await pageCsPeek(tabId, 'start');
      if (!stillCurrent()) return;
      if (after.state === 'live' && after.result) {
        clearBadge(tabId);
        return;
      }
      if (after.state === 'stale') return;
      await setBadgeError(tabId, 'inject', 'auto');
    } catch (err) {
      if (!stillCurrent()) return;
      if (String(err?.message || err).includes('navigation superseded')) {
        IH_actionState.set(tabId, 'off');
        return;
      }
      console.error('[Info Highlight] auto inject failed', err);
      await setBadgeError(tabId, 'inject', 'auto');
    }
  } finally {
    autoAnalyzeInFlight.delete(tabId);
  }
}

chrome.action.onClicked.addListener((tab) => {
  void activateTab(tab, false, '', 'icon');
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  syncTabContextMenus(tabId);
  void maybeAutoAnalyze(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 整页开始加载才 reset。地址变了或 DOM 变了不自动跟。
  if (changeInfo.status === 'loading') resetAutoForTab(tabId);
  if (tab.active && (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete')) {
    syncTabContextMenus(tabId);
  }
  if (changeInfo.status === 'complete') void maybeAutoAnalyze(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  IH_actionState.clear(tabId);
  manualTabs.delete(tabId);
  autoGenByTab.delete(tabId);
});

/** Chrome 界面语言只在重启浏览器后生效，跟着走 onStartup 重建一次即可。 */
function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: AUTO_MENU_ID,
      title: tr('Always analyze this site'),
      contexts: ['page', 'action'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    IH_library.createMenu();
    chrome.contextMenus.create({
      id: 'ih-auto-separator',
      type: 'separator',
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: ANALYZE_MENU_TITLE,
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: FORCE_MENU_ID,
      title: FORCE_ANALYZE_MENU_TITLE,
      contexts: ['page', 'action'],
    });
    chrome.contextMenus.create({
      id: EXTRACT_PREVIEW_MENU_ID,
      title: extractPreviewMenuTitle(false),
      contexts: ['page', 'action'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    for (const m of IH_localState.CLOUD_MODELS) {
      chrome.contextMenus.create({
        id: FORCE_MODEL_PREFIX + m.id,
        title: `${FORCE_ANALYZE_MENU_TITLE} (${m.label})`,
        contexts: ['page'],
      });
    }
    chrome.contextMenus.create({
      id: 'ih-options-separator',
      type: 'separator',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: OPTIONS_MENU_ID,
      title: tr('Options'),
      contexts: ['page', 'action'],
    });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs[0]?.id;
      if (typeof id === 'number') syncTabContextMenus(id);
    });
  });
}

chrome.runtime.onStartup.addListener(buildContextMenus);

chrome.runtime.onInstalled.addListener((details) => {
  buildContextMenus();

  void IL_optionsAttention.onInstalled(details, IL_OPTIONS_CATALOG);
  void armFadeDefaultNotice(details);
  void applyFadeMinDefault(details);
  IL_setActionIconDotted(true);
  IL_reportInstallOrUpdate(details, EXTENSION_ID);
  if (details.reason === 'install') {
    void chrome.tabs.create({
      url: chrome.runtime.getURL('options.html') + '?welcome',
    });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === OPTIONS_MENU_ID) {
    IL_setActionIconDotted(false);
    void chrome.runtime.openOptionsPage();
    return;
  }
  if (!tab?.id) return;
  // 用过菜单也算用过插件；Chrome 右键工具栏图标本身不发事件，只能在这里灭蓝点
  IL_setActionIconDotted(false);
  if (info.menuItemId === CONTEXT_MENU_ID) void activateTab(tab, false, '', 'menu');
  else if (info.menuItemId === FORCE_MENU_ID) void activateTab(tab, true, '', 'rerun');
  else if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith(FORCE_MODEL_PREFIX)) {
    const modelId = info.menuItemId.slice(FORCE_MODEL_PREFIX.length);
    if (!knownCloudModel(modelId)) return;
    void activateTab(tab, true, modelId, 'rerun');
  }
  // permissions.request 要手势，toggleAutoSite 里首句就发，别在这之前 await
  else if (info.menuItemId === AUTO_MENU_ID) void toggleAutoSite(info, tab.id, tab.url);
  else if (info.menuItemId === EXTRACT_PREVIEW_MENU_ID) void toggleExtractPreviewOnTab(tab);
  else if (IH_library.handleClick(info, tab)) return;
});

chrome.permissions.onAdded.addListener(() => {
  void settleAutoSitePending();
  void IH_autoSites.pruneLegacyOriginsIfAllSites();
});
void settleAutoSitePending();

const ERROR_BODY_SNIPPET = 500;

function isJsonContentType(contentTypeHeader) {
  const ct = (contentTypeHeader || '').split(';')[0].trim().toLowerCase();
  return ct === 'application/json' || ct.endsWith('+json');
}

function analyzeRequestBody(model, text) {
  return JSON.stringify({
    model,
    text,
    privacy_mode: true,
    ...(IH_CONFIG.modalDebug ? { modal_debug: true } : {}),
  });
}

/** SW 这次启动后读余额接口的那一次；失败清空，下次再读。 */
let creditSync = null;

/**
 * SW 每次启动读一次余额接口，更新余额和是否限时免费。
 * 余额未知时等它读完，避免零额度用户首段误走付费再 402；读不到仍未知则继续走付费路径。
 */
async function syncCreditState() {
  creditSync ||= readCreditBalance()
    .then((data) => persistCreditBalance(data.credit_balance))
    .catch(() => { creditSync = null; });
  if ((await ensureLastCreditBalance()) == null) await creditSync;
}

/** SYNC: analyzeRun.js / postUsageReport — 用量上报 engine 取值 */
const USAGE_ENGINE_LOCAL = 'local';
const USAGE_ENGINE_CLOUD_FREE = 'cloud-free';
const USAGE_ENGINE_CLOUD_CREDIT = 'cloud-credit';
const USAGE_ENGINE_CLOUD_SELF = 'cloud-self-api';

const USAGE_ENGINES = new Set([
  USAGE_ENGINE_LOCAL,
  USAGE_ENGINE_CLOUD_FREE,
  USAGE_ENGINE_CLOUD_CREDIT,
  USAGE_ENGINE_CLOUD_SELF,
]);

function isUsageEngine(engine) {
  return USAGE_ENGINES.has(engine);
}

/** 已知余额为 0 走免费并在本机排队。余额未知或还有余点直接走付费。路径在发起时定一次。 */
async function postAnalyze(text, model, tabId, waitUi) {
  await IL_ensureApiBaseLoaded();
  await notifyAnalyzeNetworkWait(tabId, waitUi);
  if (!IL_useFacadeV2Analyze()) {
    if (!IL_ANALYZE_API_BASE) {
      throw new Error('Custom cloud API URL is missing or invalid. Open extension settings to fix it.');
    }
    const raw = await postCloudAnalyze('/api/analyze', text, model, false, tabId);
    return { ...raw, usageEngine: USAGE_ENGINE_CLOUD_SELF };
  }
  await syncCreditState();
  const free = (await ensureLastCreditBalance()) === 0;
  if (free) {
    await maybeNotifyFacadePolicyNotice(tabId);
    const raw = await runFreeAnalyze(
      tabId,
      () => postCloudAnalyze('/v2/analyze-free', text, model, false, tabId),
    );
    return { ...raw, usageEngine: USAGE_ENGINE_CLOUD_FREE };
  }
  const paid = await postCloudAnalyze('/v2/analyze', text, model, true, tabId);
  if (!paid?.depleted) return { ...paid, usageEngine: USAGE_ENGINE_CLOUD_CREDIT };
  await persistCreditBalance(Number.isInteger(paid.credit_balance) ? paid.credit_balance : 0);
  const got = await postAnalyze(text, model, tabId, waitUi);
  return { ...got, notice: got.notice || paid.notice };
}

async function postCloudAnalyze(path, text, model, withKey, tabId) {
  await IL_ensureApiBaseLoaded();
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: analyzeRequestBody(model, text),
  };
  let res;
  try {
    // 免费档也带 Bearer（与付费同 key）；门面暂不处理，预留按 key 限流。自定义 /api/analyze 仍不带 key。
    const attachBearer = withKey || path === '/v2/analyze-free';
    res = attachBearer
      ? await fetchWithApiKey(path, init)
      : await fetch(`${IL_ANALYZE_API_BASE}${path}`, init);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(msg)) {
      throw new Error('Cannot reach the analyze server. Try again later.');
    }
    throw err;
  }
  // 门面只在余额不足 1 点时回 402，由 postAnalyze 转免费接口；额度文案也由门面 notice 带来
  if (withKey && res.status === 402) {
    const data = await res.json().catch(() => null);
    const balance = Number.isInteger(data?.credit_balance) ? data.credit_balance : 0;
    if (Number.isInteger(data?.credit_balance) && data.credit_balance >= 0) {
      await persistCreditBalance(data.credit_balance);
    }
    return { depleted: true, notice: pickAnalyzeNotice(data?.notice), credit_balance: balance };
  }
  if (!withKey && res.status === 429) {
    const data = await res.json().catch(() => null);
    const err = new Error(FREE_API_RATE_LIMITED);
    const notice = pickAnalyzeNotice(data?.notice);
    if (notice) err.notice = notice;
    throw err;
  }
  const data = await readAnalyzeResponse(res);
  if (Number.isInteger(data?.credit_balance) && data.credit_balance >= 0) {
    await persistCreditBalance(data.credit_balance);
  }
  return { data, notice: pickAnalyzeNotice(data?.notice), credit_balance: data?.credit_balance };
}

/** 与 page-map analyzeNoticeKey 相同：公告版本 id，文案变则变。 */
function facadeNoticeId(notice) {
  if (!notice || typeof notice.zh !== 'string' || typeof notice.en !== 'string') return '';
  const z = notice.zh.trim();
  const e = notice.en.trim();
  return z || e ? `${z}\n${e}` : '';
}

/** 0 额度走云端免费 API 前：状态条提醒一次当前公告（与选项页 notice 同源，按 id 去重）。 */
async function maybeNotifyFacadePolicyNotice(tabId) {
  if (!tabId || !IL_useFacadeV2Analyze()) return;
  const balance = await ensureLastCreditBalance();
  if (balance !== 0) return;
  const stored = await chrome.storage.local.get([BALANCE_NOTICE_KEY, FACADE_NOTICE_SEEN_ID_KEY]);
  const notice = pickAnalyzeNotice(stored?.[BALANCE_NOTICE_KEY]);
  const id = facadeNoticeId(notice);
  if (!id || stored?.[FACADE_NOTICE_SEEN_ID_KEY] === id) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ih-facade-policy-notice', notice });
  } catch {
    /* 页未注入或已关 */
  }
}

/** 门面分析 notice { zh, en }：格式不对或都空就当没有。插件不自拟文案。 */
function pickAnalyzeNotice(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.zh !== 'string' || typeof value.en !== 'string') return undefined;
  if (!value.zh.trim() && !value.en.trim()) return undefined;
  return { zh: value.zh, en: value.en };
}

/** SYNC: userErrors.js / 用量上报 error。免费接口硬上限 429，不再按 Retry-After 重发。 */
const FREE_API_RATE_LIMITED = 'free api rate limited';

const CREDIT_ORDER_KEY = 'ih_credit_order';
const CREDIT_PAY_URL_KEY = 'ih_credit_pay_url';
const CREDIT_BALANCE_KEY = 'ih_credit_balance';
const BILLING_ENFORCED_KEY = 'ih_billing_enforced';
/** SYNC: page-map.js — 余额接口通用公告；与选项页 #credits_notice 同源 */
const BALANCE_NOTICE_KEY = 'ih_balance_notice';
/** SYNC: page-map.js — 已展示过的公告 id（zh+en 原文），文案变则再弹 */
const FACADE_NOTICE_SEEN_ID_KEY = 'ih_facade_notice_seen_id';

/** @type {number | null} */
let lastCreditBalance = null;

async function ensureLastCreditBalance() {
  if (lastCreditBalance != null) return lastCreditBalance;
  const stored = await chrome.storage.local.get(CREDIT_BALANCE_KEY);
  const b = stored?.[CREDIT_BALANCE_KEY];
  if (Number.isInteger(b) && b >= 0) lastCreditBalance = b;
  return lastCreditBalance;
}

/** 云端已结束限免；余额接口仍带 billing_enforced，插件侧恒为 true。 */
async function readBillingEnforced() {
  return true;
}

async function persistCreditBalance(balance) {
  if (!Number.isInteger(balance) || balance < 0) return;
  lastCreditBalance = balance;
  await chrome.storage.local.set({ [CREDIT_BALANCE_KEY]: balance });
}

const CREDIT_ORDER_RE = /^ih[0-9a-f]{32}$/;

function normalizeCreditOrderAmountKind(raw) {
  if (raw === 'custom' || raw === 'trial' || raw === 'promo') return raw;
  return 'pack';
}

const PROMO_LABEL_MAX_LEN = 32;

function readPromoLabel(raw, amountKind) {
  if (normalizeCreditOrderAmountKind(amountKind) !== 'promo') return undefined;
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().replace(/\s+/g, ' ');
  if (!t || t.length > PROMO_LABEL_MAX_LEN || /[\x00-\x1f\x7f]/.test(t)) return undefined;
  return t;
}

function readCreditOrders(value) {
  if (!Array.isArray(value) || value.length > 3) return null;
  const orders = [];
  for (const row of value) {
    const orderId = row?.order_id;
    const credits = row?.order_credits;
    const amount = row?.amount;
    const status = row?.payment_status;
    const refunded = row?.refunded_cents;
    const createdAt = row?.created_at;
    const currency = row?.currency;
    const paymentProvider = row?.payment_provider;
    if (typeof orderId !== 'string' || !CREDIT_ORDER_RE.test(orderId)) return null;
    if (!Number.isInteger(credits) || credits <= 0) return null;
    if (typeof amount !== 'string' || !/^\d+\.\d{2}$/.test(amount)) return null;
    if (status !== 'pending' && status !== 'paid') return null;
    if (!Number.isSafeInteger(refunded) || refunded < 0) return null;
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;
    const amountKind = normalizeCreditOrderAmountKind(row?.amount_kind);
    const promoLabel = readPromoLabel(row?.promo_label, amountKind);
    const entry = {
      order_id: orderId,
      order_credits: credits,
      amount,
      currency: currency === 'USD' ? 'USD' : 'CNY',
      payment_provider: paymentProvider === 'waffo' || paymentProvider === 'waffo_cny' ? paymentProvider : 'alipay',
      payment_status: status,
      refunded_cents: refunded,
      created_at: createdAt,
      amount_kind: amountKind,
    };
    if (promoLabel) entry.promo_label = promoLabel;
    orders.push(entry);
  }
  return orders;
}

async function readCreditCatalog() {
  const res = await fetchWithApiKey('/v2/credits/catalog?catalog=2', { method: 'GET' });
  const data = await res.json().catch(() => null);
  const CNY = data?.CNY;
  const USD = data?.USD;
  if (!res.ok || !Array.isArray(CNY) || !Array.isArray(USD) || (!CNY.length && !USD.length)) {
    throw new Error('Could not start payment.');
  }
  return { CNY, USD };
}

/** @param {string} [apiKey] 不给则用本机 key */
async function readCreditBalance(apiKey) {
  const res = await fetchWithApiKey('/v2/credits/balance', { method: 'GET' }, apiKey);
  const data = await res.json().catch(() => null);
  const balance = data?.credit_balance;
  const orders = readCreditOrders(data?.orders);
  const billingEnforced = data?.billing_enforced;
  // 门面公告，可选：{ zh, en } 纯文本
  // 公告格式不对就当没有，不影响额度显示
  const notice = typeof data?.notice?.zh === 'string' && typeof data?.notice?.en === 'string' ? data.notice : undefined;
  if (!res.ok || !Number.isInteger(balance) || balance < 0 || !orders || billingEnforced !== true) {
    throw new Error('Failed to read credits');
  }
  await chrome.storage.local.set({ [BILLING_ENFORCED_KEY]: true });
  if (notice) await chrome.storage.local.set({ [BALANCE_NOTICE_KEY]: notice });
  else await chrome.storage.local.remove(BALANCE_NOTICE_KEY);
  return { credit_balance: balance, orders, billing_enforced: true, ...(notice ? { notice } : {}) };
}

async function storedCreditOrder() {
  const stored = await chrome.storage.local.get(CREDIT_ORDER_KEY);
  const orderId = stored?.[CREDIT_ORDER_KEY];
  return typeof orderId === 'string' && CREDIT_ORDER_RE.test(orderId) ? orderId : null;
}

async function readStoredCreditPay() {
  const stored = await chrome.storage.local.get([CREDIT_ORDER_KEY, CREDIT_PAY_URL_KEY]);
  const orderId = stored?.[CREDIT_ORDER_KEY];
  const payUrl = readHttpsPayUrl(stored?.[CREDIT_PAY_URL_KEY]);
  if (!CREDIT_ORDER_RE.test(orderId) || !payUrl) return null;
  return { order_id: orderId, pay_url: payUrl };
}

function readHttpsPayUrl(payUrl) {
  try {
    const url = new URL(payUrl);
    if (url.protocol === 'https:') return url.href;
  } catch {
    /* ignore */
  }
  return '';
}

async function startCreditPurchase(provider, pack, amountUsd) {
  const body = { provider };
  if (typeof pack === 'string' && pack) body.pack = pack;
  if (typeof amountUsd === 'string' && amountUsd.trim()) body.amount_usd = amountUsd.trim();
  const res = await fetchWithApiKey('/v2/credits/purchase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  const href = readHttpsPayUrl(data?.pay_url);
  const orderId = typeof data?.order_id === 'string' ? data.order_id : '';
  if (!res.ok || !href || !CREDIT_ORDER_RE.test(orderId)) throw new Error('Could not start payment.');
  await chrome.storage.local.set({ [CREDIT_ORDER_KEY]: orderId, [CREDIT_PAY_URL_KEY]: href });
  return href;
}

async function confirmCreditPurchase(orderId) {
  if (!CREDIT_ORDER_RE.test(orderId)) throw new Error('Could not confirm payment.');
  const res = await fetchWithApiKey('/v2/credits/purchase/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: orderId }),
  });
  const data = await res.json().catch(() => null);
  const balance = data?.credit_balance;
  const status = data?.payment_status;
  if (!res.ok || !Number.isInteger(balance) || balance < 0 || (status !== 'paid' && status !== 'pending')) {
    throw new Error('Could not confirm payment.');
  }
  if (status === 'paid' && (await storedCreditOrder()) === orderId) {
    await chrome.storage.local.remove([CREDIT_ORDER_KEY, CREDIT_PAY_URL_KEY]);
  }
  await persistCreditBalance(balance);
  return { credit_balance: balance, payment_status: status };
}

async function refreshCreditState() {
  const orderId = await storedCreditOrder();
  let confirmFailed = false;
  if (orderId) {
    try {
      await confirmCreditPurchase(orderId);
    } catch (err) {
      // 查单失败不挡住读余额，交给选项页在那一行显示
      console.error('[Info Highlight] confirm credit order', err);
      confirmFailed = true;
    }
  }
  const state = await readCreditState();
  return confirmFailed ? { ...state, confirm_failed_order: orderId } : state;
}

async function readCreditState() {
  const data = await readCreditBalance();
  await persistCreditBalance(data.credit_balance);
  const api_key = await IL_getApiKey();
  const credit_pay = await readStoredCreditPay();
  return { ...data, api_key, credit_pay };
}

async function readAnalyzeResponse(res) {
  const raw = await res.text();
  const ctHeader = res.headers.get('Content-Type') || '';
  const ct = ctHeader.split(';')[0].trim().toLowerCase() || '(none)';
  const snippet = raw.length <= ERROR_BODY_SNIPPET ? raw : raw.slice(0, ERROR_BODY_SNIPPET - 1) + '…';

  if (!raw.trim()) {
    throw new Error(`HTTP ${res.status}: empty response`);
  }
  if (!isJsonContentType(ctHeader)) {
    throw new Error(`HTTP ${res.status}: expected application/json, got ${ct}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    const why = e && e.message ? String(e.message) : 'parse failed';
    throw new Error(`HTTP ${res.status}: malformed JSON (${why}): ${snippet}`);
  }

  if (data?.success === false) {
    throw new Error(data.message || data.detail || `HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(data?.message || `HTTP ${res.status}`);
  }
  return data;
}

/** 并发 createDocument 共用这一次 load；完成初次 page load 后才 settle。 */
let creating = null;

async function ensureOffscreen() {
  while (creating) await creating;
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen
    .createDocument({
      url: 'local/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run the local WebGPU language model for Info Highlight',
    })
    .catch((err) => {
      const msg = String(err?.message || err);
      if (/already exists|Only a single offscreen/i.test(msg)) return;
      throw err;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

let localInflight = 0;

/** 已发出、还没进藏页的本机分析。一个标签最多一条。免费云端另有一条队列。 */
function pickLocalWaiter(waiters, activeTabId) {
  const i = waiters.findIndex((w) => activeTabId != null && w.tabId === activeTabId);
  return i >= 0 ? i : 0;
}

function focusedTabId() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(
    (tabs) => (tabs && tabs[0] ? tabs[0].id : null),
    () => null,
  );
}

/**
 * 同时只放行一条，已在等的激活标签优先。
 * 前台要等上一段回到页面才发下一段，空档里后台最多插进一段，所以前台至少大约一半。
 */
function createAnalyzeAdmit() {
  const waiters = [];
  let draining = false;

  function run(tabId, job) {
    return new Promise((resolve, reject) => {
      waiters.push({ tabId, run: job, resolve, reject });
      void drain();
    });
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (waiters.length) {
        const activeId = await focusedTabId();
        const job = waiters.splice(pickLocalWaiter(waiters, activeId), 1)[0];
        try {
          job.resolve(await job.run());
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      draining = false;
      if (waiters.length) void drain();
    }
  }

  return run;
}

const admitLocalAnalyze = createAnalyzeAdmit();
const admitFreeAnalyze = createAnalyzeAdmit();

function runLocalAnalyze(tabId, run) {
  return admitLocalAnalyze(tabId, run);
}

function runFreeAnalyze(tabId, run) {
  return admitFreeAnalyze(tabId, run);
}

function isOffscreenGone(err) {
  const msg = String(err?.message || err);
  return /Receiving end does not exist|Could not establish connection|The message port closed|no current offscreen/i.test(msg);
}

async function sendToEngine(payload) {
  const send = async () => {
    await ensureOffscreen();
    return chrome.runtime.sendMessage({ type: 'ih-local-engine', ...payload });
  };
  try {
    const res = await send();
    if (res != null) return res;
  } catch (err) {
    if (!isOffscreenGone(err)) throw err;
  }
  try {
    await destroyOffscreen();
  } catch (err) {
    if (!isOffscreenGone(err)) throw err;
  }
  const res = await send();
  if (res == null) throw new Error('local engine not ready');
  return res;
}

async function hasOffscreen() {
  return !!(chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument()));
}

function idleBlockReason() {
  if (localInflight > 0) return 'inflight';
  if (initBusy) return 'init';
  if (offerLock) return 'offer';
  return 'none';
}

async function destroyOffscreen() {
  if (creating) await creating;
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument();
  }
}

async function closeOffscreenIfIdle() {
  if (creating) await creating;
  if (idleBlockReason() !== 'none') return;
  await destroyOffscreen();
}

function statusSpec(st) {
  return IH_localState.localSpec(IH_localState.onDeviceStatusModelId(st.choice, st.runtime));
}

async function dropLocalModel(all = false, explicitLocalId) {
  await destroyOffscreen();
  if (all) {
    await IH_localState.dropModelCache();
    await IH_localState.set({ readyIds: [] });
  } else {
    const st = await IH_localState.get();
    const id = IH_localState.normalizeLocalId(explicitLocalId) || statusSpec(st).id;
    await IH_localState.dropModelCache(id);
    await IH_localState.markReady(id, false);
  }
  await IH_analyzeCache.dropAll();
}

/** 只打断还在下载的初始化；已经 init 成功则忽略。半成品留在 Cache。 */
async function cancelLocalInit() {
  if (!initCancellable) return;
  initCancellable = false;
  initGeneration += 1;
  initBusy = false;
  await destroyOffscreen();
}

async function probeAndStore() {
  const { WEBGPU_BLOCK } = IH_localState;
  let result;
  if (globalThis.navigator?.gpu == null) {
    const res = await sendToEngine({ cmd: 'probe' });
    if (!res?.ok) throw new Error(res?.error || 'WebGPU probe failed');
    result = {
      ok: !!res.webgpu,
      reason: res.webgpu ? null : (res.reason || WEBGPU_BLOCK.device_failed),
    };
  } else {
    result = await IH_localState.probeWebGPU();
  }
  return IH_localState.applyWebgpuProbe(result);
}

/** @type {((engine: string) => void)[]} */
let initWaiters = [];
let initGeneration = 0;
let offerLock = null;
let initBusy = false;
let initCancellable = false;

/** Prepare 开着时通知选项页：暂停「新选项」看见计时 */
function notifyOptionsInitOverlay(active) {
  chrome.runtime.sendMessage({ type: 'ih-local-init-overlay', active: !!active }, () => {
    void chrome.runtime.lastError;
  });
}

function clearInitWindowId() {
  releaseHostPopup(initPopup);
}

function assignInitWindowId(id, hostId) {
  initPopup.id = id;
  initPopup.host = hostId ?? null;
  notifyOptionsInitOverlay(true);
}

function resolveInitWaiters(engine) {
  const waiters = initWaiters;
  initWaiters = [];
  for (const w of waiters) w(engine);
}

async function resolveInitWithoutReady() {
  initGeneration += 1;
  resolveInitWaiters(engineFrom(await IH_localState.get()));
}

async function refuseLocal() {
  initGeneration += 1;
  resolveInitWaiters('local');
}

async function abandonInitWindow() {
  const id = initPopup.id;
  clearInitWindowId();
  if (id == null) return;
  try {
    await chrome.windows.remove(id);
  } catch {
    /* already gone */
  }
}

async function createInitPopupWindow(create, hostId) {
  const win = await chrome.windows.create(create);
  if (win?.id == null) throw new Error('Init window create returned no id');
  assignInitWindowId(win.id, hostId);
  if (create.left == null || create.top == null) return initPopup.id;
  try {
    await chrome.windows.update(win.id, { left: create.left, top: create.top, focused: true });
  } catch (err) {
    if (!IH_initWindowBounds.isBoundsError(err)) throw err;
    try {
      await chrome.windows.update(win.id, { focused: true });
    } catch (err2) {
      if (!IH_initWindowBounds.isBoundsError(err2)) throw err2;
    }
  }
  return initPopup.id;
}

async function openInitWindow() {
  if (initPopup.id != null) {
    try {
      await chrome.windows.update(initPopup.id, { focused: true });
      notifyOptionsInitOverlay(true);
      return initPopup.id;
    } catch {
      clearInitWindowId();
    }
  }
  const width = 540;
  const height = 420;
  /** @type {chrome.windows.CreateData} */
  const create = {
    url: chrome.runtime.getURL('local/init.html'),
    type: 'popup',
    width,
    height,
    focused: true,
  };
  /** @type {number | null} */
  let hostId = null;
  try {
    const host = await chrome.windows.getLastFocused();
    hostId = host?.id ?? null;
    const pos = IH_initWindowBounds.clampPopupToHost(host, width, height);
    if (pos) {
      create.left = pos.left;
      create.top = pos.top;
    }
  } catch {
    /* 没有宿主窗口时让浏览器自己放 */
  }
  try {
    return await createInitPopupWindow(create, hostId);
  } catch (err) {
    const canRetryWithoutPos =
      IH_initWindowBounds.isBoundsError(err) && create.left != null && create.top != null;
    await abandonInitWindow();
    if (!canRetryWithoutPos) throw err;
    delete create.left;
    delete create.top;
    try {
      return await createInitPopupWindow(create, hostId);
    } catch (err2) {
      await abandonInitWindow();
      throw err2;
    }
  }
}

async function openInitAndWait() {
  const windowId = await openInitWindow();
  return new Promise((resolve) => {
    initWaiters.push(resolve);
    function onRemoved(id) {
      if (id !== windowId) return;
      chrome.windows.onRemoved.removeListener(onRemoved);
      clearInitWindowId();
      void (async () => {
        const st = await IH_localState.get();
        // 下载中关掉（Hide）继续后台；已就绪则只关窗。
        // 选了本机：关窗等同拒绝，这次分析不再等。
        const localId = IH_localState.onDeviceStatusModelId(st.choice, st.runtime);
        if (st.readyIds.includes(localId) || initBusy) return;
        if (initWaiters.length === 0) return;
        if (IH_localState.choiceById(st.choice).local) {
          await refuseLocal();
          return;
        }
        await resolveInitWithoutReady();
      })();
    }
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

async function maybeOfferInitOnce(prepare = false) {
  const st = await IH_localState.get();
  const localId = prepare
    ? IH_localState.localRuntimeModelId(st.runtime)
    : IH_localState.onDeviceStatusModelId(st.choice, st.runtime);
  if (st.readyIds.includes(localId)) return;
  if (st.webgpuOk === false) return;
  let webgpu;
  try {
    webgpu = await probeAndStore();
  } catch (err) {
    console.warn('[Info Highlight] WebGPU probe failed', err);
    await IH_localState.set({
      webgpuOk: false,
      webgpuBlockReason: IH_localState.WEBGPU_BLOCK.probe_failed,
    });
    return;
  }
  if (!webgpu) return;
  try {
    await openInitAndWait();
  } catch (err) {
    if (IH_initWindowBounds.isBoundsError(err)) {
      console.warn('[Info Highlight] Init popup bounds rejected; skip offering', err);
      return;
    }
    throw err;
  }
}

/** prepare：选项页点 Prepare。否则只有选了本机且权重未就绪才问。 */
async function maybeOfferInit(prepare = false) {
  if (!prepare) {
    const st = await IH_localState.get();
    if (!IH_localState.choiceById(st.choice).local) return;
  }
  if (!offerLock) {
    offerLock = maybeOfferInitOnce(prepare).finally(async () => {
      offerLock = null;
      const st = await IH_localState.get();
      const localId = IH_localState.onDeviceStatusModelId(st.choice, st.runtime);
      if (!st.readyIds.includes(localId)) await closeOffscreenIfIdle();
    });
  }
  return offerLock;
}

function engineFrom(st) {
  return IH_localState.choiceById(st.choice).local ? 'local' : 'cloud';
}

const choiceReady = IH_localState.migrate().then((dropCache) => {
  if (dropCache) return IH_analyzeCache.dropAll();
});

/**
 * @returns {Promise<{ tokens: unknown[], model: string, engine: 'local' | 'cloud' }>}
 */
/** @typedef {{ waitGen: number, armCloudWait: boolean }} AnalyzeWaitUi */

async function notifyAnalyzeNetworkWait(tabId, waitUi) {
  if (!waitUi || !Number.isInteger(tabId) || tabId < 0) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'ih-analyze-network-wait',
      waitGen: waitUi.waitGen,
      armCloudWait: !!waitUi.armCloudWait,
    });
  } catch {
    /* 页已关或未注入 */
  }
}

async function fetchTokensForChoice(st, forceCloud, text, tabId, cloudModel, waitUi) {
  const selected = IH_localState.choiceById(st.choice);
  await IL_ensureApiBaseLoaded();
  // 右键钉的模型优先；其次自定义服务上选的（如本机 LM Studio / Ollama 的）；再次选项里的云端模型
  const model = cloudModel || IL_customApiModel() || selected.cloudModel;
  const useLocal = !forceCloud && selected.local;
  const got = await fetchTokens(useLocal ? USAGE_ENGINE_LOCAL : 'cloud', text, model, tabId, waitUi);
  return { ...got, engine: got.usageEngine || USAGE_ENGINE_LOCAL };
}

async function initEngine() {
  const st = await IH_localState.get();
  const spec = statusSpec(st);
  return sendToEngine({
    cmd: 'init',
    hub: st.hub,
    localId: spec.id,
    hubId: IH_localState.hubRepoId(st.hub, spec),
    dtype: spec.dtype,
    family: spec.family,
  });
}

/** 选项页在开着时会实时收 ih-local-progress；这段静默重载完了也要报一声，否则页面卡在「正在下载」。 */
function notifyInitOutcome(outcome) {
  chrome.runtime.sendMessage({ type: 'ih-local-init-outcome', outcome }).catch(() => {});
}

async function fetchTokens(engine, text, cloudModel, tabId, waitUi) {
  if (engine === USAGE_ENGINE_LOCAL) {
    await notifyAnalyzeNetworkWait(tabId, waitUi);
    localInflight += 1;
    try {
      const st = await IH_localState.get();
      const spec = statusSpec(st);
      const status = await sendToEngine({ cmd: 'status' });
      if (!status?.ok) throw new Error(status?.error || 'local engine status failed');
      if (!status.loaded || status.localId !== spec.id) {
        let loaded;
        try {
          loaded = await initEngine();
        } finally {
          notifyInitOutcome(loaded?.ok ? 'ok' : 'failed');
        }
        if (!loaded?.ok) throw new Error(loaded?.error || 'local model reload failed');
      }
      const res = await runLocalAnalyze(tabId, () => sendToEngine({ cmd: 'analyze', text }));
      if (!res?.ok) throw new Error(res?.error || 'local analyze failed');
      if (globalThis.IH_CONFIG?.localModelDebug && res.result?.metrics) {
        console.info('[IH local analyze]', res.result.metrics);
      }
      const tokens = res.result?.bpe_strings;
      if (!Array.isArray(tokens)) throw new Error('local analyze returned no tokens');
      const device = typeof res.result?.device === 'string' ? res.result.device.trim() : '';
      return { tokens, model: spec.id, device };
    } finally {
      localInflight -= 1;
    }
  }
  const { data, notice, credit_balance, usageEngine } = await postAnalyze(text, cloudModel, tabId, waitUi);
  const tokens = data?.result?.bpe_strings;
  if (!Array.isArray(tokens)) throw new Error('Analyze returned no tokens');
  const raw = data?.result?.model;
  const model = typeof raw === 'string' && raw.trim() ? raw.trim() : cloudModel;
  const device = typeof data?.result?.device === 'string' ? data.result.device.trim() : '';
  return { tokens, model, device, notice, credit_balance, usageEngine };
}

async function handleAnalyze(text, skipCache, forceCloud, tabId, cloudModel, waitUi) {
  await choiceReady;
  const pinned = knownCloudModel(cloudModel);
  if (pinned) forceCloud = true;
  if (!forceCloud) await maybeOfferInit();
  const st = await IH_localState.get();
  const selected = IH_localState.choiceById(st.choice);
  if (!forceCloud) {
    const blocked = IH_userErrors.localOnlyBlock(st);
    if (blocked) throw new Error(blocked);
  }
  let engine = forceCloud || !selected.local ? USAGE_ENGINE_CLOUD_CREDIT : USAGE_ENGINE_LOCAL;
  let inferred = false;
  let model = engine === USAGE_ENGINE_LOCAL
    ? statusSpec(st).id
    : (pinned || selected.cloudModel);
  let device = '';
  let tokens;
  let notice;
  let credit_balance;
  try {
    tokens = await IH_analyzeCache.tokens(text, async () => {
      inferred = true;
      const got = await fetchTokensForChoice(st, forceCloud, text, tabId, pinned, waitUi);
      if (got.model) model = got.model;
      if (got.device) device = got.device;
      engine = got.engine;
      if (got.notice) ({ notice, credit_balance } = got);
      return got.tokens;
    }, { skip: !!skipCache || !!pinned });
  } catch (err) {
    if (!forceCloud && selected.local) {
      if (IH_userErrors.isGpuRelated(err?.message || err)) {
        await IH_localState.set({
          webgpuOk: false,
          webgpuBlockReason: IH_localState.WEBGPU_BLOCK.runtime_failed,
        });
      }
      throw new Error(IH_userErrors.localOnlyFailure(err));
    }
    throw err;
  }
  return {
    data: {
      request: { text },
      result: {
        model,
        bpe_strings: tokens,
        ...(device ? { device } : {}),
      },
    },
    inferred,
    engine,
    notice,
    credit_balance,
  };
}

/** 防止异常时钟或挂死上报炸开；约 24h。与 local-init duration 同档。 */
const MAX_DURATION_MS = 86_400_000;

function clampDurationMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), MAX_DURATION_MS);
}

/** 阶段性调试：分析结束闲置超时后 offscreen 仍在（可随门面通道一起删除）。 */
async function postLocalEngineLinger(payload) {
  const body = {
    extension: EXTENSION_ID,
    version: chrome.runtime.getManifest().version,
    event: 'unload_linger',
    loaded: !!payload.loaded,
    wait_ms: clampDurationMs(payload.wait_ms),
    blocked: payload.blocked === 'inflight' || payload.blocked === 'init' || payload.blocked === 'offer'
      ? payload.blocked
      : 'none',
  };
  const heap = Number(payload.js_heap_bytes);
  if (Number.isFinite(heap) && heap >= 0) body.js_heap_bytes = Math.round(heap);
  const client_id = await IL_getClientId().catch(() => null);
  if (client_id) body.client_id = client_id;
  IL_postKeepalive('/api/extension-local-engine', body);
}

/**
 * 上一段结束后闲置达到选项中的超时：关藏页。正在推理/初始化/offer 则上报后不动。
 */
async function handleLinger(msg) {
  if (!(await hasOffscreen())) return;
  const blocked = idleBlockReason();
  void postLocalEngineLinger({
    loaded: msg?.loaded,
    js_heap_bytes: msg?.js_heap_bytes,
    wait_ms: msg?.wait_ms,
    blocked,
  });
  if (blocked !== 'none') return;
  await destroyOffscreen();
}

/** 上次已随用量上报的选项快照。没有这份键时，下一次分析会带上当前选项。 */
const OPTIONS_REPORTED_KEY = 'ih_options_reported';

function canonOptions(snap) {
  return JSON.stringify(Object.keys(snap).sort().map((k) => [k, snap[k]]));
}

/** 选项页上的选择，外加本机 WebGPU 探测。自动高亮站点只记条数。 */
async function readOptionsSnapshot() {
  const HS = IH_highlightStyle;
  const [raw, st, sites] = await Promise.all([
    chrome.storage.local.get(IH_optionDefaults),
    IH_localState.get(),
    IH_autoSites.list(),
  ]);
  const prefs = HS.normalizePrefs(raw);
  const webgpu = st.webgpuOk;
  return {
    ih_article_only: IH_optionStored('ih_article_only', raw.ih_article_only),
    ih_dynamic_track: IH_optionStored('ih_dynamic_track', raw.ih_dynamic_track),
    ih_from_viewport: IH_optionStored('ih_from_viewport', raw.ih_from_viewport),
    show_progress: IH_optionStored('show_progress', raw.show_progress),
    show_token_tip: IH_optionStored('show_token_tip', raw.show_token_tip),
    ih_word_merge: IH_optionStored('ih_word_merge', raw.ih_word_merge),
    ih_library_close_tab: IH_optionStored('ih_library_close_tab', raw.ih_library_close_tab),
    ih_paint_style: prefs.paintStyle,
    ih_highlight_color: prefs.highlightColor,
    ih_text_color: prefs.textColor,
    ih_max_highlight_alpha: prefs.maxAlphaDepth,
    ih_fade_min_pct: prefs.fadeMinPct,
    ih_fade_norm: prefs.fadeNorm,
    ih_fade_norm_pct: prefs.fadeNormPct,
    ih_two_tier: prefs.twoTier,
    ih_highlight_threshold_pct: prefs.thresholdPct,
    [IH_localState.KEYS.choice]: st.choice,
    ih_model_hub: st.hub,
    ih_webgpu_ok: webgpu === true ? true : webgpu === false ? false : null,
    ih_local_ready: st.ready,
    auto_sites: sites.length,
  };
}

/** 与上次已报快照不同才返回；相同则 null。 */
async function changedOptionsSnapshot() {
  const snap = await readOptionsSnapshot();
  const prev = await chrome.storage.local.get(OPTIONS_REPORTED_KEY);
  const old = prev[OPTIONS_REPORTED_KEY];
  if (old && typeof old === 'object' && !Array.isArray(old) && canonOptions(old) === canonOptions(snap)) {
    return null;
  }
  return snap;
}

async function postUsageReport(body) {
  const engine = isUsageEngine(body?.engine) ? body.engine : null;
  const outcome = body?.outcome;
  if (outcome !== 'ok' && outcome !== 'failed' && outcome !== 'cancelled') return;
  const segments = Math.max(0, Math.min(512, Number(body?.segments) || 0));
  const segments_ok = Math.max(0, Math.min(segments, Number(body?.segments_ok) || 0));
  const cached = Math.max(0, Math.min(segments, Number(body?.cached) || 0));
  const duration_ms = clampDurationMs(body?.duration_ms);
  const client_id = await IL_getClientId().catch(() => null);
  const model = typeof body?.model === 'string' ? body.model.trim().slice(0, 64) : '';
  const trigger = typeof body?.trigger === 'string' && body.trigger.trim()
    ? body.trigger.trim()
    : 'other';
  const payload = {
    extension: EXTENSION_ID,
    version: chrome.runtime.getManifest().version,
    outcome,
    trigger,
    segments,
    segments_ok,
    cached,
    duration_ms,
  };
  if (engine) payload.engine = engine;
  if (model) payload.model = model;
  if (client_id) payload.client_id = client_id;
  if (outcome === 'failed') {
    const err = String(body?.error || body?.message || '').slice(0, 500);
    if (err) payload.error = err;
    const detail = body?.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) payload.detail = detail;
  }
  const options = await changedOptionsSnapshot();
  if (options) payload.options = options;
  IL_postKeepalive('/api/extension-usage', payload);
  if (options) await chrome.storage.local.set({ [OPTIONS_REPORTED_KEY]: options });
}

async function postEngagementNudgeReport(msg) {
  const allowed = new Set(['later', 'feedback', 'review', 'dont_show_again']);
  const action = typeof msg?.action === 'string' ? msg.action.trim() : '';
  if (!allowed.has(action)) return;
  const body = {
    event: 'engagement_nudge',
    extension: EXTENSION_ID,
    version: chrome.runtime.getManifest().version,
    action,
    success_total: Math.max(0, Math.floor(Number(msg?.success_total) || 0)),
    prompt_index: Math.max(0, Math.floor(Number(msg?.prompt_index) || 0)),
  };
  const client_id = await IL_getClientId().catch(() => null);
  if (client_id) body.client_id = client_id;
  IL_postKeepalive('/api/extension-usage', body);
}

/** 选项页点「购买额度」：经用量通道报一次，带 client_id 和当时是否限时免费（没读到过为 null）。 */
async function postCreditsAddClick() {
  const body = {
    extension: EXTENSION_ID,
    version: chrome.runtime.getManifest().version,
    event: 'credits_add_click',
    billing_enforced: await readBillingEnforced(),
  };
  const client_id = await IL_getClientId().catch(() => null);
  if (client_id) body.client_id = client_id;
  IL_postKeepalive('/api/extension-usage', body);
}

/** 匿名网站域名。触发方式与用量上报相同；不带 client_id、路径和正文。 */
function postAnonymousSiteDomain(body) {
  if (IH_CONFIG.skipAnonymousSiteDomain) return;
  const outcome = body?.outcome;
  if (outcome !== 'ok' && outcome !== 'failed' && outcome !== 'cancelled' && outcome !== 'empty') return;
  const trigger = typeof body?.trigger === 'string' && body.trigger.trim()
    ? body.trigger.trim()
    : 'other';
  const host = typeof body?.host === 'string' ? body.host.trim().toLowerCase() : '';
  const kind = typeof body?.kind === 'string' ? body.kind.trim() : '';
  const kinds = new Set(['html', 'pdf', 'txt', 'md', 'other']);
  IL_postKeepalive('/api/anonymous-site-domain', {
    host: host && host.length <= 253 && !/[/?#@\s]/.test(host) ? host : 'unknown',
    chars: Math.max(0, Math.round(Number(body?.chars) || 0)),
    blocks: Math.max(0, Math.round(Number(body?.blocks) || 0)),
    outcome,
    kind: kinds.has(kind) ? kind : 'other',
    trigger,
    version: chrome.runtime.getManifest().version,
  });
}

/** 入口拦住、尚未抽出正文：仍走上面那条上报。 */
async function postAnonymousSiteDomainForTab(tabId, trigger) {
  let href = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    href = typeof tab?.url === 'string' ? tab.url : '';
  } catch {
    /* 标签可能已关 */
  }
  const classify = globalThis.IH_anonymousSiteDomain;
  if (!classify?.blockedAttempt) return;
  postAnonymousSiteDomain(classify.blockedAttempt(href, trigger));
}

async function postLocalInitReport({ outcome, duration_ms, error }) {
  if (outcome !== 'ok' && outcome !== 'failed' && outcome !== 'cancelled') return;
  const st = await IH_localState.get();
  const hub =
    st.hub === IH_localState.HUB_HUGGINGFACE || st.hub === IH_localState.HUB_MODELSCOPE
      ? st.hub
      : null;
  const body = {
    extension: EXTENSION_ID,
    version: chrome.runtime.getManifest().version,
    outcome,
    duration_ms: Math.max(0, Math.round(Number(duration_ms) || 0)),
    hub,
    model: IH_localState.hubRepoId(st.hub, statusSpec(st)),
  };
  if (outcome !== 'ok' && error) body.error = String(error).slice(0, 500);
  const client_id = await IL_getClientId().catch(() => null);
  if (client_id) body.client_id = client_id;
  IL_postKeepalive('/api/extension-local-init', body);
}

async function handleAgree() {
  await choiceReady;
  const gen = initGeneration;
  const t0 = Date.now();
  let outcome = 'ok';
  let error = null;
  const assertNotCancelled = () => {
    if (gen !== initGeneration) throw new Error('Cancelled');
  };
  initCancellable = true;
  try {
    assertNotCancelled();
    const webgpu = await probeAndStore();
    assertNotCancelled();
    if (!webgpu) throw new Error(IH_userErrors.gpuUnavailableShort());
    const res = await initEngine();
    initCancellable = false;
    if (!res?.ok) throw new Error(res?.error || 'local model init failed');
    if (globalThis.IH_CONFIG?.localModelDebug && res.metrics) {
      console.info('[IH local init]', res.metrics);
    }
    const st = await IH_localState.get();
    await IH_localState.markReady(statusSpec(st).id, true);
    resolveInitWaiters(engineFrom(st));
  } catch (err) {
    const cancelled = gen !== initGeneration || String(err?.message || err) === 'Cancelled';
    outcome = cancelled ? 'cancelled' : 'failed';
    error = cancelled ? 'Cancelled' : String(err?.message || err);
    throw cancelled ? new Error('Cancelled') : err;
  } finally {
    initCancellable = false;
    initBusy = false;
    void postLocalInitReport({ outcome, duration_ms: Date.now() - t0, error });
    notifyInitOutcome(outcome);
  }
}

async function handleStatus() {
  await choiceReady;
  try {
    await probeAndStore();
  } catch {
    await IH_localState.set({
      webgpuOk: false,
      webgpuBlockReason: IH_localState.WEBGPU_BLOCK.probe_failed,
    });
    await closeOffscreenIfIdle();
    return IH_localState.get();
  }
  try {
    const status = await sendToEngine({ cmd: 'status' });
    if (!status?.loaded) await closeOffscreenIfIdle();
  } catch {
    await closeOffscreenIfIdle();
  }
  return IH_localState.get();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (IL_pdfSw.handleMessage(msg, sender, sendResponse)) return true;
  if (IH_library.handleRuntimeMessage(msg, sender, sendResponse)) return true;
  if (
    msg?.type === 'ih-local-engine'
    || msg?.type === 'ih-local-progress'
    || msg?.type === 'ih-local-init-outcome'
  ) return;

  if (msg?.type === 'ih-action-state') {
    const tabId = sender.tab?.id;
    if (tabId && (msg.state === 'off' || msg.state === 'analyzing' || msg.state === 'on')) {
      IH_actionState.set(tabId, msg.state, msg.filled);
      clearBadge(tabId);
    }
    return;
  }

  if (msg?.type === 'ih-open-auto-nudge') {
    const host = IH_autoSites.parseHost(msg.host || '');
    if (host && !host.includes('*')) {
      void openNudgeWindow(host, sender.tab?.windowId).finally(() => sendResponse());
      return true;
    }
    return;
  }

  if (msg?.type === 'ih-open-welcome') {
    openWelcomeWindow(sender.tab?.windowId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-local-linger') {
    handleLinger(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-local-status') {
    handleStatus()
      .then((data) => sendResponse({ ok: true, ...data, initOverlay: initPopup.id != null }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-set-choice') {
    let choice;
    try {
      choice = IH_localState.choiceById(msg.id);
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
      return;
    }
    (async () => {
      await choiceReady;
      if (choice.local) {
        const webgpu = await probeAndStore();
        if (!webgpu) throw new Error(IH_userErrors.setLocalPrefBlocked());
      }
      const prev = await IH_localState.get();
      await IH_localState.set({ choice: choice.id });
      if (prev.choice !== choice.id) {
        await IH_analyzeCache.dropAll();
        await destroyOffscreen();
      }
      if (choice.local) await maybeOfferInit();
      sendResponse({ ok: true, id: choice.id });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-set-hub') {
    const hub = IH_localState.normalizeHub(msg.hub);
    (async () => {
      const st = await IH_localState.get();
      if (st.hub !== hub) {
        await dropLocalModel(true);
        await IH_localState.set({ hub });
      }
      sendResponse({ ok: true, hub });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-open-init') {
    (async () => {
      const localId = IH_localState.normalizeLocalId(msg.localId);
      if (localId) {
        const st = await IH_localState.get();
        if (st.runtime !== localId) {
          await IH_localState.set({ runtime: localId });
          await destroyOffscreen();
        }
      }
      await maybeOfferInit(true);
      sendResponse({ ok: true });
    })().catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-agree') {
    initBusy = true;
    handleAgree()
      .then(() => sendResponse({ ok: true }))
      .catch(async (err) => {
        const cancelled = String(err?.message || err) === 'Cancelled';
        if (!cancelled) {
          try {
            await resolveInitWithoutReady();
          } catch {
            resolveInitWaiters('cloud');
          }
        }
        sendResponse({ ok: false, cancelled, error: String(err?.message || err) });
      });
    return true;
  }
  if (msg?.type === 'ih-local-cancel-init') {
    cancelLocalInit()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === 'ih-local-drop-model') {
    dropLocalModel(false, msg.localId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-open-highlight-options') {
    const raw = typeof msg.section === 'string' ? msg.section.replace(/^#/, '').trim() : 'highlight';
    const section = OPTIONS_PAGE_SECTIONS.has(raw) ? raw : 'highlight';
    const qs = msg.purchase ? '?purchase=1' : '';
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + qs + `#${section}` });
    return;
  }

  if (msg?.type === 'il-open-about-feedback') {
    void (async () => {
      await chrome.storage.session.set({ [globalThis.IL_OPEN_ABOUT_FEEDBACK_KEY]: true });
      await chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + '#about' });
    })();
    return;
  }

  if (msg?.type === 'il-open-store-review') {
    const url = typeof msg.url === 'string' ? msg.url.trim() : '';
    if (url.startsWith('https://chromewebstore.google.com/')) {
      void chrome.tabs.create({ url });
    }
    return;
  }

  if (msg?.type === 'il-engagement-nudge-report') {
    void postEngagementNudgeReport(msg);
    return;
  }

  if (msg?.type === 'ih-usage-report') {
    postUsageReport(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-credits-add-click') {
    postCreditsAddClick()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-anonymous-site-domain') {
    postAnonymousSiteDomain(msg);
    return;
  }

  if (msg?.type === 'ih-author-note') {
    IL_postAuthorNote(EXTENSION_ID, msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'il-extension-feedback') {
    IL_postKeepalive(
      '/api/extension-feedback',
      {
        ...(msg.body && typeof msg.body === 'object' ? msg.body : {}),
        extension: EXTENSION_ID,
        extension_version: chrome.runtime.getManifest().version,
      },
    );
    return;
  }

  if (msg?.type === 'ih-credits-balance') {
    readCreditState()
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-credits-refresh') {
    refreshCreditState()
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-credits-purchase') {
    startCreditPurchase(msg.provider, msg.pack, msg.amount_usd)
      .then((pay_url) => sendResponse({ ok: true, pay_url }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-credits-catalog') {
    readCreditCatalog()
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-credits-confirm') {
    confirmCreditPurchase(typeof msg.order_id === 'string' ? msg.order_id : '')
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-api-key') {
    IL_getApiKey()
      .then((api_key) => sendResponse({ ok: true, api_key }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  // 更换前先用新 key 查余额和订单
  if (msg?.type === 'ih-credits-check-key') {
    if (!IL_API_KEY_RE.test(msg.api_key)) {
      sendResponse({ ok: false, error: 'Invalid API key.' });
      return;
    }
    readCreditBalance(msg.api_key)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type === 'ih-api-key-replace') {
    IL_replaceApiKey(msg.api_key)
      .then(async () => {
        // 旧 key 的余额和待付订单不再适用
        lastCreditBalance = null;
        await chrome.storage.local.remove([CREDIT_BALANCE_KEY, CREDIT_ORDER_KEY, CREDIT_PAY_URL_KEY]);
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg?.type !== 'ih-analyze') return;
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (!text) {
    sendResponse({ ok: false, error: 'Missing text' });
    return;
  }
  const waitGen = Number(msg.waitGen);
  const waitUi = Number.isInteger(waitGen) && waitGen > 0
    ? { waitGen, armCloudWait: !!msg.armCloudWait }
    : null;
  handleAnalyze(text, !!msg.skipCache, false, sender.tab?.id, msg.cloudModel, waitUi)
    .then(({
      data,
      inferred,
      engine,
      notice,
      credit_balance,
    }) => sendResponse({
      ok: true,
      data,
      inferred,
      engine,
      ...(notice ? { notice, credit_balance } : {}),
    }))
    .catch((err) => sendResponse({
      ok: false,
      error: String(err?.message || err),
      ...(pickAnalyzeNotice(err?.notice) ? { notice: err.notice } : {}),
    }));
  return true;
});
