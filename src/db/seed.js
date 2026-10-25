'use strict';

/**
 * Seeds a realistic demo data set (manufacturer of LED light fixtures).
 * Usage: npm run db:seed        (skips when data already exists)
 *        FORCE_SEED=1 npm run db:seed
 */
const bcrypt = require('bcryptjs');
const { initDb, withTransaction, closeDb } = require('./index');
const { nextNumber } = require('../lib/sequences');
const { createCheckForPayment, recordHistory, statusEvent } = require('../lib/checks');
const { lotFromDate } = require('../lib/helpers');
const { formatPackingSlipNo } = require('../lib/packingSlips');
const { seedPosDemo } = require('./posSeed');

const FORCE = process.env.FORCE_SEED === '1';
const PASSWORD = 'Admin123!';

// Small deterministic PRNG so the demo data is stable between runs.
function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261022);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (min, max) => min + rand() * (max - min);
const round2 = (n) => Math.round(n * 100) / 100;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

async function insert(conn, table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys
    .map(() => '?')
    .join(', ')})`;
  const [res] = await conn.query(sql, keys.map((k) => data[k]));
  return res.insertId;
}

function totals(items, discount = 0) {
  const subtotal = round2(items.reduce((s, i) => s + i.quantity * i.unit_price, 0));
  const tax_total = round2(
    items.reduce((s, i) => {
      const line = i.quantity * i.unit_price;
      return s + (i.tax_rate > 0 ? line * (i.tax_rate / (100 + i.tax_rate)) : 0);
    }, 0),
  );
  const total = round2(subtotal - discount);
  return { subtotal, tax_total, total, discount_total: round2(discount) };
}

async function main() {
  await initDb();

  await withTransaction(async (conn) => {
    const [[{ count }]] = await conn.query('SELECT COUNT(*) AS count FROM customers');
    if (count > 0 && !FORCE) {
      console.log(`[seed] database already contains ${count} customers – skipping. Use FORCE_SEED=1 to add demo data anyway.`);
      return;
    }

    const passwordHash = bcrypt.hashSync(PASSWORD, 10);

    // ---------------------------------------------------------------- users
    const adminId = await insert(conn, 'users', {
      name: 'Alex Morgan', email: 'admin@werp.local', password_hash: passwordHash, role: 'admin',
    });
    await insert(conn, 'users', {
      name: 'Priya Shah', email: 'manager@werp.local', password_hash: passwordHash, role: 'manager',
    });
    await insert(conn, 'users', {
      name: 'Tom Becker', email: 'staff@werp.local', password_hash: passwordHash, role: 'staff',
    });

    // ------------------------------------------------------------- settings
    const settings = {
      company_name: 'Aurora Lighting Works',
      company_email: 'hello@auroralighting.example',
      company_phone: '+1 (415) 555-0138',
      company_address: '2450 Foundry Lane, Unit 12\nOakland, CA 94607\nUnited States',
      company_tax_id: 'US-94-7281556',
      currency: 'USD',
      default_tax_rate: '8.25',
      invoice_footer: 'Thank you for your business. Payment is due within the agreed terms.',
      fiscal_year_start: '01-01',
    };
    for (const [skey, svalue] of Object.entries(settings)) {
      await insert(conn, 'settings', { skey, svalue });
    }

    // ----------------------------------------------------------- categories
    const catNames = [
      ['LED Fixtures', 'Finished lighting products'],
      ['Electrical', 'Drivers, LED modules and cabling'],
      ['Metalwork', 'Extrusions, housings and diffusers'],
      ['Packaging', 'Cartons and protective packaging'],
      ['Services', 'Installation and design services'],
    ];
    const cats = {};
    for (const [name, description] of catNames) {
      cats[name] = await insert(conn, 'product_categories', { name, description });
    }

    // --------------------------------------------------------------- brands
    const brandDefs = [
      ['Aurora Lighting', 'Aurora’s own architectural lighting collection', 'https://auroralighting.example'],
      ['Lumen Select', 'Value-focused retail lighting range', 'https://lumenselect.example'],
      ['Voltway Components', 'Drivers, LED modules and electronic components', 'https://voltway.example'],
      ['Northstar Industrial', 'Metalwork, diffusers and packaging supplies', 'https://northstar.example'],
      ['Unbranded', 'Products without a retail brand', null],
    ];
    const brands = {};
    for (const [name, description, website] of brandDefs) {
      brands[name] = await insert(conn, 'brands', { name, description, website, status: 'active' });
    }

    // ------------------------------------------------------------ suppliers
    const supplierDefs = [
      ['Pacific Aluminium Supply', 'Greg Sandoval', 'Long Beach, CA', 8.25, 1.5],
      ['Lumen Components Inc.', 'Yuki Tanaka', 'Irvine, CA', 8.25, 0.75],
      ['Voltway Electronics', 'Brian O\'Neill', 'Shenzhen, CN', 6.5, 2.25],
      ['ClearView Diffusers', 'Hannah Berg', 'Tacoma, WA', 8.25, 1],
      ['Precision Fasteners Co.', 'Miles Foster', 'Cleveland, OH', 8.25, 0.5],
      ['Greenline Packaging', 'Zoe Martin', 'Portland, OR', 8.25, 1.25],
      ['CircuitWorks Assembly', 'Ivan Costa', 'Guadalajara, MX', 7.5, 2],
      ['Northstar Cabling', 'Rosa Delgado', 'Sacramento, CA', 8.25, 0.85],
      ['Summit Logistics', 'Kenji Mori', 'Oakland, CA', 8.25, 3],
      ['Brightline Tools', 'Alicia Wren', 'Phoenix, AZ', 8.25, 1.1],
    ];
    const suppliers = [];
    let snum = 1;
    for (const [name, contact, cityState, vatRate, levyRate] of supplierDefs) {
      const [city, state] = cityState.split(', ');
      const id = await insert(conn, 'suppliers', {
        supplier_no: `SUP-${String(snum++).padStart(5, '0')}`,
        company_name: name,
        contact_name: contact,
        email: `orders@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
        phone: `+1 (${Math.floor(between(200, 989))}) 555-${String(Math.floor(between(1000, 9999)))}`,
        address_line1: `${Math.floor(between(100, 9800))} ${pick(['Commerce Dr', 'Factory Rd', 'Logistics Pkwy'])}`,
        city,
        state,
        country: state === 'CN' ? 'China' : state === 'MX' ? 'Mexico' : 'United States',
        payment_terms: pick(['Net 30', 'Net 45', 'Net 60']),
        default_vat_rate: vatRate,
        default_levy_rate: levyRate,
        status: 'active',
      });
      suppliers.push({ id, name, vat: vatRate, levy: levyRate });
    }
    const supplierByName = Object.fromEntries(suppliers.map((s) => [s.name, s]));

    // ------------------------------------------------------------- products
    const productDefs = [
      {
        sku: 'AUR-P100', name: 'Aurora Pendant 100', cat: 'LED Fixtures', type: 'finished_good', unit: 'pcs',
        costNet: 38.5, saleNet: 129.0, stock: 24, reorder: 10, sellable: 1, purchasable: 0, manufactured: 1, track: 1,
        brand: 'Aurora Lighting', supplier: null, ean13: '0841234500017', dun14: '10841234500014', plu: 4101,
        unitsPerPack: 1, packsPerPallet: 48, weighted: 0,
      },
      {
        sku: 'AUR-L200', name: 'Aurora Linear 200', cat: 'LED Fixtures', type: 'finished_good', unit: 'pcs',
        costNet: 62.0, saleNet: 219.0, stock: 12, reorder: 8, sellable: 1, purchasable: 0, manufactured: 1, track: 1,
        brand: 'Aurora Lighting', supplier: null, ean13: '0841234500024', dun14: '10841234500021', plu: 4102,
        unitsPerPack: 1, packsPerPallet: 24, weighted: 0,
      },
      {
        sku: 'AUR-D50', name: 'Aurora Desk Lamp 50', cat: 'LED Fixtures', type: 'finished_good', unit: 'pcs',
        costNet: 21.0, saleNet: 79.0, stock: 41, reorder: 15, sellable: 1, purchasable: 0, manufactured: 1, track: 1,
        brand: 'Lumen Select', supplier: null, ean13: '0841234500031', dun14: '10841234500038', plu: 4103,
        unitsPerPack: 2, packsPerPallet: 60, weighted: 0,
      },
      {
        sku: 'AUR-S300', name: 'Aurora Spot 300', cat: 'LED Fixtures', type: 'finished_good', unit: 'pcs',
        costNet: 28.75, saleNet: 99.0, stock: 6, reorder: 10, sellable: 1, purchasable: 0, manufactured: 1, track: 1,
        brand: 'Aurora Lighting', supplier: null, ean13: '0841234500048', dun14: '10841234500045', plu: 4104,
        unitsPerPack: 1, packsPerPallet: 40, weighted: 0,
      },
      {
        sku: 'AL-6061', name: 'Aluminium Extrusion 2m', cat: 'Metalwork', type: 'raw_material', unit: 'pcs',
        costNet: 8.4, saleNet: 0, stock: 320, reorder: 100, sellable: 0, purchasable: 1, manufactured: 0, track: 1,
        brand: 'Northstar Industrial', supplier: 'Pacific Aluminium Supply', ean13: '0841234500055', dun14: '10841234500052',
        unitsPerPack: 1, packsPerPallet: 100, weighted: 0,
      },
      {
        sku: 'LED-2835', name: 'LED Strip 5m 3000K', cat: 'Electrical', type: 'raw_material', unit: 'roll',
        costNet: 6.2, saleNet: 0, stock: 210, reorder: 80, sellable: 0, purchasable: 1, manufactured: 0, track: 1,
        brand: 'Voltway Components', supplier: 'Voltway Electronics', ean13: '0841234500062', dun14: '10841234500069',
        unitsPerPack: 5, packsPerPallet: 120, weighted: 0,
      },
      {
        sku: 'PSU-24V', name: '24V LED Driver 60W', cat: 'Electrical', type: 'raw_material', unit: 'pcs',
        costNet: 11.8, saleNet: 0, stock: 47, reorder: 50, sellable: 0, purchasable: 1, manufactured: 0, track: 1,
        brand: 'Voltway Components', supplier: 'Voltway Electronics', ean13: '0841234500079', dun14: '10841234500076',
        unitsPerPack: 1, packsPerPallet: 80, weighted: 0,
      },
      {
        sku: 'DIF-OPAL', name: 'Opal Diffuser Panel', cat: 'Metalwork', type: 'raw_material', unit: 'pcs',
        costNet: 4.3, saleNet: 0, stock: 180, reorder: 60, sellable: 0, purchasable: 1, manufactured: 0, track: 1,
        brand: 'Northstar Industrial', supplier: 'ClearView Diffusers', ean13: '0841234500086', dun14: '10841234500083',
        unitsPerPack: 10, packsPerPallet: 200, weighted: 0,
      },
      {
        sku: 'PCB-LED', name: 'LED PCB Module', cat: 'Electrical', type: 'raw_material', unit: 'pcs',
        costNet: 3.1, saleNet: 0, stock: 260, reorder: 100, sellable: 0, purchasable: 1, manufactured: 0, track: 1,
        brand: 'Voltway Components', supplier: 'CircuitWorks Assembly', ean13: '0841234500093', dun14: '10841234500090',
        unitsPerPack: 1, packsPerPallet: 500, weighted: 0,
      },
      {
        sku: 'CBL-2C', name: '2-Core Cable', cat: 'Electrical', type: 'raw_material', unit: 'm',
        costNet: 0.85, saleNet: 0, stock: 900, reorder: 300, sellable: 0, purchasable: 1, manufactured: 0, track: 1,
        brand: 'Northstar Industrial', supplier: 'Northstar Cabling', ean13: '0841234500109', dun14: '10841234500106',
        unitsPerPack: 1, packsPerPallet: 1000, weighted: 0,
      },
      {
        sku: 'SCR-M3', name: 'M3 Screw Pack (100)', cat: 'Metalwork', type: 'raw_material', unit: 'pack',
        costNet: 1.2, saleNet: 0, stock: 75, reorder: 40, sellable: 0, purchasable: 1, manufactured: 0, track: 1,
        brand: 'Northstar Industrial', supplier: 'Precision Fasteners Co.', ean13: '0841234500116', dun14: '10841234500113',
        unitsPerPack: 1, packsPerPallet: 200, weighted: 0,
      },
      {
        sku: 'PKG-BOX', name: 'Carton 600x200', cat: 'Packaging', type: 'raw_material', unit: 'pcs',
        costNet: 1.85, saleNet: 0, stock: 150, reorder: 80, sellable: 0, purchasable: 1, manufactured: 0, track: 1,
        brand: 'Unbranded', supplier: 'Greenline Packaging', ean13: '0841234500123', dun14: '10841234500120',
        unitsPerPack: 25, packsPerPallet: 500, weighted: 0,
      },
      {
        sku: 'CON-TAPE', name: 'Thermal Tape Roll', cat: 'Electrical', type: 'consumable', unit: 'roll',
        costNet: 2.5, saleNet: 0, stock: 60, reorder: 25, sellable: 0, purchasable: 1, manufactured: 0, track: 1,
        brand: 'Unbranded', supplier: 'Brightline Tools', ean13: '0841234500130', dun14: '10841234500137',
        unitsPerPack: 1, packsPerPallet: 144, weighted: 0,
      },
      {
        sku: 'RAW-SOLDER', name: 'Solder Wire 1mm', cat: 'Electrical', type: 'raw_material', unit: 'kg',
        costNet: 18.0, saleNet: 0, stock: 12.5, reorder: 5, sellable: 0, purchasable: 1, manufactured: 0, track: 1,
        brand: 'Unbranded', supplier: 'Summit Logistics', ean13: '0841234500147', dun14: '10841234500144',
        unitsPerPack: 1, packsPerPallet: 24, weighted: 1,
      },
      {
        sku: 'SRV-INST', name: 'Installation Service', cat: 'Services', type: 'service', unit: 'job',
        costNet: 0, saleNet: 150.0, stock: 0, reorder: 0, sellable: 1, purchasable: 0, manufactured: 0, track: 0,
        brand: 'Unbranded', supplier: null, ean13: null, dun14: null,
        unitsPerPack: null, packsPerPallet: null, weighted: 0,
      },
      {
        sku: 'SRV-DESIGN', name: 'Custom Design Service', cat: 'Services', type: 'service', unit: 'job',
        costNet: 0, saleNet: 250.0, stock: 0, reorder: 0, sellable: 1, purchasable: 0, manufactured: 0, track: 0,
        brand: 'Unbranded', supplier: null, ean13: null, dun14: null,
        unitsPerPack: null, packsPerPallet: null, weighted: 0,
      },
    ];
    const prod = {};
    const prodPrices = {};
    const prodCosts = {};
    const prodCostTaxRates = {};
    for (const p of productDefs) {
      const supplier = p.supplier ? supplierByName[p.supplier] : null;
      const costVat = supplier ? supplier.vat : 0;
      const costLevy = supplier ? supplier.levy : 0;
      const costGross = p.costNet > 0 ? round2(p.costNet / (1 + (costVat + costLevy) / 100)) : 0;
      const costPrice = round2(costGross + costGross * (costVat / 100) + costGross * (costLevy / 100));
      const saleVat = p.saleNet > 0 ? 8.25 : 0;
      const saleGross = p.saleNet > 0 ? round2(p.saleNet / (1 + saleVat / 100)) : 0;
      const salePrice = round2(saleGross + saleGross * (saleVat / 100));
      prod[p.sku] = await insert(conn, 'products', {
        sku: p.sku,
        name: p.name,
        category_id: cats[p.cat],
        brand_id: brands[p.brand],
        supplier_id: supplier ? supplier.id : null,
        ean13: p.ean13,
        dun14: p.dun14,
        plu: p.plu ?? null,
        units_per_pack: p.unitsPerPack,
        packs_per_pallet: p.packsPerPallet,
        sold_by_weight: p.weighted,
        type: p.type,
        unit: p.unit,
        cost_gross_price: costGross,
        cost_vat_rate: costVat,
        cost_levy_rate: costLevy,
        cost_price: costPrice,
        sale_gross_price: saleGross,
        sale_vat_rate: saleVat,
        sale_price: salePrice,
        stock_qty: p.stock,
        reorder_level: p.reorder,
        is_sellable: p.sellable,
        is_purchasable: p.purchasable,
        is_manufactured: p.manufactured,
        track_stock: p.track,
        description: null,
      });
      prodPrices[p.sku] = salePrice;
      prodCosts[p.sku] = costPrice;
      prodCostTaxRates[p.sku] = costVat;
    }

    // ----------------------------------------------------------------- BOMs
    const bomDefs = [
      {
        sku: 'AUR-P100', name: 'Aurora Pendant 100 – BOM', version: 'v1', output: 1, status: 'active',
        items: [['AL-6061', 0.8, 2], ['LED-2835', 0.5, 1], ['PSU-24V', 1, 0], ['DIF-OPAL', 0.5, 1],
          ['PCB-LED', 1, 0], ['CBL-2C', 1.2, 3], ['SCR-M3', 0.2, 0], ['PKG-BOX', 1, 0]],
      },
      {
        sku: 'AUR-L200', name: 'Aurora Linear 200 – BOM', version: 'v1', output: 1, status: 'active',
        items: [['AL-6061', 1.6, 2], ['LED-2835', 1.2, 2], ['PSU-24V', 2, 0], ['DIF-OPAL', 1, 1],
          ['PCB-LED', 2, 0], ['CBL-2C', 2.4, 3], ['SCR-M3', 0.4, 0], ['PKG-BOX', 1, 0]],
      },
      {
        sku: 'AUR-D50', name: 'Aurora Desk Lamp 50 – BOM', version: 'v1', output: 1, status: 'active',
        items: [['AL-6061', 0.5, 2], ['LED-2835', 0.3, 1], ['PSU-24V', 1, 0], ['DIF-OPAL', 0.2, 1],
          ['PCB-LED', 0.5, 0], ['CBL-2C', 0.8, 3], ['SCR-M3', 0.1, 0], ['PKG-BOX', 1, 0]],
      },
      {
        sku: 'AUR-S300', name: 'Aurora Spot 300 – BOM (draft)', version: 'v1', output: 1, status: 'draft',
        items: [['AL-6061', 0.6, 2], ['LED-2835', 0.4, 1], ['PSU-24V', 1, 0], ['PCB-LED', 1, 0],
          ['PKG-BOX', 1, 0]],
      },
    ];
    const bom = {};
    for (const b of bomDefs) {
      const bomId = await insert(conn, 'boms', {
        product_id: prod[b.sku], name: b.name, version: b.version, output_qty: b.output, status: b.status,
      });
      bom[b.sku] = bomId;
      let sort = 0;
      for (const [component, qty, scrap] of b.items) {
        await insert(conn, 'bom_items', {
          bom_id: bomId, component_id: prod[component], quantity: qty, scrap_percent: scrap, sort_order: sort++,
        });
      }
    }

    // ------------------------------------------------------------ customers
    const customerDefs = [
      ['Harborview Hotels', 'Dana Whitfield', 'procurement@harborview.example', 'Portland', 'OR', 'active'],
      ['Northline Architects', 'Marcus Lee', 'marcus@northline.example', 'Seattle', 'WA', 'active'],
      ['Cedar & Co. Interiors', 'Elena Ramos', 'elena@cedarco.example', 'San Francisco', 'CA', 'active'],
      ['Brightspace Offices', 'Josh Kim', 'josh@brightspace.example', 'San Jose', 'CA', 'active'],
      ['Atlas Coworking', 'Nadia Osei', 'nadia@atlas-cowork.example', 'Denver', 'CO', 'active'],
      ['The Loft Bistro', 'Peter Lang', 'peter@loftbistro.example', 'Austin', 'TX', 'active'],
      ['Summit Fitness Clubs', 'Rachel Doyle', 'rachel@summitfit.example', 'Phoenix', 'AZ', 'inactive'],
      ['Juniper Retail Group', 'Owen Clarke', 'owen@juniper.example', 'Chicago', 'IL', 'active'],
      ['Studio Halo', 'Mina Park', 'mina@studiohalo.example', 'Los Angeles', 'CA', 'active'],
      ['Riverbend Clinic', 'Sofia Almeida', 'sofia@riverbend.example', 'Sacramento', 'CA', 'active'],
      ['Kestrel Design Build', 'Liam Turner', 'liam@kestrel.example', 'Boise', 'ID', 'active'],
      ['Union Hall Events', 'Grace Chen', 'grace@unionhall.example', 'New York', 'NY', 'active'],
      ['Bluebird Cafés', 'Henry Walsh', 'henry@bluebird.example', 'Boston', 'MA', 'active'],
      ['Meridian Property', 'Ava Sinclair', 'ava@meridianprop.example', 'Dallas', 'TX', 'active'],
      ['Ridgeway Galleries', 'Noah Bennett', 'noah@ridgeway.example', 'Santa Fe', 'NM', 'active'],
      ['Lumen Workspaces', 'Chloe Fontaine', 'chloe@lumenwork.example', 'Miami', 'FL', 'active'],
      ['Foxglove Boutique', 'Iris Voss', 'iris@foxglove.example', 'Nashville', 'TN', 'inactive'],
      ['Beacon Conference', 'Derek Hall', 'derek@beaconconf.example', 'Las Vegas', 'NV', 'active'],
      ['Willow Creek Winery', 'Ana Petrova', 'ana@willowcreek.example', 'Napa', 'CA', 'active'],
      ['Metro Library Trust', 'Samir Patel', 'samir@metrolibrary.example', 'Minneapolis', 'MN', 'active'],
      ['Copperline Studios', 'Ruby Nguyen', 'ruby@copperline.example', 'Atlanta', 'GA', 'active'],
      ['Brookfield Schools', 'Karen Mills', 'karen@brookfield.example', 'Columbus', 'OH', 'active'],
      ['Salt & Stone Spa', 'Tara Singh', 'tara@saltstone.example', 'San Diego', 'CA', 'active'],
      ['Orbit Tech Labs', 'Victor Liu', 'victor@orbitlabs.example', 'San Jose', 'CA', 'active'],
    ];
    const customers = [];
    let cnum = 1;
    for (const [name, contact, email, city, state, status] of customerDefs) {
      const address = `${Math.floor(between(100, 9800))} ${pick(['Market St', 'Oak Ave', 'Industrial Way', 'Harbor Blvd', 'Main St'])}`;
      const postal = String(Math.floor(between(10000, 99999)));
      const phone = `+1 (${Math.floor(between(200, 989))}) 555-${String(Math.floor(between(1000, 9999)))}`;
      const id = await insert(conn, 'customers', {
        customer_no: `CUS-${String(cnum++).padStart(5, '0')}`,
        company_name: name,
        contact_name: contact,
        email,
        phone,
        address_line1: address,
        city,
        state,
        postal_code: postal,
        country: 'United States',
        tax_id: `US-${Math.floor(between(10, 99))}-${Math.floor(between(1000000, 9999999))}`,
        payment_terms: pick(['Net 15', 'Net 30', 'Net 45', 'Due on receipt']),
        credit_limit: pick([0, 5000, 10000, 25000]),
        status,
      });
      customers.push({ id, name, contact, email, phone, address, city, state, postal, status });
    }

    // ------------------------------------------------- customer warehouses
    // Customers receive purchases at their own warehouses, which are
    // independent from the billing address stored on the customer record.
    const warehousesByCustomer = new Map();
    for (const [index, customer] of customers.entries()) {
      const mainId = await insert(conn, 'customer_warehouses', {
        customer_id: customer.id,
        code: 'MAIN',
        name: 'Main warehouse',
        contact_name: customer.contact,
        email: customer.email,
        phone: customer.phone,
        address_line1: customer.address,
        city: customer.city,
        state: customer.state,
        postal_code: customer.postal,
        country: 'United States',
        status: customer.status === 'inactive' ? 'inactive' : 'active',
        notes: 'Primary receiving location.',
      });
      const list = [{ id: mainId, name: 'Main warehouse', code: 'MAIN' }];

      // Most customers operate more than one receiving location.
      if (index % 4 !== 3) {
        const secondName = pick(['North distribution center', 'West coast receiving', 'Airport logistics hub', 'Regional warehouse']);
        const secondCode = pick(['NORTH', 'WEST', 'AIR', 'REG']);
        const secondId = await insert(conn, 'customer_warehouses', {
          customer_id: customer.id,
          code: secondCode,
          name: secondName,
          contact_name: customer.contact,
          email: customer.email,
          phone: customer.phone,
          address_line1: `${Math.floor(between(100, 9800))} ${pick(['Logistics Pkwy', 'Cargo Rd', 'Distribution Way', 'Dock St'])}`,
          city: customer.city,
          state: customer.state,
          postal_code: customer.postal,
          country: 'United States',
          status: index % 9 === 0 ? 'inactive' : 'active',
          notes: 'Receives pallet deliveries. Call ahead for dock scheduling.',
        });
        list.push({ id: secondId, name: secondName, code: secondCode });
      }
      warehousesByCustomer.set(customer.id, list);
    }

    // ------------------------------------------------- customer product codes
    const customerByName = Object.fromEntries(customers.map((c) => [c.name, c.id]));
    const customerCodeDefs = [
      ['Harborview Hotels', 'AUR-P100', 'HV-PEND-100', 'Harborview pendant, brushed brass'],
      ['Harborview Hotels', 'AUR-D50', 'HV-DESK-50', 'Harborview desk lamp'],
      ['Northline Architects', 'AUR-L200', 'NLA-LIN-200', 'Northline linear fixture'],
      ['Cedar & Co. Interiors', 'AUR-P100', 'CED-P100', 'Cedar pendant'],
      ['Cedar & Co. Interiors', 'AUR-S300', 'CED-SPOT-300', 'Cedar spot'],
      ['Brightspace Offices', 'AUR-S300', 'BS-SPOT-300', 'Brightspace spot fixture'],
      ['Brightspace Offices', 'SRV-INST', 'BS-INSTALL', 'Installation service'],
      ['Atlas Coworking', 'AUR-L200', 'ATLAS-LINEAR', 'Atlas linear run'],
      ['Juniper Retail Group', 'AUR-D50', 'JRG-DESK-50', 'Juniper desk lamp'],
      ['Juniper Retail Group', 'AUR-P100', 'JRG-PEND-100', 'Juniper pendant'],
      ['Studio Halo', 'AUR-P100', 'HALO-P100', 'Studio Halo pendant'],
      ['Riverbend Clinic', 'AUR-S300', 'RBC-S300', 'Riverbend spot'],
      ['Union Hall Events', 'SRV-DESIGN', 'UHE-DESIGN', 'Event lighting design'],
      ['Bluebird Cafés', 'AUR-D50', 'BB-CAFE-D50', 'Bluebird café lamp'],
      ['Lumen Workspaces', 'AUR-L200', 'LUM-L200', 'Lumen linear fixture'],
    ];
    for (const [customerName, sku, code, description] of customerCodeDefs) {
      await insert(conn, 'customer_product_codes', {
        customer_id: customerByName[customerName],
        product_id: prod[sku],
        code,
        description,
      });
    }

    // ------------------------------------------------------------ employees
    const employeeDefs = [
      ['Maya', 'Rodriguez', 'Operations Manager', 'Operations', 'full_time', 92000, 'active'],
      ['Daniel', 'Cho', 'Production Supervisor', 'Manufacturing', 'full_time', 74000, 'active'],
      ['Fatima', 'Hassan', 'Assembly Technician', 'Manufacturing', 'full_time', 48000, 'active'],
      ['Lucas', 'Meyer', 'Assembly Technician', 'Manufacturing', 'full_time', 46500, 'active'],
      ['Nina', 'Kowalski', 'Quality Inspector', 'Quality', 'full_time', 56000, 'active'],
      ['Andre', 'Dubois', 'Procurement Specialist', 'Purchasing', 'full_time', 61000, 'active'],
      ['Sana', 'Iqbal', 'Sales Executive', 'Sales', 'full_time', 68000, 'active'],
      ['Ethan', 'Brooks', 'Sales Executive', 'Sales', 'full_time', 65000, 'on_leave'],
      ['Hana', 'Sato', 'Industrial Designer', 'Engineering', 'full_time', 78000, 'active'],
      ['Omar', 'Farouk', 'Warehouse Coordinator', 'Logistics', 'full_time', 52000, 'active'],
      ['Julia', 'Novak', 'Finance Administrator', 'Finance', 'part_time', 38000, 'active'],
      ['Ben', 'Carter', 'Maintenance Technician', 'Manufacturing', 'contract', 44000, 'inactive'],
    ];
    let enumIdx = 1;
    for (const [first, last, title, dept, type, salary, status] of employeeDefs) {
      await insert(conn, 'employees', {
        employee_no: `EMP-${String(enumIdx++).padStart(4, '0')}`,
        first_name: first,
        last_name: last,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@auroralighting.example`,
        phone: `+1 (415) 555-${String(1000 + enumIdx)}`,
        job_title: title,
        department: dept,
        employment_type: type,
        hire_date: daysAgo(Math.floor(between(200, 1500))),
        salary,
        address: `${Math.floor(between(100, 9800))} ${pick(['Pine St', 'Cedar Ave', 'Grand Ave'])}`,
        status,
      });
    }

    // --------------------------------------------------------- sales orders
    const saleSkus = ['AUR-P100', 'AUR-L200', 'AUR-D50', 'AUR-S300', 'SRV-INST', 'SRV-DESIGN'];
    const productPrices = prodPrices;
    const productCosts = prodCosts;

    const salesOrders = [];
    for (let i = 0; i < 18; i++) {
      const customer = pick(customers);
      const orderDate = daysAgo(Math.floor(between(0, 120)));
      const lineCount = Math.floor(between(1, 3.99));
      const items = [];
      const used = new Set();
      for (let j = 0; j < lineCount; j++) {
        let sku = pick(saleSkus);
        let guard = 0;
        while (used.has(sku) && guard++ < 10) sku = pick(saleSkus);
        used.add(sku);
        const qty = sku.startsWith('SRV') ? Math.floor(between(1, 3)) : Math.floor(between(1, 9));
        const price = round2(productPrices[sku] * (rand() < 0.25 ? 0.95 : 1));
        items.push({ sku, quantity: qty, unit_price: price, tax_rate: 8.25, description: null });
      }
      const status = pick(['draft', 'confirmed', 'confirmed', 'confirmed', 'partially_delivered', 'delivered', 'delivered', 'cancelled']);
      const totalsObj = totals(items);
      const orderNo = `SO-${orderDate.slice(0, 4)}-${String(i + 1).padStart(4, '0')}`;
      const customerWarehouses = warehousesByCustomer.get(customer.id) || [];
      const warehouse = pick(customerWarehouses);
      const receptionDate = addDays(orderDate, Math.floor(between(1, 12)));
      const receptionAt = `${receptionDate} ${String(Math.floor(between(7, 16))).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}:00`;
      const orderId = await insert(conn, 'sales_orders', {
        order_no: orderNo,
        customer_id: customer.id,
        customer_order_no: `CO-${orderDate.slice(0, 4)}-${String(Math.floor(between(1000, 9999)))}-${String(i + 1).padStart(3, '0')}`,
        customer_warehouse_id: warehouse ? warehouse.id : null,
        order_date: orderDate,
        expected_date: addDays(orderDate, Math.floor(between(7, 30))),
        docking_station: rand() < 0.85 ? pick(['Dock 1', 'Dock 2', 'Dock 3', 'Dock 4', 'Receiving A', 'Receiving B']) : null,
        reception_at: rand() < 0.9 ? receptionAt : null,
        status,
        ...totalsObj,
        notes: null,
        created_by: adminId,
      });
      for (const item of items) {
        await insert(conn, 'sales_order_items', {
          order_id: orderId,
          product_id: prod[item.sku],
          description: item.description,
          quantity: item.quantity,
          delivered_qty: status === 'delivered' ? item.quantity : status === 'partially_delivered' ? Math.floor(item.quantity / 2) : 0,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate,
          line_total: round2(item.quantity * item.unit_price),
        });
      }
      salesOrders.push({ id: orderId, no: orderNo, customer, items, status, orderDate });
    }

    // ------------------------------------------------------ purchase orders
    const purchaseSkus = ['AL-6061', 'LED-2835', 'PSU-24V', 'DIF-OPAL', 'PCB-LED', 'CBL-2C', 'SCR-M3', 'PKG-BOX', 'CON-TAPE'];
    const purchaseOrders = [];
    for (let i = 0; i < 14; i++) {
      const supplier = pick(suppliers);
      const orderDate = daysAgo(Math.floor(between(0, 140)));
      const lineCount = Math.floor(between(1, 3.99));
      const items = [];
      const used = new Set();
      for (let j = 0; j < lineCount; j++) {
        let sku = pick(purchaseSkus);
        let guard = 0;
        while (used.has(sku) && guard++ < 10) sku = pick(purchaseSkus);
        used.add(sku);
        const qty = Math.floor(between(20, 200));
        const price = round2(productCosts[sku] * (rand() < 0.3 ? 1.05 : 1));
        items.push({ sku, quantity: qty, unit_price: price, tax_rate: prodCostTaxRates[sku] || 0 });
      }
      const status = pick(['draft', 'confirmed', 'confirmed', 'partially_received', 'received', 'received', 'cancelled']);
      const totalsObj = totals(items);
      const orderNo = `PO-${orderDate.slice(0, 4)}-${String(i + 1).padStart(4, '0')}`;
      const orderId = await insert(conn, 'purchase_orders', {
        order_no: orderNo,
        supplier_id: supplier.id,
        order_date: orderDate,
        expected_date: addDays(orderDate, Math.floor(between(7, 25))),
        status,
        ...totalsObj,
        created_by: adminId,
      });
      for (const item of items) {
        await insert(conn, 'purchase_order_items', {
          order_id: orderId,
          product_id: prod[item.sku],
          quantity: item.quantity,
          received_qty: status === 'received' ? item.quantity : status === 'partially_received' ? Math.floor(item.quantity / 2) : 0,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate,
          line_total: round2(item.quantity * item.unit_price),
        });
      }
      purchaseOrders.push({ id: orderId, no: orderNo, supplier, items, status, orderDate });
    }

    // --------------------------------------------------------- sales invoices
    const invoiceStatuses = ['paid', 'paid', 'sent', 'sent', 'overdue', 'draft'];
    let invoiceSeq = 1;
    for (let i = 0; i < 28; i++) {
      const customer = pick(customers);
      const invoiceDate = daysAgo(Math.floor(between(0, 175)));
      const lineCount = Math.floor(between(1, 3.99));
      const items = [];
      const used = new Set();
      for (let j = 0; j < lineCount; j++) {
        let sku = pick(saleSkus);
        let guard = 0;
        while (used.has(sku) && guard++ < 10) sku = pick(saleSkus);
        used.add(sku);
        const qty = sku.startsWith('SRV') ? 1 : Math.floor(between(1, 6));
        items.push({ sku, quantity: qty, unit_price: productPrices[sku], tax_rate: 8.25, description: null });
      }
      const status = pick(invoiceStatuses);
      const totalsObj = totals(items, rand() < 0.15 ? 25 : 0);
      const invoiceNo = `INV-${invoiceDate.slice(0, 4)}-${String(invoiceSeq++).padStart(4, '0')}`;
      const sourceOrder = salesOrders.find((o) => o.customer.id === customer.id && o.status === 'delivered');
      const invoiceId = await insert(conn, 'sales_invoices', {
        invoice_no: invoiceNo,
        sales_order_id: sourceOrder ? sourceOrder.id : null,
        customer_id: customer.id,
        invoice_date: invoiceDate,
        due_date: addDays(invoiceDate, 30),
        status,
        ...totalsObj,
        amount_paid: status === 'paid' ? totalsObj.total : 0,
        created_by: adminId,
      });
      for (const item of items) {
        await insert(conn, 'sales_invoice_items', {
          invoice_id: invoiceId,
          product_id: prod[item.sku],
          quantity: item.quantity,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate,
          line_total: round2(item.quantity * item.unit_price),
        });
      }
    }

    // ------------------------------------------------------ purchase invoices
    let billSeq = 1;
    for (let i = 0; i < 18; i++) {
      const supplier = pick(suppliers);
      const invoiceDate = daysAgo(Math.floor(between(0, 175)));
      const lineCount = Math.floor(between(1, 3.99));
      const items = [];
      const used = new Set();
      for (let j = 0; j < lineCount; j++) {
        let sku = pick(purchaseSkus);
        let guard = 0;
        while (used.has(sku) && guard++ < 10) sku = pick(purchaseSkus);
        used.add(sku);
        const qty = Math.floor(between(25, 150));
        items.push({ sku, quantity: qty, unit_price: productCosts[sku], tax_rate: prodCostTaxRates[sku] || 0, description: null });
      }
      const status = pick(['draft', 'received', 'received', 'paid', 'paid', 'overdue']);
      const totalsObj = totals(items);
      const billNo = `BILL-${invoiceDate.slice(0, 4)}-${String(billSeq++).padStart(4, '0')}`;
      const sourceOrder = purchaseOrders.find((o) => o.supplier.id === supplier.id);
      const posted = ['received', 'paid'].includes(status) ? 1 : 0;
      const invoiceId = await insert(conn, 'purchase_invoices', {
        bill_no: billNo,
        purchase_order_id: sourceOrder ? sourceOrder.id : null,
        supplier_id: supplier.id,
        invoice_date: invoiceDate,
        due_date: addDays(invoiceDate, 30),
        status,
        ...totalsObj,
        amount_paid: status === 'paid' ? totalsObj.total : 0,
        stock_posted: posted,
        created_by: adminId,
      });
      for (const item of items) {
        await insert(conn, 'purchase_invoice_items', {
          invoice_id: invoiceId,
          product_id: prod[item.sku],
          quantity: item.quantity,
          unit_price: item.unit_price,
          tax_rate: item.tax_rate,
          line_total: round2(item.quantity * item.unit_price),
        });
        if (posted) {
          await insert(conn, 'stock_movements', {
            product_id: prod[item.sku],
            movement_type: 'purchase_in',
            quantity: item.quantity,
            unit_cost: item.unit_price,
            reference_type: 'purchase_invoice',
            reference_id: invoiceId,
            notes: `Received on ${billNo}`,
            created_by: adminId,
          });
        }
      }
    }

    // ------------------------------------------- customer and supplier payments
    const [openSales] = await conn.query(
      `SELECT id, invoice_no, customer_id, total
         FROM sales_invoices
        WHERE status IN ('sent', 'overdue') AND total > 0
        ORDER BY invoice_date DESC, id DESC
        LIMIT 2`,
    );
    const [openPurchases] = await conn.query(
      `SELECT id, bill_no, supplier_id, total
         FROM purchase_invoices
        WHERE status IN ('received', 'overdue') AND total > 0
        ORDER BY invoice_date DESC, id DESC
        LIMIT 2`,
    );

    const paymentDate = daysAgo(0);
    const addDemoPayment = async ({
      direction,
      partyId,
      reference,
      methods,
      adjustments = [],
      allocations,
      notes = null,
    }) => {
      const methodTotal = round2(methods.reduce((sum, line) => sum + line.amount, 0));
      const creditTotal = round2(
        adjustments.filter((line) => line.kind === 'credit_note').reduce((sum, line) => sum + line.amount, 0),
      );
      const debitTotal = round2(
        adjustments.filter((line) => line.kind === 'debit_note').reduce((sum, line) => sum + line.amount, 0),
      );
      const withholdingTotal = round2(
        adjustments.filter((line) => line.kind === 'withholding').reduce((sum, line) => sum + line.amount, 0),
      );
      const sourceTotal = round2(methodTotal + creditTotal + withholdingTotal);
      const appliedTotal = round2(allocations.reduce((sum, line) => sum + line.amount, 0));
      const [partyRows] = await conn.query(
        direction === 'customer'
          ? 'SELECT company_name FROM customers WHERE id = ? LIMIT 1'
          : 'SELECT company_name FROM suppliers WHERE id = ? LIMIT 1',
        [partyId],
      );
      const partyName = partyRows[0] ? partyRows[0].company_name : null;
      const paymentNo = await nextNumber({
        prefix: direction === 'customer' ? 'RCP' : 'PMT',
        table: 'payments',
        column: 'payment_no',
        conn,
        date: paymentDate,
      });
      const paymentId = await insert(conn, 'payments', {
        payment_no: paymentNo,
        direction,
        customer_id: direction === 'customer' ? partyId : null,
        supplier_id: direction === 'supplier' ? partyId : null,
        payment_date: paymentDate,
        reference,
        method_total: methodTotal,
        credit_total: creditTotal,
        debit_total: debitTotal,
        withholding_total: withholdingTotal,
        total_amount: sourceTotal,
        applied_amount: appliedTotal,
        unapplied_amount: round2(sourceTotal - appliedTotal - debitTotal),
        notes,
        created_by: adminId,
      });

      for (let i = 0; i < methods.length; i += 1) {
        const line = methods[i];
        await insert(conn, 'payment_methods', {
          payment_id: paymentId,
          method: line.method,
          amount: line.amount,
          reference: line.reference || null,
          bank_name: line.bank_name || null,
          check_date: line.check_date || null,
          notes: line.notes || null,
          sort_order: i,
        });
        if (line.method === 'own_check' || line.method === 'endorsed_check') {
          await createCheckForPayment(conn, {
            direction,
            party: { id: partyId, company_name: partyName },
            line,
            paymentDate,
            paymentId,
            paymentNo,
            userId: adminId,
            companyName: settings.company_name,
          });
        }
      }
      for (let i = 0; i < adjustments.length; i += 1) {
        const line = adjustments[i];
        await insert(conn, 'payment_adjustments', {
          payment_id: paymentId,
          kind: line.kind,
          amount: line.amount,
          reference: line.reference || null,
          notes: line.notes || null,
          sort_order: i,
        });
      }
      for (const line of allocations) {
        await insert(conn, 'payment_allocations', {
          payment_id: paymentId,
          invoice_type: line.invoice_type,
          invoice_id: line.invoice_id,
          invoice_no: line.invoice_no,
          amount: line.amount,
        });
        const invoiceTable = line.invoice_type === 'sales' ? 'sales_invoices' : 'purchase_invoices';
        if (line.markPaid) {
          await conn.query(
            `UPDATE ${invoiceTable} SET amount_paid = amount_paid + ?, status = 'paid' WHERE id = ?`,
            [line.amount, line.invoice_id],
          );
        } else {
          await conn.query(`UPDATE ${invoiceTable} SET amount_paid = amount_paid + ? WHERE id = ?`, [
            line.amount,
            line.invoice_id,
          ]);
        }
      }
      return { paymentId, paymentNo };
    };

    if (openSales[0]) {
      const total = round2(openSales[0].total);
      const cash = round2(total * 0.35);
      const check = round2(total - cash);
      await addDemoPayment({
        direction: 'customer',
        partyId: openSales[0].customer_id,
        reference: 'Counter receipt - mixed payment',
        methods: [
          { method: 'cash', amount: cash },
          {
            method: 'own_check',
            amount: check,
            reference: `CHK-${Date.now().toString().slice(-6)}`,
            bank_name: 'Bay Area Commercial Bank',
            check_date: paymentDate,
          },
        ],
        allocations: [
          {
            invoice_type: 'sales',
            invoice_id: openSales[0].id,
            invoice_no: openSales[0].invoice_no,
            amount: total,
            markPaid: true,
          },
        ],
        notes: 'Demo customer receipt with cash and a customer check.',
      });
    }
    if (openSales[1]) {
      const total = round2(openSales[1].total);
      const received = round2(total + 50);
      await addDemoPayment({
        direction: 'customer',
        partyId: openSales[1].customer_id,
        reference: 'Endorsed third-party check',
        methods: [
          {
            method: 'endorsed_check',
            amount: received,
            reference: `EDC-${Date.now().toString().slice(-6)}`,
            bank_name: 'Pacific Trade Bank',
            check_date: paymentDate,
          },
        ],
        allocations: [
          {
            invoice_type: 'sales',
            invoice_id: openSales[1].id,
            invoice_no: openSales[1].invoice_no,
            amount: total,
            markPaid: true,
          },
        ],
        notes: 'Demo overpayment: the difference remains as customer credit.',
      });
    }
    if (openPurchases[0]) {
      const total = round2(openPurchases[0].total);
      const credit = round2(total * 0.05);
      const cash = round2(total - credit);
      await addDemoPayment({
        direction: 'supplier',
        partyId: openPurchases[0].supplier_id,
        reference: 'Supplier settlement with credit note',
        methods: [{ method: 'cash', amount: cash, notes: 'Petty cash settlement' }],
        adjustments: [
          { kind: 'credit_note', amount: credit, reference: `SCN-${Date.now().toString().slice(-6)}` },
        ],
        allocations: [
          {
            invoice_type: 'purchase',
            invoice_id: openPurchases[0].id,
            invoice_no: openPurchases[0].bill_no,
            amount: total,
            markPaid: true,
          },
        ],
        notes: 'Demo supplier payment using a supplier credit note.',
      });
    }
    if (openPurchases[1]) {
      const total = round2(openPurchases[1].total);
      const bank = round2(total * 0.5);
      await addDemoPayment({
        direction: 'supplier',
        partyId: openPurchases[1].supplier_id,
        reference: 'Partial bank transfer',
        methods: [
          {
            method: 'bank_transfer',
            amount: bank,
            reference: `TRF-${Date.now().toString().slice(-6)}`,
            bank_name: 'Bay Area Commercial Bank',
          },
        ],
        allocations: [
          {
            invoice_type: 'purchase',
            invoice_id: openPurchases[1].id,
            invoice_no: openPurchases[1].bill_no,
            amount: bank,
            markPaid: false,
          },
        ],
        notes: 'Demo partial supplier payment; the balance remains open.',
      });

      const remaining = round2(total - bank);
      if (remaining > 0) {
        await addDemoPayment({
          direction: 'supplier',
          partyId: openPurchases[1].supplier_id,
          reference: 'Supplier check settlement',
          methods: [
            {
              method: 'own_check',
              amount: remaining,
              reference: `SUP-CHK-${Date.now().toString().slice(-6)}`,
              bank_name: 'Bay Area Commercial Bank',
              check_date: paymentDate,
              notes: 'Balance settled with our own check.',
            },
          ],
          allocations: [
            {
              invoice_type: 'purchase',
              invoice_id: openPurchases[1].id,
              invoice_no: openPurchases[1].bill_no,
              amount: remaining,
              markPaid: true,
            },
          ],
          notes: 'Demo supplier payment settled with an issued check.',
        });
      }
    }

    // ------------------------------------------------------------- checks
    const demoCustomerId = openSales[0] ? openSales[0].customer_id : customers[0] ? customers[0].id : null;
    const demoCustomer2Id = openSales[1] ? openSales[1].customer_id : demoCustomerId;
    const demoSupId = openPurchases[0] ? openPurchases[0].supplier_id : suppliers[0] ? suppliers[0].id : null;
    const customerName = (id) => {
      const match = customers.find((customer) => customer.id === id);
      return match ? match.name : 'Demo customer';
    };

    const addDemoCheck = async ({
      entryType = 'received',
      status = 'available',
      customerId = null,
      supplierId = null,
      amount,
      checkNumber,
      bankName,
      drawerName,
      issueDate,
      dueDate = null,
      receivedDate = null,
      depositedBank = null,
      depositedDate = null,
      endorsedDate = null,
      settledDate = null,
      notes = null,
      statusNotes = null,
    }) => {
      const initialStatus = entryType === 'issued' ? 'endorsed' : 'available';
      const checkNo = await nextNumber({
        prefix: 'CHK',
        table: 'checks',
        column: 'check_no',
        conn,
        date: issueDate,
      });
      const checkId = await insert(conn, 'checks', {
        check_no: checkNo,
        check_number: checkNumber,
        bank_name: bankName,
        drawer_name: drawerName,
        amount,
        entry_type: entryType,
        status,
        customer_id: customerId,
        supplier_id: supplierId,
        issue_date: issueDate,
        due_date: dueDate,
        received_date: receivedDate,
        deposited_bank: depositedBank,
        deposited_date: depositedDate,
        endorsed_date: endorsedDate,
        settled_date: settledDate,
        source: 'manual',
        notes,
        created_by: adminId,
      });
      await recordHistory(conn, {
        checkId,
        event: 'created',
        fromStatus: null,
        toStatus: initialStatus,
        eventDate: receivedDate || issueDate,
        notes: null,
        userId: adminId,
      });
      if (status !== initialStatus) {
        await recordHistory(conn, {
          checkId,
          event: statusEvent(status),
          fromStatus: initialStatus,
          toStatus: status,
          eventDate: settledDate || endorsedDate || depositedDate || issueDate,
          notes: statusNotes,
          userId: adminId,
        });
      }
      return checkId;
    };

    if (demoCustomerId) {
      await addDemoCheck({
        customerId: demoCustomerId,
        amount: 850,
        checkNumber: 'DEMO-AVAILABLE-01',
        bankName: 'Bay Area Commercial Bank',
        drawerName: customerName(demoCustomerId),
        issueDate: daysAgo(4),
        dueDate: addDays(daysAgo(4), 20),
        receivedDate: daysAgo(4),
        notes: 'Received from a customer and waiting for deposit.',
      });
      await addDemoCheck({
        customerId: demoCustomerId,
        amount: 430,
        checkNumber: 'DEMO-PAID-01',
        bankName: 'Pacific Trade Bank',
        drawerName: customerName(demoCustomerId),
        issueDate: daysAgo(20),
        dueDate: addDays(daysAgo(20), 10),
        receivedDate: daysAgo(20),
        status: 'paid',
        settledDate: daysAgo(3),
        notes: 'Customer check that cleared successfully.',
        statusNotes: 'Cleared by the bank.',
      });
      await addDemoCheck({
        customerId: demoCustomerId,
        amount: 275,
        checkNumber: 'DEMO-EXPIRED-01',
        bankName: 'Golden Gate Credit Union',
        drawerName: customerName(demoCustomerId),
        issueDate: daysAgo(40),
        dueDate: addDays(daysAgo(40), 1),
        receivedDate: daysAgo(40),
        status: 'expired',
        settledDate: daysAgo(5),
        notes: 'Customer check kept for history after its validity date.',
        statusNotes: 'Past its validity date.',
      });
    }
    if (demoCustomer2Id) {
      await addDemoCheck({
        customerId: demoCustomer2Id,
        amount: 1240.5,
        checkNumber: 'DEMO-DEPOSITED-01',
        bankName: 'Bay Area Commercial Bank',
        drawerName: customerName(demoCustomer2Id),
        issueDate: daysAgo(12),
        dueDate: addDays(daysAgo(12), 15),
        receivedDate: daysAgo(12),
        status: 'deposited',
        depositedBank: 'Bay Area Commercial Bank',
        depositedDate: daysAgo(7),
        notes: 'Customer check deposited in the main operating account.',
        statusNotes: 'Deposited in the main operating account.',
      });
      await addDemoCheck({
        customerId: demoCustomer2Id,
        amount: 310,
        checkNumber: 'DEMO-REJECTED-01',
        bankName: 'Pacific Trade Bank',
        drawerName: customerName(demoCustomer2Id),
        issueDate: daysAgo(25),
        dueDate: addDays(daysAgo(25), 5),
        receivedDate: daysAgo(25),
        status: 'rejected',
        settledDate: daysAgo(6),
        notes: 'Customer check rejected by the issuing bank.',
        statusNotes: 'Rejected by the issuing bank.',
      });
    }
    if (demoSupId) {
      await addDemoCheck({
        entryType: 'issued',
        supplierId: demoSupId,
        amount: 980,
        checkNumber: 'DEMO-ISSUED-01',
        bankName: 'Bay Area Commercial Bank',
        drawerName: settings.company_name,
        issueDate: daysAgo(15),
        dueDate: addDays(daysAgo(15), 10),
        receivedDate: daysAgo(15),
        endorsedDate: daysAgo(15),
        status: 'endorsed',
        notes: 'Own check issued to a supplier and pending settlement.',
        statusNotes: 'Delivered to the supplier.',
      });
    }

    // ------------------------------------------------------------ deliveries
    const [[caiCount]] = await conn.query('SELECT COUNT(*) AS count FROM cai_authorizations');
    const caiPrefix = Number(caiCount.count) === 0 ? '00001' : String(Date.now()).slice(-5).padStart(5, '0');
    const caiNumber = `CAI-DEMO-${Date.now()}`;
    const caiId = await insert(conn, 'cai_authorizations', {
      cai_number: caiNumber,
      prefix: caiPrefix,
      range_start: 1,
      range_end: 1000,
      next_number: 1,
      status: 'active',
      notes: 'Demo CAI authorization',
      created_by: adminId,
    });
    let deliverySeq = 1;
    const deliverableOrders = salesOrders.filter((o) => ['confirmed', 'partially_delivered', 'delivered'].includes(o.status));
    for (let i = 0; i < Math.min(10, deliverableOrders.length); i++) {
      const order = deliverableOrders[i];
      const status = order.status === 'delivered' ? 'delivered' : pick(['pending', 'shipped', 'shipped']);
      const deliveryDate = addDays(order.orderDate, Math.floor(between(2, 10)));
      const seq = deliverySeq++;
      const deliveryId = await insert(conn, 'deliveries', {
        delivery_no: `DLV-${deliveryDate.slice(0, 4)}-${String(seq).padStart(4, '0')}`,
        packing_slip_no: formatPackingSlipNo(caiPrefix, seq),
        cai_authorization_id: caiId,
        cai_number: caiNumber,
        cot: i % 3 === 0 ? `COT-${1000 + i}` : null,
        sales_order_id: order.id,
        customer_id: order.customer.id,
        delivery_date: deliveryDate,
        carrier: pick(['UPS', 'FedEx', 'DHL', 'Local courier']),
        tracking_number: `1Z${Math.floor(between(100000, 999999))}${Math.floor(between(1000, 9999))}`,
        status,
        stock_posted: status === 'pending' ? 0 : 1,
        notes: null,
      });
      for (const item of order.items) {
        await insert(conn, 'delivery_items', {
          delivery_id: deliveryId,
          product_id: prod[item.sku],
          quantity: item.quantity,
        });
        if (status !== 'pending') {
          await insert(conn, 'stock_movements', {
            product_id: prod[item.sku],
            movement_type: 'sale_out',
            quantity: -item.quantity,
            unit_cost: productCosts[item.sku],
            reference_type: 'delivery',
            reference_id: deliveryId,
            notes: `Delivered on ${deliveryDate}`,
            created_by: adminId,
          });
        }
      }
    }

    await conn.query('UPDATE cai_authorizations SET next_number = ? WHERE id = ?', [deliverySeq, caiId]);

    // ------------------------------------------------------ production orders
    const producibleOrders = salesOrders.filter((o) => o.status === 'confirmed' || o.status === 'partially_delivered').slice(0, 5);
    const prodOrderStatuses = ['completed', 'in_progress', 'released', 'planned', 'planned'];
    let prodSeq = 1;
    for (let i = 0; i < producibleOrders.length; i++) {
      const order = producibleOrders[i];
      const finishedLine = order.items.find((it) => it.sku.startsWith('AUR-') && it.sku !== 'AUR-S300');
      if (!finishedLine) continue;
      const status = prodOrderStatuses[i % prodOrderStatuses.length];
      const startDate = addDays(order.orderDate, 1);
      const dueDate = addDays(order.orderDate, 14);
      const productionId = await insert(conn, 'production_orders', {
        production_no: `PRD-${startDate.slice(0, 4)}-${String(prodSeq++).padStart(4, '0')}`,
        sales_order_id: order.id,
        bom_id: bom[finishedLine.sku],
        product_id: prod[finishedLine.sku],
        lot_number: lotFromDate(startDate),
        expiry_date: addDays(dueDate, 365),
        quantity: finishedLine.quantity,
        start_date: startDate,
        due_date: dueDate,
        status,
        completed_at: status === 'completed' ? `${dueDate} 15:30:00` : null,
        notes: null,
        created_by: adminId,
      });
      const [bomComponents] = await conn.query(
        `SELECT component_id, quantity, scrap_percent FROM bom_items WHERE bom_id = ?`,
        [bom[finishedLine.sku]],
      );
      for (const comp of bomComponents) {
        const required = round2(comp.quantity * finishedLine.quantity * (1 + comp.scrap_percent / 100));
        await insert(conn, 'production_order_materials', {
          production_order_id: productionId,
          component_id: comp.component_id,
          quantity_required: required,
          quantity_consumed: status === 'completed' ? required : 0,
        });
        if (status === 'completed') {
          await insert(conn, 'stock_movements', {
            product_id: comp.component_id,
            movement_type: 'production_out',
            quantity: -required,
            unit_cost: productCosts[Object.keys(prod).find((k) => prod[k] === comp.component_id)] || 0,
            reference_type: 'production_order',
            reference_id: productionId,
            notes: 'Material consumed',
            created_by: adminId,
          });
        }
      }
      if (status === 'completed') {
        await insert(conn, 'stock_movements', {
          product_id: prod[finishedLine.sku],
          movement_type: 'production_in',
          quantity: finishedLine.quantity,
          unit_cost: productCosts[finishedLine.sku],
          reference_type: 'production_order',
          reference_id: productionId,
          notes: 'Finished goods produced',
          created_by: adminId,
        });

        // Demo scale/labeler records for the completed batch. The real data
        // comes from the Bizerba middleware; these rows make the page usable
        // immediately after a fresh seed.
        const finishedPlu = (productDefs.find((p) => p.sku === finishedLine.sku) || {}).plu ?? null;
        const scaleCount = Math.max(12, Math.min(36, Number(finishedLine.quantity) || 12));
        for (let n = 0; n < scaleCount; n++) {
          const realWeight = Math.round((2.4 + between(-0.08, 0.08)) * 1000) / 1000;
          const inRange = rand() > 0.06 ? 1 : 0;
          await insert(conn, 'scale_records', {
            product_id: prod[finishedLine.sku],
            plu: finishedPlu,
            lot_number: lotFromDate(startDate),
            expiry_date: addDays(dueDate, 365),
            weighed_at: `${startDate} ${String(8 + Math.floor(n / 6)).padStart(2, '0')}:${String((n * 7) % 60).padStart(2, '0')}:00`,
            in_range: inRange,
            real_weight: realWeight,
            printed_weight: inRange ? realWeight : 0,
            printed_price: inRange ? round2(realWeight * (productPrices[finishedLine.sku] || 0)) : 0,
            label_id: `LBL-${String(productionId).padStart(4, '0')}-${String(n + 1).padStart(4, '0')}`,
            box_id: `BOX-${String(productionId).padStart(4, '0')}-${String(Math.floor(n / 6) + 1).padStart(2, '0')}`,
            pallet_id: `PAL-${String(productionId).padStart(4, '0')}-${String(Math.floor(n / 18) + 1).padStart(2, '0')}`,
          });
        }
      }
    }

    // ------------------------------------------- historical stock adjustments
    for (let i = 0; i < 40; i++) {
      const sku = pick(Object.keys(prod));
      if (sku.startsWith('SRV')) continue;
      const qty = Math.floor(between(1, 25));
      await insert(conn, 'stock_movements', {
        product_id: prod[sku],
        movement_type: pick(['purchase_in', 'adjustment']),
        quantity: qty,
        unit_cost: productCosts[sku] || 0,
        reference_type: 'seed',
        reference_id: null,
        notes: 'Opening balance adjustment',
        created_by: adminId,
      });
    }

    // ------------------------------------------------ Unit #2 POS demo data
    const posResult = await seedPosDemo(conn, { adminId });
    if (!posResult.skipped) {
      console.log(`[seed] POS demo data: ${posResult.locations} shops, ${posResult.sales} sales`);
    }

    console.log('[seed] demo data created');
    console.log(`[seed] login: admin@werp.local / ${PASSWORD}`);
  });
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
