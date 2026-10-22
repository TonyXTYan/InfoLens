/**
 * 运行：node --test extension/info-highlight/test/visual-block-order.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const dir = dirname(fileURLToPath(import.meta.url));

test('网页管线注入 visualBlockOrder 并在 extract 后重排 mapped', () => {
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  assert.match(bg, /'visualBlockOrder\.js'/);
  assert.ok(bg.indexOf("'visualBlockOrder.js'") < bg.indexOf("'page-map.js'"));
  assert.match(pageMap, /IL_reorderMappedByVisual/);
  const vbo = readFileSync(join(dir, '../../shared/page/visualBlockOrder.js'), 'utf8');
  assert.match(vbo, /function visualPermutationForKids/);
  assert.match(vbo, /visualPermutationForKids\(liveKids\)/);
  assert.match(vbo, /IL_reorderMappedByVisual/);
});
