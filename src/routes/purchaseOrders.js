'use strict';

const { makeDocumentRouter } = require('./documents');

module.exports = makeDocumentRouter({
  kind: 'purchase_order',
  key: 'purchase-orders',
  basePath: '/purchase-orders',
  title: 'Purchase Orders',
  singular: 'Purchase Order',
  active: 'purchase-orders',
  table: 'purchase_orders',
  itemTable: 'purchase_order_items',
  itemFk: 'order_id',
  numberField: 'order_no',
  numberPrefix: 'PO',
  party: { field: 'supplier_id', table: 'suppliers', label: 'Supplier' },
  partyBase: '/suppliers',
  dateField: 'order_date',
  dateLabel: 'Order date',
  dueField: 'expected_date',
  dueLabel: 'Expected delivery',
  defaultDueDays: 14,
  statuses: ['draft', 'confirmed', 'partially_received', 'received', 'cancelled'],
  defaultStatus: 'draft',
  productWhere: "is_purchasable = 1 AND status = 'active'",
  priceField: 'cost_price',
  openStatuses: ['draft', 'confirmed', 'partially_received'],
  lockedStatuses: ['partially_received', 'received', 'cancelled'],
  showDelivered: true,
  qtyLabel: 'Received',
  qtyKey: 'received_qty',
});
