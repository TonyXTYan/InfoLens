(() => {
  const closeBtn = document.getElementById('close');
  if (!closeBtn) throw new Error('restricted-page missing required elements');
  const name = chrome.runtime.getManifest().name;
  if (!name) throw new Error('manifest name missing');
  document.title = name;
  closeBtn.addEventListener('click', () => window.close());
})();
