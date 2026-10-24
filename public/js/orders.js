'use strict';

(function () {
  const form = document.getElementById('document-form');
  if (!form) return;

  const locale = document.body.dataset.locale || document.documentElement.lang || 'en-US';
  let messages = {};
  try {
    messages = JSON.parse(document.body.getAttribute('data-i18n') || '{}');
  } catch (e) {
    messages = {};
  }

  const container = document.getElementById('line-items');
  const template = document.getElementById('line-template');
  const currency = form.getAttribute('data-currency') || 'USD';
  const defaultTax = Number(form.getAttribute('data-default-tax') || 0);
  const partySelect = document.getElementById('party_id');
  const warehouseSelect = document.getElementById('customer_warehouse_id');
  const warehouseLink = document.getElementById('warehouse-manage-link');
  let warehouses = [];
  try {
    warehouses = JSON.parse(form.getAttribute('data-warehouses') || '[]');
  } catch (e) {
    warehouses = [];
  }
  let customerCodes = {};
  try {
    customerCodes = JSON.parse(form.getAttribute('data-customer-codes') || '{}');
  } catch (e) {
    customerCodes = {};
  }

  function fmt(value) {
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(value || 0));
    } catch (e) {
      return `${currency} ${Number(value || 0).toFixed(2)}`;
    }
  }

  function recalcRow(row) {
    const qty = Number(row.querySelector('[data-qty]')?.value || 0);
    const price = Number(row.querySelector('input[data-price]')?.value || 0);
    const tax = Number(row.querySelector('[data-tax]')?.value || 0);
    const base = qty * price;
    const line = row.querySelector('[data-line-total]');
    if (line) line.textContent = fmt(base);
    const taxHint = row.querySelector('[data-tax-hint]');
    if (taxHint) taxHint.textContent = tqty(base, tax);
  }

  function includedTax(base, tax) {
    if (!tax) return 0;
    return base * (tax / (100 + tax));
  }

  function tqty(base, tax) {
    if (!tax) return '';
    const template = messages.taxIncluded || 'incl. {amount} VAT';
    return template.replace('{amount}', fmt(includedTax(base, tax)));
  }

  function recalcAll() {
    let subtotal = 0;
    let taxTotal = 0;
    container.querySelectorAll('[data-line]').forEach((row) => {
      const qty = Number(row.querySelector('[data-qty]')?.value || 0);
      const price = Number(row.querySelector('input[data-price]')?.value || 0);
      const tax = Number(row.querySelector('[data-tax]')?.value || 0);
      const base = qty * price;
      subtotal += base;
      taxTotal += includedTax(base, tax);
      recalcRow(row);
    });
    const discount = Math.min(Number(document.getElementById('discount_total')?.value || 0), subtotal);
    const total = subtotal - discount;
    setText('subtotal-display', fmt(subtotal));
    setText('tax-display', fmt(taxTotal));
    setText('discount-display', `- ${fmt(discount)}`);
    setText('total-display', fmt(total));
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function renumber() {
    container.querySelectorAll('[data-line]').forEach((row, index) => {
      const label = row.querySelector('[data-line-number]');
      if (label) label.textContent = index + 1;
      row.querySelectorAll('input, select, textarea').forEach((input) => {
        input.name = input.name.replace(/\[[^\]]*\]/, `[${index}]`);
      });
    });
  }

  function updateCustomerCode(row) {
    const codeEl = row.querySelector('[data-customer-code]');
    if (!codeEl) return;
    const customerId = partySelect?.value || '';
    const productId = row.querySelector('[data-product-select]')?.value || '';
    const code = customerId && productId ? customerCodes[customerId]?.[productId] : '';
    if (!code) {
      codeEl.textContent = '';
      return;
    }
    const template = messages.customerCodeLine || 'Customer code: {code}';
    codeEl.textContent = template.replace('{code}', code);
  }

  function updateAllCustomerCodes() {
    container.querySelectorAll('[data-line]').forEach(updateCustomerCode);
  }

  function updateWarehouseOptions() {
    if (!warehouseSelect) return;
    const customerId = partySelect?.value || '';
    const current = warehouseSelect.value;
    const placeholder = warehouseSelect.querySelector('option[value=""]');
    warehouseSelect.innerHTML = '';
    if (placeholder) warehouseSelect.appendChild(placeholder);

    const own = customerId ? warehouses.filter((w) => String(w.customerId) === String(customerId)) : [];
    own.forEach((w) => {
      const option = document.createElement('option');
      option.value = w.value;
      option.textContent = w.label;
      warehouseSelect.appendChild(option);
    });

    if (own.length === 1) {
      warehouseSelect.value = own[0].value;
    } else if (own.some((w) => String(w.value) === String(current))) {
      warehouseSelect.value = current;
    } else {
      warehouseSelect.value = '';
    }

    if (warehouseLink) {
      warehouseLink.href = customerId ? `/customers/${customerId}/warehouses` : '/customers';
    }
  }

  container.addEventListener('input', (event) => {
    recalcAll();
  });
  container.addEventListener('change', (event) => {
    recalcAll();
  });

  container.addEventListener('change', (event) => {
    const select = event.target.closest('[data-product-select]');
    if (!select) return;
    const row = select.closest('[data-line]');
    const option = select.selectedOptions[0];
    if (option && option.dataset.price !== undefined) {
      const price = row.querySelector('input[data-price]');
      if (price) price.value = Number(option.dataset.price || 0).toFixed(2);
    }
    const unit = row.querySelector('[data-unit]');
    if (unit) unit.textContent = option?.dataset.unit || '';
    if (option && option.dataset.taxRate !== undefined) {
      const tax = row.querySelector('[data-tax]');
      if (tax) tax.value = Number(option.dataset.taxRate || 0).toFixed(2);
    }
    const desc = row.querySelector('[data-description]');
    if (desc && !desc.value && option?.dataset.name) desc.value = option.dataset.name;
    updateCustomerCode(row);
    recalcAll();
  });

  container.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-line]');
    if (remove) {
      event.preventDefault();
      const rows = container.querySelectorAll('[data-line]');
      if (rows.length <= 1) {
        rows[0].querySelectorAll('input').forEach((i) => {
          if (i.type !== 'hidden') i.value = '';
        });
        const sel = rows[0].querySelector('select');
        if (sel) sel.selectedIndex = 0;
        const tax = rows[0].querySelector('[data-tax]');
        if (tax) tax.value = defaultTax;
        recalcAll();
        return;
      }
      remove.closest('[data-line]').remove();
      renumber();
      recalcAll();
    }
  });

  const addBtn = document.getElementById('add-line');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const html = template.innerHTML.replace(/__INDEX__/g, container.querySelectorAll('[data-line]').length);
      const wrapper = document.createElement('tbody');
      wrapper.innerHTML = html.trim();
      const row = wrapper.firstElementChild;
      container.appendChild(row);
      const tax = row.querySelector('[data-tax]');
      if (tax && !tax.value) tax.value = defaultTax;
      renumber();
      updateAllCustomerCodes();
      recalcAll();
      row.querySelector('select')?.focus();
    });
  }

  if (partySelect) {
    partySelect.addEventListener('change', () => {
      updateAllCustomerCodes();
      updateWarehouseOptions();
    });
  }

  const discount = document.getElementById('discount_total');
  if (discount) discount.addEventListener('input', recalcAll);

  renumber();
  updateAllCustomerCodes();
  updateWarehouseOptions();
  recalcAll();
})();
