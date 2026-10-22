/** 选项页侧栏：锚点滚动 + 滚动时高亮当前节 */
globalThis.IL_optionsNav = {
  init() {
    const navItems = [...document.querySelectorAll('.side-nav a')].map((a) => {
      const id = (a.getAttribute('href') || '').slice(1);
      const section = document.getElementById(id);
      if (!section) throw new Error(`options nav missing #${id}`);
      return { a, section };
    });
    if (!navItems.length) return;

    function syncNavCurrent() {
      const top = document.querySelector('.top');
      const line = (top ? top.getBoundingClientRect().height : 0) + 12;
      let current = navItems[0];
      for (const item of navItems) {
        if (item.section.getBoundingClientRect().top <= line + 1) current = item;
      }
      for (const item of navItems) {
        if (item === current) item.a.setAttribute('aria-current', 'true');
        else item.a.removeAttribute('aria-current');
      }
    }

    let navFrame = 0;
    function scheduleNavCurrent() {
      if (navFrame) return;
      navFrame = requestAnimationFrame(() => {
        navFrame = 0;
        syncNavCurrent();
      });
    }

    for (const { a, section } of navItems) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        section.scrollIntoView({ block: 'start' });
        history.replaceState(null, '', `#${section.id}`);
        a.focus({ preventScroll: true });
        scheduleNavCurrent();
      });
    }

    window.addEventListener('scroll', scheduleNavCurrent, { passive: true });
    window.addEventListener('resize', scheduleNavCurrent);
    syncNavCurrent();
  },
};
