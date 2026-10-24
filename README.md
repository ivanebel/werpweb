# WerpWeb ERP

A compact, web-based ERP for small manufacturing companies. It covers the commercial side of the business — customers, suppliers, employees, sales, purchasing, deliveries and retail point-of-sale reporting — and the shop floor side with bills of materials and production orders.

Built with **Node.js + Express**, **EJS** server-rendered views, **MySQL 8** and a **Tailwind CSS / TailAdmin** style interface. The MySQL connection can be routed through an **SSH tunnel** when the database is not directly reachable.

---

## Features

- **Dashboard** with revenue and purchasing trends, sales by category, production pipeline, low-stock alerts, recent orders and outstanding invoices (ApexCharts).
- **Contacts** - customers, suppliers and employees with full CRUD, search, filters and detail pages. Customer lists show the outstanding receivable balance and supplier lists show the outstanding payable balance, net of unapplied payment credits.
- **Customer receipts and supplier payments** — record cash, bank transfers, customer checks, endorsed third-party checks or a mix in the same payment. Allocate receipts to open sales invoices, credit notes and tax withholdings; allocate supplier payments to purchase invoices, credit notes and debit notes. Partial payments and overpayments are supported, unapplied amounts become party credit, and customer payment orders can be printed or saved as PDF.
- **Check portfolio** — track every check received from customers or issued/endorsed to suppliers. Each check has a full lifecycle (**Available**, **Deposited**, **Endorsed**, **Paid**, **Rejected**, **Expired**), its own dates, bank, drawer and supplier, linked payments, and a detailed status history. Customer check receipts automatically create available checks; supplier check payments automatically create issued checks, and an available check can be selected when endorsing a supplier payment.
- **Inventory** — products (raw materials, finished goods, consumables, services), brands and categories, including stock levels, reorder warnings, EAN-13/DUN-14 identifiers with live barcode previews and downloadable SVG files, pack/pallet quantities, weighted products, cost/sale price breakdowns and manufacturing flags.
- **Sales** — sales orders, sales invoices and deliveries. Orders can be confirmed, invoiced and delivered partially or completely. Each customer can have several receiving warehouses (separate from the billing address). Sales orders store the customer's own order number, a destination warehouse, the docking station and the expected reception date/time; deliveries and their printed documents show these details. Customers can also store their own product codes, which are printed on sales documents and packing slips.
- **Purchasing** — purchase orders and purchase invoices (bills). Receiving a bill posts stock into inventory.
- **Point of Sale (Unit #2)** — manage several shops as distinct points of sale, record completed POS sales with ticket type, ticket number and shop, and analyse revenue, average ticket, units, product rankings and category performance. POS sales are reporting records only: they do not create stock movements or change Unit #1 inventory.
- **Manufacturing** — bills of materials with component quantities and scrap, production orders that snapshot the BOM, check material availability, consume components and add finished goods to stock when completed, and scale records from the Bizerba GLM-e labeler with lot/date filters, weight statistics, and box/pallet totals.
- **Documents** — printable sales orders, purchase orders, invoices and packing slips. Unit prices are tax-inclusive; VAT is displayed as an extracted (included) amount rather than added again.
- **Outgoing email** — configure SMTP in the app and email purchase orders, purchase invoices, sales orders, sales invoices, supplier/customer payment orders and delivery notes. Messages contain the full document details as inline HTML with an optional signature, and every send attempt is recorded in the email log.
- **Search** across customers, suppliers, products, orders, invoices and POS tickets.
- **Auth and roles** — session login, CSRF protection, flash messages and `admin` / `manager` / `staff` permissions.
- **Settings** — company profile, currency, default tax rate, document footer, SMTP/email settings and user management.
- **Dark mode**, responsive sidebar and mobile layout.

---

## Requirements

- Node.js **18 or newer**
- MySQL **8.x** (local or remote)
- Optional: an SSH server that can reach MySQL, if you use the tunnel

---

## Quick start

```bash
# 1. install dependencies
npm install

# 2. create your environment file
copy .env.example .env      # Windows
cp .env.example .env        # macOS / Linux

# 3. edit .env with your database details, then create the schema and demo data
npm run db:setup

# 4. build the Tailwind stylesheet
npm run build:css

# 5. start the app
npm run dev
```

Open <http://localhost:3000> and sign in with:

| Email | Password |
| --- | --- |
| `admin@werp.local` | `Admin123!` |

> Change the password and `SESSION_SECRET` before using the app for real data.

The seed script creates a demo company, **Aurora Lighting Works**, with customers and their warehouses, suppliers, employees, products, BOMs, orders (including customer order numbers, destinations, docking stations and reception times), invoices, customer receipts, supplier payments, checks, deliveries, production orders and POS demo shops/sales. It skips seeding when customers already exist; use `FORCE_SEED=1 npm run db:seed` to add another demo data set. `FORCE_SEED=1` also clears the existing POS demo tables before reseeding them.

To add POS demo data to a database that is already seeded, run `npm run db:seed-pos`. Use `FORCE_SEED=1 npm run db:seed-pos` to replace the current POS locations and sales. This deliberately deletes existing POS records, but never touches products, stock or Unit #1 documents.

---

## Environment variables

All settings live in `.env` (see `.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables secure cookies and hides error details. |
| `PORT` | `3000` | HTTP port. |
| `SESSION_SECRET` | dev fallback | Long random string used to sign session cookies. |
| `DB_HOST` | `127.0.0.1` | MySQL host. With SSH tunneling this is usually `127.0.0.1` (the local forwarded port). |
| `DB_PORT` | `3306` | MySQL port. |
| `DB_USER` | `root` | MySQL user. |
| `DB_PASSWORD` | empty | MySQL password. |
| `DB_NAME` | `werp_erp` | Database name. |
| `DB_SSL` | `false` | Enable TLS to MySQL. |
| `DB_SSH_ENABLED` | `false` | Turn the SSH tunnel on. |
| `SSH_HOST` / `SSH_PORT` | — / `22` | SSH server. |
| `SSH_USER` | — | SSH user. |
| `SSH_PASSWORD` | empty | SSH password (or use a key). |
| `SSH_PRIVATE_KEY_PATH` | empty | Path to a private key. Relative paths are resolved from the project root. |
| `SSH_PRIVATE_KEY_PASSPHRASE` | empty | Passphrase for the private key. |
| `DB_REMOTE_HOST` | `127.0.0.1` | MySQL host **as seen from the SSH server**. |
| `DB_REMOTE_PORT` | `3306` | MySQL port **as seen from the SSH server**. |

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Using an SSH tunnel

Set:

```env
DB_SSH_ENABLED=true
SSH_HOST=erp.example.com
SSH_PORT=22
SSH_USER=deploy
SSH_PRIVATE_KEY_PATH=C:/keys/erp_deploy
# or SSH_PASSWORD=...
DB_REMOTE_HOST=127.0.0.1
DB_REMOTE_PORT=3306

# The app connects to this local forwarded port:
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USER=erp_user
DB_PASSWORD=secret
DB_NAME=werp_erp
```

On startup the app opens a local port forward from `DB_HOST:DB_PORT` to `DB_REMOTE_HOST:DB_REMOTE_PORT` through the SSH server, then MySQL connects to the local forwarded port. The tunnel is closed during graceful shutdown and reconnects if the SSH connection drops.

---

## Database scripts

```bash
npm run db:migrate    # apply src/db/schema.sql (idempotent CREATE TABLE IF NOT EXISTS)
npm run db:seed       # insert demo data if the database is empty
npm run db:seed-pos   # add POS demo shops and sales to an existing database
npm run db:setup      # migrate + seed
```

The schema is in `src/db/schema.sql`. Money is stored as `DECIMAL(14,2)`, quantities as `DECIMAL(14,3)`. Document numbers are generated per year, e.g. `SO-2026-0001`, `INV-2026-0001`, `PO-2026-0001`, `BILL-2026-0001`, `DLV-2026-0001`, `PRD-2026-0001`, `RCP-2026-0001` for customer receipts, `PMT-2026-0001` for supplier payments and `CHK-2026-0001` for checks.

## Outgoing email

Email is configured from **Company settings → Email settings** (or **System → Email settings**). Administrators and managers can change it; staff can view the configuration and email log.

1. Enter the SMTP host and port. Port `587` normally uses STARTTLS, while port `465` normally uses implicit TLS.
2. Enter the sender name and sender email address. If the SMTP server requires authentication, add the username and password. Leave the password blank when editing to keep the stored one.
3. Add an optional email signature. When it is blank, the company name is used.
4. Save the settings, then use **Send a test email** to confirm the connection.

The SMTP password is stored in the `settings` table and is never rendered in the browser. Use an app-specific password when your provider supports it. Sending uses `nodemailer`; the database schema adds an `email_log` table that records successful and failed attempts, the recipients, subject, message and the user who sent it.

Open an order, invoice, payment or delivery and choose **Email** to compose a message. The recipient defaults to the party email address, and the message includes the document details, totals and signature as inline HTML. Attachments are not generated.

## Checks integration test

Start the app with `npm run dev` (or `npm start`) and, in another terminal, run:

```bash
npm run test:checks
```

The test logs in with the seeded admin account, creates its own customer, supplier, invoices, payments and checks, verifies the check lifecycle and payment integration, and removes everything it created. Run it against a development database, not production.

---

## Common workflows

### Customer warehouses and sales orders

1. Open a **customer** and choose **Warehouses → New warehouse**. Add each location where the customer receives purchases (name, optional code, contact and address). Warehouses are independent from the customer's billing address.
2. Create a **sales order**, select the customer, then choose one of that customer's warehouses. An order can only use a warehouse owned by its own customer.
3. Optionally enter the customer's own **order number**, the **docking station** and the **reception date/time**. Existing orders and orders created by older clients fall back to the customer's first warehouse (a default “Main warehouse” is created when needed).
4. Warehouses used by sales orders cannot be deleted; mark them **inactive** instead.

### Sales order to delivery

1. Create a **sales order** and add line items. Set the customer's order number and destination warehouse.
2. Set it to **confirmed**.
3. Open **Deliveries → New delivery**, pick the order and enter the quantities to ship.
4. The delivery stays **pending** until you mark it **shipped**. Shipping reduces product stock, records stock movements and updates the sales order's fulfilment status.
5. Mark it **delivered** once the customer receives it. The delivery detail page and packing slip show the customer order number, destination warehouse, docking station and reception date/time resolved from the sales order.

### Purchase invoice and stock

1. Create a **purchase order** for raw materials.
2. Create a **purchase invoice** (bill), either directly or prefilled from the order.
3. When the bill is set to **received** or **paid**, stock is posted in. Reverting the status reverses the stock movement.

### Customer receipts and supplier payments

1. Open **Customer payments → New customer payment** (or use **Record payment** on an open sales invoice). Select the customer, payment date and reference.
2. Tick the open sales invoices covered by the receipt. Leave an amount blank to apply the full outstanding balance, or enter a smaller amount for a partial payment.
3. Add one or more payment methods: cash, bank transfer, the customer's own check or an endorsed third-party check. Each method can carry its own reference, bank/issuer and check date.
4. Add customer **credit notes** or **tax withholdings** when they reduce the amount collected. For supplier payments, add **credit notes** that reduce the amount paid or **debit notes** that add an amount due.
5. The summary shows total sources, the amount applied to invoices and any **unapplied credit**. A receipt larger than the invoice balance leaves the difference as customer credit; a payment larger than the supplier balance leaves supplier credit.
6. Open the receipt and choose **Print / PDF** for a customer payment order. Payments are immutable: use **Reverse** to remove a payment and restore the invoice balances and statuses.

### Email a document

1. Configure SMTP under **Company settings → Email settings** and send a test message.
2. Open an order, invoice, payment or delivery and choose **Email**.
3. Check the recipient, optional CC, subject and message. The document body and signature are added automatically.
4. Send the message. The result appears in **System → Email log**, and recent sends for the same document are shown on the compose page.

### Check portfolio

1. Open **Treasury → Checks** to see every received, deposited, endorsed, paid, rejected and expired check, with totals for open and available value.
2. Create a check manually when it arrives outside a payment, or let a customer payment with a check method create an **available** received check automatically. A supplier payment with a check method creates an **issued** check, already **endorsed** to that supplier.
3. When endorsing a supplier payment, choose an existing available check in the payment method row to reuse the check record instead of creating a duplicate. The check moves to **Endorsed** and keeps its original customer and receipt history.
4. On the check detail page, use **Change status** to record deposits, endorsements, settlement, rejection or expiry. Every change is written to the check history with its date, user and optional note.
5. Linked checks appear on the payment page. Reversing a payment detaches its checks; checks created by that payment and not moved further are removed, while checks already deposited or endorsed are kept and, when appropriate, returned to **Available**.

### Manufacturing

1. Create an **active BOM** for a finished product and add its components with quantities and scrap percentages.
2. Create a **production order** from the BOM (optionally linked to a sales order).
3. Release the order, then start production.
4. **Complete** the order: the system checks material availability, consumes components, records stock movements and adds the finished quantity to stock. If stock is short, completion is blocked with a clear error.
5. Sales orders can also generate production orders for their manufactured products from the order detail page.

### Point-of-sale reporting

1. Create the shops under **Point of Sale → Points of sale**, each with a short code such as `OAK-01`.
2. Open **POS sales → New sale**, choose the shop, ticket type and ticket number, then add the products that were sold.
3. Ticket numbers are unique per shop and ticket type. POS sales record the shop, ticket, date, payment method and optional customer.
4. The **POS dashboard** shows revenue, tickets, average ticket, units, trends, product rankings and category performance for the selected date range. The POS **Sales** and **Performance** pages add filters and pagination.
5. POS sales are reporting-only. They do not post stock movements or change product stock quantities; Unit #1 sales, deliveries and manufacturing remain the inventory source of truth.

---

## Roles

| Role | Access |
| --- | --- |
| `admin` | Everything, including users and company settings. |
| `manager` | All operational modules and company settings, but not user administration. |
| `staff` | Day-to-day records, orders, deliveries and production. Cannot change company settings. |

Guards are implemented with `requireRole()` in `src/middleware/web.js`.

---

## Project structure

```
src/
  app.js                 Express app, middleware, route mounting, error pages
  server.js              Startup, DB connection, graceful shutdown
  config.js              Environment configuration
  assets/tailwind.css    Tailwind source and component classes
  db/
    schema.sql           MySQL schema
    index.js             mysql2 pool + transaction helpers
    migrate.js           Schema runner
    seed.js              Demo data
    posSeed.js           Deterministic POS demo shops and sales
    seedPos.js           CLI for adding POS demo data
  lib/
    helpers.js           Formatting, badges, pagination, status metadata
    settings.js          Cached company settings
    sequences.js         Per-year document numbering
    production.js        BOM snapshots and production completion
    checks.js            Check statuses, history, payment links and reversal
    documentTypes.js     Shared order/invoice definitions
    email.js             SMTP transport, validation and email rendering
    emailDocuments.js    Document loaders and email content builders
    barcodes.js          EAN-13/DUN-14 check digits and SVG barcode rendering
  middleware/web.js      Sessions, CSRF, locals, auth and role guards
  routes/                One router per module
  views/                 EJS layouts, pages and partials
public/
  css/app.css            Built Tailwind stylesheet
  js/                    Sidebar, theme, confirmations, order and BOM editors
  favicon.svg
```

---

## Front-end notes

- Tailwind is built with the CLI: `npm run build:css` for a minified build, `npm run watch:css` while developing.
- ApexCharts is served from `node_modules` at `/vendor/apexcharts/apexcharts.min.js`, so the dashboard works without a CDN.
- Fonts are loaded from Google Fonts (Outfit). If the app runs offline, self-host the font or remove the link in `src/views/layouts/head.ejs`.
- Dark mode is controlled by the `dark` class on `<html>` and persisted in `localStorage`.

---

## Production checklist

- Set `NODE_ENV=production`.
- Use a long random `SESSION_SECRET`.
- Create a dedicated MySQL user with rights only on the ERP database.
- Put the app behind a reverse proxy with HTTPS (secure cookies are enabled in production).
- Build the CSS before deploying (`npm run build:css`).
- Keep backups of the MySQL database, including the `sessions` table if you want sessions to survive a restore.
