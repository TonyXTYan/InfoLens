/**
 * 视口上沿起的段下标。运行：node --test extension/info-highlight/test/scroll-geometry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../../shared/page/scrollGeometry.js'), 'utf8'), {
  filename: 'scrollGeometry.js',
});
const geo = globalThis.IL_scrollGeometry;
const at = (ys, top) => geo.segmentIndexFromViewportTop(ys, top);

test('视口上沿落在段内：取该段', () => {
  const ys = [
    { y0: 0, y1: 10 },
    { y0: 10, y1: 20 },
    { y0: 20, y1: 30 },
  ];
  assert.equal(at(ys, 0), 0);
  assert.equal(at(ys, 12), 1);
  assert.equal(at(ys, 20), 1);
});

test('屏幕上的页眉排在已滚走的正文前：从视口里的正文起', () => {
  const ys = [
    { y0: 0, y1: 40 },
    { y0: -400, y1: -200 },
    { y0: -200, y1: -10 },
    { y0: 80, y1: 200 },
    { y0: 200, y1: 400 },
  ];
  assert.equal(at(ys, 0), 3);
});

test('全在视口之上取最后一段；量不到则 0', () => {
  const ys = [
    { y0: 0, y1: 10 },
    null,
    { y0: 10, y1: 20 },
  ];
  assert.equal(at(ys, 100), 2);
  assert.equal(at([null, null], 0), 0);
  assert.equal(at([], 0), 0);
});

test('视口在两段之间：取下面那段', () => {
  const ys = [
    { y0: 0, y1: 10 },
    { y0: 40, y1: 50 },
  ];
  assert.equal(at(ys, 25), 1);
});

test('段与视口重叠 1px 或只贴边：仍算进范围', () => {
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  const fn = pageMap.slice(
    pageMap.indexOf('function viewportSegments'),
    pageMap.indexOf('function splitSegments'),
  );
  assert.match(fn, /cy\.y1 < view\.top \|\| cy\.y0 > reach/);
  assert.match(fn, /cy\.y0 > view\.bottom \? below : inView/);
  const measure = pageMap.slice(
    pageMap.indexOf('let segYCache'),
    pageMap.indexOf('function viewportSegmentStart'),
  );
  assert.match(measure, /segYMapped !== mapped/);
  assert.match(measure, /ResizeObserver\(dropSegYCache\)/);
  assert.match(measure, /visualViewport\?\.addEventListener\('resize', dropSegYCache\)/);
  assert.match(measure, /Array\.isArray\(tokensBySeg\?\.\[i\]\) \? segYCache : new Map\(\)/);
  assert.match(fn, /tokensBySeg/);
  assert.match(fn, /top: view\.top/);
  const inRange = (cy, view) => !(!cy || cy.y1 < view.top || cy.y0 > view.bottom);
  const view = { top: 100, bottom: 200 };
  assert.equal(inRange({ y0: 199, y1: 200 }, view), true, '底边重叠 1px');
  assert.equal(inRange({ y0: 100, y1: 101 }, view), true, '顶边重叠 1px');
  assert.equal(inRange({ y0: 200, y1: 260 }, view), true, '贴视口底边');
  assert.equal(inRange({ y0: 40, y1: 100 }, view), true, '贴视口顶边');
  assert.equal(inRange({ y0: 80, y1: 99 }, view), false);
  assert.equal(inRange({ y0: 201, y1: 250 }, view), false);
});
