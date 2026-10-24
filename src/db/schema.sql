-- ---------------------------------------------------------------------------
-- WerpWeb ERP – schema (MySQL 8+)
-- All tables are created with IF NOT EXISTS so the migration is repeatable.
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','manager','staff') NOT NULL DEFAULT 'staff',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  skey       VARCHAR(80) NOT NULL,
  svalue     TEXT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (skey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customers (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_no    VARCHAR(30) NOT NULL,
  company_name   VARCHAR(180) NOT NULL,
  contact_name   VARCHAR(150) NULL,
  email          VARCHAR(190) NULL,
  phone          VARCHAR(40) NULL,
  website        VARCHAR(190) NULL,
  address_line1  VARCHAR(190) NULL,
  address_line2  VARCHAR(190) NULL,
  city           VARCHAR(100) NULL,
  state          VARCHAR(100) NULL,
  postal_code    VARCHAR(20) NULL,
  country        VARCHAR(100) NULL,
  tax_id         VARCHAR(60) NULL,
  payment_terms  VARCHAR(60) NOT NULL DEFAULT 'Net 30',
  credit_limit   DECIMAL(14,2) NOT NULL DEFAULT 0,
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes          TEXT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_no (customer_no),
  KEY idx_customers_name (company_name),
  KEY idx_customers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_warehouses (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id    INT UNSIGNED NOT NULL,
  code           VARCHAR(30) NULL,
  name           VARCHAR(180) NOT NULL,
  contact_name   VARCHAR(150) NULL,
  email          VARCHAR(190) NULL,
  phone          VARCHAR(40) NULL,
  address_line1  VARCHAR(190) NULL,
  address_line2  VARCHAR(190) NULL,
  city           VARCHAR(100) NULL,
  state          VARCHAR(100) NULL,
  postal_code    VARCHAR(20) NULL,
  country        VARCHAR(100) NULL,
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes          TEXT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_warehouse_code (customer_id, code),
  KEY idx_customer_warehouses_customer (customer_id),
  KEY idx_customer_warehouses_status (status),
  CONSTRAINT fk_customer_warehouses_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS suppliers (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_no    VARCHAR(30) NOT NULL,
  company_name   VARCHAR(180) NOT NULL,
  contact_name   VARCHAR(150) NULL,
  email          VARCHAR(190) NULL,
  phone          VARCHAR(40) NULL,
  website        VARCHAR(190) NULL,
  address_line1  VARCHAR(190) NULL,
  address_line2  VARCHAR(190) NULL,
  city           VARCHAR(100) NULL,
  state          VARCHAR(100) NULL,
  postal_code    VARCHAR(20) NULL,
  country        VARCHAR(100) NULL,
  tax_id         VARCHAR(60) NULL,
  payment_terms  VARCHAR(60) NOT NULL DEFAULT 'Net 30',
  default_vat_rate   DECIMAL(5,2) NOT NULL DEFAULT 0,
  default_levy_rate  DECIMAL(5,2) NOT NULL DEFAULT 0,
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes          TEXT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_suppliers_no (supplier_no),
  KEY idx_suppliers_name (company_name),
  KEY idx_suppliers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employees (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_no     VARCHAR(30) NOT NULL,
  first_name      VARCHAR(100) NOT NULL,
  last_name       VARCHAR(100) NOT NULL,
  email           VARCHAR(190) NULL,
  phone           VARCHAR(40) NULL,
  job_title       VARCHAR(120) NULL,
  department      VARCHAR(120) NULL,
  employment_type ENUM('full_time','part_time','contract','intern') NOT NULL DEFAULT 'full_time',
  hire_date       DATE NULL,
  end_date        DATE NULL,
  salary          DECIMAL(12,2) NOT NULL DEFAULT 0,
  address         VARCHAR(255) NULL,
  status          ENUM('active','on_leave','inactive') NOT NULL DEFAULT 'active',
  notes           TEXT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_employees_no (employee_no),
  KEY idx_employees_name (last_name, first_name),
  KEY idx_employees_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_categories (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS brands (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  website     VARCHAR(190) NULL,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_brands_name (name),
  KEY idx_brands_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sku           VARCHAR(50) NOT NULL,
  name          VARCHAR(180) NOT NULL,
  category_id   INT UNSIGNED NULL,
  brand_id      INT UNSIGNED NULL,
  supplier_id   INT UNSIGNED NULL,
  ean13         VARCHAR(13) NULL,
  dun14         VARCHAR(14) NULL,
  plu           INT UNSIGNED NULL,
  units_per_pack   INT UNSIGNED NULL,
  packs_per_pallet INT UNSIGNED NULL,
  sold_by_weight   TINYINT(1) NOT NULL DEFAULT 0,
  type          ENUM('finished_good','raw_material','consumable','service') NOT NULL DEFAULT 'finished_good',
  unit          VARCHAR(20) NOT NULL DEFAULT 'pcs',
  cost_gross_price DECIMAL(14,2) NOT NULL DEFAULT 0,
  cost_vat_rate    DECIMAL(5,2) NOT NULL DEFAULT 0,
  cost_levy_rate   DECIMAL(5,2) NOT NULL DEFAULT 0,
  cost_price    DECIMAL(14,2) NOT NULL DEFAULT 0,
  sale_gross_price DECIMAL(14,2) NOT NULL DEFAULT 0,
  sale_vat_rate    DECIMAL(5,2) NOT NULL DEFAULT 0,
  sale_price    DECIMAL(14,2) NOT NULL DEFAULT 0,
  stock_qty     DECIMAL(14,3) NOT NULL DEFAULT 0,
  reorder_level DECIMAL(14,3) NOT NULL DEFAULT 0,
  is_sellable   TINYINT(1) NOT NULL DEFAULT 1,
  is_purchasable TINYINT(1) NOT NULL DEFAULT 1,
  is_manufactured TINYINT(1) NOT NULL DEFAULT 0,
  track_stock   TINYINT(1) NOT NULL DEFAULT 1,
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
  description   TEXT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_sku (sku),
  UNIQUE KEY uq_products_ean13 (ean13),
  UNIQUE KEY uq_products_dun14 (dun14),
  UNIQUE KEY uq_products_plu (plu),
  KEY idx_products_name (name),
  KEY idx_products_type (type),
  KEY idx_products_category (category_id),
  KEY idx_products_brand (brand_id),
  KEY idx_products_supplier (supplier_id),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id)
    REFERENCES product_categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_products_brand FOREIGN KEY (brand_id)
    REFERENCES brands (id) ON DELETE SET NULL,
  CONSTRAINT fk_products_supplier FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_product_codes (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id INT UNSIGNED NOT NULL,
  product_id  INT UNSIGNED NOT NULL,
  code        VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_product_code (customer_id, product_id),
  KEY idx_customer_product_codes_code (code),
  CONSTRAINT fk_cpc_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_cpc_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS boms (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id INT UNSIGNED NOT NULL,
  name       VARCHAR(180) NOT NULL,
  version    VARCHAR(20) NOT NULL DEFAULT 'v1',
  output_qty DECIMAL(14,3) NOT NULL DEFAULT 1,
  status     ENUM('draft','active','archived') NOT NULL DEFAULT 'draft',
  notes      TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_boms_product_version (product_id, version),
  KEY idx_boms_status (status),
  CONSTRAINT fk_boms_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bom_items (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  bom_id       INT UNSIGNED NOT NULL,
  component_id INT UNSIGNED NOT NULL,
  quantity     DECIMAL(14,3) NOT NULL DEFAULT 1,
  scrap_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bom_component (bom_id, component_id),
  CONSTRAINT fk_bom_items_bom FOREIGN KEY (bom_id)
    REFERENCES boms (id) ON DELETE CASCADE,
  CONSTRAINT fk_bom_items_component FOREIGN KEY (component_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_orders (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_no       VARCHAR(30) NOT NULL,
  customer_id    INT UNSIGNED NOT NULL,
  customer_order_no VARCHAR(60) NULL,
  customer_warehouse_id INT UNSIGNED NULL,
  order_date     DATE NOT NULL,
  expected_date  DATE NULL,
  docking_station VARCHAR(60) NULL,
  reception_at   DATETIME NULL,
  status         ENUM('draft','confirmed','partially_delivered','delivered','cancelled') NOT NULL DEFAULT 'draft',
  subtotal       DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_total      DECIMAL(14,2) NOT NULL DEFAULT 0,
  total          DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes          TEXT NULL,
  created_by     INT UNSIGNED NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_orders_no (order_no),
  KEY idx_sales_orders_customer (customer_id),
  KEY idx_sales_orders_warehouse (customer_warehouse_id),
  KEY idx_sales_orders_status (status),
  KEY idx_sales_orders_date (order_date),
  CONSTRAINT fk_sales_orders_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_orders_warehouse FOREIGN KEY (customer_warehouse_id)
    REFERENCES customer_warehouses (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_orders_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_order_items (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id    INT UNSIGNED NOT NULL,
  product_id  INT UNSIGNED NOT NULL,
  description VARCHAR(255) NULL,
  quantity    DECIMAL(14,3) NOT NULL DEFAULT 0,
  delivered_qty DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit_price  DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_rate    DECIMAL(5,2) NOT NULL DEFAULT 0,
  line_total  DECIMAL(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_sales_order_items_order (order_id),
  CONSTRAINT fk_soi_order FOREIGN KEY (order_id)
    REFERENCES sales_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_soi_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_no       VARCHAR(30) NOT NULL,
  supplier_id    INT UNSIGNED NOT NULL,
  order_date     DATE NOT NULL,
  expected_date  DATE NULL,
  status         ENUM('draft','confirmed','partially_received','received','cancelled') NOT NULL DEFAULT 'draft',
  subtotal       DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_total      DECIMAL(14,2) NOT NULL DEFAULT 0,
  total          DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes          TEXT NULL,
  created_by     INT UNSIGNED NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_orders_no (order_no),
  KEY idx_purchase_orders_supplier (supplier_id),
  KEY idx_purchase_orders_status (status),
  KEY idx_purchase_orders_date (order_date),
  CONSTRAINT fk_purchase_orders_supplier FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_orders_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id     INT UNSIGNED NOT NULL,
  product_id   INT UNSIGNED NOT NULL,
  description  VARCHAR(255) NULL,
  quantity     DECIMAL(14,3) NOT NULL DEFAULT 0,
  received_qty DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit_price   DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_rate     DECIMAL(5,2) NOT NULL DEFAULT 0,
  line_total   DECIMAL(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_purchase_order_items_order (order_id),
  CONSTRAINT fk_poi_order FOREIGN KEY (order_id)
    REFERENCES purchase_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_poi_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS deliveries (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_no     VARCHAR(30) NOT NULL,
  sales_order_id  INT UNSIGNED NULL,
  customer_id     INT UNSIGNED NOT NULL,
  delivery_date   DATE NOT NULL,
  carrier         VARCHAR(120) NULL,
  tracking_number VARCHAR(120) NULL,
  status          ENUM('pending','shipped','delivered','cancelled') NOT NULL DEFAULT 'pending',
  stock_posted    TINYINT(1) NOT NULL DEFAULT 0,
  notes           TEXT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_deliveries_no (delivery_no),
  KEY idx_deliveries_order (sales_order_id),
  KEY idx_deliveries_customer (customer_id),
  KEY idx_deliveries_status (status),
  CONSTRAINT fk_deliveries_order FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_deliveries_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS delivery_items (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id         INT UNSIGNED NOT NULL,
  sales_order_item_id INT UNSIGNED NULL,
  product_id          INT UNSIGNED NOT NULL,
  quantity            DECIMAL(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_delivery_items_delivery (delivery_id),
  CONSTRAINT fk_di_delivery FOREIGN KEY (delivery_id)
    REFERENCES deliveries (id) ON DELETE CASCADE,
  CONSTRAINT fk_di_so_item FOREIGN KEY (sales_order_item_id)
    REFERENCES sales_order_items (id) ON DELETE SET NULL,
  CONSTRAINT fk_di_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_invoices (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_no     VARCHAR(30) NOT NULL,
  sales_order_id INT UNSIGNED NULL,
  customer_id    INT UNSIGNED NOT NULL,
  invoice_date   DATE NOT NULL,
  due_date       DATE NULL,
  status         ENUM('draft','sent','paid','overdue','cancelled') NOT NULL DEFAULT 'draft',
  subtotal       DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_total      DECIMAL(14,2) NOT NULL DEFAULT 0,
  total          DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount_paid    DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes          TEXT NULL,
  created_by     INT UNSIGNED NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_invoices_no (invoice_no),
  KEY idx_sales_invoices_order (sales_order_id),
  KEY idx_sales_invoices_customer (customer_id),
  KEY idx_sales_invoices_status (status),
  KEY idx_sales_invoices_date (invoice_date),
  CONSTRAINT fk_sales_invoices_order FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_invoices_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_invoice_items (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id  INT UNSIGNED NOT NULL,
  product_id  INT UNSIGNED NOT NULL,
  description VARCHAR(255) NULL,
  quantity    DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit_price  DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_rate    DECIMAL(5,2) NOT NULL DEFAULT 0,
  line_total  DECIMAL(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_sii_invoice (invoice_id),
  CONSTRAINT fk_sii_invoice FOREIGN KEY (invoice_id)
    REFERENCES sales_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_sii_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  bill_no           VARCHAR(30) NOT NULL,
  purchase_order_id INT UNSIGNED NULL,
  supplier_id       INT UNSIGNED NOT NULL,
  invoice_date      DATE NOT NULL,
  due_date          DATE NULL,
  status            ENUM('draft','received','paid','overdue','cancelled') NOT NULL DEFAULT 'draft',
  subtotal          DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_total    DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_total         DECIMAL(14,2) NOT NULL DEFAULT 0,
  total             DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount_paid       DECIMAL(14,2) NOT NULL DEFAULT 0,
  stock_posted      TINYINT(1) NOT NULL DEFAULT 0,
  notes             TEXT NULL,
  created_by        INT UNSIGNED NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_purchase_invoices_no (bill_no),
  KEY idx_purchase_invoices_order (purchase_order_id),
  KEY idx_purchase_invoices_supplier (supplier_id),
  KEY idx_purchase_invoices_status (status),
  KEY idx_purchase_invoices_date (invoice_date),
  CONSTRAINT fk_purchase_invoices_order FOREIGN KEY (purchase_order_id)
    REFERENCES purchase_orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_purchase_invoices_supplier FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_invoice_items (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id  INT UNSIGNED NOT NULL,
  product_id  INT UNSIGNED NOT NULL,
  description VARCHAR(255) NULL,
  quantity    DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit_price  DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_rate    DECIMAL(5,2) NOT NULL DEFAULT 0,
  line_total  DECIMAL(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_pii_invoice (invoice_id),
  CONSTRAINT fk_pii_invoice FOREIGN KEY (invoice_id)
    REFERENCES purchase_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_pii_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_no        VARCHAR(30) NOT NULL,
  direction         ENUM('customer','supplier') NOT NULL,
  customer_id       INT UNSIGNED NULL,
  supplier_id       INT UNSIGNED NULL,
  payment_date      DATE NOT NULL,
  reference         VARCHAR(120) NULL,
  method_total      DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit_total      DECIMAL(14,2) NOT NULL DEFAULT 0,
  debit_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  withholding_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_amount      DECIMAL(14,2) NOT NULL DEFAULT 0,
  applied_amount    DECIMAL(14,2) NOT NULL DEFAULT 0,
  unapplied_amount  DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes             TEXT NULL,
  created_by        INT UNSIGNED NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_no (payment_no),
  KEY idx_payments_direction (direction),
  KEY idx_payments_customer (customer_id),
  KEY idx_payments_supplier (supplier_id),
  KEY idx_payments_date (payment_date),
  KEY idx_payments_created_by (created_by),
  CONSTRAINT chk_payments_party CHECK (
    (direction = 'customer' AND customer_id IS NOT NULL AND supplier_id IS NULL) OR
    (direction = 'supplier' AND supplier_id IS NOT NULL AND customer_id IS NULL)
  ),
  CONSTRAINT fk_payments_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_payments_supplier FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_payments_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_allocations (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id   INT UNSIGNED NOT NULL,
  invoice_type ENUM('sales','purchase') NOT NULL,
  invoice_id   INT UNSIGNED NOT NULL,
  invoice_no   VARCHAR(30) NOT NULL,
  amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_allocation (payment_id, invoice_type, invoice_id),
  KEY idx_payment_allocations_payment (payment_id),
  KEY idx_payment_allocations_invoice (invoice_type, invoice_id),
  CONSTRAINT fk_payment_allocations_payment FOREIGN KEY (payment_id)
    REFERENCES payments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_methods (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id INT UNSIGNED NOT NULL,
  method     ENUM('cash','bank_transfer','own_check','endorsed_check','other') NOT NULL,
  amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
  reference  VARCHAR(120) NULL,
  bank_name  VARCHAR(120) NULL,
  check_date DATE NULL,
  notes      VARCHAR(255) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_payment_methods_payment (payment_id),
  CONSTRAINT fk_payment_methods_payment FOREIGN KEY (payment_id)
    REFERENCES payments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_adjustments (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id INT UNSIGNED NOT NULL,
  kind       ENUM('credit_note','debit_note','withholding') NOT NULL,
  amount     DECIMAL(14,2) NOT NULL DEFAULT 0,
  reference  VARCHAR(120) NULL,
  notes      VARCHAR(255) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_payment_adjustments_payment (payment_id),
  CONSTRAINT fk_payment_adjustments_payment FOREIGN KEY (payment_id)
    REFERENCES payments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Checks received from customers or issued/endorsed to suppliers.
-- A check keeps its own lifecycle and audit trail, independently of the
-- payment that brought it in or the payment where it was endorsed.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS checks (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  check_no            VARCHAR(30) NOT NULL,
  check_number        VARCHAR(60) NULL,
  bank_name           VARCHAR(120) NULL,
  drawer_name         VARCHAR(150) NULL,
  amount              DECIMAL(14,2) NOT NULL DEFAULT 0,
  entry_type          ENUM('received','issued') NOT NULL DEFAULT 'received',
  status              ENUM('available','deposited','endorsed','paid','rejected','expired') NOT NULL DEFAULT 'available',
  customer_id         INT UNSIGNED NULL,
  supplier_id         INT UNSIGNED NULL,
  issue_date          DATE NULL,
  due_date            DATE NULL,
  received_date       DATE NULL,
  deposited_bank      VARCHAR(120) NULL,
  deposited_date      DATE NULL,
  endorsed_date       DATE NULL,
  settled_date        DATE NULL,
  received_payment_id INT UNSIGNED NULL,
  issued_payment_id   INT UNSIGNED NULL,
  source              ENUM('manual','payment') NOT NULL DEFAULT 'manual',
  notes               TEXT NULL,
  created_by          INT UNSIGNED NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_checks_no (check_no),
  KEY idx_checks_status (status),
  KEY idx_checks_entry_type (entry_type),
  KEY idx_checks_customer (customer_id),
  KEY idx_checks_supplier (supplier_id),
  KEY idx_checks_dates (issue_date, due_date),
  KEY idx_checks_received_payment (received_payment_id),
  KEY idx_checks_issued_payment (issued_payment_id),
  KEY idx_checks_created_by (created_by),
  CONSTRAINT fk_checks_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE SET NULL,
  CONSTRAINT fk_checks_supplier FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE SET NULL,
  CONSTRAINT fk_checks_received_payment FOREIGN KEY (received_payment_id)
    REFERENCES payments (id) ON DELETE SET NULL,
  CONSTRAINT fk_checks_issued_payment FOREIGN KEY (issued_payment_id)
    REFERENCES payments (id) ON DELETE SET NULL,
  CONSTRAINT fk_checks_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS check_history (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  check_id    INT UNSIGNED NOT NULL,
  event       ENUM('created','updated','deposited','endorsed','paid','rejected','expired','reopened','linked','unlinked') NOT NULL,
  from_status ENUM('available','deposited','endorsed','paid','rejected','expired') NULL,
  to_status   ENUM('available','deposited','endorsed','paid','rejected','expired') NULL,
  event_date  DATE NOT NULL,
  notes       VARCHAR(500) NULL,
  user_id     INT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_check_history_check (check_id, created_at),
  KEY idx_check_history_date (event_date),
  CONSTRAINT fk_check_history_check FOREIGN KEY (check_id)
    REFERENCES checks (id) ON DELETE CASCADE,
  CONSTRAINT fk_check_history_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_orders (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  production_no  VARCHAR(30) NOT NULL,
  sales_order_id INT UNSIGNED NULL,
  bom_id         INT UNSIGNED NOT NULL,
  product_id     INT UNSIGNED NOT NULL,
  lot_number     VARCHAR(60) NULL,
  expiry_date    DATE NULL,
  quantity       DECIMAL(14,3) NOT NULL DEFAULT 0,
  start_date     DATE NULL,
  due_date       DATE NULL,
  status         ENUM('planned','released','in_progress','completed','cancelled') NOT NULL DEFAULT 'planned',
  completed_at   DATETIME NULL,
  notes          TEXT NULL,
  created_by     INT UNSIGNED NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_orders_no (production_no),
  KEY idx_production_orders_status (status),
  KEY idx_production_orders_order (sales_order_id),
  KEY idx_production_orders_product (product_id),
  KEY idx_production_orders_expiry (expiry_date),
  CONSTRAINT fk_production_orders_order FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_production_orders_bom FOREIGN KEY (bom_id)
    REFERENCES boms (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_orders_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_orders_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_order_materials (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  production_order_id INT UNSIGNED NOT NULL,
  component_id      INT UNSIGNED NOT NULL,
  quantity_required DECIMAL(14,3) NOT NULL DEFAULT 0,
  quantity_consumed DECIMAL(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_pom_order (production_order_id),
  CONSTRAINT fk_pom_order FOREIGN KEY (production_order_id)
    REFERENCES production_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_pom_component FOREIGN KEY (component_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per item that passed through the Bizerba GLM-e scale/labeler.
-- Weights are stored in kilograms. Product data is snapshotted so the history
-- remains readable if a product is renamed or removed later.
CREATE TABLE IF NOT EXISTS scale_records (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id     INT UNSIGNED NULL,
  plu            INT UNSIGNED NULL,
  lot_number     VARCHAR(60) NULL,
  expiry_date    DATE NULL,
  weighed_at     DATETIME NOT NULL,
  in_range       TINYINT(1) NOT NULL DEFAULT 0,
  real_weight    DECIMAL(14,3) NOT NULL DEFAULT 0,
  printed_weight DECIMAL(14,3) NOT NULL DEFAULT 0,
  printed_price  DECIMAL(14,2) NOT NULL DEFAULT 0,
  label_id       VARCHAR(80) NULL,
  box_id         VARCHAR(80) NULL,
  pallet_id      VARCHAR(80) NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_scale_records_weighed (weighed_at, id),
  KEY idx_scale_records_lot (lot_number, weighed_at),
  KEY idx_scale_records_product (product_id, weighed_at),
  KEY idx_scale_records_plu (plu, weighed_at),
  KEY idx_scale_records_range (in_range, weighed_at),
  KEY idx_scale_records_label (label_id),
  KEY idx_scale_records_box (box_id),
  KEY idx_scale_records_pallet (pallet_id),
  CONSTRAINT fk_scale_records_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_movements (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id     INT UNSIGNED NOT NULL,
  movement_type  ENUM('purchase_in','sale_out','production_in','production_out','adjustment') NOT NULL,
  quantity       DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit_cost      DECIMAL(14,2) NOT NULL DEFAULT 0,
  reference_type VARCHAR(50) NULL,
  reference_id   INT UNSIGNED NULL,
  notes          VARCHAR(255) NULL,
  created_by     INT UNSIGNED NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stock_movements_product (product_id),
  KEY idx_stock_movements_date (created_at),
  CONSTRAINT fk_stock_movements_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Unit #2 – retail points of sale
-- POS sales are reporting records. They deliberately do not post stock
-- movements or alter Unit #1 inventory.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pos_locations (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code          VARCHAR(20) NOT NULL,
  name          VARCHAR(120) NOT NULL,
  address_line1 VARCHAR(190) NULL,
  city          VARCHAR(100) NULL,
  state         VARCHAR(100) NULL,
  postal_code   VARCHAR(20) NULL,
  phone         VARCHAR(40) NULL,
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes         TEXT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pos_locations_code (code),
  KEY idx_pos_locations_name (name),
  KEY idx_pos_locations_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pos_sales (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  pos_id          INT UNSIGNED NOT NULL,
  ticket_type     VARCHAR(40) NOT NULL,
  ticket_number   VARCHAR(40) NOT NULL,
  sale_date       DATE NOT NULL,
  payment_method  ENUM('cash','card','transfer','other') NOT NULL DEFAULT 'cash',
  customer_name   VARCHAR(180) NULL,
  subtotal        DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_total  DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_total       DECIMAL(14,2) NOT NULL DEFAULT 0,
  total           DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes           TEXT NULL,
  created_by      INT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pos_sales_ticket (pos_id, ticket_type, ticket_number),
  KEY idx_pos_sales_pos_date (pos_id, sale_date),
  KEY idx_pos_sales_date (sale_date),
  KEY idx_pos_sales_type (ticket_type),
  CONSTRAINT fk_pos_sales_location FOREIGN KEY (pos_id)
    REFERENCES pos_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pos_sales_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pos_sale_items (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_id     INT UNSIGNED NOT NULL,
  product_id  INT UNSIGNED NOT NULL,
  description VARCHAR(255) NULL,
  quantity    DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit_price  DECIMAL(14,2) NOT NULL DEFAULT 0,
  tax_rate    DECIMAL(5,2) NOT NULL DEFAULT 0,
  line_total  DECIMAL(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_pos_sale_items_sale (sale_id),
  KEY idx_pos_sale_items_product (product_id),
  CONSTRAINT fk_pos_sale_items_sale FOREIGN KEY (sale_id)
    REFERENCES pos_sales (id) ON DELETE CASCADE,
  CONSTRAINT fk_pos_sale_items_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Outgoing email audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_log (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_type VARCHAR(40) NOT NULL,
  document_id   INT UNSIGNED NULL,
  document_no   VARCHAR(80) NOT NULL,
  party_name    VARCHAR(180) NULL,
  to_email      VARCHAR(500) NOT NULL,
  cc_email      VARCHAR(500) NULL,
  subject       VARCHAR(255) NOT NULL,
  message       TEXT NULL,
  status        ENUM('sent','failed') NOT NULL DEFAULT 'sent',
  error_text    TEXT NULL,
  message_id    VARCHAR(255) NULL,
  sent_by       INT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_email_log_document (document_type, document_id),
  KEY idx_email_log_created (created_at),
  KEY idx_email_log_status (status),
  CONSTRAINT fk_email_log_user FOREIGN KEY (sent_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
