/**
 * Gemma offset：本机 alignUtf16Offsets 与 PyTorch tokenizer return_offsets_mapping 金样一致。
 * 金样由 backend gemma-3-270m 生成，见 scripts/info-highlight/gen_gemma_offset_golden.py
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
  readFileSync(join(dir, 'fixtures/gemma-offset-golden.json'), 'utf8'),
);

for (const c of cases) {
  test(`Gemma offset 金样：${JSON.stringify(c.text).slice(0, 40)}`, () => {
    const pieceById = new Map(c.ids.map((id, i) => [id, c.pieces[i]]));
    const specialIds = new Set([c.ids[0]]);
    const utf16 = S.alignUtf16Offsets(c.text, c.ids, (id) => pieceById.get(id), specialIds);
    assert.deepEqual(utf16, c.utf16);
  });
}
