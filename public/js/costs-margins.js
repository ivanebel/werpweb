'use strict';

(function () {
  const dataElement = document.getElementById('costs-margins-data');
  if (!dataElement) return;

  let data = {};
  try {
    data = JSON.parse(dataElement.textContent || '{}');
  } catch (e) {
    return;
  }

  const products = Array.isArray(data.products) ? data.products : [];
  const allWithholdings = Array.isArray(data.customerWithholdings) ? data.customerWithholdings : [];
  const locale = data.locale || document.documentElement.lang || 'en-US';
  const currency = data.currency || 'USD';
  const labels = data.labels || {};
  const label = (key, fallback) => labels[key] || fallback;

  const customerSelect = document.getElementById('margins-customer');
  const withholdingPanel = document.getElementById('margins-withholdings');
  const head = document.getElementById('margins-head');
  const body = document.getElementById('margins-body');
  const foot = document.getElementById('margins-foot');
  const empty = document.getElementById('margins-empty');
  const addButton = document.getElementById('add-margin-product');
  if (!customerSelect || !withholdingPanel || !head || !body || !foot || !empty || !addButton) return;

  const table = head.closest('table');
  let rowSequence = 0;
  let rows = [];
  let currentWithholdings = [];

  const moneyFormatter = (() => {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch (e) {
      return null;
    }
  })();

  const numberFormatter = (digits) => {
    try {
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    } catch (e) {
      return null;
    }
  };

  const money = (value) => {
    const amount = Number(value) || 0;
    return moneyFormatter ? moneyFormatter.format(amount) : `${currency} ${amount.toFixed(2)}`;
  };
  const percent = (value, digits = 2) => {
    const formatter = numberFormatter(digits);
    return `${formatter ? formatter.format(Number(value) || 0) : (Number(value) || 0).toFixed(digits)}%`;
  };
  const number = (value) => {
    const parsed = Number(String(value === undefined || value === null ? '' : value).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const clampPercent = (value) => Math.min(100, Math.max(0, number(value)));

  const td = (className = 'table-td', text = '') => {
    const cell = document.createElement('td');
    cell.className = className;
    cell.textContent = text;
    return cell;
  };

  const th = (className = 'table-th', text = '') => {
    const cell = document.createElement('th');
    cell.className = className;
    cell.textContent = text;
    return cell;
  };

  const makeRow = () => ({
    id: `margin-row-${++rowSequence}`,
    productId: '',
    quantity: 1,
    sale: 0,
    cost: 0,
  });

  const productById = (id) => products.find((product) => String(product.id) === String(id)) || null;

  function currentCustomerWithholdings() {
    const customerId = String(customerSelect.value || '');
    if (!customerId) return [];
    return allWithholdings
      .filter((withholding) => String(withholding.customer_id) === customerId)
      .map((withholding) => ({ ...withholding, percentage: Number(withholding.percentage) || 0 }));
  }

  function renderWithholdings() {
    withholdingPanel.innerHTML = '';
    if (!customerSelect.value) {
      const message = document.createElement('p');
      message.className = 'text-sm text-gray-400';
      message.textContent = label('selectCustomer', 'Select a customer to load withholdings.');
      withholdingPanel.appendChild(message);
      return;
    }
    if (!currentWithholdings.length) {
      const message = document.createElement('p');
      message.className = 'text-sm text-gray-400';
      message.textContent = label('noWithholdings', 'This customer has no withholdings assigned.');
      withholdingPanel.appendChild(message);
      return;
    }

    currentWithholdings.forEach((withholding) => {
      const block = document.createElement('div');
      block.className = 'rounded-xl border border-gray-200 p-3 dark:border-gray-700';

      const top = document.createElement('div');
      top.className = 'flex items-start justify-between gap-3';
      const details = document.createElement('div');
      details.className = 'min-w-0';
      const name = document.createElement('p');
      name.className = 'truncate text-sm font-medium text-gray-800 dark:text-gray-200';
      name.textContent = withholding.name;
      const type = document.createElement('p');
      type.className = 'mt-0.5 text-xs text-gray-400';
      type.textContent = withholding.typeLabel || withholding.type || '';
      details.appendChild(name);
      details.appendChild(type);

      const inputWrap = document.createElement('div');
      inputWrap.className = 'relative w-28 shrink-0';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '100';
      input.step = '0.0001';
      input.value = String(withholding.percentage);
      input.className = 'form-input pr-7 text-right';
      input.setAttribute('data-withholding-percentage', withholding.withholding_id);
      input.setAttribute('aria-label', withholding.name);
      const suffix = document.createElement('span');
      suffix.className = 'pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-gray-400';
      suffix.textContent = '%';
      inputWrap.appendChild(input);
      inputWrap.appendChild(suffix);

      input.addEventListener('input', () => {
        withholding.percentage = clampPercent(input.value);
        const headerPercent = head.querySelector(`[data-withholding-header="${withholding.withholding_id}"]`);
        if (headerPercent) headerPercent.textContent = percent(withholding.percentage, 4);
        recalcAll();
      });

      top.appendChild(details);
      top.appendChild(inputWrap);

      const total = document.createElement('p');
      total.className = 'mt-2 text-xs text-gray-500 dark:text-gray-400';
      total.textContent = `${label('withheld', 'Withheld')}: `;
      const totalValue = document.createElement('span');
      totalValue.className = 'font-medium text-gray-700 dark:text-gray-300';
      totalValue.setAttribute('data-withholding-total', withholding.withholding_id);
      totalValue.textContent = money(0);
      total.appendChild(totalValue);

      block.appendChild(top);
      block.appendChild(total);
      withholdingPanel.appendChild(block);
    });
  }

  function buildHeader() {
    head.innerHTML = '';
    const row = document.createElement('tr');
    row.appendChild(th('table-th', label('product', 'Product')));
    row.appendChild(th('table-th', label('quantity', 'Quantity')));
    row.appendChild(th('table-th text-right', label('grossSalePrice', 'Gross sale price')));
    row.appendChild(th('table-th text-right', label('grossCostPrice', 'Gross cost price')));
    row.appendChild(th('table-th text-right', label('totalSales', 'Total sales')));
    row.appendChild(th('table-th text-right', label('totalCost', 'Total cost')));
    row.appendChild(th('table-th text-right', label('grossMargin', 'Gross margin')));

    currentWithholdings.forEach((withholding) => {
      const cell = document.createElement('th');
      cell.className = 'table-th text-right min-w-[130px]';
      const name = document.createElement('span');
      name.className = 'block';
      name.textContent = withholding.name;
      const percentage = document.createElement('span');
      percentage.className = 'mt-0.5 block text-[10px] font-normal normal-case text-gray-400';
      percentage.setAttribute('data-withholding-header', withholding.withholding_id);
      percentage.textContent = percent(withholding.percentage, 4);
      cell.appendChild(name);
      cell.appendChild(percentage);
      row.appendChild(cell);
    });

    row.appendChild(th('table-th text-right', label('totalBenefit', 'Total benefit')));
    row.appendChild(th('table-th text-right', label('finalMargin', 'Final margin')));
    row.appendChild(th('table-th', ''));
    head.appendChild(row);
  }

  function buildRow(row) {
    const element = document.createElement('tr');
    element.className = 'table-row';
    element.setAttribute('data-margin-row', row.id);

    const productCell = document.createElement('td');
    productCell.className = 'table-td min-w-[260px]';
    const select = document.createElement('select');
    select.className = 'form-select min-w-[240px]';
    select.setAttribute('data-row-product', '');
    select.appendChild(new Option(label('selectProduct', 'Select product'), ''));
    products.forEach((product) => select.appendChild(new Option(product.label, product.id)));
    select.value = row.productId;
    const unit = document.createElement('span');
    unit.className = 'mt-1 block text-[11px] text-gray-400';
    unit.setAttribute('data-row-unit', '');
    const selectedProduct = productById(row.productId);
    unit.textContent = selectedProduct ? selectedProduct.unit : '';
    productCell.appendChild(select);
    productCell.appendChild(unit);

    select.addEventListener('change', () => {
      row.productId = select.value;
      const product = productById(row.productId);
      if (product) {
        row.sale = Number(product.sale) || 0;
        row.cost = Number(product.cost) || 0;
        row.quantity = number(row.quantity) > 0 ? row.quantity : 1;
        element.querySelector('[data-row-sale]').value = row.sale.toFixed(2);
        element.querySelector('[data-row-cost]').value = row.cost.toFixed(2);
        element.querySelector('[data-row-qty]').value = String(row.quantity);
        unit.textContent = product.unit || '';
        const unitHint = element.querySelector('[data-row-qty-unit]');
        if (unitHint) unitHint.textContent = product.unit || '';
      } else {
        row.sale = 0;
        row.cost = 0;
        element.querySelector('[data-row-sale]').value = '0.00';
        element.querySelector('[data-row-cost]').value = '0.00';
        unit.textContent = '';
        const unitHint = element.querySelector('[data-row-qty-unit]');
        if (unitHint) unitHint.textContent = '';
      }
      recalcAll();
    });

    const quantityCell = document.createElement('td');
    quantityCell.className = 'table-td';
    const quantity = document.createElement('input');
    quantity.type = 'number';
    quantity.min = '0';
    quantity.step = '0.001';
    quantity.value = String(row.quantity);
    quantity.className = 'form-input w-28 text-right';
    quantity.setAttribute('data-row-qty', '');
    quantity.addEventListener('input', () => {
      row.quantity = number(quantity.value);
      recalcAll();
    });
    quantityCell.appendChild(quantity);
    const unitHint = document.createElement('span');
    unitHint.className = 'mt-1 block text-[11px] text-gray-400';
    unitHint.setAttribute('data-row-qty-unit', '');
    unitHint.textContent = selectedProduct ? selectedProduct.unit : '';
    quantityCell.appendChild(unitHint);

    const saleCell = document.createElement('td');
    saleCell.className = 'table-td';
    const sale = document.createElement('input');
    sale.type = 'number';
    sale.min = '0';
    sale.step = '0.01';
    sale.value = Number(row.sale).toFixed(2);
    sale.className = 'form-input w-28 text-right';
    sale.setAttribute('data-row-sale', '');
    sale.addEventListener('input', () => {
      row.sale = number(sale.value);
      recalcAll();
    });
    saleCell.appendChild(sale);

    const costCell = document.createElement('td');
    costCell.className = 'table-td';
    const cost = document.createElement('input');
    cost.type = 'number';
    cost.min = '0';
    cost.step = '0.01';
    cost.value = Number(row.cost).toFixed(2);
    cost.className = 'form-input w-28 text-right';
    cost.setAttribute('data-row-cost', '');
    cost.addEventListener('input', () => {
      row.cost = number(cost.value);
      recalcAll();
    });
    costCell.appendChild(cost);

    const totalSales = td('table-td text-right font-medium text-gray-800 dark:text-gray-200');
    totalSales.setAttribute('data-row-total-sales', '');
    totalSales.textContent = money(0);
    const totalCost = td('table-td text-right text-gray-700 dark:text-gray-300');
    totalCost.setAttribute('data-row-total-cost', '');
    totalCost.textContent = money(0);

    const grossMargin = td('table-td text-right');
    const grossMarginValue = document.createElement('span');
    grossMarginValue.className = 'block font-medium';
    grossMarginValue.setAttribute('data-row-gross-margin', '');
    const grossMarginPercent = document.createElement('span');
    grossMarginPercent.className = 'mt-0.5 block text-[11px] text-gray-400';
    grossMarginPercent.setAttribute('data-row-gross-percent', '');
    grossMargin.appendChild(grossMarginValue);
    grossMargin.appendChild(grossMarginPercent);

    element.appendChild(productCell);
    element.appendChild(quantityCell);
    element.appendChild(saleCell);
    element.appendChild(costCell);
    element.appendChild(totalSales);
    element.appendChild(totalCost);
    element.appendChild(grossMargin);

    currentWithholdings.forEach((withholding) => {
      const cell = td('table-td text-right text-gray-700 dark:text-gray-300');
      cell.setAttribute('data-row-withholding', withholding.withholding_id);
      cell.textContent = money(0);
      element.appendChild(cell);
    });

    const benefit = td('table-td text-right font-semibold');
    benefit.setAttribute('data-row-benefit', '');
    benefit.textContent = money(0);
    const finalMargin = td('table-td text-right font-semibold');
    finalMargin.setAttribute('data-row-final-margin', '');
    finalMargin.textContent = percent(0, 2);

    element.appendChild(benefit);
    element.appendChild(finalMargin);

    const action = td('table-td text-right');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-icon text-error-500 hover:bg-error-50 hover:text-error-600 dark:text-error-400 dark:hover:bg-error-500/10';
    remove.title = label('remove', 'Remove');
    remove.setAttribute('aria-label', label('remove', 'Remove'));
    remove.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor" class="h-4 w-4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>';
    remove.addEventListener('click', () => {
      rows = rows.filter((item) => item.id !== row.id);
      rebuildTable();
      recalcAll();
    });
    action.appendChild(remove);
    element.appendChild(action);

    return element;
  }

  function buildFoot() {
    foot.innerHTML = '';
    const row = document.createElement('tr');
    const totalLabel = td('table-td font-semibold', label('totals', 'Totals'));
    totalLabel.colSpan = 4;
    row.appendChild(totalLabel);

    const sales = td('table-td text-right font-semibold');
    sales.setAttribute('data-total-sales', '');
    sales.textContent = money(0);
    row.appendChild(sales);

    const cost = td('table-td text-right font-semibold');
    cost.setAttribute('data-total-cost', '');
    cost.textContent = money(0);
    row.appendChild(cost);

    const gross = td('table-td text-right font-semibold');
    const grossValue = document.createElement('span');
    grossValue.className = 'block';
    grossValue.setAttribute('data-total-gross-margin', '');
    const grossPercent = document.createElement('span');
    grossPercent.className = 'mt-0.5 block text-[11px] font-normal text-gray-400';
    grossPercent.setAttribute('data-total-gross-percent', '');
    gross.appendChild(grossValue);
    gross.appendChild(grossPercent);
    row.appendChild(gross);

    currentWithholdings.forEach((withholding) => {
      const cell = td('table-td text-right font-semibold');
      cell.setAttribute('data-total-withholding', withholding.withholding_id);
      cell.textContent = money(0);
      row.appendChild(cell);
    });

    const benefit = td('table-td text-right font-semibold');
    benefit.setAttribute('data-total-benefit', '');
    benefit.textContent = money(0);
    row.appendChild(benefit);

    const final = td('table-td text-right font-semibold');
    final.setAttribute('data-total-final-margin', '');
    final.textContent = percent(0, 2);
    row.appendChild(final);

    row.appendChild(td('table-td', ''));
    foot.appendChild(row);
  }

  function rebuildTable() {
    if (table) table.style.minWidth = `${1050 + currentWithholdings.length * 150}px`;
    buildHeader();
    body.innerHTML = '';
    rows.forEach((row) => body.appendChild(buildRow(row)));
    buildFoot();
    if (table) table.classList.toggle('hidden', rows.length === 0);
    empty.classList.toggle('hidden', rows.length > 0);
  }

  function recalcAll() {
    const totals = {
      sales: 0,
      cost: 0,
      benefit: 0,
      withholdings: currentWithholdings.map(() => 0),
    };

    rows.forEach((row) => {
      const element = body.querySelector(`[data-margin-row="${row.id}"]`);
      if (!element) return;
      const sales = number(row.quantity) * number(row.sale);
      const cost = number(row.quantity) * number(row.cost);
      const gross = sales - cost;
      const grossPercent = sales > 0 ? (gross / sales) * 100 : 0;
      let withholdingTotal = 0;

      element.querySelector('[data-row-total-sales]').textContent = money(sales);
      element.querySelector('[data-row-total-cost]').textContent = money(cost);
      element.querySelector('[data-row-gross-margin]').textContent = money(gross);
      element.querySelector('[data-row-gross-percent]').textContent = percent(grossPercent, 2);

      currentWithholdings.forEach((withholding, index) => {
        const amount = sales * (number(withholding.percentage) / 100);
        withholdingTotal += amount;
        totals.withholdings[index] += amount;
        const cell = element.querySelector(`[data-row-withholding="${withholding.withholding_id}"]`);
        if (cell) cell.textContent = money(amount);
      });

      const benefit = sales - cost - withholdingTotal;
      const finalMargin = sales > 0 ? (benefit / sales) * 100 : 0;
      element.querySelector('[data-row-benefit]').textContent = money(benefit);
      element.querySelector('[data-row-final-margin]').textContent = percent(finalMargin, 2);

      totals.sales += sales;
      totals.cost += cost;
      totals.benefit += benefit;
    });

    const totalGross = totals.sales - totals.cost;
    const totalGrossPercent = totals.sales > 0 ? (totalGross / totals.sales) * 100 : 0;
    const totalFinalMargin = totals.sales > 0 ? (totals.benefit / totals.sales) * 100 : 0;

    const totalSales = foot.querySelector('[data-total-sales]');
    if (totalSales) totalSales.textContent = money(totals.sales);
    const totalCost = foot.querySelector('[data-total-cost]');
    if (totalCost) totalCost.textContent = money(totals.cost);
    const totalGrossMargin = foot.querySelector('[data-total-gross-margin]');
    if (totalGrossMargin) totalGrossMargin.textContent = money(totalGross);
    const totalGrossPercentElement = foot.querySelector('[data-total-gross-percent]');
    if (totalGrossPercentElement) totalGrossPercentElement.textContent = percent(totalGrossPercent, 2);

    currentWithholdings.forEach((withholding, index) => {
      const totalCell = foot.querySelector(`[data-total-withholding="${withholding.withholding_id}"]`);
      if (totalCell) totalCell.textContent = money(totals.withholdings[index]);
      const panelTotal = withholdingPanel.querySelector(`[data-withholding-total="${withholding.withholding_id}"]`);
      if (panelTotal) panelTotal.textContent = money(totals.withholdings[index]);
    });

    const totalBenefit = foot.querySelector('[data-total-benefit]');
    if (totalBenefit) totalBenefit.textContent = money(totals.benefit);
    const totalFinal = foot.querySelector('[data-total-final-margin]');
    if (totalFinal) totalFinal.textContent = percent(totalFinalMargin, 2);
  }

  function loadCustomer() {
    currentWithholdings = currentCustomerWithholdings();
    renderWithholdings();
    addButton.disabled = !customerSelect.value;
    if (customerSelect.value && !rows.length) rows.push(makeRow());
    rebuildTable();
    recalcAll();
  }

  addButton.addEventListener('click', () => {
    rows.push(makeRow());
    rebuildTable();
    recalcAll();
    const lastRow = body.lastElementChild;
    lastRow?.querySelector('[data-row-product]')?.focus();
  });

  customerSelect.addEventListener('change', loadCustomer);

  loadCustomer();
})();
