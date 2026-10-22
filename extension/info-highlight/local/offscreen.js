/**
 * 隐藏页：加载本机 ONNX q4f16，在 WebGPU 上做 Analyze。
 * SW 无持久内存；模型必须留在这里。
 */
import {
  AutoTokenizer,
  AutoModelForCausalLM,
  Tensor,
  env,
} from '../vendor/transformers/transformers.js';

const DEVICE = 'webgpu';
const MAX_LENGTH = 2000;
/** 单次前向 token 数。128 × 词表 × 4B 挡住 WASM 堆高水位。 */
const CHUNK_SIZE = 128;
const VERIFY = 'The cat sat.';

if (!globalThis.IH_localScoring) throw new Error('IH_localScoring missing');
if (!globalThis.IH_localState) throw new Error('IH_localState missing');

env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/transformers/transformers.js').replace(/[^/]+$/, '');
  env.backends.onnx.wasm.proxy = false;
}

async function configureOrtWebGpu() {
  const webgpu = env.backends?.onnx?.webgpu;
  const gpu = globalThis.navigator?.gpu;
  if (!webgpu || !gpu) return;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter?.features?.has('shader-f16')) {
    throw new Error('WebGPU shader-f16 required for on-device WebGPU');
  }
  webgpu.device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
}

let tokenizer = null;
let model = null;
let bosId = null;
let eosId = null;
let family = '';
let loadedLocalId = '';
let loadedHub = '';
/** @type {{ id: string, hubId: string, dtype: string, family: string, prefixLogitsRev?: number } | null} */
let loadedSpec = null;
/** @type {Float32Array | null} */
let firstLogits = null;
/** @type {Set<number>} */
let specialIds = new Set();
/** @type {Map<string, string>} Qwen added token 字面量，不参与 ByteLevel 解码 */
let qwenAddedTokens = new Map();
let queue = Promise.resolve();

function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

function specialSet(tok) {
  const ids = tok.all_special_ids;
  const out = new Set();
  if (ids && typeof ids[Symbol.iterator] === 'function') {
    for (const id of ids) out.add(Number(id));
  }
  const bos = tok.bos_token_id;
  if (bos != null) out.add(Number(bos));
  const eos = tok.eos_token_id;
  if (eos != null) out.add(Number(eos));
  const pad = tok.pad_token_id;
  if (pad != null) out.add(Number(pad));
  const unk = tok.unk_token_id;
  if (unk != null) out.add(Number(unk));
  return out;
}

function decodeOne(id) {
  return tokenizer.decode([id], { skip_special_tokens: false, clean_up_tokenization_spaces: false });
}

function tokenStr(id) {
  const t = tokenizer.model.convert_ids_to_tokens([id]);
  if (!Array.isArray(t) || t.length !== 1 || t[0] == null) {
    throw new Error(`convert_ids_to_tokens ${id}`);
  }
  return t[0];
}

function disposeTensors(obj) {
  if (!obj) return;
  for (const t of Object.values(obj)) t.dispose?.();
}

function idsTensor(id) {
  return new Tensor('int64', BigInt64Array.from([BigInt(id)]), [1, 1]);
}

async function disposeLoaded() {
  firstLogits = null;
  loadedLocalId = '';
  loadedHub = '';
  loadedSpec = null;
  family = '';
  bosId = null;
  eosId = null;
  specialIds = new Set();
  qwenAddedTokens = new Map();
  tokenizer = null;
  if (model) {
    await model.dispose?.();
    model = null;
  }
}

async function probe() {
  return globalThis.IH_localState.probeWebGPU();
}

function initSpec(msg) {
  const id = globalThis.IH_localState.normalizeLocalId(msg.localId);
  if (!id) throw new Error('init missing localId');
  const spec = globalThis.IH_localState.localSpec(id);
  const hub = globalThis.IH_localState.normalizeHub(msg.hub);
  const hubId = typeof msg.hubId === 'string' ? msg.hubId.trim() : '';
  const dtype = typeof msg.dtype === 'string' ? msg.dtype.trim() : '';
  const family = typeof msg.family === 'string' ? msg.family.trim() : '';
  const repoId = globalThis.IH_localState.hubRepoId(hub, spec);
  if (!hubId || !dtype || !family) throw new Error('init missing model spec');
  if (hubId !== repoId || dtype !== spec.dtype || family !== spec.family) {
    throw new Error('init model spec mismatch');
  }
  return { spec, hub, repoId };
}

function hubLoadOptions(progress) {
  return { progress_callback: progress };
}

async function loadTokenizerAndModel(repoId, spec, progress) {
  const opts = hubLoadOptions(progress);
  const modelLoad = {
    device: DEVICE,
    dtype: spec.dtype,
    ...opts,
    session_options: globalThis.IH_localState.onnxSessionOptions(spec.dtype, spec),
  };
  const tok = await AutoTokenizer.from_pretrained(repoId, opts);
  const mdl = await AutoModelForCausalLM.from_pretrained(repoId, modelLoad);
  return { tokenizer: tok, model: mdl };
}

function prefixTokenId() {
  return bosId != null ? bosId : (eosId != null ? eosId : 0);
}

function modelVocabSize() {
  const v = model?.config?.vocab_size;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error('model vocab_size missing');
  return n;
}

async function inferPrefixLogits() {
  const prefixId = prefixTokenId();
  const input_ids = idsTensor(prefixId);
  const attention_mask = idsTensor(1);
  let outputs;
  try {
    outputs = await model({ input_ids, attention_mask });
  } finally {
    input_ids.dispose?.();
    attention_mask.dispose?.();
  }
  try {
    const logits = outputs.logits;
    const dims = (logits.dims || []).map(Number);
    if (!dims || dims.length < 3) throw new Error(`bad prefix logits dims: ${JSON.stringify(dims)}`);
    const vocab = dims[2];
    const row = dims[1] - 1;
    if (row < 0) throw new Error('prefix logits empty');
    const data = logits.data;
    const out = new Float32Array(vocab);
    const base = row * vocab;
    for (let i = 0; i < vocab; i++) out[i] = Number(data[base + i]);
    return out;
  } finally {
    const past = model.getPastKeyValues(outputs, null);
    disposeTensors(past);
    outputs.logits.dispose?.();
  }
}

async function ensureFirstLogits() {
  if (firstLogits) return firstLogits;
  if (family !== 'qwen' || !loadedSpec || !loadedHub) {
    firstLogits = await inferPrefixLogits();
    return firstLogits;
  }
  const prefixId = prefixTokenId();
  const vocab = modelVocabSize();
  const st = globalThis.IH_localState;
  const cached = await st.loadPrefixFirstLogits(loadedHub, loadedSpec, prefixId, vocab);
  if (cached) {
    firstLogits = cached;
    return firstLogits;
  }
  firstLogits = await inferPrefixLogits();
  await st.savePrefixFirstLogits(loadedHub, loadedSpec, prefixId, vocab, firstLogits);
  return firstLogits;
}

async function firstTokenRow(targetId) {
  const logits = await ensureFirstLogits();
  return globalThis.IH_localScoring.scoreRow(logits, 0, logits.length, targetId);
}

async function init(hub, spec, repoId, progress) {
  const st = globalThis.IH_localState;
  const hubOk = hub === st.HUB_HUGGINGFACE
    || hub === st.HUB_MODELSCOPE
    || (hub === st.HUB_LOCAL && st.localHubEnabled());
  if (!hubOk) throw new Error(`bad hub: ${hub}`);
  if (loadedLocalId === spec.id && loadedHub === hub && model && tokenizer) {
    const check = await analyzeText(VERIFY);
    if (!check.bpe_strings.length) throw new Error('verify produced no tokens');
    return;
  }
  await disposeLoaded();
  env.remoteHost = globalThis.IH_localState.hubRemoteHost(hub);
  const t0 = performance.now();
  await configureOrtWebGpu();
  ({ tokenizer, model } = await loadTokenizerAndModel(repoId, spec, progress));
  const loadMs = Math.round(performance.now() - t0);
  bosId = tokenizer.bos_token_id == null ? null : Number(tokenizer.bos_token_id);
  eosId = tokenizer.eos_token_id == null ? null : Number(tokenizer.eos_token_id);
  specialIds = specialSet(tokenizer);
  qwenAddedTokens = new Map();
  if (spec.family === 'qwen') {
    const added = tokenizer.added_tokens;
    if (added && typeof added[Symbol.iterator] === 'function') {
      for (const token of added) {
        if (token?.content != null) qwenAddedTokens.set(token.content, token.content);
      }
    }
  }
  family = spec.family;
  loadedLocalId = spec.id;
  loadedHub = hub;
  loadedSpec = globalThis.IH_localState.localSpec(spec.id);
  try {
    const check = await analyzeText(VERIFY);
    if (!check.bpe_strings.length) throw new Error('verify produced no tokens');
    for (const t of check.bpe_strings) {
      const p = t.real_topk?.[1];
      if (!Number.isFinite(p) || p <= 0) throw new Error('verify produced non-finite probability');
    }
    logLocalDebug('init', localMetrics({
      hub,
      hubId: repoId,
      dtype: spec.dtype,
      load_ms: loadMs,
      verify_tokens: check.bpe_strings.length,
    }));
  } catch (err) {
    await disposeLoaded();
    throw err;
  }
  return localDebugOn()
    ? localMetrics({ hub, hubId: repoId, dtype: spec.dtype, load_ms: loadMs })
    : null;
}

async function analyzeText(text) {
  if (!model || !tokenizer) throw new Error('local model not loaded');
  if (typeof text !== 'string' || !text) throw new Error('Missing text');

  const t0 = performance.now();
  const inputs = await tokenizer(text, {
    return_tensors: 'pt',
    truncation: true,
    max_length: MAX_LENGTH,
    add_special_tokens: family !== 'qwen',
  });
  let past = null;
  try {
    const ids = Array.from(inputs.input_ids.data).map(Number);
    let offsets;
    if (family === 'qwen') {
      // Qwen：encode 无 special token；offset 见 scoring.alignQwenByteTokens（SYNC: _encode_text offset_mapping）
      const pieces = ids.map((id) => tokenStr(id));
      const spans = globalThis.IH_localScoring.alignQwenByteTokens(text, pieces, qwenAddedTokens);
      offsets = globalThis.IH_localScoring.utf16ToCpOffsets(
        text,
        spans.map((s) => [s.start, s.end]),
      );
    } else {
      if (bosId != null && ids[0] !== bosId) {
        throw new Error('Gemma encoding missing BOS');
      }
      const utf16 = globalThis.IH_localScoring.alignUtf16Offsets(text, ids, tokenStr, specialIds);
      offsets = globalThis.IH_localScoring.utf16ToCpOffsets(text, utf16);
    }
    // SYNC: backend/core/language_checker.py → _encode_text truncation warn
    if (offsets.length) {
      const lastEnd = offsets[offsets.length - 1][1];
      const cpLen = globalThis.IH_localScoring.utf16ToCpOffsets(text, [[0, text.length]])[0][1];
      if (lastEnd < cpLen) {
        console.warn(
          `[Info Highlight] text truncated to first ${MAX_LENGTH} tokens (${cpLen} char -> ${lastEnd} char)`,
        );
      }
    }
    const aligned = family === 'gemma'
      ? globalThis.IH_localScoring.ensureGemmaBos(ids, offsets, bosId)
      : { ids, offsets };

    const rows = [];
    const seq = aligned.ids.length;
    for (let start = 0; start < seq; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, seq);
      const input_ids = inputs.input_ids.slice(null, [start, end]);
      const attention_mask = inputs.attention_mask.slice(null, [0, end]);
      let outputs;
      try {
        outputs = await model({ input_ids, attention_mask, past_key_values: past });
      } finally {
        input_ids.dispose?.();
        attention_mask.dispose?.();
      }
      try {
        const logits = outputs.logits;
        const dims = (logits.dims || []).map(Number);
        if (!dims || dims.length < 3) throw new Error(`bad logits dims: ${JSON.stringify(dims)}`);
        if (dims[1] !== end - start) {
          throw new Error(`logits seq ${dims[1]} != chunk ${end - start}`);
        }
        rows.push(...globalThis.IH_localScoring.scoreChunk(
          logits.data, dims[2], aligned.ids, start, end,
        ));
      } finally {
        past = model.getPastKeyValues(outputs, past);
        outputs.logits.dispose?.();
      }
    }
    const { insertFirst } = globalThis.IH_localScoring.scoringPayloadOffsets(aligned.offsets);
    if (insertFirst) {
      if (!aligned.ids.length) throw new Error('insertFirst with empty ids');
      rows.unshift(await firstTokenRow(aligned.ids[0]));
    }
    const out = globalThis.IH_localScoring.bpeFromRows({
      rows,
      ids: aligned.ids,
      offsets: aligned.offsets,
      text,
      decodeId: decodeOne,
    });
    const analyzeMs = Math.round(performance.now() - t0);
    if (localDebugOn()) {
      out.metrics = localMetrics({
        analyze_ms: analyzeMs,
        chars: text.length,
        tokens: aligned.ids.length,
      });
      logLocalDebug('analyze', out.metrics);
    }
    return out;
  } finally {
    disposeTensors(past);
    inputs.input_ids?.dispose?.();
    inputs.attention_mask?.dispose?.();
  }
}

function progressToInit(info) {
  chrome.runtime.sendMessage({ type: 'ih-local-progress', info }).catch(() => {});
}

/** 上一段 analyze 结束后闲置若干秒无下一段/init，喊 SW 关藏页（释放 WebGPU）。时长见选项。新 analyze/init 撤表。 */
let lingerGen = 0;
let lingerTimer = 0;
let lingerArmedAt = 0;

function jsHeapBytes() {
  const n = globalThis.performance?.memory?.usedJSHeapSize;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function localDebugOn() {
  return !!globalThis.IH_CONFIG?.localModelDebug;
}

function localMetrics(extra) {
  return { js_heap_bytes: jsHeapBytes(), ...extra };
}

function logLocalDebug(label, payload) {
  if (!localDebugOn()) return;
  console.info(`[IH local] ${label}`, payload);
}

function disarmLinger() {
  lingerGen += 1;
  if (lingerTimer) {
    clearTimeout(lingerTimer);
    lingerTimer = 0;
  }
  lingerArmedAt = 0;
}

function armLinger() {
  disarmLinger();
  const gen = lingerGen;
  lingerArmedAt = Date.now();
  void globalThis.IH_localState.webgpuLingerMs().then((ms) => {
    if (gen !== lingerGen) return;
    lingerTimer = setTimeout(() => {
      if (gen !== lingerGen) return;
      lingerTimer = 0;
      const wait_ms = Date.now() - lingerArmedAt;
      lingerArmedAt = 0;
      chrome.runtime.sendMessage({
        type: 'ih-local-linger',
        loaded: !!(model && tokenizer),
        js_heap_bytes: jsHeapBytes(),
        wait_ms,
      }).catch(() => {});
    }, ms);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ih-local-engine') return;
  const cmd = msg.cmd;
  enqueue(async () => {
    if (cmd === 'probe') {
      const result = await probe();
      return { ok: true, webgpu: !!result.ok, reason: result.reason || null };
    }
    if (cmd === 'init') {
      disarmLinger();
      const { spec, hub, repoId } = initSpec(msg);
      const metrics = await init(hub, spec, repoId, (info) => progressToInit(info));
      return metrics
        ? { ok: true, localId: loadedLocalId, metrics }
        : { ok: true, localId: loadedLocalId };
    }
    if (cmd === 'analyze') {
      disarmLinger();
      try {
        const result = await analyzeText(msg.text);
        result.device = 'local WebGPU';
        return { ok: true, result };
      } finally {
        // 标签暂停不再发消息时，靠这段闲置计时卸引擎；下一段到来会先 disarm
        armLinger();
      }
    }
    if (cmd === 'status') {
      return { ok: true, loaded: !!(model && tokenizer), localId: loadedLocalId };
    }
    throw new Error(`unknown engine cmd: ${cmd}`);
  })
    .then((data) => sendResponse(data))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
