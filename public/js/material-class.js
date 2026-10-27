'use strict';

(function () {
  const container = document.getElementById('class-members');
  const template = document.getElementById('class-member-template');
  if (!container || !template) return;

  const locale = document.body.dataset.locale || document.documentElement.lang || 'en-US';

  function fmt(value) {
    return Number(value || 0).toLocaleString(locale, { maximumFractionDigits: 3 });
  }

  function classUnit() {
    return String(document.getElementById('class-unit')?.value || '').trim() || 'unit';
  }

  function renumber() {
    container.querySelectorAll('[data-class-member]').forEach((row, index) => {
      const label = row.querySelector('[data-member-number]');
      if (label) label.textContent = index + 1;
    });
  }

  function updateHints() {
    container.querySelectorAll('[data-class-member]').forEach((row) => {
      const select = row.querySelector('[data-member-product]');
      const option = select?.selectedOptions?.[0];
      const hint = row.querySelector('[data-member-hint]');
      const factorHint = row.querySelector('[data-member-factor-hint]');
      const factor = Number(row.querySelector('[data-member-factor]')?.value || 0);
      const unit = String(option?.dataset.unit || '').trim();
      const stock = Number(option?.dataset.stock || 0);
      const inactive = option?.dataset.status === 'inactive';
      if (hint) {
        hint.textContent = option && option.value
          ? `${unit || '—'} · ${inactive ? 'inactive · ' : ''}stock ${fmt(stock)}`
          : 'Select a product to see its stock and unit.';
      }
      if (factorHint) {
        factorHint.textContent = unit && factor > 0
          ? `1 ${unit} = ${fmt(factor)} ${classUnit()}`
          : 'class units per member unit';
      }
    });
  }

  container.addEventListener('input', updateHints);
  container.addEventListener('change', updateHints);

  container.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-class-member]');
    if (!remove) return;
    event.preventDefault();
    const rows = container.querySelectorAll('[data-class-member]');
    if (rows.length <= 1) {
      rows[0].querySelectorAll('input').forEach((input) => {
        if (input.type === 'number') input.value = input.name.includes('priority') ? '100' : '1';
        else input.value = '';
      });
      rows[0].querySelectorAll('select').forEach((select) => { select.selectedIndex = 0; });
      updateHints();
      return;
    }
    remove.closest('[data-class-member]').remove();
    renumber();
    updateHints();
  });

  document.getElementById('add-class-member')?.addEventListener('click', () => {
    const wrapper = document.createElement('tbody');
    wrapper.innerHTML = template.innerHTML.trim();
    container.appendChild(wrapper.firstElementChild);
    renumber();
    updateHints();
  });

  document.getElementById('class-unit')?.addEventListener('input', updateHints);
  renumber();
  updateHints();
})();
