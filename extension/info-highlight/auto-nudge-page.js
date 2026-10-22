(async () => {
  const agreeBtn = document.getElementById('agree');
  const laterBtn = document.getElementById('later');
  const muteBtn = document.getElementById('mute');
  const titleEl = document.getElementById('title');
  if (!agreeBtn || !laterBtn || !muteBtn || !titleEl) {
    throw new Error('auto-nudge page missing required elements');
  }
  if (!globalThis.IH_autoSites) {
    throw new Error('IH_autoSites missing — inject auto-sites.js before auto-nudge-page.js');
  }
  if (!globalThis.IH_autoNudge) {
    throw new Error('IH_autoNudge missing — inject auto-nudge.js before auto-nudge-page.js');
  }

  const name = chrome.runtime.getManifest().name;
  if (!name) throw new Error('manifest name missing');
  document.title = name;

  const host = globalThis.IH_autoSites.parseHost(new URLSearchParams(location.search).get('host') || '');
  if (!host || host.includes('*')) {
    window.close();
    return;
  }
  titleEl.textContent = globalThis.IH_i18n.tr('Always analyze {host}?', { host });

  const N = globalThis.IH_autoNudge;

  agreeBtn.addEventListener('click', async () => {
    const granted = await globalThis.IH_autoSites.requestAllSitesPermission();
    if (!granted) {
      window.close();
      return;
    }
    await globalThis.IH_autoSites.add(host);
    window.close();
  });

  laterBtn.addEventListener('click', () => {
    window.close();
  });

  muteBtn.addEventListener('click', async () => {
    const gate = await N.loadGate();
    await N.saveGate(N.mute(gate));
    window.close();
  });

  const [counts, gate] = await Promise.all([N.loadCounts(), N.loadGate()]);
  await N.saveGate(N.later(gate, host, counts.hosts[host] || 0));
})();
