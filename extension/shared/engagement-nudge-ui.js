/**
 * 满意度条 UI（状态条 + 弱「不再提醒」链接）。
 */
globalThis.IL_engagementNudgeUi ||= (function () {
  /**
   * @param {{
   *   list: HTMLElement,
   *   tr: (en: string, vars?: Record<string, string | number>) => string,
   *   storeReviewUrl: string,
   *   promptIndex: number,
   *   successTotal: number,
   *   onDone: (action: 'later' | 'feedback' | 'review' | 'dont_show_again') => void,
   * }} opts
   */
  function show(opts) {
    const { list, tr, storeReviewUrl, onDone } = opts;
    if (!list || list.querySelector('[data-il-engagement-nudge]')) return;

    const overlay = globalThis.IL_overlay;
    if (!overlay?.createStatus) throw new Error('IL_overlay missing');

    const title = tr(
      "You've been using this for a while. Got a minute to share feedback with the author?",
    );
    const detail = tr("Good or bad, both are welcome. It really matters for the product's future.");

    const el = overlay.createStatus({
      label: title,
      detail: '',
      tone: 'info',
      continueHidden: true,
      feedbackHidden: true,
    });
    el.classList.add('is-engagement-nudge');
    el.dataset.ilEngagementNudge = '1';

    const textEl = el.querySelector('.semantic-find-status-text');
    if (textEl) {
      const labelEl = document.createElement('span');
      labelEl.className = 'semantic-find-status-label';
      labelEl.textContent = title;
      const detailEl = document.createElement('div');
      detailEl.className = 'il-engagement-nudge-detail';
      detailEl.textContent = detail;
      textEl.replaceChildren(labelEl, detailEl);
      textEl.title = `${title}\n${detail}`;
    }
    const actions = el.querySelector('.semantic-find-status-actions');
    const closeBtn = el.querySelector('.semantic-find-status-close');
    if (!(actions instanceof HTMLElement) || !(closeBtn instanceof HTMLButtonElement)) {
      throw new Error('engagement nudge: status strip incomplete');
    }

    let closed = false;
    const finish = (action) => {
      if (closed) return;
      closed = true;
      el.remove();
      onDone(action);
    };

    const mkBtn = (label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'semantic-find-status-continue';
      btn.textContent = label;
      return btn;
    };

    const openReview = () => {
      chrome.runtime.sendMessage(
        { type: 'il-open-store-review', url: storeReviewUrl },
        () => {
          void chrome.runtime.lastError;
        },
      );
    };
    const openFeedback = () => {
      chrome.runtime.sendMessage({ type: 'il-open-about-feedback' }, () => {
        void chrome.runtime.lastError;
      });
    };

    closeBtn.addEventListener('click', () => finish('later'));

    const ventBtn = mkBtn(tr('Send feedback'));
    ventBtn.addEventListener('click', () => {
      openFeedback();
      finish('feedback');
    });
    const reviewBtn = mkBtn(tr('Leave a review'));
    reviewBtn.addEventListener('click', () => {
      openReview();
      finish('review');
    });
    const laterBtn = mkBtn(tr('Later'));
    laterBtn.addEventListener('click', () => finish('later'));

    actions.insertBefore(ventBtn, closeBtn);
    actions.insertBefore(reviewBtn, closeBtn);
    actions.insertBefore(laterBtn, closeBtn);

    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'il-engagement-nudge-mute';
    mute.textContent = tr("Don't show again");
    mute.addEventListener('click', () => finish('dont_show_again'));

    const row = document.createElement('div');
    row.className = 'il-engagement-nudge-actions-row';
    el.removeChild(actions);
    row.append(mute, actions);
    el.append(row);

    list.appendChild(el);
  }

  return { show };
})();
