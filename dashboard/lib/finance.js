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
 *
 * The four money columns a job is analysed against:
 *   OUR COST      what we actually paid to have the part on the shelf (landed).
 *   OUTSIDE COST  what the same part would have cost us to buy from a local
 *                 outside supplier instead — the market TRADE/wholesale band.
 *   OUR PRICE     what we billed the customer.
 *   OUTSIDE PRICE what a competing shop would have billed the customer — the
 *                 market RETAIL band (Mid).
 * See {@link jobProfitAnalysis} for the three comparisons built on them.
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
 * Percentage of `part` against `whole`, or null when there is no base to
 * divide by (so the UI can print "—" rather than a misleading 0%).
 * @param {number} part
 * @param {number} whole
 * @returns {number|null}
 */
function pctOf(part, whole) {
  return whole > 0 ? round2((part / whole) * 100) : null;
}

/**
 * Fallback ratio of the outside TRADE (buying) price to the outside RETAIL
 * (Mid) price, used only when neither the item nor the Rate Card carries a
 * real trade figure. 0.55 is the midpoint of the seeded Low/Mid bands.
 * @type {number}
 */
const DEFAULT_OUTSIDE_COST_RATIO = 0.55;

/**
 * The Low ÷ Mid ratio the shop's own Rate Card implies, as the median across
 * every priced row. Using the operator's edited card (rather than a constant)
 * means the derived outside cost tracks their real market view; the constant is
 * only a last resort when the card is empty or unpriced.
 * @param {Array<object>} rates
 * @returns {number} ratio in (0, 1]
 */
function outsideCostRatio(rates) {
  const ratios = (rates || [])
    .map((r) => (num(r && r.outsideMid) > 0 ? num(r.outsideLow) / num(r.outsideMid) : 0))
    .filter((x) => x > 0 && x <= 1)
    .sort((a, b) => a - b);
  if (!ratios.length) return DEFAULT_OUTSIDE_COST_RATIO;
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}

/**
 * Per-unit OUTSIDE COST for one invoice line, with the basis it came from so
 * the UI can be honest about how firm the number is.
 *
 * Preference order: the item's own recorded trade price → the matched Rate Card
 * Low band → the item's retail benchmark scaled by {@link outsideCostRatio}
 * (flagged as `derived`) → nothing at all.
 *
 * @param {object} p
 * @param {number} [p.marketLow] Inventory.MarketLow — outside trade price per unit
 * @param {object|null} [p.rate] matched Rate Card row
 * @param {number} [p.marketMid] outside retail price per unit for this line
 * @param {number} [p.ratio] ratio from {@link outsideCostRatio}
 * @returns {{unit:number, basis:('item'|'ratecard'|'derived'|'none')}}
 */
function outsideCostUnit(p) {
  const marketLow = num(p && p.marketLow);
  if (marketLow > 0) return { unit: round2(marketLow), basis: 'item' };

  const rateLow = num(p && p.rate && p.rate.outsideLow);
  if (rateLow > 0) return { unit: round2(rateLow), basis: 'ratecard' };

  const marketMid = num(p && p.marketMid);
  if (marketMid > 0) {
    const ratio = num(p && p.ratio, DEFAULT_OUTSIDE_COST_RATIO) || DEFAULT_OUTSIDE_COST_RATIO;
    return { unit: round2(marketMid * ratio), basis: 'derived' };
  }
  return { unit: 0, basis: 'none' };
}

/**
 * Three-stage profit analysis for one job, in the order the shop reasons about
 * it — buy, then sell, then bank the difference:
 *
 *   ① SOURCING  our cost vs outside cost — did importing beat buying locally?
 *               Carries a side-by-side P&L (same billed revenue, only the cost
 *               of the parts changes) so the gain shows up as profit, not just
 *               as a cheaper purchase order.
 *   ② PRICING   our price vs outside price — how far under the market we billed,
 *               i.e. what the customer saved by coming to us.
 *   ③ MARGIN    our cost vs our price — the profit actually earned on the job.
 *
 * They reconcile: advantage over a competing shop
 *   = our profit − outside profit = sourcing gain − customer saving.
 *
 * @param {object} p
 * @param {number} p.ourCost       Σ qty × our landed unit cost
 * @param {number} p.ourPrice      Σ line amounts billed (net of tax)
 * @param {number} p.outsideCost   Σ qty × outside trade unit price
 * @param {number} p.outsidePrice  Σ qty × outside retail unit price
 * @returns {{sourcing:object, pricing:object, margin:object, bridge:object}}
 */
function jobProfitAnalysis(p) {
  const ourCost = round2(p && p.ourCost);
  const ourPrice = round2(p && p.ourPrice);
  const outsideCost = round2(p && p.outsideCost);
  const outsidePrice = round2(p && p.outsidePrice);

  // ① Buying: positive = we sourced cheaper than the outside market.
  const sourcingGain = round2(outsideCost - ourCost);
  // ② Selling: positive = we billed under the market, so the customer saved.
  const customerSaving = round2(outsidePrice - ourPrice);
  // ③ Earning: what is left on the job.
  const grossProfit = round2(ourPrice - ourCost);
  // What a competing shop would have earned on the same job.
  const outsideProfit = round2(outsidePrice - outsideCost);
  // The same job, our price, but with the parts bought outside.
  const outsideSourcedProfit = round2(ourPrice - outsideCost);

  return {
    sourcing: {
      ourCost,
      outsideCost,
      gain: sourcingGain,
      gainPct: pctOf(sourcingGain, outsideCost),
      verdict: sourcingGain > 0 ? 'gain' : sourcingGain < 0 ? 'loss' : 'even',
      // Profit & loss compare: identical revenue, only the sourcing differs.
      pl: {
        revenue: ourPrice,
        ourCost,
        ourProfit: grossProfit,
        ourMarginPct: pctOf(grossProfit, ourPrice),
        outsideCost,
        outsideProfit: outsideSourcedProfit,
        outsideMarginPct: pctOf(outsideSourcedProfit, ourPrice),
        profitDelta: sourcingGain,
      },
    },
    pricing: {
      ourPrice,
      outsidePrice,
      customerSaving,
      customerSavingPct: pctOf(customerSaving, outsidePrice),
      verdict: customerSaving > 0 ? 'below' : customerSaving < 0 ? 'above' : 'level',
    },
    margin: {
      ourCost,
      ourPrice,
      grossProfit,
      grossMarginPct: pctOf(grossProfit, ourPrice),
      markupPct: ourCost > 0 ? round2((grossProfit / ourCost) * 100) : null,
      verdict: grossProfit > 0 ? 'profit' : grossProfit < 0 ? 'loss' : 'break-even',
    },
    bridge: {
      ourProfit: grossProfit,
      outsideProfit,
      advantage: round2(grossProfit - outsideProfit),
      sourcingGain,
      customerSaving,
    },
  };
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
  DEFAULT_OUTSIDE_COST_RATIO,
  jobProfit,
  pctOf,
  outsideCostRatio,
  outsideCostUnit,
  jobProfitAnalysis,
  materialCostOf,
  normaliseSpec,
  sizeInchFromCode,
  tierValueOf,
  matchRate,
  matchFitting,
  compareLine,
};
