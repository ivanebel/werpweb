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
  const fiscalTypeSelect = document.querySelector('[data-fiscal-type]');
  const deliverySelect = document.getElementById('delivery_ids');
  const noteInvoiceSelect = document.getElementById('note_invoice_ids');
  const deliverySection = document.getElementById('packing-slips-section');
  const noteInvoiceSection = document.getElementById('note-invoices-section');
  const associationsCard = document.getElementById('invoice-associations-card');
  const invoiceNumberInput = document.querySelector('[data-invoice-number]');
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

  function normalizeProductText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function syncProductCombobox(scope) {
    (scope || document).querySelectorAll('[data-product-combobox]').forEach((combo) => {
      const select = combo.querySelector('[data-product-select]');
      const input = combo.querySelector('[data-product-search]');
      if (!select || !input) return;
      const option = select.selectedOptions[0];
      input.value = option && option.value ? option.textContent.trim() : '';
    });
  }

  function initProductCombobox(scope) {
    const root = scope || document;
    const combos = [];
    if (root.matches && root.matches('[data-product-combobox]')) combos.push(root);
    if (root.querySelectorAll) combos.push(...root.querySelectorAll('[data-product-combobox]'));

    combos.forEach((combo) => {
      if (combo.dataset.comboboxReady === '1') return;
      combo.dataset.comboboxReady = '1';
      const select = combo.querySelector('[data-product-select]');
      const input = combo.querySelector('[data-product-search]');
      const menu = combo.querySelector('[data-product-menu]');
      if (!select || !input || !menu) return;

      // The line-items table can scroll horizontally, so the menu is moved out
      // of the table and positioned with fixed coordinates.
      document.body.appendChild(menu);
      combo._productMenu = menu;

      const options = Array.from(select.options)
        .filter((option) => option.value)
        .map((option) => ({
          value: option.value,
          label: option.textContent.trim(),
          sku: option.dataset.sku || '',
          search: normalizeProductText(`${option.textContent} ${option.dataset.sku || ''}`),
        }));
      let filtered = [];
      let activeIndex = -1;

      const sync = () => {
        const option = select.selectedOptions[0];
        input.value = option && option.value ? option.textContent.trim() : '';
      };

      const close = () => {
        menu.classList.add('hidden');
        input.setAttribute('aria-expanded', 'false');
        activeIndex = -1;
      };

      const position = () => {
        const rect = input.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        const spaceAbove = rect.top - 8;
        const placeAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
        menu.style.maxHeight = `${Math.max(80, Math.min(256, placeAbove ? spaceAbove : spaceBelow))}px`;
        menu.style.left = `${rect.left}px`;
        menu.style.width = `${Math.min(Math.max(240, rect.width), Math.max(180, window.innerWidth - rect.left - 8))}px`;
        if (placeAbove) {
          menu.style.top = 'auto';
          menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        } else {
          menu.style.bottom = 'auto';
          menu.style.top = `${rect.bottom + 4}px`;
        }
      };

      const choose = (option) => {
        if (!option) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
        close();
        input.focus();
      };

      const exactMatch = () => {
        const typed = normalizeProductText(input.value);
        if (!typed) return null;
        return options.find((option) => (
          normalizeProductText(option.label) === typed || normalizeProductText(option.sku) === typed
        )) || null;
      };

      const highlight = () => {
        menu.querySelectorAll('[data-product-option]').forEach((button, index) => {
          button.classList.toggle('bg-brand-50', index === activeIndex);
          button.classList.toggle('dark:bg-brand-500/10', index === activeIndex);
        });
        const current = menu.querySelector(`[data-product-option="${activeIndex}"]`);
        if (current) current.scrollIntoView({ block: 'nearest' });
      };

      const open = (query) => {
        const normalized = normalizeProductText(query);
        filtered = (normalized
          ? options.filter((option) => option.search.includes(normalized))
          : options
        ).slice(0, 50);
        menu.innerHTML = '';
        if (!filtered.length) {
          const empty = document.createElement('p');
          empty.className = 'px-3 py-2 text-sm text-gray-400';
          empty.textContent = messages.noProducts || 'No products found';
          menu.appendChild(empty);
        } else {
          filtered.forEach((option, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.productOption = String(index);
            button.className = 'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800';
            const title = document.createElement('span');
            title.className = 'block text-sm font-medium text-gray-800 dark:text-gray-200';
            title.textContent = option.label;
            const meta = document.createElement('span');
            meta.className = 'block font-mono text-[11px] text-gray-400';
            meta.textContent = option.sku;
            button.append(title, meta);
            button.addEventListener('mousedown', (event) => {
              event.preventDefault();
              choose(option);
            });
            menu.appendChild(button);
          });
        }
        activeIndex = -1;
        menu.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
        position();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(position);
      };

      input.addEventListener('focus', () => {
        input.select();
        open('');
      });
      input.addEventListener('input', () => open(input.value));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (menu.classList.contains('hidden')) {
            open(input.value);
            return;
          }
          activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
          highlight();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          activeIndex = Math.max(activeIndex - 1, 0);
          highlight();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          const option = activeIndex >= 0 ? filtered[activeIndex] : (filtered.length === 1 ? filtered[0] : exactMatch());
          if (option) choose(option);
        } else if (event.key === 'Escape') {
          close();
          sync();
        }
      });
      input.addEventListener('blur', () => {
        setTimeout(() => {
          close();
          const exact = exactMatch();
          if (!input.value.trim()) {
            if (select.value) {
              select.value = '';
              select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            input.value = '';
          } else if (exact) {
            if (select.value !== exact.value) {
              select.value = exact.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            input.value = exact.label;
          } else {
            sync();
          }
        }, 120);
      });

      window.addEventListener('scroll', () => {
        if (!menu.classList.contains('hidden')) position();
      }, true);
      window.addEventListener('resize', () => {
        if (!menu.classList.contains('hidden')) position();
      });
      sync();
    });
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

  function fiscalFamily() {
    const selected = fiscalTypeSelect?.selectedOptions?.[0];
    return selected?.dataset.family || '';
  }

  function filterAssociationOptions(select, dataAttribute) {
    if (!select) return;
    const partyId = partySelect?.value || '';
    Array.from(select.options).forEach((option) => {
      const belongs = Boolean(partyId) && option.dataset[dataAttribute] === partyId;
      option.hidden = !belongs;
      option.disabled = !belongs;
      if (!belongs) option.selected = false;
    });
  }

  function updateInvoiceAssociations() {
    if (!fiscalTypeSelect) return;
    const family = fiscalFamily();
    const isNote = family === 'credit_note' || family === 'debit_note';
    if (deliverySection) deliverySection.classList.toggle('hidden', isNote);
    if (noteInvoiceSection) noteInvoiceSection.classList.toggle('hidden', !isNote);
    if (associationsCard) {
      associationsCard.classList.toggle('hidden', !deliverySection && !isNote);
    }
    filterAssociationOptions(deliverySelect, 'customer');
    filterAssociationOptions(noteInvoiceSelect, 'party');
  }

  function addDays(dateValue, days) {
    if (!dateValue) return '';
    const date = new Date(`${dateValue}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return '';
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
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
    if (unit) unit.textContent = option?.dataset.productUnit || '';
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
        syncProductCombobox(rows[0]);
        const tax = rows[0].querySelector('[data-tax]');
        if (tax) tax.value = defaultTax;
        recalcAll();
        return;
      }
      const rowToRemove = remove.closest('[data-line]');
      const comboToRemove = rowToRemove.querySelector('[data-product-combobox]');
      if (comboToRemove && comboToRemove._productMenu) comboToRemove._productMenu.remove();
      rowToRemove.remove();
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
      initProductCombobox(row);
      const tax = row.querySelector('[data-tax]');
      if (tax && !tax.value) tax.value = defaultTax;
      renumber();
      updateAllCustomerCodes();
      recalcAll();
      row.querySelector('[data-product-search]')?.focus();
    });
  }

  if (partySelect) {
    partySelect.addEventListener('change', () => {
      updateAllCustomerCodes();
      updateWarehouseOptions();
      updateInvoiceAssociations();
    });
  }

  if (fiscalTypeSelect) {
    fiscalTypeSelect.addEventListener('change', updateInvoiceAssociations);
  }

  if (invoiceNumberInput) {
    invoiceNumberInput.addEventListener('blur', () => {
      const match = invoiceNumberInput.value.trim().match(/^(\d{1,5})\s*-\s*(\d{1,8})$/);
      if (match) {
        invoiceNumberInput.value = `${match[1].padStart(5, '0')}-${match[2].padStart(8, '0')}`;
      }
    });
  }

  const documentDate = document.getElementById('doc-date');
  const caeInput = document.getElementById('cae');
  const caeExpiry = document.getElementById('cae_expiry_date');
  const paymentExpiry = document.getElementById('payment_expiry_date');
  if (caeInput && caeExpiry && documentDate) {
    caeInput.addEventListener('input', () => {
      if (caeInput.value.trim() && !caeExpiry.value) {
        caeExpiry.value = addDays(documentDate.value, 10);
      }
    });
  }
  if (documentDate && paymentExpiry) {
    documentDate.addEventListener('change', () => {
      if (!paymentExpiry.value) paymentExpiry.value = addDays(documentDate.value, 7);
    });
  }

  const discount = document.getElementById('discount_total');
  if (discount) discount.addEventListener('input', recalcAll);

  renumber();
  syncProductCombobox(container);
  initProductCombobox(container);
  updateAllCustomerCodes();
  updateWarehouseOptions();
  updateInvoiceAssociations();
  recalcAll();
})();
