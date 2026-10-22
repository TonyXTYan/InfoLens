// 插件自己的浮层不能重新计入正文。输入框内变化不触发分析（IL_EDITABLE_SEL）。
globalThis.IL_TEXT_MAP_EXTRA_EXCLUDE = '#ih-progress-host, #ih-library-host';
globalThis.IL_EDITABLE_SEL = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
// 实验：与阅读收藏 DOM 克隆对齐，暂不按 checkVisibility 过滤（验证后删或改默认 false）。
globalThis.IL_TEXT_MAP_SKIP_CHECK_VISIBILITY = true;
