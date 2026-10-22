/**
 * 捐助弹窗海外项：预设金额与 $2–$200 范围。点数不算。
 * 运行：node --test extension/info-highlight/test/credit-custom-usd.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../creditCustomUsd.js'), 'utf8');
const ctx = {};
runInNewContext(src, ctx);
const usd = ctx.IH_creditCustomUsd;

test('海外项预设 $3/$5/$10，默认 $5，范围 $2–$200', () => {
  assert.deepEqual(Array.from(usd.PRESET_CENTS), [300, 500, 1000]);
  assert.equal(usd.DEFAULT_CENTS, 500);
  assert.equal(usd.CUSTOM_USD_MIN_CENTS, 200);
  assert.equal(usd.CUSTOM_USD_MAX_CENTS, 20000);
  assert.equal(usd.formatUsdCents(300), '3.00');
  assert.equal(usd.formatUsdCents(500), '5.00');
  assert.equal(usd.formatUsdCents(1000), '10.00');
  assert.equal(usd.moneyToCents('3'), 300);
  assert.equal(usd.moneyToCents('5.00'), 500);
  assert.equal(usd.moneyToCents('10.5'), 1050);
  assert.equal(usd.inRange(200), true);
  assert.equal(usd.inRange(20000), true);
  assert.equal(usd.inRange(199), false);
  assert.equal(usd.inRange(20001), false);
  assert.equal(usd.moneyToCents('1.99'), 199);
  assert.equal(usd.moneyToCents('200.01'), 20001);
  assert.equal(usd.moneyToCents(''), null);
  assert.equal(usd.moneyToCents('3.001'), null);
});

test('扩展侧不算、不导出点数', () => {
  assert.equal(usd.pointsForCustomUsdCents, undefined);
  assert.doesNotMatch(src, /pointsForCustomUsdCents|将获得|will get/i);
});
