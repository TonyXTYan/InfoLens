/**
 * Qwen offset：本机 alignQwenByteTokens 与 PyTorch tokenizer return_offsets_mapping 金样一致。
 * 金样由 backend qwen3-0.6b 生成，见 scripts/info-highlight/gen_qwen_offset_golden.py
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../local/scoring.js'), 'utf8'), {
  filename: 'scoring.js',
});
const S = globalThis.IH_localScoring;

const cases = JSON.parse(
  readFileSync(join(dir, 'fixtures/qwen-offset-golden.json'), 'utf8'),
);

for (const c of cases) {
  test(`Qwen offset 金样：${JSON.stringify(c.text).slice(0, 40)}`, () => {
    const spans = S.alignQwenByteTokens(c.text, c.pieces);
    const utf16 = spans.map((s) => [s.start, s.end]);
    // HF return_offsets_mapping：Unicode 字符下标（与云端 payload 码点 offset 一致）
    const cp = S.utf16ToCpOffsets(c.text, utf16);
    assert.deepEqual(cp, c.utf16);
  });
}
