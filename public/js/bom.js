'use strict';

(function () {
  const container = document.getElementById('bom-lines');
  const template = document.getElementById('bom-line-template');
  if (!container || !template) return;

  const locale = document.body.dataset.locale || document.documentElement.lang || 'en-US';

  function fmt(value) {
    return Number(value || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function recalc() {
    let total = 0;
    container.querySelectorAll('[data-bom-line]').forEach((row) => {
      const qty = Number(row.querySelector('[data-bom-qty]')?.value || 0);
      const scrap = Number(row.querySelector('[data-bom-scrap]')?.value || 0);
      const option = row.querySelector('[data-component-select]')?.selectedOptions[0];
      const cost = Number(option?.dataset.cost || 0);
      const line = qty * (1 + scrap / 100) * cost;
      total += line;
      const display = row.querySelector('[data-bom-cost]');
      if (display) display.textContent = fmt(line);
    });
    const output = Number(document.getElementById('output_qty')?.value || 1) || 1;
    const totalEl = document.getElementById('material-cost');
    const unitEl = document.getElementById('unit-cost');
    if (totalEl) totalEl.textContent = fmt(total);
    if (unitEl) unitEl.textContent = fmt(total / output);
  }

  function renumber() {
    container.querySelectorAll('[data-bom-line]').forEach((row, index) => {
      const label = row.querySelector('[data-bom-number]');
      if (label) label.textContent = index + 1;
      row.querySelectorAll('input, select').forEach((input) => {
        input.name = input.name.replace(/\[[^\]]*\]/, `[${index}]`);
      });
    });
  }

  container.addEventListener('input', recalc);
  container.addEventListener('change', recalc);

  container.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-component]');
    if (!remove) return;
    event.preventDefault();
    const rows = container.querySelectorAll('[data-bom-line]');
    if (rows.length <= 1) {
      rows[0].querySelectorAll('input').forEach((i) => (i.value = ''));
      const select = rows[0].querySelector('select');
      if (select) select.selectedIndex = 0;
      recalc();
      return;
    }
    remove.closest('[data-bom-line]').remove();
    renumber();
    recalc();
  });

  document.getElementById('add-component')?.addEventListener('click', () => {
    const html = template.innerHTML.replace(/__INDEX__/g, container.querySelectorAll('[data-bom-line]').length);
    const wrapper = document.createElement('tbody');
    wrapper.innerHTML = html.trim();
    container.appendChild(wrapper.firstElementChild);
    renumber();
    recalc();
  });

  document.getElementById('output_qty')?.addEventListener('input', recalc);
  recalc();
})();
