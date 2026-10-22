(() => {
  const { tr } = globalThis.IH_i18n;
  const agreeBtn = document.getElementById('agree');
  const refuseBtn = document.getElementById('refuse');
  const hideBtn = document.getElementById('hide');
  const cancelBtn = document.getElementById('cancel');
  const closeBtn = document.getElementById('close');
  const statusEl = document.getElementById('status');
  const bar = document.getElementById('bar');
  const leadEl = document.getElementById('lead');
  const hubSel = document.getElementById('model_hub');
  if (!agreeBtn || !refuseBtn || !hideBtn || !cancelBtn || !closeBtn || !statusEl || !bar || !leadEl || !hubSel) {
    throw new Error('init page missing required elements');
  }
  if (!globalThis.IH_localState) {
    throw new Error('IH_localState missing — inject state.js before init.js');
  }

  let localOnly = false;
  let wantProgress = false;
  const localOpt = document.getElementById('hub_local');
  if (localOpt && globalThis.IH_localState.localHubEnabled()) {
    localOpt.hidden = false;
  }

  globalThis.IH_localState.get().then((st) => {
    localOnly = globalThis.IH_localState.choiceById(st.choice).local;
    hubSel.value = globalThis.IH_localState.normalizeHub(st.hub);
    const spec = globalThis.IH_localState.localSpec(
      globalThis.IH_localState.onDeviceStatusModelId(st.choice, st.runtime),
    );
    leadEl.textContent = tr('This downloads about {size} ({model} {dtype}) and keeps it on this computer.', {
      model: spec.label,
      dtype: spec.dtype,
      size: spec.initDownloadSize,
    });
  });

  hubSel.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'ih-local-set-hub', hub: hubSel.value }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        globalThis.IH_localState.get().then((st) => {
          hubSel.value = globalThis.IH_localState.normalizeHub(st.hub);
        });
      }
    });
  });

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  function doneButtons() {
    agreeBtn.hidden = true;
    refuseBtn.hidden = true;
    hideBtn.hidden = true;
    cancelBtn.hidden = true;
    closeBtn.hidden = false;
    bar.hidden = true;
    wantProgress = false;
  }

  function restoreActions() {
    agreeBtn.hidden = false;
    refuseBtn.hidden = false;
    agreeBtn.disabled = false;
    refuseBtn.disabled = false;
    hubSel.disabled = false;
    hideBtn.hidden = true;
    cancelBtn.hidden = true;
    cancelBtn.disabled = false;
    bar.hidden = true;
    wantProgress = false;
  }

  function showDownloading() {
    agreeBtn.hidden = true;
    refuseBtn.hidden = true;
    hideBtn.hidden = false;
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
    wantProgress = true;
  }

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function onProgress(info) {
    if (!wantProgress || !info || typeof info !== 'object') return;
    const status = info.status;
    const file = info.file || info.name || '';
    if (status === 'progress' && Number.isFinite(info.loaded) && Number.isFinite(info.total) && info.total > 0) {
      bar.hidden = false;
      bar.max = info.total;
      bar.value = info.loaded;
      setStatus(tr('Downloading {file} · {loaded} / {total}', {
        file, loaded: formatBytes(info.loaded), total: formatBytes(info.total),
      }));
      return;
    }
    if (status === 'initiate' || status === 'download') {
      bar.hidden = false;
      bar.removeAttribute('value');
      setStatus(file ? tr('Preparing {file}', { file }) : tr('Preparing download'));
      return;
    }
    if (status === 'done') {
      setStatus(file ? tr('Got {file}', { file }) : tr('Download complete'));
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'ih-local-progress') onProgress(msg.info);
  });

  agreeBtn.addEventListener('click', async () => {
    agreeBtn.disabled = true;
    refuseBtn.disabled = true;
    hubSel.disabled = true;
    setStatus(tr('Preparing on-device model…'));
    try {
      const granted = await chrome.permissions.request({
        origins: globalThis.IH_localState.hubOrigins(hubSel.value),
      });
      if (!granted) throw new Error(tr('Download was not authorized'));
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'ih-local-set-hub', hub: hubSel.value }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res?.ok) reject(new Error(res?.error || tr('Failed to switch download source')));
          else resolve(res);
        });
      });
    } catch (err) {
      setStatus(err?.message || String(err));
      restoreActions();
      return;
    }
    showDownloading();
    chrome.runtime.sendMessage({ type: 'ih-local-agree' }, (res) => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message);
        restoreActions();
        return;
      }
      if (res?.cancelled) {
        setStatus(tr('Download stopped.'));
        restoreActions();
        return;
      }
      if (!res?.ok) {
        setStatus(res?.error || tr('Setup failed'));
        restoreActions();
        return;
      }
      setStatus(localOnly
        ? tr('On-device model is ready. You can close this window. Later toolbar clicks will analyze on this device only.')
        : tr('On-device model is ready. You can close this window.'));
      doneButtons();
    });
  });

  refuseBtn.addEventListener('click', () => {
    window.close();
  });

  hideBtn.addEventListener('click', () => window.close());

  cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    wantProgress = false;
    setStatus(tr('Stopping download…'));
    chrome.runtime.sendMessage({ type: 'ih-local-cancel-init' }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        setStatus(chrome.runtime.lastError?.message || res?.error || tr('Failed to stop download'));
        cancelBtn.disabled = false;
        wantProgress = true;
      }
    });
  });

  closeBtn.addEventListener('click', () => window.close());
})();
