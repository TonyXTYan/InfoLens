/**
 * 收藏自动模式白名单。运行：node --test extension/info-highlight/test/library-capture-allowlist.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../library-capture-allowlist.js'), 'utf8'), {
  filename: 'library-capture-allowlist.js',
});

const { urlOnFullCaptureAllowlist } = globalThis.IH_libraryCaptureAllowlist;

test('公众号图文路径在白名单', () => {
  assert.equal(
    urlOnFullCaptureAllowlist('https://mp.weixin.qq.com/s/abc123'),
    true,
  );
});

test('其它站一律不在白名单', () => {
  assert.equal(
    urlOnFullCaptureAllowlist('https://m.gulongbbs.com/jinyong/sdxl/16166.html'),
    false,
  );
});
