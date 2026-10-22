/**
 * 选项页「关于」：Info Lens 介绍、反馈、商店评价。
 * mount() 写入 #about 并绑定事件；htmlShell() 供测试断言结构。
 */
globalThis.IL_optionsAbout = (function () {
  const LEAD_ROW = `
    <div class="row">
      <div class="row-text">
        <p class="about-lead">{{LEAD}}</p>
      </div>
    </div>`;

  const ACTIONS = `
    <div class="row about-actions">
    <details class="about-feedback" id="about_feedback">
      <summary class="about-pill">{{FEEDBACK}}</summary>
      <div class="row row-about-note">
        <p class="row-desc" id="about_prompt">{{PROMPT}}</p>
        <div id="about_message" class="about-note-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="about_prompt"></div>
      </div>
      <div class="row">
        <label class="row-title" for="about_contact"><span>{{CONTACT}}</span> <span class="about-optional">{{OPTIONAL}}</span></label>
        <input type="text" id="about_contact" maxlength="200" autocomplete="off" spellcheck="false" aria-label="{{CONTACT_ARIA}}">
      </div>
      <div class="row">
        <p id="about_feedback_status" class="row-desc" hidden></p>
        <button type="button" id="about_send" disabled>{{SEND}}</button>
      </div>
    </details>
    <a class="about-pill" href="{{STORE_URL}}" target="_blank" rel="noopener noreferrer">{{REVIEW}}</a>
    </div>`;

  function htmlShell({ leadHtml, storeReviewUrl, tr }) {
    const t = tr;
    const leadRow = LEAD_ROW.replace('{{LEAD}}', leadHtml);
    const actions = ACTIONS
      .replace('{{FEEDBACK}}', t('Feedback'))
      .replace('{{PROMPT}}', t("The author would love to hear from you. Say anything you like—you can paste images too."))
      .replace('{{CONTACT}}', t('Contact'))
      .replace('{{OPTIONAL}}', t('optional'))
      .replace('{{CONTACT_ARIA}}', t('Contact, optional'))
      .replace('{{SEND}}', t('Send'))
      .replace('{{REVIEW}}', t('Leave a review'))
      .replace('{{STORE_URL}}', storeReviewUrl);
    return `<h2>${t('About')}</h2><div class="group">${leadRow}${actions}</div>`;
  }

  /** 无 IH_i18n 的选项页（如 Semantic）用 About 专用 tr */
  function localeTr() {
    const ZH = globalThis.IL_optionsAbout_zh;
    if (!ZH) throw new Error('IL_optionsAbout_zh missing — inject options-about-zh.js');
    const forced = globalThis.IL_CONFIG?.lang || globalThis.IH_CONFIG?.lang || '';
    if (forced !== '' && forced !== 'en' && forced !== 'zh') {
      throw new Error('config.lang must be "en" or "zh"');
    }
    const ui = (forced || globalThis.chrome?.i18n?.getUILanguage?.() || '').toLowerCase().replaceAll('_', '-');
    const zh = /^zh/.test(ui);
    return (en) => (zh ? (ZH[en] ?? en) : en);
  }

  function mount(section, { tr, leadHtml, storeReviewUrl, sendNote }) {
    if (!section) throw new Error('about section missing');
    if (!tr || !leadHtml || !storeReviewUrl || !sendNote) {
      throw new Error('IL_optionsAbout.mount: tr, leadHtml, storeReviewUrl, sendNote required');
    }
    if (!globalThis.IL_aboutNote) {
      throw new Error('IL_aboutNote missing — inject aboutNote.js before options-about.js');
    }
    section.innerHTML = htmlShell({ tr, leadHtml, storeReviewUrl });

    const about_feedback = section.querySelector('#about_feedback');
    const about_message = section.querySelector('#about_message');
    const about_contact = section.querySelector('#about_contact');
    const about_send = section.querySelector('#about_send');
    const about_feedback_status = section.querySelector('#about_feedback_status');
    if (!about_feedback || !about_message || !about_contact || !about_send || !about_feedback_status) {
      throw new Error('about mount incomplete');
    }

    let aboutPhase = '';

    function clearAboutError() {
      if (!about_feedback_status.hidden) {
        about_feedback_status.hidden = true;
        about_feedback_status.textContent = '';
      }
    }

    const aboutNote = globalThis.IL_aboutNote.bind(about_message, {
      onSync() { syncAboutSend(); },
      onEdit() {
        if (aboutPhase === 'sent') aboutPhase = '';
        clearAboutError();
        syncAboutSend();
      },
      onError(kind) {
        about_feedback_status.hidden = false;
        about_feedback_status.textContent = kind === 'read'
          ? tr('Could not read that image.')
          : tr('Images are limited to 1 MB in total.');
      },
    });

    function setAboutLocked(locked) {
      about_message.contentEditable = locked ? 'false' : 'true';
      about_contact.disabled = locked;
    }

    function syncAboutSend() {
      if (aboutPhase === 'sending') {
        about_send.classList.remove('about-sent');
        about_send.classList.add('about-sending');
        about_send.textContent = tr('Sending…');
        about_send.disabled = true;
        return;
      }
      if (aboutPhase === 'sent') {
        about_send.classList.remove('about-sending');
        about_send.classList.add('about-sent');
        about_send.textContent = tr('Sent');
        about_send.disabled = true;
        return;
      }
      about_send.classList.remove('about-sending', 'about-sent');
      about_send.textContent = tr('Send');
      about_send.disabled = aboutNote.busy() || !aboutNote.hasContent();
    }

    about_feedback.addEventListener('toggle', () => {
      if (about_feedback.open) about_message.focus();
    });
    about_contact.addEventListener('input', () => {
      if (aboutPhase === 'sent') aboutPhase = '';
      clearAboutError();
      syncAboutSend();
    });
    about_send.addEventListener('click', async () => {
      if (aboutPhase || aboutNote.busy() || about_send.disabled) return;
      aboutPhase = 'sending';
      setAboutLocked(true);
      clearAboutError();
      syncAboutSend();
      try {
        const note = await aboutNote.payload();
        if (!note.message && note.images.length === 0) return;
        await sendNote({
          message: note.message,
          images: note.images,
          contact: about_contact.value.trim(),
        });
        aboutNote.clear();
        aboutPhase = 'sent';
        about_feedback_status.hidden = false;
        about_feedback_status.textContent = tr('Thank you. Your feedback helps the author improve.');
      } catch (err) {
        about_feedback_status.hidden = false;
        about_feedback_status.textContent = err?.message || String(err);
      } finally {
        if (aboutPhase !== 'sent') aboutPhase = '';
        setAboutLocked(false);
        syncAboutSend();
      }
    });
  }

  async function applyOpenFeedbackIfRequested() {
    const key = globalThis.IL_OPEN_ABOUT_FEEDBACK_KEY || 'il_open_about_feedback';
    const res = await chrome.storage.session.get({ [key]: false });
    if (!res[key]) return;
    await chrome.storage.session.remove(key);
    const about = document.getElementById('about');
    const details = document.getElementById('about_feedback');
    const message = document.getElementById('about_message');
    if (about) about.scrollIntoView({ block: 'start' });
    if (details instanceof HTMLDetailsElement) {
      details.open = true;
      message?.focus();
    }
  }

  return { mount, htmlShell, localeTr, applyOpenFeedbackIfRequested };
})();
