'use strict';

/**
 * Job Profit Analysis endpoints — per-invoice profit data, the unpaid
 * technical/crimping (labour) summary, marking that labour paid, and the
 * colourful PDF + Excel exports.
 */

const express = require('express');
const xlsx = require('xlsx');
const money = require('../lib/money');
const jobProfit = require('../services/jobProfit');
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
    const html = buildJobProfitHtml(data, { period: periodLabel(opts) });
    const buffer = await pdf.htmlToPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Job_Profit_Analysis.pdf"');
    res.send(buffer);
  } catch (err) {
    console.error('Job profit PDF failed:', err.message);
    res.status(500).json({ error: 'Could not generate PDF. ' + err.message });
  }
});

router.get('/api/job-profit/excel', async (req, res) => {
  try {
    const opts = parseOpts(req.query);
    const { invoices, totals } = await jobProfit.jobProfitData(opts);

    // Sheet 1 — Detail: every line item, with outside comparison.
    const detail = [];
    invoices.forEach((inv) => {
      inv.lines.forEach((l) => {
        detail.push({
          'Invoice Number': inv.invoiceNo,
          'Description': l.description,
          'Unit': l.unit,
          'Qty': l.qty,
          'Our Cost Rate': l.ourCostRate,
          'Our Billed Rate': l.ourBilledRate,
          'Outside Market Rate': l.outsideRate,
          'Our Amount': l.ourAmount,
          'Outside Amount': l.outsideAmount,
          'Diff': l.diff,
          'Invoice Total': inv.ourBill,
          'Technical/Crimping': l.isTech ? 'YES' : '',
        });
      });
    });

    // Sheet 2 — Summary: one row per invoice + totals + unpaid labour.
    const summary = invoices.map((inv) => ({
      'Invoice': inv.invoiceNo,
      'Date': inv.invoiceDate ? String(inv.invoiceDate).slice(0, 10) : '',
      'Customer': inv.customer || '',
      'Our Cost (Billed)': inv.ourBill,
      'Outside Cost': inv.outsideCost,
      'Profit/Loss': inv.profit,
      'Margin %': inv.margin,
      'Technical Charges': inv.techCharges,
      'Labour': inv.techPaid ? 'Paid' : 'Unpaid',
    }));
    summary.push({});
    summary.push({
      'Invoice': 'TOTAL',
      'Our Cost (Billed)': totals.ourBill,
      'Outside Cost': totals.outsideCost,
      'Profit/Loss': totals.profit,
      'Margin %': totals.margin,
      'Technical Charges': totals.techCharges,
    });
    summary.push({ 'Invoice': 'TOTAL UNPAID TECHNICAL CHARGES', 'Our Cost (Billed)': totals.unpaidTech });

    const wb = xlsx.utils.book_new();
    const ws1 = xlsx.utils.json_to_sheet(detail.length ? detail : [{ 'Invoice Number': 'No data' }]);
    const ws2 = xlsx.utils.json_to_sheet(summary.length ? summary : [{ 'Invoice': 'No data' }]);
    xlsx.utils.book_append_sheet(wb, ws1, 'Detail');
    xlsx.utils.book_append_sheet(wb, ws2, 'Summary');
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
