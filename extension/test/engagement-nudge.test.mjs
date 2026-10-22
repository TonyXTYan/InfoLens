/**
 * 满意度条计数与间隔。运行：node --test extension/test/engagement-nudge.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInThisContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
const extRoot = join(dir, '..');

globalThis.IL_ENGAGEMENT_NUDGE_KEY = 'test_engagement_nudge';
runInThisContext(
  readFileSync(join(extRoot, 'shared/engagement-nudge.js'), 'utf8'),
  { filename: 'engagement-nudge.js' },
);
const N = globalThis.IL_engagementNudge;

test('首次：满 10 次成功应提示', () => {
  let s = N.empty();
  for (let i = 0; i < 9; i++) {
    const out = N.noteSuccessState(s);
    s = out.state;
    assert.equal(out.shouldPrompt, false);
  }
  const tenth = N.noteSuccessState(s);
  assert.equal(tenth.state.successTotal, 10);
  assert.equal(tenth.shouldPrompt, true);
});

test('关闭后：以后再说后再成功 20 次且未满 14 天不提示', () => {
  let s = N.empty();
  for (let i = 0; i < 10; i++) s = N.noteSuccessState(s).state;
  s = N.markShownState(s);
  s = N.dismissState(s, 'later', 1_000_000);
  assert.equal(s.intervalScale, 2);
  for (let i = 0; i < 19; i++) s = N.noteSuccessState(s).state;
  assert.equal(N.shouldPrompt(s, 1_000_000 + 1), false);
  s = N.noteSuccessState(s).state;
  assert.equal(s.successTotal, 30);
  assert.equal(N.shouldPrompt(s, 1_000_000 + 1), false);
  const afterDoubledWeek = 1_000_000 + N.AGAIN_MS * 2;
  assert.equal(N.shouldPrompt(s, afterDoubledWeek), true);
});

test('review / dont_show_again 永久 mute', () => {
  let s = N.empty();
  for (let i = 0; i < 10; i++) s = N.noteSuccessState(s).state;
  s = N.dismissState(s, 'review');
  assert.equal(s.mute, true);
  const next = N.noteSuccessState(s);
  assert.equal(next.shouldPrompt, false);
});

test('engagementNudgeDebug：除 mute 外每次都提示', () => {
  globalThis.IH_CONFIG = { engagementNudgeDebug: true };
  try {
    let s = N.empty();
    const first = N.noteSuccessState(s);
    assert.equal(first.shouldPrompt, true);
    s = N.dismissState(first.state, 'later');
    const second = N.noteSuccessState(s);
    assert.equal(second.shouldPrompt, true);
    s = N.dismissState(second.state, 'dont_show_again');
    const muted = N.noteSuccessState(s);
    assert.equal(muted.shouldPrompt, false);
  } finally {
    delete globalThis.IH_CONFIG;
  }
});

test('feedback 只记 lastPromptAt', () => {
  let s = N.empty();
  for (let i = 0; i < 10; i++) s = N.noteSuccessState(s).state;
  s = N.dismissState(s, 'feedback', 5_000);
  assert.equal(s.mute, false);
  assert.equal(s.lastPromptAt, 10);
  assert.equal(s.lastPromptTime, 5_000);
});

test('later 不 mute，与 feedback 同写 lastPrompt*，并加倍间隔', () => {
  let s = N.empty();
  for (let i = 0; i < 10; i++) s = N.noteSuccessState(s).state;
  s = N.markShownState(s);
  s = N.dismissState(s, 'later', 100);
  assert.equal(s.mute, false);
  assert.equal(s.lastPromptAt, 10);
  assert.equal(s.lastPromptTime, 100);
  assert.equal(s.intervalScale, 2);
  assert.equal(N.shouldPrompt(s, 100), false);
  for (let i = 0; i < 20; i++) s = N.noteSuccessState(s).state;
  assert.equal(s.successTotal, 30);
  assert.equal(N.shouldPrompt(s, 100 + 1), false);
  assert.equal(N.shouldPrompt(s, 100 + N.AGAIN_MS * 2), true);
});

test('feedback 不加倍间隔', () => {
  let s = N.empty();
  for (let i = 0; i < 10; i++) s = N.noteSuccessState(s).state;
  s = N.markShownState(s);
  s = N.dismissState(s, 'feedback', 100);
  assert.equal(s.intervalScale, 1);
  for (let i = 0; i < 10; i++) s = N.noteSuccessState(s).state;
  assert.equal(N.shouldPrompt(s, 100 + N.AGAIN_MS), true);
});

test('dont_show_again 永久 mute', () => {
  let s = N.empty();
  for (let i = 0; i < 10; i++) s = N.noteSuccessState(s).state;
  s = N.dismissState(s, 'dont_show_again');
  assert.equal(s.mute, true);
  assert.equal(N.noteSuccessState(s).shouldPrompt, false);
});

test('later 后须 success 与加倍天数同时满足才再弹', () => {
  const t0 = 2_000_000;
  const wait = N.AGAIN_MS * 2;
  let s = N.empty();
  for (let i = 0; i < 10; i++) s = N.noteSuccessState(s).state;
  s = N.markShownState(s);
  s = N.dismissState(s, 'later', t0);
  for (let i = 0; i < 19; i++) s = N.noteSuccessState(s).state;
  assert.equal(N.shouldPrompt(s, t0 + wait + 1), false);
  s = N.noteSuccessState(s).state;
  assert.equal(N.shouldPrompt(s, t0 + 1), false);
  assert.equal(N.shouldPrompt(s, t0 + wait), true);
});
