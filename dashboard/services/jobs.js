'use strict';

/**
 * Workshop operations: quotations, job cards, and technician labour.
 *
 *   Quotation  →  Job Card  →  Invoice
 *                    ↓
 *                 JobLabour  →  a real Worker, accrued then paid
 *
 * The labour treatment is the part that changes how the books read. Technician
 * work is EARNED when the job is completed and PAID later, so it accrues:
 *
 *   Job completed   Dr Cost of Sales — Technical Labour   Cr Accrued Technical Labour
 *   Worker paid     Dr Accrued Technical Labour           Cr Cash / Bank
 *
 * Before this, a payout hit Wages directly and the liability never existed, so
 * the balance sheet never showed what was owed to the worker. Account 2200 was
 * seeded in migration 0005 for exactly this and had nothing posted to it.
 */

const connection = require('../db');
const money = require('../lib/money');
const ledgerSvc = require('./ledger');
const { ACC } = require('./glPosting');

const ACCRUED_LABOUR = '2200';
const COGS_LABOUR = '5200';

const JOB_STATUSES = ['open', 'in-progress', 'waiting-parts', 'completed', 'invoiced', 'cancelled'];
const QUOTE_STATUSES = ['open', 'accepted', 'declined', 'expired'];

class JobError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'JobError';
    this.httpStatus = status;
  }
}

/** Next document number for a prefix, e.g. JOB/2026/0007. */
function nextDocNo(prefix, table, column) {
  const year = new Date().getFullYear();
  const row = connection._db.prepare(
    `SELECT ${column} AS no FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`
  ).get(`${prefix}/${year}/%`);
  let seq = 1;
  if (row) {
    const m = /(\d+)$/.exec(row.no);
    if (m) seq = Number(m[1]) + 1;
  }
  return `${prefix}/${year}/${String(seq).padStart(4, '0')}`;
}

function requireDate(value, label) {
  const d = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new JobError(`A valid ${label} is required`);
  return d;
}

// ------------------------------------------------------------- quotations

function createQuotation(q) {
  const db = connection._db;
  const items = (q.items || []).filter((i) => money.num(i.qty) > 0);
  if (!items.length) throw new JobError('A quotation needs at least one line with a quantity');
  const quoteDate = requireDate(q.quoteDate, 'quote date');

  return db.transaction(() => {
    const quoteNo = nextDocNo('QTN', 'Quotations', 'QuoteNo');
    const info = db.prepare(`INSERT INTO Quotations
      (QuoteNo, CustomerID, MachineID, QuoteDate, ValidUntil, Status, Notes, CreatedAt, UpdatedAt)
      VALUES (?, ?, ?, ?, ?, 'open', ?, datetime('now','localtime'), datetime('now','localtime'))`)
      .run(quoteNo, q.customerId || null, q.machineId || null, quoteDate, q.validUntil || null, q.notes || null);

    const ins = db.prepare(`INSERT INTO QuotationItems
      (QuoteID, InventoryID, Description, Unit, Qty, Rate) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const i of items) {
      ins.run(info.lastInsertRowid, i.inventoryId || null, i.description || null,
        i.unit || null, money.num(i.qty), money.round2(i.rate));
    }
    return { quoteId: info.lastInsertRowid, quoteNo };
  })();
}

/** Turn an accepted quotation into a job card, carrying its lines across. */
function quotationToJob(quoteId, opts = {}) {
  const db = connection._db;
  const quote = db.prepare('SELECT * FROM Quotations WHERE QuoteID = ?').get(quoteId);
  if (!quote) throw new JobError(`Quotation ${quoteId} not found`, 404);
  if (quote.Status === 'declined') throw new JobError('That quotation was declined');

  const existing = db.prepare('SELECT JobID, JobNo FROM JobCards WHERE QuoteID = ?').get(quoteId);
  if (existing) return { jobId: existing.JobID, jobNo: existing.JobNo, alreadyConverted: true };

  const items = db.prepare('SELECT * FROM QuotationItems WHERE QuoteID = ? ORDER BY QuoteItemID').all(quoteId);
  const job = createJob({
    customerId: quote.CustomerID,
    machineId: quote.MachineID,
    quoteId,
    description: opts.description || quote.Notes || `From quotation ${quote.QuoteNo}`,
    receivedAt: opts.receivedAt || new Date().toISOString().slice(0, 10),
    promisedAt: opts.promisedAt || null,
    items: items.map((i) => ({
      inventoryId: i.InventoryID, description: i.Description,
      unit: i.Unit, qty: i.Qty, rate: i.Rate,
    })),
  });
  db.prepare("UPDATE Quotations SET Status = 'accepted', UpdatedAt = datetime('now','localtime') WHERE QuoteID = ?").run(quoteId);
  return { ...job, alreadyConverted: false };
}

// -------------------------------------------------------------- job cards

/**
 * @param {object} job { customerId, machineId, quoteId, description, hoseSpec,
 *   priority, receivedAt, promisedAt, notes, items: [...] }
 */
function createJob(job) {
  const db = connection._db;
  const receivedAt = requireDate(job.receivedAt || new Date().toISOString().slice(0, 10), 'received date');
  const items = (job.items || []).filter((i) => money.num(i.qty) > 0);

  return db.transaction(() => {
    const jobNo = nextDocNo('JOB', 'JobCards', 'JobNo');
    const info = db.prepare(`INSERT INTO JobCards
      (JobNo, CustomerID, MachineID, QuoteID, Description, HoseSpec, Status, Priority,
       ReceivedAt, PromisedAt, Notes, CreatedAt, UpdatedAt)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`)
      .run(jobNo, job.customerId || null, job.machineId || null, job.quoteId || null,
        job.description || null, job.hoseSpec || null, job.priority || 'normal',
        receivedAt, job.promisedAt || null, job.notes || null);

    const ins = db.prepare(`INSERT INTO JobCardItems
      (JobID, InventoryID, Description, Unit, Qty, Rate) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const i of items) {
      ins.run(info.lastInsertRowid, i.inventoryId || null, i.description || null,
        i.unit || null, money.num(i.qty), money.round2(i.rate));
    }
    return { jobId: info.lastInsertRowid, jobNo };
  })();
}

function updateJob(jobId, patch) {
  const db = connection._db;
  const job = db.prepare('SELECT * FROM JobCards WHERE JobID = ?').get(jobId);
  if (!job) throw new JobError(`Job ${jobId} not found`, 404);
  if (patch.status && !JOB_STATUSES.includes(patch.status)) throw new JobError(`Unknown job status "${patch.status}"`);
  if (job.Status === 'invoiced' && patch.status && patch.status !== 'invoiced') {
    throw new JobError('An invoiced job cannot be moved back — cancel the invoice instead');
  }
  const keep = (v, prev) => (v != null ? v : prev);

  db.prepare(`UPDATE JobCards SET
    Description = ?, HoseSpec = ?, Status = ?, Priority = ?, PromisedAt = ?, Notes = ?,
    CompletedAt = ?, UpdatedAt = datetime('now','localtime') WHERE JobID = ?`)
    .run(keep(patch.description, job.Description), keep(patch.hoseSpec, job.HoseSpec),
      keep(patch.status, job.Status), keep(patch.priority, job.Priority),
      keep(patch.promisedAt, job.PromisedAt), keep(patch.notes, job.Notes),
      patch.status === 'completed' && !job.CompletedAt
        ? (patch.completedAt || new Date().toISOString().slice(0, 10))
        : keep(patch.completedAt, job.CompletedAt),
      jobId);

  return db.prepare('SELECT * FROM JobCards WHERE JobID = ?').get(jobId);
}

/** Replace a job's parts/labour lines wholesale — it is a working document. */
function setJobItems(jobId, items) {
  const db = connection._db;
  const job = db.prepare('SELECT Status FROM JobCards WHERE JobID = ?').get(jobId);
  if (!job) throw new JobError(`Job ${jobId} not found`, 404);
  if (job.Status === 'invoiced') throw new JobError('An invoiced job can no longer be edited');

  db.transaction(() => {
    db.prepare('DELETE FROM JobCardItems WHERE JobID = ?').run(jobId);
    const ins = db.prepare(`INSERT INTO JobCardItems
      (JobID, InventoryID, Description, Unit, Qty, Rate) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const i of (items || []).filter((x) => money.num(x.qty) > 0)) {
      ins.run(jobId, i.inventoryId || null, i.description || null, i.unit || null,
        money.num(i.qty), money.round2(i.rate));
    }
    db.prepare("UPDATE JobCards SET UpdatedAt = datetime('now','localtime') WHERE JobID = ?").run(jobId);
  })();
}

// ------------------------------------------------------- technician labour

/**
 * Record work a technician did on a job, and accrue what they have earned.
 *
 * The accrual is what makes the liability visible: the shop owes the worker from
 * the moment the work is done, not from the moment someone remembers to pay.
 */
function addJobLabour(jobId, labour) {
  const db = connection._db;
  const job = db.prepare('SELECT * FROM JobCards WHERE JobID = ?').get(jobId);
  if (!job) throw new JobError(`Job ${jobId} not found`, 404);

  const units = money.num(labour.units);
  const rate = money.round2(labour.rate);
  const amount = money.round2(units * rate);
  if (!(amount > 0)) throw new JobError('Labour must have a quantity and a rate');

  const id = db.prepare(`INSERT INTO JobLabour
    (JobID, WorkerID, WorkType, Units, UnitLabel, Rate, Amount, Notes, CreatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
    .run(jobId, labour.workerId || null, labour.workType || 'crimping', units,
      labour.unitLabel || 'end', rate, amount, labour.notes || null).lastInsertRowid;

  const posting = ledgerSvc.postEntry({
    date: String(job.CompletedAt || job.ReceivedAt || new Date().toISOString()).slice(0, 10),
    memo: `Technician labour on ${job.JobNo}`,
    sourceType: 'job-labour', sourceID: id,
    postedBy: labour.postedBy,
    lines: [
      { accountCode: COGS_LABOUR, debit: amount, memo: `${labour.workType || 'crimping'} — ${job.JobNo}` },
      { accountCode: ACCRUED_LABOUR, credit: amount, memo: 'Owed to the technician' },
    ],
  });

  return { jobLabourId: id, amount, posting };
}

/**
 * Pay a technician for labour already accrued. Clears the accrual rather than
 * hitting Wages again — the cost was recognised when the work was done.
 *
 * @param {object} p { workerId, jobLabourIds:[], paymentDate, method, notes }
 */
function payJobLabour(p) {
  const db = connection._db;
  const ids = (p.jobLabourIds || []).map(Number).filter(Boolean);
  if (!ids.length) throw new JobError('Select at least one piece of labour to pay');
  const paymentDate = requireDate(p.paymentDate || new Date().toISOString().slice(0, 10), 'payment date');

  const rows = db.prepare(
    `SELECT * FROM JobLabour WHERE JobLabourID IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  if (rows.length !== ids.length) throw new JobError('Some labour records were not found', 404);

  const already = rows.filter((r) => r.LabourPaymentID);
  if (already.length) throw new JobError(`Already paid: ${already.map((r) => r.JobLabourID).join(', ')}`);

  const amount = money.round2(rows.reduce((a, r) => a + money.num(r.Amount), 0));
  if (!(amount > 0)) throw new JobError('Nothing to pay');

  const workerId = p.workerId || rows[0].WorkerID || null;
  const period = paymentDate.slice(0, 7);

  const paymentId = db.transaction(() => {
    const info = db.prepare(`INSERT INTO LabourPayments
      (WorkerID, Amount, PayPeriod, PaymentDate, Method, Notes, CreatedAt)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
      .run(workerId, amount, period, paymentDate, p.method || 'Cash',
        p.notes || `Technician payout for ${rows.length} job(s)`);
    const lpId = info.lastInsertRowid;
    const mark = db.prepare('UPDATE JobLabour SET LabourPaymentID = ? WHERE JobLabourID = ?');
    for (const r of rows) mark.run(lpId, r.JobLabourID);
    return lpId;
  })();

  const cashAccount = /bank|transfer|cheque|card/i.test(p.method || '') ? ACC.BANK : ACC.CASH;
  const posting = ledgerSvc.postEntry({
    date: paymentDate,
    memo: `Technician paid for ${rows.length} job(s)`,
    sourceType: 'labour', sourceID: paymentId,
    postedBy: p.postedBy,
    lines: [
      { accountCode: ACCRUED_LABOUR, debit: amount, memo: 'Clearing the accrual' },
      { accountCode: cashAccount, credit: amount, memo: p.method || 'Cash' },
    ],
  });

  return { labourPaymentId: paymentId, amount, jobLabourIds: ids, posting };
}

/** What is owed to technicians, by worker. */
function labourOwed() {
  const rows = connection._db.prepare(`
    SELECT jl.JobLabourID, jl.JobID, jl.WorkType, jl.Units, jl.UnitLabel, jl.Rate, jl.Amount,
           j.JobNo, j.CompletedAt, j.ReceivedAt,
           w.WorkerID, COALESCE(w.Name, 'Unassigned') AS WorkerName
    FROM JobLabour jl
    JOIN JobCards j ON j.JobID = jl.JobID
    LEFT JOIN Workers w ON w.WorkerID = jl.WorkerID
    WHERE jl.LabourPaymentID IS NULL
    ORDER BY WorkerName, j.JobNo`).all();

  const byWorker = new Map();
  for (const r of rows) {
    const key = r.WorkerID || 0;
    if (!byWorker.has(key)) byWorker.set(key, { workerId: r.WorkerID, workerName: r.WorkerName, amount: 0, items: [] });
    const w = byWorker.get(key);
    w.amount = money.round2(w.amount + money.num(r.Amount));
    w.items.push(r);
  }
  return {
    workers: [...byWorker.values()],
    total: money.round2(rows.reduce((a, r) => a + money.num(r.Amount), 0)),
    count: rows.length,
  };
}

// -------------------------------------------------------- job → invoice

/**
 * The payload the existing invoice finalize endpoint expects, built from a job.
 * The job is not invoiced here — the caller posts it through the normal billing
 * path so all the stock checks, numbering and ledger posting still apply.
 */
function invoicePayloadFor(jobId) {
  const db = connection._db;
  const job = db.prepare(`
    SELECT j.*, c.Name AS CustomerName, c.Address AS CustomerAddress, m.Name AS MachineName
    FROM JobCards j
    LEFT JOIN Customers c ON c.CustomerID = j.CustomerID
    LEFT JOIN Machines m ON m.MachineID = j.MachineID
    WHERE j.JobID = ?`).get(jobId);
  if (!job) throw new JobError(`Job ${jobId} not found`, 404);
  if (job.InvoiceID) throw new JobError(`${job.JobNo} has already been invoiced`);
  if (job.Status === 'cancelled') throw new JobError('A cancelled job cannot be invoiced');

  const items = db.prepare(`
    SELECT i.*, inv.Cost, inv.MarketMid FROM JobCardItems i
    LEFT JOIN Inventory inv ON inv.InventoryID = i.InventoryID
    WHERE i.JobID = ? ORDER BY i.JobItemID`).all(jobId);
  if (!items.length) throw new JobError(`${job.JobNo} has no lines to invoice`);

  return {
    job,
    payload: {
      // Machine jobs are billed to the machine's name, matching how the shop
      // has always written its invoices.
      billedToName: job.MachineName || job.CustomerName || '',
      billedToAddress: job.CustomerAddress || '',
      customerId: job.CustomerID,
      machineId: job.MachineID,
      jobId,
      items: items.map((i) => ({
        inventoryId: i.InventoryID,
        description: i.Description || '',
        unit: i.Unit || '',
        qty: i.Qty,
        rate: i.Rate,
        cost: i.InventoryID ? money.num(i.Cost) : 0,
        marketMid: i.InventoryID ? money.num(i.MarketMid) : 0,
      })),
    },
  };
}

/** Record that a job was billed, once the invoice actually exists. */
function markInvoiced(jobId, invoiceId) {
  connection._db.prepare(
    "UPDATE JobCards SET InvoiceID = ?, Status = 'invoiced', UpdatedAt = datetime('now','localtime') WHERE JobID = ?"
  ).run(invoiceId, jobId);
  connection._db.prepare('UPDATE Invoices SET JobID = ? WHERE InvoiceID = ?').run(jobId, invoiceId);
}

module.exports = {
  JobError, JOB_STATUSES, QUOTE_STATUSES, ACCRUED_LABOUR, COGS_LABOUR,
  nextDocNo, createQuotation, quotationToJob,
  createJob, updateJob, setJobItems,
  addJobLabour, payJobLabour, labourOwed,
  invoicePayloadFor, markInvoiced,
};
