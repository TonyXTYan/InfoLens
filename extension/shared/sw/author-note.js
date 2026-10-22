/** 选项页 About 留言 → /api/extension-feedback */
const IL_AUTHOR_NOTE_MESSAGE_MAX = 4000;
const IL_AUTHOR_NOTE_CONTACT_MAX = 200;

globalThis.IL_postAuthorNote = async function IL_postAuthorNote(extension, msg) {
  const message = String(msg?.message ?? '').trim().slice(0, IL_AUTHOR_NOTE_MESSAGE_MAX);
  const images = Array.isArray(msg?.images) ? msg.images : [];
  if (!message && images.length === 0) throw new Error('Missing message');
  const contact = String(msg?.contact ?? '').trim().slice(0, IL_AUTHOR_NOTE_CONTACT_MAX);
  const client_id = await IL_getClientId();
  if (!client_id) throw new Error('Missing client id');
  const body = {
    extension,
    extension_version: chrome.runtime.getManifest().version,
    client_id,
  };
  if (message) body.message = message;
  if (images.length) body.images = images;
  if (contact) body.contact = contact;
  const res = await fetch(`${IL_API_BASE}/api/extension-feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success || data.stored === false) {
    throw new Error('Could not send');
  }
};
