'use strict';

/**
 * Server-authoritative billing engine.
 *
 * The browser is never trusted for money. It may send line items (description,
 * qty, rate) as facts the user entered, but every derived amount — line totals,
 * subtotal, SSCL, VAT, discount, round-off and the grand total — is recomputed
 * here from those items and the tax rates. This guarantees the stored and
 * printed invoice is internally consistent and cannot be tampered with from the
 * client.
 *
 * Tax order (Sri Lanka, matches the printed invoice):
 *   Sub Total  = Σ round2(qty × rate)
 *   SSCL       = round2(Sub Total × ssclRate%)
 *   Pre-VAT    = Sub Total + SSCL
 *   VAT        = round2(Pre-VAT × vatRate%)
 *   After Tax  = Pre-VAT + VAT
 *   Discount   = manual, clamped to [0, After Tax]
 *   Grand      = After Tax − Discount  (optionally rounded to the nearest rupee)
 */

const { num, round2, sumMoney, clamp } = require('../lib/money');

const DEFAULT_SSCL_RATE = 2.5;
const DEFAULT_VAT_RATE = 18;
const MAX_RATE = 100; // tax percentages are bounded to a sane range

/**
 * Compute the amount for a single line: round2(qty × rate).
 * @param {number} qty
 * @param {number} rate
 * @returns {number}
 */
function lineAmount(qty, rate) {
  return round2(num(qty) * num(rate));
}

/**
 * Recompute every derived total for an invoice from its line items.
 *
 * @param {object} input
 * @param {Array<{qty:number, rate:number}>} input.items
 * @param {number} [input.ssclRate=2.5]
 * @param {number} [input.vatRate=18]
 * @param {number} [input.discount=0]      absolute LKR discount applied after tax
 * @param {boolean} [input.roundToRupee=false] round the grand total to nearest whole rupee
 * @returns {{
 *   lineAmounts:number[], subTotal:number,
 *   ssclRate:number, ssclAmount:number,
 *   vatRate:number, vatAmount:number,
 *   preVat:number, afterTax:number,
 *   discount:number, roundOff:number, grandTotal:number
 * }}
 */
function computeTotals(input) {
  const items = Array.isArray(input && input.items) ? input.items : [];
  const ssclRate = clamp(input && input.ssclRate != null ? input.ssclRate : DEFAULT_SSCL_RATE, 0, MAX_RATE);
  const vatRate = clamp(input && input.vatRate != null ? input.vatRate : DEFAULT_VAT_RATE, 0, MAX_RATE);

  const lineAmounts = items.map((it) => lineAmount(it.qty, it.rate));
  const subTotal = sumMoney(lineAmounts);

  const ssclAmount = round2(subTotal * (ssclRate / 100));
  const preVat = round2(subTotal + ssclAmount);
  const vatAmount = round2(preVat * (vatRate / 100));
  const afterTax = round2(preVat + vatAmount);

  const discount = round2(clamp(input && input.discount, 0, afterTax));
  const grandBeforeRound = round2(afterTax - discount);

  let roundOff = 0;
  let grandTotal = grandBeforeRound;
  if (input && input.roundToRupee) {
    grandTotal = Math.round(grandBeforeRound);
    roundOff = round2(grandTotal - grandBeforeRound);
  }

  return {
    lineAmounts,
    subTotal,
    ssclRate,
    ssclAmount,
    vatRate,
    vatAmount,
    preVat,
    afterTax,
    discount,
    roundOff,
    grandTotal,
  };
}

/**
 * Validate an invoice payload before it is saved.
 *
 * @param {object} payload
 * @param {object} [opts]
 * @param {boolean} [opts.requireCustomer=false] finalized invoices must name a customer
 * @param {boolean} [opts.checkStock=false] enforce inventory availability
 * @param {Map<number, number>} [opts.stockById] inventoryId -> available qty (for checkStock)
 * @param {Map<number, string>} [opts.nameById] inventoryId -> product name (for messages)
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateInvoice(payload, opts = {}) {
  const errors = [];
  const items = Array.isArray(payload && payload.items) ? payload.items : [];

  if (items.length === 0) {
    errors.push('Invoice must have at least one item.');
  }

  if (opts.requireCustomer && !(payload && String(payload.billedToName || '').trim())) {
    errors.push('A customer (Billed To) name is required.');
  }

  items.forEach((it, i) => {
    const qty = num(it.qty, NaN);
    const rate = num(it.rate, NaN);
    const label = `Row ${i + 1}`;
    if (!String(it.description || '').trim()) {
      errors.push(`${label}: description is required.`);
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`${label}: quantity must be greater than zero.`);
    }
    if (!Number.isFinite(rate) || rate < 0) {
      errors.push(`${label}: rate must be zero or positive.`);
    }
  });

  if (opts.checkStock && opts.stockById) {
    // Aggregate requested qty per inventory item so multiple lines of the
    // same product are validated against the single available balance.
    const requested = new Map();
    for (const it of items) {
      if (it.inventoryId == null) continue;
      const id = Number(it.inventoryId);
      requested.set(id, num(requested.get(id)) + num(it.qty));
    }
    for (const [id, wantQty] of requested) {
      if (!opts.stockById.has(id)) {
        errors.push(`Inventory item ${id} no longer exists.`);
        continue;
      }
      const have = num(opts.stockById.get(id));
      if (have < wantQty) {
        const name = (opts.nameById && opts.nameById.get(id)) || `item ${id}`;
        errors.push(`Not enough stock for ${name}. Available: ${have}, requested: ${round2(wantQty)}.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Derive a payment status and outstanding balance for a finalized invoice.
 * @param {number} grandTotal
 * @param {number} amountPaid
 * @returns {{status:('Paid'|'Partial'|'Unpaid'), balance:number, amountPaid:number}}
 */
function paymentStatus(grandTotal, amountPaid) {
  const grand = round2(grandTotal);
  const paid = round2(Math.max(0, num(amountPaid)));
  const balance = round2(Math.max(0, grand - paid));

  let status;
  if (grand <= 0 || balance <= 0) status = 'Paid';
  else if (paid <= 0) status = 'Unpaid';
  else status = 'Partial';

  return { status, balance, amountPaid: paid };
}

/**
 * Per-line profit margin relative to a unit cost.
 * @param {number} rate selling rate charged on the invoice
 * @param {number} cost unit cost from inventory (0/unknown -> margin unknown)
 * @returns {{marginAmount:number, marginPct:(number|null), belowCost:boolean, hasCost:boolean}}
 */
function lineMargin(rate, cost) {
  const r = num(rate);
  const c = num(cost);
  const hasCost = c > 0;
  const marginAmount = round2(r - c);
  const marginPct = r > 0 ? round2(((r - c) / r) * 100) : null;
  const belowCost = hasCost && r < c;
  return { marginAmount, marginPct, belowCost, hasCost };
}

module.exports = {
  DEFAULT_SSCL_RATE,
  DEFAULT_VAT_RATE,
  MAX_RATE,
  lineAmount,
  computeTotals,
  validateInvoice,
  paymentStatus,
  lineMargin,
};
