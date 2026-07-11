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

### New database objects

| Object | Purpose |
|---|---|
| `Inventory.Cost` | Unit purchase cost, drives the margin / below-cost warning |
| `Invoices.Discount`, `RoundOff` | Discount and round-off amounts |
| `Invoices.AmountPaid`, `PaymentStatus` | Payment tracking |
| `Invoices.CancelledAt`, `CancelReason` | Void audit trail |
| `Payments` | One row per recorded payment |
| `Users` | Login credentials (scrypt-hashed passwords) |

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
