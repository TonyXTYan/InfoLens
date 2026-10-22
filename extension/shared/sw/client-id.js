/**
 * 产品级匿名 client_id：本地缓存 + GET /api/client-id（Cookie il_aid，跨重装/两插件/官网共用）。
 *
 * 本质很简单：就是一个随机 UUID。本地有就用；没有（首装或重装）才问一次门面，
 * 门面只是回显 Cookie 里的旧 id 或发新 id；门面不可用就本地随机生成。
 * 备份是单向的：Cookie 能帮重装找回 id，但本地 id 不会回写 Cookie（有意不做）。
 *
 * 门面 Cookie 为 SameSite=None; Secure，故扩展无需为 api 声明 host_permissions 也能 credentials 同步；失败则退化为本地 id。
 *
 * API key 与 client_id 分开：首次 IL_getApiKey 时用 32 字节随机数做成 ih_ 前缀的 base64url 写在本地。
 * 只给云端额度用，不发给 /api/client-id。
 */
const IL_CLIENT_ID_KEY = 'il_client_id';
const IL_CLIENT_ID_PATH = '/api/client-id';
const IL_API_KEY_STORAGE = 'ih_api_key';
const IL_API_KEY_PREV = 'ih_api_key_prev';
const IL_CLIENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IL_API_KEY_RE = /^ih_[A-Za-z0-9_-]{43}$/;

/** @type {Promise<string> | null} */
let _ilClientIdPromise = null;
/** @type {Promise<string> | null} */
let _ilApiKeyPromise = null;

function IL_isValidClientId(v) {
  return typeof v === 'string' && IL_CLIENT_ID_RE.test(v.trim());
}

function IL_storageGetClientId() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([IL_CLIENT_ID_KEY], (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const v = res?.[IL_CLIENT_ID_KEY];
      resolve(IL_isValidClientId(v) ? String(v).trim().toLowerCase() : null);
    });
  });
}

function IL_storageSetClientId(id) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [IL_CLIENT_ID_KEY]: id }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * 向门面取 id：带 Cookie 的 GET，服务端有 Cookie 则回显，否则新发并 Set-Cookie。
 * @returns {Promise<string | null>}
 */
async function IL_fetchClientId() {
  if (globalThis.IL_ensureApiBaseLoaded) await globalThis.IL_ensureApiBaseLoaded();
  const res = await fetch(`${IL_API_BASE}${IL_CLIENT_ID_PATH}`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const id = data?.client_id;
  return IL_isValidClientId(id) ? String(id).trim().toLowerCase() : null;
}

function IL_newApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const body = btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const key = `ih_${body}`;
  if (!IL_API_KEY_RE.test(key)) throw new Error('api key generation failed');
  return key;
}

function IL_storageGetApiKey() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([IL_API_KEY_STORAGE], (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const v = res?.[IL_API_KEY_STORAGE];
      if (v == null || v === '') {
        resolve(null);
        return;
      }
      if (typeof v !== 'string' || !IL_API_KEY_RE.test(v)) {
        reject(new Error('stored api key is invalid'));
        return;
      }
      resolve(v);
    });
  });
}

function IL_storageSetApiKey(key, prev) {
  const obj = { [IL_API_KEY_STORAGE]: key };
  if (prev) obj[IL_API_KEY_PREV] = prev;
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function IL_ensureApiKey() {
  const existing = await IL_storageGetApiKey();
  if (existing) return existing;
  const key = IL_newApiKey();
  await IL_storageSetApiKey(key);
  return key;
}

/**
 * 缓存优先：有本地 id 就直接用，只有首次（含重装后）才问门面。
 * @returns {Promise<string>}
 */
globalThis.IL_getClientId = function IL_getClientId() {
  if (_ilClientIdPromise) return _ilClientIdPromise;
  _ilClientIdPromise = (async () => {
    let cached = null;
    try {
      cached = await IL_storageGetClientId();
    } catch {
      cached = null;
    }
    if (cached) return cached;

    let id = null;
    try {
      id = await IL_fetchClientId();
    } catch {
      /* 离线或无 host 权限：本地新建，与门面 Cookie 可能不一致 */
    }
    if (!id) id = crypto.randomUUID().toLowerCase();

    try {
      await IL_storageSetClientId(id);
    } catch {
      /* 仍返回 id，供本会话上报 */
    }
    return id;
  })().catch((err) => {
    _ilClientIdPromise = null;
    throw err;
  });
  return _ilClientIdPromise;
};

/** @returns {Promise<string>} */
globalThis.IL_getApiKey = function IL_getApiKey() {
  _ilApiKeyPromise ||= IL_ensureApiKey().catch((err) => {
    _ilApiKeyPromise = null;
    throw err;
  });
  return _ilApiKeyPromise;
};

/** @param {string} key */
globalThis.IL_replaceApiKey = async function IL_replaceApiKey(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!IL_API_KEY_RE.test(k)) throw new Error('invalid api key');
  const current = await IL_storageGetApiKey().catch(() => null);
  await IL_storageSetApiKey(k, current && current !== k ? current : undefined);
  _ilApiKeyPromise = Promise.resolve(k);
};
