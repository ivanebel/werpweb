# WerpWeb ERP

A compact, web-based ERP for small manufacturing companies. It covers the commercial side of the business — customers, suppliers, employees, sales, purchasing, deliveries and retail point-of-sale reporting — and the shop floor side with bills of materials and production orders.

Built with **Node.js + Express**, **EJS** server-rendered views, **MySQL 8** and a **Tailwind CSS / TailAdmin** style interface. The MySQL connection can be routed through an **SSH tunnel** when the database is not directly reachable.

---

## Features

- **Dashboard** with revenue and purchasing trends, sales by category, production pipeline, low-stock alerts, recent orders and outstanding invoices (ApexCharts).
- **Contacts** - customers, suppliers and employees with full CRUD, search, filters and detail pages. Customer lists show the outstanding receivable balance and supplier lists show the outstanding payable balance, net of unapplied payment credits. Employee detail pages show current shift assignments and recent attendance.
- **Shifts and attendance** - define working schedules (start/end time, working days, tardiness and early-leave grace), assign employees with effective dates and per-employee grace overrides, and review a weekly attendance register. Each row is an employee and each column a day; cells show clock-in/out times, worked duration, punctuality color and late/early/overtime badges. The panel navigates between weeks, filters by employee and summarises worked hours, punctuality, tardiness, early leaves, overtime, absences and incomplete records. Employees can store a **Clock ID**, and a JSON file exported by the time clock can be previewed and imported in bulk; multiple punches per day are paired to calculate worked time, while odd punch counts and missing scheduled days are marked **Incomplete**.
- **Customer and supplier account dashboards** - open a per-party snapshot from the customer or supplier list/detail page. It shows the net receivable/payable balance, overdue and not-yet-due amounts, unapplied or advance credit, credit-limit usage, invoiced vs paid totals, average days to pay, open invoice aging, a 12-month billing vs payments chart, recent payments, recent orders and top products.
- **Customer receipts and supplier payments** — record cash, bank transfers, customer checks, endorsed third-party checks or a mix in the same payment. Allocate receipts to open sales invoices, credit notes and tax withholdings; allocate supplier payments to purchase invoices, credit notes and debit notes. Partial payments and overpayments are supported, unapplied amounts become party credit, and customer payment orders can be printed or saved as PDF.
- **Bank accounts** - store our own bank accounts and customer/supplier accounts with bank, account number, CBU, alias and notes. Administrators and managers can manage them from **Treasury → Bank accounts**, and the same accounts appear on the customer and supplier detail pages.
- **Check portfolio** - track every check received from customers or issued/endorsed to suppliers. Each check has a full lifecycle (**Available**, **Deposited**, **Endorsed**, **Paid**, **Rejected**, **Expired**), its own dates, bank, drawer and supplier, linked payments, and a detailed status history. Customer check receipts automatically create available checks; supplier check payments automatically create issued checks, and an available check can be selected when endorsing a supplier payment.
- **Inventory** - products (raw materials, finished goods, for-sale products, consumables, services), brands and categories, including stock levels, reorder warnings, EAN-13/DUN-14 identifiers with live barcode previews and downloadable SVG files, pack/pallet quantities, weighted products with unit weights, cost/sale price breakdowns with color-coded net margins, manufacturing flags, and an optional **Old ID** field for migrating product IDs from another database. **Finished good** is reserved for manufactured products; **For Sale** identifies products that are purchased and resold without a BOM.
- **Sales** — sales orders, sales invoices and deliveries. Orders can be confirmed, invoiced and delivered partially or completely. Each customer can have several receiving warehouses (separate from the billing address). Sales orders store the customer's own order number, a destination warehouse, the docking station and the expected reception date/time; deliveries and their printed documents show these details. Each delivery receives a sequential packing-slip number from an administrator-managed CAI authorization, and packing slips can carry an optional COT code. Packing-slip lines show pallets, boxes, units and weight, calculated from the product packaging data and editable for manual adjustments, with lot and expiry stored for the printable pallet slips (two copies per pallet, with EAN-13/DUN-14 barcodes and a summary QR code). Carrier and transport records store the company, driver, DNI/ID and truck license plate, and those details are printed on the packing slip. Customers can also store their own product codes, which are printed on sales documents and packing slips. Sales and purchase invoices use the ARCA number format `#####-########`, select an active fiscal document type, and support linked packing slips and credit/debit note relations; sales invoices also store CAE data and the optional MiPyME credit-invoice fields. Product pickers in sales orders, purchase orders and invoices are editable autocomplete fields that search by brand, product name or SKU and display **Brand - Product Name**.
- **Purchasing** — purchase orders and purchase invoices (bills). Receiving a bill posts stock into inventory.
- **Point of Sale (Unit #2)** — manage several shops as distinct points of sale, record completed POS sales with ticket type, ticket number and shop, and analyse revenue, average ticket, units, product rankings and category performance. POS sales are reporting records only: they do not create stock movements or change Unit #1 inventory.
- **Manufacturing** - bills of materials with fixed components or flexible **material classes**, component quantities and scrap, multi-BOM production orders where each line has its own quantity, lot, expiry and notes, aggregated material requirements across all BOM lines, material availability checks, component consumption and finished-goods posting, plus scale records from the Bizerba GLM-e labeler with lot/date filters, weight statistics, and box/pallet totals. Material classes group interchangeable products (for example cheese brands, film reels or label rolls) with a global priority and a conversion factor to the class unit. Production orders split each class requirement across the available members by priority and stock, allow mixing members, reserve stock for other active orders, and keep the actual member allocation as a snapshot for costing and completion.
- **Finance: costs and profitability** — a management-accounting workspace for fixed, variable, semi-variable and stepped costs. Cost centers and categories organise spending; cost items define recurring amounts or variable drivers such as units, net revenue, material cost, invoices, pallets or labour hours. The analysis dashboard combines BOM-based product costs with sales invoices to show contribution margin, operating profit, break-even revenue and units, margin of safety, cash break-even and product profitability. Monthly actual costs can be entered manually or imported from CSV and compared with the calculated plan. All analytical amounts are net of recoverable VAT.
- **Finance: sales simulator** — build saved sales scenarios with a product/customer basket, monthly quantities, net prices, discounts and optional cost overrides. Each scenario projects revenue, contribution, fixed costs, operating profit, break-even, product and customer margins, a BOM-based purchase plan net of stock and open purchase orders, a production plan and a simplified cash/working-capital estimate. Scenarios can be duplicated, locked, archived and compared side by side.
- **Finance: cash flow** — a 13-week weekly and 12-month monthly cash forecast built from cash account balances, open receivables and payables, collection and payment profiles, open checks, recurring fixed costs and planned cash events. It includes AR/AP aging, collection-rate assumptions, a minimum cash buffer with funding-gap alerts, planned-event and fixed-cost detail, cash snapshots for actual-vs-forecast tracking, CSV export and a settings page. Cash amounts are gross cash movements; non-cash costs and future uninvoiced sales are not forecast automatically.
- **Finance: price analysis** — search competitor product prices from the bundled Python scraper. Results are grouped by retailer (DIA and Carrefour), sorted from the lowest price, summarised with price ranges and averages, and each product opens the original store page in a new tab. The page is restricted to administrators and managers; searches are not stored in the ERP.
- **Finance: taxes** - an Argentine-oriented management tax estimate for a date range: VAT by rate (output minus input), Ingresos Brutos by jurisdiction with annual Convenio Multilateral coefficients and rates, IIBB perceptions linked to purchase invoices, withholdings classified from customer payments, and municipal tax. The IIBB base is net sales without VAT, allocated to each jurisdiction by its annual coefficient and then taxed at the jurisdiction rate; perceptions and withholdings reduce the jurisdiction balance. Credit notes reduce the corresponding amounts; a negative net is shown as a credit balance. Administrators configure jurisdictions, coefficients and rates; managers can view the report and enter perceptions/classify withholdings. The report is based on invoices and payments, excludes POS sales, and is not a statutory tax return.
- **Documents** — printable sales orders, purchase orders, invoices and packing slips. Unit prices are tax-inclusive; VAT is displayed as an extracted (included) amount rather than added again.
- **Outgoing email** - configure SMTP in the app and email purchase orders, purchase invoices, sales orders, sales invoices, supplier/customer payment orders and delivery notes. Messages contain the full document details as inline HTML with an optional signature, and every send attempt is recorded in the email log.
- **Telegram bot (read-only)** - link an ERP account from **My profile**, then query active production orders, order details, material shortages, product stock and product prices from Telegram with Spanish commands. The bot is internal-only, read-only, uses long polling (no public webhook required) and does not expose financial reports or customer data.
- **Search** across customers, suppliers, products, orders, invoices and POS tickets.
- **Auth and roles** — session login, CSRF protection, flash messages and `admin` / `manager` / `staff` permissions.
- **Settings** — company profile, currency, default tax rate, document footer, SMTP/email settings and user management.
- **Dark mode**, responsive sidebar and mobile layout.

---

## Requirements

- Node.js **18 or newer**
- MySQL **8.x** (local or remote)
- Optional: Python **3.10 or newer** with the dependencies in `scraper/requirements.txt` for the price-analysis page
- Optional: an SSH server that can reach MySQL, if you use the tunnel

---

## Quick start

```bash
# 1. install dependencies
npm install

# Optional: install the price-analysis scraper dependencies
python -m pip install -r scraper/requirements.txt

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

The seed script creates a demo company, **Aurora Lighting Works**, with customers and their warehouses, suppliers, employees with Clock IDs, shifts and three weeks of attendance, products, BOMs, orders (including customer order numbers, destinations, docking stations and reception times), ARCA-formatted invoices, customer receipts, supplier payments, checks, deliveries, production orders and POS demo shops/sales. It skips seeding when customers already exist; use `FORCE_SEED=1 npm run db:seed` to add another demo data set. `FORCE_SEED=1` also clears the existing POS demo tables before reseeding them.

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
| `TELEGRAM_ENABLED` | `false` | Enable the read-only Telegram production bot. |
| `TELEGRAM_BOT_TOKEN` | empty | Bot token from @BotFather. Keep it secret. |
| `TELEGRAM_BOT_USERNAME` | empty | Optional bot username shown in linking instructions. |
| `APP_PUBLIC_URL` | empty | Public ERP URL used in Telegram order links. |
| `TELEGRAM_POLL_TIMEOUT` | `25` | Long-polling timeout in seconds. |
| `PYTHON_BIN` | `python` / `python3` | Python executable used by the price-analysis scraper. |
| `PRICE_SCRAPER_TIMEOUT_MS` | `90000` | Maximum time for one price search. |
| `PRICE_SCRAPER_SCRIPT` | `scraper/main.py` | Scraper entry point. Relative paths resolve from the project root. |

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

## Telegram bot

The Telegram bot is an internal, read-only way to check production from a phone. It uses long polling, so the ERP does not need a public webhook or an open inbound port.

1. Create a bot with Telegram **@BotFather** and copy its token.
2. Set these variables in `.env`:
   - `TELEGRAM_ENABLED=true`
   - `TELEGRAM_BOT_TOKEN=...`
   - `TELEGRAM_BOT_USERNAME=your_company_bot` (optional, shown in the profile instructions)
   - `APP_PUBLIC_URL=https://your-erp.example.com` (required for clickable order links)
3. Restart the app. The log should show `[telegram] bot @... ready`.
4. Open **My profile** in the ERP and choose **Generate linking code**.
5. Send `/vincular CODIGO` to the bot. The code expires after 10 minutes.
6. Use these commands in Spanish:
   - `/produccion` — active orders
   - `/produccion planificadas`, `/produccion liberadas`, `/produccion en-proceso`, `/produccion todas`
   - `/orden PRD-2026-0006` — order detail
   - `/faltantes` — active orders with material shortages
   - `/stock 32` - stock for SKU-00032 (you can omit the `SKU-` prefix and leading zeros)
   - `/price 32` - product brand, name, gross/net cost and gross/net sale price for SKU-00032
   - `/desvincular` - remove the Telegram link
7. The order link opens the read-only production page. Users must be signed in to the ERP in their browser.

Only linked, active ERP users can query. Every command is written to `telegram_audit_log`. The bot never changes data. Price queries include the product cost price, so only link users who are allowed to see it. Automatic notifications are not implemented yet.

If the app runs in multiple processes or containers, only one process should run the Telegram poller; otherwise Telegram returns a conflict error.

## Checks integration test

Start the app with `npm run dev` (or `npm start`) and, in another terminal, run:

```bash
npm run test:checks
```

The test logs in with the seeded admin account, creates its own customer, supplier, invoices, payments and checks, verifies the check lifecycle and payment integration, and removes everything it created. Run it against a development database, not production.

Finance calculation helpers have standalone unit checks that do not touch the database:

```bash
npm run test:finance
npm run test:simulator
npm run test:materials
npm run test:cashflow
npm run test:prices
npm run test:taxes
npm run test:telegram
```

`npm run test:materials` checks the material-class allocation and costing helpers without a database. `npm run test:manufacturing` uses the configured development database: it creates its own products, class, BOM and production orders, verifies reservation and completion behaviour, and removes everything it created.

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
3. Open **Deliveries → New delivery**, pick the order and enter the quantities to ship. Select the **carrier/transport** and confirm the driver, DNI/ID and license plate. If required, add the optional **COT** merchandise code. The packing slip number is assigned sequentially from the active **CAI** authorization, and the pallet, box, unit and weight quantities are calculated from the product packaging data. They can be adjusted per line before saving or later from **Edit packing quantities**.
4. The delivery stays **pending** until you mark it **shipped**. Shipping reduces product stock, records stock movements and updates the sales order's fulfilment status.
5. Mark it **delivered** once the customer receives it. The delivery detail page and packing slip show the customer order number, destination warehouse, docking station and reception date/time resolved from the sales order.

### Standalone packing slips

1. Open **Deliveries** and choose **Standalone packing slip**. Use this for repairs, samples, or any movement that is not linked to a sales order.
2. Choose a **customer or supplier** as the recipient, the delivery date and the carrier details.
3. Add one or more manual lines with an editable **description**, quantity, unit, packing quantities, lot and expiry. The lines do not need to reference products in the catalog.
4. The packing slip number comes from the same active **CAI** authorization as regular deliveries. These slips can be printed, emailed and given pallet slips like any other packing slip.
5. Standalone slips do not update stock. They move through **pending → shipped → delivered** or can be cancelled, and their status changes never create stock movements.
6. While a standalone slip is pending, edit it to change the recipient, carrier, notes or lines. Regular sales-order deliveries keep their existing stock and fulfilment behavior.

### Pallet slips

1. Open a delivery and choose **Print pallet slips**, or use the same link from the packing slip or **Edit packing quantities** pages.
2. Set the **lot** and **expiry date** per line on **Edit packing quantities**. When the sales order has production lines with a lot/expiry, those values are offered as defaults; the values saved on the delivery always take precedence.
3. The pallet-slip page creates **one slip per pallet, in two copies**, so each pallet can be labelled on two sides. Pallets are rounded up from the packing quantities; a line with units but no pallet count still produces one slip.
4. Each slip shows the brand and product name, customer product code, EAN-13, customer, customer purchase order, delivery totals for units/boxes/weight, lot and expiry. The EAN-13 and derived DUN-14 barcodes are printed at the bottom, and a QR code summarising the slip is placed in the middle-left area.
5. Units, boxes and weight are **delivery totals**, not per-pallet totals, and are shared by every slip in the delivery.
6. Use **Print / Save PDF** to print. Each slip is an A4 page and page breaks are inserted automatically.

### Costs and profitability

1. Open **Finance → Costs & profitability**. The workspace is restricted to administrators and managers.
2. In **Cost setup**, create the cost centers (for example production, administration, sales and logistics) and cost categories (rent, payroll, utilities, insurance, freight, packaging, commissions).
3. Create **cost items**:
   - **Fixed** or **stepped** costs have a recurring amount and frequency (monthly, quarterly, annual or one-off).
   - **Variable** costs have a driver: units sold, percentage of net revenue, percentage of material cost, invoices, pallets or labour hours.
   - **Semi-variable** costs have both a fixed amount and a variable driver.
   - A variable cost can apply company-wide, to one product or to a product category.
4. Enter **monthly actual costs** and compare them with the calculated recurring plan and variable drivers.
5. Use **Import CSV** on the monthly actuals page to upload many actuals at once. The file needs `cost_item`, `period`, `amount` and an optional `notes` column. `cost_item` can be the exact name or the numeric ID; invalid rows stop the whole import. A template with one row per active cost item can be downloaded from the import page.
6. The dashboard shows net revenue, contribution margin, fixed costs per month, operating profit, break-even revenue and units, margin of safety, cash break-even and product profitability. Product material cost uses the active BOM when available; otherwise it uses the product's net cost.
7. Costs can be entered VAT-inclusive or net. Recoverable VAT is extracted so all analytical amounts use a consistent net basis. Depreciation and other non-cash fixed costs can be flagged and are excluded from cash break-even.
8. One-off costs affect operating profit for the period but are excluded from the recurring break-even point.
9. Revenue and units come from non-draft sales invoices in the selected month. Credit notes reduce revenue and units. Unit #2 POS sales are not included in this analysis.

### Sales simulator

1. Open **Finance → Sales simulator** and create a scenario. Choose the start month, horizon (up to 24 months) and working-capital assumptions.
2. Add products to the sales basket, choose an optional customer, and enter the planned quantity for each month. **Load last 12 months** fills the basket from the average monthly invoiced sales in the 12 months before the scenario. Use **Fill all months**, **Copy first month** or **Apply growth** for quick adjustments.
3. Prices are net of VAT. Leave the price blank to use the product's current net sale price. Discounts are applied per line.
4. Optionally override cost items in **Cost overrides**. Overrides are net amounts and apply to every month.
5. Save the scenario to see:
   - monthly revenue, material cost, other variable costs, contribution, fixed costs and operating profit;
   - break-even revenue, break-even units and margin of safety;
   - product and customer margins;
   - a purchase plan net of stock and open purchase orders, with order-by dates based on lead times and quantities rounded to product minimums and order multiples; material classes are planned as one class requirement and any purchase is assigned to the preferred member;
   - a production plan for manufactured products;
   - a simplified cash and working-capital projection using collection, payment and inventory days.
6. Product purchasing fields are maintained in the product form under **Purchasing**: lead time, minimum order quantity and order multiple.
7. Use **Export CSV** for the monthly projection and **Purchase plan CSV** for the purchasing detail. Duplicate, lock or archive scenarios from the results page, and select two or more scenarios on the list page to compare them.

### Cash flow

1. Open **Finance → Cash flow**. The workspace is restricted to administrators and managers.
2. Add each active **cash account** under **Cash accounts** with its type and current opening balance. The forecast starts from the sum of active account balances.
3. Review **Cash flow settings** to set the minimum cash buffer, the week start day, the supplier payment delay and the collection rate and delay for each receivable aging bucket.
4. The forecast includes open sales invoices and credit notes (using the collection profile), open purchase bills and credit notes (paid in full after the supplier delay), open received and issued checks (by due date), recurring fixed costs from the cost module (gross of VAT and excluding non-cash items) and **planned cash events** such as taxes, payroll, loans or capex.
5. Switch between the **Weekly** (13 weeks) and **Monthly** (12 months) views. The dashboard shows opening and closing cash, the lowest cash point, funding gap, net movement and periods below the buffer, with an ApexCharts inflow/outflow projection.
6. Use the aging, receivable, payable, check and event tables to see what drives each period. **Export CSV** downloads the selected view.
7. Under **Actual cash**, enter a balance snapshot for each active cash account. A period shows actual cash and variance only when every active account has a snapshot inside that period and the snapshot is not future-dated.
8. Future sales that are not invoiced yet are not forecast automatically. Add planned cash events for expected receipts, or use the sales simulator for what-if planning.

### Price analysis

1. Install Python 3 and the scraper dependencies once per server: `python -m pip install -r scraper/requirements.txt`.
2. Open **Finance → Price analysis**. The workspace is restricted to administrators and managers.
3. Enter a product name or brand, for example `tybo`, and choose **Search prices**. The server runs `scraper/main.py` with the search text as a single argument.
4. Results are grouped by retailer (DIA and Carrefour), sorted by price from lowest to highest. The summary cards show the number of products, the lowest and highest prices and the overall average.
5. Each **Open** button opens the original product page in a new tab. Prices are shown in ARS unless the scraper returns a different `currency`.
6. Searches require outbound internet access from the server. The timeout is 90 seconds by default and can be changed with `PRICE_SCRAPER_TIMEOUT_MS`. Use `PYTHON_BIN` if Python is not on the server's `PATH`.
7. Search results are displayed only for the current request; they are not saved in the ERP. If a store is unavailable, its section is empty and the other retailer's results are still shown.

### Taxes

1. Open **Finance → Taxes**. Administrators and managers can view the report. **Tax settings** are restricted to administrators.
2. In **Tax settings**, create the jurisdictions you need (for example CABA, Buenos Aires or Córdoba). For each one set:
   - **Default coefficient %**: fallback used when no annual Convenio Multilateral coefficient exists for the report year.
   - **IIBB rate %** and **municipal rate %**.
   - The **default jurisdiction** supplies the municipal rate and is highlighted in the report.

   `npm run db:migrate` creates the tax tables and a **Main jurisdiction** placeholder with 0% rates. Rename it and set the real rates before relying on the estimate.
3. In **Tax settings**, the **Default coefficient %** is a fallback used when no annual Convenio Multilateral coefficient exists for the report year. Set the **IIBB rate %** and **municipal rate %** for each jurisdiction. The **default jurisdiction** supplies the municipal rate and is highlighted in the report.

   `npm run db:migrate` creates the tax tables and a **Main jurisdiction** placeholder with 0% rates. Rename it and set the real rates before relying on the estimate.
4. In **Convenio Multilateral coefficients**, choose the fiscal year and enter each active jurisdiction coefficient. Coefficients must total 100%. Saving stores them for that year, so reports for previous periods keep using the coefficients agreed for that year.
5. Choose a date range (defaults to the current month) and review:
   - VAT by rate: output VAT minus input VAT.
   - Ingresos Brutos by jurisdiction: net sales without VAT × the jurisdiction coefficient × its IIBB rate, less perceptions and IIBB withholdings.
   - Municipal tax: gross sales × the default jurisdiction municipal rate.
   - Other withholdings (income tax and other), shown separately from IIBB.
6. Use **IIBB perceptions** to record perceptions or levies printed on purchase invoices. Select a received, paid or overdue purchase invoice, a jurisdiction and the amount. Credit notes reduce the jurisdiction total.
7. Use **Tax withholdings** to classify the withholding adjustment lines recorded on customer payments as IIBB (with a jurisdiction), income tax or other. Unclassified withholdings are shown as a warning and do not reduce IIBB.
8. The report includes sales invoices with status sent/paid/overdue and purchase invoices with status received/paid/overdue. Draft, cancelled and POS sales are excluded. Credit notes reduce the corresponding amounts in their document period.
9. The report uses the coefficients stored for the year of the selected start date. If the selected range spans more than one year, the report warns you; run a separate report per year.
10. This is a management estimate, not a statutory tax return. Confirm rates, coefficients and treatment with your accountant.

### Purchase invoice and stock

1. Create a **purchase order** for raw materials.
2. Create a **purchase invoice** (bill), either directly or prefilled from the order.
3. When the bill is set to **received** or **paid**, stock is posted in. Reverting the status reverses the stock movement.
4. For historical bills whose stock was already handled outside the ERP, use **Mark as received (no stock)** on the bill, or tick **Do not update stock** on the form before setting the status to Received or Paid. The invoice is marked as received but no stock movement is created, and the bill shows a **Stock not posted** badge. This flag is permanent for that invoice; later status changes do not post stock.
5. Sales invoices never post stock directly. Sales stock is reduced when a **delivery** is marked as shipped.

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

### ARCA invoices

1. When creating or editing a sales or purchase invoice, enter the invoice number as `point of sale-document`, for example `10-1450`. It is normalized and stored as `00010-00001450`. Existing historical numbers are preserved until you choose to renumber them.
2. Choose a **Fiscal document type** from the active ARCA types imported from `TABLACOMPROBANTES.xlsx`. The code is stored with the invoice; inactive types are hidden from new documents. Use **999 — DOCUMENTO NO FISCAL** for internal sales or purchase records that have no actual fiscal document; no CAE is required for that type.
3. Sales invoices have **CAE number** and **CAE expiry date** fields. The CAE is optional until the ARCA connection is implemented, but when present it must contain exactly 14 digits. A **CAE pending** badge is shown when it is missing.
4. The collapsible **MiPyME credit invoice options** section at the bottom of the sales-invoice form stores the CBU, transfer option (`ADC`/`SCA`) and payment expiry date used by certain FCE document types.
5. Sales invoices can link one or more **packing slips (remitos)** from the selected customer. Purchase invoices store an optional supplier remito number.
6. Credit and debit notes can link one or more regular invoices for the same party. The related invoices/notes appear on the detail and print pages.

### Importing ARCA sales invoices from the QR

1. Open **Sales invoices** and use **Import ARCA PDF**, or open a draft sales invoice and use the same button to fill that draft. Every logged-in user can import.
2. Choose the ARCA PDF. Only the first page is scanned, so Factura A/B files with several copies work as expected. The PDF is decoded in the browser with PDF.js and jsQR; it is never uploaded or stored.
3. If the QR cannot be read, paste the QR link or base64 payload shown on the invoice. The official ARCA verification page may ask for a CAPTCHA, so this import does not depend on it.
4. Review the extracted data: invoice number, date, fiscal document type, issuer CUIT, customer document, total, currency, CAE and verification link. The CAE expiry date is prefilled with the invoice date; adjust it if ARCA shows a different date.
5. Choose the customer and confirm. Discrepancies are warnings, not errors. Imported data stays in **draft** status.
6. When importing into an existing draft, the invoice number, date, customer, fiscal type, CAE and expiry are updated, but the invoice total and line items are left untouched. A total mismatch is shown as a warning. Creating a new import produces a draft header without line items; add them from the edit page before sending.
7. Unsupported currencies (anything other than `PES`) and structurally invalid QR payloads are rejected. The raw QR payload, warnings, PDF file name and SHA-256 are stored in `sales_invoice_imports` for auditing; the PDF itself is not kept.

The QR is treated as a data-entry helper, not as proof of authenticity. Run the parser checks with `npm run test:arca-qr`.

### Customer and supplier account dashboards

1. Open **Contacts → Customers** or **Contacts → Suppliers** and click the chart icon on a row, or open the party and use **Account dashboard**.
2. The dashboard shows the net receivable/payable balance (open invoice balance less unapplied credit), overdue and not-yet-due amounts, open invoice count, unapplied/advance credit and total invoiced/purchased versus paid.
3. Customer dashboards also show credit-limit usage and available credit. Both types show average days to pay, average days overdue and the last payment date.
4. The aging card splits the outstanding balance into current, 1–30, 31–60, 61–90 and 90+ day buckets. Overdue is based on the invoice due date.
5. The 12-month chart compares invoiced sales (or purchases) with recorded payments. Below it are the open invoices/bills, recent payments, recent orders and top products for the last year.

### Shifts and attendance

1. Open **Contacts → Shifts** and create a schedule: name, start/end time, working days, and the tardiness and early-leave grace periods. Overnight schedules are supported when the end time is earlier than the start time.
2. Open the shift and use **Assign employee** to attach employees. Assignments have an effective period; a new open-ended assignment automatically closes the previous one the day before it starts, and overlapping periods are rejected.
3. Use the optional grace overrides on an assignment when an employee regularly arrives later or leaves earlier than the rest of the team.
4. Open **Contacts → Attendance** to see the weekly register. Move between weeks with **Previous week** / **Next week**, filter by employee, and click a day cell to add or edit its clock-in/clock-out record.
5. Metrics are calculated from the assignment effective on the work date: worked minutes, late minutes, early-leave minutes, overtime, grace snapshots and punctuality. Records with no clock-out are marked **Incomplete**, and scheduled days before today without a record are counted as **Absent**.

### Importing time-clock records

1. Set the **Clock ID** on each employee under **Contacts → Employees**. This is the identifier used by the physical time clock and is how the import matches records; names are not used for matching.
2. Open **Contacts → Attendance → Import JSON** and choose the `.json` file exported by the clock. The expected structure has `date_from`, `date_to` and an `employees` array whose entries contain `employee_id` (the Clock ID), an optional `employee_name`, and a `records` object keyed by date with a `daily_record` array of times.
3. The preview shows how many employees matched, unmatched Clock IDs, employees missing from the file, punches, records to write, existing records that will be replaced and incomplete days. Nothing is saved until the import is confirmed.
4. An employee can punch more than twice a day. Punches are paired in order (first → second, third → fourth) and worked time is the sum of those pairs, so short errands between pairs are not counted as worked time.
5. An odd number of punches is saved as **Incomplete**. Because the file is treated as the complete record for its date range, scheduled days without punches — including days for active employees with a Clock ID who are missing from the file — are also saved as **Incomplete** rather than absent.
6. Existing attendance records for the matched employees and dates are replaced by the imported values. Re-importing the same file is safe: it updates the existing records instead of duplicating them.

### Manufacturing

1. Create an **active BOM** for a finished product and add its material lines. A line is either a **fixed component** or a **material class** with a class quantity and scrap percentage.
2. Material classes are managed by administrators and managers under **Manufacturing → Material classes**. Each class has a unit (for example `kg` or `unit`) and a list of interchangeable product members. Lower priority numbers are preferred. The **conversion factor** is the number of class units supplied by one member unit: a 20 kg film reel is `20`, a 2,500-label roll is `2,500`, and a 10 kg cheese box is `10`.
3. The BOM cost for a class line uses the preferred member cost and shows the substitution range from the cheapest to the most expensive active member. Existing fixed-component BOMs keep working unchanged.
4. Create a **production order** and add one or more **BOM lines**, each with its own quantity, lot number, expiry date and notes. The order can optionally be linked to a sales order.
5. Review the **material requirements**. Class requirements are converted into member quantities by priority and available stock, excluding stock reserved by other planned, released or in-progress orders. Use **Edit allocation** to change the split manually or **Recalculate** to reset it to the priority allocation.
6. **Complete** the order: the system checks shortages and stock, consumes the allocated member products, records stock movements with the snapshotted unit costs, and adds every finished product to stock. Completion is blocked while a requirement still has a shortage.
7. Sales orders can also generate a production order with lines for their manufactured products from the order detail page.

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
    production.js        BOM snapshots, material allocation and production completion
    materials.js         Material classes, member costs, stock and BOM costing
    telegram/            Telegram bot client, commands, links and read-only queries
    checks.js            Check statuses, history, payment links and reversal
    finance.js           Cost items, periods and profitability calculations
    simulator.js         Sales scenario, purchase plan and cash calculations
    cashflow.js          AR/AP, checks, fixed costs, events and cash forecast
    priceAnalysis.js     Safe Python runner and competitor-price normalizer
    taxes.js             VAT, IIBB, perceptions, withholdings and municipal tax
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
scraper/
  main.py                Price scraper entry point (JSON on stdout)
  dia.py                 DIA / VTEX source
  carrefour.py           Carrefour / VTEX source
  vtex.py                Shared VTEX product-search parser
  requirements.txt       Python dependencies
```

---

## Front-end notes

- Tailwind is built with the CLI: `npm run build:css` for a minified build, `npm run watch:css` while developing.
- ApexCharts is served from `node_modules` at `/vendor/apexcharts/apexcharts.min.js`, so the dashboard works without a CDN.
- Fonts are loaded from Google Fonts (Outfit). If the app runs offline, self-host the font or remove the link in `src/views/layouts/head.ejs`.
- Dark mode is controlled by the `dark` class on `<html>` and persisted in `localStorage`. A small inline script in the page head applies the saved theme before the stylesheet loads, avoiding a light flash on navigation.
- Palettes are a second, independent dimension stored in `werp-palette` under `localStorage` and exposed as `data-palette` on `<html>`. The **Default** palette keeps the original light/dark design. **Cyberpunk** is dark-only: selecting it forces dark mode and disables the light/dark toggle; switching back restores the previously chosen mode. Palette styles live in `src/assets/cyberpunk.css`, which is imported by `src/assets/tailwind.css`. Default components keep using the existing Tailwind classes; the Cyberpunk file remaps the color utilities used by the views to a neon palette, so new screens that introduce a color class not covered there should add it to that file. Charts read the `--chart-*` CSS variables through `window.werpChartColors()` (`src/views/layouts/head.ejs`), which keeps their axes, grids, tooltips and series colors in sync with the active palette.
- The desktop sidebar can be collapsed manually with the button next to the mobile menu button. The collapsed state is persisted in `localStorage`; on mobile the sidebar remains an overlay.
- CSS and JS links include a per-restart version query (`assetVersion`), so a normal deploy/restart refreshes cached assets without requiring users to hard-refresh.

---

## Production checklist

- Set `NODE_ENV=production`.
- Use a long random `SESSION_SECRET`.
- Create a dedicated MySQL user with rights only on the ERP database.
- Put the app behind a reverse proxy with HTTPS (secure cookies are enabled in production).
- Build the CSS before deploying (`npm run build:css`).
- Keep backups of the MySQL database, including the `sessions` table if you want sessions to survive a restore.
