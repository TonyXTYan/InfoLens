/**
 * 选项页反馈框：文字和粘贴的图片混排。
 * PNG，最长边 1280，压完一共不超过 1MB。不限张数。
 * 正文里的 [img:1] 对 images[0]，按出现顺序编号。
 */
globalThis.IL_aboutNote = {
  bind(editor, hooks) {
    const MAX_TEXT = 4000;
    const MAX_BYTES = 1024 * 1024;
    const MAX_EDGE = 1280;
    const blobs = new WeakMap();
    const live = new Set();
    let pending = 0;
    let tail = Promise.resolve();
    const onSync = hooks.onSync;
    const onEdit = hooks.onEdit;
    const onError = hooks.onError;

    function gc() {
      for (const img of live) {
        if (editor.contains(img)) continue;
        URL.revokeObjectURL(img.src);
        blobs.delete(img);
        live.delete(img);
      }
    }

    function collect() {
      let raw = '';
      const images = [];
      let started = false;
      const add = (text) => {
        raw += text;
        if (text) started = true;
      };
      const walk = (parent) => {
        for (const child of parent.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) add(child.textContent);
          else if (child.nodeName === 'BR') add('\n');
          else if (child.nodeName === 'IMG') {
            const blob = blobs.get(child);
            if (!blob) continue;
            images.push(blob);
            add(`[img:${images.length}]`);
          } else if (child.nodeName === 'DIV' || child.nodeName === 'P') {
            if (started && !raw.endsWith('\n')) add('\n');
            walk(child);
          } else walk(child);
        }
      };
      walk(editor);
      return { raw, images };
    }

    function read() {
      gc();
      const note = collect();
      let message = note.raw.trim();
      if (message.length > MAX_TEXT) message = message.slice(0, MAX_TEXT);
      const images = [];
      for (let i = 0; i < note.images.length; i += 1) {
        if (!message.includes(`[img:${i + 1}]`)) break;
        images.push(note.images[i]);
      }
      return { message, images };
    }

    function place(range) {
      const sel = document.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function insertNode(range, node) {
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      place(range);
      return range;
    }

    function caretRange() {
      const sel = document.getSelection();
      if (sel && sel.rangeCount > 0 && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        return sel.getRangeAt(0);
      }
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      return range;
    }

    function encodeBitmap(bitmap, maxEdge) {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), 'image/png');
      });
    }

    async function compressToFit(file, budget) {
      const bitmap = await createImageBitmap(file);
      try {
        for (const edge of [MAX_EDGE, MAX_EDGE / 2]) {
          const blob = await encodeBitmap(bitmap, edge);
          if (blob.size > 0 && blob.size <= budget) return blob;
        }
        return null;
      } finally {
        bitmap.close();
      }
    }

    function makeImg(blob) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      img.alt = '';
      img.draggable = false;
      img.contentEditable = 'false';
      blobs.set(img, blob);
      live.add(img);
      return img;
    }

    function imageBytes() {
      gc();
      let bytes = 0;
      for (const img of live) bytes += blobs.get(img)?.size || 0;
      return bytes;
    }

    async function addFiles(files, range) {
      let errorKind = '';
      let at = range;
      for (const file of files) {
        const used = imageBytes();
        if (used >= MAX_BYTES) {
          errorKind = 'limit';
          break;
        }
        let blob;
        try {
          blob = await compressToFit(file, MAX_BYTES - used);
        } catch {
          errorKind = 'read';
          break;
        }
        if (!blob) {
          errorKind = 'limit';
          break;
        }
        at = insertNode(at, makeImg(blob));
      }
      onEdit();
      if (errorKind) onError(errorKind);
    }

    function enqueue(task) {
      pending += 1;
      onSync();
      const run = tail.then(task, task);
      tail = run.then(() => {}, () => {});
      run.finally(() => {
        pending -= 1;
        onSync();
      });
    }

    function imageFiles(data) {
      const out = [];
      for (const item of data?.items ? [...data.items] : []) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) out.push(file);
        }
      }
      if (!out.length && data?.files) {
        for (const file of data.files) {
          if (file.type.startsWith('image/')) out.push(file);
        }
      }
      return out;
    }

    function clearLoneBreak() {
      if (editor.childNodes.length === 1 && editor.firstChild?.nodeName === 'BR') editor.replaceChildren();
    }

    function locked() {
      return editor.contentEditable === 'false';
    }

    editor.addEventListener('paste', (e) => {
      if (locked()) {
        e.preventDefault();
        return;
      }
      const data = e.clipboardData;
      if (!data) return;
      const text = data.getData('text/plain').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const files = imageFiles(data);
      if (!text && !files.length) {
        if ([...data.types].includes('text/html')) e.preventDefault();
        return;
      }
      e.preventDefault();
      clearLoneBreak();
      const chunk = text.slice(0, Math.max(0, MAX_TEXT - collect().raw.length));
      let range = caretRange();
      if (chunk) range = insertNode(range, document.createTextNode(chunk));
      if (files.length) enqueue(() => addFiles(files, range));
      else onEdit();
    });

    editor.addEventListener('dragover', (e) => e.preventDefault());
    editor.addEventListener('drop', (e) => {
      e.preventDefault();
      if (locked()) return;
      const files = [...e.dataTransfer.files].filter((file) => file.type.startsWith('image/'));
      if (!files.length) return;
      clearLoneBreak();
      enqueue(() => addFiles(files, caretRange()));
    });

    editor.addEventListener('input', () => {
      if (locked()) return;
      gc();
      onEdit();
    });

    async function blobToBase64(blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    }

    return {
      busy: () => pending > 0,
      hasContent() {
        const note = read();
        return note.message.length > 0 || note.images.length > 0;
      },
      clear() {
        for (const img of live) {
          URL.revokeObjectURL(img.src);
          blobs.delete(img);
        }
        live.clear();
        editor.replaceChildren();
      },
      async payload() {
        const note = read();
        const images = [];
        for (const blob of note.images) {
          images.push({ mime: 'image/png', data: await blobToBase64(blob) });
        }
        return { message: note.message, images };
      },
    };
  },
};
globalThis.IH_aboutNote = globalThis.IL_aboutNote;
