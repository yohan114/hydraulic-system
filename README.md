# Hydraulic Hose Repair — Inventory & Smart Billing System

A workshop management system for hydraulic hose repair: inventory, invoicing with
Sri Lankan tax calculations (SSCL + VAT), material transaction tracking, and a
**smart, locked, accurate billing** layer. Data is stored in a single **SQLite**
database file (`hydraulic.db`, via `better-sqlite3`); the UI is a Node.js/Express
web dashboard in [`dashboard/`](dashboard/). It runs on **any OS** — no Microsoft
Access or Windows dependency.

## Smart Billing (Lock · Accurate · Smart)

The billing layer was rebuilt so money is trustworthy and invoices are tamper-proof:

- **🔒 Locked invoices** — once an invoice is **finalized it is immutable**: its
  number, amounts and items can no longer be edited. Corrections go through a proper
  **Cancel/Void** flow that automatically restores the stock the invoice deducted.
- **🔒 Login protection** — the dashboard is behind a password (default `admin` /
  `admin123`, change it in-app). Every data API is token-protected.
- **🔒 Race-free numbering** — invoice numbers (`INV/YYYY/MM/nnn`) are allocated
  under a mutex, so two invoices created at the same instant can never collide.
- **🎯 Server-authoritative math** — the server **recomputes** subtotal, SSCL, VAT,
  discount, round-off and grand total from the line items and tax rates. The browser
  can never push a wrong or tampered total into the database.
- **🎯 Accurate rounding** — all money is rounded half-up to 2 decimals using a
  decimal-safe algorithm (e.g. `1.005 → 1.01`), with an optional *round-to-nearest-
  rupee* line. The pure money engine is covered by unit tests (`npm test`).
- **🎯 Validation guards** — rejects empty invoices, zero/negative quantities,
  missing customer, stock shortfalls and duplicate numbers before saving.
- **💡 Payment tracking** — record part or full payments per invoice; each invoice
  shows **Paid / Partially Paid / Unpaid** and a live balance, and the dashboard
  shows total outstanding receivables.
- **💡 Auto price & margin** — line rates auto-fill from inventory, and while billing
  each line shows its **profit margin** and a **below-cost warning** (from the new
  per-item *Unit Cost*).

See [`dashboard/README`](#smart-billing-web-dashboard) below for setup.

## Features

### 📦 Inventory Management
- Add, edit, and delete products with auto-generated unique codes
- Track stock levels with visual indicators
- Quick "Add Stock" function with full transaction logging
- Low stock alerts
- Cost tracking per unit

### 🧾 Invoice Generator
- Professional invoice layout with company logo and details
- Three item types: **Spares**, **Technical Charges**, **Other**
- Automatic tax calculation:
  - Sub Total → SSCL 2.5% → VAT 18% → Discount → Grand Total
- Customer dropdown with quick-add
- Prepared-by e-signature support
- **Auto-deducts materials from inventory** when invoice is finalized
- Save as draft or finalize & print

### 📋 Invoice History
- Browse all invoices with date range and status filters
- View, print, or cancel past invoices
- Cancellation automatically reverses stock deductions

### 🔄 Material Transaction History
- Complete audit trail of all stock movements (IN/OUT/ADJUST)
- Filter by date, product, and transaction type
- Color-coded entries (Green=IN, Red=OUT, Yellow=ADJUST)

## Prerequisites

1. **Node.js** LTS (18+). That's it — no Microsoft Access, no PowerShell, no COM.
2. Works on **Windows, macOS, or Linux**.

## Installation

```bash
cd dashboard
npm install     # installs express + better-sqlite3 (prebuilt binary)
npm start       # serves http://localhost:9999
```

The bundled `hydraulic.db` already contains the inventory, rate card and invoice
history. A fresh database is created automatically if the file is missing.

## First-Time Setup

1. The **Dashboard** opens automatically
2. Set up your **Company Information**:
   - Click the company setup area or navigate to the Company Setup form
   - Enter your company name, address, phone, email, TIN
   - Set your invoice prefix (default: "INV")
3. Add your **Products** to inventory:
   - Click "📦 INVENTORY" on the dashboard
   - Click "+ Add Product"
   - Enter product details — the unique code auto-generates
4. Add your **Customers**:
   - Customers can be added when creating a new invoice
   - Click "+ New Customer" on the invoice form

## Usage Guide

### Adding Stock
1. Go to Inventory → Select a product → Click "+ Add Stock"
2. Enter quantity and remarks → Click "Add"
3. Transaction is logged automatically

### Creating an Invoice
1. Dashboard → "🧾 NEW INVOICE"
2. Select customer (or add new)
3. Add line items:
   - **Spare**: Select from product dropdown (auto-fills description and price)
   - **Technical Charge**: Enter description and price manually
   - **Other**: Enter any additional charges
4. Review totals (SSCL, VAT, discount auto-calculated)
5. "Save Draft" to save without deducting stock
6. "Finalize & Print" to lock, deduct stock, and print

### Cancelling an Invoice
1. Dashboard → "📋 INVOICE HISTORY"
2. Find the invoice → Click "Cancel"
3. Stock is automatically restored to inventory

## File Structure

```
hydraulic-system/
├── README.md                  # This file
├── hydraulic.db               # The SQLite database (data lives here)
└── dashboard/
    ├── server.js              # Express app + all API endpoints
    ├── migrate.js             # Idempotent SQLite schema bootstrap + seed
    ├── lib/
    │   ├── db.js              # better-sqlite3 data layer (query/execute)
    │   ├── billing.js         # Server-authoritative totals/tax engine
    │   ├── money.js           # Decimal-safe rounding
    │   └── …                  # finance, invoiceNo, auth, mutex, sql, ratecardSeed
    ├── public/                # Dashboard UI (index.html, app.js, styles.css)
    └── test/                  # Unit tests (npm test)
```

## Job Profit Analysis

The **Job Profit Analysis** screen reads the filtered jobs as three comparisons,
in the order the shop reasons about it — buy, sell, bank:

| Step | Comparison | Answers |
|---|---|---|
| **1 · Buying** | **Our Cost** vs **Outside Cost** | Did buying our way beat buying the same parts from a local supplier? Shown with a side-by-side **profit & loss compare**: same jobs, same billed price, parts sourced two ways. |
| **2 · Selling** | **Our Price** vs **Outside Price** | How far under (or over) the market we billed — what the customer saved by coming to us. |
| **3 · Earning** | **Our Cost** vs **Our Price** | The gross profit actually banked, with margin-on-price and markup-on-cost. |

The three reconcile, and the screen shows the check:

```
our advantage over a competing shop
  = our profit − their profit
  = sourcing gain (step 1) − customer saving (step 2)
```

**Where the four figures come from**

| Figure | Source |
|---|---|
| Our Cost | `InvoiceItems.UnitCostAtBilling` (billing-time snapshot) → else `Inventory.Cost` |
| Outside Cost | `Inventory.MarketLow` (local trade price) → else the matched Rate Card **Outside Low** band → else the line's outside price × the card's own median Low/Mid ratio, tagged **est** |
| Our Price | `qty × Rate` actually billed |
| Outside Price | `InvoiceItems.MarketBillRate` (snapshot) → else `Inventory.MarketMid` |

Notes that keep the numbers honest:

- All three comparisons run **ex-tax**. Invoices written before SSCL/VAT were
  dropped still carry tax in their `GrandTotal`; that tax is collected for the
  state, not shop income, so it is reported separately instead of inflating margin.
- Estimated and missing benchmarks are **labelled, not hidden** — each line shows
  its basis, and notes under steps 1 and 2 say how many lines came from where.
- Unlike cost and market price, outside cost is **not** snapshotted at billing
  time; it resolves when the report runs, so filling in `MarketLow` improves
  past jobs too.

### Exports

The screen carries all three comparisons; the **exports deliberately do not**. A
printed sheet gets read cold by someone who was not in the conversation, so both
the Excel and the PDF tell one story, in the shop's own layout:

```
OUR COST  |  OUTSIDE COST  |  PROFIT      per invoice
SUMMARY                                   per invoice + total
TECHNICAL / CRIMPING LABOUR               billed, paid, and still owed
REPORT DETAILS                            date range, job count, labour split
```

**REPORT DETAILS** closes the sheet with what it covers: the real date range of
the jobs (not just the filter you typed), how many invoices are in it, how many
carry technical/crimping labour, and the paid-versus-unpaid split in both job
count and rupees. In Excel those counts are `COUNTIF`/`SUMIF` over the Status
column, so flipping a job to `Paid` updates them on the spot.

Here **Outside Cost** is the outside-company benchmark — what the customer would
have paid to go elsewhere — matching the shop's existing spreadsheet. Two rules
apply to the cost side:

- **Crimping and welding are costed at the outside rate.** They are labour we do
  in the shop, so the market charge is taken as the cost of that labour: both
  sides of the sheet carry the same figure and the lines net to nothing, instead
  of crediting a margin on our own time. A *weld fitting* is a part, not labour,
  and keeps its own separate cost and outside price.
- **Every job carries a `Sundry (Electricity) Cost` line at 10%** of its other
  costs — shop overhead, added into Total Our Cost. It has no outside counterpart,
  since an outside bill buries overhead in its own rates.

The two profit columns are different on purpose:

| Where | Formula | Means |
|---|---|---|
| Detail (`Profit`) | `Invoice Total − Total Our Cost` | what we earned on the job |
| Summary (`Profit`) | `Outside Cost − Our Actual Cost` | what the customer gained by coming to us |

The Excel is **live**: every derived cell is a real formula, not a baked value.

| Cell | Formula |
|---|---|
| Amount | `=D4*E4` |
| Total Our Cost | `=SUM(F4:F9)` — includes the sundry line |
| Our rate, crimping/welding | `=I8` — points at the outside rate, so the two stay identical |
| Outside Cost | `=I4*J4` |
| Sundry (Electricity) | `=ROUND(SUM(F4:F8)*0.1,2)` |
| Profit | `=N4-G4` |
| Margin % | `=IFERROR(O4/N4,0)` |
| Total unpaid labour | `=SUMIF(E202:E226,"Unpaid",D202:D226)` |

The summary pulls straight from the detail blocks (`=G52`, `=L52`), so editing a
rate up top flows all the way down; flip a labour Status cell to `Paid` and the
unpaid total drops on its own. The overhead rate lives in one place —
`SUNDRY_RATE` in `services/jobProfitExport.js`.

Both exports are built from one model (`services/jobProfitExport.js`), so the
spreadsheet and the printout can never disagree.

## Tax Calculation

Computed **server-side** (the browser preview mirrors it exactly), rounded half-up
to 2 decimals at every step:

```
Sub Total           =  Σ round2(qty × rate)
SSCL (2.5%)         =  round2(Sub Total × 2.5%)
Pre-VAT             =  Sub Total + SSCL
VAT (18%)           =  round2(Pre-VAT × 18%)
After Tax           =  Pre-VAT + VAT
Discount            =  Manual entry, clamped to [0, After Tax]
Round Off           =  Optional — snap grand total to the nearest whole rupee
─────────────────────────────────────
Grand Total         =  After Tax − Discount (± Round Off)
```

## Smart Billing Web Dashboard

The dashboard in [`dashboard/`](dashboard/) is the UI (Node.js + Express, storing
data in `hydraulic.db` via `better-sqlite3` — a fast, in-process, cross-platform
SQLite driver; no Access/COM install needed).

```bash
cd dashboard
npm install
npm run migrate     # optional: create/upgrade the schema (also runs on boot)
npm start           # serves http://localhost:9999
```

- The server runs the idempotent schema bootstrap automatically on boot, so a
  fresh or older `hydraulic.db` gains any missing tables/columns without manual steps.
- First login: **admin / admin123** — use the **Password** button in the sidebar to
  change it. Set `BILLING_PASSWORD` to change the default, or `BILLING_AUTH=off` to
  disable the login entirely for a trusted single-user machine.
- Run the billing engine's unit tests with `npm test` (pure JS, no database needed).

### Schema migrations

`migrate.js` holds the **baseline** — the schema as it stood before the ERP
conversion — and stays idempotent. Every change from the ERP work onwards is a
numbered migration in `migrations/NNNN-name.js`, applied once and recorded in
`SchemaVersion`.

```bash
npm run migrate:status    # what would run — changes nothing
npm run migrate           # baseline, then every pending migration
```

The server runs both on boot, so a database is never left behind. What makes it
safe to run on the shop's only copy of its books:

- A **safety copy is written before any pending migration** (`backups/pre-<stamp>-<version>.db`).
  If the copy cannot be written, nothing is applied.
- Each migration runs **inside a transaction** — a failure rolls back rather than
  leaving the schema half-changed, and the server refuses to start.
- Applied migrations are **checksummed**; editing one after it has run is
  reported, because two databases can no longer be assumed equal.
- Migrations **never DROP or rename in place**: add a column, backfill it, switch
  reads over, retire the old one later.

### Tests

```bash
npm test
```

Two layers. The unit tests cover the pure engines (money, billing, pricing,
finance, migrations, audit) with no database. The **integration tests boot the
real app** — routers, auth gate, role guard, audit middleware — against a
throwaway SQLite file on an ephemeral port, via `test/helpers/appHarness.js`.
Nothing in the suite can reach `hydraulic.db`.

### New database objects

| Object | Purpose |
|---|---|
| `Inventory.Cost` | Unit purchase cost, drives the margin / below-cost warning |
| `Inventory.MarketMid` | Outside **retail** price — what a competing shop bills the customer |
| `Inventory.MarketLow` | Outside **trade** price — what the same part costs to buy locally |
| `Invoices.Discount`, `RoundOff` | Discount and round-off amounts |
| `Invoices.AmountPaid`, `PaymentStatus` | Payment tracking |
| `Invoices.CancelledAt`, `CancelReason` | Void audit trail |
| `Payments` | One row per recorded payment |
| `Users` | Login credentials (scrypt-hashed passwords) |
| `SchemaVersion` | Which numbered migrations have been applied |
| `AuditLog` | One row per state-changing API call — actor, route, entity, status, payload |
| `Company` | Shop identity, base currency, fiscal year start (single row, enforced) |
| `Customers` | Who work is billed to; `Kind` separates external customers from own-fleet |
| `Machines` | Plant and equipment jobs are done on, owned by a customer |
| `Invoices.CustomerID/MachineID/IsInternal` | Links each job to its customer, its machine, and whether it is internal work |
| `Accounts` | Chart of accounts; the code's first digit is its type |
| `JournalEntries` / `JournalLines` | Double-entry journals — debit and credit as separate non-negative columns |
| `Periods` | Month open/closed; a closed period refuses new postings |
| `PurchaseOrders` / `PurchaseOrderItems` | What was ordered, and how much of it has arrived and been billed |
| `GoodsReceipts` / `GoodsReceiptItems` | What arrived, with the landed unit cost it was valued at |
| `LandedCosts` | Freight, duty and clearing spread over a receipt |
| `PurchaseBills` / `PurchaseBillItems` | Supplier invoices and what is still owed |
| `SupplierPayments` | Money paid out to suppliers |
| `Quotations` / `QuotationItems` | What was offered, before the work starts |
| `JobCards` / `JobCardItems` | The job on the bench — machine, hose spec, status, parts |
| `JobLabour` | Technician work on a job; accrued when done, cleared when paid |
| `Invoices.JobID` | Links a bill back to the job card it came from |
| `FixedAssets` / `DepreciationEntries` | Plant at cost, and one row per asset per period charged |
| `StockTakes` / `StockTakeItems` | Physical counts against system quantities |
| `TaxCodes` | SSCL / VAT rates, seeded inactive |

### General Ledger

Every money event now posts a balanced double-entry journal, and the three
statements are **derived from the ledger** rather than re-scanned out of the
operational tables. Account codes carry their type in the first digit — `1xxx`
asset, `2xxx` liability, `3xxx` equity, `4xxx` income, `5xxx` cost of sales,
`6xxx` expense — so a code is enough to know how a balance behaves.

| Event | Journal |
|---|---|
| External invoice | Dr Receivable · Cr Sales (parts / technical) · Cr Taxes Payable · Dr Cost of Sales · Cr Inventory |
| **Internal job** | Dr Internal Repairs & Maintenance · Cr Inventory — **no sale, no receivable, no cash** |
| Customer payment | Dr Cash or Bank · Cr Receivable (external invoices only) |
| Expense / labour | Dr the expense account · Cr Cash |
| Invoice cancelled | A reversing journal; the original stays on the books |

Reports come out of the ledger: **trial balance**, **profit & loss** (whole
period and **month by month**, with the cash that actually moved), **balance
sheet**, and a drill-down on any account. The old Profit & Loss screen, which
re-scanned Invoices and Expenses on every request, has been retired — its
monthly view and cash flow are now derived from journals instead.

What keeps it trustworthy — enforced in `services/ledger.js`:

- an entry that does not balance is refused, and a line cannot be both a debit
  and a credit;
- every account must exist in the chart;
- posting into a **closed period** is refused;
- the whole entry is written in one transaction — a half-posted journal cannot exist;
- **one event posts at most once**, so replaying a backfill or double-clicking
  Finalize cannot double the books;
- journals are never edited or deleted. A mistake is corrected by posting its
  reversal, and deleting an expense reverses its journal rather than orphaning it.

`migrations/0006` opened the books on the existing history and **refuses to
complete unless it reconciles**: debits must equal credits, and ledger stock must
equal the inventory value to the cent.

### Controls: stock valuation, stock takes, fixed assets, ageing, year-end

**Stock valuation** values the shelf at weighted-average cost and checks it
against the ledger. The banner at the top of the screen answers the only
question that matters — *does the stock agree with the books?* — and shows the
difference when it does not.

**Stock takes** replace someone quietly editing a quantity. Opening a take
freezes today's system quantities onto a count sheet; you enter what you actually
counted; posting adjusts the stock and puts the difference through Stock
Adjustments, leaving an `ADJUST` stock movement behind. Nothing moves until the
take is posted, and a posted take cannot be edited or posted again.

**Fixed assets** depreciate straight-line:

| When | Journal |
|---|---|
| Asset registered | Dr Plant & Machinery · Cr Payables *(or Opening Equity if already owned)* |
| Depreciation run | Dr Depreciation · Cr Accumulated Depreciation |

Two rules keep it honest: depreciation never takes an asset below its residual
value, and the final month absorbs the rounding so the total charged equals the
depreciable amount exactly. A period already charged is skipped, so a run is safe
to repeat. The crimping machine's amortisation is currently a hardcoded constant
in `lib/ratecardSeed.js` — registering it here is what puts that charge on the books.

**Receivables ageing** buckets what customers owe by days past their payment
terms. Internal jobs never appear: they are not receivables.

**Year-end close** sweeps every income, cost and expense account to zero and
carries the net to Retained Earnings. Balance-sheet accounts carry forward.

**Tax codes** are deliberately minimal — SSCL and VAT are seeded *inactive*,
because the shop stopped charging them. They exist so there is somewhere for tax
to go if it comes back.

### Workshop: quotations, job cards and technician labour

```
Quotation  →  Job Card  →  Invoice
                 ↓
              JobLabour  →  a real Worker, accrued then paid
```

A job card is the record the shop never had: which machine came in, what hose
spec, who did the work, what it is waiting for, and whether it has been billed.
Statuses run `open → in-progress → waiting-parts → completed → invoiced`, and an
invoiced job locks.

Invoicing a job **does not reimplement billing** — it builds the payload and
posts it through the existing finalize endpoint, so stock checks, race-free
numbering and ledger posting all still apply.

**Technician labour is accrued, not paid straight to Wages:**

| When | Journal |
|---|---|
| Work recorded on a job | Dr Cost of Sales — Technical Labour · Cr **Accrued Technical Labour** |
| Technician paid | Dr Accrued Technical Labour · Cr Cash or Bank |

That matters because the cost is recognised **once**, when the work is done, and
the balance sheet shows what is owed to the worker in between. Previously a
payout hit Wages directly, the liability never existed, and what a technician had
earned was inferred by pattern-matching the words "Technical charge" or
"Crimping" in a line description with a boolean flag on the invoice. Account
`2200` was seeded in migration 0005 for this and had nothing posted to it until
now.

### Procurement and payables

Purchase Order → Goods Receipt → Supplier Bill → Payment, with landed costs.

| Step | Journal |
|---|---|
| Goods receipt | Dr Inventory (at **landed** cost) · Cr Goods Received Not Invoiced · Cr Payables (freight/duty) |
| Supplier bill | Dr GRNI · Cr Payables · any difference to Purchase Price Variance |
| Payment | Dr Payables · Cr Cash or Bank |

**GRNI** (`2150`) is the accrual between the goods arriving and the invoice
arriving. Its balance is a live to-do list: whatever sits in it is stock you hold
but have not been billed for.

**Landed cost** is the piece that matters for an importer. Freight, duty and
clearing are spread across the receipt lines — by **value** (a line worth twice
as much carries twice the freight) or by **quantity** (right for volumetric costs
like container space). The last line absorbs the rounding remainder, so the
allocated total always equals the cost being allocated to the cent. Item cost is
then re-averaged at the landed figure:

```
100 units @ Rs 300  +  Rs 7,800 duty  +  Rs 2,200 freight
  = Rs 40,000 landed  =  Rs 400 per unit   (33% uplift on the supplier price)
```

Receiving goods raises stock, re-averages the cost and posts the journal **inside
one transaction**, so a receipt cannot leave stock up but the books untouched.

Also here: payables ageing, a three-way match (ordered vs received vs billed) and
a list of uninvoiced receipts.

### Customers, machines and internal work

`Invoices.BilledToName` was free text carrying three different things — real
people, vehicle registrations (`HEX-18`, `ZA-7092`) and equipment descriptions
(`Tractor Hose`, `Service Bay`). Migration `0003` split them:

- **Customers** — who pays. `Kind = 'external'` for real customers, `'internal'`
  for the single *Internal / Own Fleet* record.
- **Machines** — the plant a job was done on, owned by a customer.
- **`Invoices.IsInternal`** — whether the job was work on the shop's own plant.

The backfill classified historical invoices by billing address: an invoice billed
to the shop's own address is internal work. On the live data that gave **5
external customers / 18 machines**, and **26 internal vs 5 external** finalized
invoices. `BilledToName` is untouched, so nothing is lost if a row is
misclassified — fix it on the Customers & Machines screen.

## Troubleshooting

| Issue | Solution |
|---|---|
| `npm install` fails building better-sqlite3 | Ensure a supported Node.js LTS; prebuilt binaries cover Windows/macOS/Linux. On odd platforms install build tools (`node-gyp`). |
| "database is locked" | Only one process should write at a time; close any other instance/backup tool holding `hydraulic.db`. |
| Port 9999 in use | Set `PORT=xxxx` before `npm start`. |
| Forgot the login | Set `BILLING_PASSWORD=...` (or `BILLING_AUTH=off` for a trusted single-user machine). |

## Backup

The database is a single portable file — `hydraulic.db`. Back it up by copying that
one file to another location (works while the app is stopped; for a hot copy use
`sqlite3 hydraulic.db ".backup backup.db"`). Recommended: daily backup to USB or cloud.

---

Built for hydraulic hose repair workshop inventory management.
