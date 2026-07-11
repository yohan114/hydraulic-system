'use strict';

/**
 * Tiered Rate Card seed — Sri Lankan hydraulic market benchmark.
 *
 * These are RESEARCHED STARTING POINTS, not a price list. There is no published
 * price list for hose/fittings/crimping in Sri Lanka (every supplier quotes on
 * request), so these are modelled from Chinese FOB + the SL duty stack, cross-
 * checked against Indian counter and US retail actuals, and collapsed from the
 * Low/Mid/High ranges to their midpoints. All values are LKR, VAT-EXCLUSIVE.
 *
 * Units:
 *   - hose      → per METRE   (invoices are quantified in metres)
 *   - fitting   → per END     (fitting + ferrule, straight BSP/JIC)
 *   - crimping  → per END     (labour only)
 *
 * Tiers: Low = unbranded Chinese import · Mid = reputable Chinese/Indian brand ·
 * High = genuine European/US/Japanese. The comparison defaults to Mid.
 *
 * Our defaults: ourCost ≈ 60% of Mid (wholesale), ourPrice ≈ 80% of Mid
 * (undercut the market but stay profitable). Crimping uses true internal cost.
 * Edit all of these from your real supplier quotes — that is what makes the
 * comparison exact. Basis: USD≈LKR335, INR≈LKR3.8, July 2026.
 *
 * ourCost on the hose rows below is no longer a 60%-of-Mid estimate: it is the
 * REAL landed cost (CIF × duty) from shipment HS25E1112W1 (Henan Spark, Nov
 * 2025) — the datasheet's own advice was "your landed cost is now the ground
 * truth." See dashboard/data/shipment-HS25E1112W1.json for the per-item source.
 */

function row(category, spec, sizeInch, sizeCode, label, unit, low, mid, high, opts = {}) {
  const ourCost = opts.ourCost != null ? opts.ourCost : Math.round(mid * 0.6);
  const ourPrice = opts.ourPrice != null ? opts.ourPrice : Math.round(mid * 0.8);
  return {
    category, spec, sizeInch, sizeCode, label, unit,
    ourCost, ourPrice,
    outsideLow: low, outsideMid: mid, outsideHigh: high,
  };
}

const RATECARD_SEED = [
  // ---- Hose: 2-wire braid (SAE 100 R2AT / EN 853 2SN), per metre ----
  // ourCost = real landed cost from shipment HS25E1112W1.
  row('hose', 'R2', 0.25, '6', '1/4" R2 (2-wire)', 'm', 575, 1125, 2300, { ourCost: 206 }),
  row('hose', 'R2', 0.375, '10', '3/8" R2 (2-wire)', 'm', 800, 1525, 2950, { ourCost: 280 }),
  row('hose', 'R2', 0.5, '13', '1/2" R2 (2-wire)', 'm', 1075, 1950, 3900, { ourCost: 355 }),
  row('hose', 'R2', 0.625, '16', '5/8" R2 (2-wire)', 'm', 1400, 2450, 4900, { ourCost: 458 }),
  row('hose', 'R2', 0.75, '19', '3/4" R2 (2-wire)', 'm', 1750, 3100, 6150, { ourCost: 561 }),
  row('hose', 'R2', 1.0, '25', '1" R2 (2-wire)', 'm', 2500, 4400, 8900, { ourCost: 804 }),

  // ---- Hose: 1-wire braid (R1 ≈ 0.70 × R2) ----
  row('hose', 'R1', 0.25, '6', '1/4" R1 (1-wire)', 'm', 403, 788, 1610, { ourCost: 144 }),
  row('hose', 'R1', 0.375, '10', '3/8" R1 (1-wire)', 'm', 560, 1068, 2065, { ourCost: 196 }),
  row('hose', 'R1', 0.5, '13', '1/2" R1 (1-wire)', 'm', 753, 1365, 2730), // 13mm R1 not in shipment — modelled

  // ---- Hose: 4-wire spiral (4SP / 4SH), per metre ----
  // 4SH 25mm/32mm ourCost from shipment; the spiral market Mid there (12,260 /
  // 17,100) runs well above these researched benchmarks — review outsideMid if
  // you sell spiral at the higher local rate.
  row('hose', '4SH', 1.0, '25', '1" 4SH (spiral)', 'm', 4350, 7400, 14000, { ourCost: 2292 }),
  row('hose', '4SH', 1.25, '32', '1-1/4" 4SH (spiral)', 'm', 5650, 9500, 18000, { ourCost: 3197 }),
  row('hose', '4SH', 1.5, '38', '1-1/2" 4SH (spiral)', 'm', 7500, 12750, 24500),
  row('hose', '4SH', 2.0, '51', '2" 4SH (spiral)', 'm', 10750, 18000, 35000),

  // ---- Fittings (hose ends): fitting + ferrule, straight BSP/JIC, per end ----
  row('fitting', 'BSP', 0.25, '6', 'Fitting 1/4" (straight)', 'end', 465, 775, 1850),
  row('fitting', 'BSP', 0.375, '10', 'Fitting 3/8" (straight)', 'end', 565, 965, 2250),
  row('fitting', 'BSP', 0.5, '13', 'Fitting 1/2" (straight)', 'end', 740, 1250, 2950),
  row('fitting', 'BSP', 0.75, '19', 'Fitting 3/4" (straight)', 'end', 1235, 2100, 5000),
  row('fitting', 'BSP', 1.0, '25', 'Fitting 1" (straight)', 'end', 2050, 3500, 8400),
  row('fitting', 'BSP', 1.25, '32', 'Fitting 1-1/4" (straight)', 'end', 3950, 6700, 15500),

  // ---- Crimping charge, per end. From the shipment datasheet's Crimping Charges
  // sheet: outsideLow/Mid/High are the local market tiers; ourCost is the true
  // internal cost (machine amortization + burdened labour + consumables + power);
  // ourPrice is set to the market HIGH rate (branded-shop / test-certificate tier).
  // Reference rows — not auto-matched to invoice lines. ----
  row('crimping', '', 0.25, '6', 'Crimp 1/4" (per end)', 'end', 250, 650, 1800, { ourCost: 290, ourPrice: 1800 }),
  row('crimping', '', 0.3125, '8', 'Crimp 5/16" (per end)', 'end', 250, 650, 1800, { ourCost: 290, ourPrice: 1800 }),
  row('crimping', '', 0.375, '10', 'Crimp 3/8" (per end)', 'end', 250, 650, 1800, { ourCost: 313, ourPrice: 1800 }),
  row('crimping', '', 0.5, '13', 'Crimp 1/2" (per end)', 'end', 280, 700, 1900, { ourCost: 336, ourPrice: 1900 }),
  row('crimping', '', 0.625, '16', 'Crimp 5/8" (per end)', 'end', 380, 850, 2200, { ourCost: 360, ourPrice: 2200 }),
  row('crimping', '', 0.75, '19', 'Crimp 3/4" (per end)', 'end', 450, 950, 2500, { ourCost: 383, ourPrice: 2500 }),
  row('crimping', '', 1.0, '25', 'Crimp 1" (per end)', 'end', 650, 1350, 3500, { ourCost: 453, ourPrice: 3500 }),
  row('crimping', '', 1.25, '32', 'Crimp 1-1/4" (per end)', 'end', 900, 1800, 4500, { ourCost: 523, ourPrice: 4500 }),
];

module.exports = { RATECARD_SEED };
