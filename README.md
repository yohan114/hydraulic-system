# Hydraulic Hose Repair — Inventory & Invoice Management System

A complete Microsoft Access database for managing hydraulic hose repair workshop inventory, generating invoices with Sri Lankan tax calculations, and tracking material transactions.

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

```
Sub Total           =  Sum of all line items
SSCL (2.5%)         =  Sub Total × 2.5%
Subtotal + SSCL     =  Sub Total + SSCL
VAT (18%)           =  (Subtotal + SSCL) × 18%
Discount            =  Manual entry
─────────────────────────────────────
Grand Total         =  Subtotal + SSCL + VAT − Discount
```

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
