/**
 * Info Highlight 捐助入口：支付宝/微信本地收款码；海外支付在弹窗内自定义美元下单。
 * 运行：node --test extension/info-highlight/test/donate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, '..');
const shRoot = join(dir, '../../semantic-highlight');
const DONATE_WORDS = /donate|donation|\btip\b|捐助|打赏/i;

function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function zhTable() {
  const ctx = {};
  runInNewContext(readFileSync(join(root, '../shared/options-about-zh.js'), 'utf8'), ctx);
  runInNewContext(readFileSync(join(root, 'zh.js'), 'utf8'), ctx);
  return ctx.IH_zh;
}

function donateDialogHtml() {
  const html = readFileSync(join(root, 'options.html'), 'utf8');
  return html.slice(html.indexOf('id="donate_dialog"'), html.indexOf('id="credits_replace_input_dialog"'));
}

test('Info Highlight 设置页有捐助入口，弹窗先选币种再显示对应内容', () => {
  const html = readFileSync(join(root, 'options.html'), 'utf8');
  const opts = readFileSync(join(root, 'options.js'), 'utf8');
  const about = readFileSync(join(root, '../shared/options-about.js'), 'utf8');
  assert.doesNotMatch(html, /id="donate_open"/);
  assert.match(html, /id="welcome_open"/);
  assert.match(opts, /reviewLink\.after\(donateOpen\)/);
  assert.match(opts, /donateOpen\.id = 'donate_open'/);
  assert.match(opts, /donateOpen\.className = 'about-pill'/);
  assert.match(opts, /donateOpen\.textContent = tr\('Donate'\)/);
  assert.match(opts, /\.about-actions > a\.about-pill/);
  assert.match(html, /#about #donate_open \{ margin-left: auto; \}/);
  assert.doesNotMatch(about, DONATE_WORDS);
  assert.doesNotMatch(about, /donate_open/);
  assert.match(html, /id="donate_dialog"/);
  assert.match(html, /id="donate_title"[^>]*data-i18n>Support development</);
  assert.match(html, /data-i18n>Thank you so much for supporting Info Highlight\.</);
  assert.match(html, /class="donate-heart"[^>]*>♥</);
  assert.match(html, /#donate_note \.donate-heart \{[\s\S]*color:\s*#e31c3d/);
  assert.ok(html.indexOf('id="donate_intl_go"') < html.indexOf('id="donate_note"'));
  assert.doesNotMatch(opts, /el\.donate_note\.hidden = isUsd/);
  assert.match(opts, /el\.donate_note\.hidden = false/);
  assert.doesNotMatch(html, /Voluntary donation|International payment/);
  const dialog = donateDialogHtml();
  assert.match(dialog, /id="donate_currency"[^>]*class="credits-currency"/);
  assert.match(dialog, /data-currency="CNY"[^>]*data-i18n>CNY</);
  assert.match(dialog, /data-currency="USD"/);
  assert.match(dialog, /id="donate_cny_wrap"[^>]*hidden/);
  assert.match(dialog, /value="alipay"/);
  assert.match(dialog, /data-i18n>Alipay</);
  assert.match(dialog, /value="wechat"/);
  assert.match(dialog, /data-i18n>WeChat Pay</);
  assert.doesNotMatch(dialog, /value="international"|waffo_cny|Credit pack|API Key|waffo|Waffo/);
  assert.doesNotMatch(dialog, /credits-terms|Terms of Service|Privacy Policy/);
  assert.match(dialog, /data-i18n>Close</);
  assert.match(dialog, /id="donate_intl_go"[^>]*data-i18n>Continue to pay</);
  assert.match(dialog, /id="donate_qr_wrap"[^>]*hidden/);
  assert.match(dialog, /id="donate_intl_wrap"[^>]*hidden/);
  assert.match(opts, /function defaultPurchaseCurrency/);
  assert.match(opts, /layoutCurrencyButtons\(el\.credits_currency/);
  assert.match(opts, /layoutCurrencyButtons\(el\.donate_currency/);
  assert.match(opts, /el\.donate_currency\.addEventListener\('click'/);
  const zh = zhTable();
  assert.equal(zh['Donate'], '捐助');
  assert.equal(zh['Thank you so much for supporting Info Highlight.'], '非常感谢你支持 Info Highlight。');
  assert.ok(!('Voluntary donation. It does not add credits and does not provide goods or services.' in zh));
  assert.ok(!('International payment' in zh));
});

test('Semantic Highlight 设置页没有捐助入口', () => {
  const html = readFileSync(join(shRoot, 'options.html'), 'utf8');
  const js = readFileSync(join(shRoot, 'options.js'), 'utf8');
  assert.doesNotMatch(html, DONATE_WORDS);
  assert.doesNotMatch(js, DONATE_WORDS);
  assert.doesNotMatch(html, /donate_open|donate_dialog/);
});

test('支付宝/微信收款码是插件内静态 PNG，选中才显示', () => {
  const opts = readFileSync(join(root, 'options.js'), 'utf8');
  assert.match(opts, /chrome\.runtime\.getURL\('donate\/alipay\.png'\)/);
  assert.match(opts, /chrome\.runtime\.getURL\('donate\/wechat\.png'\)/);
  const start = opts.indexOf('const DONATE_QR');
  const end = opts.indexOf('el.donate_intl_go.addEventListener');
  assert.ok(start >= 0 && end > start);
  const local = opts.slice(start, end);
  assert.doesNotMatch(local, /sendMessage/);
  assert.doesNotMatch(local, /fetch\s*\(/);
  assert.doesNotMatch(local, /ih-credits/);
  assert.match(local, /el\.donate_qr_wrap\.hidden = false/);
  assert.match(opts, /resetDonateDialog\(\);\s*el\.donate_dialog\.showModal\(\)/);
  const html = readFileSync(join(root, 'options.html'), 'utf8');
  const css = html.slice(html.indexOf('#donate_qr {'), html.indexOf('.donate-intl-amounts'));
  assert.match(css, /width:\s*min\(220px, 100%\)/);
  assert.match(css, /height:\s*auto/);
  assert.match(css, /object-fit:\s*contain/);
  assert.doesNotMatch(css, /height:\s*240px/);
  assert.doesNotMatch(css, /min\(360px/);
  assert.doesNotMatch(donateDialogHtml(), /id="donate_qr"[^>]*(width|height)="/);
  for (const name of ['alipay.png', 'wechat.png']) {
    const size = pngSize(readFileSync(join(root, 'donate', name)));
    assert.ok(size.width >= 400, `${name} width ${size.width}`);
    assert.ok(size.height >= 400, `${name} height ${size.height}`);
    assert.ok(size.height / size.width < 1.3, `${name} should be the QR card, not a poster`);
  }
});

test('海外支付在捐助弹窗内自定义美元下单，不跳充值页、不展示额度包价', () => {
  const opts = readFileSync(join(root, 'options.js'), 'utf8');
  const html = readFileSync(join(root, 'options.html'), 'utf8');
  const dialog = donateDialogHtml();
  const wrap = dialog.slice(dialog.indexOf('id="donate_intl_wrap"'), dialog.indexOf('id="donate_intl_go"'));
  assert.match(wrap, /data-cents="300">\$3</);
  assert.match(wrap, /data-cents="500"[^>]*aria-pressed="true">\$5</);
  assert.match(wrap, /data-cents="1000">\$10</);
  assert.match(wrap, /id="donate_intl_custom"/);
  assert.match(wrap, /class="donate-intl-thanks"[^>]*data-i18n>Includes a small amount of cloud credits</);
  assert.match(wrap, /Enter an amount between \$2\.00 and \$200\.00\./);
  assert.doesNotMatch(wrap, /1,024|1024|thank-you|\$12|1000 points|will get|将获得|Credit pack|matching cloud credits/i);
  assert.doesNotMatch(wrap, />\$2</);
  const visibleIntl = [
    ...wrap.matchAll(/data-i18n(?:-html)?>([\s\S]*?)<\//g),
    ...wrap.matchAll(/>(\$\d+)</g),
  ].map((m) => m[1]).join('\n');
  assert.doesNotMatch(visibleIntl, DONATE_WORDS);
  assert.doesNotMatch(wrap, /credits-terms|Terms of Service|Privacy Policy/);
  const css = html.slice(html.indexOf('.donate-intl-thanks {'), html.indexOf('#credits_orders .order-thanks'));
  assert.match(css, /font-size:\s*11px/);
  const placeholder = html.slice(html.indexOf('#donate_intl_custom::placeholder'), html.indexOf('.donate-intl-range'));
  assert.match(placeholder, /color:\s*#b0b4ba/);
  assert.match(placeholder, /opacity:\s*1/);
  assert.match(placeholder, /color:\s*#7c8187/);

  assert.match(opts, /tr\('Support development'\)/);
  assert.match(opts, /provider: 'waffo'/);
  assert.match(opts, /amount_usd: donateUsd\.formatUsdCents\(amount\.cents\)/);
  const goFn = opts.slice(opts.indexOf('el.donate_intl_go.addEventListener'), opts.indexOf('el.credits_pack_list.addEventListener'));
  assert.match(goFn, /chrome\.tabs\.create\(\{ url: res\.pay_url \}\)/);
  assert.doesNotMatch(goFn, /donate_dialog\.close/);
  assert.doesNotMatch(opts, /beginCreditsPurchase\(\{ currency: 'USD' \}\)/);
  assert.match(opts, /el\.credits_add\.addEventListener\('click', \(\) => \{\s*beginCreditsPurchase\(\);/);
  assert.match(opts, /function defaultPurchaseCurrency\(preferred\) \{\s*return preferred === 'USD' \|\| preferred === 'CNY'/);
  assert.match(opts, /selectedCurrency\(el\.donate_currency\) === 'USD'/);
  assert.doesNotMatch(opts, /Buy credits to support development/);
  assert.match(opts, /function isCustomAmountOrder\(order\) \{\s*return order\?\.amount_kind === 'custom';/);
  assert.match(opts, /function isPromoGiftOrder\(order\) \{\s*return order\?\.amount_kind === 'promo';/);
  assert.match(opts, /function promoGiftLabel\(order\)/);
  assert.match(opts, /appendCell\(li, 'order-money', promoGiftLabel\(order\)\)/);
  assert.match(opts, /appendCell\(li, 'order-thanks', tr\('Thank you for your support\.'\)\)/);
  assert.match(opts, /appendNumericGroup\(li, 'order-points', 'order-credits', String\(order\.order_credits\)/);
  assert.match(opts, /if \(res\.payment_status === 'paid' && isCustomAmountOrder\(confirmed\)\) \{\s*showCreditsStatus\(tr\('Thank you for your support\.'\)\);/);
  const ordersFn = opts.slice(opts.indexOf('function isCustomAmountOrder'), opts.indexOf('function showCreditsStatus'));
  assert.doesNotMatch(ordersFn, /1024|1,024/);
  assert.doesNotMatch(ordersFn, /order_credits.*custom|custom.*order_credits/);

  const bg = readFileSync(join(root, 'background.js'), 'utf8');
  assert.match(bg, /async function startCreditPurchase\(provider, pack, amountUsd\)/);
  assert.match(bg, /body\.amount_usd = amountUsd\.trim\(\)/);
  assert.match(bg, /startCreditPurchase\(msg\.provider, msg\.pack, msg\.amount_usd\)/);
  assert.match(bg, /function normalizeCreditOrderAmountKind\(raw\)/);
  assert.match(bg, /amount_kind: amountKind/);

  const zh = zhTable();
  const intlKeys = [
    'Support development',
    'Other amount',
    'Enter an amount between $2.00 and $200.00.',
    'Includes a small amount of cloud credits',
    'Thank you for your support.',
  ];
  for (const en of intlKeys) {
    assert.doesNotMatch(en, DONATE_WORDS);
    assert.ok(en in zh, `zh.js 缺 "${en}"`);
    assert.doesNotMatch(zh[en], DONATE_WORDS);
  }
  assert.equal(zh['Includes a small amount of cloud credits'], '附赠少量额度');
  assert.equal(zh['Thank you for your support.'], '感谢你的支持。');
  assert.equal(zh.Gift, '赠送');
  const purchase = html.slice(html.indexOf('id="credits_purchase_dialog"'), html.indexOf('id="credits_replace_warn_dialog"'));
  assert.doesNotMatch(purchase, DONATE_WORDS);
  assert.match(purchase, />Buy credits</);
  assert.match(purchase, />Credit pack</);
  assert.match(purchase, /credits-terms/);
  assert.match(purchase, /Terms of Service/);
});
