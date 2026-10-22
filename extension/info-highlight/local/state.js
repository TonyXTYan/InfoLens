/**
 * 模型选择与本机状态：选项页的一项、WebGPU、权重是否就绪、下载源。
 * 写入 chrome.storage.local。权重在 Cache API（transformers-cache），不进 chrome.storage。
 */
globalThis.IH_localState ||= (function () {
  const HUB_HUGGINGFACE = 'huggingface';
  const HUB_MODELSCOPE = 'modelscope';
  const HUB_LOCAL = 'local';
  const CLOUD_QWEN = 'qwen3-0.6b';
  const CLOUD_GEMMA = 'gemma-3-270m';
  const CLOUD_MODELS = Object.freeze([
    { id: CLOUD_QWEN, label: 'Qwen3 0.6B' },
    { id: CLOUD_GEMMA, label: 'Gemma 3 270M' },
  ]);
  const CLOUD_MODEL_IDS = new Set(CLOUD_MODELS.map((m) => m.id));
  const LOCAL_SPECS = Object.freeze({
    [CLOUD_GEMMA]: Object.freeze({
      id: CLOUD_GEMMA,
      hubId: 'onnx-community/gemma-3-270m-ONNX',
      dtype: 'q4',
      family: 'gemma',
      label: 'Gemma 3 270M',
      initDownloadSize: '500 MB',
    }),
    [CLOUD_QWEN]: Object.freeze({
      id: CLOUD_QWEN,
      hubId: 'dqy08/Qwen3-0.6B-Base-ONNX',
      hubIdModelscope: 'ddqy08/Qwen3-0.6B-Base-ONNX',
      dtype: 'q4',
      family: 'qwen',
      label: 'Qwen3 0.6B',
      initDownloadSize: '920 MB',
      prefixLogitsRev: 5,
    }),
  });
  const CHOICE_CLOUD_QWEN = `cloud:${CLOUD_QWEN}`;
  const CHOICE_CLOUD_GEMMA = `cloud:${CLOUD_GEMMA}`;
  const CHOICE_LOCAL_GEMMA = `local:${CLOUD_GEMMA}`;
  const CHOICE_LOCAL_QWEN3 = `local:${CLOUD_QWEN}`;
  const REMOVED_LOCAL_QWEN25 = 'local:qwen2.5-0.5b';
  const LOCAL_MODEL_IDS = Object.freeze([CLOUD_QWEN, CLOUD_GEMMA]);
  /** 选项页一项即一次实际会跑的组合。 */
  const CHOICES = Object.freeze([
    Object.freeze({
      id: CHOICE_CLOUD_QWEN,
      cloudModel: CLOUD_QWEN,
      local: false,
    }),
    Object.freeze({
      id: CHOICE_CLOUD_GEMMA,
      cloudModel: CLOUD_GEMMA,
      local: false,
    }),
    Object.freeze({
      id: CHOICE_LOCAL_QWEN3,
      localModel: CLOUD_QWEN,
      local: true,
    }),
    Object.freeze({
      id: CHOICE_LOCAL_GEMMA,
      localModel: CLOUD_GEMMA,
      local: true,
    }),
  ]);
  const CHOICE_IDS = new Set(CHOICES.map((c) => c.id));
  /** 升级前的两份存储。读到新键之后删掉。 */
  const LEGACY_PREF = 'ih_analyze_pref';
  const LEGACY_CLOUD_MODEL = 'ih_cloud_model';
  const WEBGPU_BLOCK = Object.freeze({
    no_api: 'no_api',
    no_adapter: 'no_adapter',
    no_shader_f16: 'no_shader_f16',
    device_failed: 'device_failed',
    probe_failed: 'probe_failed',
    runtime_failed: 'runtime_failed',
  });
  const WEBGPU_LINGER_SECS = Object.freeze([10, 60, 600, 3600]);
  const DEFAULT_WEBGPU_LINGER_SEC = 10;
  const WEBGPU_LINGER_LABEL_BY_SEC = Object.freeze({
    10: '10 seconds',
    60: '1 minute',
    600: '10 minutes',
    3600: '60 minutes',
  });

  const KEYS = {
    webgpu: 'ih_webgpu_ok',
    webgpuBlockReason: 'ih_webgpu_block_reason',
    webgpuLingerSec: 'ih_webgpu_linger_sec',
    ready: 'ih_local_ready',
    runtime: 'ih_local_runtime',
    hub: 'ih_model_hub',
    choice: 'ih_model_choice',
  };

  function normalizeWebgpuLingerSec(raw) {
    const n = Math.floor(Number(raw));
    return WEBGPU_LINGER_SECS.includes(n) ? n : DEFAULT_WEBGPU_LINGER_SEC;
  }

  function webgpuLingerMsFromSec(sec) {
    return normalizeWebgpuLingerSec(sec) * 1000;
  }

  async function webgpuLingerMs() {
    const res = await storageGet({ [KEYS.webgpuLingerSec]: DEFAULT_WEBGPU_LINGER_SEC });
    return webgpuLingerMsFromSec(res[KEYS.webgpuLingerSec]);
  }

  function webgpuLingerLabelKey(sec) {
    const normalized = normalizeWebgpuLingerSec(sec);
    return WEBGPU_LINGER_LABEL_BY_SEC[normalized] || WEBGPU_LINGER_LABEL_BY_SEC[DEFAULT_WEBGPU_LINGER_SEC];
  }
  /** @deprecated 仅兼容旧引用；新代码用 localSpec(id).hubId 或 hubRepoId(hub, spec) */
  const MODEL_ID = LOCAL_SPECS[CLOUD_GEMMA].hubId;
  const MODEL_DTYPE = LOCAL_SPECS[CLOUD_GEMMA].dtype;
  /** 与 @huggingface/transformers hub.js `caches.open` 一致。 */
  const MODEL_CACHE = 'transformers-cache';
  const HUBS = {
    huggingface: {
      remoteHost: 'https://huggingface.co/',
      origins: [
        'https://huggingface.co/*',
        'https://*.huggingface.co/*',
        'https://*.hf.co/*',
        'https://*.xethub.hf.co/*',
      ],
    },
    modelscope: {
      remoteHost: 'https://www.modelscope.cn/models/',
      origins: ['https://*.modelscope.cn/*'],
    },
  };

  /** IH_CONFIG.localModelHost（须以 / 结尾）→ 准备页「本机 Hub 镜像」；目录布局同 Hugging Face resolve/main。 */
  function localHubEnabled() {
    const host = typeof globalThis.IH_CONFIG?.localModelHost === 'string'
      ? globalThis.IH_CONFIG.localModelHost.trim()
      : '';
    if (!host || !host.endsWith('/')) return null;
    try {
      const u = new URL(host);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return { remoteHost: host, origin: `${u.origin}/*` };
    } catch {
      return null;
    }
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(res);
      });
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function normalizeLocalId(id) {
    return Object.prototype.hasOwnProperty.call(LOCAL_SPECS, id) ? id : '';
  }

  function parseReadyIds(raw) {
    if (raw === true) return [CLOUD_GEMMA];
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const id of raw) {
      const localId = normalizeLocalId(id);
      if (!localId || seen.has(localId)) continue;
      seen.add(localId);
      out.push(localId);
    }
    return out;
  }

  function get() {
    return storageGet([
      KEYS.choice,
      LEGACY_PREF,
      LEGACY_CLOUD_MODEL,
      KEYS.webgpu,
      KEYS.webgpuBlockReason,
      KEYS.ready,
      KEYS.runtime,
      KEYS.hub,
      KEYS.webgpuLingerSec,
    ]).then((res) => {
      const choice = storedChoice(res) || choiceFromLegacy(res);
      const runtime = normalizeLocalId(res[KEYS.runtime]) || CLOUD_GEMMA;
      const readyIds = parseReadyIds(res[KEYS.ready]);
      const statusId = onDeviceStatusModelId(choice, runtime);
      return {
        webgpuOk: Object.prototype.hasOwnProperty.call(res, KEYS.webgpu) ? res[KEYS.webgpu] : null,
        webgpuBlockReason: res[KEYS.webgpuBlockReason] || null,
        ready: readyIds.includes(statusId),
        readyIds,
        runtime,
        hub: normalizeHub(res[KEYS.hub]),
        choice,
        webgpuLingerSec: normalizeWebgpuLingerSec(res[KEYS.webgpuLingerSec]),
      };
    });
  }

  function set(patch) {
    const out = {};
    if ('webgpuOk' in patch) out[KEYS.webgpu] = patch.webgpuOk;
    if ('webgpuBlockReason' in patch) out[KEYS.webgpuBlockReason] = patch.webgpuBlockReason || null;
    if ('hub' in patch) out[KEYS.hub] = normalizeHub(patch.hub);
    if ('readyIds' in patch) out[KEYS.ready] = parseReadyIds(patch.readyIds);
    if ('runtime' in patch) {
      const runtime = normalizeLocalId(patch.runtime);
      if (!runtime) throw new Error(`bad local runtime: ${patch.runtime}`);
      out[KEYS.runtime] = runtime;
    }
    if ('choice' in patch) {
      const choice = choiceById(patch.choice);
      out[KEYS.choice] = choice.id;
      if (choice.local) out[KEYS.runtime] = choice.localModel;
    }
    if ('webgpuLingerSec' in patch) {
      out[KEYS.webgpuLingerSec] = normalizeWebgpuLingerSec(patch.webgpuLingerSec);
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(out, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  async function markReady(localId, on) {
    const id = normalizeLocalId(localId);
    if (!id) throw new Error(`unknown local model: ${localId}`);
    const st = await get();
    const ids = new Set(st.readyIds);
    if (on) ids.add(id);
    else ids.delete(id);
    return set({ readyIds: [...ids] });
  }

  /**
   * 新键已在时沿用；否则按升级前的偏好收成现在的一项，并删掉旧键。
   * 自动（含没写过偏好）改去云端 Qwen 时返回 true，调用方清分析缓存。
   */
  async function migrate() {
    const res = await storageGet([KEYS.choice, LEGACY_PREF, LEGACY_CLOUD_MODEL, KEYS.ready]);
    const existing = storedChoice(res);
    const choice = existing || choiceFromLegacy(res);
    const legacy = [LEGACY_PREF, LEGACY_CLOUD_MODEL].filter((k) => Object.prototype.hasOwnProperty.call(res, k));
    const dropCache = !existing && legacy.length > 0 && res[LEGACY_PREF] !== 'local' && res[LEGACY_PREF] !== 'cloud';
    if (existing !== choice) await set({ choice });
    if (res[KEYS.ready] === true) await set({ readyIds: [CLOUD_GEMMA] });
    if (legacy.length) await storageRemove(legacy);
    return dropCache;
  }

  function normalizeHub(h) {
    if (h === HUB_MODELSCOPE) return HUB_MODELSCOPE;
    if (h === HUB_LOCAL && localHubEnabled()) return HUB_LOCAL;
    return HUB_HUGGINGFACE;
  }

  function normalizeCloudModel(id) {
    return CLOUD_MODEL_IDS.has(id) ? id : CLOUD_QWEN;
  }

  function localSpec(localId) {
    const spec = LOCAL_SPECS[localId];
    if (!spec) throw new Error(`unknown local model: ${localId}`);
    return spec;
  }

  function modelLabel(modelId) {
    if (Object.prototype.hasOwnProperty.call(LOCAL_SPECS, modelId)) return LOCAL_SPECS[modelId].label;
    const id = normalizeCloudModel(modelId);
    const row = CLOUD_MODELS.find((m) => m.id === id);
    if (!row) throw new Error(`unknown model id: ${modelId}`);
    return row.label;
  }

  function localModelIdFromChoiceId(choiceId) {
    const choice = choiceById(choiceId);
    if (!choice.local) throw new Error(`not a local choice: ${choiceId}`);
    return choice.localModel;
  }

  /** 云端选项时，本机准备/状态行用上次选过的本机型号；没写过则 Gemma。 */
  function localRuntimeModelId(stored) {
    return normalizeLocalId(stored) || CLOUD_GEMMA;
  }

  /** 选项页「本机模型」状态行：选本机项用该项型号，否则用 runtime 槽位。 */
  function onDeviceStatusModelId(choiceId, runtimeId) {
    if (typeof choiceId === 'string' && choiceId.startsWith('local:')) {
      return localModelIdFromChoiceId(choiceId);
    }
    return localRuntimeModelId(runtimeId);
  }

  function choiceById(id) {
    const found = CHOICES.find((c) => c.id === id);
    if (!found) throw new Error(`bad model choice: ${id}`);
    return found;
  }

  function storedChoice(res) {
    const id = res[KEYS.choice];
    if (id === REMOVED_LOCAL_QWEN25) return CHOICE_LOCAL_QWEN3;
    return CHOICE_IDS.has(id) ? id : '';
  }

  /**
   * 旧存储：ih_analyze_pref（auto / cloud / local）和 ih_cloud_model。
   * 自动，以及没写过偏好（当时的默认就是自动），升到云端 Qwen。
   * 明确选过本机或某个云端模型的，沿用那个。
   */
  function choiceFromLegacy(res) {
    const pref = res[LEGACY_PREF];
    if (pref === 'local') return CHOICE_LOCAL_GEMMA;
    if (pref === 'cloud') {
      return res[LEGACY_CLOUD_MODEL] === CLOUD_GEMMA ? CHOICE_CLOUD_GEMMA : CHOICE_CLOUD_QWEN;
    }
    return CHOICE_CLOUD_QWEN;
  }

  function hubOrigins(h) {
    const nh = normalizeHub(h);
    if (nh === HUB_LOCAL) return [localHubEnabled().origin];
    return HUBS[nh].origins;
  }

  function hubRemoteHost(h) {
    const nh = normalizeHub(h);
    if (nh === HUB_LOCAL) return localHubEnabled().remoteHost;
    return HUBS[nh].remoteHost;
  }

  /** Hugging Face 用 spec.hubId；ModelScope 上 Qwen 等账号与 HF 不一致时用 hubIdModelscope。 */
  function hubRepoId(hub, spec) {
    const nh = normalizeHub(hub);
    if (nh === HUB_MODELSCOPE && spec.hubIdModelscope) return spec.hubIdModelscope;
    return spec.hubId;
  }

  function hubRepoNeedles(spec) {
    const ids = [spec.hubId];
    if (spec.hubIdModelscope && !ids.includes(spec.hubIdModelscope)) ids.push(spec.hubIdModelscope);
    return ids.map((id) => `/${id}/`);
  }

  /**
   * ORT WebGPU 加载 Hub q4f16 时，默认 graphOptimizationLevel=all 会在 LayerNorm Cast 上推断出 fp16/fp32 不一致。
   * basic 保留必要优化并避免该路径（见 microsoft/onnxruntime#29235 同类 Cast 类型问题）。
   */
  function onnxSessionOptions(dtype, spec) {
    const opts = {};
    if (dtype === 'q4f16' || dtype === 'fp16') {
      opts.graphOptimizationLevel = 'basic';
    }
    const level = spec?.graphOptimizationLevel;
    if (level) opts.graphOptimizationLevel = level;
    return opts;
  }

  /** q4f16 需要 WebGPU 与 shader-f16（与 transformers.js 一致）。 */
  async function probeWebGPU() {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) return { ok: false, reason: WEBGPU_BLOCK.no_api };
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return { ok: false, reason: WEBGPU_BLOCK.no_adapter };
      if (!adapter.features?.has('shader-f16')) {
        return { ok: false, reason: WEBGPU_BLOCK.no_shader_f16 };
      }
      const device = await adapter.requestDevice();
      if (!device) return { ok: false, reason: WEBGPU_BLOCK.device_failed };
      device.destroy?.();
      return { ok: true, reason: null };
    } catch {
      return { ok: false, reason: WEBGPU_BLOCK.device_failed };
    }
  }

  async function applyWebgpuProbe(result) {
    const ok = !!result?.ok;
    await set({
      webgpuOk: ok,
      webgpuBlockReason: ok ? null : (result?.reason || WEBGPU_BLOCK.probe_failed),
    });
    return ok;
  }

  function cacheApi() {
    if (typeof caches === 'undefined') throw new Error('Cache API unavailable');
    return caches;
  }

  function cacheNeedles(localId) {
    const spec = localSpec(normalizeLocalId(localId) || CLOUD_GEMMA);
    return hubRepoNeedles(spec);
  }

  function cacheUrlMatchesLocalId(url, localId) {
    const needles = cacheNeedles(localId);
    return needles.some((needle) => url.includes(needle));
  }

  function prefixFirstLogitsRelPath(spec, prefixId, vocab) {
    const rev = spec.prefixLogitsRev == null ? 0 : Number(spec.prefixLogitsRev);
    return `onnx/ih-prefix-first-logits.r${rev}.${spec.dtype}.p${prefixId}.v${vocab}.bin`;
  }

  function prefixFirstLogitsCacheUrl(hub, spec, prefixId, vocab) {
    const host = hubRemoteHost(normalizeHub(hub));
    const rel = prefixFirstLogitsRelPath(spec, prefixId, vocab);
    return `${host}${hubRepoId(hub, spec)}/resolve/main/${rel}`;
  }

  async function loadPrefixFirstLogits(hub, spec, prefixId, vocab) {
    const v = Number(vocab);
    const p = Number(prefixId);
    if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(p)) return null;
    const api = cacheApi();
    if (!(await api.has(MODEL_CACHE))) return null;
    const cache = await api.open(MODEL_CACHE);
    const url = prefixFirstLogitsCacheUrl(hub, spec, p, v);
    const res = await cache.match(url);
    if (!res) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== v * 4) return null;
    const out = new Float32Array(buf);
    for (let i = 0; i < out.length; i++) {
      if (!Number.isFinite(out[i])) return null;
    }
    return out;
  }

  async function savePrefixFirstLogits(hub, spec, prefixId, vocab, floats) {
    const v = Number(vocab);
    const p = Number(prefixId);
    if (!Number.isFinite(v) || v <= 0 || !Number.isFinite(p)) {
      throw new Error('bad prefix logits cache key');
    }
    if (!(floats instanceof Float32Array) || floats.length !== v) {
      throw new Error('prefix logits length mismatch');
    }
    const api = cacheApi();
    const cache = await api.open(MODEL_CACHE);
    const url = prefixFirstLogitsCacheUrl(hub, spec, p, v);
    const body = floats.buffer.slice(floats.byteOffset, floats.byteOffset + floats.byteLength);
    await cache.put(url, new Response(body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.byteLength),
      },
    }));
  }

  async function modelCacheUsage(localId) {
    const api = cacheApi();
    if (!(await api.has(MODEL_CACHE))) return { entries: 0, bytes: 0 };
    const cache = await api.open(MODEL_CACHE);
    const keys = await cache.keys();
    let entries = 0;
    let bytes = 0;
    for (const req of keys) {
      const url = req.url || '';
      if (!cacheUrlMatchesLocalId(url, localId)) continue;
      entries += 1;
      const res = await cache.match(req);
      if (!res) continue;
      const raw = res.headers.get('Content-Length');
      if (raw != null && raw !== '') {
        const cl = Number(raw);
        if (Number.isFinite(cl) && cl >= 0) {
          bytes += cl;
          continue;
        }
      }
      bytes += (await res.blob()).size;
    }
    return { entries, bytes };
  }

  async function dropModelCache(localId) {
    const id = normalizeLocalId(localId);
    if (!id) {
      await cacheApi().delete(MODEL_CACHE);
      return;
    }
    const api = cacheApi();
    if (!(await api.has(MODEL_CACHE))) return;
    const cache = await api.open(MODEL_CACHE);
    const keys = await cache.keys();
    await Promise.all(
      keys.filter((req) => cacheUrlMatchesLocalId(req.url || '', id)).map((req) => cache.delete(req)),
    );
  }

  return {
    HUB_HUGGINGFACE,
    HUB_MODELSCOPE,
    HUB_LOCAL,
    localHubEnabled,
    CLOUD_QWEN,
    CLOUD_GEMMA,
    CLOUD_MODELS,
    CHOICE_CLOUD_QWEN,
    CHOICE_CLOUD_GEMMA,
    CHOICE_LOCAL_GEMMA,
    CHOICE_LOCAL_QWEN3,
    LOCAL_MODEL_IDS,
    CHOICES,
    LEGACY_PREF,
    LEGACY_CLOUD_MODEL,
    choiceById,
    choiceFromLegacy,
    storedChoice,
    WEBGPU_BLOCK,
    WEBGPU_LINGER_SECS,
    WEBGPU_LINGER_LABEL_BY_SEC,
    DEFAULT_WEBGPU_LINGER_SEC,
    normalizeWebgpuLingerSec,
    webgpuLingerLabelKey,
    webgpuLingerMs,
    KEYS,
    MODEL_ID,
    MODEL_DTYPE,
    MODEL_CACHE,
    get,
    set,
    markReady,
    migrate,
    normalizeHub,
    normalizeCloudModel,
    normalizeLocalId,
    localSpec,
    modelLabel,
    localModelIdFromChoiceId,
    localRuntimeModelId,
    onDeviceStatusModelId,
    hubOrigins,
    hubRemoteHost,
    hubRepoId,
    probeWebGPU,
    onnxSessionOptions,
    applyWebgpuProbe,
    modelCacheUsage,
    dropModelCache,
    prefixFirstLogitsCacheUrl,
    loadPrefixFirstLogits,
    savePrefixFirstLogits,
  };
})();
