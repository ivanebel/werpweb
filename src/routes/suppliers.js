'use strict';

const { makeResourceRouter } = require('./resource');
const { query } = require('../db');
const { renderAccountDashboard } = require('../lib/accountDashboard');

const statusOptions = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

const fields = [
  { name: 'supplier_no', label: 'Supplier no.', type: 'text', section: 'Company', help: 'Leave blank to generate automatically.', maxLength: 30 },
  { name: 'status', label: 'Status', type: 'select', options: statusOptions, default: 'active', section: 'Company' },
  { name: 'company_name', label: 'Company name', type: 'text', required: true, full: true, section: 'Company' },
  { name: 'contact_name', label: 'Contact person', type: 'text', section: 'Contact' },
  { name: 'email', label: 'Email', type: 'email', section: 'Contact' },
  { name: 'phone', label: 'Phone', type: 'tel', section: 'Contact' },
  { name: 'website', label: 'Website', type: 'url', section: 'Contact' },
  { name: 'address_line1', label: 'Address line 1', type: 'text', full: true, section: 'Address' },
  { name: 'address_line2', label: 'Address line 2', type: 'text', full: true, section: 'Address' },
  { name: 'city', label: 'City', type: 'text', section: 'Address' },
  { name: 'state', label: 'State / region', type: 'text', section: 'Address' },
  { name: 'postal_code', label: 'Postal code', type: 'text', section: 'Address' },
  { name: 'country', label: 'Country', type: 'text', section: 'Address' },
  { name: 'tax_id', label: 'Tax ID', type: 'text', section: 'Financial' },
  { name: 'default_vat_rate', label: 'Default VAT rate (%)', type: 'decimal', min: 0, max: 100, default: 0, section: 'Financial', help: 'Applied to product costs when this supplier is selected as the default supplier.' },
  { name: 'default_levy_rate', label: 'Default levy rate (%)', type: 'decimal', min: 0, max: 100, default: 0, section: 'Financial', help: 'Supplier-specific levy, applied as a percentage of the cost gross price.' },
  {
    name: 'payment_terms',
    label: 'Payment terms',
    type: 'select',
    default: 'Net 30',
    section: 'Financial',
    options: ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'].map((v) => ({ value: v, label: v })),
  },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true, section: 'Notes' },
];

const router = makeResourceRouter({
  key: 'suppliers',
  basePath: '/suppliers',
  title: 'Suppliers',
  singular: 'Supplier',
  table: 'suppliers',
  numberField: 'supplier_no',
  number: { prefix: 'SUP', year: false, pad: 5 },
  titleField: 'company_name',
  searchFields: ['t.supplier_no', 't.company_name', 't.contact_name', 't.email', 't.phone', 't.city'],
  filters: [{ name: 'status', label: 'Status', options: statusOptions }],
  orderBy: 't.company_name ASC',
  fields,
  columns: [
    { key: 'company_name', label: 'Supplier', type: 'primary', sub: 'supplier_no' },
    { key: 'contact_name', label: 'Contact' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'order_count', label: 'Orders', type: 'number', align: 'right' },
    { key: 'current_balance', label: 'Current balance', type: 'money', align: 'right' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
  select: `t.*,
    (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = t.id) AS order_count,
    (SELECT COALESCE(SUM(GREATEST(pi.total - pi.amount_paid, 0)), 0)
       FROM purchase_invoices pi
      WHERE pi.supplier_id = t.id AND pi.status IN ('received', 'overdue'))
    - (SELECT COALESCE(SUM(p.unapplied_amount), 0)
         FROM payments p
        WHERE p.direction = 'supplier' AND p.supplier_id = t.id) AS current_balance`,
  relatedLoader: async (row, req) => {
    const orders = await query(
      `SELECT id, order_no, order_date, status, total FROM purchase_orders WHERE supplier_id = ? ORDER BY order_date DESC LIMIT 6`,
      [row.id],
    );
    const invoices = await query(
      `SELECT id, bill_no, invoice_date, status, total FROM purchase_invoices WHERE supplier_id = ? ORDER BY invoice_date DESC LIMIT 6`,
      [row.id],
    );
    const payments = await query(
      `SELECT id, payment_no, payment_date, total_amount, applied_amount, unapplied_amount
         FROM payments
        WHERE direction = 'supplier' AND supplier_id = ?
        ORDER BY payment_date DESC, id DESC
        LIMIT 6`,
      [row.id],
    );
    const canManageBankAccounts = req.session.user && ['admin', 'manager'].includes(req.session.user.role);
    const bankAccounts = canManageBankAccounts
      ? await query(
        `SELECT id, bank_name, account_number, cbu, alias, notes
           FROM bank_accounts
          WHERE owner_type = 'supplier' AND owner_id = ?
          ORDER BY bank_name, id`,
        [row.id],
      )
      : [];
    const sections = [
      {
        title: 'Recent purchase orders',
        href: `/purchase-orders?q=${encodeURIComponent(row.company_name)}`,
        columns: [
          { key: 'order_no', label: 'Order' },
          { key: 'order_date', label: 'Date', type: 'date' },
          { key: 'status', label: 'Status', type: 'status' },
          { key: 'total', label: 'Total', type: 'money', align: 'right' },
        ],
        rows: orders,
        linkBase: '/purchase-orders',
      },
      {
        title: 'Recent bills',
        href: `/purchases?q=${encodeURIComponent(row.company_name)}`,
        columns: [
          { key: 'bill_no', label: 'Bill' },
          { key: 'invoice_date', label: 'Date', type: 'date' },
          { key: 'status', label: 'Status', type: 'status' },
          { key: 'total', label: 'Total', type: 'money', align: 'right' },
        ],
        rows: invoices,
        linkBase: '/purchases',
      },
      {
        title: 'Recent supplier payments',
        href: `/payments?type=supplier&q=${encodeURIComponent(row.company_name)}`,
        columns: [
          { key: 'payment_no', label: 'Payment no.' },
          { key: 'payment_date', label: 'Date', type: 'date' },
          { key: 'total_amount', label: 'Total', type: 'money', align: 'right' },
          { key: 'applied_amount', label: 'Applied', type: 'money', align: 'right' },
          { key: 'unapplied_amount', label: 'Unapplied credit', type: 'money', align: 'right' },
        ],
        rows: payments,
        linkBase: '/payments',
        emptyText: 'No supplier payments have been recorded yet.',
      },
    ];
    if (canManageBankAccounts) {
      sections.push({
        title: 'Bank accounts',
        href: `/bank-accounts?owner_type=supplier&q=${encodeURIComponent(row.company_name)}`,
        columns: [
          { key: 'bank_name', label: 'Bank' },
          { key: 'account_number', label: 'Account number' },
          { key: 'cbu', label: 'CBU' },
          { key: 'alias', label: 'Alias' },
          { key: 'notes', label: 'Notes' },
        ],
        rows: bankAccounts,
        emptyText: 'No bank accounts have been added for this supplier yet.',
      });
    }
    return sections;
  },
  afterDelete: async (row) => {
    await query("DELETE FROM bank_accounts WHERE owner_type = 'supplier' AND owner_id = ?", [row.id]);
  },
});

router.get('/:id(\\d+)/dashboard', (req, res, next) => renderAccountDashboard(req, res, next, 'supplier'));

module.exports = router;
