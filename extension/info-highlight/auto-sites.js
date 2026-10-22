/**
 * 自动分析的站点名单：条目是 hostname、`*.example.com` 或 `*`，匹配规则与 Chrome match pattern 的 host 一致。
 * 名单在 chrome.storage.local，host 权限在 Chrome 手上——用户可在扩展详情页单独撤销，
 * 故要跑之前以 granted() 为准，名单只当用户意图看。
 */
globalThis.IH_autoSites ||= (function () {
  const KEY = 'ih_auto_sites';

  /** 只有普通 http(s) 页进自动路径；PDF、file:、受限页由调用方另外挡 */
  function hostOf(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname || null;
  }

  /** `*` 与 `*.example.com` 之外不许再有通配；IPv6 字面量拼不出合法 match pattern */
  function isListable(host) {
    if (host === '*') return true;
    const rest = host.startsWith('*.') ? host.slice(2) : host;
    return !!rest && !rest.includes('*') && !rest.includes('[');
  }

  /** 选项页手填：hostname、完整 URL，或 `*.example.com` / `*`；非法则 null */
  function parseHost(input) {
    const s = String(input || '').trim();
    if (!s) return null;
    const host = s === '*' ? s : hostOf(s.includes('://') ? s : `https://${s}`);
    return host && isListable(host) ? host : null;
  }

  /** 页面 hostname 是否被某条名单项覆盖 */
  function matches(entry, host) {
    if (entry === '*') return true;
    if (entry.startsWith('*.')) return host === entry.slice(2) || host.endsWith(entry.slice(1));
    return entry === host;
  }

  // 自动分析 / 收藏拉图共用：一次授权覆盖所有 http(s) 站，避免每站各弹一次。
  // manifest 的 optional_host_permissions 须含 *://*/*；拆成 http、https 两条则 permissions.request 会被拒。
  const ALL_SITES_ORIGINS = ['*://*/*'];

  function allSitesPermissionRequest() {
    return { origins: ALL_SITES_ORIGINS };
  }

  /** 须在用户手势里同步调用（返回的 Promise 可之后再 await）。 */
  function requestAllSitesPermission() {
    return chrome.permissions.request(allSitesPermissionRequest());
  }

  async function hasAllSitesPermission() {
    return chrome.permissions.contains(allSitesPermissionRequest());
  }

  /** 单站 match pattern（仅用于清理旧版按站授权残留）。 */
  function originPattern(host) {
    return `*://${host}/*`;
  }

  async function list() {
    const res = await chrome.storage.local.get({ [KEY]: [] });
    const raw = res[KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter((h) => typeof h === 'string' && h);
  }

  async function has(host) {
    return !!host && (await list()).some((entry) => matches(entry, host));
  }

  /** 右键菜单只管精确项：它加什么就查什么、删什么；通配项只在选项页增删 */
  async function hasExact(host) {
    return !!host && (await list()).includes(host);
  }

  /** 调用前须已拿到 host 权限 */
  async function add(host) {
    const cur = await list();
    if (cur.includes(host)) return;
    await chrome.storage.local.set({ [KEY]: [...cur, host].sort() });
  }

  async function remove(host) {
    const cur = await list();
    await chrome.storage.local.set({ [KEY]: cur.filter((h) => h !== host) });
    try {
      await chrome.permissions.remove({ origins: [originPattern(host)] });
    } catch {
      /* 旧版按站授权可能已无 */
    }
  }

  /** 0.4.3 按页 hostname 或名单条目（含 *.example.com）授权的 pattern，去重后逐个 contains。 */
  async function legacyOriginPatternsForPage(host) {
    const patterns = new Set([originPattern(host)]);
    for (const entry of await list()) {
      if (matches(entry, host)) patterns.add(originPattern(entry));
    }
    return [...patterns];
  }

  /** 自动分析能否注入：全网权限，或仍保留的旧版按站 / 通配 optional 权限。 */
  async function hasHostPermissionForPage(host) {
    if (!host) return false;
    if (await hasAllSitesPermission()) return true;
    for (const pattern of await legacyOriginPatternsForPage(host)) {
      if (pattern === '*://*/*') continue;
      if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    }
    return false;
  }

  /** 已拿到全网权限后，去掉名单里各条目对应的旧按站 pattern，避免权限页堆一堆重复项。 */
  async function pruneLegacyOriginsIfAllSites() {
    if (!(await hasAllSitesPermission())) return;
    const patterns = new Set();
    for (const entry of await list()) {
      const p = originPattern(entry);
      if (p !== '*://*/*') patterns.add(p);
    }
    if (!patterns.size) return;
    try {
      await chrome.permissions.remove({ origins: [...patterns] });
    } catch {
      /* 用户可能已在扩展详情里撤过部分项 */
    }
  }

  async function granted(host) {
    if (!(await has(host))) return false;
    return hasHostPermissionForPage(host);
  }

  return {
    KEY,
    ALL_SITES_ORIGINS,
    hostOf,
    parseHost,
    matches,
    originPattern,
    allSitesPermissionRequest,
    requestAllSitesPermission,
    hasAllSitesPermission,
    list,
    has,
    hasExact,
    add,
    remove,
    granted,
    hasHostPermissionForPage,
    pruneLegacyOriginsIfAllSites,
  };
})();
