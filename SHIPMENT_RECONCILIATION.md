# Shipment Reconciliation — Invoice HS25E1112W1

**Datasheet:** `EC_Shipment_HS25E1112W1_Datasheet` (Henan Spark Machinery Co. Ltd,
12 Nov 2025, CIF Colombo) · **Reconciled:** 2026-07-11 · **Currency:** LKR, VAT-excl.

This is the analysis behind the inventory update. The uploaded datasheet is the
**authoritative record** of the shipment — 84 line items with the correct received
quantity, our **landed cost** (CIF × duty) and the **market / sell price** for each
item. Of those, **83 are sellable stock** loaded into the catalogue; the 84th line,
the tube swaging machine, is the workshop's own crimping equipment and is excluded. The system's old inventory came from a rough material-issue sheet
(`Hydraulic Items.xlsx`, 71 lines) that had **no cost data, flat placeholder prices,
several wrong quantities, missing items, and stock that never actually arrived.**

Every figure below was cross-checked by re-deriving it independently from the raw
datasheet — all findings confirmed, zero discrepancies.

---

## What changed, at a glance

| | Old system | Now |
|---|---|---|
| Items in catalogue | 71 rough lines | **83 authoritative items** |
| Unit **cost** tracked | none (0) | **every item** (landed LKR) |
| Sell price | flat 400 / 450 / 1,125 | **per-item market price** |
| Quantity errors | 6 | **fixed** |
| Missing received items | 9 | **added** |
| "Ghost" stock (never arrived) | 2 lines | **removed / zeroed** |
| Items priced **below cost** | 21 | **corrected** |

**Received stock value:** LKR **2,933,220** at cost → LKR **13,273,385** at sell
(≈ **78 %** gross margin headroom).

**17 data problems** were found and fixed (6 quantity errors + 9 missing items +
2 ghost entries), plus a full cost/price refresh.

---

## 1. Quantity errors — "received X but entered Y"

Six items were entered with the wrong quantity versus what the shipment actually
delivered. Two were **under-counted** (real stock higher than the system showed) and
four were **over-counted** (system showed stock that was never received).

| # | Code | Item | System had | Actually shipped | Error |
|---|------|------|-----------:|-----------------:|-------|
| 26 | 00210-20 | Ferrule 2SN 1-1/4" (32 mm) | 20 | **30** | short 10 |
| 29 | 00400-16 | Ferrule spiral 1" (25 mm) | 20 | **30** | short 10 |
| 32 | 22611-06-04 | BSP straight G3/8", hose 6 mm | 100 | **50** | over 50 |
| 57 | 22692-10-10 | BSP 90° G5/8", hose 16 mm | 50 | **25** | over 25 |
| 68 | 10011N-20 | Welding fitting 32 mm | 50 | **10** | over 40 |
| 71 | 90011-08 | Double connector 12 mm | 11 | **10** | over 1 |

## 2. Missing items — received but never in the system

Nine items were on the shipment and **received**, but the old catalogue never had
them. They are now added, with correct cost and sell price.

| # | Code | Item | Qty | Cost | Sell |
|---|------|------|----:|----:|----:|
| 28 | 00400-12 | Ferrule spiral 3/4" (20 mm) | 30 | 1,396 | 2,234 |
| 30 | 00400-20 | Ferrule spiral 1-1/4" (32 mm) | 30 | 3,222 | 5,155 |
| 37 | 22611-10-10 | BSP straight G5/8", hose 16 mm | 50 | 279 | 1,250 |
| 45 | 22611D-06-06 | BSP dbl-hex G3/8", hose 10 mm | 50 | 185 | 828 |
| 46 | 22611D-08-08 | BSP dbl-hex G1/2", hose 12 mm | 50 | 244 | 1,092 |
| 53 | 22612-20-20 | BSP straight G1-1/4", hose 32 mm | 25 | 984 | 3,900 |
| 55 | 22692-06-06 | BSP 90° G3/8", hose 10 mm | 50 | 354 | 1,404 |
| 56 | 22692-08-08 | BSP 90° G1/2", hose 12 mm | 50 | 467 | 1,852 |
| 65 | 10011N-10 | Welding fitting 16 mm | 100 | 142 | 750 |

## 3. Ghost stock — entered but never received

Two items were **not received** in this shipment (they are on the supplier's
short-ship / claim list) yet the old system showed 50 pcs each in stock. Billing
from them would sell stock you do not have. Their stock is now **zeroed** and they
are flagged *ON ORDER*.

| # | Code | Item | System showed | Real |
|---|------|------|--------------:|-----:|
| 42 | 22691-06-06 | BSP 90° G3/8", hose 10 mm | 50 | **0 (not received)** |
| 43 | 22691-08-08 | BSP 90° G1/2", hose 12 mm | 50 | **0 (not received)** |

## 4. On-order items (short-shipped) — kept at Qty 0

Six connector line items were ordered but not received; they stay in the catalogue at
**Qty 0** so they are ready to receive when the supplier ships them, and so
received items are not over-costed. Follow up with the supplier (see the datasheet's
*Not received* sheet — estimated value **USD 246 / LKR 94,600**).

`22611-16-16` · `22611-20-20W` · `22691-04-04` · `22691-06-06` · `22691-08-08` ·
`22611D-04-04`

*(The tube swaging machine `R32ELD-380V` was also short-shipped, but it is the
workshop's own crimping equipment — not stock for sale — so it is excluded from the
inventory. Its supplier claim of USD 1,700 is tracked separately.)*

## 5. Price corrections — including items sold below cost

The old prices were flat placeholders (400 / 450 / 1,125) that ignored size and
type. **21 items had an old price *below* their real landed cost** — you would lose
money on every sale. The clearest cases are the four premium spiral hoses:

| # | Hose | Old price | Landed cost | New sell (market) |
|---|------|----------:|------------:|------------------:|
| 12 | 4SP 5/8" (16 mm) | 1,035 | 1,146 | **6,130** |
| 13 | 4SH 3/4" (19 mm) | 1,260 | 1,599 | **8,550** |
| 14 | 4SH 1" (25 mm) | 1,530 | 2,292 | **12,260** |
| 15 | 4SH 1-1/4" (32 mm) | 1,800 | 3,197 | **17,100** |

Every item now carries its real landed **Cost** (so the dashboard's margin and
below-cost warnings work) and a **market Sell** price. Prices remain fully editable
in the dashboard — override any line with your own quoted price.

---

## How to apply this to your system

All 83 corrected items live in `dashboard/data/shipment-HS25E1112W1.json` (the source
of truth). Pick whichever path fits your situation:

- **One-click, through the dashboard** — Inventory → **Import**, choose
  `Inventory_Import_HS25E1112W1.xlsx` (in the repo root). *For a clean result, use
  Inventory → Clear first, otherwise the old rough rows remain alongside the new ones.*
- **Live system, keep your invoices (recommended)** — on the Windows machine:
  `cd dashboard && node reconcile-inventory.js` (add `--dry-run` to preview). It
  upserts every item, fixes the quantities, fills cost/price, adds the missing items
  and zeroes the ghost stock — **without deleting any invoices**.
- **Fresh / empty database** — `cd dashboard && node reimport.js` rebuilds the whole
  catalogue from the datasheet.

The market-comparison **Rate Card** hose costs were also updated to the real landed
costs (`dashboard/lib/ratecardSeed.js`).

---

*Method note: per-item costs for fittings are allocated from invoice group totals
(the supplier invoice prices groups, not individual lines), so fitting costs scale
correctly with size/type but are indicative, not the supplier's exact per-line figure.
Hose and machine costs are exact. See the datasheet's method notes for detail.*
