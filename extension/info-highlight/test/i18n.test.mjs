/**
 * 界面英文与 zh.js 对齐。运行：node --test extension/info-highlight/test/i18n.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sharedRoot = join(root, '../shared');
const zhSrc = readFileSync(join(root, 'zh.js'), 'utf8');
const optionsAboutZhSrc = readFileSync(join(sharedRoot, 'options-about-zh.js'), 'utf8');
const optionsI18nSrc = readFileSync(join(sharedRoot, 'options-i18n.js'), 'utf8');
const i18nSrc = readFileSync(join(root, 'i18n.js'), 'utf8');

function runZh(ctx) {
  runInNewContext(optionsAboutZhSrc, ctx);
  runInNewContext(zhSrc, ctx);
}

function runI18n(ctx) {
  runInNewContext(optionsI18nSrc, ctx);
  runInNewContext(i18nSrc, ctx);
}

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ['test', 'vendor'].includes(e.name) ? [] : sources(p);
    return /\.(js|html)$/.test(e.name) && e.name !== 'zh.js' ? [p] : [];
  });
}

function decode(s) {
  return s.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

/** tr('...') 抠出的是源码原文（\n 还是两个字符），求值成真实字符串才能和 zh.js 的键比。 */
function evalLiteral(raw, quote) {
  return runInNewContext(quote + raw + quote);
}

function usedStrings() {
  const used = new Map();
  const add = (s, file) => used.set(s, relative(root, file));
  for (const file of sources(root)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\btr\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) {
      add(m[1] === undefined ? evalLiteral(m[2], '"') : evalLiteral(m[1], "'"), file);
    }
    for (const m of src.matchAll(/<\w+[^>]*\sdata-i18n(?=[\s>])[^>]*>([^<]*)</g)) add(decode(m[1].trim()), file);
    for (const m of src.matchAll(/<(\w+)[^>]*\sdata-i18n-html(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/g)) add(m[2].trim(), file);
    for (const m of src.matchAll(/<\w+[^>]*\sdata-i18n-attr="([^"]+)"[^>]*>/g)) {
      for (const name of m[1].split(',')) {
        const v = m[0].match(new RegExp(`\\s${name}="([^"]*)"`));
        assert.ok(v, `${relative(root, file)}: ${name} missing on ${m[0]}`);
        add(decode(v[1]), file);
      }
    }
  }
  return used;
}

function vars(s) {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

test('界面英文都有中文，中文表里没有多余条目，占位符一致', () => {
  const ctx = {};
  runInNewContext(optionsAboutZhSrc, ctx);
  const aboutZh = ctx.IL_optionsAbout_zh;
  runInNewContext(zhSrc, ctx);
  const zh = ctx.IH_zh;
  const used = usedStrings();
  for (const key of Object.keys(aboutZh)) used.set(key, 'shared/options-about-zh.js');
  for (const [en, file] of used) assert.ok(en in zh, `${file}: 缺中文 "${en}"`);
  for (const [en, value] of Object.entries(zh)) {
    assert.ok(used.has(en), `zh.js 多余条目 "${en}"`);
    assert.deepEqual(vars(value), vars(en), en);
  }
});

function load(uiLanguage) {
  const ctx = { chrome: { i18n: { getUILanguage: () => uiLanguage } } };
  runZh(ctx);
  runI18n(ctx);
  return ctx.IH_i18n;
}

test('IH_CONFIG.lang 覆盖 Chrome 界面语言，非法值报错', () => {
  function loadWith(uiLanguage, lang) {
    const ctx = { chrome: { i18n: { getUILanguage: () => uiLanguage } }, IH_CONFIG: { lang } };
    runZh(ctx);
    runI18n(ctx);
    return ctx.IH_i18n;
  }
  assert.equal(loadWith('zh-CN', 'en').zh, false);
  assert.equal(loadWith('zh-CN', 'en').tr('Always analyze {host}', { host: 'a.com' }), 'Always analyze a.com');
  assert.equal(loadWith('en-US', 'zh').zh, true);
  assert.equal(loadWith('en-US', 'zh').tr('Always analyze {host}', { host: 'a.com' }), '总是分析 a.com');
  const bad = { chrome: { i18n: { getUILanguage: () => 'en-US' } }, IH_CONFIG: { lang: 'fr' } };
  runZh(bad);
  assert.throws(() => runI18n(bad), /config\.lang/);
});

test('tr：中文界面查表并代入占位符，缺变量报错', () => {
  const zh = load('zh-CN');
  assert.equal(zh.zh, true);
  assert.equal(zh.tr('Always analyze {host}', { host: 'a.com' }), '总是分析 a.com');
  assert.throws(() => zh.tr('Always analyze {host}', {}), /missing \{host\}/);
  const en = load('en-US');
  assert.equal(en.zh, false);
  assert.equal(en.tr('Always analyze {host}', { host: 'a.com' }), 'Always analyze a.com');
  assert.equal(load('zh-TW').zh, true);
});
