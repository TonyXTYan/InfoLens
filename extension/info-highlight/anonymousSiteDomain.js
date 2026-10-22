/**
 * 匿名网站域名统计：插件一开始干活就报主机名（或类别）、字数、文本块数、结果、文档种类、触发方式。
 * 分析成功/取消/失败，以及抽出正文前的入口拦截，都走同一条。
 * 不带用户标识、路径、查询和正文。本机与内网只报类别；受保护页报协议或页面类型。
 */
(() => {
  const INTRANET_SUFFIXES = ['.local', '.internal', '.lan', '.home', '.localdomain'];
  const KINDS = new Set(['html', 'pdf', 'txt', 'md', 'other']);

  function ipv4Parts(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (parts.some((n) => n > 255)) return null;
    return parts;
  }

  function isLocalhost(host) {
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
    const v4 = ipv4Parts(host);
    return !!v4 && v4[0] === 127;
  }

  /** 局域网与链路本地。127 与 ::1 已在 isLocalhost。 */
  function isLan(host) {
    const v4 = ipv4Parts(host);
    if (v4) {
      const a = v4[0];
      const b = v4[1];
      if (a === 10) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      return false;
    }
    if (!host.includes(':')) return false;
    const first = host.split(':')[0];
    if (!first) return false;
    const n = parseInt(first, 16);
    if (!Number.isFinite(n)) return false;
    if (n >= 0xfe80 && n <= 0xfebf) return true;
    return n >= 0xfc00 && n <= 0xfdff;
  }

  function isIntranetName(host) {
    if (!host.includes('.')) return true;
    return INTRANET_SUFFIXES.some((suffix) => host.endsWith(suffix));
  }

  function stripWww(host) {
    return host.startsWith('www.') ? host.slice(4) : host;
  }

  /** chrome://newtab → chrome:newtab。不报路径；chrome-extension id 只报协议。 */
  function schemePageLabel(url) {
    const proto = url.protocol;
    if (!proto || proto === 'http:' || proto === 'https:' || proto === 'file:') return '';
    if (proto === 'chrome-extension:') return 'chrome-extension:';
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    if (host && !/[/?#@\s]/.test(host)) return `${proto}${host}`;
    // about:blank 的类型在 pathname；view-source 的 pathname 是完整 URL，丢掉
    const token = String(url.pathname || '').replace(/^\//, '');
    if (/^[a-z0-9_-]{1,64}$/.test(token)) return `${proto}${token}`;
    return proto;
  }

  /** 公开主机名，或 file / localhost / lan / intranet / ip / webstore / chrome:newtab / unknown。 */
  function hostFromUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return 'unknown';
    }
    if (url.protocol === 'file:') return 'file';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return schemePageLabel(url) || 'unknown';
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    if (!host) return 'unknown';
    // 旧版商店路径不能报 pathname，收成类型；新版 chromewebstore.google.com 走下面公开主机名
    if (host === 'chrome.google.com' && url.pathname.startsWith('/webstore')) return 'webstore';
    if (isLocalhost(host)) return 'localhost';
    if (ipv4Parts(host) || host.includes(':')) return isLan(host) ? 'lan' : 'ip';
    if (isIntranetName(host)) return 'intranet';
    const bare = stripWww(host);
    return bare || 'unknown';
  }

  function pathIsMarkdown(href) {
    try {
      return /\.(md|markdown)$/i.test(new URL(href).pathname);
    } catch {
      return false;
    }
  }

  /**
   * 网页文档种类。PDF 查看器由调用方传 kind:'pdf'（查看器页面本身是 HTML）。
   * 已渲染成 HTML 的 Markdown 记 html。
   */
  function docKind(doc, href) {
    const ct = String(doc?.contentType || '').split(';')[0].trim().toLowerCase();
    if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html';
    if (ct === 'text/markdown' || ct === 'text/x-markdown') return 'md';
    if (ct === 'text/plain') return pathIsMarkdown(href) ? 'md' : 'txt';
    return 'other';
  }

  /** 没有 document 时按 URL 能确定的种类；不报路径。 */
  function kindFromHref(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return 'other';
    }
    const path = url.pathname;
    if (/\.pdf$/i.test(path)) return 'pdf';
    if (/\.(md|markdown)$/i.test(path)) return 'md';
    if (/\.txt$/i.test(path)) return 'txt';
    if (url.protocol === 'http:' || url.protocol === 'https:') return 'html';
    if (/\.html?$/i.test(path)) return 'html';
    return 'other';
  }

  /**
   * 抽出正文前就结束：失败/拦截。chars/blocks 为 0，outcome 保持 failed（不收成 empty）。
   * @param {string} [href]
   * @param {string} [trigger]
   */
  function blockedAttempt(href, trigger) {
    const url = typeof href === 'string' ? href : '';
    return {
      host: hostFromUrl(url),
      kind: kindFromHref(url),
      chars: 0,
      blocks: 0,
      outcome: 'failed',
      trigger: typeof trigger === 'string' ? trigger : '',
    };
  }

  function counts(session) {
    const mapped = session?.mapped;
    const text = mapped?.text;
    const pieces = mapped?.pieces;
    return {
      chars: typeof text === 'string' ? text.length : 0,
      blocks: Array.isArray(pieces) ? pieces.length : 0,
    };
  }

  function send(body) {
    const rt = globalThis.chrome?.runtime;
    if (typeof rt?.sendMessage !== 'function') return;
    try {
      rt.sendMessage({ type: 'ih-anonymous-site-domain', ...body }, () => {
        void rt.lastError;
      });
    } catch {
      /* 上报失败不影响分析 */
    }
  }

  /**
   * @param {{ href?: string, doc?: Document, kind?: string, session?: { mapped?: { text?: string, pieces?: unknown[] } } | null, report?: { outcome?: string, trigger?: string | null } }} args
   */
  function fromAnalysis(args) {
    if (globalThis.IH_OPTIONS_PAGE) return;
    const report = args?.report;
    let outcome = report?.outcome;
    if (outcome !== 'ok' && outcome !== 'failed' && outcome !== 'cancelled') return;
    const { chars, blocks } = counts(args?.session);
    if (outcome === 'failed' && chars === 0 && blocks === 0) outcome = 'empty';
    const href = typeof args?.href === 'string' ? args.href : '';
    const kind = args?.kind || docKind(args?.doc, href);
    send({
      host: hostFromUrl(href),
      kind: KINDS.has(kind) ? kind : 'other',
      chars,
      blocks,
      outcome,
      trigger: typeof report?.trigger === 'string' ? report.trigger : '',
    });
  }

  globalThis.IH_anonymousSiteDomain = {
    hostFromUrl,
    docKind,
    kindFromHref,
    blockedAttempt,
    fromAnalysis,
  };
})();
