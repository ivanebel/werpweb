'use strict';

(function () {
  const form = document.querySelector('[data-payment-form]');
  if (!form) return;

  const direction = form.getAttribute('data-direction') || 'customer';
  const currency = form.getAttribute('data-currency') || 'USD';
  const locale = form.getAttribute('data-locale') || 'en-US';
  let money;
  try {
    money = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch (error) {
    money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  }

  const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  const number = (value) => {
    const parsed = Number(String(value === undefined || value === null ? '' : value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const setSummary = (selector, value) => {
    const element = form.querySelector(selector);
    if (element) element.textContent = money.format(round2(value));
  };

  // ------------------------------------------------------------- party load
  const party = form.querySelector('[data-party-select]');
  if (party) {
    party.addEventListener('change', () => {
      const url = new URL(window.location.href);
      url.searchParams.set('type', direction);
      if (party.value) {
        url.searchParams.set('party_id', party.value);
      } else {
        url.searchParams.delete('party_id');
      }
      url.searchParams.delete('invoice_id');
      url.searchParams.delete('page');
      window.location.assign(url.toString());
    });
  }

  // ------------------------------------------------------------ invoice rows
  const invoiceChecks = Array.from(form.querySelectorAll('[data-invoice-check]'));

  function invoiceAmount(checkbox) {
    const row = checkbox.closest('tr');
    return row ? row.querySelector('[data-invoice-amount]') : null;
  }

  function syncInvoice(checkbox, initial) {
    const amount = invoiceAmount(checkbox);
    if (!amount) return;
    if (checkbox.checked) {
      amount.disabled = false;
      if (!initial || !amount.value || number(amount.value) === 0) {
        amount.value = amount.getAttribute('data-balance') || '';
      }
    } else {
      amount.disabled = true;
      if (!initial) amount.value = '';
    }
  }

  invoiceChecks.forEach((checkbox) => {
    syncInvoice(checkbox, true);
    checkbox.addEventListener('change', () => {
      syncInvoice(checkbox, false);
      recalculate();
    });
    const amount = invoiceAmount(checkbox);
    if (amount) amount.addEventListener('input', recalculate);
  });

  const applyAll = form.querySelector('[data-apply-all]');
  if (applyAll) {
    applyAll.addEventListener('click', () => {
      invoiceChecks.forEach((checkbox) => {
        checkbox.checked = true;
        const amount = invoiceAmount(checkbox);
        if (amount) {
          amount.disabled = false;
          amount.value = amount.getAttribute('data-balance') || '';
        }
      });
      recalculate();
    });
  }

  // ------------------------------------------------------------- method rows
  const methodRows = form.querySelector('[data-method-rows]');
  const methodTemplate = document.getElementById('method-row-template');
  const addMethod = form.querySelector('[data-add-method]');

  function bindMethodRow(row) {
    row.querySelectorAll('[data-method-amount]').forEach((input) => input.addEventListener('input', recalculate));
    const remove = row.querySelector('[data-remove-method]');
    if (!remove) return;
    remove.addEventListener('click', () => {
      const rows = methodRows.querySelectorAll('[data-method-row]');
      if (rows.length <= 1) {
        row.querySelectorAll('input').forEach((input) => {
          input.value = '';
        });
        const select = row.querySelector('select');
        if (select) select.value = 'cash';
      } else {
        row.remove();
      }
      recalculate();
    });
  }

  if (methodRows) {
    methodRows.querySelectorAll('[data-method-row]').forEach(bindMethodRow);
  }
  if (addMethod && methodRows && methodTemplate) {
    addMethod.addEventListener('click', () => {
      const row = methodTemplate.content.firstElementChild.cloneNode(true);
      methodRows.appendChild(row);
      bindMethodRow(row);
      recalculate();
      const amount = row.querySelector('[data-method-amount]');
      if (amount) amount.focus();
    });
  }

  // --------------------------------------------------------- adjustment rows
  const adjustmentRows = form.querySelector('[data-adjustment-rows]');
  const adjustmentTemplate = document.getElementById('adjustment-row-template');
  const addAdjustment = form.querySelector('[data-add-adjustment]');

  function removeAdjustmentPlaceholder() {
    if (!adjustmentRows) return;
    const placeholder = adjustmentRows.querySelector('[data-adjustment-empty]');
    if (placeholder) placeholder.remove();
  }

  function bindAdjustmentRow(row) {
    row.querySelectorAll('[data-adjustment-amount]').forEach((input) => input.addEventListener('input', recalculate));
    const select = row.querySelector('select[name="adjustment_kind[]"]');
    if (select) select.addEventListener('change', recalculate);
    const remove = row.querySelector('[data-remove-adjustment]');
    if (!remove) return;
    remove.addEventListener('click', () => {
      row.remove();
      recalculate();
    });
  }

  if (adjustmentRows) {
    adjustmentRows.querySelectorAll('[data-adjustment-row]').forEach(bindAdjustmentRow);
  }
  if (addAdjustment && adjustmentRows && adjustmentTemplate) {
    addAdjustment.addEventListener('click', () => {
      removeAdjustmentPlaceholder();
      const row = adjustmentTemplate.content.firstElementChild.cloneNode(true);
      adjustmentRows.appendChild(row);
      bindAdjustmentRow(row);
      recalculate();
      const amount = row.querySelector('[data-adjustment-amount]');
      if (amount) amount.focus();
    });
  }

  // ---------------------------------------------------------------- summary
  function sumInputs(selector, scope) {
    return round2(
      Array.from((scope || form).querySelectorAll(selector)).reduce((total, input) => total + number(input.value), 0),
    );
  }

  function adjustmentTotal(kind) {
    if (!adjustmentRows) return 0;
    return round2(
      Array.from(adjustmentRows.querySelectorAll('[data-adjustment-row]')).reduce((total, row) => {
        const select = row.querySelector('select[name="adjustment_kind[]"]');
        if (!select || select.value !== kind) return total;
        const amount = row.querySelector('[data-adjustment-amount]');
        return total + (amount ? number(amount.value) : 0);
      }, 0),
    );
  }

  function recalculate() {
    const methodTotal = methodRows ? sumInputs('[data-method-amount]', methodRows) : 0;
    const creditTotal = adjustmentTotal('credit_note');
    const debitTotal = adjustmentTotal('debit_note');
    const withholdingTotal = adjustmentTotal('withholding');
    const sourceTotal = round2(methodTotal + creditTotal + withholdingTotal);
    const appliedTotal = invoiceChecks.reduce((total, checkbox) => {
      if (!checkbox.checked) return total;
      const amount = invoiceAmount(checkbox);
      return total + (amount ? number(amount.value) : 0);
    }, 0);
    const unapplied = round2(sourceTotal - appliedTotal - debitTotal);

    setSummary('[data-summary-method]', methodTotal);
    setSummary('[data-summary-credit]', creditTotal);
    setSummary('[data-summary-debit]', debitTotal);
    setSummary('[data-summary-withholding]', withholdingTotal);
    setSummary('[data-summary-source]', sourceTotal);
    setSummary('[data-summary-applied]', appliedTotal);
    setSummary('[data-summary-unapplied]', unapplied);

    const unappliedElement = form.querySelector('[data-summary-unapplied]');
    if (unappliedElement) {
      unappliedElement.classList.toggle('text-error-600', unapplied < 0);
      unappliedElement.classList.toggle('dark:text-error-400', unapplied < 0);
    }
  }

  recalculate();
})();
