'use strict';

/**
 * ARCA purchase-invoice concepts (Concepto).
 * Codes are strings so leading zeros (01–08) are preserved.
 */
const PURCHASE_CONCEPTS = [
  { code: '01', name: 'COMPRA DE MERCADERIAS 21%' },
  { code: '02', name: 'VENTA DE MERCADERIA' },
  { code: '03', name: 'LUZ Y TELEFONO 27%' },
  { code: '04', name: 'COMPRA DE MERCADERIAS 10,5%' },
  { code: '05', name: 'COMBUSTIBLE' },
  { code: '06', name: 'FLETES Y FRANQUEOS' },
  { code: '07', name: 'GASTOS GENERALES 21%' },
  { code: '08', name: 'ALQUILERES' },
  { code: '10', name: 'HONORARIOS' },
  { code: '11', name: 'GASTOS BANCARIOS 21%' },
  { code: '12', name: 'BIEN DE USO' },
  { code: '14', name: 'GASTOS BANCARIOS 10.5%' },
  { code: '15', name: 'GASTOS GENERALES 27%' },
  { code: '16', name: 'GASTOS GENERALES 10,5%' },
  { code: '17', name: 'GASTOS EXENTOS' },
  { code: '18', name: 'GASTOS BANCARIOS 10.5%' },
  { code: '20', name: 'VENTAS EXENTAS' },
  { code: '21', name: 'INSUMOS PARA PRODUCCION 21%' },
  { code: '22', name: 'BIEN DE USO 10.5% (CPRAS)' },
  { code: '23', name: 'BIEN DE USO 21% (CPRAS)' },
  { code: '24', name: 'LUZ Y TELEFONO 21%' },
  { code: '25', name: 'INDUMENTARIA DE TRABAJO 21%' },
  { code: '26', name: 'SERVICIOS DE INFORMATICA 21%' },
  { code: '27', name: 'MATANZA' },
  { code: '28', name: 'ARTICULOS DE LIMPIEZA' },
];

module.exports = { PURCHASE_CONCEPTS };
