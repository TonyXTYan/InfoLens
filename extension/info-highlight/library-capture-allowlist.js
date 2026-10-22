/**
 * 收藏「自动」模式：命中白名单 → 原页整页，否则阅读视图。内置名单；日后可并入用户配置。
 */
globalThis.IH_libraryCaptureAllowlist ||= (function () {
  const BUILTIN_FULL_CAPTURE = [
    'mp.weixin.qq.com/s/',
  ];

  /** @param {string} url @param {string[]} entries */
  function urlOnAllowlist(url, entries) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const h = (u.hostname || '').toLowerCase();
      const path = (u.pathname || '').toLowerCase();
      for (const entry of entries) {
        const e = String(entry || '').trim().toLowerCase();
        if (!e) continue;
        const slash = e.indexOf('/');
        if (slash >= 0) {
          const hostPart = e.slice(0, slash);
          const pathPart = e.slice(slash);
          if (!pathPart.startsWith('/')) continue;
          const hostOk = h === hostPart || h.endsWith(`.${hostPart}`);
          if (hostOk && path.startsWith(pathPart)) return true;
          continue;
        }
        if (h === e || h.endsWith(`.${e}`)) return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  function urlOnFullCaptureAllowlist(url) {
    return urlOnAllowlist(url, BUILTIN_FULL_CAPTURE);
  }

  return {
    BUILTIN_FULL_CAPTURE,
    urlOnAllowlist,
    urlOnFullCaptureAllowlist,
  };
})();
