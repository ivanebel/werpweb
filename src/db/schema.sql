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

CREATE TABLE IF NOT EXISTS fiscal_document_types (
  code       SMALLINT UNSIGNED NOT NULL,
  name       VARCHAR(255) NOT NULL,
  active     TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employees (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_no     VARCHAR(30) NOT NULL,
  clock_id        VARCHAR(40) NULL,
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
  UNIQUE KEY uq_employees_clock_id (clock_id),
  KEY idx_employees_name (last_name, first_name),
  KEY idx_employees_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shifts (
  id                       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                     VARCHAR(120) NOT NULL,
  start_time               TIME NOT NULL,
  end_time                 TIME NOT NULL,
  work_days                SET('mon','tue','wed','thu','fri','sat','sun') NOT NULL,
  grace_minutes            INT UNSIGNED NOT NULL DEFAULT 10,
  early_leave_grace_minutes INT UNSIGNED NOT NULL DEFAULT 10,
  status                   ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes                    VARCHAR(500) NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shifts_name (name),
  KEY idx_shifts_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_shift_assignments (
  id                              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id                     INT UNSIGNED NOT NULL,
  shift_id                        INT UNSIGNED NOT NULL,
  effective_from                  DATE NOT NULL,
  effective_to                    DATE NULL,
  grace_minutes_override          INT UNSIGNED NULL,
  early_leave_grace_minutes_override INT UNSIGNED NULL,
  notes                           VARCHAR(500) NULL,
  created_at                      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_esa_employee_start (employee_id, effective_from),
  KEY idx_esa_employee (employee_id, effective_from),
  KEY idx_esa_shift (shift_id),
  CONSTRAINT fk_esa_employee FOREIGN KEY (employee_id)
    REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_esa_shift FOREIGN KEY (shift_id)
    REFERENCES shifts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_records (
  id                         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id                INT UNSIGNED NOT NULL,
  work_date                  DATE NOT NULL,
  clock_in                   DATETIME NULL,
  clock_out                  DATETIME NULL,
  shift_id                   INT UNSIGNED NULL,
  shift_name                 VARCHAR(120) NULL,
  scheduled_start            TIME NULL,
  scheduled_end              TIME NULL,
  expected_minutes           INT UNSIGNED NOT NULL DEFAULT 0,
  worked_minutes             INT UNSIGNED NULL,
  late_minutes               INT UNSIGNED NOT NULL DEFAULT 0,
  early_leave_minutes        INT UNSIGNED NOT NULL DEFAULT 0,
  overtime_minutes           INT UNSIGNED NOT NULL DEFAULT 0,
  grace_minutes              INT UNSIGNED NOT NULL DEFAULT 0,
  early_leave_grace_minutes  INT UNSIGNED NOT NULL DEFAULT 0,
  punctuality                ENUM('on_time','late','early_leave','late_early','incomplete','day_off','unscheduled') NOT NULL DEFAULT 'unscheduled',
  source                     ENUM('manual','import') NOT NULL DEFAULT 'manual',
  punch_count                INT UNSIGNED NOT NULL DEFAULT 0,
  notes                      VARCHAR(500) NULL,
  created_by                 INT UNSIGNED NULL,
  created_at                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_attendance_employee_date (employee_id, work_date),
  KEY idx_attendance_date (work_date),
  KEY idx_attendance_shift (shift_id),
  CONSTRAINT fk_attendance_employee FOREIGN KEY (employee_id)
    REFERENCES employees (id) ON DELETE CASCADE,
  CONSTRAINT fk_attendance_shift FOREIGN KEY (shift_id)
    REFERENCES shifts (id) ON DELETE SET NULL,
  CONSTRAINT fk_attendance_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_punches (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  attendance_record_id  INT UNSIGNED NOT NULL,
  punch_at              DATETIME NOT NULL,
  source                ENUM('manual','import') NOT NULL DEFAULT 'manual',
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_attendance_punches_record (attendance_record_id, punch_at),
  CONSTRAINT fk_attendance_punches_record FOREIGN KEY (attendance_record_id)
    REFERENCES attendance_records (id) ON DELETE CASCADE
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
  old_id        INT UNSIGNED NULL,
  name          VARCHAR(180) NOT NULL,
  category_id   INT UNSIGNED NULL,
  brand_id      INT UNSIGNED NULL,
  supplier_id   INT UNSIGNED NULL,
  ean13         VARCHAR(13) NULL,
  dun14         VARCHAR(14) NULL,
  plu           INT UNSIGNED NULL,
  units_per_pack   INT UNSIGNED NULL,
  packs_per_pallet INT UNSIGNED NULL,
  lead_time_days   INT UNSIGNED NOT NULL DEFAULT 0,
  min_order_qty    DECIMAL(14,3) NOT NULL DEFAULT 0,
  order_multiple   DECIMAL(14,3) NOT NULL DEFAULT 0,
  sold_by_weight   TINYINT(1) NOT NULL DEFAULT 0,
  weight_kg        DECIMAL(14,3) NOT NULL DEFAULT 0,
  type          ENUM('finished_good','for_sale','raw_material','consumable','service') NOT NULL DEFAULT 'finished_good',
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

-- ---------------------------------------------------------------------------
-- Material classes: a BOM requirement can point to a functional material
-- class instead of a single product. Class members are interchangeable
-- products with a priority and a conversion factor to the class unit.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS material_classes (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(30) NOT NULL,
  name        VARCHAR(150) NOT NULL,
  unit        VARCHAR(20) NOT NULL DEFAULT 'unit',
  allow_mix   TINYINT(1) NOT NULL DEFAULT 1,
  cost_method ENUM('priority','average','lowest','highest') NOT NULL DEFAULT 'priority',
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes       VARCHAR(500) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_material_classes_code (code),
  UNIQUE KEY uq_material_classes_name (name),
  KEY idx_material_classes_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS material_class_members (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  class_id          INT UNSIGNED NOT NULL,
  product_id        INT UNSIGNED NOT NULL,
  priority          INT NOT NULL DEFAULT 100,
  conversion_factor DECIMAL(18,6) NOT NULL DEFAULT 1,
  status            ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes             VARCHAR(255) NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_material_class_member (class_id, product_id),
  KEY idx_material_class_members_priority (class_id, priority),
  KEY idx_material_class_members_product (product_id),
  CONSTRAINT fk_material_class_members_class FOREIGN KEY (class_id)
    REFERENCES material_classes (id) ON DELETE CASCADE,
  CONSTRAINT fk_material_class_members_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
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
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  bom_id            INT UNSIGNED NOT NULL,
  component_id      INT UNSIGNED NULL,
  material_class_id INT UNSIGNED NULL,
  quantity          DECIMAL(14,3) NOT NULL DEFAULT 1,
  scrap_percent     DECIMAL(5,2) NOT NULL DEFAULT 0,
  sort_order        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bom_component (bom_id, component_id),
  UNIQUE KEY uq_bom_material_class (bom_id, material_class_id),
  KEY idx_bom_items_class (material_class_id),
  CONSTRAINT fk_bom_items_bom FOREIGN KEY (bom_id)
    REFERENCES boms (id) ON DELETE CASCADE,
  CONSTRAINT fk_bom_items_component FOREIGN KEY (component_id)
    REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_bom_items_class FOREIGN KEY (material_class_id)
    REFERENCES material_classes (id) ON DELETE RESTRICT,
  CONSTRAINT chk_bom_items_source CHECK (
    (component_id IS NULL) <> (material_class_id IS NULL)
  )
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

CREATE TABLE IF NOT EXISTS carriers (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_name  VARCHAR(120) NOT NULL,
  driver_name   VARCHAR(120) NULL,
  driver_id     VARCHAR(40) NULL,
  license_plate VARCHAR(20) NULL,
  phone         VARCHAR(40) NULL,
  email         VARCHAR(180) NULL,
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes         VARCHAR(500) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_carriers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Government-issued CAI authorizations for packing slips. Each authorization
-- covers a contiguous numeric range for one five-digit series/prefix.
CREATE TABLE IF NOT EXISTS cai_authorizations (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  cai_number  VARCHAR(60) NOT NULL,
  prefix      CHAR(5) NOT NULL,
  range_start INT UNSIGNED NOT NULL,
  range_end   INT UNSIGNED NOT NULL,
  next_number INT UNSIGNED NOT NULL,
  status      ENUM('active','exhausted','cancelled') NOT NULL DEFAULT 'active',
  notes       VARCHAR(500) NULL,
  created_by  INT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cai_authorizations_number (cai_number),
  KEY idx_cai_authorizations_status (status, created_at),
  KEY idx_cai_authorizations_range (prefix, range_start, range_end),
  CONSTRAINT fk_cai_authorizations_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS deliveries (
  id                    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_no           VARCHAR(30) NOT NULL,
  packing_slip_no       VARCHAR(14) NULL,
  cai_authorization_id  INT UNSIGNED NULL,
  cai_number            VARCHAR(60) NULL,
  cot                   VARCHAR(80) NULL,
  sales_order_id        INT UNSIGNED NULL,
  customer_id           INT UNSIGNED NOT NULL,
  delivery_date         DATE NOT NULL,
  carrier               VARCHAR(120) NULL,
  carrier_id            INT UNSIGNED NULL,
  carrier_driver_name   VARCHAR(120) NULL,
  carrier_driver_id     VARCHAR(40) NULL,
  carrier_license_plate VARCHAR(20) NULL,
  tracking_number       VARCHAR(120) NULL,
  status                ENUM('pending','shipped','delivered','cancelled') NOT NULL DEFAULT 'pending',
  stock_posted          TINYINT(1) NOT NULL DEFAULT 0,
  notes                 TEXT NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_deliveries_no (delivery_no),
  UNIQUE KEY uq_deliveries_packing_slip (packing_slip_no),
  KEY idx_deliveries_order (sales_order_id),
  KEY idx_deliveries_customer (customer_id),
  KEY idx_deliveries_status (status),
  KEY idx_deliveries_cai (cai_authorization_id),
  KEY idx_deliveries_carrier (carrier_id),
  CONSTRAINT fk_deliveries_order FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_deliveries_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_deliveries_cai FOREIGN KEY (cai_authorization_id)
    REFERENCES cai_authorizations (id) ON DELETE SET NULL,
  CONSTRAINT fk_deliveries_carrier FOREIGN KEY (carrier_id)
    REFERENCES carriers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS delivery_items (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id         INT UNSIGNED NOT NULL,
  sales_order_item_id INT UNSIGNED NULL,
  product_id          INT UNSIGNED NOT NULL,
  quantity            DECIMAL(14,3) NOT NULL DEFAULT 0,
  slip_pallets        DECIMAL(14,3) NOT NULL DEFAULT 0,
  slip_boxes          DECIMAL(14,3) NOT NULL DEFAULT 0,
  slip_units          DECIMAL(14,3) NOT NULL DEFAULT 0,
  slip_weight_kg      DECIMAL(14,3) NOT NULL DEFAULT 0,
  lot_number          VARCHAR(60) NULL,
  expiry_date         DATE NULL,
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
  document_type_code SMALLINT UNSIGNED NULL,
  cae            VARCHAR(14) NULL,
  cae_expiry_date DATE NULL,
  cbu            VARCHAR(22) NULL,
  transfer_option ENUM('ADC','SCA') NULL,
  payment_expiry_date DATE NULL,
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
  KEY idx_sales_invoices_fiscal_type (document_type_code),
  CONSTRAINT fk_sales_invoices_order FOREIGN KEY (sales_order_id)
    REFERENCES sales_orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_invoices_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_invoices_fiscal_type FOREIGN KEY (document_type_code)
    REFERENCES fiscal_document_types (code) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_invoice_deliveries (
  invoice_id  INT UNSIGNED NOT NULL,
  delivery_id INT UNSIGNED NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (invoice_id, delivery_id),
  KEY idx_sales_invoice_deliveries_delivery (delivery_id),
  CONSTRAINT fk_sales_invoice_deliveries_invoice FOREIGN KEY (invoice_id)
    REFERENCES sales_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_sales_invoice_deliveries_delivery FOREIGN KEY (delivery_id)
    REFERENCES deliveries (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_invoice_relations (
  note_id     INT UNSIGNED NOT NULL,
  invoice_id  INT UNSIGNED NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (note_id, invoice_id),
  KEY idx_sales_invoice_relations_invoice (invoice_id),
  CONSTRAINT fk_sales_invoice_relations_note FOREIGN KEY (note_id)
    REFERENCES sales_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_sales_invoice_relations_invoice FOREIGN KEY (invoice_id)
    REFERENCES sales_invoices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_invoice_imports (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id          INT UNSIGNED NULL,
  source              ENUM('pdf_qr','manual_qr') NOT NULL DEFAULT 'manual_qr',
  issuer_cuit         VARCHAR(20) NULL,
  receiver_doc_type   SMALLINT UNSIGNED NULL,
  receiver_doc_number VARCHAR(20) NULL,
  currency            CHAR(3) NULL,
  exchange_rate       DECIMAL(14,6) NULL,
  raw_payload         JSON NULL,
  qr_url              TEXT NULL,
  warnings            JSON NULL,
  pdf_filename        VARCHAR(255) NULL,
  pdf_sha256          CHAR(64) NULL,
  imported_by         INT UNSIGNED NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sales_invoice_imports_invoice (invoice_id),
  KEY idx_sales_invoice_imports_created (created_at),
  CONSTRAINT fk_sales_invoice_imports_invoice FOREIGN KEY (invoice_id)
    REFERENCES sales_invoices (id) ON DELETE SET NULL,
  CONSTRAINT fk_sales_invoice_imports_user FOREIGN KEY (imported_by)
    REFERENCES users (id) ON DELETE SET NULL
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
  document_type_code SMALLINT UNSIGNED NULL,
  packing_slip_no   VARCHAR(30) NULL,
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
  stock_skipped     TINYINT(1) NOT NULL DEFAULT 0,
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
  KEY idx_purchase_invoices_fiscal_type (document_type_code),
  CONSTRAINT fk_purchase_invoices_order FOREIGN KEY (purchase_order_id)
    REFERENCES purchase_orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_purchase_invoices_supplier FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_invoices_fiscal_type FOREIGN KEY (document_type_code)
    REFERENCES fiscal_document_types (code) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_invoice_relations (
  note_id     INT UNSIGNED NOT NULL,
  invoice_id  INT UNSIGNED NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (note_id, invoice_id),
  KEY idx_purchase_invoice_relations_invoice (invoice_id),
  CONSTRAINT fk_purchase_invoice_relations_note FOREIGN KEY (note_id)
    REFERENCES purchase_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_purchase_invoice_relations_invoice FOREIGN KEY (invoice_id)
    REFERENCES purchase_invoices (id) ON DELETE CASCADE
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

-- ---------------------------------------------------------------------------
-- Tax reporting configuration. The default jurisdiction supplies the IIBB and
-- municipal rates applied to gross sales; all jurisdictions can receive
-- perceptions and withholdings.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tax_jurisdictions (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(20) NOT NULL,
  name           VARCHAR(120) NOT NULL,
  sales_share    DECIMAL(5,2) NOT NULL DEFAULT 0,
  iibb_rate      DECIMAL(5,2) NOT NULL DEFAULT 0,
  municipal_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
  status         ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tax_jurisdictions_code (code),
  UNIQUE KEY uq_tax_jurisdictions_name (name),
  KEY idx_tax_jurisdictions_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Convenio Multilateral coefficients are agreed once per fiscal year. The
-- coefficient assigns a share of the total IIBB tax base (net sales without
-- VAT) to each jurisdiction. tax_jurisdictions.sales_share is the fallback
-- used when no coefficient has been stored for the report year.
CREATE TABLE IF NOT EXISTS tax_jurisdiction_coefficients (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  jurisdiction_id INT UNSIGNED NOT NULL,
  fiscal_year     SMALLINT UNSIGNED NOT NULL,
  coefficient     DECIMAL(5,2) NOT NULL DEFAULT 0,
  notes           VARCHAR(255) NULL,
  created_by      INT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tax_coefficient_jurisdiction_year (jurisdiction_id, fiscal_year),
  KEY idx_tax_coefficients_year (fiscal_year),
  CONSTRAINT fk_tax_coefficients_jurisdiction FOREIGN KEY (jurisdiction_id)
    REFERENCES tax_jurisdictions (id) ON DELETE CASCADE,
  CONSTRAINT fk_tax_coefficients_created_by FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Telegram bot: account links, one-time linking codes, polling state and an
-- audit trail of commands. The bot is read-only and only exposes production
-- information to linked active users.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS telegram_links (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED NOT NULL,
  telegram_user_id BIGINT NOT NULL,
  chat_id          BIGINT NOT NULL,
  username         VARCHAR(64) NULL,
  first_name       VARCHAR(120) NULL,
  last_name        VARCHAR(120) NULL,
  linked_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at     DATETIME NULL,
  revoked_at       DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_telegram_links_telegram_user (telegram_user_id),
  KEY idx_telegram_links_user (user_id),
  KEY idx_telegram_links_revoked (revoked_at),
  CONSTRAINT fk_telegram_links_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS telegram_link_codes (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  code       CHAR(8) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_telegram_link_codes_code (code),
  KEY idx_telegram_link_codes_user (user_id),
  KEY idx_telegram_link_codes_expiry (expires_at),
  CONSTRAINT fk_telegram_link_codes_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS telegram_bot_state (
  id             TINYINT UNSIGNED NOT NULL DEFAULT 1,
  last_update_id BIGINT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS telegram_audit_log (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  direction        ENUM('in','out') NOT NULL DEFAULT 'in',
  user_id          INT UNSIGNED NULL,
  telegram_user_id BIGINT NULL,
  chat_id          BIGINT NULL,
  command          VARCHAR(120) NULL,
  success          TINYINT(1) NOT NULL DEFAULT 1,
  response         VARCHAR(500) NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_telegram_audit_created (created_at),
  KEY idx_telegram_audit_user (user_id),
  CONSTRAINT fk_telegram_audit_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tax_settings (
  id                      TINYINT UNSIGNED NOT NULL DEFAULT 1,
  default_jurisdiction_id INT UNSIGNED NULL,
  updated_by              INT UNSIGNED NULL,
  updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_tax_settings_jurisdiction FOREIGN KEY (default_jurisdiction_id)
    REFERENCES tax_jurisdictions (id) ON DELETE SET NULL,
  CONSTRAINT fk_tax_settings_updated_by FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_invoice_perceptions (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_id      INT UNSIGNED NOT NULL,
  jurisdiction_id INT UNSIGNED NOT NULL,
  amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  reference       VARCHAR(120) NULL,
  notes           VARCHAR(255) NULL,
  created_by      INT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_purchase_invoice_perceptions_invoice (invoice_id),
  KEY idx_purchase_invoice_perceptions_jurisdiction (jurisdiction_id),
  CONSTRAINT fk_purchase_invoice_perceptions_invoice FOREIGN KEY (invoice_id)
    REFERENCES purchase_invoices (id) ON DELETE CASCADE,
  CONSTRAINT fk_purchase_invoice_perceptions_jurisdiction FOREIGN KEY (jurisdiction_id)
    REFERENCES tax_jurisdictions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_purchase_invoice_perceptions_created_by FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
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
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id      INT UNSIGNED NOT NULL,
  kind            ENUM('credit_note','debit_note','withholding') NOT NULL,
  tax_type        ENUM('none','iibb','income','other') NOT NULL DEFAULT 'none',
  jurisdiction_id INT UNSIGNED NULL,
  amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  reference       VARCHAR(120) NULL,
  notes           VARCHAR(255) NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_payment_adjustments_payment (payment_id),
  KEY idx_payment_adjustments_jurisdiction (jurisdiction_id),
  CONSTRAINT fk_payment_adjustments_payment FOREIGN KEY (payment_id)
    REFERENCES payments (id) ON DELETE CASCADE,
  CONSTRAINT fk_payment_adjustments_jurisdiction FOREIGN KEY (jurisdiction_id)
    REFERENCES tax_jurisdictions (id) ON DELETE SET NULL
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

-- Bank accounts for our own company and for customers/suppliers. The owner is
-- polymorphic because one table stores all three kinds of account.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_type     ENUM('company','customer','supplier') NOT NULL,
  owner_id       INT UNSIGNED NULL,
  bank_name      VARCHAR(120) NOT NULL,
  account_number VARCHAR(60) NULL,
  cbu            VARCHAR(22) NULL,
  alias          VARCHAR(60) NULL,
  notes          VARCHAR(500) NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bank_accounts_cbu (cbu),
  UNIQUE KEY uq_bank_accounts_alias (alias),
  KEY idx_bank_accounts_owner (owner_type, owner_id),
  KEY idx_bank_accounts_bank (bank_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Management finance: cost structure and profitability analysis.
-- These tables are a management-accounting layer, not a statutory ledger.
-- All analytical amounts are stored net of recoverable VAT.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cost_centers (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120) NOT NULL,
  code        VARCHAR(30) NULL,
  description VARCHAR(255) NULL,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cost_centers_name (name),
  KEY idx_cost_centers_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cost_categories (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cost_categories_name (name),
  KEY idx_cost_categories_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cost_items (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name              VARCHAR(180) NOT NULL,
  category_id       INT UNSIGNED NULL,
  cost_center_id    INT UNSIGNED NULL,
  behavior          ENUM('fixed','variable','semi_variable','stepped') NOT NULL DEFAULT 'fixed',
  amount            DECIMAL(14,2) NOT NULL DEFAULT 0,
  frequency         ENUM('monthly','quarterly','annual','one_off') NOT NULL DEFAULT 'monthly',
  driver_type       ENUM('unit','revenue_percent','material_percent','invoice','pallet','labor_hour') NULL,
  driver_rate       DECIMAL(14,4) NOT NULL DEFAULT 0,
  scope_type        ENUM('company','product','category') NOT NULL DEFAULT 'company',
  scope_product_id  INT UNSIGNED NULL,
  scope_category_id INT UNSIGNED NULL,
  amount_basis      ENUM('net','gross') NOT NULL DEFAULT 'net',
  vat_rate          DECIMAL(5,2) NOT NULL DEFAULT 0,
  vat_recoverable   TINYINT(1) NOT NULL DEFAULT 1,
  is_non_cash       TINYINT(1) NOT NULL DEFAULT 0,
  payment_days      INT NOT NULL DEFAULT 0,
  payment_day       TINYINT UNSIGNED NULL,
  effective_from    DATE NOT NULL,
  effective_to      DATE NULL,
  supplier_id       INT UNSIGNED NULL,
  notes             TEXT NULL,
  status            ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by        INT UNSIGNED NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cost_items_category (category_id),
  KEY idx_cost_items_center (cost_center_id),
  KEY idx_cost_items_behavior (behavior),
  KEY idx_cost_items_status (status),
  KEY idx_cost_items_effective (effective_from, effective_to),
  KEY idx_cost_items_scope_product (scope_product_id),
  KEY idx_cost_items_scope_category (scope_category_id),
  CONSTRAINT fk_cost_items_category FOREIGN KEY (category_id)
    REFERENCES cost_categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_cost_items_center FOREIGN KEY (cost_center_id)
    REFERENCES cost_centers (id) ON DELETE SET NULL,
  CONSTRAINT fk_cost_items_scope_product FOREIGN KEY (scope_product_id)
    REFERENCES products (id) ON DELETE SET NULL,
  CONSTRAINT fk_cost_items_scope_category FOREIGN KEY (scope_category_id)
    REFERENCES product_categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_cost_items_supplier FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE SET NULL,
  CONSTRAINT fk_cost_items_created_by FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cost_actuals (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  cost_item_id INT UNSIGNED NOT NULL,
  period       CHAR(7) NOT NULL,
  amount       DECIMAL(14,2) NOT NULL DEFAULT 0,
  source       ENUM('manual','import','invoice') NOT NULL DEFAULT 'manual',
  notes        VARCHAR(500) NULL,
  created_by   INT UNSIGNED NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cost_actuals_item_period (cost_item_id, period),
  KEY idx_cost_actuals_period (period),
  CONSTRAINT fk_cost_actuals_item FOREIGN KEY (cost_item_id)
    REFERENCES cost_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_cost_actuals_created_by FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS planning_scenarios (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(180) NOT NULL,
  description    VARCHAR(500) NULL,
  start_period   CHAR(7) NOT NULL,
  horizon_months TINYINT UNSIGNED NOT NULL DEFAULT 6,
  status         ENUM('draft','active','locked','archived') NOT NULL DEFAULT 'draft',
  assumptions    JSON NULL,
  created_by     INT UNSIGNED NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_planning_scenarios_status (status),
  KEY idx_planning_scenarios_start (start_period),
  CONSTRAINT fk_planning_scenarios_created_by FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS scenario_sales_lines (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scenario_id  INT UNSIGNED NOT NULL,
  product_id   INT UNSIGNED NOT NULL,
  customer_id  INT UNSIGNED NULL,
  period       CHAR(7) NOT NULL,
  quantity     DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit_price   DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_scenario_sales_lines_scenario (scenario_id, period),
  KEY idx_scenario_sales_lines_product (product_id),
  KEY idx_scenario_sales_lines_customer (customer_id),
  CONSTRAINT fk_scenario_sales_lines_scenario FOREIGN KEY (scenario_id)
    REFERENCES planning_scenarios (id) ON DELETE CASCADE,
  CONSTRAINT fk_scenario_sales_lines_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_scenario_sales_lines_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS scenario_cost_overrides (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scenario_id  INT UNSIGNED NOT NULL,
  cost_item_id INT UNSIGNED NOT NULL,
  amount       DECIMAL(14,2) NULL,
  driver_rate  DECIMAL(14,4) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_scenario_cost_override (scenario_id, cost_item_id),
  CONSTRAINT fk_scenario_cost_overrides_scenario FOREIGN KEY (scenario_id)
    REFERENCES planning_scenarios (id) ON DELETE CASCADE,
  CONSTRAINT fk_scenario_cost_overrides_item FOREIGN KEY (cost_item_id)
    REFERENCES cost_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Cash flow: company cash accounts, planned movements and actual snapshots.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cash_accounts (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(120) NOT NULL,
  type            ENUM('bank','cash','card','other') NOT NULL DEFAULT 'bank',
  bank_name       VARCHAR(120) NULL,
  account_number  VARCHAR(60) NULL,
  currency        VARCHAR(3) NOT NULL DEFAULT 'USD',
  opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
  opening_date    DATE NULL,
  status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes           VARCHAR(500) NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_accounts_name (name),
  KEY idx_cash_accounts_status (status),
  KEY idx_cash_accounts_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_events (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(180) NOT NULL,
  direction   ENUM('inflow','outflow') NOT NULL,
  category    ENUM('sales','purchases','payroll','tax','loan','capex','variable_cost','other_income','other')
              NOT NULL DEFAULT 'other',
  amount      DECIMAL(14,2) NOT NULL DEFAULT 0,
  event_date  DATE NOT NULL,
  recurrence  ENUM('one_off','monthly','quarterly','annual') NOT NULL DEFAULT 'one_off',
  end_date    DATE NULL,
  account_id  INT UNSIGNED NULL,
  status      ENUM('planned','actual') NOT NULL DEFAULT 'planned',
  notes       VARCHAR(500) NULL,
  created_by  INT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cash_events_date (event_date),
  KEY idx_cash_events_direction (direction),
  KEY idx_cash_events_status (status),
  KEY idx_cash_events_category (category),
  CONSTRAINT fk_cash_events_account FOREIGN KEY (account_id)
    REFERENCES cash_accounts (id) ON DELETE SET NULL,
  CONSTRAINT fk_cash_events_created_by FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_snapshots (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id    INT UNSIGNED NOT NULL,
  snapshot_date DATE NOT NULL,
  balance       DECIMAL(14,2) NOT NULL DEFAULT 0,
  notes         VARCHAR(500) NULL,
  created_by    INT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cash_snapshots_account_date (account_id, snapshot_date),
  KEY idx_cash_snapshots_date (snapshot_date),
  CONSTRAINT fk_cash_snapshots_account FOREIGN KEY (account_id)
    REFERENCES cash_accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_cash_snapshots_created_by FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_flow_settings (
  id                        TINYINT UNSIGNED NOT NULL DEFAULT 1,
  minimum_cash_buffer       DECIMAL(14,2) NOT NULL DEFAULT 0,
  collection_rate_current   DECIMAL(5,2) NOT NULL DEFAULT 100,
  collection_rate_1_30      DECIMAL(5,2) NOT NULL DEFAULT 90,
  collection_rate_31_60     DECIMAL(5,2) NOT NULL DEFAULT 75,
  collection_rate_61_90     DECIMAL(5,2) NOT NULL DEFAULT 50,
  collection_rate_90_plus   DECIMAL(5,2) NOT NULL DEFAULT 25,
  collection_delay_current  INT UNSIGNED NOT NULL DEFAULT 0,
  collection_delay_1_30     INT UNSIGNED NOT NULL DEFAULT 15,
  collection_delay_31_60    INT UNSIGNED NOT NULL DEFAULT 30,
  collection_delay_61_90    INT UNSIGNED NOT NULL DEFAULT 45,
  collection_delay_90_plus  INT UNSIGNED NOT NULL DEFAULT 60,
  payment_delay_days        INT UNSIGNED NOT NULL DEFAULT 0,
  week_start_day            TINYINT UNSIGNED NOT NULL DEFAULT 1,
  updated_by                INT UNSIGNED NULL,
  updated_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_cash_flow_settings_updated_by FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_orders (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  production_no  VARCHAR(30) NOT NULL,
  sales_order_id INT UNSIGNED NULL,
  -- Legacy single-BOM columns kept nullable for older databases. New orders
  -- store their output products and batches in production_order_lines.
  bom_id         INT UNSIGNED NULL,
  product_id     INT UNSIGNED NULL,
  lot_number     VARCHAR(60) NULL,
  expiry_date    DATE NULL,
  quantity       DECIMAL(14,3) NULL,
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

CREATE TABLE IF NOT EXISTS production_order_lines (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  production_order_id INT UNSIGNED NOT NULL,
  bom_id             INT UNSIGNED NOT NULL,
  product_id         INT UNSIGNED NOT NULL,
  quantity           DECIMAL(14,3) NOT NULL DEFAULT 0,
  lot_number         VARCHAR(60) NULL,
  expiry_date        DATE NULL,
  notes              TEXT NULL,
  sort_order         INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_order_lines_bom (production_order_id, bom_id),
  KEY idx_production_order_lines_order (production_order_id),
  KEY idx_production_order_lines_product (product_id),
  CONSTRAINT fk_production_order_lines_order FOREIGN KEY (production_order_id)
    REFERENCES production_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_production_order_lines_bom FOREIGN KEY (bom_id)
    REFERENCES boms (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_order_lines_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_order_requirements (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  production_order_id INT UNSIGNED NOT NULL,
  material_class_id   INT UNSIGNED NULL,
  component_id        INT UNSIGNED NULL,
  unit                VARCHAR(20) NOT NULL DEFAULT 'unit',
  quantity_required   DECIMAL(14,3) NOT NULL DEFAULT 0,
  quantity_allocated  DECIMAL(14,3) NOT NULL DEFAULT 0,
  quantity_consumed   DECIMAL(14,3) NOT NULL DEFAULT 0,
  shortage_qty        DECIMAL(14,3) NOT NULL DEFAULT 0,
  source_count        INT UNSIGNED NOT NULL DEFAULT 1,
  sort_order          INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_por_class (production_order_id, material_class_id),
  UNIQUE KEY uq_por_component (production_order_id, component_id),
  KEY idx_por_order (production_order_id),
  KEY idx_por_class (material_class_id),
  CONSTRAINT fk_por_order FOREIGN KEY (production_order_id)
    REFERENCES production_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_por_class FOREIGN KEY (material_class_id)
    REFERENCES material_classes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_por_component FOREIGN KEY (component_id)
    REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT chk_por_source CHECK (
    (material_class_id IS NULL) <> (component_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_order_materials (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  production_order_id INT UNSIGNED NOT NULL,
  requirement_id    INT UNSIGNED NULL,
  material_class_id INT UNSIGNED NULL,
  component_id      INT UNSIGNED NOT NULL,
  quantity_required DECIMAL(14,3) NOT NULL DEFAULT 0,
  quantity_consumed DECIMAL(14,3) NOT NULL DEFAULT 0,
  source_count      INT UNSIGNED NOT NULL DEFAULT 1,
  priority          INT NOT NULL DEFAULT 0,
  conversion_factor DECIMAL(18,6) NOT NULL DEFAULT 1,
  unit_cost         DECIMAL(14,2) NOT NULL DEFAULT 0,
  is_substitute     TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_pom_order (production_order_id),
  KEY idx_pom_requirement (requirement_id),
  KEY idx_pom_class (material_class_id),
  CONSTRAINT fk_pom_order FOREIGN KEY (production_order_id)
    REFERENCES production_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_pom_requirement FOREIGN KEY (requirement_id)
    REFERENCES production_order_requirements (id) ON DELETE CASCADE,
  CONSTRAINT fk_pom_class FOREIGN KEY (material_class_id)
    REFERENCES material_classes (id) ON DELETE SET NULL,
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
