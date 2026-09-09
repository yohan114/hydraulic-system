'use strict';

/**
 * Job Profit Analysis — reads every job as THREE comparisons, in the order the
 * shop reasons about it (buy, sell, bank). See lib/finance.js jobProfitAnalysis:
 *
 *   (1) BUYING   our cost   vs outside cost   — did buying our way beat buying
 *                locally? Carried with a side-by-side profit & loss compare.
 *   (2) SELLING  our price  vs outside price  — how far under the market we
 *                billed, i.e. what the customer saved by coming to us.
 *   (3) EARNING  our cost   vs our price      — the profit banked on the job.
 *
 * Also tracks the technical/crimping (labour) charge owed to the worker until
 * marked paid.
 *
 * The four money columns per line:
 *   ourCost       billing-time snapshot UnitCostAtBilling, else the item's Cost
 *   outsideCost   Inventory.MarketLow, else the Rate Card's Outside Low band,
 *                 else the line's outside price x the card's own Low/Mid ratio
 *                 (flagged 'derived' so an estimate never reads as a fact)
 *   ourPrice      qty x the rate actually billed
 *   outsidePrice  billing-time snapshot MarketBillRate, else Inventory.MarketMid
 *
 * Unlike cost and market price, outside cost is NOT snapshotted at billing time
 * — it is resolved when the report runs, so filling in MarketLow improves past
 * jobs too. Only finalized invoices count.
 */

const connection = require('../db');
const money = require('../lib/money');
const finance = require('../lib/finance');
const sql = require('../lib/sql');
const { loadRateCardSafe, matchLineRate } = require('./ratecard');

// A line is part of the labour pool if its description is a technical or
// crimping charge (case-insensitive).
const TECH_RE = /technical charge|crimping/i;
function isTechCharge(desc) { return TECH_RE.test(String(desc || '')); }

function emptyTotals() {
  return {
    count: 0, unpaidCount: 0,
    ourBill: 0, ourCost: 0, outsideCost: 0, ourPrice: 0, outsidePrice: 0,
    materialCost: 0, profit: 0, grossProfit: 0, margin: 0,
    marketGap: 0, techCharges: 0, unpaidTech: 0,
    analysis: finance.jobProfitAnalysis({ ourCost: 0, ourPrice: 0, outsideCost: 0, outsidePrice: 0 }),
  };
}

// Roll a set of analysed lines up into the four money columns the three
// comparisons are built from.
function totalLines(lines) {
  return lines.reduce(
    (a, l) => ({
      ourCost: money.round2(a.ourCost + l.ourCost),
      ourPrice: money.round2(a.ourPrice + l.ourAmount),
      outsideCost: money.round2(a.outsideCost + l.outsideCost),
      outsidePrice: money.round2(a.outsidePrice + l.outsideAmount),
    }),
    { ourCost: 0, ourPrice: 0, outsideCost: 0, outsidePrice: 0 }
  );
}

/**
 * Per-invoice profit rows (with itemised line detail) for the filtered set.
 * @param {object} [opts]
 * @param {string} [opts.from] inclusive YYYY-MM-DD
 * @param {string} [opts.to]   inclusive YYYY-MM-DD
 * @param {string[]} [opts.invoices] specific invoice numbers
 * @param {string} [opts.status] 'all' | 'unpaid' | 'paid'
 * @returns {Promise<{invoices:Array, totals:object}>}
 */
async function jobProfitData(opts = {}) {
  const conds = ["Status = 'Finalized'"];
  if (opts.from) conds.push(`InvoiceDate >= ${sql.dbDate(opts.from)}`);
  if (opts.to) conds.push(`InvoiceDate <= ${sql.dbDate(opts.to)}`);
  if (Array.isArray(opts.invoices) && opts.invoices.length) {
    conds.push(`InvoiceNo IN (${opts.invoices.map((n) => sql.q(n)).join(', ')})`);
  }

  const invs = await connection.query(
    `SELECT InvoiceID, InvoiceNo, InvoiceDate, BilledToName, GrandTotal, TechChargePaid
     FROM Invoices WHERE ${conds.join(' AND ')} ORDER BY InvoiceDate ASC, InvoiceID ASC`
  );
  if (!invs.length) return { invoices: [], totals: emptyTotals() };

  const ids = invs.map((i) => i.InvoiceID);
  const items = await connection.query(`
    SELECT ii.InvoiceID, ii.ItemDescription, ii.Unit, ii.Length, ii.Qty, ii.Rate,
           COALESCE(ii.UnitCostAtBilling, inv.Cost, 0)  AS UnitCost,
           COALESCE(ii.MarketBillRate,  inv.MarketMid, 0) AS MarketRate,
           COALESCE(inv.MarketLow, 0) AS MarketLow,
           inv.ProductName, inv.SpecificationCode
    FROM InvoiceItems ii LEFT JOIN Inventory inv ON ii.InventoryID = inv.InventoryID
    WHERE ii.InvoiceID IN (${ids.join(',')})`);

  // The Rate Card supplies the Outside Low fallback, and its own median Low/Mid
  // ratio is what a derived outside cost is scaled by.
  const rates = await loadRateCardSafe();
  const ratio = finance.outsideCostRatio(rates);

  const byInv = new Map();
  for (const it of items) {
    if (!byInv.has(it.InvoiceID)) byInv.set(it.InvoiceID, []);
    byInv.get(it.InvoiceID).push(it);
  }

  const rows = invs.map((inv) => {
    const lines = (byInv.get(inv.InvoiceID) || []).map((it) => {
      const qty = money.num(it.Qty);
      const rate = money.num(it.Rate);
      const unitCost = money.num(it.UnitCost);
      const marketRate = money.num(it.MarketRate);
      const ourAmount = money.round2(qty * rate);
      const outsideAmount = money.round2(qty * marketRate);
      const ourCost = money.round2(qty * unitCost);

      // (1) What the same part would have cost bought from a local supplier.
      const oc = finance.outsideCostUnit({
        marketLow: it.MarketLow,
        rate: matchLineRate(rates, it),
        marketMid: marketRate,
        ratio,
      });
      const outsideCost = money.round2(qty * oc.unit);

      return {
        description: it.ItemDescription || it.ProductName || '',
        unit: it.Unit || '',
        specCode: it.SpecificationCode || '',
        length: money.num(it.Length),
        qty,
        ourCostRate: money.round2(unitCost),
        ourBilledRate: money.round2(rate),
        outsideCostRate: oc.unit,
        outsideRate: money.round2(marketRate),
        ourCost,
        outsideCost,
        outsideCostBasis: oc.basis,
        ourAmount,
        outsideAmount,
        // (1) buying, (2) selling, (3) earning — per line.
        sourcingGain: money.round2(outsideCost - ourCost),
        customerSaving: money.round2(outsideAmount - ourAmount),
        grossProfit: money.round2(ourAmount - ourCost),
        costMatched: outsideCost > 0,
        priceMatched: outsideAmount > 0,
        // Legacy field: our amount vs the outside amount (kept for the old
        // "Diff" column). Note this is a market gap, NOT a profit.
        diff: money.round2(ourAmount - outsideAmount),
        isTech: isTechCharge(it.ItemDescription || ''),
      };
    });

    const t = totalLines(lines);
    const analysis = finance.jobProfitAnalysis(t);
    const ourBill = money.round2(inv.GrandTotal);
    const techCharges = money.round2(lines.filter((l) => l.isTech).reduce((a, l) => a + l.ourAmount, 0));

    return {
      invoiceId: inv.InvoiceID,
      invoiceNo: inv.InvoiceNo,
      invoiceDate: inv.InvoiceDate,
      customer: inv.BilledToName,
      ourBill,
      // Older invoices (before SSCL/VAT were dropped) have a tax-inclusive
      // GrandTotal. Tax is collected for the state, not shop income, so all
      // three comparisons run on the ex-tax line sums and the difference is
      // reported here rather than silently inflating the margin.
      taxCollected: money.round2(ourBill - t.ourPrice),
      // The four money columns the three comparisons are built from.
      ourCost: t.ourCost,
      outsideCost: t.outsideCost,
      ourPrice: t.ourPrice,
      outsidePrice: t.outsidePrice,
      analysis,
      // (3) is the real profit on the job: our price − our cost.
      profit: analysis.margin.grossProfit,
      margin: analysis.margin.grossMarginPct == null ? 0 : analysis.margin.grossMarginPct,
      // (1) and (2) at a glance.
      sourcingGain: analysis.sourcing.gain,
      customerSaving: analysis.pricing.customerSaving,
      // What our bill is vs the market bill. Previously mis-labelled "profit".
      marketGap: money.round2(t.ourPrice - t.outsidePrice),
      // Kept so existing callers (P&L, charts) keep reading the same figure.
      materialCost: t.ourCost,
      techCharges,
      techPaid: !!inv.TechChargePaid,
      lines,
    };
  });

  let filtered = rows;
  if (opts.status === 'unpaid') filtered = rows.filter((r) => r.techCharges > 0 && !r.techPaid);
  else if (opts.status === 'paid') filtered = rows.filter((r) => r.techPaid);

  const t = filtered.reduce((a, r) => ({
    ourBill: a.ourBill + r.ourBill,
    ourCost: a.ourCost + r.ourCost,
    outsideCost: a.outsideCost + r.outsideCost,
    ourPrice: a.ourPrice + r.ourPrice,
    outsidePrice: a.outsidePrice + r.outsidePrice,
    techCharges: a.techCharges + r.techCharges,
    unpaidTech: a.unpaidTech + (r.techPaid ? 0 : r.techCharges),
  }), { ourBill: 0, ourCost: 0, outsideCost: 0, ourPrice: 0, outsidePrice: 0, techCharges: 0, unpaidTech: 0 });
  for (const k of Object.keys(t)) t[k] = money.round2(t[k]);

  // The same three comparisons, over the whole filtered period.
  t.analysis = finance.jobProfitAnalysis(t);
  t.materialCost = t.ourCost;                       // legacy alias
  t.grossProfit = t.analysis.margin.grossProfit;    // (3) our price − our cost
  t.profit = t.analysis.margin.grossProfit;
  t.margin = t.analysis.margin.grossMarginPct == null ? 0 : t.analysis.margin.grossMarginPct;
  t.sourcingGain = t.analysis.sourcing.gain;        // (1)
  t.customerSaving = t.analysis.pricing.customerSaving; // (2)
  t.marketGap = money.round2(t.ourPrice - t.outsidePrice);
  t.taxCollected = money.round2(t.ourBill - t.ourPrice);
  t.count = filtered.length;
  t.unpaidCount = filtered.filter((r) => r.techCharges > 0 && !r.techPaid).length;
  // How firm the outside-cost column is, so the UI can say where it came from.
  t.outsideCostBasis = filtered.reduce((a, r) => {
    r.lines.forEach((l) => { a[l.outsideCostBasis] = (a[l.outsideCostBasis] || 0) + 1; });
    return a;
  }, { item: 0, ratecard: 0, derived: 0, none: 0 });

  return { invoices: filtered, totals: t };
}

/** Total unpaid technical/crimping charge across ALL finalized invoices. */
async function unpaidSummary() {
  const rows = await connection.query(`
    SELECT ii.InvoiceID, ii.ItemDescription, ii.Qty, ii.Rate
    FROM InvoiceItems ii JOIN Invoices i ON ii.InvoiceID = i.InvoiceID
    WHERE i.Status = 'Finalized' AND (i.TechChargePaid IS NULL OR i.TechChargePaid = 0)`);
  let total = 0;
  const jobs = new Set();
  for (const r of rows) {
    if (isTechCharge(r.ItemDescription)) {
      total += money.num(r.Qty) * money.num(r.Rate);
      jobs.add(r.InvoiceID);
    }
  }
  return { totalUnpaid: money.round2(total), count: jobs.size };
}

/** Mark the technical/crimping charge paid (or unpaid) for a set of invoices. */
async function markPaid(invoiceNumbers, paid) {
  if (!Array.isArray(invoiceNumbers) || !invoiceNumbers.length) return 0;
  const list = invoiceNumbers.map((n) => sql.q(String(n))).join(', ');
  const info = await connection.execute(
    `UPDATE Invoices SET TechChargePaid = ${paid ? 1 : 0} WHERE InvoiceNo IN (${list})`
  );
  return (info && info.changes) || 0;
}

module.exports = { jobProfitData, unpaidSummary, markPaid, isTechCharge };
