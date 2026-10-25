'use strict';

/**
 * Creates the database (if needed) and applies schema.sql.
 * Usage: npm run db:migrate
 */
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const config = require('../config');
const { baseOptions } = require('./index');
const { createSshTunnel } = require('./tunnel');

function assertSafeIdentifier(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database name: ${name}`);
  }
}

async function columnExists(conn, dbName, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [dbName, table, column],
  );
  return rows.length > 0;
}

async function addColumn(conn, dbName, table, column, definition) {
  if (await columnExists(conn, dbName, table, column)) return false;
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  console.log(`[migrate] added column ${table}.${column}`);
  return true;
}

async function makeNullable(conn, dbName, table, column, definition) {
  const [rows] = await conn.query(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [dbName, table, column],
  );
  if (!rows.length || rows[0].IS_NULLABLE === 'YES') return false;
  await conn.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
  console.log(`[migrate] made ${table}.${column} nullable`);
  return true;
}

async function indexExists(conn, dbName, table, indexName) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [dbName, table, indexName],
  );
  return rows.length > 0;
}

async function addIndex(conn, dbName, table, indexName, definition) {
  if (await indexExists(conn, dbName, table, indexName)) return false;
  await conn.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
  console.log(`[migrate] added index ${table}.${indexName}`);
  return true;
}

async function constraintExists(conn, dbName, table, constraintName) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`,
    [dbName, table, constraintName],
  );
  return rows.length > 0;
}

async function addConstraint(conn, dbName, table, constraintName, definition) {
  if (await constraintExists(conn, dbName, table, constraintName)) return false;
  await conn.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraintName}\` ${definition}`);
  console.log(`[migrate] added constraint ${table}.${constraintName}`);
  return true;
}

/**
 * Adds the columns/tables introduced after the initial release to databases
 * that already exist. schema.sql handles fresh installs; these ALTERs keep
 * upgrades idempotent because MySQL does not support ADD COLUMN IF NOT EXISTS.
 */
async function upgradeSchema(conn, dbName) {
  await addColumn(conn, dbName, 'suppliers', 'default_vat_rate', 'DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER payment_terms');
  await addColumn(conn, dbName, 'suppliers', 'default_levy_rate', 'DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER default_vat_rate');

  await addColumn(conn, dbName, 'products', 'brand_id', 'INT UNSIGNED NULL AFTER category_id');
  await addColumn(conn, dbName, 'products', 'supplier_id', 'INT UNSIGNED NULL AFTER brand_id');
  await addColumn(conn, dbName, 'products', 'ean13', 'VARCHAR(13) NULL AFTER supplier_id');
  await addColumn(conn, dbName, 'products', 'dun14', 'VARCHAR(14) NULL AFTER ean13');
  await addColumn(conn, dbName, 'products', 'plu', 'INT UNSIGNED NULL AFTER dun14');
  await addColumn(conn, dbName, 'products', 'units_per_pack', 'INT UNSIGNED NULL AFTER plu');
  await addColumn(conn, dbName, 'products', 'packs_per_pallet', 'INT UNSIGNED NULL AFTER units_per_pack');
  await addColumn(conn, dbName, 'products', 'sold_by_weight', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER packs_per_pallet');
  await addColumn(conn, dbName, 'products', 'weight_kg', 'DECIMAL(14,3) NOT NULL DEFAULT 0 AFTER sold_by_weight');
  const addedCostGross = await addColumn(conn, dbName, 'products', 'cost_gross_price', 'DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER unit');
  await addColumn(conn, dbName, 'products', 'cost_vat_rate', 'DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER cost_gross_price');
  await addColumn(conn, dbName, 'products', 'cost_levy_rate', 'DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER cost_vat_rate');
  const addedSaleGross = await addColumn(conn, dbName, 'products', 'sale_gross_price', 'DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER cost_price');
  await addColumn(conn, dbName, 'products', 'sale_vat_rate', 'DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER sale_gross_price');

  // Existing products stored their final price in cost_price/sale_price. Make
  // those the gross amount once, so the first edit does not reset the price.
  if (addedCostGross) {
    await conn.query('UPDATE products SET cost_gross_price = cost_price WHERE cost_price <> 0');
  }
  if (addedSaleGross) {
    await conn.query('UPDATE products SET sale_gross_price = sale_price WHERE sale_price <> 0');
  }

  await addIndex(conn, dbName, 'products', 'uq_products_ean13', 'UNIQUE KEY `uq_products_ean13` (`ean13`)');
  await addIndex(conn, dbName, 'products', 'uq_products_dun14', 'UNIQUE KEY `uq_products_dun14` (`dun14`)');
  await addIndex(conn, dbName, 'products', 'uq_products_plu', 'UNIQUE KEY `uq_products_plu` (`plu`)');
  await addIndex(conn, dbName, 'products', 'idx_products_brand', 'KEY `idx_products_brand` (`brand_id`)');
  await addIndex(conn, dbName, 'products', 'idx_products_supplier', 'KEY `idx_products_supplier` (`supplier_id`)');
  await addConstraint(conn, dbName, 'products', 'fk_products_brand',
    'FOREIGN KEY (`brand_id`) REFERENCES `brands` (`id`) ON DELETE SET NULL');
  await addConstraint(conn, dbName, 'products', 'fk_products_supplier',
    'FOREIGN KEY (`supplier_id`) REFERENCES `suppliers` (`id`) ON DELETE SET NULL');

  // ------------------------------------------------ customer warehouses/orders
  await addColumn(conn, dbName, 'sales_orders', 'customer_order_no', 'VARCHAR(60) NULL AFTER customer_id');
  await addColumn(conn, dbName, 'sales_orders', 'customer_warehouse_id', 'INT UNSIGNED NULL AFTER customer_order_no');
  await addColumn(conn, dbName, 'sales_orders', 'docking_station', 'VARCHAR(60) NULL AFTER expected_date');
  await addColumn(conn, dbName, 'sales_orders', 'reception_at', 'DATETIME NULL AFTER docking_station');
  await addIndex(conn, dbName, 'sales_orders', 'idx_sales_orders_warehouse', 'KEY `idx_sales_orders_warehouse` (`customer_warehouse_id`)');
  await addConstraint(conn, dbName, 'sales_orders', 'fk_sales_orders_warehouse',
    'FOREIGN KEY (`customer_warehouse_id`) REFERENCES `customer_warehouses` (`id`) ON DELETE RESTRICT');

  // Existing customers received their goods somewhere. Give every customer a
  // default warehouse and attach orders that predate this feature, so older
  // records remain printable and every order has a destination.
  await conn.query(
    `INSERT INTO customer_warehouses
       (customer_id, code, name, contact_name, email, phone,
        address_line1, address_line2, city, state, postal_code, country)
     SELECT c.id, 'MAIN', 'Main warehouse', c.contact_name, c.email, c.phone,
            c.address_line1, c.address_line2, c.city, c.state, c.postal_code, c.country
       FROM customers c
       LEFT JOIN customer_warehouses w ON w.customer_id = c.id
      WHERE w.id IS NULL`,
  );
  await conn.query(
    `UPDATE sales_orders so
        SET so.customer_warehouse_id = (
          SELECT MIN(w.id) FROM customer_warehouses w WHERE w.customer_id = so.customer_id
        )
      WHERE so.customer_warehouse_id IS NULL`,
  );

  // ------------------------------------------------- production batch details
  await addColumn(conn, dbName, 'production_orders', 'lot_number', 'VARCHAR(60) NULL AFTER product_id');
  await addColumn(conn, dbName, 'production_orders', 'expiry_date', 'DATE NULL AFTER lot_number');
  await addIndex(conn, dbName, 'production_orders', 'idx_production_orders_expiry', 'KEY `idx_production_orders_expiry` (`expiry_date`)');

  // ---------------------------------------------------- multi-BOM production
  await makeNullable(conn, dbName, 'production_orders', 'bom_id', 'INT UNSIGNED NULL');
  await makeNullable(conn, dbName, 'production_orders', 'product_id', 'INT UNSIGNED NULL');
  await makeNullable(conn, dbName, 'production_orders', 'quantity', 'DECIMAL(14,3) NULL');
  await addColumn(conn, dbName, 'production_order_materials', 'source_count', 'INT UNSIGNED NOT NULL DEFAULT 1 AFTER quantity_consumed');
  await conn.query(
    `INSERT INTO production_order_lines
       (production_order_id, bom_id, product_id, quantity, lot_number, expiry_date, notes, sort_order)
     SELECT po.id, po.bom_id, po.product_id, po.quantity, po.lot_number, po.expiry_date, NULL, 0
       FROM production_orders po
      WHERE po.bom_id IS NOT NULL
        AND po.product_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM production_order_lines l WHERE l.production_order_id = po.id
        )`,
  );

  // ------------------------------------------------- packing slips and CAI
  await addColumn(conn, dbName, 'deliveries', 'packing_slip_no', 'VARCHAR(14) NULL AFTER delivery_no');
  await addColumn(conn, dbName, 'deliveries', 'cai_authorization_id', 'INT UNSIGNED NULL AFTER packing_slip_no');
  await addColumn(conn, dbName, 'deliveries', 'cai_number', 'VARCHAR(60) NULL AFTER cai_authorization_id');
  await addColumn(conn, dbName, 'deliveries', 'cot', 'VARCHAR(80) NULL AFTER cai_number');
  await addIndex(conn, dbName, 'deliveries', 'uq_deliveries_packing_slip', 'UNIQUE KEY `uq_deliveries_packing_slip` (`packing_slip_no`)');
  await addIndex(conn, dbName, 'deliveries', 'idx_deliveries_cai', 'KEY `idx_deliveries_cai` (`cai_authorization_id`)');
  await addConstraint(conn, dbName, 'deliveries', 'fk_deliveries_cai',
    'FOREIGN KEY (`cai_authorization_id`) REFERENCES `cai_authorizations` (`id`) ON DELETE SET NULL');
  await addColumn(conn, dbName, 'deliveries', 'carrier_id', 'INT UNSIGNED NULL AFTER carrier');
  await addColumn(conn, dbName, 'deliveries', 'carrier_driver_name', 'VARCHAR(120) NULL AFTER carrier_id');
  await addColumn(conn, dbName, 'deliveries', 'carrier_driver_id', 'VARCHAR(40) NULL AFTER carrier_driver_name');
  await addColumn(conn, dbName, 'deliveries', 'carrier_license_plate', 'VARCHAR(20) NULL AFTER carrier_driver_id');
  await addIndex(conn, dbName, 'deliveries', 'idx_deliveries_carrier', 'KEY `idx_deliveries_carrier` (`carrier_id`)');
  await addConstraint(conn, dbName, 'deliveries', 'fk_deliveries_carrier',
    'FOREIGN KEY (`carrier_id`) REFERENCES `carriers` (`id`) ON DELETE SET NULL');

  // --------------------------------------------------- packing slip breakdown
  await addColumn(conn, dbName, 'delivery_items', 'slip_pallets', 'DECIMAL(14,3) NOT NULL DEFAULT 0 AFTER quantity');
  await addColumn(conn, dbName, 'delivery_items', 'slip_boxes', 'DECIMAL(14,3) NOT NULL DEFAULT 0 AFTER slip_pallets');
  const addedSlipUnits = await addColumn(conn, dbName, 'delivery_items', 'slip_units', 'DECIMAL(14,3) NOT NULL DEFAULT 0 AFTER slip_boxes');
  await addColumn(conn, dbName, 'delivery_items', 'slip_weight_kg', 'DECIMAL(14,3) NOT NULL DEFAULT 0 AFTER slip_units');
  if (addedSlipUnits) {
    await conn.query(
      `UPDATE delivery_items di
         JOIN products p ON p.id = di.product_id
          SET di.slip_units = di.quantity,
              di.slip_boxes = CASE
                WHEN p.units_per_pack > 0 THEN ROUND(di.quantity / p.units_per_pack, 3)
                ELSE 0
              END,
              di.slip_pallets = CASE
                WHEN p.units_per_pack > 0 AND p.packs_per_pallet > 0
                  THEN ROUND(di.quantity / p.units_per_pack / p.packs_per_pallet, 3)
                ELSE 0
              END,
              di.slip_weight_kg = ROUND(di.quantity * COALESCE(p.weight_kg, 0), 3)`,
    );
    console.log('[migrate] backfilled packing slip quantities');
  }
}

async function main() {
  const dbName = config.db.database;
  assertSafeIdentifier(dbName);

  let tunnel = null;
  let host = config.db.host;
  let port = config.db.port;

  if (config.db.ssh.enabled) {
    tunnel = await createSshTunnel({
      host: config.db.ssh.host,
      port: config.db.ssh.port,
      user: config.db.ssh.user,
      password: config.db.ssh.password,
      privateKey: config.db.ssh.privateKey,
      passphrase: config.db.ssh.passphrase,
      remoteHost: config.db.ssh.remoteHost,
      remotePort: config.db.ssh.remotePort,
    });
    host = tunnel.host;
    port = tunnel.port;
  }

  let conn;
  try {
    conn = await mysql.createConnection(
      baseOptions({ host, port, database: undefined, multipleStatements: true }),
    );

    console.log(`[migrate] connected to MySQL at ${host}:${port}`);
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await conn.query(`USE \`${dbName}\``);

    const schemaPath = path.join(__dirname, 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await conn.query(sql);
    console.log(`[migrate] schema applied to "${dbName}"`);

    await upgradeSchema(conn, dbName);

    const [tables] = await conn.query('SHOW TABLES');
    console.log(`[migrate] ${tables.length} tables ready`);
  } finally {
    if (conn) await conn.end().catch(() => {});
    if (tunnel) await tunnel.close();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exitCode = 1;
});
