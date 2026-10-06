'use strict';

/**
 * Workshop endpoints — quotations, job cards, technician labour.
 *
 * Invoicing a job deliberately does NOT reimplement billing: it builds the
 * payload and the caller posts it through the existing finalize endpoint, so
 * stock checks, race-free numbering and ledger posting all still apply.
 */

const express = require('express');
const connection = require('../db');
const sql = require('../lib/sql');
const jobs = require('../services/jobs');
const router = express.Router();

function fail(res, err) {
  res.status(err && err.httpStatus ? err.httpStatus : 500).json({ error: err.message || String(err) });
}
const actor = (req) => (req.user && req.user.username) || null;

// ------------------------------------------------------------ quotations

router.get('/api/quotations', async (req, res) => {
  try {
    const rows = await connection.query(`
      SELECT q.*, c.Name AS CustomerName, m.Name AS MachineName,
             ROUND(COALESCE(SUM(i.Qty * i.Rate), 0), 2) AS Total,
             COUNT(i.QuoteItemID) AS Lines,
             (SELECT JobNo FROM JobCards j WHERE j.QuoteID = q.QuoteID) AS JobNo
      FROM Quotations q
      LEFT JOIN Customers c ON c.CustomerID = q.CustomerID
      LEFT JOIN Machines m ON m.MachineID = q.MachineID
      LEFT JOIN QuotationItems i ON i.QuoteID = q.QuoteID
      GROUP BY q.QuoteID ORDER BY q.QuoteDate DESC, q.QuoteID DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not load quotations. Run "npm run migrate" first. ' + err.message });
  }
});

router.post('/api/quotations', async (req, res) => {
  try {
    const result = jobs.createQuotation({ ...(req.body || {}), postedBy: actor(req) });
    res.locals.audit = { entity: 'quotation', entityId: result.quoteId, action: 'create' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

router.post('/api/quotations/:id/convert', async (req, res) => {
  try {
    const result = jobs.quotationToJob(sql.n(req.params.id), req.body || {});
    res.locals.audit = { entity: 'quotation', entityId: req.params.id, action: 'convert' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

// ------------------------------------------------------------- job cards

router.get('/api/jobs', async (req, res) => {
  try {
    const where = [];
    if (req.query.status) where.push(`j.Status = ${sql.q(req.query.status)}`);
    if (req.query.open === '1') where.push("j.Status NOT IN ('invoiced','cancelled')");

    const rows = await connection.query(`
      SELECT j.*, c.Name AS CustomerName, m.Name AS MachineName, i.InvoiceNo, w.Name AS WorkerName,
             ROUND(COALESCE((SELECT SUM(Qty * Rate) FROM JobCardItems x WHERE x.JobID = j.JobID), 0), 2) AS Total,
             ROUND(COALESCE((SELECT SUM(Amount) FROM JobLabour l WHERE l.JobID = j.JobID), 0), 2) AS LabourCost,
             (SELECT COUNT(*) FROM JobCardItems x WHERE x.JobID = j.JobID) AS Lines
      FROM JobCards j
      LEFT JOIN Customers c ON c.CustomerID = j.CustomerID
      LEFT JOIN Machines m ON m.MachineID = j.MachineID
      LEFT JOIN Invoices i ON i.InvoiceID = j.InvoiceID
      LEFT JOIN JobLabour jl ON jl.JobID = j.JobID
      LEFT JOIN Workers w ON w.WorkerID = jl.WorkerID
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY j.JobID
      ORDER BY CASE j.Priority WHEN 'urgent' THEN 0 ELSE 1 END, j.ReceivedAt DESC, j.JobID DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not load job cards. Run "npm run migrate" first. ' + err.message });
  }
});

router.get('/api/jobs/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const head = await connection.query(`
      SELECT j.*, c.Name AS CustomerName, m.Name AS MachineName, i.InvoiceNo, q.QuoteNo
      FROM JobCards j
      LEFT JOIN Customers c ON c.CustomerID = j.CustomerID
      LEFT JOIN Machines m ON m.MachineID = j.MachineID
      LEFT JOIN Invoices i ON i.InvoiceID = j.InvoiceID
      LEFT JOIN Quotations q ON q.QuoteID = j.QuoteID
      WHERE j.JobID = ${id}`);
    if (!head.length) return res.status(404).json({ error: 'Job card not found' });

    const items = await connection.query(`
      SELECT i.*, inv.ProductName, ROUND(i.Qty * i.Rate, 2) AS Amount
      FROM JobCardItems i LEFT JOIN Inventory inv ON inv.InventoryID = i.InventoryID
      WHERE i.JobID = ${id} ORDER BY i.JobItemID`);
    const labour = await connection.query(`
      SELECT l.*, w.Name AS WorkerName, p.PaymentDate
      FROM JobLabour l
      LEFT JOIN Workers w ON w.WorkerID = l.WorkerID
      LEFT JOIN LabourPayments p ON p.LabourPaymentID = l.LabourPaymentID
      WHERE l.JobID = ${id} ORDER BY l.JobLabourID`);

    const total = items.reduce((a, i) => a + (i.Amount || 0), 0);
    const labourCost = labour.reduce((a, l) => a + (l.Amount || 0), 0);
    res.json({
      ...head[0], items, labour,
      Total: Math.round(total * 100) / 100,
      LabourCost: Math.round(labourCost * 100) / 100,
    });
  } catch (err) { fail(res, err); }
});

router.post('/api/jobs', async (req, res) => {
  try {
    const result = jobs.createJob({ ...(req.body || {}), postedBy: actor(req) });
    res.locals.audit = { entity: 'job', entityId: result.jobId, action: 'create' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

router.put('/api/jobs/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const job = jobs.updateJob(id, req.body || {});
    if (Array.isArray((req.body || {}).items)) jobs.setJobItems(id, req.body.items);
    res.locals.audit = { entity: 'job', entityId: id, action: 'update' };
    res.json({ success: true, job });
  } catch (err) { fail(res, err); }
});

/** The payload to hand to /api/invoices/finalize for this job. */
router.get('/api/jobs/:id/invoice-payload', async (req, res) => {
  try {
    const { job, payload } = jobs.invoicePayloadFor(sql.n(req.params.id));
    res.json({ jobNo: job.JobNo, ...payload });
  } catch (err) { fail(res, err); }
});

router.post('/api/jobs/:id/invoiced', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const invoiceId = sql.n((req.body || {}).invoiceId);
    jobs.markInvoiced(id, invoiceId);
    res.locals.audit = { entity: 'job', entityId: id, action: 'invoiced' };
    res.json({ success: true });
  } catch (err) { fail(res, err); }
});

// -------------------------------------------------------------- labour

router.post('/api/jobs/:id/labour', async (req, res) => {
  try {
    const result = jobs.addJobLabour(sql.n(req.params.id), { ...(req.body || {}), postedBy: actor(req) });
    res.locals.audit = { entity: 'job-labour', entityId: result.jobLabourId, action: 'accrue' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

router.get('/api/labour/owed', async (req, res) => {
  try { res.json(jobs.labourOwed()); } catch (err) { fail(res, err); }
});

router.post('/api/labour/pay', async (req, res) => {
  try {
    const result = jobs.payJobLabour({ ...(req.body || {}), postedBy: actor(req) });
    res.locals.audit = { entity: 'labour-payment', entityId: result.labourPaymentId, action: 'pay' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

module.exports = router;
