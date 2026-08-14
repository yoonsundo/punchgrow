const header = document.querySelector('.site-header');
const menuButton = document.querySelector('.menu-button');
const navLinks = document.querySelector('.nav-links');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const korean = document.documentElement.lang === 'ko';

function setMenuOpen(open) {
  menuButton?.setAttribute('aria-expanded', String(open));
  navLinks?.classList.toggle('open', open);
  const label = menuButton?.querySelector('.sr-only');
  const visibleLabel = menuButton?.querySelector('[aria-hidden="true"]');

  if (label) {
    if (korean) {
      label.textContent = open ? '메뉴 닫기' : '메뉴 열기';
    } else {
      label.textContent = open ? 'Close menu' : 'Open menu';
    }
  }
  if (visibleLabel) visibleLabel.textContent = open ? 'CLOSE' : 'MENU';
}

function updateHeader() {
  header?.classList.toggle('scrolled', window.scrollY > 16);
}
updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });

menuButton?.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
  setMenuOpen(!isOpen);
});

navLinks?.addEventListener('click', (event) => {
  if (event.target instanceof HTMLAnchorElement) {
    setMenuOpen(false);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuButton?.getAttribute('aria-expanded') === 'true') {
    setMenuOpen(false);
    menuButton.focus();
  }
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 880) setMenuOpen(false);
}, { passive: true });

document.querySelectorAll('.copy-button').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copyTarget ?? '');
    if (!target) return;
    const originalLabel = button.textContent;
    try {
      await navigator.clipboard.writeText(target.textContent ?? '');
      button.textContent = korean ? '복사됨' : 'Copied';
      window.setTimeout(() => { button.textContent = originalLabel; }, 1600);
    } catch {
      button.textContent = korean ? '선택해 복사' : 'Select to copy';
    }
  });
});

document.querySelectorAll('[data-current-year]').forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});

const revealItems = document.querySelectorAll('.reveal');
if (reduceMotion || !('IntersectionObserver' in window)) {
  revealItems.forEach((item) => item.classList.add('visible'));
} else {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  revealItems.forEach((item) => observer.observe(item));
}
