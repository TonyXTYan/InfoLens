/**
 * 选项页自带高亮：分析走同一套后端、无悬停、实验开关。
 * 运行：node --test extension/info-highlight/test/options-page-highlight.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const sharedRoot = join(dir, '../../shared');

test('选项页预览高亮：setEnabled 带 icon 触发来源', () => {
  const src = readFileSync(join(dir, '../options-highlight.js'), 'utf8');
  assert.match(src, /api\.setEnabled\(box\.checked, 'icon'\)/);
});

test('选项页挂网页管线，无 tokenTip，实验项标在所属组', () => {
  const html = readFileSync(join(dir, '../options.html'), 'utf8');
  const shellCss = readFileSync(join(sharedRoot, 'options-shell.css'), 'utf8');
  assert.match(html, /<nav class="side-nav"[\s\S]*?<main>[\s\S]*?id="ih_highlight_options_page"/);
  assert.match(html, /href="options-shell\.css"/);
  assert.match(shellCss, /\.top \{[\s\S]*?position: sticky;/);
  assert.match(shellCss, /\.side-nav \{[\s\S]*?position: sticky;/);
  assert.match(shellCss, /\.side-nav a \{[\s\S]*?font-size: 16px;/);
  assert.match(shellCss, /\.side-nav a\.nav-is-new::after/);
  assert.match(shellCss, /\.side-nav a\[aria-current="true"\]/);
  assert.match(shellCss, /padding: 8px 0 100vh/);
  const navJs = readFileSync(join(sharedRoot, 'options-nav.js'), 'utf8');
  const optJs = readFileSync(join(dir, '../options.js'), 'utf8');
  assert.match(html, /src="options-nav\.js"/);
  assert.match(navJs, /scrollIntoView\(\{ block: 'start' \}\)/);
  assert.match(navJs, /function syncNavCurrent/);
  assert.match(navJs, /setAttribute\('aria-current', 'true'\)/);
  assert.match(navJs, /addEventListener\('scroll', scheduleNavCurrent/);
  assert.match(optJs, /IL_optionsNav\.init\(\)/);
  assert.match(html, /<section id="highlight">/);
  assert.match(html, /<section id="settings-restore">/);
  assert.match(html, /id="ih_highlight_options_page">\s*<span data-i18n>Highlight this page to preview<\/span>/);
  assert.ok(html.indexOf('id="ih_highlight_options_page"') < html.indexOf('>Highlight</h2>'));
  assert.ok(html.indexOf('class="page-demo"') < html.indexOf('>Highlight</h2>'));
  assert.match(html, /\.page-demo \{[\s\S]*?justify-content: flex-end;/);
  assert.match(html, /\.page-demo \{[\s\S]*?font-size: 13px;/);
  assert.match(html, /id="ih_paint_style"/);
  assert.match(html, /id="ih_highlight_color"/);
  assert.match(html, /id="ih_text_swatches"/);
  assert.match(html, /id="ih_fade_min_pct"/);
  assert.match(html, /id="ih_fade_norm"/);
  assert.match(html, /Normalize scale/);
  assert.match(html, /Scale the highlight so the most surprising text is at full highlight\./);
  assert.match(html, /id="ih_fade_norm_pct"/);
  assert.match(html, /min="1" max="50"/);
  assert.match(html, /id="restore_recommended"/);
  assert.match(html, /Auto-analyze sites stay/);
  assert.doesNotMatch(html, /Normalize brightness/);
  assert.match(html, /id="ih_fade_value"/);
  assert.match(html, /data-option-id="ih_fade_min_pct"/);
  assert.match(html, /Minimum visibility/);
  assert.match(html, /How visible the least important text stays\./);
  assert.match(html, /ih-fade/);
  assert.match(html, /\.ih-paint-card\[data-style="fade"\]/);
  assert.match(html, /\.row\[hidden\] \{ display: none; \}/);
  assert.match(html, /class="ih-hue"/);
  assert.match(html, /ih-color-swatch-ink/);
  assert.match(html, /For technical reasons, PDFs only support underline/);
  assert.doesNotMatch(html, /Ink for the text-color style/);
  assert.doesNotMatch(html, /How strong the highlight looks/);
  assert.doesNotMatch(html, /<select id="ih_paint_style"/);
  assert.match(html, /\.ih-paint-cards \{[\s\S]*?grid-template-columns: 1fr;/);
  assert.doesNotMatch(html, /grid-template-columns: 1fr 1fr 1fr/);
  assert.match(html, /\.ih-paint-demo \{[\s\S]*?font-size: 16px;/);
  assert.match(html, /button\.ih-paint-card \{[\s\S]*?border-color: transparent;/);
  assert.doesNotMatch(html, /<h2>Experimental<\/h2>/);
  assert.match(html, /Progress chart[\s\S]*class="experimental">Experimental/);
  assert.match(html, /One-tone highlight[\s\S]*class="experimental">Experimental/);
  assert.match(html, /Merge subwords[\s\S]*class="experimental">Experimental/);
  assert.match(html, /Not recommended/);
  const highlight = html.slice(html.indexOf('>Highlight</h2>'), html.indexOf('>Display</h2>'));
  assert.ok(highlight.indexOf('Highlight style') < highlight.indexOf('Highlight color'));
  assert.ok(highlight.indexOf('id="ih_highlight_color"') < highlight.indexOf('id="ih_text_swatches"'));
  assert.ok(highlight.indexOf('id="ih_text_swatches"') < highlight.indexOf('Highlight intensity'));
  assert.ok(highlight.indexOf('Highlight intensity') < highlight.indexOf('Minimum visibility'));
  assert.ok(highlight.indexOf('Minimum visibility') < highlight.indexOf('One-tone highlight'));
  const display = html.slice(html.indexOf('>Display</h2>'), html.indexOf('>Analysis</h2>'));
  assert.ok(display.indexOf('Progress chart') < display.indexOf('Merge subwords'));
  assert.match(html, /src="highlightStyle\.js"[\s\S]*?src="optionDefaults\.js"/);
  assert.match(html, /src="wordMerge\.js"/);
  assert.match(html, /src="auto-nudge\.js"/);
  assert.ok(html.indexOf('src="auto-nudge.js"') < html.indexOf('src="content.js"'));
  assert.doesNotMatch(html, /model-nudge\.js/);
  assert.match(html, /src="content\.js"/);
  assert.match(html, /src="options-page-flags\.js"/);
  assert.match(html, /href="content\.css"/);
  assert.doesNotMatch(html, /tokenTip\.js/);
  const catalog = readFileSync(join(dir, '../options-catalog.js'), 'utf8');
  assert.doesNotMatch(catalog, /ih_highlight_options_page/);
  assert.match(catalog, /'ih_word_merge'/);
  assert.match(catalog, /'ih_paint_style'/);
  assert.match(catalog, /'ih_highlight_color'/);
  assert.match(catalog, /'ih_fade_min_pct'/);
  assert.match(catalog, /'ih_fade_norm'/);
  assert.doesNotMatch(catalog, /ih_text_color/);
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_paint_style/,
  );
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_highlight_color/,
  );
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_highlight_options_page/,
  );
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_word_merge/,
  );
  const opts = readFileSync(join(dir, '../options.js'), 'utf8');
  const defs = readFileSync(join(dir, '../optionDefaults.js'), 'utf8');
  assert.match(defs, /ih_highlight_options_page: false/);
  assert.match(defs, /ih_word_merge: false/);
  assert.match(defs, /ih_article_only: false/);
  assert.match(defs, /ih_from_viewport: true/);
  assert.match(defs, /ih_dynamic_track: true/);
  assert.match(catalog, /'ih_from_viewport'/);
  assert.match(catalog, /'ih_dynamic_track'/);
  assert.doesNotMatch(
    catalog.slice(catalog.indexOf('globalThis.IL_OPTIONS_SEED_SEEN')),
    /ih_from_viewport/,
  );
  assert.match(opts, /IH_optionDefaults/);
  assert.doesNotMatch(opts, /ih_article_only: false/);
  assert.match(opts, /IH_optionsPageReady/);
  const beforeReady = opts.slice(0, opts.indexOf('.finally(() => resolvePageReady())'));
  assert.doesNotMatch(beforeReady.slice(beforeReady.lastIndexOf('Promise.all([')), /Credits/);
  assert.match(opts, /COLOR_INK/);
  assert.match(opts, /Black \/ white/);
  assert.match(opts, /KEY_TEXT_COLOR/);
  assert.match(opts, /TEXT_COLOR_IDS/);
  assert.match(opts, /ih_highlight_color\.hidden/);
  assert.match(opts, /function syncPaintColorUi/);
  assert.match(opts, /ih-paint-card/);
  assert.match(opts, /PAINT_STYLES/);
  assert.match(opts, /\[' Highlight', 19\]/);
  assert.match(opts, /\[' yourself', 4\.29\]/);
  assert.match(opts, /function syncPaintDemo/);
  assert.match(opts, /tokenLevelFromBits/);
  assert.match(opts, /tokenLevelForFade/);
  assert.match(opts, /fadeOpacityForLevel/);
  assert.match(opts, /function syncFadeLabel/);
  assert.match(opts, /KEY_FADE_MIN_PCT/);
  assert.match(opts, /KEY_FADE_NORM/);
  assert.match(opts, /KEY_FADE_NORM_PCT/);
  assert.match(opts, /storage\.local\.remove/);
  assert.doesNotMatch(opts, /storage\.local\.set\(\{ \.\.\.HS\.STORAGE_DEFAULTS/);
  assert.match(opts, /restore_recommended/);
  assert.match(opts, /Auto-analyze sites stay/);
  assert.match(opts, /fadeNormScaleBits/);
  assert.match(opts, /syncDemoFadeScale/);
  assert.match(opts, /Fade unimportant/);
  assert.match(opts, /setAttribute\('aria-hidden', 'true'\)/);
  const collect = readFileSync(join(dir, '../../shared/page/collectTextMap.js'), 'utf8');
  assert.match(collect, /\[aria-hidden="true"\]/);
  assert.doesNotMatch(opts, /The more surprising a word is the stronger it looks/);
  assert.doesNotMatch(opts, /ih-paint-card-label/);
  assert.doesNotMatch(html, /ih-paint-card-label/);
  assert.match(html, /rgba\(var\(--ih-mark-rgb/);
  assert.match(html, /var\(--ih-block-max/);
  assert.match(html, /var\(--ih-line-max/);
  assert.match(html, /var\(--ih-ink-max/);
  assert.match(opts, /--ih-block-max/);
  assert.doesNotMatch(html, /data-option-id="ih_text_color"/);
  assert.doesNotMatch(html, /data-option-id="ih_highlight_color"[^>]*hidden/);
  assert.ok(opts.indexOf('for (const id of HS.COLOR_IDS)') < opts.indexOf("appendColorSwatch(HS.COLOR_INK"));
});

test('选项页抽字忽略只标主文；分析不单独指定后端', () => {
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  const pageMapCode = pageMap.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(pageMap, /IH_OPTIONS_PAGE \? false : articleOnly/);
  assert.match(pageMap, /color-mix\(in srgb-linear/);
  assert.match(pageMap, /highlightForFadeRange/);
  assert.doesNotMatch(pageMapCode, /--ih-(fade|token)-pct/);
  const flags = readFileSync(join(dir, '../options-page-flags.js'), 'utf8');
  assert.match(flags, /IH_OPTIONS_PAGE = true/);
  assert.match(flags, /IL_TEXT_MAP_EXTRA_EXCLUDE \+= ', #cache_desc, \.model-compare \.stars'/);
  assert.match(flags, /IH_tokenTip/);
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  assert.match(bg, /'wordMerge\.js'/);
  assert.doesNotMatch(bg, /isOwnOptionsPage/);
  assert.match(bg, /handleAnalyze\(text, !!msg\.skipCache, false, sender\.tab\?\.id, msg\.cloudModel, waitUi\)/);
  assert.match(bg, /fetchTokensForChoice/);
  assert.match(readFileSync(join(dir, '../local/state.js'), 'utf8'), /ih_model_choice/);
  assert.match(bg, /if \(!forceCloud\) await maybeOfferInit\(\)/);
  assert.match(bg, /if \(!prepare\) \{[\s\S]*?if \(!IH_localState\.choiceById\(st\.choice\)\.local\) return;/);
  assert.match(bg, /maybeOfferInit\(true\)/);
  assert.match(bg, /if \(choice\.local\) \{[\s\S]*?probeAndStore\(\)/);
  assert.match(bg, /await IH_localState\.set\(\{ choice: choice\.id \}\);[\s\S]*?if \(choice\.local\) await maybeOfferInit\(\)/);
  const html = readFileSync(join(dir, '../options.html'), 'utf8');
  const optJs = readFileSync(join(dir, '../options.js'), 'utf8');
  assert.match(optJs, /choice\.local && unavailable/);
  assert.doesNotMatch(html, /<option value="local"/);
  const content = readFileSync(join(dir, '../content.js'), 'utf8');
  assert.match(content, /function setEnabled\(on, why\)/);
  assert.match(content, /void runBatch\(gen \+= 1, false, false\)/);
  assert.match(content, /setEnabled\(\!\(busy \|\| active\), why\)/);
  assert.match(content, /trigger = why \|\| 'other'/);
  assert.match(content, /trigger = 'auto'/);
  assert.match(content, /trigger = why \|\| 'rerun'/);
  const run = readFileSync(join(dir, '../analyzeRun.js'), 'utf8');
  assert.match(run, /if \(globalThis\.IH_OPTIONS_PAGE\) return;/);
  assert.match(run, /armCloudWait && !globalThis\.IH_OPTIONS_PAGE/);
});

test('升级时把最低可见度写成 30%，已有值也覆盖，不弹提示', () => {
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  const hs = readFileSync(join(dir, '../highlightStyle.js'), 'utf8');
  assert.match(hs, /const FADE_MIN_DEFAULT = 30;/);
  assert.match(bg, /async function applyFadeMinDefault\(details\)/);
  assert.match(bg, /void applyFadeMinDefault\(details\)/);
  assert.match(bg, /ih_fade_min_force_30/);
  assert.doesNotMatch(bg, /applyFadeMinDefault[\s\S]{0,800}pending/);
});

test('升级且没存过高亮形式时提醒一次，Settings 打开高亮一节', () => {
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  assert.match(bg, /async function armFadeDefaultNotice\(details\)/);
  assert.match(bg, /details\.reason === 'install'/);
  assert.match(bg, /details\.reason === 'update'/);
  assert.match(bg, /ih_fade_default_notice/);
  assert.match(bg, /OPTIONS_PAGE_SECTIONS\.has\(raw\) \? raw : 'highlight'/);
  assert.match(pageMap, /The default style is now "Fade"\./);
  assert.match(pageMap, /textContent = tr\('OK'\)/);
  assert.match(pageMap, /textContent = tr\('Go to settings'\)/);
  assert.match(pageMap, /ih-open-highlight-options/);
  assert.match(pageMap, /function maybeShowPaintNotices\(\) \{\s*maybeShowFadeDefaultNotice\(\);\s*maybeShowDynamicTrackNotice\(\);\s*maybeShowViewportDefaultNotice\(\);\s*\}/);
  assert.match(readFileSync(join(dir, '../content.js'), 'utf8'), /session\?\.painted > 0\) globalThis\.IH_maybeShowPaintNotices\(\)/);
});

test('默认从视口开始：真正跳过内容时提醒一次，Settings 打开内容一节', () => {
  const pageMap = readFileSync(join(dir, '../page-map.js'), 'utf8');
  const zh = readFileSync(join(dir, '../zh.js'), 'utf8');
  assert.match(pageMap, /ih_viewport_default_notice/);
  assert.match(pageMap, /Content above the screen is skipped; only this screen and below is analyzed\. You can turn this off in settings\./);
  assert.match(pageMap, /data-ih-viewport-notice/);
  assert.match(pageMap, /openOptionsSection\('content'\)/);
  assert.match(zh, /已跳过页面上方的内容，只分析当前屏幕及以下。/);
});

test('选项页 About 可以给作者留言', () => {
  const html = readFileSync(join(dir, '../options.html'), 'utf8');
  const optJs = readFileSync(join(dir, '../options.js'), 'utf8');
  const bg = readFileSync(join(dir, '../background.js'), 'utf8');
  const aboutJs = readFileSync(join(sharedRoot, 'options-about.js'), 'utf8');
  const authorNote = readFileSync(join(sharedRoot, 'sw/author-note.js'), 'utf8');
  assert.match(html, /<a href="#about" data-i18n>About<\/a>/);
  assert.ok(html.indexOf('id="settings-restore"') < html.indexOf('id="about"'));
  assert.match(html, /<section id="about"><\/section>/);
  assert.match(html, /options-about\.css/);
  assert.match(html, /options-about\.js/);
  assert.match(optJs, /IL_optionsAbout\.mount/);
  assert.match(optJs, /Info Highlight is part of <a class="about-home"/);
  assert.match(optJs, /gemajnklkebeikmfphiddpjfimahacdk\/reviews/);
  assert.match(aboutJs, /id="about_feedback"/);
  assert.match(aboutJs, /class="row about-actions"/);
  assert.match(optJs, /type: 'ih-author-note'/);
  assert.match(bg, /msg\?\.type === 'ih-author-note'/);
  assert.match(bg, /IL_postAuthorNote/);
  assert.match(authorNote, /client_id/);
  assert.doesNotMatch(authorNote, /page_url/);
});

test('视口提醒：每次真跳过都提醒，点 OK / 去设置才永久关', () => {
  const src = readFileSync(join(dir, '../page-map.js'), 'utf8');
  const fn = src.slice(src.indexOf('function maybeShowViewportDefaultNotice'), src.indexOf('function dismissViewportDefaultNotice'));
  assert.match(fn, /if \(dynamicTrack \|\| viewportNoticeDismissed \|\| !fromViewport \|\| !\(lastViewportFrom > 0\)\) return;/);
  assert.doesNotMatch(fn, /viewportNoticeDismissed = true;\s*chrome\.storage\.local\.get/);
  const dismiss = src.slice(src.indexOf('function dismissViewportDefaultNotice'), src.indexOf('function dismissViewportDefaultNotice') + 300);
  assert.match(dismiss, /viewportNoticeDismissed = true;\s*chrome\.storage\.local\.set\(\{ \[VIEWPORT_DEFAULT_NOTICE\]: 'seen' \}\)/);
  const show = src.slice(src.indexOf('async function showViewportDefaultNotice'), src.indexOf('async function showViewportDefaultNotice') + 400);
  assert.doesNotMatch(show, /viewportNotice\w* = true/);
});
