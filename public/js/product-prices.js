'use strict';

(function () {
  const dialog = document.getElementById('price-dialog');
  if (!dialog) return;

  const form = dialog.querySelector('[data-price-form]');
  const productLabel = dialog.querySelector('[data-price-product]');
  const returnInput = dialog.querySelector('[data-price-return]');
  const costGross = dialog.querySelector('[name="cost_gross_price"]');
  const costVat = dialog.querySelector('[name="cost_vat_rate"]');
  const costLevy = dialog.querySelector('[name="cost_levy_rate"]');
  const costNet = dialog.querySelector('[data-price-net="cost"]');
  const saleGross = dialog.querySelector('[name="sale_gross_price"]');
  const saleVat = dialog.querySelector('[name="sale_vat_rate"]');
  const saleNet = dialog.querySelector('[data-price-net="sale"]');

  const num = (value) => {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

  function recalc() {
    const grossCost = num(costGross.value);
    const vatCost = num(costVat.value);
    const levy = num(costLevy.value);
    costNet.value = round2(grossCost + (grossCost * vatCost) / 100 + (grossCost * levy) / 100).toFixed(2);

    const grossSale = num(saleGross.value);
    const vatSale = num(saleVat.value);
    saleNet.value = round2(grossSale + (grossSale * vatSale) / 100).toFixed(2);
  }

  [costGross, costVat, costLevy, saleGross, saleVat].forEach((input) => {
    input.addEventListener('input', recalc);
  });

  document.querySelectorAll('[data-price-open]').forEach((button) => {
    button.addEventListener('click', () => {
      form.action = `/products/${button.dataset.productId}/prices`;
      if (returnInput) returnInput.value = location.pathname + location.search;
      if (productLabel) productLabel.textContent = button.dataset.productName || '';

      costGross.value = num(button.dataset.costGross).toFixed(2);
      costVat.value = num(button.dataset.costVat).toFixed(2);
      costLevy.value = num(button.dataset.costLevy).toFixed(2);
      saleGross.value = num(button.dataset.saleGross).toFixed(2);
      saleVat.value = num(button.dataset.saleVat).toFixed(2);
      recalc();

      dialog.showModal();
      costGross.focus();
      costGross.select();
    });
  });

  dialog.querySelectorAll('[data-price-close]').forEach((button) => {
    button.addEventListener('click', () => dialog.close());
  });

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
})();
