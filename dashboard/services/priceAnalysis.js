'use strict';

/**
 * Price analysis — the "Cost vs Our Bill vs Market Bill" engine.
 *
 * Two responsibilities:
 *  1. At BILLING time, snapshot each invoice line's cost + market benchmark and
 *     derive profit / margin / market-gap / a price flag, so a finalized bill's
 *     profitability is frozen as it was when billed (cost & market prices drift).
 *  2. For the dashboard, aggregate finalized lines into rows + KPIs + chart
 *     series, re-flagging against a caller-chosen low-margin threshold.
 *
 * `computeLineMetrics` is pure (money-only) so it is unit-tested directly.
 */

const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const pricingEngine = require('./pricingEngine');

const LOW_MARGIN_DEFAULT = 15; // percent — a line at/under this is "low-margin"

const FLAGS = {
  BELOW_COST: 'below-cost',   // OurBill < Cost — we lose money (critical)
  OVER_MARKET: 'over-market', // OurBill > Market — we're pricier than the market
  LOW_MARGIN: 'low-margin',   // thin profit
  OK: 'ok',
};

/**
 * Derive per-line profitability + a single primary flag from the snapshot inputs.
 * Pure. Flag precedence: below-cost > over-market > low-margin > ok.
 *
 * @param {object} p
 * @param {number} p.unitCost   our unit cost at billing time
 * @param {number} p.ourRate    the unit rate we billed
 * @param {number} p.marketRate market unit benchmark (0 = unknown)
 * @param {number} p.qty        line quantity
 * @param {number} [p.lowMarginThreshold=15]
 * @returns {{profitAmount:number, marginPercent:number, marketGap:number, priceFlag:string}}
 */
function computeLineMetrics({ unitCost, ourRate, marketRate, qty, lowMarginThreshold = LOW_MARGIN_DEFAULT }) {
  const cost = money.num(unitCost);
  const rate = money.num(ourRate);
  const market = money.num(marketRate);
  const q = money.num(qty);
  const threshold = money.num(lowMarginThreshold);

  const profitAmount = money.round2((rate - cost) * q);
  const marginPercent = rate > 0 ? money.round2(((rate - cost) / rate) * 100) : 0;
  // Positive gap = we billed ABOVE market (less competitive); negative = below.
  const marketGap = money.round2((rate - market) * q);

  let priceFlag = FLAGS.OK;
  if (cost > 0 && rate < cost) priceFlag = FLAGS.BELOW_COST;
  else if (market > 0 && rate > market) priceFlag = FLAGS.OVER_MARKET;
  else if (rate > 0 && marginPercent < threshold) priceFlag = FLAGS.LOW_MARGIN;

  return { profitAmount, marginPercent, marketGap, priceFlag };
}

/**
 * Snapshot column values for one line at billing time. Also records the
 * SUGGESTED bill (70% of market mid, floored at cost) and the pricing source,
 * so a report can later show what the system suggested vs what was billed —
 * frozen as of billing time.
 * @returns {{unitCostAtBilling,ourBillRate,marketBillRate,suggestedBillRate,pricingSource,profitAmount,marginPercent,marketGap,priceFlag}}
 */
function lineSnapshot({ unitCost, ourRate, marketRate, qty, source, ferrule }) {
  const m = computeLineMetrics({ unitCost, ourRate, marketRate, qty });
  const suggested = pricingEngine.suggestUnit(unitCost, marketRate, { ferrule: !!ferrule });
  return {
    unitCostAtBilling: money.round2(money.num(unitCost)),
    ourBillRate: money.round2(money.num(ourRate)),
    marketBillRate: money.round2(money.num(marketRate)),
    suggestedBillRate: suggested.suggested,
    pricingSource: source || (money.num(marketRate) > 0 || money.num(unitCost) > 0 ? 'inventory' : 'manual'),
    pricingRuleApplied: suggested.rule,
    profitAmount: m.profitAmount,
    marginPercent: m.marginPercent,
    marketGap: m.marketGap,
    priceFlag: m.priceFlag,
  };
}

/** Current Cost + MarketMid (+ spec code, for ferrule detection) for a set of
 *  inventory ids (for the billing-time snapshot). */
async function loadCostMarket(ids) {
  const map = new Map();
  const unique = [...new Set((ids || []).filter((i) => i != null))];
  for (const id of unique) {
    const r = await connection.query(`SELECT Cost, MarketMid, SpecificationCode FROM Inventory WHERE InventoryID = ${sql.n(id)}`);
    if (r.length) map.set(id, { unitCost: money.num(r[0].Cost), marketRate: money.num(r[0].MarketMid), specCode: r[0].SpecificationCode });
  }
  return map;
}

function monthOf(dateVal) {
  const m = String(dateVal || '').match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : 'unknown';
}

/**
 * Build the dashboard dataset: per-line rows, KPI totals and chart series for
 * finalized invoices. Lines use their stored billing-time snapshot, falling back
 * to the item's current cost/market when a snapshot is absent (legacy rows).
 * Flags are recomputed against `lowMarginThreshold` so the UI's threshold filter
 * is live.
 *
 * @param {object} [opts]
 * @param {string} [opts.from] inclusive YYYY-MM-DD
 * @param {string} [opts.to]   inclusive YYYY-MM-DD
 * @param {string} [opts.flag] one of the FLAGS to filter by (or 'all')
 * @param {string} [opts.search] invoice no / product / description contains
 * @param {number} [opts.lowMarginThreshold=15]
 * @returns {Promise<{rows:Array, kpis:object, charts:object, lowMarginThreshold:number}>}
 */
async function billComparison(opts = {}) {
  const threshold = money.num(opts.lowMarginThreshold || LOW_MARGIN_DEFAULT);
  const conds = ["i.Status = 'Finalized'"];
  if (opts.from) conds.push(`i.InvoiceDate >= ${sql.dbDate(opts.from)}`);
  if (opts.to) conds.push(`i.InvoiceDate <= ${sql.dbDate(opts.to)}`);
  if (opts.search && String(opts.search).trim()) {
    const s = sql.esc(String(opts.search).trim());
    conds.push(`(i.InvoiceNo LIKE '%${s}%' OR ii.ItemDescription LIKE '%${s}%' OR inv.ProductName LIKE '%${s}%')`);
  }

  const raw = await connection.query(`
    SELECT ii.InvoiceItemID, i.InvoiceID, i.InvoiceNo, i.InvoiceDate, i.BilledToName,
           ii.ItemDescription, ii.Unit, ii.Qty, ii.Rate,
           COALESCE(ii.UnitCostAtBilling, inv.Cost, 0)  AS UnitCost,
           COALESCE(ii.MarketBillRate,  inv.MarketMid, 0) AS MarketRate,
           ii.SuggestedBillRate, ii.PricingSource, ii.PricingRuleApplied,
           inv.ProductName, inv.UniqueID, inv.SpecificationCode
    FROM (InvoiceItems ii INNER JOIN Invoices i ON ii.InvoiceID = i.InvoiceID)
         LEFT JOIN Inventory inv ON ii.InventoryID = inv.InventoryID
    WHERE ${conds.join(' AND ')}
    ORDER BY i.InvoiceDate DESC, ii.InvoiceItemID DESC
  `);

  const wantFlag = opts.flag && opts.flag !== 'all' ? opts.flag : null;
  const rows = [];
  const kpis = { lines: 0, ourBill: 0, cost: 0, profit: 0, marketBill: 0, suggestedBill: 0, marketGap: 0, belowCost: 0, lowMargin: 0, overMarket: 0 };
  const byMonth = new Map();      // month -> { ourBill, marketBill, cost, profit }
  const flagCounts = { 'below-cost': 0, 'low-margin': 0, 'over-market': 0, ok: 0 };

  for (const r of raw) {
    const qty = money.num(r.Qty);
    const ourRate = money.num(r.Rate);
    const unitCost = money.num(r.UnitCost);
    const marketRate = money.num(r.MarketRate);
    const m = computeLineMetrics({ unitCost, ourRate, marketRate, qty, lowMarginThreshold: threshold });

    // Warnings/KPIs are counted over the WHOLE (unfiltered-by-flag) result set.
    flagCounts[m.priceFlag] = (flagCounts[m.priceFlag] || 0) + 1;
    if (m.priceFlag === 'below-cost') kpis.belowCost++;
    else if (m.priceFlag === 'low-margin') kpis.lowMargin++;
    else if (m.priceFlag === 'over-market') kpis.overMarket++;

    const ourBill = money.round2(ourRate * qty);
    const marketBill = money.round2(marketRate * qty);
    const costTotal = money.round2(unitCost * qty);
    // Suggested 80% bill + rule: prefer the values snapshotted at billing time,
    // else derive (with ferrule detection from the item's spec code).
    const ferrule = pricingEngine.isFerrule(r.SpecificationCode);
    const derived = pricingEngine.suggestUnit(unitCost, marketRate, { ferrule });
    const suggestedUnit = r.SuggestedBillRate != null ? money.round2(r.SuggestedBillRate) : derived.suggested;
    const suggestedBill = money.round2(suggestedUnit * qty);
    const ruleApplied = r.PricingRuleApplied || derived.rule;
    const status = pricingEngine.priceStatus({ cost: unitCost, rate: ourRate, marketMid: marketRate });
    kpis.lines++;
    kpis.ourBill += ourBill;
    kpis.cost += costTotal;
    kpis.profit += m.profitAmount;
    kpis.marketBill += marketBill;
    kpis.suggestedBill += suggestedBill;
    kpis.marketGap += m.marketGap;

    const mo = byMonth.get(monthOf(r.InvoiceDate)) || { ourBill: 0, marketBill: 0, cost: 0, profit: 0 };
    mo.ourBill += ourBill; mo.marketBill += marketBill; mo.cost += costTotal; mo.profit += m.profitAmount;
    byMonth.set(monthOf(r.InvoiceDate), mo);

    if (wantFlag && m.priceFlag !== wantFlag) continue; // table respects the flag filter
    rows.push({
      invoiceItemId: r.InvoiceItemID,
      invoiceId: r.InvoiceID,
      invoiceNo: r.InvoiceNo,
      invoiceDate: r.InvoiceDate,
      customer: r.BilledToName,
      description: r.ItemDescription || r.ProductName || '',
      uniqueId: r.UniqueID || '',
      unit: r.Unit || '',
      qty,
      unitCost: money.round2(unitCost),
      ourBillRate: money.round2(ourRate),
      marketBillRate: money.round2(marketRate),
      suggestedBillRate: suggestedUnit,
      suggestedBill,
      ourBill,
      marketBill,
      cost: costTotal,
      profit: m.profitAmount,
      marginPercent: m.marginPercent,
      marketGap: m.marketGap,
      priceFlag: m.priceFlag,
      status,
      statusLabel: pricingEngine.STATUS_LABEL[status] || status,
      pricingSource: r.PricingSource || 'inventory',
      pricingRuleApplied: ruleApplied,
      ruleLabel: pricingEngine.RULE_LABEL[ruleApplied] || ruleApplied,
    });
  }

  for (const k of ['ourBill', 'cost', 'profit', 'marketBill', 'suggestedBill', 'marketGap']) kpis[k] = money.round2(kpis[k]);
  kpis.marginPercent = kpis.ourBill > 0 ? money.round2((kpis.profit / kpis.ourBill) * 100) : 0;
  kpis.flagged = kpis.belowCost + kpis.lowMargin + kpis.overMarket;

  const months = [...byMonth.keys()].filter((k) => k !== 'unknown').sort().map((month) => {
    const b = byMonth.get(month);
    return {
      month,
      ourBill: money.round2(b.ourBill),
      marketBill: money.round2(b.marketBill),
      cost: money.round2(b.cost),
      profit: money.round2(b.profit),
    };
  });

  return { rows, kpis, charts: { months, flagCounts }, lowMarginThreshold: threshold };
}

module.exports = { computeLineMetrics, lineSnapshot, loadCostMarket, billComparison, FLAGS, LOW_MARGIN_DEFAULT };
