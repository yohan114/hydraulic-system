'use strict';

/**
 * Seed values for the editable Rate Card.
 *
 * These are RESEARCHED STARTING POINTS, not gospel — the whole point of the
 * Rate Card is that the shop edits them from real supplier quotes so the
 * comparison becomes exact. Prices are per FOOT, in LKR.
 *
 * Basis (July 2026):
 *  - Outside/market price: Sri Lankan retail benchmarks (duty + VAT + margin),
 *    ~1.5–2× the US-converted price. US SAE-100 R2 retail runs ~$2.28/ft (1/4")
 *    to ~$3.36/ft (1/2") at ~Rs.335/USD; R1 is cheaper, 4SP/4SH spiral 2–3×.
 *  - Our price ≈ 75% of outside (the workshop undercuts the market).
 *  - Our cost ≈ 62% of our price (typical purchase cost / gross margin).
 * Sources: discounthydraulichose.com, hydraulicsdirect.com, CBSL USD-LKR.
 */

// [spec, sizeInch, sizeCode(mm bore), label, outsidePricePerFoot]
const OUTSIDE = [
  ['R1', 0.25, '6', '1/4" R1', 950],
  ['R1', 0.3125, '8', '5/16" R1', 1050],
  ['R1', 0.375, '10', '3/8" R1', 1150],
  ['R2', 0.25, '6', '1/4" R2', 1200],
  ['R2', 0.3125, '8', '5/16" R2', 1300],
  ['R2', 0.375, '10', '3/8" R2', 1400],
  ['R2', 0.5, '13', '1/2" R2', 1600],
  ['R2', 0.625, '16', '5/8" R2', 1950],
  ['R2', 0.75, '19', '3/4" R2', 2300],
  ['R2', 1.0, '25', '1" R2', 3000],
  ['R2', 1.25, '32', '1-1/4" R2', 3950],
  ['4SP', 0.625, '16', '5/8" 4SP', 2900],
  ['4SH', 0.75, '19', '3/4" 4SH', 3800],
  ['4SH', 1.0, '25', '1" 4SH', 4700],
  ['4SH', 1.25, '32', '1-1/4" 4SH', 5900],
];

const RATECARD_SEED = OUTSIDE.map(([spec, sizeInch, sizeCode, label, outside]) => {
  const ourPrice = Math.round(outside * 0.75);
  const ourCost = Math.round(ourPrice * 0.62);
  return { spec, sizeInch, sizeCode, label, unit: 'ft', ourCost, ourPrice, outsidePrice: outside };
});

module.exports = { RATECARD_SEED };
