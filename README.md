# Hydraulic Hose Repair — Inventory & Smart Billing System

A workshop management system for hydraulic hose repair: inventory, invoicing with
Sri Lankan tax calculations (SSCL + VAT), material transaction tracking, and a
**smart, locked, accurate billing** layer. Data is stored in a Microsoft Access
database (`HydraulicHoseRepair.accdb`); the day-to-day UI is a Node.js/Express web
dashboard in [`dashboard/`](dashboard/).

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

1. **Microsoft Access** 2016, 2019, 2021, or Microsoft 365
2. **PowerShell** 5.1 or later (pre-installed on Windows 10/11)
3. **VBA Trust Setting**: In Access, enable "Trust access to the VBA project object model":
   - Open Access → File → Options → Trust Center → Trust Center Settings
   - Click "Macro Settings"
   - Check ✅ "Trust access to the VBA project object model"
   - Click OK

## Installation

1. Open PowerShell **as Administrator**
2. Navigate to this folder:
   ```powershell
   cd "d:\hydraulic 1"
   ```
3. If needed, allow script execution:
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
   ```
4. Run the build script:
   ```powershell
   .\build.ps1
   ```
5. Wait for the build to complete (about 30-60 seconds)
6. Open `HydraulicHoseRepair.accdb` in Microsoft Access
7. Click "Enable Content" if prompted about macros

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
d:\hydraulic 1\
├── build.ps1                  # Master build script
├── README.md                  # This file
├── HydraulicHoseRepair.accdb  # The database (created by build.ps1)
└── scripts\
    ├── 01_create_schema.ps1   # Tables, relationships, queries
    ├── 02_create_vba.ps1      # VBA business logic modules
    ├── 03_create_forms.ps1    # User interface forms
    └── 04_create_reports.ps1  # Print reports
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

The dashboard in [`dashboard/`](dashboard/) is the primary UI (Node.js + Express,
talking to the same `.accdb` via `node-adodb`; Windows-only driver).

```powershell
cd dashboard
npm install
npm run migrate     # one-time: add smart-billing columns/tables to an existing DB
npm start           # serves http://localhost:9999
```

- The server also runs the idempotent schema upgrade automatically on boot, so a
  DB created before this release gains the new columns without manual steps.
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
| "Microsoft Access not found" | Install MS Access or ensure it's not running when building |
| VBA module import fails | Enable "Trust access to VBA project object model" in Trust Center |
| Script won't run | Run `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` |
| Database locked | Close all Access instances and retry |
| Forms don't appear | Open database, press F11 to show Navigation Pane |

## Backup

The database is a single `.accdb` file. Back it up regularly by copying it to another location. Recommended: daily backup to USB or cloud storage.

---

Built for hydraulic hose repair workshop inventory management.
