/**
 * 匿名网站域名：主机名归类与文档种类。
 * 运行：node --test extension/info-highlight/test/anonymous-site-domain.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext, runInNewContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
runInThisContext(readFileSync(join(dir, '../anonymousSiteDomain.js'), 'utf8'), {
  filename: 'anonymousSiteDomain.js',
});
const D = globalThis.IH_anonymousSiteDomain;

test.beforeEach(() => {
  delete globalThis.IH_OPTIONS_PAGE;
  delete globalThis.chrome;
});

test('公开主机名去掉开头的 www，保留子域', () => {
  assert.equal(D.hostFromUrl('https://www.Example.com/a?b=1'), 'example.com');
  assert.equal(D.hostFromUrl('https://news.example.com/path'), 'news.example.com');
  assert.equal(D.hostFromUrl('https://www.news.example.com/'), 'news.example.com');
  assert.equal(D.hostFromUrl('https://example.com.'), 'example.com');
});

test('本机、内网和 IP 只报类别', () => {
  assert.equal(D.hostFromUrl('file:///tmp/a.pdf'), 'file');
  assert.equal(D.hostFromUrl('http://localhost:8080/'), 'localhost');
  assert.equal(D.hostFromUrl('http://app.localhost/'), 'localhost');
  assert.equal(D.hostFromUrl('http://127.0.0.1/'), 'localhost');
  assert.equal(D.hostFromUrl('http://[::1]/'), 'localhost');
  assert.equal(D.hostFromUrl('http://10.1.2.3/'), 'lan');
  assert.equal(D.hostFromUrl('http://192.168.1.9/a'), 'lan');
  assert.equal(D.hostFromUrl('http://172.16.0.1/'), 'lan');
  assert.equal(D.hostFromUrl('http://172.32.0.1/'), 'ip');
  assert.equal(D.hostFromUrl('http://169.254.1.1/'), 'lan');
  assert.equal(D.hostFromUrl('http://[fe80::1]/'), 'lan');
  assert.equal(D.hostFromUrl('http://[fd12::1]/'), 'lan');
  assert.equal(D.hostFromUrl('http://8.8.8.8/'), 'ip');
  assert.equal(D.hostFromUrl('http://printer/'), 'intranet');
  assert.equal(D.hostFromUrl('http://nas.local/'), 'intranet');
  assert.equal(D.hostFromUrl('http://wiki.internal/a'), 'intranet');
  assert.equal(D.hostFromUrl('chrome-extension://abc/pdf/viewer.html'), 'chrome-extension:');
  assert.equal(D.hostFromUrl(''), 'unknown');
});

test('受保护页报协议或页面类型，不报路径', () => {
  assert.equal(D.hostFromUrl('chrome://newtab'), 'chrome:newtab');
  assert.equal(D.hostFromUrl('chrome://settings/help'), 'chrome:settings');
  assert.equal(D.hostFromUrl('chrome://extensions'), 'chrome:extensions');
  assert.equal(D.hostFromUrl('about:blank'), 'about:blank');
  assert.equal(D.hostFromUrl('edge://favorites'), 'edge:favorites');
  assert.equal(D.hostFromUrl('view-source:https://secret.example/path?q=1'), 'view-source:');
  assert.equal(D.hostFromUrl('https://chromewebstore.google.com/detail/foo'), 'chromewebstore.google.com');
  assert.equal(D.hostFromUrl('https://chrome.google.com/webstore/detail/foo'), 'webstore');
  assert.equal(D.hostFromUrl('https://chrome.google.com/intl/en'), 'chrome.google.com');
});

test('文档种类：HTML、纯文本、Markdown', () => {
  assert.equal(D.docKind({ contentType: 'text/html; charset=utf-8' }, 'https://ex.com/a'), 'html');
  assert.equal(D.docKind({ contentType: 'application/xhtml+xml' }, 'https://ex.com/'), 'html');
  assert.equal(D.docKind({ contentType: 'text/html' }, 'https://ex.com/README.md'), 'html');
  assert.equal(D.docKind({ contentType: 'text/plain' }, 'file:///tmp/a.txt'), 'txt');
  assert.equal(D.docKind({ contentType: 'text/plain' }, 'https://ex.com/a.py'), 'txt');
  assert.equal(D.docKind({ contentType: 'text/plain' }, 'https://ex.com/README.md'), 'md');
  assert.equal(D.docKind({ contentType: 'text/markdown' }, 'https://ex.com/a'), 'md');
  assert.equal(D.docKind({ contentType: 'application/json' }, 'https://ex.com/a'), 'other');
});

test('抽不到正文记 empty，并带上触发方式', () => {
  const sent = [];
  globalThis.chrome = {
    runtime: {
      sendMessage(msg, cb) {
        sent.push(msg);
        cb();
      },
      lastError: undefined,
    },
  };
  D.fromAnalysis({
    href: 'https://www.example.com/post',
    doc: { contentType: 'text/html' },
    session: null,
    report: { outcome: 'failed', trigger: 'auto' },
  });
  D.fromAnalysis({
    href: 'https://news.example.com/a',
    kind: 'pdf',
    session: { mapped: { text: 'hello', pieces: [{}, {}] } },
    report: { outcome: 'ok', trigger: 'menu' },
  });
  assert.deepEqual(sent, [
    {
      type: 'ih-anonymous-site-domain',
      host: 'example.com',
      kind: 'html',
      chars: 0,
      blocks: 0,
      outcome: 'empty',
      trigger: 'auto',
    },
    {
      type: 'ih-anonymous-site-domain',
      host: 'news.example.com',
      kind: 'pdf',
      chars: 5,
      blocks: 2,
      outcome: 'ok',
      trigger: 'menu',
    },
  ]);
});

test('一次抽出记一笔：对拍延后上报，续跑不报，查看器自启动记 pdf-viewer', () => {
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  const pdf = readFileSync(join(dir, '../pdf/highlight.js'), 'utf8');
  assert.match(content, /if \(!extracted\) return;/);
  assert.match(content, /if \(settle\) \{\s*domainReport = report;/);
  assert.match(content, /domainReport = null;\s*extracted = false;/);
  assert.match(content, /flushDomain\(\);\s*if \(!still\(\)\) return;/);
  assert.match(pdf, /if \(!extracted\) return;/);
  assert.match(pdf, /if \(!session\) extracted = true;/);
  assert.match(pdf, /if \(!trigger\) trigger = 'pdf-viewer'/);
  assert.match(pdf, /il-pdf-ready', viewerSelfStart/);
});

test('选项页不上报', () => {
  globalThis.IH_OPTIONS_PAGE = true;
  const sent = [];
  globalThis.chrome = {
    runtime: {
      sendMessage(msg) {
        sent.push(msg);
      },
    },
  };
  D.fromAnalysis({
    href: 'chrome-extension://abc/options.html',
    doc: { contentType: 'text/html' },
    session: { mapped: { text: 'x', pieces: [{}] } },
    report: { outcome: 'ok', trigger: 'icon' },
  });
  assert.deepEqual(sent, []);
});

test('入口拦住：failed，带上能区分的 host/kind，不收成 empty', () => {
  assert.deepEqual(D.blockedAttempt('chrome://settings/help', 'icon'), {
    host: 'chrome:settings',
    kind: 'other',
    chars: 0,
    blocks: 0,
    outcome: 'failed',
    trigger: 'icon',
  });
  assert.deepEqual(D.blockedAttempt('https://chromewebstore.google.com/detail/x', 'menu'), {
    host: 'chromewebstore.google.com',
    kind: 'html',
    chars: 0,
    blocks: 0,
    outcome: 'failed',
    trigger: 'menu',
  });
  assert.equal(D.kindFromHref('file:///tmp/a.pdf'), 'pdf');
  assert.equal(D.kindFromHref('https://example.com/a'), 'html');
});

test('入口拦住走现有匿名域名上报，开发版 skip 仍生效', async () => {
  const src = readFileSync(join(dir, '../background.js'), 'utf8');
  assert.match(src, /importScripts\('anonymousSiteDomain\.js'\)/);
  assert.match(src, /await postAnonymousSiteDomainForTab\(tabId, trigger\)/);
  assert.match(src, /if \(IH_CONFIG\.skipAnonymousSiteDomain\) return;/);
  const start = src.indexOf('function postAnonymousSiteDomain(body)');
  const end = src.indexOf('async function postLocalInitReport');
  assert.ok(start >= 0 && end > start, 'postAnonymousSiteDomain block missing');
  const chunk = src.slice(start, end);

  async function run(skip, tabUrl) {
    const posted = [];
    const sandbox = {
      IH_CONFIG: { skipAnonymousSiteDomain: skip },
      chrome: {
        tabs: { get: async () => ({ url: tabUrl }) },
        runtime: { getManifest: () => ({ version: '0.3.2' }) },
      },
      IL_postKeepalive: (path, body) => posted.push([path, body]),
      IH_anonymousSiteDomain: D,
    };
    runInNewContext(`${chunk}\nvoid postAnonymousSiteDomainForTab;`, sandbox);
    await sandbox.postAnonymousSiteDomainForTab(1, 'icon');
    return posted;
  }

  const posted = await run(false, 'chrome://settings/help');
  assert.equal(posted.length, 1);
  assert.equal(posted[0][0], '/api/anonymous-site-domain');
  assert.equal(posted[0][1].host, 'chrome:settings');
  assert.equal(posted[0][1].outcome, 'failed');
  assert.equal(posted[0][1].kind, 'other');
  assert.equal(posted[0][1].chars, 0);
  assert.equal(posted[0][1].blocks, 0);
  assert.equal(posted[0][1].trigger, 'icon');
  assert.equal(posted[0][1].version, '0.3.2');
  assert.equal('client_id' in posted[0][1], false);

  const skipped = await run(true, 'chrome://newtab');
  assert.deepEqual(skipped, []);
});

test('受保护页打开扩展自己的说明窗，不往页面注入', () => {
  const src = readFileSync(join(dir, '../background.js'), 'utf8');
  const html = readFileSync(join(dir, '../restricted-page.html'), 'utf8');
  assert.match(src, /IL_isRestrictedUrl\(url\)[\s\S]*?openRestrictedPageWindow\(fresh\.windowId \?\? tab\.windowId\)/);
  assert.match(src, /async function openRestrictedPageWindow\(hostWindowId\) \{[\s\S]*?restricted-page\.html/);
  assert.match(src, /if \(await focusHeld\(restrictedPagePopup\)\) return;/);
  assert.doesNotMatch(src, /pageAlert\([^)]*protected/);
  assert.match(html, /data-ih-i18n="1"/);
  assert.match(html, /data-i18n>Can't analyze this page</);
  assert.doesNotMatch(html, /executeScript|content\.js/);
});
