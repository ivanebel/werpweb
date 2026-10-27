'use strict';

(function () {
  const container = document.getElementById('bom-lines');
  const template = document.getElementById('bom-line-template');
  if (!container || !template) return;

  const locale = document.body.dataset.locale || document.documentElement.lang || 'en-US';

  function fmt(value) {
    return Number(value || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function selectedOption(row) {
    const type = row.querySelector('[data-bom-type]')?.value === 'class' ? 'class' : 'component';
    const select = type === 'class'
      ? row.querySelector('[data-class-select]')
      : row.querySelector('[data-component-select]');
    return { type, select, option: select?.selectedOptions?.[0] };
  }

  function updateHint(row) {
    const { type, option } = selectedOption(row);
    const wrap = type === 'class'
      ? row.querySelector('[data-bom-class-wrap]')
      : row.querySelector('[data-bom-component-wrap]');
    const unitHint = wrap?.querySelector('[data-bom-unit-hint]');
    const rangeHint = row.querySelector('[data-bom-cost-range]');
    const unit = String(option?.dataset.unit || '').trim();
    const stock = Number(option?.dataset.stock || 0);
    if (unitHint) {
      if (!option || !option.value) {
        unitHint.textContent = type === 'class'
          ? 'Class quantity per output unit'
          : 'Quantity per output unit';
      } else if (type === 'class') {
        unitHint.textContent = `${unit} · class stock ${fmt(stock)}`;
      } else {
        unitHint.textContent = `${unit} · stock ${fmt(stock)}`;
      }
    }
    if (rangeHint) {
      if (type !== 'class' || !option || !option.value) {
        rangeHint.textContent = '';
      } else {
        const cost = Number(option.dataset.cost || 0);
        const min = Number(option.dataset.min || 0);
        const max = Number(option.dataset.max || 0);
        const missing = option.dataset.missing === '1';
        rangeHint.textContent = missing
          ? 'No active members in this material class'
          : (Math.abs(min - max) < 0.0001
            ? `Preferred cost ${fmt(cost)}`
            : `Preferred ${fmt(cost)} · range ${fmt(min)} – ${fmt(max)}`);
      }
    }
  }

  function recalc() {
    let total = 0;
    container.querySelectorAll('[data-bom-line]').forEach((row) => {
      const qty = Number(row.querySelector('[data-bom-qty]')?.value || 0);
      const scrap = Number(row.querySelector('[data-bom-scrap]')?.value || 0);
      const { option } = selectedOption(row);
      const cost = Number(option?.dataset.cost || 0);
      const line = qty * (1 + scrap / 100) * cost;
      total += line;
      const display = row.querySelector('[data-bom-cost]');
      if (display) display.textContent = fmt(line);
      updateHint(row);
    });
    const output = Number(document.getElementById('output_qty')?.value || 1) || 1;
    const totalEl = document.getElementById('material-cost');
    const unitEl = document.getElementById('unit-cost');
    if (totalEl) totalEl.textContent = fmt(total);
    if (unitEl) unitEl.textContent = fmt(total / output);
  }

  function toggleType(row) {
    const type = row.querySelector('[data-bom-type]')?.value === 'class' ? 'class' : 'component';
    row.querySelector('[data-bom-component-wrap]')?.classList.toggle('hidden', type === 'class');
    row.querySelector('[data-bom-class-wrap]')?.classList.toggle('hidden', type !== 'class');
    updateHint(row);
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
  container.addEventListener('change', (event) => {
    const row = event.target.closest('[data-bom-line]');
    if (row && event.target.matches('[data-bom-type]')) toggleType(row);
    recalc();
  });

  container.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-component]');
    if (!remove) return;
    event.preventDefault();
    const rows = container.querySelectorAll('[data-bom-line]');
    if (rows.length <= 1) {
      rows[0].querySelectorAll('input').forEach((input) => {
        if (input.type === 'number') input.value = input.name.startsWith('scrap') ? '0' : '1';
        else input.value = '';
      });
      rows[0].querySelectorAll('select').forEach((select) => { select.selectedIndex = 0; });
      toggleType(rows[0]);
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
  container.querySelectorAll('[data-bom-line]').forEach(toggleType);
  renumber();
  recalc();
})();
