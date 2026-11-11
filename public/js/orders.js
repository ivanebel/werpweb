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
  const levyContainer = document.getElementById('levy-items');
  const levyTemplate = document.getElementById('levy-template');
  const currency = form.getAttribute('data-currency') || 'USD';
  const defaultTax = Number(form.getAttribute('data-default-tax') || 0);
  const defaultTaxValue = Number(defaultTax || 0).toFixed(2);
  const packUnits = form.getAttribute('data-pack-units') === '1';
  const applyTaxRate = (select, rate) => {
    if (!select) return Number(rate) || 0;
    const value = Number(rate || 0).toFixed(2);
    if ([...select.options].some((option) => option.value === value)) {
      select.value = value;
      return Number(value);
    }
    const preferred = [...select.options].find((option) => option.value === defaultTaxValue);
    const fallback = preferred || [...select.options].find((option) => option.value === '21.00') || select.options[0];
    if (fallback) {
      select.value = fallback.value;
      return Number(fallback.value);
    }
    return Number(rate) || 0;
  };
  const selectedProductOption = (row) => row.querySelector('[data-product-select]')?.selectedOptions?.[0] || null;
  const packSizeFor = (row) => Math.max(1, Number(selectedProductOption(row)?.dataset.unitsPerPack || 1));
  const baseQuantityFor = (row) => {
    const qty = Number(row.querySelector('[data-qty]')?.value || 0);
    const unit = row.querySelector('[data-qty-unit]')?.value || 'unit';
    return qty * (unit === 'pack' ? packSizeFor(row) : 1);
  };
  function updatePackHint(row) {
    if (!packUnits) return;
    const hint = row.querySelector('[data-pack-hint]');
    if (!hint) return;
    const select = row.querySelector('[data-qty-unit]');
    const qty = Number(row.querySelector('[data-qty]')?.value || 0);
    const size = packSizeFor(row);
    if (select?.value === 'pack' && size > 1 && qty > 0) {
      const template = messages.packHint || '{packs} packs = {units} units';
      hint.textContent = template.replace('{packs}', fmtQty(qty)).replace('{units}', fmtQty(qty * size));
      hint.classList.remove('hidden');
    } else {
      hint.textContent = '';
      hint.classList.add('hidden');
    }
  }
  function syncPackOptions(row) {
    if (!packUnits) return;
    const select = row.querySelector('[data-qty-unit]');
    if (!select) return;
    const size = packSizeFor(row);
    const current = select.value;
    select.innerHTML = '';
    const unitOption = document.createElement('option');
    unitOption.value = 'unit';
    unitOption.textContent = messages.unit || 'Unit';
    select.appendChild(unitOption);
    if (size > 1) {
      const packOption = document.createElement('option');
      packOption.value = 'pack';
      packOption.textContent = `${messages.pack || 'Pack'} ×${size}`;
      select.appendChild(packOption);
    }
    select.value = current === 'pack' && size > 1 ? 'pack' : 'unit';
    select.disabled = size <= 1;
    updatePackHint(row);
  }
  const netPrices = form.getAttribute('data-net-prices') === '1';
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

  function fmtQty(value) {
    try {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(Number(value || 0));
    } catch (e) {
      return Number(value || 0).toFixed(3).replace(/\.?0+$/, '');
    }
  }

  function roundQty(value) {
    return Number((Number(value) || 0).toFixed(3));
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
    const qty = baseQuantityFor(row);
    const price = Number(row.querySelector('input[data-price]')?.value || 0);
    const tax = Number(row.querySelector('[data-tax]')?.value || 0);
    const weightInput = row.querySelector('[data-weight-unit]');
    const weight = weightInput && !weightInput.disabled ? Number(weightInput.value || 0) : 0;
    const effectiveQty = weight > 0 ? qty * weight : qty;
    const net = effectiveQty * price;
    const grossUnit = netPrices && tax ? price * (1 + tax / 100) : price;
    const gross = netPrices ? net * (1 + tax / 100) : net;
    const grossInput = row.querySelector('[data-price-gross]');
    if (grossInput) grossInput.value = grossUnit.toFixed(2);
    const totalWeight = row.querySelector('[data-total-weight]');
    if (totalWeight) totalWeight.textContent = weight > 0 ? fmtQty(qty * weight) : '0';
    const netCell = row.querySelector('[data-net-total]');
    if (netCell) netCell.textContent = fmt(net);
    const line = row.querySelector('[data-line-total]');
    if (line) line.textContent = fmt(gross);
    const taxHint = row.querySelector('[data-tax-hint]');
    if (taxHint) taxHint.textContent = tqty(net, tax, netPrices);
  }

  function includedTax(base, tax) {
    if (!tax) return 0;
    return base * (tax / (100 + tax));
  }

  function tqty(base, tax, netBase = false) {
    if (!tax) return '';
    const template = messages.taxIncluded || 'incl. {amount} VAT';
    const vat = netBase ? base * (tax / 100) : includedTax(base, tax);
    return template.replace('{amount}', fmt(vat));
  }

  function recalcAll() {
    let subtotal = 0;
    let taxTotal = 0;
    container.querySelectorAll('[data-line]').forEach((row) => {
      const qty = baseQuantityFor(row);
      const price = Number(row.querySelector('input[data-price]')?.value || 0);
      const tax = Number(row.querySelector('[data-tax]')?.value || 0);
      const weightInput = row.querySelector('[data-weight-unit]');
      const weight = weightInput && !weightInput.disabled ? Number(weightInput.value || 0) : 0;
      const effectiveQty = weight > 0 ? qty * weight : qty;
      const net = effectiveQty * price;
      const gross = netPrices ? net * (1 + tax / 100) : net;
      subtotal += gross;
      taxTotal += netPrices ? net * (tax / 100) : includedTax(net, tax);
      recalcRow(row);
    });
    const discount = Math.min(Number(document.getElementById('discount_total')?.value || 0), subtotal);
    const levyBase = Math.max(0, subtotal - taxTotal - discount);
    let levyTotal = 0;
    if (levyContainer) {
      levyContainer.querySelectorAll('[data-levy]').forEach((row) => {
        const select = row.querySelector('[data-levy-select]');
        const percentage = Number(row.querySelector('[data-levy-percentage]')?.value || 0);
        const amount = select && select.value ? levyBase * percentage / 100 : 0;
        const baseCell = row.querySelector('[data-levy-base]');
        const amountCell = row.querySelector('[data-levy-amount]');
        if (baseCell) baseCell.textContent = select && select.value ? fmt(levyBase) : '—';
        if (amountCell) amountCell.textContent = select && select.value ? fmt(amount) : '—';
        levyTotal += amount;
      });
      setText('levy-base-display', fmt(levyBase));
      setText('levy-total-display', fmt(levyTotal));
      setText('levy-display', fmt(levyTotal));
    }
    const total = subtotal - discount + levyTotal;
    setText('subtotal-display', fmt(subtotal - taxTotal));
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

  function parseDateOnly(value) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const match = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (!match) return '';
    const iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : '';
  }

  function formatDateDisplay(value) {
    const iso = parseDateOnly(value);
    if (!iso) return '';
    const [year, month, day] = iso.split('-');
    return `${day}/${month}/${year}`;
  }

  function addDays(dateValue, days) {
    const iso = parseDateOnly(dateValue);
    if (!iso) return '';
    const date = new Date(`${iso}T00:00:00Z`);
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
    const row = event.target.closest('[data-line]');
    if (row) updatePackHint(row);
    recalcAll();
  });
  container.addEventListener('change', (event) => {
    const row = event.target.closest('[data-line]');
    if (row) updatePackHint(row);
    recalcAll();
  });

  container.addEventListener('change', (event) => {
    const select = event.target.closest('[data-product-select]');
    if (!select) return;
    const row = select.closest('[data-line]');
    const option = select.selectedOptions[0];
    const tax = row.querySelector('[data-tax]');
    const optionTax = option && option.dataset.taxRate !== undefined
      ? Number(option.dataset.taxRate || 0)
      : Number(tax?.value || 0);
    const effectiveTax = option && tax ? applyTaxRate(tax, optionTax) : optionTax;
    syncPackOptions(row);
    if (option && option.dataset.price !== undefined) {
      const price = row.querySelector('input[data-price]');
      const grossPrice = Number(option.dataset.price || 0);
      const displayPrice = netPrices && effectiveTax ? grossPrice / (1 + effectiveTax / 100) : grossPrice;
      if (price) price.value = displayPrice.toFixed(2);
    }
    const unit = row.querySelector('[data-unit]');
    const unitName = String(option?.dataset.productUnit || '').toLowerCase();
    if (unit) unit.textContent = option?.dataset.productUnit || '';
    const kgUnits = ['kg', 'kgs', 'kilogram', 'kilograms'];
    const weighted = option?.dataset.weighted === '1' && !kgUnits.includes(unitName);
    const weightInput = row.querySelector('[data-weight-unit]');
    const weightEmpty = row.querySelector('[data-weight-empty]');
    const weightWrapper = row.querySelector('[data-weight-total-wrapper]');
    row.dataset.weighted = weighted ? '1' : '0';
    if (weightInput) {
      weightInput.disabled = !weighted;
      weightInput.classList.toggle('hidden', !weighted);
      weightInput.value = weighted ? String(Number(option.dataset.weightKg || 0)) : '0';
    }
    if (weightEmpty) weightEmpty.classList.toggle('hidden', weighted);
    if (weightWrapper) weightWrapper.classList.toggle('hidden', !weighted);
    const priceUnit = row.querySelector('[data-price-unit]');
    if (priceUnit) priceUnit.textContent = weighted ? '/kg' : (unitName ? `/${unitName}` : '');
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
        if (tax) applyTaxRate(tax, defaultTax);
        syncPackOptions(rows[0]);
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

  function addDocumentLine() {
    const html = template.innerHTML.replace(/__INDEX__/g, container.querySelectorAll('[data-line]').length);
    const wrapper = document.createElement('tbody');
    wrapper.innerHTML = html.trim();
    const row = wrapper.firstElementChild;
    container.appendChild(row);
    initProductCombobox(row);
    const tax = row.querySelector('[data-tax]');
    if (tax && !tax.value) applyTaxRate(tax, defaultTax);
    syncPackOptions(row);
    renumber();
    updateAllCustomerCodes();
    recalcAll();
    return row;
  }

  const addBtn = document.getElementById('add-line');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const row = addDocumentLine();
      row.querySelector('[data-product-search]')?.focus();
    });
  }

  const importPackingButton = document.getElementById('load-packing-slip-items');
  const packingImportStatus = document.getElementById('packing-slip-import-status');
  if (deliverySelect && importPackingButton) {
    const setImportStatus = (message, tone = 'muted') => {
      if (!packingImportStatus) return;
      packingImportStatus.textContent = message || '';
      packingImportStatus.className = 'text-xs';
      if (tone === 'success') packingImportStatus.classList.add('text-success-600', 'dark:text-success-400');
      else if (tone === 'warning') packingImportStatus.classList.add('text-warning-600', 'dark:text-warning-400');
      else if (tone === 'error') packingImportStatus.classList.add('text-error-600', 'dark:text-error-400');
      else packingImportStatus.classList.add('text-gray-500', 'dark:text-gray-400');
    };

    const productOptionFor = (productId) => {
      const select = container.querySelector('[data-product-select]');
      if (!select) return null;
      return [...select.options].find((option) => option.value === String(productId)) || null;
    };

    const lineForProduct = (productId) => [...container.querySelectorAll('[data-line]')]
      .find((row) => row.querySelector('[data-product-select]')?.value === String(productId)) || null;

    const emptyLine = () => [...container.querySelectorAll('[data-line]')]
      .find((row) => !row.querySelector('[data-product-select]')?.value) || null;

    const setLineProduct = (row, productId) => {
      const select = row.querySelector('[data-product-select]');
      const option = select ? [...select.options].find((opt) => opt.value === String(productId)) : null;
      if (!select || !option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncProductCombobox(row);
      return true;
    };

    const setLineQuantity = (row, quantity, merge = false) => {
      const qty = row.querySelector('[data-qty]');
      if (!qty) return;
      const current = merge ? Number(qty.value || 0) : 0;
      qty.value = String(roundQty(current + Number(quantity || 0)));
      qty.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const countMessage = (template, count) => String(template || '').replace('{count}', String(count));

    importPackingButton.addEventListener('click', async () => {
      const selectedIds = [...deliverySelect.selectedOptions].map((option) => option.value).filter(Boolean);
      if (!selectedIds.length) {
        setImportStatus(importPackingButton.dataset.emptyMessage || '', 'warning');
        return;
      }

      const url = importPackingButton.dataset.importUrl || '/sales/deliveries/items';
      setImportStatus(importPackingButton.dataset.loadingMessage || '', 'muted');
      importPackingButton.disabled = true;
      try {
        const response = await fetch(`${url}?ids=${encodeURIComponent(selectedIds.join(','))}`, {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (!items.length) {
          setImportStatus(importPackingButton.dataset.noItemsMessage || '', 'muted');
          return;
        }

        let loaded = 0;
        let skipped = 0;
        for (const item of items) {
          const quantity = roundQty(item.quantity);
          if (quantity <= 0) continue;
          if (!productOptionFor(item.product_id)) {
            skipped += 1;
            continue;
          }
          let row = lineForProduct(item.product_id);
          if (row) {
            setLineQuantity(row, quantity, true);
            loaded += 1;
            continue;
          }
          row = emptyLine() || addDocumentLine();
          if (!setLineProduct(row, item.product_id)) {
            skipped += 1;
            continue;
          }
          setLineQuantity(row, quantity, false);
          loaded += 1;
        }

        recalcAll();
        const loadedMessage = loaded
          ? countMessage(importPackingButton.dataset.loadedMessage, loaded)
          : '';
        const skippedMessage = skipped
          ? countMessage(importPackingButton.dataset.skippedMessage, skipped)
          : '';
        setImportStatus(
          [loadedMessage, skippedMessage].filter(Boolean).join(' ') || (importPackingButton.dataset.noItemsMessage || ''),
          loaded ? (skipped ? 'warning' : 'success') : 'warning',
        );
      } catch (err) {
        setImportStatus(importPackingButton.dataset.errorMessage || '', 'error');
      } finally {
        importPackingButton.disabled = false;
      }
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
        caeExpiry.value = formatDateDisplay(addDays(documentDate.value, 10));
      }
    });
  }
  if (documentDate && paymentExpiry) {
    documentDate.addEventListener('change', () => {
      if (!paymentExpiry.value) paymentExpiry.value = addDays(documentDate.value, 7);
    });
  }

  if (levyContainer) {
    const applyDefaultPercentage = (row) => {
      const select = row.querySelector('[data-levy-select]');
      const percentage = row.querySelector('[data-levy-percentage]');
      if (!select || !percentage) return;
      const option = select.selectedOptions[0];
      if (option && option.value && option.dataset.percentage !== undefined) {
        percentage.value = Number(option.dataset.percentage || 0).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
      }
    };
    levyContainer.addEventListener('change', (event) => {
      if (!event.target.matches('[data-levy-select]')) return;
      applyDefaultPercentage(event.target.closest('[data-levy]'));
      recalcAll();
    });
    levyContainer.addEventListener('input', (event) => {
      if (event.target.matches('[data-levy-percentage]')) recalcAll();
    });
    levyContainer.addEventListener('click', (event) => {
      const remove = event.target.closest('[data-remove-levy]');
      if (!remove) return;
      event.preventDefault();
      remove.closest('[data-levy]')?.remove();
      recalcAll();
    });
    document.getElementById('add-levy')?.addEventListener('click', () => {
      if (!levyTemplate) return;
      const wrapper = document.createElement('tbody');
      wrapper.innerHTML = levyTemplate.innerHTML.trim();
      const row = wrapper.querySelector('[data-levy]');
      if (!row) return;
      levyContainer.appendChild(row);
      row.querySelector('[data-levy-select]')?.focus();
      recalcAll();
    });
  }

  const discount = document.getElementById('discount_total');
  if (discount) discount.addEventListener('input', recalcAll);

  renumber();
  syncProductCombobox(container);
  initProductCombobox(container);
  container.querySelectorAll('[data-line]').forEach(syncPackOptions);
  updateAllCustomerCodes();
  updateWarehouseOptions();
  updateInvoiceAssociations();
  recalcAll();
})();
