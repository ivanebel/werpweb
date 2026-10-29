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
  function readStoredValue(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  let savedTheme = readStoredValue('werp-theme', 'light') === 'dark' ? 'dark' : 'light';
  let palette = readStoredValue('werp-palette', 'default') === 'cyberpunk'
    ? 'cyberpunk'
    : 'default';
  const paletteIsLocked = () => palette === 'cyberpunk';

  function themeToggleLabel(theme) {
    if (paletteIsLocked()) {
      return messages.cyberpunkDarkOnly || 'Cyberpunk is dark only';
    }
    return theme === 'dark'
      ? (messages.lightMode || 'Light mode')
      : (messages.darkMode || 'Dark mode');
  }

  function syncThemeControls(theme) {
    const label = themeToggleLabel(theme);
    const locked = paletteIsLocked();
    document.querySelectorAll('[data-theme-label]').forEach((el) => {
      el.textContent = label;
    });
    document.querySelectorAll('[data-theme-toggle]').forEach((el) => {
      el.setAttribute('title', label);
      el.setAttribute('aria-label', label);
      el.setAttribute('aria-disabled', String(locked));
      if (el.tagName === 'BUTTON') el.disabled = locked;
    });
    document.querySelectorAll('[data-palette-select]').forEach((el) => {
      el.value = palette;
      el.setAttribute('title', messages.palette || 'Palette');
    });
  }

  function applyTheme(theme, persist = true) {
    const effective = paletteIsLocked() ? 'dark' : (theme === 'dark' ? 'dark' : 'light');
    root.classList.toggle('dark', effective === 'dark');
    if (persist && !paletteIsLocked()) {
      savedTheme = effective;
      try {
        localStorage.setItem('werp-theme', effective);
      } catch (e) {
        /* ignore */
      }
    }
    syncThemeControls(effective);
    document.dispatchEvent(new CustomEvent('werp:theme', {
      detail: { theme: effective, palette },
    }));
  }

  function applyPalette(next, persist = true) {
    palette = next === 'cyberpunk' ? 'cyberpunk' : 'default';
    root.dataset.palette = palette;
    if (persist) {
      try {
        localStorage.setItem('werp-palette', palette);
      } catch (e) {
        /* ignore */
      }
    }
    applyTheme(paletteIsLocked() ? 'dark' : savedTheme, false);
    // Charts redraw their SVG colors on the next resize after updateOptions.
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  }

  applyPalette(palette, false);

  // -------------------------------------------------------------- sidebar
  function applySidebar(collapsed, persist, notify) {
    root.classList.toggle('sidebar-collapsed', collapsed);
    const label = collapsed
      ? (messages.expandSidebar || 'Expand sidebar')
      : (messages.collapseSidebar || 'Collapse sidebar');
    document.querySelectorAll('[data-sidebar-collapse]').forEach((button) => {
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    });
    if (persist) {
      try {
        localStorage.setItem('werp-sidebar', collapsed ? 'collapsed' : 'expanded');
      } catch (e) {
        /* ignore */
      }
    }
    if (notify) {
      window.setTimeout(() => window.dispatchEvent(new Event('resize')), 280);
    }
  }
  let savedSidebar = false;
  try {
    savedSidebar = localStorage.getItem('werp-sidebar') === 'collapsed';
  } catch (e) {
    /* ignore */
  }
  applySidebar(root.classList.contains('sidebar-collapsed') || savedSidebar, false, false);

  document.addEventListener('click', (event) => {
    const sidebarCollapse = event.target.closest('[data-sidebar-collapse]');
    if (sidebarCollapse) {
      event.preventDefault();
      applySidebar(!root.classList.contains('sidebar-collapsed'), true, true);
      return;
    }

    const toggle = event.target.closest('[data-theme-toggle]');
    if (toggle) {
      event.preventDefault();
      if (paletteIsLocked()) return;
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

  document.addEventListener('change', (event) => {
    const paletteSelect = event.target.closest('[data-palette-select]');
    if (!paletteSelect) return;
    applyPalette(paletteSelect.value);
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
