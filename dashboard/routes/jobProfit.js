'use strict';

/**
 * Job Profit Analysis endpoints — per-invoice profit data, the unpaid
 * technical/crimping (labour) summary, marking that labour paid, and the
 * PDF + Excel exports.
 *
 * The screen carries all three comparisons; the exports carry ONE simple
 * story — OUR COST | OUTSIDE COST | PROFIT per invoice, a summary, and the
 * labour still owed — because a printed sheet is read cold. Both exports are
 * built from the same model (services/jobProfitExport.js) so they cannot drift.
 */

const express = require('express');
const xlsx = require('xlsx');
const money = require('../lib/money');
const jobProfit = require('../services/jobProfit');
const { buildExportModel, SUNDRY_RATE } = require('../services/jobProfitExport');
const pdf = require('../services/pdf');
const { buildJobProfitHtml } = require('../services/jobProfitPdf');
const router = express.Router();

function parseOpts(q) {
  return {
    from: q.from || null,
    to: q.to || null,
    invoices: q.invoices ? String(q.invoices).split(',').map((s) => s.trim()).filter(Boolean) : null,
    status: q.status || 'all',
  };
}

function periodLabel(opts) {
  if (opts.from && opts.to) return `${opts.from} to ${opts.to}`;
  if (opts.from) return `from ${opts.from}`;
  if (opts.to) return `up to ${opts.to}`;
  if (opts.invoices && opts.invoices.length) return `${opts.invoices.length} selected invoice(s)`;
  return 'All finalized invoices';
}

router.get('/api/job-profit', async (req, res) => {
  try {
    res.json(await jobProfit.jobProfitData(parseOpts(req.query)));
  } catch (err) {
    res.status(500).json({ error: 'Could not build job profit analysis. Run "npm run migrate" first. ' + err.message });
  }
});

router.get('/api/job-profit/unpaid-summary', async (req, res) => {
  try {
    res.json(await jobProfit.unpaidSummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/job-profit/mark-paid', async (req, res) => {
  try {
    const b = req.body || {};
    const nums = Array.isArray(b.invoiceNumbers) ? b.invoiceNumbers : [];
    if (!nums.length) return res.status(400).json({ error: 'invoiceNumbers is required' });
    const changed = await jobProfit.markPaid(nums, !!b.paid);
    res.json({ success: true, changed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/job-profit/pdf', async (req, res) => {
  try {
    if (!pdf.isAvailable()) {
      return res.status(501).json({ error: 'PDF export is not available on the server (puppeteer is not installed).', code: 'PDF_UNAVAILABLE' });
    }
    const opts = parseOpts(req.query);
    const data = await jobProfit.jobProfitData(opts);
    const html = buildJobProfitHtml(buildExportModel(data), { period: periodLabel(opts) });
    const buffer = await pdf.htmlToPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Job_Profit_Analysis.pdf"');
    res.send(buffer);
  } catch (err) {
    console.error('Job profit PDF failed:', err.message);
    res.status(500).json({ error: 'Could not generate PDF. ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Excel writer — one sheet, laid out the way the shop's own spreadsheet is:
// OUR COST | OUTSIDE COST | PROFIT per invoice, then SUMMARY, then the labour
// still owed. Every derived number is written as a real Excel FORMULA, not a
// baked value, so the sheet recalculates when a rate is edited by hand.
// ---------------------------------------------------------------------------

const MONEY_FMT = '#,##0.00';
const PCT_FMT = '0.0%';

// Column letters of the layout (A..P), named so the formulas read as English.
const COL = {
  invoice: 'A', description: 'B', unit: 'C', qty: 'D', costRate: 'E', costAmount: 'F',
  totalOurCost: 'G', hoseSize: 'H', outsideRate: 'I', outsideQty: 'J', outsideAmount: 'K',
  totalOutside: 'L', spacer: 'M', invoiceTotal: 'N', profit: 'O', margin: 'P',
};

// Write one cell. `f` makes it a formula (with `v` kept as the cached value so
// readers that do not evaluate formulas still show the right number).
function put(ws, col, row, value, opts = {}) {
  const ref = `${col}${row}`;
  const cell = {};
  if (opts.f) {
    cell.t = 'n';
    cell.f = opts.f;
    if (value != null) cell.v = value;
  } else if (typeof value === 'number') {
    cell.t = 'n';
    cell.v = value;
  } else {
    if (value == null || value === '') return;
    cell.t = 's';
    cell.v = String(value);
  }
  if (opts.z) cell.z = opts.z;
  ws[ref] = cell;
}

function merge(ws, c1, r1, c2, r2) {
  ws['!merges'] = ws['!merges'] || [];
  ws['!merges'].push({ s: { c: xlsx.utils.decode_col(c1), r: r1 - 1 }, e: { c: xlsx.utils.decode_col(c2), r: r2 - 1 } });
}

function buildProfitSheet(model, periodText) {
  const ws = {};
  const { blocks, unpaid, totals } = model;
  let r = 1;

  // --- Banner + the three group headers ---
  put(ws, 'A', r, 'JOB PROFIT ANALYSIS');
  put(ws, COL.invoiceTotal, r, periodText);
  merge(ws, 'A', r, 'L', r);
  r += 1;

  put(ws, 'A', r, 'OUR COST');
  merge(ws, 'A', r, 'H', r);
  put(ws, COL.outsideRate, r, 'OUTSIDE COST');
  merge(ws, COL.outsideRate, r, COL.totalOutside, r);
  put(ws, COL.invoiceTotal, r, 'PROFIT');
  merge(ws, COL.invoiceTotal, r, COL.margin, r);
  r += 1;

  const HEAD = [
    [COL.invoice, 'Invoice Number'], [COL.description, 'Description'], [COL.unit, 'Unit'],
    [COL.qty, 'Qty'], [COL.costRate, 'Rate'], [COL.costAmount, 'Amount'],
    [COL.totalOurCost, 'Total Our Cost'], [COL.hoseSize, 'Hose Size'],
    [COL.outsideRate, 'Rate (Outside)'], [COL.outsideQty, 'Qty (Outside)'],
    [COL.outsideAmount, 'Outside Cost'], [COL.totalOutside, 'Total Outside Cost'],
    [COL.invoiceTotal, 'Invoice Total'], [COL.profit, 'Profit'], [COL.margin, 'Margin %'],
  ];
  HEAD.forEach(([c, t]) => put(ws, c, r, t));
  r += 1;

  // --- One block per invoice ---
  const blockRows = [];   // first row of each block, for the SUMMARY formulas
  blocks.forEach((b) => {
    const first = r;
    const n = Math.max(1, b.lines.length);

    b.lines.forEach((l, i) => {
      const row = first + i;
      put(ws, COL.description, row, l.description);
      put(ws, COL.unit, row, l.unit);

      if (l.isSundry) {
        // Overhead charged on every line above it, so it follows any edit to
        // the rates in this block.
        const f = i > 0
          ? `ROUND(SUM(${COL.costAmount}${first}:${COL.costAmount}${row - 1})*${SUNDRY_RATE},2)`
          : null;
        put(ws, COL.costAmount, row, l.costAmount, f ? { f, z: MONEY_FMT } : { z: MONEY_FMT });
        return;
      }

      put(ws, COL.qty, row, l.qty);
      // Crimping and welding take the OUTSIDE rate as their cost — written as a
      // reference to that cell, not a copy, so the two can never drift apart.
      put(ws, COL.costRate, row, l.costRate,
        l.isLabour ? { f: `${COL.outsideRate}${row}`, z: MONEY_FMT } : { z: MONEY_FMT });
      // Amount = Qty x Rate
      put(ws, COL.costAmount, row, l.costAmount, { f: `${COL.qty}${row}*${COL.costRate}${row}`, z: MONEY_FMT });
      if (l.outsideRate > 0) {
        put(ws, COL.outsideRate, row, l.outsideRate, { z: MONEY_FMT });
        // The outside quantity is always the same job, so it tracks our qty.
        put(ws, COL.outsideQty, row, l.qty, { f: `${COL.qty}${row}` });
        put(ws, COL.outsideAmount, row, l.outsideAmount, { f: `${COL.outsideRate}${row}*${COL.outsideQty}${row}`, z: MONEY_FMT });
      }
    });

    const last = first + n - 1;
    put(ws, COL.invoice, first, b.invoiceNo);
    put(ws, COL.totalOurCost, first, b.ourCost, { f: `SUM(${COL.costAmount}${first}:${COL.costAmount}${last})`, z: MONEY_FMT });
    put(ws, COL.hoseSize, first, b.hoseSize);
    put(ws, COL.totalOutside, first, b.outsideTotal, { f: `SUM(${COL.outsideAmount}${first}:${COL.outsideAmount}${last})`, z: MONEY_FMT });
    put(ws, COL.invoiceTotal, first, b.invoiceTotal, { z: MONEY_FMT });
    put(ws, COL.profit, first, b.profit, { f: `${COL.invoiceTotal}${first}-${COL.totalOurCost}${first}`, z: MONEY_FMT });
    put(ws, COL.margin, first, b.invoiceTotal > 0 ? b.profit / b.invoiceTotal : 0,
      { f: `IFERROR(${COL.profit}${first}/${COL.invoiceTotal}${first},0)`, z: PCT_FMT });

    if (n > 1) {
      [COL.invoice, COL.totalOurCost, COL.hoseSize, COL.totalOutside, COL.invoiceTotal, COL.profit, COL.margin]
        .forEach((c) => merge(ws, c, first, c, last));
    }
    blockRows.push(first);
    r = last + 2;   // one blank row between invoices
  });

  // --- SUMMARY: one line per job, profit measured against the outside bill ---
  const sumTitle = r;
  put(ws, 'A', sumTitle, 'SUMMARY');
  merge(ws, 'A', sumTitle, 'E', sumTitle);
  r += 1;
  ['Invoice Number', 'Our Actual Cost', 'Outside Cost', 'Profit', 'Margin %']
    .forEach((t, i) => put(ws, String.fromCharCode(65 + i), r, t));
  r += 1;

  const sumFirst = r;
  blocks.forEach((b, i) => {
    const src = blockRows[i];
    put(ws, 'A', r, b.invoiceNo);
    // Pulled straight from the detail block above, so editing a rate there
    // flows all the way through to the summary.
    put(ws, 'B', r, b.ourCost, { f: `${COL.totalOurCost}${src}`, z: MONEY_FMT });
    put(ws, 'C', r, b.outsideTotal, { f: `${COL.totalOutside}${src}`, z: MONEY_FMT });
    put(ws, 'D', r, money.round2(b.outsideTotal - b.ourCost), { f: `C${r}-B${r}`, z: MONEY_FMT });
    put(ws, 'E', r, b.outsideTotal > 0 ? (b.outsideTotal - b.ourCost) / b.outsideTotal : 0,
      { f: `IFERROR(D${r}/C${r},0)`, z: PCT_FMT });
    r += 1;
  });
  const sumLast = r - 1;

  put(ws, 'A', r, 'TOTAL');
  if (blocks.length) {
    put(ws, 'B', r, totals.ourCost, { f: `SUM(B${sumFirst}:B${sumLast})`, z: MONEY_FMT });
    put(ws, 'C', r, totals.outsideTotal, { f: `SUM(C${sumFirst}:C${sumLast})`, z: MONEY_FMT });
    put(ws, 'D', r, money.round2(totals.outsideTotal - totals.ourCost), { f: `SUM(D${sumFirst}:D${sumLast})`, z: MONEY_FMT });
    put(ws, 'E', r, totals.outsideTotal > 0 ? (totals.outsideTotal - totals.ourCost) / totals.outsideTotal : 0,
      { f: `IFERROR(D${r}/C${r},0)`, z: PCT_FMT });
  }
  r += 1;
  put(ws, 'A', r, 'Total Material Cost');
  put(ws, 'B', r, totals.materialCost, { z: MONEY_FMT });
  put(ws, 'C', r, '(parts only — excludes crimping, welding and sundry)');
  r += 1;
  put(ws, 'A', r, 'Total Sundry (Electricity)');
  put(ws, 'B', r, totals.sundry, { z: MONEY_FMT });
  put(ws, 'C', r, `(${Math.round(SUNDRY_RATE * 100)}% of each job's other costs, already inside Our Actual Cost)`);
  r += 2;

  // --- What is still owed to the worker ---
  put(ws, 'A', r, 'TECHNICAL / CRIMPING LABOUR');
  merge(ws, 'A', r, 'E', r);
  r += 1;
  ['Invoice Number', 'Date', 'Customer', 'Technical Charge', 'Status']
    .forEach((t, i) => put(ws, String.fromCharCode(65 + i), r, t));
  r += 1;

  const labFirst = r;
  unpaid.forEach((u) => {
    put(ws, 'A', r, u.invoiceNo);
    put(ws, 'B', r, u.date);
    put(ws, 'C', r, u.customer);
    put(ws, 'D', r, u.amount, { z: MONEY_FMT });
    put(ws, 'E', r, u.status);
    r += 1;
  });
  const labLast = r - 1;

  if (unpaid.length) {
    put(ws, 'A', r, 'TOTAL BILLED');
    put(ws, 'D', r, totals.techCharges, { f: `SUM(D${labFirst}:D${labLast})`, z: MONEY_FMT });
    r += 1;
    put(ws, 'A', r, 'TOTAL UNPAID');
    // Flip a Status cell to "Paid" and this figure drops on its own.
    put(ws, 'D', r, totals.unpaidTech, { f: `SUMIF(E${labFirst}:E${labLast},"Unpaid",D${labFirst}:D${labLast})`, z: MONEY_FMT });
    put(ws, 'E', r, `${totals.unpaidCount} job(s)`);
  } else {
    put(ws, 'A', r, 'No technical or crimping labour on these jobs.');
  }
  r += 2;

  // --- What this report covers ---
  put(ws, 'A', r, 'REPORT DETAILS');
  merge(ws, 'A', r, 'E', r);
  r += 1;

  const range = model.range || {};
  const lab = model.labour || {};
  const rangeText = range.from && range.to
    ? (range.from === range.to ? range.from : `${range.from}  to  ${range.to}`)
    : '—';

  const detail = [
    ['Date range (jobs in this report)', rangeText],
    ['Filter applied', periodText],
    ['Invoices / jobs', blocks.length],
  ];
  detail.forEach(([k, v]) => { put(ws, 'A', r, k); put(ws, 'B', r, v); merge(ws, 'B', r, 'E', r); r += 1; });

  put(ws, 'A', r, 'Jobs with technical / crimping labour');
  put(ws, 'B', r, lab.jobs || 0);
  r += 1;
  if (unpaid.length) {
    // Counted off the Status column, so editing a status updates these too.
    put(ws, 'A', r, '   — labour PAID');
    put(ws, 'B', r, lab.paidCount || 0, { f: `COUNTIF(E${labFirst}:E${labLast},"Paid")` });
    put(ws, 'C', r, 'job(s)');
    put(ws, 'D', r, lab.paidAmount || 0, { f: `SUMIF(E${labFirst}:E${labLast},"Paid",D${labFirst}:D${labLast})`, z: MONEY_FMT });
    r += 1;
    put(ws, 'A', r, '   — labour UNPAID');
    put(ws, 'B', r, lab.unpaidCount || 0, { f: `COUNTIF(E${labFirst}:E${labLast},"Unpaid")` });
    put(ws, 'C', r, 'job(s)');
    put(ws, 'D', r, lab.unpaidAmount || 0, { f: `SUMIF(E${labFirst}:E${labLast},"Unpaid",D${labFirst}:D${labLast})`, z: MONEY_FMT });
    r += 1;
    put(ws, 'A', r, 'Total labour billed');
    put(ws, 'D', r, lab.billed || 0, { f: `SUM(D${labFirst}:D${labLast})`, z: MONEY_FMT });
    r += 1;
  }
  put(ws, 'A', r, 'Sundry (Electricity) rate');
  put(ws, 'B', r, `${Math.round(SUNDRY_RATE * 100)}% of each job's other costs`);
  merge(ws, 'B', r, 'E', r);
  r += 1;
  put(ws, 'A', r, 'Figures');
  put(ws, 'B', r, 'Exclude SSCL/VAT. Totals, Amounts and Margins are live formulas.');
  merge(ws, 'B', r, 'L', r);
  r += 1;

  ws['!ref'] = `A1:${COL.margin}${r}`;
  ws['!cols'] = [
    { wch: 22 }, { wch: 44 }, { wch: 10 }, { wch: 9 }, { wch: 11 }, { wch: 13 },
    { wch: 15 }, { wch: 11 }, { wch: 15 }, { wch: 13 }, { wch: 14 }, { wch: 18 },
    { wch: 3 }, { wch: 14 }, { wch: 13 }, { wch: 10 },
  ];
  return ws;
}

router.get('/api/job-profit/excel', async (req, res) => {
  try {
    const opts = parseOpts(req.query);
    const data = await jobProfit.jobProfitData(opts);
    const model = buildExportModel(data);

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, buildProfitSheet(model, periodLabel(opts)), 'Profit Analysis');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Job_Profit_Analysis.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating export');
  }
});

module.exports = router;
