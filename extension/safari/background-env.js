/**
 * Safari 背景垫片，排在 manifest background.scripts 第一个（build_extension.py --target safari 写入）。
 * Safari 的背景是带 DOM 的非常驻页，不是 SW；也没有 chrome.offscreen。
 * - importScripts：background.js 里引的脚本已按原顺序列进 background.scripts，这里只需让调用变空操作。
 * - chrome.offscreen：在背景页里挂 iframe 当藏页。iframe 是独立扩展页，runtime 消息与 Chrome 藏页一样收发；
 *   移除 iframe 即释放模型与 WebGPU。只覆盖 background.js 用到的 hasDocument / createDocument / closeDocument。
 */
globalThis.importScripts = () => {};

(function installOffscreen() {
  if (globalThis.chrome?.offscreen) return;
  const FRAME_ID = 'il-offscreen';
  const frame = () => document.getElementById(FRAME_ID);

  const offscreen = {
    async hasDocument() {
      return !!frame();
    },
    /** 与 Chrome 一致：页面加载完才 resolve；已有一张则拒绝（background.js 按文案识别）。 */
    async createDocument({ url }) {
      if (frame()) throw new Error('Only a single offscreen document may be created.');
      const el = document.createElement('iframe');
      el.id = FRAME_ID;
      // 与 Chrome 一样按扩展根解析相对路径，与背景页自身路径无关
      el.src = new URL(url, new URL('/', location.href)).href;
      const loaded = new Promise((resolve) => el.addEventListener('load', () => resolve(), { once: true }));
      (document.body || document.documentElement).appendChild(el);
      await loaded;
    },
    async closeDocument() {
      const el = frame();
      if (!el) throw new Error('No current offscreen document.');
      el.remove();
    },
  };
  Object.defineProperty(chrome, 'offscreen', { value: offscreen, configurable: true });
})();
