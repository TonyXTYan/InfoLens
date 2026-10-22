/**
 * 分析 / 本机相关错误：给用户看的短句（不贴 ORT / WebGPU / HTTP 等原文）。
 * 技术细节留在 throw 的 message 里，由用量 / 反馈上报；页内只经 pageAnalyzeError 展示。
 */
globalThis.IH_userErrors ||= (function () {
  const { tr } = globalThis.IH_i18n;
  const SWITCH_PREF =
    'In extension options, choose a cloud model, or tap Prepare for the on-device model.';

  const GENERIC_FAIL = 'Analysis could not finish. Try again.';
  const SERVER_FAIL = 'The analyze server returned an error. Try again later.';
  const NETWORK_FAIL = 'Cannot reach the analyze server. Try again later.';
  const PAGE_LOST =
    'Connection to this page was lost. Refresh the page and try again.';
  const PAGE_CHANGED = 'The page changed while highlighting. Run analysis again.';
  const PDF_NO_TEXT = 'This PDF has no text to highlight.';
  const BUSY_MSG =
    'Info Highlight is still analyzing this page. Try again when it finishes.';
  /** 分析失败条：固定英文，不走 i18n。 */
  const MSG_ALIGN =
    'On-device scoring could not match this text. Try a cloud model in extension options, or another on-device model.';
  const MSG_NO_HIGHLIGHTS =
    'No highlights could be placed on this page. Try again or choose another model in extension options.';

  function norm(msg) {
    return String(msg || '').replace(/\s+/g, ' ').trim();
  }

  function isGpuRelated(msg) {
    const s = norm(msg).toLowerCase();
    return (
      s.includes('webgpu')
      || s.includes('gpu adapter')
      || s.includes('no available backend')
      || s === 'webgpu is unavailable'
      || s.includes('on-device webgpu is unavailable')
    );
  }

  function isNetworkRelated(msg) {
    return /Failed to fetch|NetworkError|ERR_CONNECTION|Cannot reach /i.test(norm(msg));
  }

  function isEngineTransport(msg) {
    const s = norm(msg).toLowerCase();
    return (
      /local (engine|model|analyze)/.test(s)
      || s.includes('offscreen')
      || s.includes('receiving end does not exist')
      || s.includes('message port closed')
      || s.includes('local model init failed')
      || s.includes('webgpu probe failed')
      || s.includes('local engine status failed')
      || s.includes('local model reload failed')
    );
  }

  function isServerResponse(msg) {
    const t = norm(msg);
    return (
      /^http \d+/i.test(t)
      || /expected application\/json/i.test(t)
      || /malformed json/i.test(t)
      || /empty response/i.test(t)
    );
  }

  function isExtensionMessaging(msg) {
    const t = norm(msg).toLowerCase();
    return (
      t.includes('message channel closed')
      || t.includes('asynchronous response')
      || t.includes('receiving end does not exist')
      || t.includes('message port closed')
    );
  }

  /** background / options 已写给人看的整句，原样展示 */
  function isUserFacingLine(t) {
    return (
      t === BUSY_MSG
      || /you chose on-device only/i.test(t)
      || /this computer cannot run the on-device model/i.test(t)
      || /on-device analysis/i.test(t)
      || /cannot reach the analyze server/i.test(t)
      || /analyze server returned an error/i.test(t)
      || /could not find a main article/i.test(t)
      || t === MSG_ALIGN
      || t === MSG_NO_HIGHLIGHTS
      || /on-device scoring could not match this text/i.test(t)
      || /no highlights could be placed on this page/i.test(t)
      || /could not read this page/i.test(t)
      || /no readable article text/i.test(t)
      || /connection to this page was lost/i.test(t)
      || /page changed while highlighting/i.test(t)
      || /this pdf has no text/i.test(t)
      || t === GENERIC_FAIL
      || /choose a cloud model/i.test(t)
      || /tap prepare for the on-device model/i.test(t)
    );
  }

  function contentMessage(msg) {
    const t = norm(msg);
    if (t === 'No article text') return 'No readable article text on this page.';
    if (t === 'Readability: no mappable article root') {
      return 'Could not find a main article on this page.';
    }
    if (t === 'Readability: parse failed') return 'Could not read this page.';
    if (t.includes('token offset align failed')) return MSG_ALIGN;
    if (
      t === 'No tokens mapped onto the page'
      || t.startsWith('No tokens mapped onto the page')
      || t === 'No tokens mapped onto the PDF text layer'
      || t.startsWith('No tokens mapped onto the PDF text layer')
    ) {
      return MSG_NO_HIGHLIGHTS;
    }
    if (/PDF has no selectable text/i.test(t)) return PDF_NO_TEXT;
    if (t === BUSY_MSG) return BUSY_MSG;
    return '';
  }

  function localOnlyBlock(st) {
    const choice = globalThis.IH_localState?.CHOICES?.find((c) => c.id === st?.choice);
    if (!choice?.local) return '';
    if (st.webgpuOk === false) return gpuUnavailableShort();
    if (!st.ready) {
      return `The on-device model is not ready, and you chose on-device only. ${SWITCH_PREF}`;
    }
    return '';
  }

  function localOnlyFailure(err) {
    const raw = norm(err?.message || err);
    const content = contentMessage(raw);
    if (content) return content;
    if (isGpuRelated(raw)) return gpuUnavailableShort();
    if (isNetworkRelated(raw)) {
      return `On-device analysis could not finish (network). ${SWITCH_PREF}`;
    }
    if (isEngineTransport(raw)) {
      return `On-device analysis did not finish. ${SWITCH_PREF}`;
    }
    if (isServerResponse(raw)) {
      return `On-device analysis could not reach the server. ${SWITCH_PREF}`;
    }
    if (/^on-device analysis failed:/i.test(raw)) {
      return localOnlyFailure({ message: raw.replace(/^on-device analysis failed:\s*/i, '') });
    }
    return `On-device analysis did not finish. ${SWITCH_PREF}`;
  }

  function webgpuBlockReasonLine(reason) {
    switch (reason) {
      case globalThis.IH_localState?.WEBGPU_BLOCK?.no_api:
        return tr('This browser does not expose WebGPU.');
      case globalThis.IH_localState?.WEBGPU_BLOCK?.no_adapter:
        return tr('No compatible GPU adapter was found.');
      case globalThis.IH_localState?.WEBGPU_BLOCK?.no_shader_f16:
        return tr('This GPU does not support half-precision shaders (shader-f16), which the on-device model needs.');
      case globalThis.IH_localState?.WEBGPU_BLOCK?.device_failed:
        return tr('Could not open a GPU device.');
      case globalThis.IH_localState?.WEBGPU_BLOCK?.probe_failed:
        return tr('Could not verify WebGPU.');
      case globalThis.IH_localState?.WEBGPU_BLOCK?.runtime_failed:
        return tr('The GPU stopped responding during a recent analysis.');
      default:
        return '';
    }
  }

  function webgpuStatusLine(st) {
    const webgpuOk = st && typeof st === 'object' && 'webgpuOk' in st ? st.webgpuOk : st;
    const blockReason = st && typeof st === 'object' ? st.webgpuBlockReason : null;
    if (webgpuOk === true) return tr('Available');
    if (webgpuOk === false) {
      const why = webgpuBlockReasonLine(blockReason);
      return why ? `${tr('Not available')}\n${why}` : tr('Not available');
    }
    return tr('Not checked yet');
  }

  function setLocalPrefBlocked() {
    return 'On-device analysis is not available on this computer.';
  }

  function gpuUnavailableShort() {
    return 'This computer cannot run the on-device model.';
  }

  /** 页内失败条：一律笼统归类；不展示技术关键词。 */
  function pageAnalyzeError(msg) {
    const t = norm(msg);
    if (!t) return GENERIC_FAIL;
    // 旧版 localOnlyFailure 曾 tr() 成中文，避免再掉进 GENERIC_FAIL
    if (t.includes('本机打分无法与这段正文对齐')) return MSG_ALIGN;
    if (t.includes('无法在本页画上高亮')) return MSG_NO_HIGHLIGHTS;
    if (/custom cloud api url is missing or invalid/i.test(t)) {
      return tr('Custom cloud API URL is missing or invalid. Open extension settings to fix it.');
    }
    if (isUserFacingLine(t)) return t;

    const content = contentMessage(t);
    if (content) return content;

    if (t === 'Cancelled') return GENERIC_FAIL;
    if (isNetworkRelated(t) || /^cannot reach /i.test(t)) return NETWORK_FAIL;
    if (isServerResponse(t)) return SERVER_FAIL;
    if (/only default model/i.test(t)) {
      return 'Cloud analysis is not available with the chosen model. Use the default in extension options.';
    }
    if (isExtensionMessaging(t)) return PAGE_LOST;
    if (/Failed to execute 'setEnd' on 'Range'/i.test(t)) return PAGE_CHANGED;
    if (/invalid value for bounds/i.test(t)) {
      return 'Could not open the preparation window. Try again from the toolbar.';
    }
    if (/css custom highlight api missing/i.test(t)) {
      return 'This browser cannot show highlights on this page.';
    }
    if (isGpuRelated(t)) return gpuUnavailableShort();
    if (/^on-device analysis failed:/i.test(t)) {
      return localOnlyFailure({ message: t.replace(/^on-device analysis failed:\s*/i, '') });
    }
    if (/^local analyze failed:/i.test(t)) {
      const inner = contentMessage(t.replace(/^local analyze failed:\s*/i, ''));
      if (inner) return inner;
    }
    if (isEngineTransport(t) || /^local analyze failed/i.test(t)) {
      return 'On-device analysis did not finish. Choose a cloud model in options.';
    }
    // SYNC: background.js FREE_API_RATE_LIMITED
    if (t === 'free api rate limited' || t === 'rate limit exceeded') {
      return tr('Too many free API requests. Please try again later.');
    }
    if (/analyze returned no tokens/i.test(t)) return SERVER_FAIL;
    if (/^analyze failed/i.test(t) && !/^local analyze failed/i.test(t)) return SERVER_FAIL;
    if (/IO error:|FILE_ERROR_NO_SPACE/i.test(t)) {
      return 'On-device analysis could not finish. Free disk space, or choose a cloud model in options.';
    }
    return GENERIC_FAIL;
  }

  /** 再跑一次可能成功：连不上、上游错误、以及归不成具体原因的失败。 */
  function isRetryable(msg) {
    const shown = pageAnalyzeError(msg);
    return shown === NETWORK_FAIL || shown === SERVER_FAIL || shown === GENERIC_FAIL;
  }

  return {
    localOnlyBlock,
    localOnlyFailure,
    webgpuStatusLine,
    setLocalPrefBlocked,
    gpuUnavailableShort,
    pageAnalyzeError,
    isRetryable,
    isGpuRelated,
  };
})();
