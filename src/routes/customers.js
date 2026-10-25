'use strict';

const { makeResourceRouter } = require('./resource');
const { query, one, getPool } = require('../db');
const h = require('../lib/helpers');
const { renderAccountDashboard } = require('../lib/accountDashboard');

const statusOptions = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

const fields = [
  { name: 'customer_no', label: 'Customer no.', type: 'text', section: 'Company', help: 'Leave blank to generate automatically.', maxLength: 30 },
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
  {
    name: 'payment_terms',
    label: 'Payment terms',
    type: 'select',
    default: 'Net 30',
    section: 'Financial',
    options: ['Due on receipt', 'Net 15', 'Net 30', 'Net 45', 'Net 60'].map((v) => ({ value: v, label: v })),
  },
  { name: 'credit_limit', label: 'Credit limit', type: 'decimal', min: 0, default: 0, section: 'Financial' },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true, section: 'Notes' },
];

const router = makeResourceRouter({
  key: 'customers',
  basePath: '/customers',
  title: 'Customers',
  singular: 'Customer',
  table: 'customers',
  numberField: 'customer_no',
  number: { prefix: 'CUS', year: false, pad: 5 },
  titleField: 'company_name',
  searchFields: ['t.customer_no', 't.company_name', 't.contact_name', 't.email', 't.phone', 't.city'],
  filters: [{ name: 'status', label: 'Status', options: statusOptions }],
  orderBy: 't.company_name ASC',
  fields,
  columns: [
    { key: 'company_name', label: 'Customer', type: 'primary', sub: 'customer_no' },
    { key: 'contact_name', label: 'Contact' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'order_count', label: 'Orders', type: 'number', align: 'right' },
    { key: 'current_balance', label: 'Current balance', type: 'money', align: 'right' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
  select: `t.*,
    (SELECT COUNT(*) FROM sales_orders so WHERE so.customer_id = t.id) AS order_count,
    (SELECT COALESCE(SUM(GREATEST(si.total - si.amount_paid, 0)), 0)
       FROM sales_invoices si
      WHERE si.customer_id = t.id AND si.status IN ('sent', 'overdue'))
    - (SELECT COALESCE(SUM(p.unapplied_amount), 0)
         FROM payments p
        WHERE p.direction = 'customer' AND p.customer_id = t.id) AS current_balance`,
  relatedLoader: async (row, req) => {
    const orders = await query(
      `SELECT id, order_no, order_date, status, total FROM sales_orders WHERE customer_id = ? ORDER BY order_date DESC LIMIT 6`,
      [row.id],
    );
    const invoices = await query(
      `SELECT id, invoice_no, invoice_date, status, total, amount_paid FROM sales_invoices WHERE customer_id = ? ORDER BY invoice_date DESC LIMIT 6`,
      [row.id],
    );
    const payments = await query(
      `SELECT id, payment_no, payment_date, total_amount, applied_amount, unapplied_amount
         FROM payments
        WHERE direction = 'customer' AND customer_id = ?
        ORDER BY payment_date DESC, id DESC
        LIMIT 6`,
      [row.id],
    );
    const warehouses = await query(
      `SELECT w.*,
              (SELECT COUNT(*) FROM sales_orders so WHERE so.customer_warehouse_id = w.id) AS order_count
         FROM customer_warehouses w
        WHERE w.customer_id = ?
        ORDER BY w.status = 'active' DESC, w.name`,
      [row.id],
    );
    const productCodes = await query(
      `SELECT cpc.id, cpc.code, cpc.description, p.sku, p.name AS product_name
         FROM customer_product_codes cpc
         JOIN products p ON p.id = cpc.product_id
        WHERE cpc.customer_id = ? ORDER BY p.name`,
      [row.id],
    );
    const canManageBankAccounts = req.session.user && ['admin', 'manager'].includes(req.session.user.role);
    const bankAccounts = canManageBankAccounts
      ? await query(
        `SELECT id, bank_name, account_number, cbu, alias, notes
           FROM bank_accounts
          WHERE owner_type = 'customer' AND owner_id = ?
          ORDER BY bank_name, id`,
        [row.id],
      )
      : [];
    const sections = [
      {
        title: 'Recent sales orders',
        href: `/sales-orders?q=${encodeURIComponent(row.company_name)}`,
        columns: [
          { key: 'order_no', label: 'Order' },
          { key: 'order_date', label: 'Date', type: 'date' },
          { key: 'status', label: 'Status', type: 'status' },
          { key: 'total', label: 'Total', type: 'money', align: 'right' },
        ],
        rows: orders,
        linkBase: '/sales-orders',
      },
      {
        title: 'Recent invoices',
        href: `/sales?q=${encodeURIComponent(row.company_name)}`,
        columns: [
          { key: 'invoice_no', label: 'Invoice' },
          { key: 'invoice_date', label: 'Date', type: 'date' },
          { key: 'status', label: 'Status', type: 'status' },
          { key: 'total', label: 'Total', type: 'money', align: 'right' },
        ],
        rows: invoices,
        linkBase: '/sales',
      },
      {
        title: 'Recent customer payments',
        href: `/payments?type=customer&q=${encodeURIComponent(row.company_name)}`,
        columns: [
          { key: 'payment_no', label: 'Payment no.' },
          { key: 'payment_date', label: 'Date', type: 'date' },
          { key: 'total_amount', label: 'Total', type: 'money', align: 'right' },
          { key: 'applied_amount', label: 'Applied', type: 'money', align: 'right' },
          { key: 'unapplied_amount', label: 'Unapplied credit', type: 'money', align: 'right' },
        ],
        rows: payments,
        linkBase: '/payments',
        emptyText: 'No customer payments have been recorded yet.',
      },
      {
        title: 'Customer warehouses',
        href: `/customers/${row.id}/warehouses`,
        columns: [
          { key: 'name', label: 'Warehouse' },
          { key: 'code', label: 'Code' },
          { key: 'city', label: 'City' },
          { key: 'order_count', label: 'Orders', type: 'number', align: 'right' },
          { key: 'status', label: 'Status', type: 'status' },
        ],
        rows: warehouses,
        emptyText: 'No warehouses have been added for this customer yet.',
      },
      {
        title: 'Customer product codes',
        href: `/customers/${row.id}/product-codes`,
        columns: [
          { key: 'product_name', label: 'Product' },
          { key: 'sku', label: 'Our SKU' },
          { key: 'code', label: 'Customer code' },
          { key: 'description', label: 'Description' },
        ],
        rows: productCodes,
        emptyText: 'No customer-specific product codes have been assigned yet.',
      },
    ];
    if (canManageBankAccounts) {
      sections.push({
        title: 'Bank accounts',
        href: `/bank-accounts?owner_type=customer&q=${encodeURIComponent(row.company_name)}`,
        columns: [
          { key: 'bank_name', label: 'Bank' },
          { key: 'account_number', label: 'Account number' },
          { key: 'cbu', label: 'CBU' },
          { key: 'alias', label: 'Alias' },
          { key: 'notes', label: 'Notes' },
        ],
        rows: bankAccounts,
        emptyText: 'No bank accounts have been added for this customer yet.',
      });
    }
    return sections;
  },
  afterDelete: async (row) => {
    await query("DELETE FROM bank_accounts WHERE owner_type = 'customer' AND owner_id = ?", [row.id]);
  },
});

// ------------------------------------------------------- account dashboard
router.get('/:id(\\d+)/dashboard', (req, res, next) => renderAccountDashboard(req, res, next, 'customer'));

// --------------------------------------------------------- product codes
async function loadProductCodePage(customerId) {
  const customer = await one('SELECT * FROM customers WHERE id = ? LIMIT 1', [customerId]);
  if (!customer) return null;
  const products = await query(
    `SELECT id, sku, name, status FROM products ORDER BY name, sku`,
  );
  const codes = await query(
    `SELECT cpc.*, p.sku, p.name AS product_name
       FROM customer_product_codes cpc
       JOIN products p ON p.id = cpc.product_id
      WHERE cpc.customer_id = ? ORDER BY p.name, p.sku`,
    [customerId],
  );
  return { customer, products, codes };
}

router.get('/:id(\\d+)/product-codes', async (req, res, next) => {
  try {
    const data = await loadProductCodePage(req.params.id);
    if (!data) {
      return next(Object.assign(new Error(req.t('Customer not found.')), { status: 404 }));
    }
    res.render('customers/product-codes', {
      title: req.t('Product codes · {customer}', { customer: data.customer.company_name }),
      active: 'customers',
      breadcrumbs: [
        { label: req.t('Customers'), href: '/customers' },
        { label: data.customer.company_name, href: `/customers/${data.customer.id}` },
        { label: req.t('Product codes') },
      ],
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/product-codes', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const customer = await one('SELECT id, company_name FROM customers WHERE id = ? LIMIT 1', [customerId]);
    if (!customer) {
      return next(Object.assign(new Error(req.t('Customer not found.')), { status: 404 }));
    }

    const productId = Number.parseInt(req.body.product_id, 10);
    const code = String(req.body.code || '').trim();
    const description = String(req.body.description || '').trim() || null;

    if (!productId) {
      req.flash('error', req.t('Choose a product before adding a customer code.'));
      return res.redirect(`/customers/${customerId}/product-codes`);
    }
    if (!code) {
      req.flash('error', req.t('The customer code cannot be empty.'));
      return res.redirect(`/customers/${customerId}/product-codes`);
    }
    if (code.length > 80) {
      req.flash('error', req.t('The customer code must be 80 characters or fewer.'));
      return res.redirect(`/customers/${customerId}/product-codes`);
    }
    const product = await one('SELECT id FROM products WHERE id = ? LIMIT 1', [productId]);
    if (!product) {
      req.flash('error', req.t('The selected product no longer exists.'));
      return res.redirect(`/customers/${customerId}/product-codes`);
    }

    await getPool().query(
      `INSERT INTO customer_product_codes (customer_id, product_id, code, description)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE code = VALUES(code), description = VALUES(description)`,
      [customerId, productId, code, description],
    );
    req.flash('success', 'Customer product code saved.');
    res.redirect(`/customers/${customerId}/product-codes`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/product-codes/:codeId(\\d+)', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const codeId = Number(req.params.codeId);
    const existing = await one(
      'SELECT id FROM customer_product_codes WHERE id = ? AND customer_id = ? LIMIT 1',
      [codeId, customerId],
    );
    if (!existing) {
      req.flash('error', req.t('Customer product code not found.'));
      return res.redirect(`/customers/${customerId}/product-codes`);
    }
    const code = String(req.body.code || '').trim();
    if (!code || code.length > 80) {
      req.flash('error', req.t('The customer code must be between 1 and 80 characters.'));
      return res.redirect(`/customers/${customerId}/product-codes`);
    }
    const description = String(req.body.description || '').trim() || null;
    await getPool().query(
      'UPDATE customer_product_codes SET code = ?, description = ? WHERE id = ? AND customer_id = ?',
      [code, description, codeId, customerId],
    );
    req.flash('success', 'Customer product code updated.');
    res.redirect(`/customers/${customerId}/product-codes`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/product-codes/:codeId(\\d+)/delete', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const codeId = Number(req.params.codeId);
    await getPool().query(
      'DELETE FROM customer_product_codes WHERE id = ? AND customer_id = ?',
      [codeId, customerId],
    );
    req.flash('success', 'Customer product code removed.');
    res.redirect(`/customers/${customerId}/product-codes`);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- warehouses
function normalizeWarehouse(body) {
  const text = (value, max) => {
    const cleaned = String(value || '').trim().slice(0, max);
    return cleaned || null;
  };
  return {
    code: text(body.code, 30),
    name: text(body.name, 180) || '',
    contact_name: text(body.contact_name, 150),
    email: text(body.email, 190),
    phone: text(body.phone, 40),
    address_line1: text(body.address_line1, 190),
    address_line2: text(body.address_line2, 190),
    city: text(body.city, 100),
    state: text(body.state, 100),
    postal_code: text(body.postal_code, 20),
    country: text(body.country, 100),
    status: body.status === 'inactive' ? 'inactive' : 'active',
    notes: text(body.notes, 5000),
  };
}

function validateWarehouse(values, req) {
  const errors = {};
  if (!values.name) errors.name = req.t('Warehouse name is required.');
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.email = req.t('Enter a valid email address.');
  }
  return errors;
}

async function loadCustomerOr404(customerId, req, next) {
  const customer = await one('SELECT * FROM customers WHERE id = ? LIMIT 1', [customerId]);
  if (!customer) {
    next(Object.assign(new Error(req.t('Customer not found.')), { status: 404 }));
    return null;
  }
  return customer;
}

async function warehouseCodeTaken(customerId, code, excludeId, req) {
  if (!code) return false;
  const existing = await one(
    'SELECT id FROM customer_warehouses WHERE customer_id = ? AND code = ? AND id <> ? LIMIT 1',
    [customerId, code, excludeId || 0],
  );
  if (existing) return req.t('Another warehouse for this customer already uses that code.');
  return false;
}

async function renderWarehouseForm(req, res, status, data) {
  return res.status(status).render('customers/warehouse-form', {
    title: data.mode === 'create'
      ? req.t('New warehouse · {customer}', { customer: data.customer.company_name })
      : req.t('Edit warehouse · {customer}', { customer: data.customer.company_name }),
    active: 'customers',
    breadcrumbs: [
      { label: req.t('Customers'), href: '/customers' },
      { label: data.customer.company_name, href: `/customers/${data.customer.id}` },
      { label: req.t('Warehouses'), href: `/customers/${data.customer.id}/warehouses` },
      { label: data.mode === 'create' ? req.t('New warehouse') : req.t('Edit warehouse') },
    ],
    ...data,
  });
}

router.get('/:id(\\d+)/warehouses', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const customer = await loadCustomerOr404(customerId, req, next);
    if (!customer) return;
    const warehouses = await query(
      `SELECT w.*,
              (SELECT COUNT(*) FROM sales_orders so WHERE so.customer_warehouse_id = w.id) AS order_count
         FROM customer_warehouses w
        WHERE w.customer_id = ?
        ORDER BY w.status = 'active' DESC, w.name`,
      [customerId],
    );
    res.render('customers/warehouses', {
      title: req.t('Warehouses · {customer}', { customer: customer.company_name }),
      active: 'customers',
      breadcrumbs: [
        { label: req.t('Customers'), href: '/customers' },
        { label: customer.company_name, href: `/customers/${customer.id}` },
        { label: req.t('Warehouses') },
      ],
      customer,
      warehouses,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/warehouses/new', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const customer = await loadCustomerOr404(customerId, req, next);
    if (!customer) return;
    await renderWarehouseForm(req, res, 200, {
      customer,
      mode: 'create',
      warehouse: {
        code: '',
        name: '',
        contact_name: '',
        email: '',
        phone: '',
        address_line1: '',
        address_line2: '',
        city: '',
        state: '',
        postal_code: '',
        country: customer.country || '',
        status: 'active',
        notes: '',
      },
      errors: {},
      action: `/customers/${customer.id}/warehouses`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/warehouses', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const customer = await loadCustomerOr404(customerId, req, next);
    if (!customer) return;

    const values = normalizeWarehouse(req.body);
    const errors = validateWarehouse(values, req);
    if (!errors.code) {
      const duplicate = await warehouseCodeTaken(customerId, values.code, 0, req);
      if (duplicate) errors.code = duplicate;
    }
    if (Object.keys(errors).length) {
      return renderWarehouseForm(req, res, 422, {
        customer,
        mode: 'create',
        warehouse: values,
        errors,
        action: `/customers/${customer.id}/warehouses`,
      });
    }

    await getPool().query(
      `INSERT INTO customer_warehouses
         (customer_id, code, name, contact_name, email, phone, address_line1, address_line2,
          city, state, postal_code, country, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId, values.code, values.name, values.contact_name, values.email, values.phone,
        values.address_line1, values.address_line2, values.city, values.state, values.postal_code,
        values.country, values.status, values.notes,
      ],
    );
    req.flash('success', 'Warehouse created.');
    res.redirect(`/customers/${customerId}/warehouses`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/warehouses/:warehouseId(\\d+)/edit', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const customer = await loadCustomerOr404(customerId, req, next);
    if (!customer) return;
    const warehouse = await one(
      'SELECT * FROM customer_warehouses WHERE id = ? AND customer_id = ? LIMIT 1',
      [Number(req.params.warehouseId), customerId],
    );
    if (!warehouse) {
      return next(Object.assign(new Error(req.t('Warehouse not found.')), { status: 404 }));
    }
    await renderWarehouseForm(req, res, 200, {
      customer,
      mode: 'edit',
      warehouse,
      errors: {},
      action: `/customers/${customer.id}/warehouses/${warehouse.id}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/warehouses/:warehouseId(\\d+)', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const warehouseId = Number(req.params.warehouseId);
    const customer = await loadCustomerOr404(customerId, req, next);
    if (!customer) return;
    const existing = await one(
      'SELECT * FROM customer_warehouses WHERE id = ? AND customer_id = ? LIMIT 1',
      [warehouseId, customerId],
    );
    if (!existing) {
      return next(Object.assign(new Error(req.t('Warehouse not found.')), { status: 404 }));
    }

    const values = normalizeWarehouse(req.body);
    const errors = validateWarehouse(values, req);
    if (!errors.code) {
      const duplicate = await warehouseCodeTaken(customerId, values.code, warehouseId, req);
      if (duplicate) errors.code = duplicate;
    }
    if (Object.keys(errors).length) {
      return renderWarehouseForm(req, res, 422, {
        customer,
        mode: 'edit',
        warehouse: { ...values, id: warehouseId },
        errors,
        action: `/customers/${customer.id}/warehouses/${warehouseId}`,
      });
    }

    await getPool().query(
      `UPDATE customer_warehouses
          SET code = ?, name = ?, contact_name = ?, email = ?, phone = ?, address_line1 = ?,
              address_line2 = ?, city = ?, state = ?, postal_code = ?, country = ?, status = ?, notes = ?
        WHERE id = ? AND customer_id = ?`,
      [
        values.code, values.name, values.contact_name, values.email, values.phone,
        values.address_line1, values.address_line2, values.city, values.state, values.postal_code,
        values.country, values.status, values.notes, warehouseId, customerId,
      ],
    );
    req.flash('success', 'Warehouse updated.');
    res.redirect(`/customers/${customerId}/warehouses`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/warehouses/:warehouseId(\\d+)/delete', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);
    const warehouseId = Number(req.params.warehouseId);
    const existing = await one(
      'SELECT id, name FROM customer_warehouses WHERE id = ? AND customer_id = ? LIMIT 1',
      [warehouseId, customerId],
    );
    if (!existing) {
      req.flash('error', req.t('Warehouse not found.'));
      return res.redirect(`/customers/${customerId}/warehouses`);
    }
    const used = await one(
      'SELECT COUNT(*) AS count FROM sales_orders WHERE customer_warehouse_id = ?',
      [warehouseId],
    );
    if (Number(used.count) > 0) {
      req.flash('error', 'This warehouse is used by sales orders and cannot be deleted. Mark it inactive instead.');
      return res.redirect(`/customers/${customerId}/warehouses`);
    }
    await getPool().query(
      'DELETE FROM customer_warehouses WHERE id = ? AND customer_id = ?',
      [warehouseId, customerId],
    );
    req.flash('success', 'Warehouse deleted.');
    res.redirect(`/customers/${customerId}/warehouses`);
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      req.flash('error', 'This warehouse is used by sales orders and cannot be deleted. Mark it inactive instead.');
      return res.redirect(`/customers/${req.params.id}/warehouses`);
    }
    next(err);
  }
});

module.exports = router;
