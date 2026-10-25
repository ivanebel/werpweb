'use strict';

const round3 = (value) => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;

/**
 * Default packing-slip quantities for a delivered quantity. Units per pack
 * produces boxes; packs per pallet produces pallets; product weight produces
 * the line weight in kilograms. These values can be overridden by the user.
 */
function packingDefaults(quantity, product = {}) {
  const units = round3(Math.max(0, Number(quantity) || 0));
  const perPack = Number(product.units_per_pack) || 0;
  const packsPerPallet = Number(product.packs_per_pallet) || 0;
  const unitWeight = Number(product.weight_kg) || 0;
  const boxes = perPack > 0 ? round3(units / perPack) : 0;
  const pallets = perPack > 0 && packsPerPallet > 0
    ? round3(units / perPack / packsPerPallet)
    : 0;
  return {
    pallets,
    boxes,
    units,
    weight: round3(units * unitWeight),
  };
}

module.exports = { round3, packingDefaults };
