'use strict';

/**
 * The SIMPLE export model for the Job Profit Analysis.
 *
 * The on-screen report carries all three comparisons; the exports deliberately
 * do not. A printed sheet is read by people who were not in the conversation,
 * so it shows one story only, in the shop's own layout:
 *
 *     OUR COST  |  OUTSIDE COST  |  PROFIT
 *
 * per invoice, then a SUMMARY, then what is still owed to the worker. The
 * "OUTSIDE COST" side is the outside-company benchmark — what the customer
 * would have paid to go elsewhere — matching the shop's existing spreadsheet.
 *
 * Both the Excel and the PDF writer consume this one model, so the two exports
 * can never drift apart.
 */

const money = require('../lib/money');

/**
 * Shop overhead added to every job's cost — power for the crimping machine and
 * the rest of the sundries — as a share of the job's other costs.
 * @type {number}
 */
const SUNDRY_RATE = 0.10;
const SUNDRY_LABEL = 'Sundry (Electricity) Cost (10%)';

// Crimping and welding are labour WE do in the shop. Both sides of the sheet
// carry the OUTSIDE rate for them — the market charge is taken as the cost of
// the labour, so these lines net to nothing in the comparison instead of
// crediting us with an internal-cost margin on our own time. A "weld fitting"
// is a part, not labour, and must keep its own separate cost and outside price.
const LABOUR_RE = /crimp|weld/i;
const WELD_PART_RE = /weld(ed|ing)?\s*fitting/i;
function isShopLabour(description) {
  const d = String(description || '');
  return LABOUR_RE.test(d) && !WELD_PART_RE.test(d);
}

// Inventory SpecificationCode is the bore in mm; show it the way the shop
// writes it on a job card ("13mm"). Blank when the line is not a sized part.
function sizeLabel(code) {
  const c = String(code == null ? '' : code).trim();
  return /^\d+$/.test(c) ? `${c}mm` : '';
}

// A block's "Hose Size" is the bore of the hose it was built around — the first
// line that is a hose. Falls back to the first sized line of any kind.
function hoseSizeOf(lines) {
  const hose = (lines || []).find((l) => /hose|rubber pipe/i.test(l.description || '') && sizeLabel(l.specCode));
  if (hose) return sizeLabel(hose.specCode);
  const any = (lines || []).find((l) => sizeLabel(l.specCode));
  return any ? sizeLabel(any.specCode) : '';
}

/**
 * Reshape {@link module:services/jobProfit.jobProfitData} output into the flat
 * block model the exports render.
 *
 * @param {{invoices:Array, totals:object}} data
 * @returns {{blocks:Array, unpaid:Array, totals:object}}
 */
function buildExportModel(data) {
  const invoices = (data && data.invoices) || [];
  const totals = (data && data.totals) || {};

  const blocks = invoices.map((inv) => {
    const lines = (inv.lines || []).map((l) => {
      // Only mirror when there IS an outside rate to mirror; a labour line with
      // no benchmark keeps its own cost rather than collapsing to zero.
      const labour = isShopLabour(l.description) && money.num(l.outsideRate) > 0;
      return {
        description: l.description,
        unit: l.unit,
        qty: l.qty,
        // OUR COST side: what the part cost us, not what we billed — except for
        // crimping and welding, which take the outside rate as their cost.
        costRate: labour ? l.outsideRate : l.ourCostRate,
        costAmount: labour ? l.outsideAmount : l.ourCost,
        // OUTSIDE COST side: what an outside company would have charged.
        outsideRate: l.outsideRate,
        outsideAmount: l.outsideAmount,
        isTech: !!l.isTech,
        isLabour: labour,
        isSundry: false,
      };
    });

    // Overhead line, charged on everything above it and carried into Total Our
    // Cost. It has no outside counterpart — an outside bill would bury it in
    // their own rates rather than show it.
    const jobCost = money.round2(lines.reduce((a, l) => a + money.num(l.costAmount), 0));
    const sundry = money.round2(jobCost * SUNDRY_RATE);
    lines.push({
      description: SUNDRY_LABEL,
      unit: 'lump sum',
      qty: null,
      costRate: null,
      costAmount: sundry,
      outsideRate: 0,
      outsideAmount: 0,
      isTech: false,
      isLabour: false,
      isSundry: true,
    });

    const ourCost = money.round2(jobCost + sundry);
    const outsideTotal = money.round2(lines.reduce((a, l) => a + money.num(l.outsideAmount), 0));
    const invoiceTotal = inv.ourPrice;

    return {
      invoiceNo: inv.invoiceNo,
      date: inv.invoiceDate ? String(inv.invoiceDate).slice(0, 10) : '',
      customer: inv.customer || 'Walk-in',
      hoseSize: hoseSizeOf(inv.lines),
      lines,
      ourCost,
      sundry,
      outsideTotal,
      invoiceTotal,
      profit: money.round2(invoiceTotal - ourCost),
      techCharges: inv.techCharges,
      techPaid: !!inv.techPaid,
    };
  });

  // Parts only — crimping, welding and the sundry overhead are not material.
  const materialCost = money.round2(
    blocks.reduce((a, b) => a + b.lines.filter((l) => !l.isTech && !l.isLabour && !l.isSundry)
      .reduce((s, l) => s + money.num(l.costAmount), 0), 0)
  );
  const sumOf = (key) => money.round2(blocks.reduce((a, b) => a + money.num(b[key]), 0));

  // Every job that carries a labour charge, paid or not, so the worker's
  // running balance is auditable rather than a single opaque total.
  const unpaid = blocks
    .filter((b) => b.techCharges > 0)
    .map((b) => ({
      invoiceNo: b.invoiceNo,
      date: b.date,
      customer: b.customer,
      amount: b.techCharges,
      status: b.techPaid ? 'Paid' : 'Unpaid',
    }));

  const paidRows = unpaid.filter((u) => u.status === 'Paid');
  const owedRows = unpaid.filter((u) => u.status === 'Unpaid');
  const sumRows = (rows) => money.round2(rows.reduce((a, u) => a + money.num(u.amount), 0));

  // The real span of the jobs in the report, which is not the same as the
  // filter the user typed (a whole-month filter can hold a week of work).
  const dates = blocks.map((b) => b.date).filter(Boolean).sort();

  return {
    blocks,
    unpaid,
    range: { from: dates[0] || '', to: dates[dates.length - 1] || '' },
    labour: {
      jobs: unpaid.length,
      paidCount: paidRows.length,
      paidAmount: sumRows(paidRows),
      unpaidCount: owedRows.length,
      unpaidAmount: sumRows(owedRows),
      billed: sumRows(unpaid),
    },
    totals: {
      count: blocks.length,
      // Rolled up from the adjusted blocks, not from the on-screen analysis:
      // these carry the sundry overhead and the labour parity above.
      ourCost: sumOf('ourCost'),
      sundry: sumOf('sundry'),
      outsideTotal: sumOf('outsideTotal'),
      invoiceTotal: sumOf('invoiceTotal'),
      profit: sumOf('profit'),
      materialCost,
      techCharges: money.round2(totals.techCharges),
      unpaidTech: money.round2(totals.unpaidTech),
      unpaidCount: totals.unpaidCount || 0,
    },
  };
}

module.exports = { buildExportModel, hoseSizeOf, sizeLabel, isShopLabour, SUNDRY_RATE, SUNDRY_LABEL };
