/**
 * 构建时根据 content/page-meta.json 向 HTML 写入英文标题、副标题、浏览器标题与导航锚文本，
 * 便于爬虫与不执行 JS 的环境读取。页内可见文案带 data-i18n，运行时由 initI18n 按英文 key 翻译；
 * 浏览器标题在构建时由本脚本写入：主标题与副标题与 page-meta 一致；副标题若以 “-” 开头（工具页 tagline）则与标题之间只加一个空格；否则中间加 “ - ”（如首页主副标题）。
 * 中文环境由 <title data-i18n> 在 initI18n 翻译整串 key。
 * 同时写入 meta description、canonical、JSON-LD、hreflang（见 injectSeoHead）。
 */

const DEFAULT_SITE_ORIGIN = 'https://info-lens.app';
const DEFAULT_STORE_URL =
    'https://chromewebstore.google.com/detail/info-highlight/gemajnklkebeikmfphiddpjfimahacdk';

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtmlText(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 浏览器标题与链接 title：title 与 subtitle 拼接（仅 trim 首尾空白）。
 * 副标题已以 “-” 开头时不额外插入横线，避免 “Title - - tagline”；否则插入 “ - ”。
 *
 * @param {{ title: string, subtitle: string }} meta
 */
function documentTitleEn(meta) {
    const title = String(meta.title ?? '').trim();
    const subtitle = String(meta.subtitle ?? '').trim();
    if (!title) return subtitle;
    if (!subtitle) return title;
    const joiner = subtitle.startsWith('-') ? ' ' : ' - ';
    return title + joiner + subtitle;
}

/**
 * 将带 `data-page-*` 的成对标签内容替换为纯文本（英文，已转义）。
 * @param {string} html
 * @param {string} attrToken 如 data-page-title
 * @param {string} text
 */
function injectDataPageBlock(html, attrToken, text) {
    const esc = escapeHtmlText(text);
    const re = new RegExp(
        `<([a-z][a-z0-9]*)([^>]*\\b${attrToken}\\b[^>]*)>([\\s\\S]*?)<\\/\\1>`,
        'gi'
    );
    return html.replace(re, (_m, tag, attrs) => `<${tag}${attrs}>${esc}</${tag}>`);
}

/**
 * @param {{ siteOrigin?: string }} doc
 * @returns {string}
 */
function siteOrigin(doc) {
    return String(doc?.siteOrigin || DEFAULT_SITE_ORIGIN).replace(/\/+$/, '');
}

/**
 * @param {{ siteOrigin?: string }} doc
 * @param {string} [path]
 * @returns {string}
 */
function absoluteUrl(doc, path) {
    const origin = siteOrigin(doc);
    if (!path || path === '/') return `${origin}/`;
    if (/^https?:\/\//i.test(path)) return path;
    return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * @param {string} html
 * @param {string} snippet
 * @returns {string}
 */
function insertBeforeHeadClose(html, snippet) {
    const trimmed = String(snippet).replace(/^\n+|\n+$/g, '');
    if (/<\/head>/i.test(html)) {
        return html.replace(/<\/head>/i, `${trimmed}\n</head>`);
    }
    return `${html}\n${trimmed}`;
}

/**
 * @param {string} html
 * @param {RegExp} re
 * @param {string} replacement
 * @returns {string | null}
 */
function replaceFirst(html, re, replacement) {
    const m = html.match(re);
    if (!m || m.index == null) return null;
    return html.slice(0, m.index) + replacement + html.slice(m.index + m[0].length);
}

/**
 * @param {{ chromeWebStoreUrl?: string }} doc
 * @param {string} pageUrl
 * @param {string} description
 */
function softwareApplicationLd(doc, pageUrl, description) {
    const storeUrl = doc.chromeWebStoreUrl || DEFAULT_STORE_URL;
    return {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Info Highlight',
        applicationCategory: 'BrowserApplication',
        operatingSystem: 'Chrome',
        url: pageUrl,
        description,
        installUrl: storeUrl,
        sameAs: [storeUrl],
        offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'USD',
            description: 'On-device WebGPU analysis is free. Cloud analysis uses optional paid credits.',
        },
    };
}

/**
 * @param {string} pageUrl
 * @param {string} description
 */
function websiteLd(pageUrl, description) {
    return {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'WebSite',
                name: 'Info Lens',
                url: pageUrl,
                description,
            },
            {
                '@type': 'Organization',
                name: 'Info Lens',
                url: pageUrl,
            },
        ],
    };
}

/**
 * @param {object} obj
 * @returns {string}
 */
function jsonLdScript(obj) {
    const json = JSON.stringify(obj).replace(/</g, '\\u003c');
    return `    <script type="application/ld+json">${json}</script>`;
}

/**
 * 写入 description / canonical / robots / hreflang / JSON-LD。已存在的 description 与 canonical 会被替换。
 *
 * @param {string} html
 * @param {{ canonicalPath?: string, description?: string, jsonLd?: string, hreflang?: boolean, robots?: string }} meta
 * @param {{ siteOrigin?: string, chromeWebStoreUrl?: string }} doc
 * @returns {string}
 */
function injectSeoHead(html, meta, doc) {
    if (!meta) return html;
    const pageUrl = absoluteUrl(doc, meta.canonicalPath);
    const description = meta.description ? String(meta.description).trim() : '';

    if (description) {
        const descZh = meta.descriptionZh ? String(meta.descriptionZh).trim() : '';
        const descTag = descZh
            ? `<meta name="description" content="${escapeHtmlText(description)}" data-desc-en="${escapeHtmlText(description)}" data-desc-zh="${escapeHtmlText(descZh)}">`
            : `<meta name="description" content="${escapeHtmlText(description)}" data-i18n="content">`;
        const replaced = replaceFirst(
            html,
            /<meta\b[^>]*\bname\s*=\s*(["'])description\1[\s\S]*?>/i,
            descTag
        );
        html = replaced || insertBeforeHeadClose(html, `    ${descTag}`);
    }

    if (meta.canonicalPath) {
        const canonTag = `<link rel="canonical" href="${escapeHtmlText(pageUrl)}">`;
        const replaced = replaceFirst(
            html,
            /<link\b[^>]*\brel\s*=\s*(["'])canonical\1[\s\S]*?>/i,
            canonTag
        );
        html = replaced || insertBeforeHeadClose(html, `    ${canonTag}`);
    }

    if (meta.robots) {
        const robotsTag = `<meta name="robots" content="${escapeHtmlText(meta.robots)}">`;
        const replaced = replaceFirst(
            html,
            /<meta\b[^>]*\bname\s*=\s*(["'])robots\1[\s\S]*?>/i,
            robotsTag
        );
        html = replaced || insertBeforeHeadClose(html, `    ${robotsTag}`);
    }

    if (meta.hreflang && meta.canonicalPath) {
        const path = meta.canonicalPath === '/' ? '/' : meta.canonicalPath;
        const sep = path.includes('?') ? '&' : '?';
        const en = absoluteUrl(doc, `${path}${sep}lang=en`);
        const zh = absoluteUrl(doc, `${path}${sep}lang=zh`);
        const def = pageUrl;
        const tags = [
            `<link rel="alternate" hreflang="en" href="${escapeHtmlText(en)}">`,
            `<link rel="alternate" hreflang="zh" href="${escapeHtmlText(zh)}">`,
            `<link rel="alternate" hreflang="x-default" href="${escapeHtmlText(def)}">`,
        ]
            .map((t) => `    ${t}`)
            .join('\n');
        if (!/\bhreflang\s*=/i.test(html)) {
            html = insertBeforeHeadClose(html, tags);
        }
    }

    if (!/application\/ld\+json/i.test(html)) {
        if (meta.jsonLd === 'software') {
            html = insertBeforeHeadClose(
                html,
                jsonLdScript(softwareApplicationLd(doc, pageUrl, description))
            );
        } else if (meta.jsonLd === 'website') {
            html = insertBeforeHeadClose(html, jsonLdScript(websiteLd(pageUrl, description)));
        }
    }

    return html;
}

/**
 * @param {string} html
 * @param {string} pageKey
 * @param {{ pages: Record<string, { title: string, subtitle: string, href?: string, titleNote?: string, heartline?: string, formula?: string, canonicalPath?: string, description?: string, jsonLd?: string, hreflang?: boolean, robots?: string }>, navPageKeys: string[], siteOrigin?: string, chromeWebStoreUrl?: string }} doc
 * @returns {string}
 */
function injectPageMeta(html, pageKey, doc) {
    const meta = doc.pages[pageKey];
    if (!meta) {
        throw new Error(`injectPageMeta: unknown pageKey "${pageKey}"`);
    }

    const dt = documentTitleEn(meta);
    html = html.replace(/<title[^>]*>[^<]*<\/title>/i, `<title data-i18n>${escapeHtmlText(dt)}</title>`);

    html = injectDataPageBlock(html, 'data-page-title', meta.title);
    html = injectDataPageBlock(html, 'data-page-subtitle', meta.subtitle);

    const heartlineElRe = /<([a-z][a-z0-9]*)([^>]*\bdata-page-heartline\b[^>]*)>([\s\S]*?)<\/\1>/gi;
    if (meta.heartline) {
        html = html.replace(heartlineElRe, (_m, tag, attrs) => `<${tag}${attrs}>${escapeHtmlText(meta.heartline)}</${tag}>`);
    } else {
        html = html.replace(heartlineElRe, '');
    }

    const formulaElRe = /<([a-z][a-z0-9]*)([^>]*\bdata-page-formula\b[^>]*)>([\s\S]*?)<\/\1>/gi;
    if (meta.formula) {
        html = html.replace(formulaElRe, (_m, tag, attrs) => `<${tag}${attrs}>${escapeHtmlText(meta.formula)}</${tag}>`);
    } else {
        html = html.replace(formulaElRe, '');
    }

    if (pageKey === 'home' && Array.isArray(doc.navPageKeys)) {
        for (const navKey of doc.navPageKeys) {
            const navMeta = doc.pages[navKey];
            if (!navMeta) {
                throw new Error(`injectPageMeta: navPageKeys references missing page "${navKey}"`);
            }
            const navTitle = documentTitleEn(navMeta);
            const titleNote = navMeta.titleNote
                ? ` <span class="nav-landing-card-title-note" data-i18n>${escapeHtmlText(navMeta.titleNote)}</span>`
                : '';
            const textBlock =
                `<div class="nav-landing-card-text">` +
                `<span class="nav-landing-card-title"><span data-i18n>${escapeHtmlText(navMeta.title)}</span>${titleNote}</span>` +
                `<span class="nav-landing-card-subtitle" data-i18n>${escapeHtmlText(navMeta.subtitle)}</span>` +
                `</div>`;
            const shot =
                navKey === 'causalFlow'
                    ? null
                    : `<div class="nav-landing-card-shot" aria-hidden="true"></div>`;
            const badgeText =
                navKey === 'causalFlow'
                    ? '1M+ plays on RedNote'
                    : navKey === 'semanticHighlight'
                        ? '500 likes/stars on RedNote'
                        : navKey === 'infoHighlight'
                            ? '3K+ likes/stars on RedNote'
                            : '';
            const badge = badgeText
                ? `<span class="nav-landing-card-badge" title="Go to demo on RedNote: xhslink.com" data-i18n="text,title">${badgeText}</span>`
                : '';

            if (navKey === 'causalFlow') {
                const re = new RegExp(
                    `(<div\\b[^>]*\\bdata-nav-page=["']?causalFlow["']?[^>]*>)([\\s\\S]*?)(<\\/div>)`,
                    'i'
                );
                const m = html.match(re);
                if (!m) {
                    throw new Error('injectPageMeta: missing <div data-nav-page="causalFlow"> in home HTML');
                }
                const href = escapeHtmlText(navMeta.href || 'causal_flow.html');
                const slideLink = (slide, content) =>
                    `<a class="nav-landing-card-link" data-demo-slide="${slide}" href="${href}" target="_blank" rel="noopener">${content}</a>`;
                const carouselShot =
                    `<div class="nav-landing-card-shot nav-landing-card-shot--carousel" aria-hidden="true">` +
                    `<div class="nav-landing-card-carousel-viewport">` +
                    `<div class="nav-landing-card-slide" data-slide="flow">${slideLink('flow', '<video muted loop playsinline preload="metadata"></video>')}</div>` +
                    `<div class="nav-landing-card-slide" data-slide="spiral">${slideLink('spiral', '<video muted loop playsinline preload="none"></video>')}</div>` +
                    `<div class="nav-landing-card-slide" data-slide="cot">${slideLink('cot', '<video muted loop playsinline preload="none"></video>')}</div>` +
                    `</div>` +
                    `<button type="button" class="nav-landing-card-carousel-arrow nav-landing-card-carousel-arrow--prev" aria-label="Previous preview">‹</button>` +
                    `<button type="button" class="nav-landing-card-carousel-arrow nav-landing-card-carousel-arrow--next" aria-label="Next preview">›</button>` +
                    `<div class="nav-landing-card-carousel-dots">` +
                    `<button type="button" class="nav-landing-card-carousel-dot is-active" aria-label="Preview 1"></button>` +
                    `<button type="button" class="nav-landing-card-carousel-dot" aria-label="Preview 2"></button>` +
                    `<button type="button" class="nav-landing-card-carousel-dot" aria-label="Preview 3"></button>` +
                    `</div></div>`;
                const inner =
                    badge +
                    `<a class="nav-landing-card-link" data-demo-slide="flow" href="${href}" target="_blank" rel="noopener" title="${escapeHtmlText(navTitle)}">` +
                    textBlock +
                    `</a>` +
                    carouselShot;
                html = html.replace(re, `${m[1]}${inner}${m[3]}`);
                continue;
            }

            const re = new RegExp(
                `(<(a|div)\\b[^>]*\\bdata-nav-page=["']?${navKey}["']?[^>]*>)([\\s\\S]*?)(<\\/\\2>)`,
                'i'
            );
            const m = html.match(re);
            if (!m) {
                throw new Error(`injectPageMeta: missing <a or div data-nav-page="${navKey}"> in home HTML`);
            }
            let openTag = m[1];
            const tagName = m[2].toLowerCase();
            if (navMeta.href && tagName === 'a') {
                if (/\bhref\s*=/.test(openTag)) {
                    openTag = openTag.replace(
                        /\bhref\s*=\s*("[^"]*"|'[^']*')/i,
                        `href="${escapeHtmlText(navMeta.href)}"`
                    );
                } else {
                    openTag = openTag.replace(/>$/, ` href="${escapeHtmlText(navMeta.href)}">`);
                }
            }
            if (/\btitle\s*=/.test(openTag)) {
                openTag = openTag.replace(/\btitle\s*=\s*("[^"]*"|'[^']*')/i, `title="${escapeHtmlText(navTitle)}"`);
            } else {
                openTag = openTag.replace(/>$/, ` title="${escapeHtmlText(navTitle)}">`);
            }
            const inner = badge + textBlock + shot;
            html = html.replace(re, `${openTag}${inner}${m[4]}`);
        }
    }

    return injectSeoHead(html, meta, doc);
}

module.exports = {
    injectPageMeta,
    injectSeoHead,
    escapeHtmlText,
    documentTitleEn,
    absoluteUrl,
    softwareApplicationLd,
};
