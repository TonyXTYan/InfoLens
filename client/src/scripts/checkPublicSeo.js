/**
 * 构建后检查 dist 里的 SEO 标签、robots.txt / sitemap.xml，以及 404.html 存在。
 * 用法：node scripts/checkPublicSeo.js ../dist-cf
 */
const fs = require('fs');
const path = require('path');

const dist = path.resolve(process.cwd(), process.argv[2] || '../dist-cf');

function read(rel) {
    const full = path.join(dist, rel);
    if (!fs.existsSync(full)) {
        throw new Error(`missing ${rel} in ${dist}`);
    }
    return fs.readFileSync(full, 'utf8');
}

function must(cond, msg) {
    if (!cond) throw new Error(msg);
}

const robots = read('robots.txt');
must(robots.startsWith('User-agent:'), 'robots.txt is not a robots file');
must(!robots.includes('<html'), 'robots.txt looks like HTML');
must(robots.includes('Sitemap: https://info-lens.app/sitemap.xml'), 'robots.txt missing sitemap');
must(robots.includes('Disallow: /uninstall'), 'robots.txt missing uninstall disallow');

const sitemap = read('sitemap.xml');
must(sitemap.includes('<?xml'), 'sitemap.xml missing xml declaration');
must(!sitemap.includes('<html'), 'sitemap.xml looks like HTML');
for (const loc of [
    'https://info-lens.app/',
    'https://info-lens.app/analysis',
    'https://info-lens.app/info-highlight',
    'https://info-lens.app/info-highlight?lang=zh',
    'https://info-lens.app/causal_flow',
]) {
    must(sitemap.includes(`<loc>${loc}</loc>`), `sitemap missing ${loc}`);
}

read('404.html');

function checkPage(file, { canonical, descriptionSnippet, jsonLdType, h1Snippet, hreflang }) {
    const html = read(file);
    must(html.includes(`<link rel="canonical" href="${canonical}">`), `${file} missing canonical ${canonical}`);
    if (descriptionSnippet) {
        must(html.includes(descriptionSnippet), `${file} missing description snippet`);
    }
    if (jsonLdType) {
        must(html.includes('"@type":"SoftwareApplication"') || html.includes('"@type": "SoftwareApplication"') || html.includes(`"@type":"${jsonLdType}"`) || html.includes(`"@type": "${jsonLdType}"`), `${file} missing JSON-LD ${jsonLdType}`);
    }
    if (h1Snippet) {
        must(html.includes(h1Snippet), `${file} missing h1 ${h1Snippet}`);
    }
    if (hreflang) {
        must(html.includes('hreflang="zh"'), `${file} missing hreflang zh`);
        must(html.includes('hreflang="en"'), `${file} missing hreflang en`);
        must(html.includes('hreflang="x-default"'), `${file} missing hreflang x-default`);
    }
}

checkPage('analysis.html', {
    canonical: 'https://info-lens.app/analysis',
    descriptionSnippet: 'Info Highlight heatmaps per-token surprisal',
    jsonLdType: 'SoftwareApplication',
    h1Snippet: 'Info Highlight',
});
must(read('analysis.html').includes('About / 关于'), 'analysis.html missing About / 关于');
must(read('analysis.html').includes('data-nosnippet'), 'analysis.html missing data-nosnippet on internal UI');

checkPage('info-highlight.html', {
    canonical: 'https://info-lens.app/info-highlight',
    descriptionSnippet: 'Info Highlight heatmaps per-token surprisal',
    jsonLdType: 'SoftwareApplication',
    hreflang: true,
});
must(read('info-highlight.html').includes('data-desc-zh='), 'info-highlight.html missing zh description');
must(read('info-highlight.html').includes('data-title-zh='), 'info-highlight.html missing zh title data');
{
    const ih = read('info-highlight.html');
    const canonIdx = ih.search(/<link rel="canonical" href="https:\/\/info-lens.app\/info-highlight">/);
    const scriptIdx = ih.indexOf('URLSearchParams(location.search)');
    must(canonIdx >= 0 && scriptIdx > canonIdx, 'info-highlight canonical must precede the lang script');
    must(ih.includes("u.searchParams.set('lang', q)"), 'info-highlight lang script must self-canonicalize ?lang=');
}

checkPage('index.html', {
    canonical: 'https://info-lens.app/',
    descriptionSnippet: 'Info Lens is a toolbox',
    jsonLdType: 'WebSite',
});

checkPage('causal_flow.html', {
    canonical: 'https://info-lens.app/causal_flow',
    descriptionSnippet: 'LLM Causal Flow draws a DAG',
});

console.log(`checkPublicSeo: ok (${dist})`);
