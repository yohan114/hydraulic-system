'use strict';

/**
 * Job Profit Analysis — per-invoice roll-up of our bill vs material cost vs the
 * outside/market cost, plus tracking of the technical/crimping (labour) charge
 * that is owed to the worker until marked paid.
 *
 * Per-line cost/market values come from the billing-time snapshot on
 * InvoiceItems (UnitCostAtBilling / MarketBillRate), falling back to the item's
 * current inventory cost/market for legacy lines. Only finalized invoices count.
 */

const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');

// A line is part of the labour pool if its description is a technical or
// crimping charge (case-insensitive).
const TECH_RE = /technical charge|crimping/i;
function isTechCharge(desc) { return TECH_RE.test(String(desc || '')); }

function emptyTotals() {
  return { count: 0, ourBill: 0, materialCost: 0, outsideCost: 0, profit: 0, grossProfit: 0, margin: 0, techCharges: 0, unpaidTech: 0 };
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
           inv.ProductName
    FROM InvoiceItems ii LEFT JOIN Inventory inv ON ii.InventoryID = inv.InventoryID
    WHERE ii.InvoiceID IN (${ids.join(',')})`);

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
      return {
        description: it.ItemDescription || it.ProductName || '',
        unit: it.Unit || '',
        length: money.num(it.Length),
        qty,
        ourCostRate: money.round2(unitCost),
        ourBilledRate: money.round2(rate),
        outsideRate: money.round2(marketRate),
        ourAmount,
        outsideAmount,
        diff: money.round2(ourAmount - outsideAmount),
        isTech: isTechCharge(it.ItemDescription || ''),
      };
    });

    const ourBill = money.round2(inv.GrandTotal);
    const materialCost = money.round2(lines.reduce((a, l) => a + l.qty * l.ourCostRate, 0));
    const outsideCost = money.round2(lines.reduce((a, l) => a + l.outsideAmount, 0));
    const techCharges = money.round2(lines.filter((l) => l.isTech).reduce((a, l) => a + l.ourAmount, 0));
    const profit = money.round2(ourBill - outsideCost);
    const margin = ourBill > 0 ? money.round2((profit / ourBill) * 100) : 0;

    return {
      invoiceId: inv.InvoiceID,
      invoiceNo: inv.InvoiceNo,
      invoiceDate: inv.InvoiceDate,
      customer: inv.BilledToName,
      ourBill,
      materialCost,
      outsideCost,
      profit,
      margin,
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
    materialCost: a.materialCost + r.materialCost,
    outsideCost: a.outsideCost + r.outsideCost,
    profit: a.profit + r.profit,
    techCharges: a.techCharges + r.techCharges,
    unpaidTech: a.unpaidTech + (r.techPaid ? 0 : r.techCharges),
  }), { ourBill: 0, materialCost: 0, outsideCost: 0, profit: 0, techCharges: 0, unpaidTech: 0 });
  for (const k of Object.keys(t)) t[k] = money.round2(t[k]);
  t.grossProfit = money.round2(t.ourBill - t.materialCost);
  t.margin = t.ourBill > 0 ? money.round2((t.profit / t.ourBill) * 100) : 0;
  t.count = filtered.length;
  t.unpaidCount = filtered.filter((r) => r.techCharges > 0 && !r.techPaid).length;

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
