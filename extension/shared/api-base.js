/**
 * 云端 API 根地址：
 * - IL_API_BASE：额度、client-id、书库等（默认官方；config.js 的 apiBase 可整站指向沙箱）
 * - IL_ANALYZE_API_BASE：云端信息密度分析 + 选项页「算力」测速
 * ih_cloud_api_base_enabled 为 true 时：analyze 只走用户填的 URL（直连 /api/analyze），不回退 config 沙箱或官方门面。
 * 开关关着时：analyze 走 IL_API_BASE 对应门面 /v2。额度等仍只用 IL_API_BASE。
 */
const IL_DEFAULT_API_BASE = 'https://api.info-lens.app';
const IL_CLOUD_API_BASE_KEY = 'ih_cloud_api_base';
const IL_CLOUD_API_BASE_ENABLED_KEY = 'ih_cloud_api_base_enabled';

/** @type {string} */
var IL_API_BASE = IL_DEFAULT_API_BASE;
/** @type {string} */
var IL_ANALYZE_API_BASE = IL_DEFAULT_API_BASE;

/** @type {boolean} */
let _useFacadeV2 = true;
/** @type {Promise<void> | null} */
let _apiBaseReady = null;
/** storage 异步读完成前若已有更新的 apply，丢弃过期结果 */
let _applyGeneration = 0;

function IL_configApiBaseRaw() {
  const v = globalThis.IH_CONFIG?.apiBase;
  return typeof v === 'string' ? v : '';
}

/**
 * 规范化用户输入的 API 根：http(s) origin，可选 pathname，无尾斜杠。
 * @returns {string} 合法则返回；非法返回 ''
 */
globalThis.IL_normalizeCloudApiBase = function IL_normalizeCloudApiBase(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  try {
    let href = s;
    if (!s.includes('://')) {
      const host = s.split('/')[0].split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
      const scheme = host === 'localhost' || host === '127.0.0.1' || host === '::1' ? 'http' : 'https';
      href = `${scheme}://${s}`;
    }
    const u = new URL(href);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    u.hash = '';
    u.search = '';
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '/') path = '';
    return path ? `${u.origin}${path}` : u.origin;
  } catch {
    return '';
  }
};

/** 仅显式开启时生效；storage 里留着 URL 但关着开关不算开启。 */
function IL_isCloudApiOverrideEnabled(enabledFlag) {
  return enabledFlag === true;
}

/** 开关关或 URL 无效时返回 '' */
function IL_effectiveCloudApiUrlRaw(urlRaw, enabled) {
  if (!IL_isCloudApiOverrideEnabled(enabled)) return '';
  const raw = typeof urlRaw === 'string' ? urlRaw.trim() : '';
  return IL_normalizeCloudApiBase(raw) ? raw : '';
}

function IL_resolveGeneralApiBase() {
  const fromConfig = IL_normalizeCloudApiBase(IL_configApiBaseRaw());
  if (fromConfig) return fromConfig;
  return IL_DEFAULT_API_BASE;
}

/** 未开启自定义云端 API 时，analyze 与额度等同根（门面 /v2）。 */
function IL_resolveFacadeAnalyzeApiBase() {
  const fromConfig = IL_normalizeCloudApiBase(IL_configApiBaseRaw());
  if (fromConfig) return fromConfig;
  return IL_DEFAULT_API_BASE;
}

function IL_applyResolved(urlRaw, enabled) {
  IL_API_BASE = IL_resolveGeneralApiBase();
  if (IL_isCloudApiOverrideEnabled(enabled)) {
    const raw = typeof urlRaw === 'string' ? urlRaw.trim() : '';
    IL_ANALYZE_API_BASE = IL_normalizeCloudApiBase(raw);
    _useFacadeV2 = false;
  } else {
    IL_ANALYZE_API_BASE = IL_resolveFacadeAnalyzeApiBase();
    _useFacadeV2 = true;
  }
}

function IL_readStoredApiBaseOverride() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([IL_CLOUD_API_BASE_KEY, IL_CLOUD_API_BASE_ENABLED_KEY], (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const url = res?.[IL_CLOUD_API_BASE_KEY];
      resolve({
        url: typeof url === 'string' ? url : '',
        enabled: res?.[IL_CLOUD_API_BASE_ENABLED_KEY],
      });
    });
  });
}

globalThis.IL_CLOUD_API_BASE_KEY = IL_CLOUD_API_BASE_KEY;
globalThis.IL_CLOUD_API_BASE_ENABLED_KEY = IL_CLOUD_API_BASE_ENABLED_KEY;
globalThis.IL_DEFAULT_API_BASE = IL_DEFAULT_API_BASE;
globalThis.IL_isCloudApiOverrideEnabled = IL_isCloudApiOverrideEnabled;

globalThis.IL_useFacadeV2Analyze = function IL_useFacadeV2Analyze() {
  return _useFacadeV2;
};

/** 选项页测速：用户自建时打 Python /api/health，否则门面 /backend-latency；开关开但 URL 无效则 skip */
globalThis.IL_analyzeLatencyTarget = function IL_analyzeLatencyTarget(urlRaw, enabledFlag) {
  if (IL_isCloudApiOverrideEnabled(enabledFlag)) {
    const effective = IL_effectiveCloudApiUrlRaw(urlRaw, enabledFlag);
    const base = IL_normalizeCloudApiBase(effective);
    if (base) return { base, path: '/api/health', needReached: false };
    return { skip: true };
  }
  const base = IL_resolveFacadeAnalyzeApiBase();
  return { base, path: '/backend-latency', needReached: true };
};

globalThis.IL_ensureApiBaseLoaded = function IL_ensureApiBaseLoaded() {
  if (!_apiBaseReady) {
    const gen = _applyGeneration;
    _apiBaseReady = IL_readStoredApiBaseOverride()
      .then(({ url, enabled }) => {
        if (gen !== _applyGeneration) return;
        IL_applyResolved(url, enabled);
      })
      .catch(() => {
        if (gen !== _applyGeneration) return;
        IL_applyResolved('', false);
      });
  }
  return _apiBaseReady;
};

/**
 * @param {string} urlRaw storage 中的 URL 原文
 * @param {boolean | undefined} enabledFlag ih_cloud_api_base_enabled
 */
globalThis.IL_applyCloudApiBaseOverride = function IL_applyCloudApiBaseOverride(urlRaw, enabledFlag) {
  _applyGeneration += 1;
  IL_applyResolved(typeof urlRaw === 'string' ? urlRaw : '', enabledFlag);
  _apiBaseReady = Promise.resolve();
};

IL_applyResolved('', false);

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes[IL_CLOUD_API_BASE_KEY] && !changes[IL_CLOUD_API_BASE_ENABLED_KEY]) return;
    chrome.storage.local.get([IL_CLOUD_API_BASE_KEY, IL_CLOUD_API_BASE_ENABLED_KEY], (res) => {
      const url = typeof res?.[IL_CLOUD_API_BASE_KEY] === 'string' ? res[IL_CLOUD_API_BASE_KEY] : '';
      IL_applyCloudApiBaseOverride(url, res?.[IL_CLOUD_API_BASE_ENABLED_KEY]);
    });
  });
}
