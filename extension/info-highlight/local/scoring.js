/**
 * 本机 Analyze 打分：把 logits 收成与云端 Analyze 相同的 bpe_strings。
 * 不依赖 WebGPU / transformers；对齐 backend/core/language_checker.py 的 payload 规则。
 */
globalThis.IH_localScoring ||= (function () {
  const TOPK = 10;
  const SIG_FIGS = 7;
  /** SentencePiece ▁ 与 GPT-2 Ġ 都当词首空格。 */
  const SPACE_MARK = /[\u2581\u0120]/g;
  const BYTE_PIECE = /^<0x([0-9A-Fa-f]{2})>$/;
  const utf8dec = new TextDecoder('utf-8', { fatal: true });

  function utf8SeqLen(b) {
    if (b < 0x80) return 1;
    if (b < 0xc0) throw new Error(`utf-8 continuation ${b}`);
    if (b < 0xe0) return 2;
    if (b < 0xf0) return 3;
    if (b < 0xf8) return 4;
    throw new Error(`utf-8 start ${b}`);
  }

  function roundSigFigs(x, n = SIG_FIGS) {
    if (x === 0 || !Number.isFinite(x)) return x;
    return Number(Number(x).toPrecision(n));
  }

  /** SYNC: backend/core/language_checker.py → scoring_payload_offsets */
  function scoringPayloadOffsets(tokenOffsets) {
    let start = 0;
    while (start < tokenOffsets.length && tokenOffsets[start][0] >= tokenOffsets[start][1]) {
      start += 1;
    }
    let end = tokenOffsets.length;
    while (end > start && tokenOffsets[end - 1][0] >= tokenOffsets[end - 1][1]) {
      end -= 1;
    }
    return { offsets: tokenOffsets.slice(start, end), insertFirst: start === 0 };
  }

  /**
   * 本机 tokenizer 必须已带 BOS；缺则抛，不补（补了也和已编码的 input_ids 对不上）。
   * SYNC: backend/core/language_checker.py → ensure_bos_prefix 的判定，不含插入。
   */
  function ensureGemmaBos(ids, offsets, bosId) {
    if (bosId == null) return { ids, offsets };
    if (offsets.length && offsets[0][0] >= offsets[0][1]) return { ids, offsets };
    if (ids.length && ids[0] === bosId) return { ids, offsets };
    throw new Error('Gemma encoding missing BOS');
  }

  function utf16ToCpIndex(text) {
    const s = text || '';
    const supp = [];
    let cpLength = 0;
    for (let i = 0; i < s.length; ) {
      const w = s.codePointAt(i) > 0xffff ? 2 : 1;
      if (w === 2) supp.push(cpLength);
      i += w;
      cpLength += 1;
    }
    return {
      utf16ToCp(u16) {
        const u = u16 < 0 ? 0 : u16 > s.length ? s.length : u16;
        let lo = 0;
        let hi = supp.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (supp[mid] + mid + 1 < u) lo = mid + 1;
          else hi = mid;
        }
        return u - lo;
      },
    };
  }

  function utf16ToCpOffsets(text, offsets) {
    const idx = utf16ToCpIndex(text);
    return offsets.map(([s, e]) => [idx.utf16ToCp(s), idx.utf16ToCp(e)]);
  }

  /** Qwen ByteLevel：词表字符 → UTF-8 字节（与 transformers.js BYTES_TO_UNICODE 互逆）。 */
  const qwenByteDecoder = (() => {
    const bytes = [
      ...Array.from({ length: 94 }, (_, i) => i + 33),
      ...Array.from({ length: 12 }, (_, i) => i + 161),
      ...Array.from({ length: 82 }, (_, i) => i + 174),
    ];
    const codes = [...bytes];
    let extra = 0;
    for (let b = 0; b < 256; b++) {
      if (!bytes.includes(b)) {
        bytes.push(b);
        codes.push(256 + extra);
        extra += 1;
      }
    }
    return new Map(codes.map((code, i) => [String.fromCodePoint(code), bytes[i]]));
  })();

  /**
   * Qwen3 ByteLevel：pieces（convert_ids_to_tokens）对齐原文 UTF-16 span。
   * 字素 NFC + UTF-8 字节流 + ByteLevel 词表逆映射；等价于 Python return_offsets_mapping（transformers.js 未提供时）。
   * SYNC: backend/core/language_checker.py → _encode_text offset_mapping（Qwen）
   * @param {string} text 与 tokenizer.encode 相同的原文
   * @param {readonly string[]} pieces
   * @param {ReadonlyMap<string, string>} [addedTokens] added token 按字面 UTF-8
   * @returns {Array<{ start: number, end: number }>} UTF-16 偏移，end 为开区间
   */
  function alignQwenByteTokens(text, pieces, addedTokens = new Map()) {
    const encoder = new TextEncoder();
    const bytes = [];
    const starts = [];
    const ends = [];
    let normalized = '';
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
    for (const segment of segments) {
      const canonical = segment.segment.normalize('NFC');
      normalized += canonical;
      for (const byte of encoder.encode(canonical)) {
        bytes.push(byte);
        starts.push(segment.index);
        ends.push(segment.index + segment.segment.length);
      }
    }
    if (normalized !== text.normalize('NFC')) {
      throw new Error('token offset align failed: text NFC grapheme mismatch');
    }
    let cursor = 0;
    const result = pieces.map((piece) => {
      const literal = addedTokens.get(piece);
      let tokenBytes;
      if (literal !== undefined) {
        tokenBytes = Array.from(encoder.encode(literal));
      } else {
        tokenBytes = [];
        for (const ch of piece) {
          const b = qwenByteDecoder.get(ch);
          if (b === undefined) {
            throw new Error(`token offset align failed at ${starts[cursor] ?? cursor} for piece=${piece}`);
          }
          tokenBytes.push(b);
        }
      }
      if (!tokenBytes.length || tokenBytes.some((byte, i) => byte !== bytes[cursor + i])) {
        throw new Error(`token offset align failed at ${starts[cursor] ?? cursor} for piece=${piece}`);
      }
      const start = starts[cursor];
      cursor += tokenBytes.length;
      return { start, end: ends[cursor - 1] };
    });
    if (cursor !== bytes.length) {
      throw new Error(`token offset align failed: ${cursor} of ${bytes.length} bytes consumed`);
    }
    return result;
  }

  /**
   * 按 token 在原文里顺序对齐 UTF-16 偏移。特殊 token 记为空 span。
   * 词表片：▁/Ġ→空格；<0xXX> 拼 UTF-8。必须贴着 cursor，对不上就抛。
   * @param {string} text
   * @param {number[]} ids
   * @param {(id: number) => string} tokenStr convert_ids_to_tokens（<0xXX> 字节片）
   * @param {Set<number>} specialIds
   * @param {{ pieceText?: (id: number) => string }} [options]
   *   pieceText：单 token 经 tokenizer.decode 的 UTF-16 片段，对齐云端 offset_mapping（ByteLevel 等）。
   */
  function alignUtf16Offsets(text, ids, tokenStr, specialIds, options) {
    const pieceText = options?.pieceText;
    const offsets = [];
    let cursor = 0;
    const bytes = [];
    const byteIds = [];

    function fail(id) {
      throw new Error(`token offset align failed at ${cursor} for id=${id}`);
    }

    function spanFor(piece, id) {
      if (piece == null) fail(id);
      if (piece === '') return [cursor, cursor];
      if (text.startsWith(piece, cursor)) return [cursor, cursor + piece.length];
      if (piece.startsWith(' ') && text.startsWith(piece.slice(1), cursor)) {
        return [cursor, cursor + piece.length - 1];
      }
      fail(id);
    }

    function emitUtf8() {
      if (!bytes.length) return;
      const need = utf8SeqLen(bytes[0]);
      if (bytes.length !== need) fail(byteIds[0]);
      let piece;
      try {
        piece = utf8dec.decode(new Uint8Array(bytes));
      } catch {
        fail(byteIds[0]);
      }
      const span = spanFor(piece, byteIds[0]);
      for (let i = 0; i < byteIds.length; i++) offsets.push(span);
      cursor = span[1];
      bytes.length = 0;
      byteIds.length = 0;
    }

    for (const rawId of ids) {
      const id = Number(rawId);
      if (specialIds.has(id)) {
        emitUtf8();
        offsets.push([cursor, cursor]);
        continue;
      }
      const raw = tokenStr(id);
      if (raw == null) fail(id);
      const byte = BYTE_PIECE.exec(raw);
      if (byte) {
        const b = Number.parseInt(byte[1], 16);
        if (!bytes.length) {
          try {
            utf8SeqLen(b);
          } catch {
            fail(id);
          }
        }
        bytes.push(b);
        byteIds.push(id);
        if (bytes.length === utf8SeqLen(bytes[0])) emitUtf8();
        continue;
      }
      emitUtf8();
      const piece = pieceText ? pieceText(id) : raw.replace(SPACE_MARK, ' ');
      const span = spanFor(piece, id);
      offsets.push(span);
      cursor = span[1];
    }
    emitUtf8();
    return offsets;
  }

  function insertTop(topVals, topIds, p, v) {
    const last = topVals.length - 1;
    if (p <= topVals[last]) return;
    let k = last;
    while (k > 0 && p > topVals[k - 1]) {
      topVals[k] = topVals[k - 1];
      topIds[k] = topIds[k - 1];
      k -= 1;
    }
    topVals[k] = p;
    topIds[k] = v;
  }

  /**
   * 一行 logits → gold 概率 + topk（未归一化 exp 的序与 softmax 相同）。
   * @param {ArrayLike<number>} logits
   * @param {number} base
   * @param {number} vocab
   * @param {number} target
   * @param {number} topk
   */
  function scoreRow(logits, base, vocab, target, topk) {
    if (target < 0 || target >= vocab) {
      throw new Error(`target id ${target} out of vocab ${vocab}`);
    }
    let maxv = -Infinity;
    for (let v = 0; v < vocab; v++) {
      const x = Number(logits[base + v]);
      if (!Number.isFinite(x)) throw new Error('non-finite logit');
      if (x > maxv) maxv = x;
    }
    const topVals = new Float64Array(topk);
    const topIds = new Int32Array(topk);
    topVals.fill(-Infinity);
    let sum = 0;
    let goldUnnorm = 0;
    for (let v = 0; v < vocab; v++) {
      const e = Math.exp(Number(logits[base + v]) - maxv);
      sum += e;
      if (v === target) goldUnnorm = e;
      insertTop(topVals, topIds, e, v);
    }
    if (!(sum > 0) || !Number.isFinite(sum)) throw new Error('softmax sum not finite');
    const p = goldUnnorm / sum;
    if (!Number.isFinite(p) || p < 0) throw new Error('token probability not finite');
    const pred = [];
    for (let k = 0; k < topk; k++) {
      if (!Number.isFinite(topVals[k])) break;
      pred.push([topIds[k], roundSigFigs(topVals[k] / sum)]);
    }
    return { p: roundSigFigs(p), pred };
  }

  function sliceByCp(text, cp0, cp1) {
    if (cp1 <= cp0) return '';
    return Array.from(text).slice(cp0, cp1).join('');
  }

  /**
   * 一块前向的 logits（位置 start..end-1）→ 对 ids[start+1 .. min(end, seq-1)] 打分。
   * SYNC: language_checker._run_inference_and_process_chunked
   */
  function scoreChunk(logits, vocab, ids, start, end, topk = TOPK) {
    const targetEnd = Math.min(end + 1, ids.length);
    const validLen = targetEnd - (start + 1);
    if (validLen <= 0) return [];
    const rows = [];
    for (let j = 0; j < validLen; j++) {
      rows.push(scoreRow(logits, j * vocab, vocab, ids[start + 1 + j], topk));
    }
    return rows;
  }

  /**
   * @param {object} args
   * @param {{ p: number, pred: [number, number][] }[]} args.rows
   * @param {number[]} args.ids
   * @param {Array<[number, number]>} args.offsets code-point offsets，与 ids 等长
   * @param {string} args.text
   * @param {(id: number) => string} args.decodeId
   */
  function bpeFromRows({ rows, ids, offsets, text, decodeId }) {
    const { offsets: payload, insertFirst } = scoringPayloadOffsets(offsets);
    const scored = Math.max(0, ids.length - 1);
    const maxByIds = insertFirst ? ids.length : scored;
    if (payload.length > maxByIds) {
      throw new Error(`payload ${payload.length} longer than scored positions ${maxByIds}`);
    }
    if (payload.length > rows.length) {
      throw new Error(`payload ${payload.length} longer than rows ${rows.length}`);
    }
    const bpe = [];
    for (let i = 0; i < payload.length; i++) {
      const row = rows[i];
      const [start, end] = payload[i];
      bpe.push({
        offset: [start, end],
        raw: sliceByCp(text, start, end),
        real_topk: [0, row.p],
        pred_topk: row.pred.map(([id, p]) => [decodeId(id), p]),
      });
    }
    return { bpe_strings: bpe };
  }

  return {
    TOPK,
    roundSigFigs,
    scoringPayloadOffsets,
    ensureGemmaBos,
    utf16ToCpOffsets,
    alignUtf16Offsets,
    alignQwenByteTokens,
    scoreRow,
    scoreChunk,
    bpeFromRows,
    sliceByCp,
  };
})();
