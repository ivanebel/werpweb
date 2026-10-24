'use strict';

(function () {
  const root = document.documentElement;
  let messages = {};
  try {
    messages = JSON.parse(document.body.getAttribute('data-i18n') || '{}');
  } catch (e) {
    messages = {};
  }

  // ---------------------------------------------------------------- theme
  function applyTheme(theme) {
    root.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('werp-theme', theme);
    } catch (e) {
      /* ignore */
    }
    const label = theme === 'dark' ? (messages.lightMode || 'Light mode') : (messages.darkMode || 'Dark mode');
    document.querySelectorAll('[data-theme-label]').forEach((el) => {
      el.textContent = label;
    });
    document.querySelectorAll('[data-theme-toggle]').forEach((el) => {
      el.setAttribute('title', label);
      el.setAttribute('aria-label', label);
    });
    document.dispatchEvent(new CustomEvent('werp:theme', { detail: { theme } }));
  }

  let savedTheme = 'light';
  try {
    savedTheme = localStorage.getItem('werp-theme') || 'light';
  } catch (e) {
    /* ignore */
  }
  applyTheme(savedTheme);

  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-theme-toggle]');
    if (toggle) {
      event.preventDefault();
      applyTheme(root.classList.contains('dark') ? 'light' : 'dark');
      return;
    }

    const sidebarToggle = event.target.closest('[data-sidebar-toggle]');
    if (sidebarToggle) {
      const sidebar = document.getElementById('app-sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      if (sidebar) sidebar.classList.toggle('-translate-x-full');
      if (overlay) overlay.classList.toggle('hidden');
      return;
    }

    const overlay = event.target.closest('#sidebar-overlay');
    if (overlay) {
      const sidebar = document.getElementById('app-sidebar');
      if (sidebar) sidebar.classList.add('-translate-x-full');
      overlay.classList.add('hidden');
      return;
    }

    const dropdownToggle = event.target.closest('[data-dropdown-toggle]');
    if (dropdownToggle) {
      event.preventDefault();
      const target = document.getElementById(dropdownToggle.getAttribute('data-dropdown-toggle'));
      if (target) target.classList.toggle('hidden');
      document.querySelectorAll('[data-dropdown]').forEach((el) => {
        if (el !== target) el.classList.add('hidden');
      });
      return;
    }

    if (!event.target.closest('[data-dropdown]')) {
      document.querySelectorAll('[data-dropdown]').forEach((el) => el.classList.add('hidden'));
    }

    const dismiss = event.target.closest('[data-dismiss]');
    if (dismiss) {
      const target = document.getElementById(dismiss.getAttribute('data-dismiss'));
      if (target) target.remove();
    }
  });

  // --------------------------------------------------------------- confirm
  document.addEventListener('submit', (event) => {
    const form = event.target;
    const message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      event.preventDefault();
    }
  });

  // ----------------------------------------------------------------- print
  document.addEventListener('click', (event) => {
    const print = event.target.closest('[data-print]');
    if (print) {
      event.preventDefault();
      window.print();
    }
  });

  // ----------------------------------------------------------------- flash
  document.querySelectorAll('[data-flash]').forEach((el) => {
    setTimeout(() => {
      el.style.transition = 'opacity .4s ease, transform .4s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      setTimeout(() => el.remove(), 450);
    }, 6000);
  });

  // Search shortcut: "/" focuses the header search input
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      const search = document.getElementById('global-search');
      if (search) {
        event.preventDefault();
        search.focus();
      }
    }
    if (event.key === 'Escape') {
      document.querySelectorAll('[data-dropdown]').forEach((el) => el.classList.add('hidden'));
    }
  });

  // -------------------------------------------------------------- quantity
  document.querySelectorAll('[data-increment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.getAttribute('data-increment'));
      if (!input) return;
      const step = Number(input.getAttribute('step') || 1);
      input.value = (Number(input.value || 0) + step).toFixed(2).replace(/\.00$/, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
})();
