/**
 * 「收藏到手机」：先把正文从第 0 段画到上限，再静态化整份 HTML（外链 CSS 留绝对 <link>）→ 内嵌图 → 视频留链 → POST /v1/library。
 * importScripts 引入；挂 globalThis.IH_library。分析、注入、fetchWithApiKey 仍走 background。
 */
(() => {
  if (!globalThis.IH_libraryCaptureAllowlist) {
    throw new Error('IH_libraryCaptureAllowlist missing — inject library-capture-allowlist.js first');
  }
  const { urlOnFullCaptureAllowlist: libraryUrlOnFullCaptureAllowlist } = IH_libraryCaptureAllowlist;

  const MENU_ID = 'ih-save-phone';
  const { tr } = IH_i18n;

  /** 与门面 LIBRARY_MAX_CONTENT_CHARS 一致（5 MiB，按 length 计）；超了当场失败，不截断。 */
  const LIBRARY_MAX_CONTENT_CHARS = 5 * 1024 * 1024;
  /** 单张 JPEG 上限；先按 0.82 压，超了再降质量、缩边。 */
  const LIBRARY_IMG_MAX_BYTES = 100_000;
  /** 全部内嵌图合计；从前往后排，排满后的留外链。 */
  const LIBRARY_IMG_TOTAL_MAX_BYTES = 1_000_000;
  /** 原图下载上限。微信 PNG 常 2–4MB，先下再 JPEG。 */
  const LIBRARY_IMG_FETCH_MAX_BYTES = 8_000_000;
  const LIBRARY_IMG_MAX_EDGE = 1200;
  const LIBRARY_IMG_QUALITY = 0.82;
  /** 冗余：主上限是合计体积；避免极端页无限拉取。 */
  const LIBRARY_IMG_MAX_COUNT = 100;
  /** 小于此边的图视为懒加载占位，不用 canvas 烘焙（微信等常见 1×1 data URL）。 */
  const LIBRARY_IMG_MIN_EDGE = 32;

  /** 受保护页、PDF、自家 PDF 查看器：收藏管线跑不了。 */
  function librarySaveBlockedUrl(url) {
    return IL_isRestrictedUrl(url) || IL_pdfSw.isPdfUrl(url) || IL_pdfSw.isOwnViewerUrl(url);
  }

  function librarySaveErrDetail(raw) {
    const msg = String(raw?.message || raw || '').trim();
    if (msg === 'library full') {
      if (Number.isInteger(raw?.maxItems)) {
        return tr(
          'Library is full ({max} items). Open your library on your phone, delete some entries, and try again.',
          { max: raw.maxItems },
        );
      }
      return tr(
        'Library is full. Open your library on your phone, delete some entries, and try again.',
      );
    }
    if (msg === 'contentHtml too large') {
      return tr('This page is too large to save (limit {max}).', {
        max: librarySizeLabel(LIBRARY_MAX_CONTENT_CHARS),
      });
    }
    return msg;
  }

  function librarySizeLabel(n) {
    const x = Math.max(0, Number(n) || 0);
    if (x < 1024) return `${Math.round(x)} B`;
    const kb = x / 1024;
    if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    const mb = kb / 1024;
    return `${mb < 10 ? mb.toFixed(2) : mb.toFixed(1)} MB`;
  }

  function libraryLogLine(label, detail) {
    const right = detail == null || detail === '' ? '' : String(detail);
    return right ? `${label}\t${right}` : String(label);
  }

  /** background service worker：只用 fetch 上传（无字节级进度）。 */
  async function postLibraryJson(path, apiKey, body) {
    const res = await fetch(`${IL_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    return {
      ok: res.ok,
      status: res.status,
      json: () => res.json(),
    };
  }

  async function deleteLibraryItem(apiKey, itemId) {
    const id = String(itemId || '').trim();
    if (!id) return { ok: false, status: 0, error: 'missing id' };
    const res = await fetch(`${IL_API_BASE}/v1/library/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    let error = '';
    if (!res.ok) {
      try {
        const err = await res.json();
        error = err?.error || err?.message || '';
      } catch { /* ignore */ }
      if (!error) error = `Delete failed (${res.status})`;
    }
    return { ok: res.ok, status: res.status, error };
  }

  function isLibraryUploadNetworkError(err) {
    const m = String(err?.message || err || '').toLowerCase();
    return m.includes('failed to fetch')
      || m.includes('network error')
      || m.includes('networkerror')
      || m.includes('net::')
      || m.includes('err_internet')
      || m.includes('err_network')
      || m.includes('timed out')
      || m.includes('timeout');
  }

  function libraryImagesCapNote(cap) {
    if (cap?.cappedByCount) {
      return ` (${tr('Only packed the first {n} images', { n: LIBRARY_IMG_MAX_COUNT })})`;
    }
    if (cap?.cappedByBytes) {
      return ` (${tr('Image pack size limit reached')})`;
    }
    return '';
  }

  function libraryImagesLogDetail(byteDelta, cap) {
    return librarySizeLabel(byteDelta) + libraryImagesCapNote(cap);
  }

  function libraryTotalLogDetail(totalChars, cap) {
    const capNote = libraryImagesCapNote(cap);
    if (totalChars > LIBRARY_MAX_CONTENT_CHARS) {
      return `${librarySizeLabel(totalChars)} / ${librarySizeLabel(LIBRARY_MAX_CONTENT_CHARS)}${capNote}`;
    }
    return librarySizeLabel(totalChars) + capNote;
  }

  /** data-src 懒加载占位：若同标签 src 已是内嵌图，不再计入待打包 http 图。 */
  function libraryImgTagHasDataSrc(html, attrIndex) {
    const start = html.lastIndexOf('<img', attrIndex);
    if (start < 0 || attrIndex - start > 8000) return false;
    const end = html.indexOf('>', attrIndex);
    if (end < 0) return false;
    const tag = html.slice(start, end + 1);
    return /\bsrc\s*=\s*["']data:image\//i.test(tag);
  }

  function libraryContentSizeMsg(page, withCss, withImg, imagesCap) {
    const lines = [libraryLogLine(tr('Page'), librarySizeLabel(page))];
    const cssDelta = withCss - page;
    if (cssDelta) lines.push(libraryLogLine(tr('Style'), librarySizeLabel(cssDelta)));
    lines.push(libraryLogLine(tr('Images'), librarySizeLabel(withImg - withCss)));
    lines.push(libraryLogLine(tr('Total'), libraryTotalLogDetail(withImg, imagesCap)));
    return lines.join('\n');
  }

  function libraryProgressText(status, sizeMsg) {
    const head = String(status || '');
    const size = String(sizeMsg || '');
    return size ? `${head}\n${size}` : head;
  }

  const librarySaveRun = new Map();

  function librarySaveRunStart(tabId) {
    const run = (librarySaveRun.get(tabId) || 0) + 1;
    librarySaveRun.set(tabId, run);
    return run;
  }

  function librarySaveCancelRun(tabId) {
    librarySaveRun.set(tabId, (librarySaveRun.get(tabId) || 0) + 1);
  }

  function librarySaveStill(tabId, run) {
    return librarySaveRun.get(tabId) === run;
  }

  function libraryThrowIfCancelled(tabId, run) {
    if (!librarySaveStill(tabId, run)) throw new Error('Cancelled');
  }

  function libraryIsCancelled(err) {
    return String(err?.message || err) === 'Cancelled';
  }

  async function libraryAbortPageAnalyze(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => {
          window.__IH_DEMO__?.setEnabled?.(false, 'library-cancel');
        },
      });
    } catch {
      /* tab gone */
    }
  }

  function libraryArrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    let s = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function libraryDataUrlBytes(dataUrl) {
    const s = String(dataUrl || '');
    const i = s.indexOf(',');
    if (i < 0) return 0;
    const b64 = s.slice(i + 1);
    let pad = 0;
    if (b64.endsWith('==')) pad = 2;
    else if (b64.endsWith('=')) pad = 1;
    return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
  }

  function libraryEmbeddedImageBytes(html) {
    let total = 0;
    const re = /(?:src="|url\(\s*["']?)(data:image\/[^"')\s]+)/gi;
    let m;
    while ((m = re.exec(html))) total += libraryDataUrlBytes(m[1]);
    return total;
  }

  function libraryImageMime(ct, url) {
    const t = String(ct || '').split(';')[0].trim().toLowerCase();
    if (t === 'image/jpg') return 'image/jpeg';
    if (t.startsWith('image/')) return t;
    const u = String(url || '');
    if (/\.png(\?|$)/i.test(u)) return 'image/png';
    if (/\.webp(\?|$)/i.test(u)) return 'image/webp';
    if (/\.gif(\?|$)/i.test(u)) return 'image/gif';
    return 'image/jpeg';
  }

  /** HTML 实体、微信 data-cover 编码、#imgIndex 碎片。 */
  function libraryNormalizeHttpUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    u = u.replace(/&amp;/gi, '&');
    if (/%3A/i.test(u)) {
      try { u = decodeURIComponent(u); } catch { /* keep */ }
    }
    const hash = u.indexOf('#');
    if (hash >= 0) u = u.slice(0, hash);
    if (/^http:\/\//i.test(u) && /qpic\.cn/i.test(u)) u = `https://${u.slice(7)}`;
    return /^https?:\/\//i.test(u) ? u : '';
  }

  /** JPEG：长边 ≤1200、质量 0.82；超过 maxBytes 再降质量、缩边。透明底铺白。 */
  async function libraryCompressBitmap(bitmap, maxBytes) {
    let w = bitmap.width;
    let h = bitmap.height;
    const scale = Math.min(1, LIBRARY_IMG_MAX_EDGE / Math.max(w, h, 1));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));

    async function blobAt(tw, th, q) {
      const canvas = new OffscreenCanvas(tw, th);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(bitmap, 0, 0, tw, th);
      return canvas.convertToBlob({ type: 'image/jpeg', quality: q });
    }

    let q = LIBRARY_IMG_QUALITY;
    let blob;
    try {
      blob = await blobAt(w, h, q);
    } catch {
      return null;
    }
    while (blob.size > maxBytes && q > 0.45) {
      q = Math.max(0.45, q - 0.12);
      blob = await blobAt(w, h, q);
    }
    while (blob.size > maxBytes && Math.max(w, h) > 64) {
      w = Math.max(1, Math.round(w * 0.7));
      h = Math.max(1, Math.round(h * 0.7));
      blob = await blobAt(w, h, q);
    }
    if (!blob || blob.size > maxBytes) return null;
    return blob;
  }

  /**
   * 扩展侧拉图（有 host 权限时不受页面 CORS 限）。
   * 一律 JPEG，超过 100KB 再压。GIF 不转，≤100KB 原样内嵌。失败返回 null，调用方留外链。
   */
  async function libraryFetchImageDataUrl(url, pageUrl) {
    try {
      url = libraryNormalizeHttpUrl(url);
      if (!url) return null;
      const init = { cache: 'force-cache', redirect: 'follow', credentials: 'omit' };
      const ref = String(pageUrl || '').trim();
      let res;
      try {
        const headers = {};
        if (ref && /^https?:/i.test(ref)) headers.Referer = ref;
        res = await fetch(url, { ...init, headers });
      } catch {
        res = await fetch(url, init);
      }
      if (!res.ok) return null;
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (ct && !ct.startsWith('image/')) return null;
      const buf = await res.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > LIBRARY_IMG_FETCH_MAX_BYTES) return null;
      const mime = libraryImageMime(ct, url);
      if (mime === 'image/gif') {
        if (buf.byteLength > LIBRARY_IMG_MAX_BYTES) return null;
        return `data:image/gif;base64,${libraryArrayBufferToBase64(buf)}`;
      }
      if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
        return null;
      }
      const blob = new Blob([buf], { type: mime });
      const bitmap = await createImageBitmap(blob);
      const out = await libraryCompressBitmap(bitmap, LIBRARY_IMG_MAX_BYTES);
      bitmap.close();
      if (!out) return null;
      const ab = await out.arrayBuffer();
      return `data:image/jpeg;base64,${libraryArrayBufferToBase64(ab)}`;
    } catch {
      return null;
    }
  }

  /** 正文 <img> 仍指向 http(s) 的换成 data URL（JPEG，GIF 原样）；CSS 背景图保留外链。合计 1MB 从前往后排。 */
  async function inlineLibraryHttpImages(html, pageUrl, stillFn) {
    const src = String(html || '');
    if (!src) return { html: src, imagesPacked: 0, imagesTotal: 0 };
    let usedBytes = libraryEmbeddedImageBytes(src);

    const imgFound = [];
    const reImg = /(<img\b[^>]*?\bsrc=")(https?:\/\/[^"]+)(")/gi;
    let m;
    while ((m = reImg.exec(src))) {
      const n = libraryNormalizeHttpUrl(m[2]);
      if (n) imgFound.push(n);
    }
    const reDataSrc = /\bdata-src="(https?:\/\/[^"]+)"/gi;
    while ((m = reDataSrc.exec(src))) {
      if (libraryImgTagHasDataSrc(src, m.index)) continue;
      const n = libraryNormalizeHttpUrl(m[1]);
      if (n) imgFound.push(n);
    }
    const reDataOrig = /\bdata-original="(https?:\/\/[^"]+)"/gi;
    while ((m = reDataOrig.exec(src))) {
      if (libraryImgTagHasDataSrc(src, m.index)) continue;
      const n = libraryNormalizeHttpUrl(m[1]);
      if (n) imgFound.push(n);
    }
    const imgUrls = [...new Set(imgFound)];
    const imagesTotal = imgUrls.length;
    if (usedBytes >= LIBRARY_IMG_TOTAL_MAX_BYTES) {
      return { html: src, imagesPacked: 0, imagesTotal, imagesCap: {} };
    }
    const cappedByCount = imgUrls.length > LIBRARY_IMG_MAX_COUNT;
    const urls = imgUrls.slice(0, LIBRARY_IMG_MAX_COUNT);
    if (!urls.length) return { html: src, imagesPacked: 0, imagesTotal: 0, imagesCap: {} };

    const map = new Map();
    let cappedByBytes = false;
    for (const url of urls) {
      if (stillFn && !stillFn()) throw new Error('Cancelled');
      const remain = LIBRARY_IMG_TOTAL_MAX_BYTES - usedBytes;
      if (remain < 256) {
        cappedByBytes = true;
        break;
      }
      const dataUrl = await libraryFetchImageDataUrl(url, pageUrl);
      if (!dataUrl) continue;
      const n = libraryDataUrlBytes(dataUrl);
      if (n > remain) continue;
      map.set(url, dataUrl);
      usedBytes += n;
    }
    if (!map.size) return { html: src, imagesPacked: 0, imagesTotal, imagesCap: {} };

    function mapped(url) {
      return map.get(libraryNormalizeHttpUrl(url));
    }
    let out = src.replace(/(<img\b[^>]*?\bsrc=")(https?:\/\/[^"]+)(")/gi, (all, a, url, c) => {
      const dataUrl = mapped(url);
      return dataUrl ? a + dataUrl + c : all;
    });
    out = out.replace(/\s+data-src="(https?:\/\/[^"]+)"/gi, (all, url) => (mapped(url) ? '' : all));
    out = out.replace(/\s+data-original="(https?:\/\/[^"]+)"/gi, (all, url) => (mapped(url) ? '' : all));
    out = out.replace(/\s+srcset="[^"]*"/gi, '');
    out = out.replace(/<img\b[^>]*>/gi, (tag) => {
      if (!/\ssrc="https?:/i.test(tag) || /\sreferrerpolicy=/i.test(tag)) return tag;
      return tag.replace(/^<img\b/i, '<img referrerpolicy="no-referrer"');
    });
    const imagesCap = {};
    if (cappedByCount) imagesCap.cappedByCount = true;
    else if (cappedByBytes) imagesCap.cappedByBytes = true;
    return { html: out, imagesPacked: map.size, imagesTotal, imagesCap };
  }

  function libraryAbsolutizeCssUrls(css, baseHref) {
    const src = String(css || '');
    const base = String(baseHref || '');
    function abs(raw) {
      const t = String(raw || '').trim();
      if (!t || /^(data:|blob:|#)/i.test(t)) return t;
      try { return new URL(t, base).href; } catch { return t; }
    }
    let out = src.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (all, q, u) => {
      const n = abs(u);
      return n === String(u).trim() ? all : `url(${q}${n}${q})`;
    });
    out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, (all, q, u) => {
      const n = abs(u);
      return n === u ? all : `@import ${q}${n}${q}`;
    });
    return out;
  }

  /** 页内 <style> 的相对 url/@import 按页面地址绝对化；外链 stylesheet 原样留 <link>。 */
  function rewriteLibraryInlineStyleUrls(html, pageUrl) {
    const src = String(html || '');
    if (!src) return src;
    return src.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (all, attrs, css) => (
      `<style${attrs}>${libraryAbsolutizeCssUrls(css, pageUrl)}</style>`
    ));
  }

  /** @returns {Promise<boolean>} */
  async function libraryAutoUseFullCapture(tabId) {
    const tab = await chrome.tabs.get(tabId);
    return libraryUrlOnFullCaptureAllowlist(tab?.url || '');
  }

  /**
   * @param {'auto' | 'full' | 'reader' | undefined} requested
   * @returns {Promise<'full' | 'reader'>}
   */
  async function resolveLibraryCaptureMode(workTabId, requested) {
    if (requested === 'full' || requested === 'reader') return requested;
    try {
      return (await libraryAutoUseFullCapture(workTabId)) ? 'full' : 'reader';
    } catch {
      return 'reader';
    }
  }

  /**
   * 页内捕获：克隆整份 html（看见什么收什么，不按站裁剪）、把已画 token 烘成 mark、去 script/事件、剥根节点主题锁、相对 URL 绝对化。
   */
  async function captureLibraryArticle(tabId) {
    const libraryLabels = {
      videoFile: tr('Video (open original file)'),
      videoPage: tr('Video (open original page)'),
    };
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: async (labels, imgCap) => {
        function absolutize(el, attr) {
          const raw = el.getAttribute(attr);
          if (!raw) return;
          const t = raw.trim();
          if (/^(mailto:|tel:|javascript:|#)/i.test(t)) return;
          try {
            el.setAttribute(attr, new URL(t, location.href).href);
          } catch { /* keep */ }
        }

        function sanitizeClone(clone) {
          for (const el of clone.querySelectorAll(
            'script, iframe, object, embed, noscript, #il-find-root, #il-overlay-host, #il-scope-divider-host, #il-scope-divider, #ih-progress-host, #ih-library-host, #ih-token-overlay, #ih-text-fg-css, [data-il-underline]',
          )) {
            el.remove();
          }
          for (const el of clone.querySelectorAll('*')) {
            for (const attr of [...el.attributes]) {
              const n = attr.name.toLowerCase();
              if (n.startsWith('on') || n === 'srcdoc') el.removeAttribute(attr.name);
            }
            absolutize(el, 'href');
            absolutize(el, 'src');
            absolutize(el, 'poster');
            if (el.tagName === 'IMG') {
              const ds = el.getAttribute('data-src') || el.getAttribute('data-original');
              const cur = (el.getAttribute('src') || '').trim();
              const dsTrim = (ds || '').trim();
              const curIsPlaceholder = !cur
                || (/^data:/i.test(cur) && cur.length < 12_000)
                || /^https?:\/\/[^/]+\/0(?:\?|$)/i.test(cur);
              if (dsTrim && curIsPlaceholder && /^https?:/i.test(dsTrim)) {
                try { el.setAttribute('src', new URL(dsTrim, location.href).href); }
                catch { el.setAttribute('src', dsTrim); }
              }
              // 快照阅读端不再按 srcset 选远程图
              el.removeAttribute('srcset');
            } else if (el.hasAttribute('srcset')) {
              el.removeAttribute('srcset');
            }
          }
          // 根节点主题锁：先按「属性名像主题 + 值是档位」剥，再按名单保底。正文不动。
          const themeLockName = /theme|scheme|color-mode|color-scheme|dark-?mode/i;
          const themeLockValue = /^(light|dark|auto|system)$/i;
          const themeLockAttrs = [
            'data-immersive-translate-page-theme',
            'data-darkreader-mode',
            'data-darkreader-scheme',
            'data-darkreader-proxy-injected',
            'data-weui-theme',
          ];
          for (const el of [clone, clone.querySelector('body'), ...clone.querySelectorAll('.wx-root')]) {
            if (!el) continue;
            for (const attr of [...el.attributes]) {
              if (themeLockName.test(attr.name) && themeLockValue.test((attr.value || '').trim())) {
                el.removeAttribute(attr.name);
              }
            }
            for (const name of themeLockAttrs) el.removeAttribute(name);
          }
        }

        try {
          const liveRoot = document.body;
          if (!document.documentElement || !liveRoot) return { ok: false, error: 'No page body' };

          await Promise.race([
            Promise.all([...liveRoot.querySelectorAll('img')].map((img) => {
              const ds = img.getAttribute('data-src') || img.getAttribute('data-original');
              const dsTrim = (ds || '').trim();
              if (dsTrim && /^https?:/i.test(dsTrim) && (!img.complete || img.naturalWidth < 32)) {
                try { img.src = new URL(dsTrim, location.href).href; }
                catch { img.src = dsTrim; }
              }
              img.loading = 'eager';
              if (img.complete && img.naturalWidth) return Promise.resolve();
              return new Promise((res) => {
                img.addEventListener('load', res, { once: true });
                img.addEventListener('error', res, { once: true });
              });
            })),
            new Promise((r) => setTimeout(r, 2500)),
          ]);

          const clone = document.documentElement.cloneNode(true);
          if (typeof globalThis.IH_bakeLibraryMarks !== 'function') {
            return { ok: false, error: 'Highlight bake missing' };
          }
          globalThis.IH_bakeLibraryMarks(clone);
          sanitizeClone(clone);
          const snapBody = clone.querySelector('body') || clone;

          function libraryVideoFileUrl(videoEl) {
            try {
              const cur = videoEl.currentSrc || videoEl.getAttribute('src') || '';
              if (cur && /^https?:/i.test(cur)) return new URL(cur, location.href).href;
            } catch { /* fall through */ }
            for (const src of videoEl.querySelectorAll('source')) {
              const raw = src.getAttribute('src') || src.getAttribute('data-src') || '';
              if (raw && /^https?:/i.test(raw)) {
                try { return new URL(raw, location.href).href; }
                catch { return raw; }
              }
            }
            return '';
          }

          function videoCoverUrl(el, innerVideo) {
            const raw = el.getAttribute('data-cover')
              || innerVideo?.getAttribute('poster')
              || el.getAttribute('poster')
              || '';
            if (!raw) return '';
            try {
              let t = decodeURIComponent(String(raw).replace(/&amp;/g, '&'));
              if (/^http:\/\//i.test(t) && /qpic\.cn/i.test(t)) t = `https://${t.slice(7)}`;
              if (/^https?:/i.test(t)) return t;
            } catch { /* fall */ }
            return /^https?:/i.test(raw) ? raw : '';
          }

          function replaceUnsupportedVideo(liveRoot, snapRoot) {
            const snapNodes = [...snapRoot.querySelectorAll('video, .video_iframe, [data-mpvid]')];
            const top = snapNodes.filter((el) => !snapNodes.some((o) => o !== el && o.contains(el)));
            const liveVideos = [...liveRoot.querySelectorAll('video')];
            let vi = 0;
            const doc = snapRoot.ownerDocument;
            for (const el of top) {
              const innerVideo = el.tagName === 'VIDEO' ? el : el.querySelector('video');
              let fileUrl = '';
              if (innerVideo) {
                fileUrl = libraryVideoFileUrl(liveVideos[vi] || innerVideo);
                vi += 1;
              }
              const cover = videoCoverUrl(el, innerVideo);
              const a = doc.createElement('a');
              a.className = 'ih-library-video';
              a.rel = 'noopener';
              a.target = '_blank';
              a.href = fileUrl || location.href;
              a.setAttribute('style', 'display:block;position:relative;margin:0.8em 0;overflow:hidden;border-radius:10px;background:#1a1a1a;color:#fff;text-decoration:none');
              if (cover) {
                const img = doc.createElement('img');
                img.src = cover;
                img.alt = '';
                img.setAttribute('referrerpolicy', 'no-referrer');
                img.setAttribute('style', 'display:block;width:100%;aspect-ratio:16/9;object-fit:cover');
                a.appendChild(img);
              }
              const cap = doc.createElement('span');
              cap.className = 'ih-library-video-cap';
              cap.setAttribute('style', 'display:flex;align-items:center;justify-content:center;padding:0.65em 0.85em;font-size:0.92rem');
              cap.textContent = fileUrl ? labels.videoFile : labels.videoPage;
              a.appendChild(cap);
              el.replaceWith(a);
            }
          }

          const minImgEdge = imgCap.minEdge;
          const maxImgEdge = imgCap.maxEdge;
          const jpegQuality = imgCap.quality;
          const maxImgBytes = imgCap.maxBytes;
          const totalMaxImgBytes = imgCap.totalMaxBytes;
          const maxInlineCount = Math.max(0, Number(imgCap.maxCount) || 0);
          function dataUrlBytes(dataUrl) {
            const s = String(dataUrl || '');
            const i = s.indexOf(',');
            if (i < 0) return 0;
            return Math.max(0, Math.floor((s.length - i - 1) * 3 / 4));
          }
          function libraryImgHttpUrl(img) {
            if (!img) return '';
            const candidates = [
              img.currentSrc,
              img.getAttribute('src'),
              img.getAttribute('data-src'),
              img.getAttribute('data-original'),
            ];
            for (const raw of candidates) {
              const t = String(raw || '').trim();
              if (!/^https?:/i.test(t)) continue;
              try { return new URL(t, location.href).href; }
              catch { return t; }
            }
            return '';
          }
          function liveImgIsGif(img) {
            const src = String(img.currentSrc || img.getAttribute('src') || '');
            if (/^data:image\/gif/i.test(src)) return true;
            const hint = `${src} ${img.getAttribute('data-src') || ''} ${img.getAttribute('data-original') || ''}`;
            return /\.gif(?:$|[?#])/i.test(hint);
          }
          // 页内已解码的图，一律 JPEG；超 100KB 再降质量、缩边。GIF 不烘焙。跨域污染时交给扩展下载。
          function liveImgToDataUrl(img) {
            try {
              if (!img || !img.complete || !img.naturalWidth) return null;
              if (liveImgIsGif(img)) return null;
              const origW = img.naturalWidth;
              const origH = img.naturalHeight;
              if (origW < minImgEdge || origH < minImgEdge) return null;
              let w = origW;
              let h = origH;
              const scale = Math.min(1, maxImgEdge / Math.max(w, h, 1));
              w = Math.max(1, Math.round(w * scale));
              h = Math.max(1, Math.round(h * scale));
              function draw(tw, th) {
                const canvas = document.createElement('canvas');
                canvas.width = tw;
                canvas.height = th;
                const ctx = canvas.getContext('2d');
                if (!ctx) return null;
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, tw, th);
                ctx.drawImage(img, 0, 0, tw, th);
                return canvas;
              }
              let q = jpegQuality;
              let canvas = draw(w, h);
              if (!canvas) return null;
              let dataUrl = canvas.toDataURL('image/jpeg', q);
              while (dataUrlBytes(dataUrl) > maxImgBytes && q > 0.45) {
                q = Math.max(0.45, q - 0.12);
                dataUrl = canvas.toDataURL('image/jpeg', q);
              }
              while (dataUrlBytes(dataUrl) > maxImgBytes && Math.max(w, h) > 64) {
                w = Math.max(1, Math.round(w * 0.7));
                h = Math.max(1, Math.round(h * 0.7));
                canvas = draw(w, h);
                if (!canvas) return null;
                dataUrl = canvas.toDataURL('image/jpeg', q);
              }
              if (dataUrlBytes(dataUrl) > maxImgBytes) return null;
              return dataUrl;
            } catch {
              return null;
            }
          }
          const liveImgs = liveRoot.querySelectorAll('img');
          const cloneImgs = snapBody.querySelectorAll('img');
          const nImg = Math.min(liveImgs.length, cloneImgs.length);
          let usedImgBytes = 0;
          let budgetFull = false;
          for (let i = 0; i < nImg; i += 1) {
            const liveImg = liveImgs[i];
            const el = cloneImgs[i];
            const httpUrl = libraryImgHttpUrl(liveImg);
            const tryBake = !budgetFull
              && usedImgBytes < totalMaxImgBytes
              && (!maxInlineCount || i < maxInlineCount);
            const dataUrl = tryBake ? liveImgToDataUrl(liveImg) : null;
            const n = dataUrl ? dataUrlBytes(dataUrl) : 0;
            if (dataUrl && usedImgBytes + n <= totalMaxImgBytes) {
              el.setAttribute('src', dataUrl);
              el.removeAttribute('srcset');
              el.removeAttribute('data-src');
              el.removeAttribute('data-original');
              usedImgBytes += n;
              continue;
            }
            if (dataUrl) budgetFull = true;
            if (httpUrl) {
              el.setAttribute('src', httpUrl);
              el.setAttribute('referrerpolicy', 'no-referrer');
              el.removeAttribute('srcset');
              el.removeAttribute('data-src');
              el.removeAttribute('data-original');
            }
          }
          for (const el of clone.querySelectorAll('img')) {
            for (const attr of ['data-src', 'data-original']) {
              const v = el.getAttribute(attr) || '';
              if (/^data:/i.test(v) && v.length > 12_000) el.removeAttribute(attr);
            }
          }

          replaceUnsupportedVideo(liveRoot, snapBody);

          for (const meta of clone.querySelectorAll('meta')) {
            if ((meta.getAttribute('charset') || '').trim()) meta.setAttribute('charset', 'utf-8');
            const httpEq = (meta.getAttribute('http-equiv') || '').toLowerCase();
            if (httpEq === 'refresh') {
              meta.remove();
              continue;
            }
            const content = meta.getAttribute('content') || '';
            if (httpEq === 'content-type' && /charset=/i.test(content)) {
              meta.setAttribute('content', content.replace(/charset=[^;]+/i, 'charset=utf-8'));
            }
          }

          const EXT_RE = /^(chrome-extension|moz-extension|safari-web-extension):/i;
          for (const link of [...clone.querySelectorAll('link')]) {
            const rels = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
            if (!rels.includes('stylesheet')) continue;
            const href = (link.getAttribute('href') || '').trim();
            if (!href || EXT_RE.test(href)) link.remove();
          }

          const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '<!DOCTYPE html>';
          const html = doctype + clone.outerHTML;
          return {
            ok: true,
            title: document.title || '',
            html,
          };
        } catch (err) {
          return { ok: false, error: String(err && err.message || err) };
        }
      },
      args: [libraryLabels, {
        minEdge: LIBRARY_IMG_MIN_EDGE,
        maxEdge: LIBRARY_IMG_MAX_EDGE,
        quality: LIBRARY_IMG_QUALITY,
        maxBytes: LIBRARY_IMG_MAX_BYTES,
        totalMaxBytes: LIBRARY_IMG_TOTAL_MAX_BYTES,
        maxCount: LIBRARY_IMG_MAX_COUNT,
      }],
    });
    const v = results?.[0]?.result;
    if (!v?.ok) throw new Error(v?.error || 'Capture failed');
    return {
      title: String(v.title || ''),
      html: String(v.html || ''),
    };
  }

  const READER_CAPTURE_JS = [
    'vendor/Readability.js',
    'extractRootPatches.js',
    'articleRoot.js',
    'visualBlockOrder.js',
  ];

  /** @type {Promise<string> | null} */
  let libraryReaderCssPromise = null;

  function loadLibraryReaderCss() {
    if (!libraryReaderCssPromise) {
      libraryReaderCssPromise = fetch(chrome.runtime.getURL('library-reader.css'))
        .then((res) => {
          if (!res.ok) throw new Error('reader css missing');
          return res.text();
        });
    }
    return libraryReaderCssPromise;
  }

  async function ensureReaderExtractScripts(tabId) {
    let ready = false;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => (
          typeof globalThis.IL_findArticleRoot === 'function'
          && typeof globalThis.IL_reorderArticleBlocksByVisual === 'function'
        ),
      });
      ready = !!result;
    } catch {
      ready = false;
    }
    if (ready) return;
    await IL_injectWithRetry(tabId, { js: READER_CAPTURE_JS }, {
      logLabel: 'Info Highlight',
      waitComplete: false,
    });
    const [{ result: ok }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => (
        typeof globalThis.IL_findArticleRoot === 'function'
        && typeof globalThis.IL_reorderArticleBlocksByVisual === 'function'
      ),
    });
    if (!ok) throw new Error('inject');
  }

  /**
   * 阅读视图快照：Readability 定根 → 极简 HTML 文档（内联 reader CSS），不烘高亮。
   */
  async function captureLibraryReaderArticle(tabId, sourceUrl) {
    await ensureReaderExtractScripts(tabId);
    const readerCss = await loadLibraryReaderCss();
    const libraryLabels = {
      videoFile: tr('Video (open original file)'),
      videoPage: tr('Video (open original page)'),
    };
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: async (readerCssText, labels) => {
        function absolutize(el, attr) {
          const raw = el.getAttribute(attr);
          if (!raw) return;
          const t = raw.trim();
          if (/^(mailto:|tel:|javascript:|#)/i.test(t)) return;
          try {
            el.setAttribute(attr, new URL(t, location.href).href);
          } catch { /* keep */ }
        }

        function stripReaderFrozenTheme(el) {
          if (!(el instanceof Element)) return;
          if (el.tagName === 'MARK' && [...el.classList].some((c) => c.startsWith('ih-token-'))) return;
          if (el.classList?.contains('ih-library-video')) return;
          el.removeAttribute('bgcolor');
          if (el.tagName === 'FONT') el.removeAttribute('color');
          const st = el.style;
          if (!st?.length) return;
          for (const prop of [
            'color',
            'background',
            'background-color',
            'background-image',
            'caret-color',
            '-webkit-text-fill-color',
          ]) {
            st.removeProperty(prop);
          }
          if (!st.length) el.removeAttribute('style');
        }

        function sanitizeArticleSubtree(root) {
          for (const el of root.querySelectorAll(
            'script, iframe, object, embed, noscript, #il-find-root, #il-overlay-host, #il-scope-divider-host, #il-scope-divider, #ih-progress-host, #ih-library-host, #ih-token-overlay, #ih-text-fg-css, [data-il-underline]',
          )) {
            el.remove();
          }
          stripReaderFrozenTheme(root);
          for (const el of root.querySelectorAll('*')) {
            stripReaderFrozenTheme(el);
            el.removeAttribute('data-il-rid');
            for (const attr of [...el.attributes]) {
              const n = attr.name.toLowerCase();
              if (n.startsWith('on') || n === 'srcdoc') el.removeAttribute(attr.name);
            }
            absolutize(el, 'href');
            absolutize(el, 'src');
            absolutize(el, 'poster');
            if (el.tagName === 'IMG') {
              const ds = el.getAttribute('data-src') || el.getAttribute('data-original');
              const cur = (el.getAttribute('src') || '').trim();
              const dsTrim = (ds || '').trim();
              const curIsPlaceholder = !cur
                || (/^data:/i.test(cur) && cur.length < 12_000)
                || /^https?:\/\/[^/]+\/0(?:\?|$)/i.test(cur);
              if (dsTrim && curIsPlaceholder && /^https?:/i.test(dsTrim)) {
                try { el.setAttribute('src', new URL(dsTrim, location.href).href); }
                catch { el.setAttribute('src', dsTrim); }
              }
              el.removeAttribute('srcset');
            } else if (el.hasAttribute('srcset')) {
              el.removeAttribute('srcset');
            }
          }
        }

        function libraryVideoFileUrl(videoEl) {
          try {
            const cur = videoEl.currentSrc || videoEl.getAttribute('src') || '';
            if (cur && /^https?:/i.test(cur)) return new URL(cur, location.href).href;
          } catch { /* fall through */ }
          for (const src of videoEl.querySelectorAll('source')) {
            const raw = src.getAttribute('src') || src.getAttribute('data-src') || '';
            if (raw && /^https?:/i.test(raw)) {
              try { return new URL(raw, location.href).href; }
              catch { return raw; }
            }
          }
          return '';
        }

        function videoCoverUrl(el, innerVideo) {
          const raw = el.getAttribute('data-cover')
            || innerVideo?.getAttribute('poster')
            || el.getAttribute('poster')
            || '';
          if (!raw) return '';
          try {
            let t = decodeURIComponent(String(raw).replace(/&amp;/g, '&'));
            if (/^http:\/\//i.test(t) && /qpic\.cn/i.test(t)) t = `https://${t.slice(7)}`;
            if (/^https?:/i.test(t)) return t;
          } catch { /* fall */ }
          return /^https?:/i.test(raw) ? raw : '';
        }

        function replaceUnsupportedVideo(liveRoot, snapRoot) {
          const snapNodes = [...snapRoot.querySelectorAll('video, .video_iframe, [data-mpvid]')];
          const top = snapNodes.filter((el) => !snapNodes.some((o) => o !== el && o.contains(el)));
          const liveVideos = [...liveRoot.querySelectorAll('video')];
          let vi = 0;
          const doc = snapRoot.ownerDocument;
          for (const el of top) {
            const innerVideo = el.tagName === 'VIDEO' ? el : el.querySelector('video');
            let fileUrl = '';
            if (innerVideo) {
              fileUrl = libraryVideoFileUrl(liveVideos[vi] || innerVideo);
              vi += 1;
            }
            const cover = videoCoverUrl(el, innerVideo);
            const a = doc.createElement('a');
            a.className = 'ih-library-video';
            a.rel = 'noopener';
            a.target = '_blank';
            a.href = fileUrl || location.href;
            a.setAttribute('style', 'display:block;position:relative;margin:0.8em 0;overflow:hidden;border-radius:10px;background:#1a1a1a;color:#fff;text-decoration:none');
            if (cover) {
              const img = doc.createElement('img');
              img.src = cover;
              img.alt = '';
              img.setAttribute('referrerpolicy', 'no-referrer');
              img.setAttribute('style', 'display:block;width:100%;aspect-ratio:16/9;object-fit:cover');
              a.appendChild(img);
            }
            const cap = doc.createElement('span');
            cap.className = 'ih-library-video-cap';
            cap.setAttribute('style', 'display:flex;align-items:center;justify-content:center;padding:0.65em 0.85em;font-size:0.92rem');
            cap.textContent = fileUrl ? labels.videoFile : labels.videoPage;
            a.appendChild(cap);
            el.replaceWith(a);
          }
        }

        try {
          if (!document.body) return { ok: false, error: 'No page body' };
          const findRoot = globalThis.IL_findArticleRoot;
          if (typeof findRoot !== 'function') {
            return { ok: false, error: 'Article extract missing' };
          }

          const liveRoot = findRoot(document);
          const liveHtml = document.documentElement;
          await Promise.race([
            Promise.all([...liveRoot.querySelectorAll('img')].map((img) => {
              const ds = img.getAttribute('data-src') || img.getAttribute('data-original');
              const dsTrim = (ds || '').trim();
              if (dsTrim && /^https?:/i.test(dsTrim) && (!img.complete || img.naturalWidth < 32)) {
                try { img.src = new URL(dsTrim, location.href).href; }
                catch { img.src = dsTrim; }
              }
              img.loading = 'eager';
              if (img.complete && img.naturalWidth) return Promise.resolve();
              return new Promise((res) => {
                img.addEventListener('load', res, { once: true });
                img.addEventListener('error', res, { once: true });
              });
            })),
            new Promise((r) => setTimeout(r, 2500)),
          ]);

          const clone = liveHtml.cloneNode(true);
          const bake = globalThis.IH_bakeLibraryMarks;
          if (typeof bake === 'function') bake(clone);
          const markCss = clone.querySelector('#ih-library-marks')?.textContent || '';
          const twinAt = globalThis.IH_libraryTwinInClone;
          const articleTwin = typeof twinAt === 'function'
            ? twinAt(liveRoot, clone, liveHtml)
            : null;
          if (!articleTwin) {
            return { ok: false, error: 'Article twin missing' };
          }

          const article = articleTwin.cloneNode(true);
          if (typeof globalThis.IL_reorderArticleBlocksByVisual !== 'function') {
            return { ok: false, error: 'Visual reorder missing' };
          }
          globalThis.IL_reorderArticleBlocksByVisual(liveRoot, article);
          sanitizeArticleSubtree(article);
          for (const el of article.querySelectorAll('img')) {
            el.setAttribute('referrerpolicy', 'no-referrer');
          }
          replaceUnsupportedVideo(liveRoot, article);

          const shell = document.implementation.createHTMLDocument('');
          const htmlEl = shell.documentElement;
          if (document.documentElement?.lang) htmlEl.setAttribute('lang', document.documentElement.lang);
          const charset = shell.createElement('meta');
          charset.setAttribute('charset', 'utf-8');
          shell.head.appendChild(charset);
          const viewport = shell.createElement('meta');
          viewport.setAttribute('name', 'viewport');
          viewport.setAttribute('content', 'width=device-width, initial-scale=1');
          shell.head.appendChild(viewport);
          const referrer = shell.createElement('meta');
          referrer.setAttribute('name', 'referrer');
          referrer.setAttribute('content', 'no-referrer');
          shell.head.appendChild(referrer);
          const titleEl = shell.createElement('title');
          titleEl.textContent = document.title || '';
          shell.head.appendChild(titleEl);
          const style = shell.createElement('style');
          style.textContent = readerCssText;
          shell.head.appendChild(style);
          if (markCss) {
            const markStyle = shell.createElement('style');
            markStyle.id = 'ih-library-marks';
            markStyle.textContent = markCss
              .replace(
                /mark\[class\^="ih-token-"\]/g,
                '.ih-library-reader-content mark[class^="ih-token-"]',
              )
              .replace(/mark\.ih-token-/g, '.ih-library-reader-content mark.ih-token-');
            shell.head.appendChild(markStyle);
          }

          shell.body.className = 'ih-library-reader';
          const wrap = shell.createElement('div');
          wrap.className = 'ih-library-reader-wrap';
          const pageTitle = (document.title || '').trim();
          if (pageTitle) {
            const meta = shell.createElement('header');
            meta.className = 'ih-library-reader-meta';
            const titleEl = shell.createElement('h1');
            titleEl.className = 'ih-library-reader-title';
            titleEl.textContent = pageTitle;
            meta.appendChild(titleEl);
            wrap.appendChild(meta);
          }
          const main = shell.createElement('main');
          main.className = 'ih-library-reader-content';
          main.appendChild(shell.importNode(article, true));
          wrap.appendChild(main);
          shell.body.appendChild(wrap);

          const html = `<!DOCTYPE html>\n${htmlEl.outerHTML}`;
          return {
            ok: true,
            title: document.title || '',
            html,
          };
        } catch (err) {
          return { ok: false, error: String(err && err.message || err) };
        }
      },
      args: [readerCss, libraryLabels],
    });
    const v = results?.[0]?.result;
    if (!v?.ok) throw new Error(v?.error || 'Reader capture failed');
    return {
      title: String(v.title || ''),
      html: String(v.html || ''),
    };
  }

  const LIBRARY_HOST_ID = 'ih-library-host';
  const LIBRARY_OVERLAY_CSS = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  display: block;
  pointer-events: none;
}
.ih-lib-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(2px);
  pointer-events: auto;
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
.ih-lib-card {
  box-sizing: border-box;
  width: 420px;
  max-width: 100%;
  padding: 16px 18px 14px;
  border: 1px solid #e1e3e1;
  border-radius: 12px;
  background: #fff;
  color: #1f1f1f;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
}
.ih-lib-card h3 {
  margin: 0 0 10px;
  font-size: 17px;
  font-weight: 600;
}
.ih-lib-status {
  margin: 0;
  height: calc(8 * 1.55em);
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 13px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
}
.ih-lib-line {
  display: flex;
  gap: 0.75em;
  overflow-wrap: anywhere;
}
.ih-lib-line-full { overflow-wrap: anywhere; }
.ih-lib-line ~ .ih-lib-line-full { margin-top: 1.55em; }
.ih-lib-lbl {
  flex: 0 0 4.5em;
}
.ih-lib-det {
  flex: 1 1 auto;
  min-width: 0;
  white-space: pre-wrap;
}
.ih-lib-dots::after {
  content: '.';
  animation: ih-lib-dots 1.2s steps(3, end) infinite;
}
@keyframes ih-lib-dots {
  0% { content: '.'; }
  33% { content: '..'; }
  66% { content: '...'; }
}
.ih-lib-line.is-success,
.ih-lib-line-full.is-success { color: #067647; }
.ih-lib-line.is-error,
.ih-lib-line-full.is-error { color: #b42318; }
.ih-lib-line-full.ih-lib-result-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75em;
}
.ih-lib-result-msg {
  flex: 1 1 auto;
  min-width: 0;
}
.ih-lib-result-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: 0.75em;
}
.ih-lib-preview,
.ih-lib-delete {
  font-size: inherit;
  line-height: inherit;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
  border: none;
  padding: 0;
  background: none;
  font: inherit;
}
.ih-lib-preview {
  color: #1a73e8;
}
.ih-lib-delete {
  color: #b42318;
}
.ih-lib-preview:hover,
.ih-lib-delete:hover:not(:disabled) { text-decoration: underline; }
.ih-lib-preview.is-off,
.ih-lib-delete.is-off { display: none; }
.ih-lib-delete:disabled {
  opacity: 0.55;
  cursor: default;
  text-decoration: none;
}
.ih-lib-hint {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.4;
  color: #5e5e5e;
}
.ih-lib-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 14px;
  cursor: pointer;
  user-select: none;
}
.ih-lib-opt input {
  width: 18px;
  height: 18px;
  margin: 0;
  flex-shrink: 0;
  cursor: pointer;
}
.ih-lib-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.ih-lib-retry.is-off,
.ih-lib-close.is-off,
.ih-lib-cancel.is-off {
  display: none;
}
.ih-lib-hint.is-off {
  visibility: hidden;
  pointer-events: none;
}
  .ih-lib-btns button {
  font: inherit;
  font-size: 14px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid #747775;
  border-radius: 8px;
  background: #fff;
  color: #1f1f1f;
  cursor: pointer;
}
.ih-lib-foot {
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px solid #e1e3e1;
  font-size: 12px;
  line-height: 1.45;
  color: #5e5e5e;
}
.ih-lib-foot-line {
  margin: 0 0 6px;
}
.ih-lib-foot-line:last-child { margin-bottom: 0; }
.ih-lib-foot-step {
  display: block;
  font-size: 13px;
  line-height: 1.45;
}
.ih-lib-foot-step-title {
  display: block;
  font-weight: 600;
  color: #1f1f1f;
}
.ih-lib-foot-step-body {
  display: block;
  margin-top: 3px;
  font-weight: 400;
  color: #5e5e5e;
}
.ih-lib-foot-note {
  display: block;
  margin: 0;
  padding-top: 6px;
  border-top: 1px solid #e8eaed;
  font-size: 11px;
  line-height: 1.4;
  color: #747775;
  text-align: right;
}
.ih-lib-foot-urlbox {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 100%;
  padding: 7px 8px 7px 10px;
  background: #f1f3f4;
  border: 1px solid #dadce0;
  border-radius: 8px;
}
.ih-lib-foot-urlrow {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ih-lib-foot-label {
  font-weight: 500;
  color: inherit;
}
.ih-lib-foot-url {
  flex: 1 1 auto;
  min-width: 0;
  color: #3c4043;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.ih-lib-foot-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 2px;
}
.ih-lib-copy-btn {
  position: relative;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #5e5e5e;
  cursor: pointer;
}
.ih-lib-copy-btn:hover:not(:disabled) {
  background: #f1f3f1;
  color: #1f1f1f;
}
.ih-lib-copy-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.ih-lib-copy-btn svg {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 14px;
  height: 14px;
  transition: opacity 0.12s ease;
}
.ih-lib-copy-btn svg.icon-stroke {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ih-lib-copy-btn svg.icon-fill {
  fill: currentColor;
  stroke: none;
}
.ih-lib-copy-btn .icon-done { opacity: 0; }
.ih-lib-copy-btn.is-copied .icon-copy { opacity: 0; }
.ih-lib-copy-btn.is-copied .icon-done { opacity: 1; }
.ih-lib-qr-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
}
.ih-lib-qr-wrap.is-off { display: none; }
.ih-lib-qr-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  padding: 10px;
  background: #fff;
  color: #1f1f1f;
  border: 1px solid #e1e3e1;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.12s ease, visibility 0.12s ease;
  z-index: 3;
}
.ih-lib-qr-wrap:hover .ih-lib-qr-pop,
.ih-lib-qr-wrap:focus-within .ih-lib-qr-pop {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}
.ih-lib-qr-pop canvas {
  display: block;
  width: 148px;
  height: 148px;
  image-rendering: pixelated;
}
.ih-lib-qr-hint {
  margin: 8px 0 0;
  max-width: 148px;
  font-size: 11px;
  line-height: 1.4;
  text-align: center;
  color: #5e5e5e;
}
@media (prefers-color-scheme: dark) {
  .ih-lib-backdrop { background: rgba(0, 0, 0, 0.68); }
  .ih-lib-card {
    background: #1f1f1f;
    color: #e3e3e3;
    border-color: #444746;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  }
  .ih-lib-preview { color: #8ab4f8; }
  .ih-lib-delete { color: #ffb4ab; }
  .ih-lib-hint { color: #c4c7c5; }
  .ih-lib-line.is-success,
  .ih-lib-line-full.is-success { color: #6ce9a6; }
  .ih-lib-line.is-error,
  .ih-lib-line-full.is-error { color: #ffb4ab; }
  .ih-lib-btns button {
    background: #1f1f1f;
    color: #e3e3e3;
    border-color: #8e918f;
  }
  .ih-lib-foot { border-top-color: #444746; color: #c4c7c5; }
  .ih-lib-foot-step-title { color: #e3e3e3; }
  .ih-lib-foot-step-body { color: #9aa0a6; }
  .ih-lib-foot-note {
    color: #9aa0a6;
    border-top-color: #444746;
  }
  .ih-lib-foot-urlbox {
    background: #2d312d;
    border-color: #5e5e5e;
  }
  .ih-lib-foot-url { color: #bdc1c6; }
  .ih-lib-copy-btn:hover:not(:disabled) {
    background: #2d312d;
    color: #e3e3e3;
  }
  .ih-lib-qr-pop {
    background: #2d312d;
    color: #e3e3e3;
    border-color: #444746;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  }
  .ih-lib-qr-hint { color: #c4c7c5; }
}
`;

  const LIBRARY_PAGE_URL = 'https://info-lens.app/library.html';
  /** 收藏预览 popup 外窗（典型手机竖屏，略宽以留出边框） */
  const LIBRARY_PREVIEW_WIDTH = 404;
  const LIBRARY_PREVIEW_HEIGHT = 844;
  const LIBRARY_COPY_BTN_SVG = '<svg class="icon-copy icon-stroke" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><svg class="icon-done icon-stroke" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
  const LIBRARY_QR_BTN_SVG = '<svg class="icon-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm13 0h2v2h-2v-2zm-2 2h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm0 4h2v2h-2v-2zm2 2h2v2h-2v-2z"/></svg>';

  function libraryPageUrlForOpen() {
    return LIBRARY_PAGE_URL;
  }

  /** 与 library.html itemHref 一致：/library/<cap> */
  function buildLibraryArticleOpenUrl(readCap) {
    const cap = String(readCap || '').trim();
    if (!cap) return '';
    const u = new URL(libraryPageUrlForOpen());
    u.pathname = '/library/' + encodeURIComponent(cap);
    u.search = '';
    u.hash = '';
    return u.toString();
  }

  async function libraryPreviewPopupBounds(parentWindowId) {
    const width = LIBRARY_PREVIEW_WIDTH;
    const height = LIBRARY_PREVIEW_HEIGHT;
    const out = { width, height };
    try {
      const win = parentWindowId != null
        ? await chrome.windows.get(parentWindowId)
        : await chrome.windows.getLastFocused();
      if (win?.left == null || win?.top == null || win?.width == null || win?.height == null) return out;
      out.left = Math.round(win.left + (win.width - width) / 2);
      out.top = Math.round(win.top + (win.height - height) / 2);
    } catch { /* 由系统摆窗 */ }
    return out;
  }

  async function openLibraryArticlePreview(articleUrl, parentWindowId) {
    const href = String(articleUrl || '').trim();
    if (!href) return false;
    try {
      const bounds = await libraryPreviewPopupBounds(parentWindowId);
      await chrome.windows.create({
        url: href,
        type: 'popup',
        focused: true,
        ...bounds,
      });
      return true;
    } catch {
      try {
        await chrome.tabs.create({ url: href });
        return true;
      } catch {
        return false;
      }
    }
  }

  /** 手机打开：?key=…；收藏页同步 localStorage 并保留地址栏 key。 */
  function buildLibraryMobileOpenUrl(pageUrl, apiKey) {
    const key = String(apiKey || '').trim();
    if (!IL_API_KEY_RE.test(key)) return '';
    const u = new URL(String(pageUrl || libraryPageUrlForOpen()));
    u.searchParams.set('key', key);
    return u.toString();
  }

  /** 页内弹窗。func 经 executeScript 序列化，不能闭包外层变量。 */
  const LIBRARY_CLOSE_TAB_KEY = 'ih_library_close_tab';

  function libraryOverlayInstallPage(hostId, css, labels, closeTabDefault, optionKey, copyBtnSvg, qrBtnSvg) {
    const id = String(hostId || 'ih-library-host');
    const key = String(optionKey || '');
    const ariaCopied = labels.copied || 'Copied';
    function libraryPageLinkLabel(url) {
      const s = String(url || '').trim();
      return s.replace(/^https?:\/\//i, '');
    }
    function applyLibraryFootUrl(urlEl, pageUrl) {
      const href = String(pageUrl || '').trim();
      urlEl.textContent = href ? libraryPageLinkLabel(href) : '';
      urlEl.title = href;
    }
    function applyLibraryFootStep(el, text) {
      el.replaceChildren();
      const raw = String(text || '');
      const nl = raw.indexOf('\n');
      if (nl < 0) {
        el.textContent = raw;
        return;
      }
      const title = document.createElement('span');
      title.className = 'ih-lib-foot-step-title';
      title.textContent = raw.slice(0, nl);
      const body = document.createElement('span');
      body.className = 'ih-lib-foot-step-body';
      body.textContent = raw.slice(nl + 1);
      el.append(title, body);
    }
    function makeCopyBtn(ariaCopy) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ih-lib-copy-btn';
      btn.setAttribute('aria-label', ariaCopy);
      btn.innerHTML = String(copyBtnSvg || '');
      let timer = 0;
      btn.addEventListener('click', () => {
        const text = btn.dataset.copyText || '';
        if (!text) return;
        void (async () => {
          try {
            await navigator.clipboard.writeText(text);
            btn.classList.add('is-copied');
            btn.setAttribute('aria-label', ariaCopied);
            clearTimeout(timer);
            timer = setTimeout(() => {
              btn.classList.remove('is-copied');
              btn.setAttribute('aria-label', ariaCopy);
            }, 1200);
          } catch { /* clipboard denied */ }
        })();
      });
      return btn;
    }
    function applyMobileOpenCopy(btn, mobileUrl) {
      if (!btn) return;
      const v = String(mobileUrl || '');
      btn.dataset.copyText = v;
      btn.disabled = !v;
    }
    function drawLibraryQrCanvas(canvas, text) {
      const makeQr = typeof qrcode === 'function' ? qrcode : null;
      if (!canvas || !makeQr) return;
      const payload = String(text || '');
      if (!payload) return;
      const qr = makeQr(0, 'M');
      qr.addData(payload);
      qr.make();
      const n = qr.getModuleCount();
      const pad = 4;
      const scale = 4;
      const dim = (n + pad * 2) * scale;
      canvas.width = dim;
      canvas.height = dim;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, dim, dim);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < n; r += 1) {
        for (let c = 0; c < n; c += 1) {
          if (qr.isDark(r, c)) {
            ctx.fillRect((c + pad) * scale, (r + pad) * scale, scale, scale);
          }
        }
      }
    }
    function applyMobileOpenQr(wrap, btn, canvas, mobileUrl) {
      const v = String(mobileUrl || '');
      if (btn) btn.disabled = !v;
      if (wrap) wrap.classList.toggle('is-off', !v);
      if (v && canvas) drawLibraryQrCanvas(canvas, v);
    }
    function applyLibraryArticlePreview(linkEl, articleUrl) {
      if (!linkEl) return;
      const v = String(articleUrl || '').trim();
      linkEl.dataset.href = v;
      if (v) {
        linkEl.setAttribute('href', v);
        linkEl.removeAttribute('target');
        linkEl.rel = 'noopener noreferrer';
      } else {
        linkEl.setAttribute('href', '#');
        linkEl.removeAttribute('rel');
      }
      linkEl.classList.toggle('is-off', !v);
    }
    function applyLibraryArticleDelete(btnEl, itemId) {
      if (!btnEl) return;
      const v = String(itemId || '').trim();
      btnEl.dataset.id = v;
      btnEl.classList.toggle('is-off', !v);
      btnEl.disabled = false;
    }
    function makeQrPopover(qrLabels) {
      const wrap = document.createElement('span');
      wrap.className = 'ih-lib-qr-wrap is-off';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ih-lib-copy-btn ih-lib-qr-btn';
      btn.disabled = true;
      btn.setAttribute('aria-label', qrLabels.qrCodePhone || 'QR code for phone');
      btn.innerHTML = String(qrBtnSvg || '');
      const pop = document.createElement('div');
      pop.className = 'ih-lib-qr-pop';
      pop.setAttribute('role', 'tooltip');
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      const hint = document.createElement('p');
      hint.className = 'ih-lib-qr-hint';
      hint.textContent = qrLabels.scanQrHint || 'Scan with your phone camera';
      pop.append(canvas, hint);
      wrap.append(btn, pop);
      return { wrap, btn, canvas, hint };
    }
    function buildFoot() {
      const foot = document.createElement('div');
      foot.className = 'ih-lib-foot';
      const introLine = document.createElement('div');
      introLine.className = 'ih-lib-foot-line';
      const footText = document.createElement('div');
      footText.className = 'ih-lib-foot-step';
      introLine.append(footText);
      const linkLine = document.createElement('div');
      linkLine.className = 'ih-lib-foot-line';
      const linkGroup = document.createElement('div');
      linkGroup.className = 'ih-lib-foot-urlbox';
      const urlRow = document.createElement('div');
      urlRow.className = 'ih-lib-foot-urlrow';
      const footUrl = document.createElement('span');
      footUrl.className = 'ih-lib-foot-url';
      const footLinkUrl = String(labels.libraryMobileOpenUrl || '').trim()
        || String(labels.libraryPageUrl || '');
      applyLibraryFootUrl(footUrl, footLinkUrl);
      const copyUrlBtn = makeCopyBtn(labels.copyMobileOpen || 'Copy link for phone');
      applyMobileOpenCopy(copyUrlBtn, labels.libraryMobileOpenUrl);
      const qrUi = makeQrPopover(labels);
      applyMobileOpenQr(qrUi.wrap, qrUi.btn, qrUi.canvas, labels.libraryMobileOpenUrl);
      const footActions = document.createElement('span');
      footActions.className = 'ih-lib-foot-actions';
      footActions.append(copyUrlBtn, qrUi.wrap);
      urlRow.append(footUrl, footActions);
      const footNote = document.createElement('span');
      footNote.className = 'ih-lib-foot-note';
      linkGroup.append(urlRow, footNote);
      linkLine.append(linkGroup);
      const followLine = document.createElement('div');
      followLine.className = 'ih-lib-foot-line';
      const footFollowUp = document.createElement('div');
      footFollowUp.className = 'ih-lib-foot-step';
      followLine.append(footFollowUp);
      foot.append(introLine, linkLine, followLine);
      return {
        foot,
        footText,
        footFollowUp,
        footLink: footUrl,
        copyUrlBtn,
        footNote,
        qrWrap: qrUi.wrap,
        qrBtn: qrUi.btn,
        qrCanvas: qrUi.canvas,
        qrHint: qrUi.hint,
      };
    }
    let host = document.getElementById(id);
    if (host && !host._ihLib) {
      host.remove();
      host = null;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = id;
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = css;
      const backdrop = document.createElement('div');
      backdrop.className = 'ih-lib-backdrop';
      const card = document.createElement('div');
      card.className = 'ih-lib-card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      const title = document.createElement('h3');
      const status = document.createElement('div');
      status.className = 'ih-lib-status';
      status.setAttribute('role', 'log');
      const previewLink = document.createElement('a');
      previewLink.className = 'ih-lib-preview is-off';
      previewLink.href = '#';
      previewLink.addEventListener('click', (e) => {
        if (e.defaultPrevented) return;
        const u = String(previewLink.dataset.href || previewLink.href || '').trim();
        if (!u || u === '#') return;
        e.preventDefault();
        chrome.runtime.sendMessage({ type: 'ih-library-open-preview', url: u });
      });
      const deleteLink = document.createElement('button');
      deleteLink.type = 'button';
      deleteLink.className = 'ih-lib-delete is-off';
      deleteLink.addEventListener('click', (e) => {
        e.preventDefault();
        const id = String(deleteLink.dataset.id || '').trim();
        if (!id || deleteLink.disabled) return;
        deleteLink.disabled = true;
        chrome.runtime.sendMessage({ type: 'ih-library-delete-saved', id }, () => {
          if (String(deleteLink.dataset.id || '').trim()) {
            deleteLink.disabled = false;
          }
        });
      });
      const hint = document.createElement('p');
      hint.className = 'ih-lib-hint';
      const opt = document.createElement('label');
      opt.className = 'ih-lib-opt';
      const check = document.createElement('input');
      check.type = 'checkbox';
      const optText = document.createElement('span');
      opt.append(check, optText);
      const btns = document.createElement('div');
      btns.className = 'ih-lib-btns';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'ih-lib-cancel';
      cancelBtn.addEventListener('click', () => {
        cancelBtn.disabled = true;
        chrome.runtime.sendMessage({ type: 'ih-library-cancel-save' });
      });
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'ih-lib-retry is-off';
      retryBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'ih-library-retry-upload' });
      });
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ih-lib-close is-off';
      closeBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'ih-library-upload-dismiss' });
        host.remove();
        delete window.__IH_LIBRARY_UI;
      });
      btns.append(cancelBtn, retryBtn, closeBtn);
      const built = buildFoot();
      card.append(title, status, hint, opt, btns, built.foot);
      backdrop.append(card);
      shadow.append(style, backdrop);
      (document.documentElement || document.body).appendChild(host);
      host._ihLib = {
        title, status, previewLink, deleteLink, hint, check, optText, cancelBtn, retryBtn, closeBtn, btns, lines: [],
        foot: built.foot,
        footText: built.footText,
        footFollowUp: built.footFollowUp,
        footLink: built.footLink,
        copyUrlBtn: built.copyUrlBtn,
        footNote: built.footNote,
        qrWrap: built.qrWrap,
        qrBtn: built.qrBtn,
        qrCanvas: built.qrCanvas,
        qrHint: built.qrHint,
        applyMobileOpenCopy,
        applyMobileOpenQr,
      };
      check.addEventListener('change', () => {
        if (key) chrome.storage.local.set({ [key]: !!check.checked });
      });
    }
    const ui = host._ihLib;
    function renderLibraryLines() {
      if (ui.previewLink?.parentNode) ui.previewLink.parentNode.removeChild(ui.previewLink);
      if (ui.deleteLink?.parentNode) ui.deleteLink.parentNode.removeChild(ui.deleteLink);
      ui.status.replaceChildren();
      for (const line of ui.lines) {
        if (line.line != null) {
          const row = document.createElement('div');
          row.className = 'ih-lib-line-full';
          if (line.tone === 'success') row.classList.add('is-success');
          if (line.tone === 'error') row.classList.add('is-error');
          const articleUrl = String(ui.previewLink?.dataset.href || '').trim();
          const articleId = String(ui.libraryArticleId || ui.deleteLink?.dataset.id || '').trim();
          const resultActionsReady = line.key === 'result'
            && line.tone === 'success'
            && ui.previewLink
            && ui.deleteLink
            && (articleUrl || articleId);
          if (resultActionsReady) {
            row.classList.add('ih-lib-result-row');
            const msg = document.createElement('span');
            msg.className = 'ih-lib-result-msg';
            msg.textContent = String(line.line);
            const actions = document.createElement('span');
            actions.className = 'ih-lib-result-actions';
            applyLibraryArticlePreview(ui.previewLink, articleUrl);
            applyLibraryArticleDelete(ui.deleteLink, articleId);
            if (articleUrl) actions.append(ui.previewLink);
            if (articleId) actions.append(ui.deleteLink);
            row.append(msg, actions);
          } else {
            row.textContent = String(line.line);
          }
          ui.status.appendChild(row);
          continue;
        }
        const row = document.createElement('div');
        row.className = 'ih-lib-line';
        if (line.tone === 'success') row.classList.add('is-success');
        if (line.tone === 'error') row.classList.add('is-error');
        const lbl = document.createElement('span');
        lbl.className = 'ih-lib-lbl';
        lbl.textContent = String(line.label || '');
        const det = document.createElement('span');
        det.className = 'ih-lib-det';
        if (line.detail != null && line.detail !== '') {
          det.textContent = String(line.detail);
        } else if (line.pending) {
          det.classList.add('ih-lib-dots');
          det.setAttribute('aria-label', '…');
        }
        row.append(lbl, det);
        ui.status.appendChild(row);
      }
    }
    ui.renderLibraryLines = renderLibraryLines;
    ui.title.textContent = labels.title || '';
    if (ui.previewLink) {
      ui.previewLink.textContent = labels.previewSavedArticle || 'Preview';
      applyLibraryArticlePreview(ui.previewLink, labels.libraryArticleUrl || ui.libraryArticleUrl);
    }
    if (ui.deleteLink) {
      ui.deleteLink.textContent = labels.deleteSavedArticle || 'Delete';
      applyLibraryArticleDelete(ui.deleteLink, labels.libraryArticleId || ui.libraryArticleId);
    }
    ui.lines = Array.isArray(labels.lines) ? labels.lines.map((l) => ({ ...l })) : [];
    renderLibraryLines();
    ui.hint.textContent = labels.hint || '';
    ui.hint.classList.remove('is-off');
    ui.optText.textContent = labels.closeTab || '';
    ui.check.checked = !!closeTabDefault;
    ui.cancelBtn.textContent = labels.cancel || 'Cancel';
    ui.retryBtn.textContent = labels.retryUpload || 'Retry upload';
    ui.closeBtn.textContent = labels.close || 'Close';
    if (!ui.copyUrlBtn || !ui.qrWrap || ui.copyKeyBtn || !ui.cancelBtn) {
      ui.foot?.remove();
      const built = buildFoot();
      ui.btns.after(built.foot);
      ui.foot = built.foot;
      ui.footText = built.footText;
      ui.footFollowUp = built.footFollowUp;
      ui.footLink = built.footLink;
      ui.copyUrlBtn = built.copyUrlBtn;
      ui.footNote = built.footNote;
      ui.qrWrap = built.qrWrap;
      ui.qrBtn = built.qrBtn;
      ui.qrCanvas = built.qrCanvas;
      ui.qrHint = built.qrHint;
      delete ui.copyKeyBtn;
      ui.applyMobileOpenCopy = applyMobileOpenCopy;
      ui.applyMobileOpenQr = applyMobileOpenQr;
    }
    applyLibraryFootStep(ui.footText, labels.readOnPhone || '');
    if (ui.footFollowUp) applyLibraryFootStep(ui.footFollowUp, labels.readOnPhoneFollowUp || '');
    if (ui.footNote) ui.footNote.textContent = labels.readOnPhoneNote || '';
    ui.readOnPhoneLink = labels.readOnPhoneLink || '';
    const footLinkUrl = String(labels.libraryMobileOpenUrl || ui.libraryMobileOpenUrl || '').trim()
      || String(labels.libraryPageUrl || '');
    applyLibraryFootUrl(ui.footLink, footLinkUrl);
    ui.applyMobileOpenCopy(
      ui.copyUrlBtn,
      labels.libraryMobileOpenUrl || ui.libraryMobileOpenUrl,
    );
    if (ui.qrHint) ui.qrHint.textContent = labels.scanQrHint || ui.qrHint.textContent;
    if (ui.qrBtn) {
      ui.qrBtn.setAttribute('aria-label', labels.qrCodePhone || ui.qrBtn.getAttribute('aria-label') || '');
    }
    ui.applyMobileOpenQr?.(
      ui.qrWrap,
      ui.qrBtn,
      ui.qrCanvas,
      labels.libraryMobileOpenUrl || ui.libraryMobileOpenUrl,
    );
    ui.retryBtn.classList.add('is-off');
    ui.closeBtn.classList.add('is-off');
    ui.cancelBtn.classList.remove('is-off');
    ui.cancelBtn.disabled = false;
    window.__IH_LIBRARY_UI = (patch) => {
      if (!patch || patch.remove) {
        if (patch?.remove) {
          host.remove();
          delete window.__IH_LIBRARY_UI;
        }
        return { closeTab: !!ui.check.checked };
      }
      if (patch.libraryArticleUrl != null) {
        ui.libraryArticleUrl = String(patch.libraryArticleUrl);
        applyLibraryArticlePreview(ui.previewLink, ui.libraryArticleUrl);
      }
      if (patch.libraryArticleId != null) {
        ui.libraryArticleId = String(patch.libraryArticleId);
        applyLibraryArticleDelete(ui.deleteLink, ui.libraryArticleId);
      }
      const keyed = patch.key != null || patch.label != null || patch.detail != null
        || patch.line != null || patch.pending != null;
      if (patch.status != null && !keyed) {
        ui.lines = [{
          key: '',
          line: String(patch.status),
          tone: patch.phase === 'error' ? 'error' : undefined,
        }];
        ui.renderLibraryLines();
      } else if (keyed) {
        const lineKey = String(patch.key || '');
        const i = lineKey ? ui.lines.findIndex((l) => l.key === lineKey) : -1;
        let next;
        if (patch.line != null) {
          next = { key: lineKey, line: String(patch.line) };
        } else {
          next = {
            key: lineKey,
            label: String(patch.label || ''),
            pending: !!patch.pending,
            detail: patch.detail == null ? '' : String(patch.detail),
          };
        }
        if (patch.phase === 'done' && lineKey === 'result') next.tone = 'success';
        if (patch.phase === 'error') next.tone = 'error';
        if (i >= 0) ui.lines[i] = next;
        else ui.lines.push(next);
        ui.renderLibraryLines();
      }
      if (patch.showRetry != null) {
        ui.retryBtn.classList.toggle('is-off', !patch.showRetry);
      }
      if (patch.libraryMobileOpenUrl != null) {
        ui.libraryMobileOpenUrl = String(patch.libraryMobileOpenUrl);
        ui.applyMobileOpenCopy?.(ui.copyUrlBtn, ui.libraryMobileOpenUrl);
        ui.applyMobileOpenQr?.(ui.qrWrap, ui.qrBtn, ui.qrCanvas, ui.libraryMobileOpenUrl);
        if (ui.libraryMobileOpenUrl) {
          applyLibraryFootUrl(ui.footLink, ui.libraryMobileOpenUrl);
        }
      }
      if (patch.libraryArticleUrl != null || patch.libraryArticleId != null) {
        ui.renderLibraryLines();
      }
      if (patch.phase === 'done' || patch.phase === 'error') {
        ui.hint.classList.add('is-off');
        ui.cancelBtn?.classList.add('is-off');
        ui.cancelBtn.disabled = false;
        ui.closeBtn?.classList.remove('is-off');
        ui.btns.classList.remove('is-off');
      } else if (patch.phase === 'run') {
        ui.hint.classList.remove('is-off');
        applyLibraryArticlePreview(ui.previewLink, '');
        applyLibraryArticleDelete(ui.deleteLink, '');
        ui.cancelBtn?.classList.remove('is-off');
        ui.cancelBtn.disabled = false;
        ui.closeBtn?.classList.add('is-off');
        ui.retryBtn.classList.add('is-off');
        ui.btns.classList.remove('is-off');
      }
      if (patch.phase === 'error') {
        applyLibraryArticlePreview(ui.previewLink, '');
        applyLibraryArticleDelete(ui.deleteLink, '');
      }
      return { closeTab: !!ui.check.checked };
    };
    return window.__IH_LIBRARY_UI({ phase: 'run' });
  }

  function libraryOverlayPatchPage(patch) {
    return window.__IH_LIBRARY_UI?.(patch) || null;
  }

  async function libraryOverlayOpen(tabId, labels, closeTabDefault) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ['vendor/qrcodegen.js'],
      });
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: libraryOverlayInstallPage,
        args: [
          LIBRARY_HOST_ID,
          LIBRARY_OVERLAY_CSS,
          labels,
          !!closeTabDefault,
          LIBRARY_CLOSE_TAB_KEY,
          LIBRARY_COPY_BTN_SVG,
          LIBRARY_QR_BTN_SVG,
        ],
      });
      return !!results?.[0]?.result;
    } catch {
      return false;
    }
  }

  async function libraryOverlayPatch(tabId, patch) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: libraryOverlayPatchPage,
        args: [patch],
      });
      return results?.[0]?.result || null;
    } catch {
      return null;
    }
  }

  function libraryLogPending(tabId, key, label) {
    return libraryOverlayPatch(tabId, { key, label, pending: true });
  }

  function libraryLog(tabId, key, label, detail) {
    return libraryOverlayPatch(tabId, { key, label, detail, pending: false });
  }

  async function installLibraryBeforeUnload(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => {
          if (window.__IH_LIBRARY_BU__) return;
          window.__IH_LIBRARY_BU__ = (e) => {
            e.preventDefault();
            e.returnValue = '';
          };
          window.addEventListener('beforeunload', window.__IH_LIBRARY_BU__);
        },
      });
    } catch {
      /* ignore */
    }
  }

  async function clearLibraryBeforeUnload(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => {
          if (!window.__IH_LIBRARY_BU__) return;
          window.removeEventListener('beforeunload', window.__IH_LIBRARY_BU__);
          delete window.__IH_LIBRARY_BU__;
        },
      });
    } catch {
      /* ignore */
    }
  }

  const librarySaving = new Set();
  /** @type {Map<number, { apiKey: string, libraryBody: string, overlayOn: boolean, tab: chrome.tabs.Tab }>} */
  const libraryUploadStash = new Map();
  async function postLibraryToServer(tabId, apiKey, libraryBody, run) {
    libraryThrowIfCancelled(tabId, run);
    await libraryLogPending(tabId, 'result', tr('Upload'));
    const res = await postLibraryJson('/v1/library', apiKey, libraryBody);
    libraryThrowIfCancelled(tabId, run);
    if (!res.ok) {
      let msg = `Upload failed (${res.status})`;
      let maxItems;
      try {
        const err = await res.json();
        msg = err?.error || err?.message || msg;
        if (Number.isInteger(err?.maxItems)) maxItems = err.maxItems;
      } catch { /* ignore */ }
      libraryUploadStash.delete(tabId);
      const thrown = new Error(msg);
      if (maxItems != null) thrown.maxItems = maxItems;
      throw thrown;
    }
    try {
      const data = await res.json();
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  async function libraryOverlayFinish(tabId, overlayOn, patch) {
    await clearLibraryBeforeUnload(tabId);
    const ui = overlayOn ? await libraryOverlayPatch(tabId, patch) : null;
    if (ui && 'closeTab' in ui) {
      await chrome.storage.local.set({ [LIBRARY_CLOSE_TAB_KEY]: !!ui.closeTab });
    }
    return ui;
  }

  /**
   * @param {chrome.tabs.Tab} uiTab 进度弹窗、取消、重试所绑定的标签（通常是用户当前页）
   * @param {number} workTabId 注入、分析、快照的标签（可与 uiTab 相同）
   * @param {{ sourceUrl?: string, overlayTitle?: string, captureMode?: 'auto' | 'full' | 'reader', skipAnalyze?: boolean, hostPermPromise?: Promise<boolean> }} [options]
   */
  async function runPhoneLibrarySave(uiTab, workTabId, options = {}) {
    if (!uiTab?.id || workTabId == null) return;
    const uiTabId = uiTab.id;
    if (librarySaving.has(uiTabId)) return;
    librarySaving.add(uiTabId);
    const run = librarySaveRunStart(uiTabId);
    IL_setActionIconDotted(false);
    let overlayOn = false;
    let sizeMsg = '';
    try {
      if (options.hostPermPromise) {
        await options.hostPermPromise.catch(() => false);
      }
      const url = (options.sourceUrl || uiTab.url || '').trim();
      if (librarySaveBlockedUrl(url)) return;
      const stored = await chrome.storage.local.get(IH_optionDefaults);
      const skipAnalyze = options.skipAnalyze === true;
      const overlayLines = skipAnalyze
        ? [
          { key: 'capture', label: tr('Capture'), pending: true },
          { key: 'page', label: tr('Page'), pending: true },
        ]
        : [
          { key: 'capture', label: tr('Capture'), pending: true },
          { key: 'analyze', label: tr('Analyze'), pending: true },
          { key: 'page', label: tr('Page'), pending: true },
        ];
      overlayOn = await libraryOverlayOpen(uiTabId, {
        title: options.overlayTitle || tr('Save to phone'),
        lines: overlayLines,
        hint: tr("Don't close this tab."),
        closeTab: tr('Close this tab when done'),
        cancel: tr('Cancel'),
        close: tr('Close'),
        retryUpload: tr('Retry upload'),
        readOnPhone: tr('First time on your phone:\ncopy the link below and open it in your phone browser to view your Info Highlight library list.'),
        readOnPhoneFollowUp: tr('Later on your phone:\nbookmark this page on your phone and open it from bookmarks each time (signs in automatically).'),
        readOnPhoneNote: tr('The link includes your API key and is tied to your cloud credits. Keep it private.'),
        readOnPhoneLink: tr('Open library'),
        libraryPageUrl: libraryPageUrlForOpen(),
        libraryMobileOpenUrl: '',
        copyMobileOpen: tr('Copy link for phone'),
        qrCodePhone: tr('QR code to open on phone'),
        scanQrHint: tr('Scan with your phone camera'),
        copied: tr('Copied'),
        previewSavedArticle: tr('Preview'),
        deleteSavedArticle: tr('Delete'),
      }, !!IH_optionStored(LIBRARY_CLOSE_TAB_KEY, stored[LIBRARY_CLOSE_TAB_KEY]));
      await installLibraryBeforeUnload(uiTabId);

      let apiKey;
      try {
        apiKey = await IL_getApiKey();
      } catch {
        apiKey = '';
      }
      if (!IL_API_KEY_RE.test(apiKey || '')) {
        const status = tr('Set an API key in Options before saving to phone.');
        if (!(await libraryOverlayFinish(uiTabId, overlayOn, { phase: 'error', status }))) {
          await pageAlert(uiTabId, status);
        }
        return;
      }
      if (overlayOn) {
        await libraryOverlayPatch(uiTabId, {
          libraryMobileOpenUrl: buildLibraryMobileOpenUrl(libraryPageUrlForOpen(), apiKey),
        });
      }

      libraryThrowIfCancelled(uiTabId, run);
      const captureMode = await resolveLibraryCaptureMode(workTabId, options.captureMode);
      const captureDetail = captureMode === 'full' ? tr('Original page') : tr('Reader view');
      await libraryLog(uiTabId, 'capture', tr('Capture'), captureDetail);

      if (!skipAnalyze) {
        if (!(await ensureLibraryAnalyzed(workTabId))) {
          libraryThrowIfCancelled(uiTabId, run);
          throw new Error('refresh this page');
        }
        libraryThrowIfCancelled(uiTabId, run);
        await libraryLog(uiTabId, 'analyze', tr('Analyze'), tr('Done'));
        await libraryLogPending(uiTabId, 'page', tr('Page'));
      } else {
        await libraryLogPending(uiTabId, 'page', tr('Page'));
      }
      const capture = captureMode === 'reader'
        ? () => captureLibraryReaderArticle(workTabId, url)
        : () => captureLibraryArticle(workTabId);
      const { title, html: rawSnap } = await capture();
      libraryThrowIfCancelled(uiTabId, run);
      const withCss = rewriteLibraryInlineStyleUrls(rawSnap, url);
      await libraryLog(uiTabId, 'page', tr('Page'), librarySizeLabel(rawSnap.length));
      const cssDelta = withCss.length - rawSnap.length;
      if (cssDelta) {
        await libraryLog(uiTabId, 'style', tr('Style'), librarySizeLabel(cssDelta));
      }
      await libraryLogPending(uiTabId, 'images', tr('Images'));
      const inlined = await inlineLibraryHttpImages(withCss, url, () => librarySaveStill(uiTabId, run));
      libraryThrowIfCancelled(uiTabId, run);
      const contentHtml = inlined.html;
      sizeMsg = libraryContentSizeMsg(
        rawSnap.length,
        withCss.length,
        contentHtml.length,
        inlined.imagesCap,
      );
      await libraryLog(
        uiTabId,
        'images',
        tr('Images'),
        libraryImagesLogDetail(contentHtml.length - withCss.length, inlined.imagesCap),
      );
      await libraryLog(
        uiTabId,
        'total',
        tr('Total'),
        libraryTotalLogDetail(contentHtml.length, inlined.imagesCap),
      );
      if (contentHtml.length > LIBRARY_MAX_CONTENT_CHARS) {
        throw new Error('contentHtml too large');
      }

      const libraryBody = JSON.stringify({
        title: (title || uiTab.title || 'Untitled').slice(0, 500),
        sourceUrl: url.slice(0, 2000),
        contentHtml,
      });
      libraryUploadStash.set(uiTabId, { apiKey, libraryBody, overlayOn, tab: uiTab });
      const created = await postLibraryToServer(uiTabId, apiKey, libraryBody, run);
      libraryUploadStash.delete(uiTabId);

      const ui = await libraryOverlayFinish(uiTabId, overlayOn, {
        phase: 'done',
        key: 'result',
        line: tr('Saved to cloud. Open on your phone.'),
        showRetry: false,
        libraryArticleUrl: buildLibraryArticleOpenUrl(created?.c),
        libraryArticleId: created?.id || '',
      });
      if (ui?.closeTab) {
        try { await chrome.tabs.remove(uiTabId); } catch { /* already gone */ }
      }
    } catch (err) {
      if (libraryIsCancelled(err) || !librarySaveStill(uiTabId, run)) {
        libraryUploadStash.delete(uiTabId);
        if (!(await libraryOverlayFinish(uiTabId, overlayOn, {
          phase: 'error',
          key: 'result',
          line: tr('Save cancelled.'),
          showRetry: false,
        }))) {
          /* overlay off */
        }
        return;
      }
      const retryable = libraryUploadStash.has(uiTabId) && isLibraryUploadNetworkError(err);
      const status = tr('Could not save to phone: {err}', { err: librarySaveErrDetail(err) });
      if (!(await libraryOverlayFinish(uiTabId, overlayOn, {
        phase: 'error',
        key: 'result',
        line: status,
        showRetry: retryable,
      }))) {
        await pageAlert(uiTabId, libraryProgressText(status, sizeMsg));
      }
    } finally {
      librarySaving.delete(uiTabId);
    }
  }

  async function saveToPhone(tab, hostPermPromise) {
    if (!tab?.id) return;
    await runPhoneLibrarySave(tab, tab.id, { captureMode: 'auto', hostPermPromise });
  }

  async function deleteSavedLibraryArticle(tabId, itemId) {
    const id = String(itemId || '').trim();
    if (!id || tabId == null) return { ok: false, error: 'missing id' };
    let apiKey;
    try {
      apiKey = await IL_getApiKey();
    } catch {
      apiKey = '';
    }
    if (!IL_API_KEY_RE.test(apiKey || '')) {
      return { ok: false, error: tr('Set an API key in Options before saving to phone.') };
    }
    const del = await deleteLibraryItem(apiKey, id);
    if (!del.ok) {
      const err = del.error || String(del.status || '');
      await pageAlert(tabId, tr('Could not delete from cloud: {err}', { err }));
      return { ok: false, error: err };
    }
    await libraryOverlayPatch(tabId, {
      phase: 'done',
      key: 'result',
      line: tr('Removed from cloud library.'),
      libraryArticleUrl: '',
      libraryArticleId: '',
    });
    return { ok: true };
  }

  async function retryLibraryUpload(tabId) {
    const stash = libraryUploadStash.get(tabId);
    if (!stash || librarySaving.has(tabId)) return;
    const { apiKey, libraryBody, overlayOn } = stash;
    librarySaving.add(tabId);
    const run = librarySaveRunStart(tabId);
    try {
      await installLibraryBeforeUnload(tabId);
      await libraryOverlayPatch(tabId, { phase: 'run', showRetry: false });
      const created = await postLibraryToServer(tabId, apiKey, libraryBody, run);
      libraryUploadStash.delete(tabId);
      const ui = await libraryOverlayFinish(tabId, overlayOn, {
        phase: 'done',
        key: 'result',
        line: tr('Saved to cloud. Open on your phone.'),
        showRetry: false,
        libraryArticleUrl: buildLibraryArticleOpenUrl(created?.c),
        libraryArticleId: created?.id || '',
      });
      if (ui?.closeTab) {
        try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
      }
    } catch (err) {
      const retryable = libraryUploadStash.has(tabId) && isLibraryUploadNetworkError(err);
      const status = tr('Could not save to phone: {err}', { err: librarySaveErrDetail(err) });
      if (!(await libraryOverlayFinish(tabId, stash.overlayOn, {
        phase: 'error',
        key: 'result',
        line: status,
        showRetry: retryable,
      }))) {
        await pageAlert(tabId, status);
      }
    } finally {
      librarySaving.delete(tabId);
    }
  }

  function handleRuntimeMessage(msg, sender, sendResponse) {
    if (msg?.type === 'ih-library-upload-dismiss') {
      const tabId = sender.tab?.id;
      if (tabId) libraryUploadStash.delete(tabId);
      return false;
    }
    if (msg?.type === 'ih-library-cancel-save') {
      const tabId = sender.tab?.id;
      if (tabId && librarySaving.has(tabId)) {
        librarySaveCancelRun(tabId);
        void libraryAbortPageAnalyze(tabId);
      }
      return false;
    }
    if (msg?.type === 'ih-library-open-preview') {
      const url = String(msg.url || '').trim();
      const parentWindowId = sender.tab?.windowId;
      void openLibraryArticlePreview(url, parentWindowId).then((ok) => sendResponse({ ok }));
      return true;
    }
    if (msg?.type === 'ih-library-delete-saved') {
      const tabId = sender.tab?.id;
      const id = String(msg.id || '').trim();
      void deleteSavedLibraryArticle(tabId, id).then(sendResponse);
      return true;
    }
    if (msg?.type !== 'ih-library-retry-upload') return false;
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'no tab' });
      return true;
    }
    void retryLibraryUpload(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  function createMenu() {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: tr('Save to phone (read later)'),
      contexts: ['page', 'action'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  }

  function handleClick(info, tab) {
    if (info.menuItemId !== MENU_ID) return false;
    const hostPermPromise = IH_autoSites.requestAllSitesPermission();
    void saveToPhone(tab, hostPermPromise);
    return true;
  }

  globalThis.IH_library = {
    MENU_ID,
    saveBlockedUrl: librarySaveBlockedUrl,
    createMenu,
    handleClick,
    saveToPhone,
    runPhoneLibrarySave,
    abortPageAnalyze: libraryAbortPageAnalyze,
    isSaving: (tabId) => librarySaving.has(tabId),
    handleRuntimeMessage,
  };
})();
