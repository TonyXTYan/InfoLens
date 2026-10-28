/**
 * Safari 版：背景是带 DOM 的页面、没有 chrome.offscreen，也碰不到 file:。
 * 垫片要对上 background.js 识别藏页错误的文案；构建要把 importScripts 原样展开成 background.scripts。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const EXTENSIONS = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(EXTENSIONS + rel, 'utf8');
const ORIGIN = 'safari-web-extension://0000-test';

/** 只够垫片用的 DOM：appendChild 后下一拍触发 load */
function fakeDocument() {
  const nodes = new Map();
  const root = {
    appendChild(el) {
      nodes.set(el.id, el);
      el.remove = () => nodes.delete(el.id);
      queueMicrotask(() => el.listeners.load?.());
    },
  };
  return {
    body: root,
    documentElement: root,
    getElementById: (id) => nodes.get(id) ?? null,
    createElement: () => ({ id: '', src: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } }),
  };
}

function loadEnv(chrome = { runtime: {} }) {
  const sandbox = { chrome, document: fakeDocument(), location: { href: `${ORIGIN}/_generated_background_page.html` }, URL, queueMicrotask };
  sandbox.globalThis = sandbox;
  vm.runInContext(read('safari/background-env.js'), vm.createContext(sandbox));
  return sandbox;
}

test('Safari 垫片：importScripts 变空操作，iframe 充当唯一藏页', async () => {
  const env = loadEnv();
  assert.equal(env.importScripts('anything.js'), undefined);
  const { offscreen } = env.chrome;
  assert.equal(await offscreen.hasDocument(), false);

  await offscreen.createDocument({ url: 'local/offscreen.html', reasons: ['WORKERS'], justification: 'x' });
  assert.equal(await offscreen.hasDocument(), true);
  assert.equal(env.document.getElementById('il-offscreen').src, `${ORIGIN}/local/offscreen.html`);

  // SYNC: background.js ensureOffscreen 吞掉「已存在」、isOffscreenGone 认「没有藏页」
  await assert.rejects(offscreen.createDocument({ url: 'local/offscreen.html' }), /already exists|Only a single offscreen/i);
  await offscreen.closeDocument();
  assert.equal(await offscreen.hasDocument(), false);
  await assert.rejects(offscreen.closeDocument(), /no current offscreen/i);
});

test('Safari 垫片：浏览器自带 offscreen 时不覆盖', () => {
  const native = { hasDocument: async () => true };
  assert.equal(loadEnv({ runtime: {}, offscreen: native }).chrome.offscreen, native);
});

test('受限页：Safari 内部页一律受限，file: 只在 Safari 受限', () => {
  const restricted = (base, url) => {
    const sandbox = { URL, chrome: { runtime: { getURL: (p) => `${base}${p}` } } };
    sandbox.globalThis = sandbox;
    vm.runInContext(read('shared/sw/restricted-url.js'), vm.createContext(sandbox));
    return sandbox.IL_isRestrictedUrl(url);
  };
  const chrome = 'chrome-extension://abc/';
  const safari = `${ORIGIN}/`;
  assert.equal(restricted(chrome, 'file:///Users/me/a.pdf'), false);
  assert.equal(restricted(safari, 'file:///Users/me/a.pdf'), true);
  assert.equal(restricted(safari, 'https://example.com/'), false);
  for (const url of [`${ORIGIN}/options.html`, 'favorites://', 'safari-resource:/x.css']) {
    assert.equal(restricted(chrome, url), true, url);
  }
});

const BUILD_DEPS = `${EXTENSIONS}info-highlight/node_modules/@huggingface/transformers`;

test('Safari 构建：manifest 与包内文件对得上，且过得了打包校验', { skip: !existsSync(BUILD_DEPS) && '先在 info-highlight 执行 npm install' }, () => {
  const dist = mkdtempSync(join(tmpdir(), 'ih-safari-'));
  try {
    execFileSync('python3', [`${EXTENSIONS}scripts/build_extension.py`, 'info-highlight', '--target', 'safari', '--release', '--dist', dist], { stdio: 'pipe' });
    const out = join(dist, 'info-highlight-safari');
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    const imports = [...read('info-highlight/background.js').matchAll(/^importScripts\('([^']+)'\);$/gm)].map((m) => m[1]);
    assert.ok(imports.length > 10);
    assert.deepEqual(manifest.background, { scripts: ['safari/background-env.js', ...imports, 'background.js'] });
    for (const rel of manifest.background.scripts) assert.ok(existsSync(join(out, rel)), rel);
    assert.ok(!manifest.permissions.includes('offscreen'));
    assert.ok(!JSON.stringify(manifest).includes('file:'));
    assert.equal(manifest.browser_specific_settings.safari.strict_min_version, '17.0');
    assert.deepEqual(manifest.options_ui, { page: 'options.html' });
    // 除 manifest 外 Chrome 原有文件都在
    for (const rel of ['local/offscreen.html', 'local/offscreen.js', 'vendor/transformers/transformers.js']) {
      assert.ok(existsSync(join(out, rel)), rel);
    }
    execFileSync('python3', [`${EXTENSIONS}scripts/package_extension.py`, out, join(dist, 'safari.zip')], { stdio: 'pipe' });
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
