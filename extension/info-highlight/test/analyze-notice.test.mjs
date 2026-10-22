/**
 * 门面分析 notice：按文案去重、今天不再提示、换文案重弹；429 报错停下；报错不清已画高亮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
const background = readFileSync(join(dir, '../background.js'), 'utf8');
const content = readFileSync(join(dir, '../content.js'), 'utf8');
const pdf = readFileSync(join(dir, '../pdf/highlight.js'), 'utf8');
const analyzeRun = readFileSync(join(dir, '../analyzeRun.js'), 'utf8');

function loadNoticeHelpers() {
  const start = pageMap.indexOf('function analyzeNoticeKey');
  const end = pageMap.indexOf('function openOptionsSection');
  if (start < 0 || end < start) throw new Error('analyze notice helpers missing');
  const sandbox = {};
  runInNewContext(`${pageMap.slice(start, end)}\nthis.analyzeNoticeKey = analyzeNoticeKey;\nthis.analyzeNoticeText = analyzeNoticeText;`, sandbox);
  return sandbox;
}

test('分析 notice 文案：界面语言优先，一边为空用另一边；key 用 zh+en 原文', () => {
  const { analyzeNoticeKey, analyzeNoticeText } = loadNoticeHelpers();
  const n = { zh: '免费 API 已限速，约一分钟后恢复', en: 'Free API rate limited. Back to normal in about a minute.' };
  assert.equal(analyzeNoticeText(n, true), n.zh);
  assert.equal(analyzeNoticeText(n, false), n.en);
  assert.equal(analyzeNoticeText({ zh: '', en: 'Slow' }, true), 'Slow');
  assert.equal(analyzeNoticeText({ zh: '慢', en: '' }, false), '慢');
  assert.equal(analyzeNoticeText(null, true), '');
  assert.equal(analyzeNoticeKey(n), `${n.zh}\n${n.en}`);
  assert.notEqual(analyzeNoticeKey(n), analyzeNoticeKey({ zh: '另一句', en: n.en }));
});

function fakeNode() {
  const node = {
    dataset: {},
    children: [],
    className: '',
    classList: { add(name) { node.className = `${node.className} ${name}`.trim(); } },
    textContent: '',
    type: 'button',
    removed: false,
    querySelector(sel) {
      if (sel === '.semantic-find-status-actions') return this.actions;
      if (sel === '.semantic-find-status-close') return this.close;
      if (sel === '.semantic-find-status-continue') return this.continueBtn;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-ih-analyze-notice]') {
        return this.children.filter((c) => c.dataset?.ihAnalyzeNotice != null);
      }
      return [];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...els) {
      this.children.push(...els);
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    insertBefore(child, ref) {
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(child);
      else this.children.splice(i, 0, child);
      return child;
    },
    addEventListener() {},
    remove() { this.removed = true; },
  };
  node.actions = {
    children: [],
    querySelector: (sel) => (sel === '.semantic-find-status-close' ? node.close : null),
    insertBefore: (child, ref) => {
      const i = node.actions.children.indexOf(ref);
      if (i < 0) node.actions.children.push(child);
      else node.actions.children.splice(i, 0, child);
      return child;
    },
    append: (...els) => { node.actions.children.push(...els); },
  };
  node.close = { className: 'semantic-find-status-close' };
  node.actions.children.push(node.close);
  return node;
}

function loadShowAnalyzeNotice(store, list) {
  const start = pageMap.indexOf('/** 分析提示「今天不再提示」');
  const end = pageMap.indexOf('async function showFadeDefaultNotice');
  if (start < 0 || end < start) throw new Error('showAnalyzeNotice block missing');
  const shown = [];
  const messages = [];
  const sandbox = {
    IH_OPTIONS_PAGE: false,
    IH_i18n: { zh: true },
    chrome: {
      runtime: { lastError: null, sendMessage(msg) { messages.push(msg); } },
      storage: {
        local: {
          get(key, cb) { cb({ [key]: store.value }); },
          set(obj) { Object.assign(store, { value: obj.ih_analyze_notice_silence }); },
        },
      },
    },
    document: {
      createElement() {
        const el = {
          type: '',
          className: '',
          textContent: '',
          label: '',
          onClick: null,
          children: [],
          addEventListener(_type, fn) {
            this.onClick = fn;
            this.label = this.textContent;
          },
          append(...nodes) { this.children.push(...nodes); },
        };
        return el;
      },
    },
    tr: (s) => s,
    invalidateCloudWait() {},
    noticeList: async () => list,
    requireOverlay: () => ({
      createStatus() {
        const el = fakeNode();
        el.children.push(el.actions);
        shown.push(el);
        return el;
      },
    }),
  };
  runInNewContext(
    `${pageMap.slice(start, end)}\nthis.showAnalyzeNotice = showAnalyzeNotice;\nthis.analyzeNoticeShownThisRound = analyzeNoticeShownThisRound;\nthis.beginRound = () => analyzeNoticeShownThisRound.clear();`,
    sandbox,
  );
  return { sandbox, shown, messages };
}

test('同一条文案一轮只弹一次；今天不再提示后不弹；换文案重新弹', async () => {
  const store = { value: undefined };
  const list = fakeNode();
  const { sandbox, shown } = loadShowAnalyzeNotice(store, list);
  const a = { zh: '免费 API 已限速，约一分钟后恢复', en: 'Free API rate limited. Back to normal in about a minute.' };
  const b = { zh: '云端额度不多了，即将改走免费 API', en: 'Cloud credits are running low. You\'ll switch to the free API soon.' };

  await sandbox.showAnalyzeNotice(a);
  await sandbox.showAnalyzeNotice(a);
  assert.equal(shown.length, 1);
  assert.equal(list.children.length, 1);

  const row = shown[0].children.find((el) => el.className === 'il-engagement-nudge-actions-row');
  const mute = row?.children.find((el) => el.label === "Don't show again today");
  assert.ok(mute);
  assert.equal(mute.className, 'il-engagement-nudge-mute');
  assert.equal(shown[0].className.includes('is-engagement-nudge'), true);
  assert.equal(shown[0].actions.children.some((el) => el.label === "Don't show again today"), false);
  mute.onClick();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(store.value?.keys?.includes(`${a.zh}\n${a.en}`));

  sandbox.beginRound();
  list.children.length = 0;
  shown.length = 0;
  await sandbox.showAnalyzeNotice(a);
  assert.equal(shown.length, 0);

  await sandbox.showAnalyzeNotice(b);
  assert.equal(shown.length, 1);
  const labels = shown[0].actions.children.map((el) => el.label);
  assert.deepEqual(labels.filter(Boolean), ['Buy credits', 'Go to settings']);
});

test('四级 notice 共用提示条：购买额度带 purchase 打开购买弹窗；去设置只跳分析一节', async () => {
  assert.equal([...pageMap.matchAll(/function showAnalyzeNotice/g)].length, 1);
  assert.match(pageMap, /openOptionsSection\('cloud-credits', \{ purchase: true \}\)/);
  assert.match(pageMap, /openOptionsSection\('analysis'\)/);
  assert.doesNotMatch(pageMap, /openOptionsSection\('cloud-credits'\)/);

  const store = { value: undefined };
  const list = fakeNode();
  const { sandbox, shown, messages } = loadShowAnalyzeNotice(store, list);
  const notices = [
    { zh: '免费 API 已限速，约一分钟后恢复', en: 'Free API rate limited. Back to normal in about a minute.' },
    { zh: '当前为免费慢速 API', en: 'Currently on the free slow API.' },
    { zh: '免费 API 请求过快，请稍后再试', en: 'Too many free API requests. Please try again later.' },
    { zh: '云端额度不多了，即将改走免费 API', en: "Cloud credits are running low. You'll switch to the free API soon." },
    { zh: '云端额度已用完，已改走免费 API', en: 'Cloud credits are used up. Switched to the free API.' },
  ];
  for (const notice of notices) {
    messages.length = 0;
    shown.length = 0;
    list.children.length = 0;
    sandbox.beginRound();
    await sandbox.showAnalyzeNotice(notice);
    const buy = shown[0].actions.children.find((el) => el.label === 'Buy credits');
    const settings = shown[0].actions.children.find((el) => el.label === 'Go to settings');
    assert.ok(buy);
    assert.ok(settings);
    buy.onClick();
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'ih-open-highlight-options', section: 'cloud-credits', purchase: true }]);
    messages.length = 0;
    settings.onClick();
    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'ih-open-highlight-options', section: 'analysis' }]);
  }
});

test('background：purchase 打开选项页带 ?purchase=1 并锚到额度一节；否则只跳对应锚点', () => {
  const start = background.indexOf("if (msg?.type === 'ih-open-highlight-options')");
  const end = background.indexOf("if (msg?.type === 'il-open-about-feedback')");
  if (start < 0 || end < start) throw new Error('ih-open-highlight-options handler missing');
  const created = [];
  const sandbox = {
    OPTIONS_PAGE_SECTIONS: new Set(['cloud-credits', 'analysis', 'highlight']),
    chrome: {
      runtime: { getURL: (p) => `chrome-ext://${p}` },
      tabs: { create: (opts) => created.push(opts) },
    },
  };
  runInNewContext(
    `function handle(msg) {\n${background.slice(start, end)}\n}\nthis.handle = handle;`,
    sandbox,
  );
  sandbox.handle({ type: 'ih-open-highlight-options', section: 'cloud-credits', purchase: true });
  assert.deepEqual(JSON.parse(JSON.stringify(created)), [{ url: 'chrome-ext://options.html?purchase=1#cloud-credits' }]);
  created.length = 0;
  sandbox.handle({ type: 'ih-open-highlight-options', section: 'analysis' });
  assert.deepEqual(JSON.parse(JSON.stringify(created)), [{ url: 'chrome-ext://options.html#analysis' }]);
  created.length = 0;
  sandbox.handle({ type: 'ih-open-highlight-options', section: 'cloud-credits' });
  assert.deepEqual(JSON.parse(JSON.stringify(created)), [{ url: 'chrome-ext://options.html#cloud-credits' }]);
});

test('选项页：?purchase 加载时打开购买弹窗；页内购买额度按钮仍只调 beginCreditsPurchase', () => {
  const opts = readFileSync(join(dir, '../options.js'), 'utf8');
  assert.match(opts, /const openPurchaseOnLoad = pageParams\.has\('purchase'\)/);
  assert.match(opts, /if \(openPurchaseOnLoad\) beginCreditsPurchase\(\);/);
  assert.match(opts, /el\.credits_add\.addEventListener\('click', \(\) => \{\s*beginCreditsPurchase\(\);/);
});

test('选项页内不弹分析 notice', async () => {
  const store = { value: undefined };
  const list = fakeNode();
  const { sandbox, shown } = loadShowAnalyzeNotice(store, list);
  sandbox.IH_OPTIONS_PAGE = true;
  await sandbox.showAnalyzeNotice({ zh: '限速', en: 'slow' });
  assert.equal(shown.length, 0);
});

test('background：pickAnalyzeNotice 格式不对或都空则没有', () => {
  const start = background.indexOf('function pickAnalyzeNotice');
  const end = background.indexOf('const FREE_API_RATE_LIMITED');
  const sandbox = {};
  runInNewContext(`${background.slice(start, end)}\nthis.pickAnalyzeNotice = pickAnalyzeNotice;`, sandbox);
  assert.equal(sandbox.pickAnalyzeNotice(undefined), undefined);
  assert.equal(sandbox.pickAnalyzeNotice('x'), undefined);
  assert.equal(sandbox.pickAnalyzeNotice({ zh: 1, en: '' }), undefined);
  assert.equal(sandbox.pickAnalyzeNotice({ zh: '  ', en: '' }), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.pickAnalyzeNotice({ zh: '限速', en: '' }))), { zh: '限速', en: '' });
});

test('报错路径不清空已画高亮；用户停止/重试仍清', () => {
  const fail = content.slice(content.indexOf('const fail = (err)'), content.indexOf('const idle'));
  assert.doesNotMatch(fail, /clearAll\s*\(/);
  assert.match(fail, /session\?\.painted > 0/);
  assert.match(content, /function retryAnalyze\(\) \{[\s\S]*?clearAll\(\)/);
  assert.match(content, /if \(busy \|\| active\) \{[\s\S]*?clearAll\(\)/);

  const pdfFail = pdf.slice(pdf.indexOf('fail(err) {'), pdf.indexOf('idle() {'));
  assert.doesNotMatch(pdfFail.replace(/\/\/[^\n]*/g, ''), /\bclear\(\)/);
  assert.match(pdfFail, /session\?\.painted > 0/);
  assert.match(pdf, /catch \(error\) \{\s*if \(!still\(\)\) return;\s*clear\(\)/);
});

test('analyzeRun：接收 ih-facade-policy-notice 并交给 IH_showFacadePolicyNotice', () => {
  assert.match(analyzeRun, /ih-facade-policy-notice/);
  assert.match(analyzeRun, /IH_showFacadePolicyNotice/);
});

test('background：0 额度走免费 API 前可发 ih-facade-policy-notice；公告 id 与 page-map key 一致', () => {
  assert.match(background, /maybeNotifyFacadePolicyNotice/);
  assert.match(background, /BALANCE_NOTICE_KEY/);
  assert.match(background, /facadeNoticeId/);
  assert.match(background, /await maybeNotifyFacadePolicyNotice\(tabId\)/);
  assert.match(pageMap, /FACADE_NOTICE_SEEN_ID_KEY/);
  assert.match(pageMap, /showFacadePolicyNotice/);
  assert.match(pageMap, /tr\('Reminder'\)/);
  assert.match(pageMap, /showFacadePolicyNotice[\s\S]*?tr\('Go to settings'\)/);
});

test('analyzeRun：失败响应把 notice 挂到 Error，不再走免费慢速条', () => {
  assert.match(analyzeRun, /err\.notice = res\.notice/);
  assert.doesNotMatch(analyzeRun, /freeSlow|IH_showSlowServerNotice/);
  assert.match(analyzeRun, /if \(!res\?\.ok\) \{[\s\S]*?reject\(err\)/);
});

test('静音按钮中文是今天不再提示；选项页介绍走免费 API；旧选择器和充值注释已去掉', () => {
  const zh = readFileSync(join(dir, '../zh.js'), 'utf8');
  const html = readFileSync(join(dir, '../options.html'), 'utf8');
  assert.match(zh, /"Don't show again today": '今天不再提示'/);
  assert.doesNotMatch(zh, /今日不再提示/);
  assert.match(pageMap, /il-engagement-nudge-mute/);
  assert.match(pageMap, /il-engagement-nudge-actions-row/);
  assert.match(zh, /不限速云端分析收费。没有额度时会自动改走免费 API，有速率限制/);
  assert.match(html, /Full-speed cloud analysis uses credits[\s\S]*analysis automatically switches to the free API, which is rate-limited/);
  assert.doesNotMatch(zh, /free slow server|免费的慢速服务器/);
  assert.doesNotMatch(html, /free slow server|免费的慢速服务器/);
  assert.doesNotMatch(pageMap, /ih-credit-notice|ih-slow-server-notice/);
  assert.doesNotMatch(background, /选项页点「充值」/);
  assert.match(background, /event: 'credits_add_click'/);
  assert.match(background, /选项页点「购买额度」/);
});
