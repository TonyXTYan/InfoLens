const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    injectPageMeta,
    injectSeoHead,
    documentTitleEn,
    absoluteUrl,
    softwareApplicationLd,
} = require('./injectPageMetaIntoHtml.js');

const DOC = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../assets/content/page-meta.json'), 'utf8')
);

test('documentTitleEn joins tagline with a single space', () => {
    assert.equal(
        documentTitleEn(DOC.pages.infoHighlight),
        "Info Highlight - highlight the 'informative' parts"
    );
});

test('absoluteUrl builds extensionless origin URLs', () => {
    assert.equal(absoluteUrl(DOC, '/'), 'https://info-lens.app/');
    assert.equal(absoluteUrl(DOC, '/analysis'), 'https://info-lens.app/analysis');
});

test('injectPageMeta fills h1, description, canonical, and SoftwareApplication JSON-LD', () => {
    const src = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title></title>
    <meta name="description" content="old">
</head>
<body>
    <h1><span data-page-title data-i18n></span><span data-page-subtitle data-i18n></span></h1>
</body>
</html>`;
    const html = injectPageMeta(src, 'infoHighlight', DOC);
    assert.match(html, /<title data-i18n>Info Highlight - highlight the 'informative' parts<\/title>/);
    assert.match(html, /data-page-title data-i18n>Info Highlight<\/span>/);
    assert.match(html, /<meta name="description" content="Info Highlight heatmaps per-token surprisal/);
    assert.match(html, /data-i18n="content"/);
    assert.match(html, /<link rel="canonical" href="https:\/\/info-lens.app\/analysis">/);
    assert.match(html, /application\/ld\+json/);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
    assert.equal(ld['@type'], 'SoftwareApplication');
    assert.equal(ld.name, 'Info Highlight');
    assert.equal(ld.applicationCategory, 'BrowserApplication');
    assert.equal(ld.operatingSystem, 'Chrome');
    assert.equal(ld.url, 'https://info-lens.app/analysis');
    assert.equal(ld.installUrl, DOC.chromeWebStoreUrl);
    assert.deepEqual(ld.sameAs, [DOC.chromeWebStoreUrl]);
    assert.equal(ld.offers.price, '0');
});

test('injectPageMeta home gets WebSite JSON-LD and keeps homepage description', () => {
    const src = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title></title>
<meta name="description" content="old">
</head><body>
<h1 data-page-title data-i18n></h1>
<p data-page-subtitle data-i18n></p>
<p data-page-formula data-i18n></p>
<p data-page-heartline data-i18n></p>
<div data-nav-page="causalFlow"></div>
<a data-nav-page="infoHighlight" href="analysis.html"></a>
<a data-nav-page="semanticHighlight" href="#"></a>
</body></html>`;
    const html = injectPageMeta(src, 'home', DOC);
    assert.match(html, /<link rel="canonical" href="https:\/\/info-lens.app\/">/);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
    assert.equal(ld['@graph'][0]['@type'], 'WebSite');
    assert.equal(ld['@graph'][1]['@type'], 'Organization');
    assert.match(html, /Info Lens is a toolbox for exploring the informational nature of LLMs/);
});

test('injectSeoHead bilingual description and hreflang for info-highlight', () => {
    const src = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Info Highlight</title>
<meta name="description" content="">
</head><body></body></html>`;
    const html = injectSeoHead(src, DOC.staticPages['info-highlight.html'], DOC);
    assert.match(html, /data-desc-en="Info Highlight heatmaps/);
    assert.match(html, /data-desc-zh="Info Highlight 用语言模型/);
    assert.match(html, /hreflang="en" href="https:\/\/info-lens.app\/info-highlight\?lang=en"/);
    assert.match(html, /hreflang="zh" href="https:\/\/info-lens.app\/info-highlight\?lang=zh"/);
    assert.match(html, /hreflang="x-default" href="https:\/\/info-lens.app\/info-highlight"/);
    assert.match(html, /<link rel="canonical" href="https:\/\/info-lens.app\/info-highlight">/);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
    assert.equal(ld['@type'], 'SoftwareApplication');
    assert.equal(ld.url, 'https://info-lens.app/info-highlight');
});

test('injectSeoHead keeps canonical before the bilingual lang script so ?lang= can self-canonicalize', () => {
    const src = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Info Highlight</title>
<meta name="description" content="">
<link rel="canonical" href="">
<script>/* lang bootstrap */</script>
</head><body></body></html>`;
    const html = injectSeoHead(src, DOC.staticPages['info-highlight.html'], DOC);
    const canonIdx = html.search(/<link rel="canonical" href="https:\/\/info-lens.app\/info-highlight">/);
    const scriptIdx = html.indexOf('/* lang bootstrap */');
    assert.ok(canonIdx >= 0, 'canonical tag missing');
    assert.ok(scriptIdx > canonIdx, 'canonical must precede the lang script');
});

test('softwareApplicationLd points at the Chrome Web Store listing', () => {
    const ld = softwareApplicationLd(DOC, 'https://info-lens.app/analysis', 'desc');
    assert.equal(
        ld.installUrl,
        'https://chromewebstore.google.com/detail/info-highlight/gemajnklkebeikmfphiddpjfimahacdk'
    );
});
