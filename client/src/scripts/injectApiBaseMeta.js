/**
 * 构建时向 HTML <head> 注入 inforadar-api-base meta（仅当 INFORADAR_API_BASE 已设置）。
 * GitHub / CF / HF Docker：`INFORADAR_API_BASE=https://api.info-lens.app`
 * 本地：不设该变量 → 无 meta → 运行时 resolveApiBase() 为同源 ''。
 */

const { escapeHtmlText } = require('./injectPageMetaIntoHtml.js');

const META_NAME = 'inforadar-api-base';

/**
 * @param {string} html
 * @returns {string}
 */
function injectApiBaseMeta(html) {
    const raw = process.env.INFORADAR_API_BASE?.trim();
    if (!raw) return html;
    const content = escapeHtmlText(raw.replace(/\/+$/, ''));
    // 只认真实 <meta>，避免页内 JS 里 querySelector('meta[name=...]') 误判已注入
    if (/<meta\s[^>]*\bname=["']inforadar-api-base["']/i.test(html)) return html;
    const tag = `<meta name="${META_NAME}" content="${content}">`;
    if (/<meta\s+charset/i.test(html)) {
        return html.replace(/(<meta\s+charset[^>]*>)/i, `$1\n    ${tag}`);
    }
    return html.replace(/<head>/i, `<head>\n    ${tag}`);
}

module.exports = { injectApiBaseMeta };
