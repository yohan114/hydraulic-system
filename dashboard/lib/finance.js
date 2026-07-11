'use strict';

/**
 * Shop-management finance engine (pure, dependency-free, unit-tested).
 *
 * Everything here is derived, never stored authoritatively: per-job profit,
 * monthly Profit & Loss, cash flow, and matching an invoice line to an editable
 * Rate Card entry (our cost / our price / outside price). Keeping it pure means
 * it is verifiable on any platform, independent of the Windows-only Access DB.
 *
 * Accounting conventions:
 *  - Revenue is recognised NET OF TAX (SSCL/VAT are collected for the state and
 *    are not shop income), i.e. the invoice Sub Total, minus any Discount.
 *  - COGS (cost of goods sold) = Σ (qty × unit cost) for stocked items on the
 *    invoice, using Inventory.Cost.
 *  - Gross profit = revenue − COGS. Net profit additionally subtracts labour
 *    and other expenses (at the monthly level, or a per-job labour figure).
 */

const { num, round2, sumMoney } = require('./money');
const FEET_PER_METRE = 3.28084;

/**
 * Profit for a single invoice/job.
 * @param {object} p
 * @param {number} p.revenueExTax  Sub Total − Discount (net-of-tax revenue)
 * @param {number} p.materialCost  Σ qty × unit cost of stocked items
 * @param {number} [p.labourCost=0] direct labour attributed to this job
 * @returns {{revenueExTax:number, materialCost:number, labourCost:number,
 *   grossProfit:number, netProfit:number, grossMarginPct:(number|null),
 *   netMarginPct:(number|null)}}
 */
function jobProfit(p) {
  const revenueExTax = round2(p && p.revenueExTax);
  const materialCost = round2(p && p.materialCost);
  const labourCost = round2(Math.max(0, num(p && p.labourCost)));
  const grossProfit = round2(revenueExTax - materialCost);
  const netProfit = round2(grossProfit - labourCost);
  const grossMarginPct = revenueExTax > 0 ? round2((grossProfit / revenueExTax) * 100) : null;
  const netMarginPct = revenueExTax > 0 ? round2((netProfit / revenueExTax) * 100) : null;
  return { revenueExTax, materialCost, labourCost, grossProfit, netProfit, grossMarginPct, netMarginPct };
}

/**
 * Monthly Profit & Loss.
 * @param {object} p
 * @param {number} p.revenue net-of-tax revenue for the period
 * @param {number} p.cogs cost of goods sold
 * @param {number} p.labour wages paid in the period
 * @param {number} p.expenses other expenses in the period
 * @returns {{revenue:number, cogs:number, grossProfit:number, labour:number,
 *   expenses:number, totalCosts:number, netProfit:number,
 *   grossMarginPct:(number|null), netMarginPct:(number|null)}}
 */
function monthlyPL(p) {
  const revenue = round2(p && p.revenue);
  const cogs = round2(p && p.cogs);
  const labour = round2(p && p.labour);
  const expenses = round2(p && p.expenses);
  const grossProfit = round2(revenue - cogs);
  const totalCosts = round2(cogs + labour + expenses);
  const netProfit = round2(revenue - totalCosts);
  return {
    revenue,
    cogs,
    grossProfit,
    labour,
    expenses,
    totalCosts,
    netProfit,
    grossMarginPct: revenue > 0 ? round2((grossProfit / revenue) * 100) : null,
    netMarginPct: revenue > 0 ? round2((netProfit / revenue) * 100) : null,
  };
}

/**
 * Cash flow: money in (customer payments) vs out (labour + expenses).
 * @param {object} p
 * @param {number} p.paymentsIn
 * @param {number} p.labourOut
 * @param {number} p.expensesOut
 * @returns {{inflow:number, outflow:number, net:number}}
 */
function cashFlow(p) {
  const inflow = round2(p && p.paymentsIn);
  const outflow = round2(num(p && p.labourOut) + num(p && p.expensesOut));
  return { inflow, outflow, net: round2(inflow - outflow) };
}

/**
 * Sum the material (stocked-item) cost of a set of invoice lines.
 * Each line contributes qty × unitCost; non-stocked lines (no cost) contribute 0.
 * @param {Array<{qty:number, cost:number}>} lines
 * @returns {number}
 */
function materialCostOf(lines) {
  return sumMoney((lines || []).map((l) => num(l.qty) * num(l.cost)));
}

/**
 * Normalise a hydraulic spec token from free text (R1/R2/4SP/4SH), or null.
 * @param {string} text
 * @returns {string|null}
 */
function normaliseSpec(text) {
  const t = String(text || '').toUpperCase();
  if (t.includes('4SP')) return '4SP';
  if (t.includes('4SH')) return '4SH';
  if (t.includes('R2')) return 'R2';
  if (t.includes('R1')) return 'R1';
  return null;
}

// Inventory SpecificationCode (mm bore) -> nominal size in inches.
const SIZE_CODE_TO_INCH = {
  '6': 0.25, '8': 0.3125, '10': 0.375, '13': 0.5,
  '16': 0.625, '19': 0.75, '25': 1.0, '32': 1.25,
  '38': 1.5, '51': 2.0,
};

/**
 * Convert an inventory SpecificationCode (bore in mm) to size in inches.
 * @param {string|number} code
 * @returns {number|undefined}
 */
function sizeInchFromCode(code) {
  return SIZE_CODE_TO_INCH[String(code == null ? '' : code).trim()];
}

// Words that mark an invoice line as a hose end / fitting rather than hose.
const FITTING_RE = /fitting|adaptor|adapter|ferrule|coupling|nipple|flange|bsp|jic|orfs|\bend\b/i;

/**
 * The outside price for a Rate Card row at a given tier (low/mid/high),
 * falling back to the legacy single OutsidePrice when tiers are absent.
 * @param {object} rate
 * @param {('low'|'mid'|'high'|string)} [tier='mid']
 * @returns {number}
 */
function tierValueOf(rate, tier) {
  if (!rate) return 0;
  const t = String(tier || 'mid').toLowerCase();
  if (t === 'low' && rate.outsideLow != null) return num(rate.outsideLow);
  if (t === 'high' && rate.outsideHigh != null) return num(rate.outsideHigh);
  if (rate.outsideMid != null) return num(rate.outsideMid);
  return num(rate.outsidePrice); // legacy single-price rows
}

/**
 * Find the HOSE Rate Card row that matches an invoice line by spec + size.
 * @param {Array<object>} rates
 * @param {object} line { productName, specCode }
 * @returns {object|null}
 */
function matchRate(rates, line) {
  const spec = normaliseSpec(line && line.productName);
  if (!spec) return null;
  const sizeInch = sizeInchFromCode(line && line.specCode);
  if (sizeInch === undefined) return null;
  return (
    (rates || []).find(
      (r) => (r.category === 'hose' || r.category == null) && r.spec === spec && Math.abs(num(r.sizeInch) - sizeInch) < 0.001
    ) || null
  );
}

/**
 * Find the FITTING Rate Card row matching a hose-end invoice line by size.
 * @param {Array<object>} rates
 * @param {object} line { productName, description, specCode }
 * @returns {object|null}
 */
function matchFitting(rates, line) {
  const text = `${(line && line.productName) || ''} ${(line && line.description) || ''}`;
  if (!FITTING_RE.test(text)) return null;
  const sizeInch = sizeInchFromCode(line && line.specCode);
  if (sizeInch === undefined) return null;
  return (
    (rates || []).find((r) => r.category === 'fitting' && Math.abs(num(r.sizeInch) - sizeInch) < 0.001) || null
  );
}

/**
 * Compare one invoice line against a matched Rate Card row.
 * Everything is per the row's own unit (metre for hose, end for fittings), so
 * the invoice qty maps straight through — no unit conversion.
 * @param {object} line { qty, ourAmount, unit }
 * @param {object|null} rate matched Rate Card row
 * @param {('low'|'mid'|'high')} [tier='mid'] outside tier to compare against
 * @returns {{matched:boolean, qty:number, unit:string, ourCost:number,
 *   ourPrice:number, outsidePrice:number}}
 */
function compareLine(line, rate, tier) {
  const qty = num(line && line.qty);
  if (!rate) {
    return { matched: false, qty: round2(qty), unit: (line && line.unit) || '', ourCost: 0, ourPrice: round2(line && line.ourAmount), outsidePrice: 0 };
  }
  return {
    matched: true,
    qty: round2(qty),
    unit: rate.unit || 'm',
    ourCost: round2(qty * num(rate.ourCost)),
    ourPrice: round2(qty * num(rate.ourPrice)),
    outsidePrice: round2(qty * tierValueOf(rate, tier)),
  };
}

module.exports = {
  FEET_PER_METRE,
  jobProfit,
  monthlyPL,
  cashFlow,
  materialCostOf,
  normaliseSpec,
  sizeInchFromCode,
  tierValueOf,
  matchRate,
  matchFitting,
  compareLine,
};
