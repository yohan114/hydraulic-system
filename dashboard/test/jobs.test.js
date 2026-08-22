'use strict';

/**
 * Workshop operations end to end: quotation → job card → invoice, and the
 * technician labour accrual that finally puts account 2200 to work.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/appHarness');

let app;
let db;
let customerId;
let machineId;
let workerId;
let hoseId;

test.before(async () => {
  app = await startTestApp();
  db = app.db._db;

  customerId = (await app.post('/api/customers', { name: 'Ceylon Earthmovers' })).body.customer.CustomerID;
  await app.post('/api/machines', { name: 'HEX-18', kind: 'registration', customerId });
  machineId = (await app.get('/api/machines')).body.find((m) => m.Name === 'HEX-18').MachineID;
  workerId = db.prepare("INSERT INTO Workers (Name, Role, Active, CreatedAt) VALUES ('Sunil', 'Technician', 1, datetime('now'))").run().lastInsertRowid;
  hoseId = db.prepare(`INSERT INTO Inventory (UniqueID, ProductName, Unit, Qty, Cost, Price, ValuationMethod)
    VALUES ('HOSE-R2-13', 'R2 hydraulic hose 1/2"', 'm', 50, 355, 1560, 'WAC')`).run().lastInsertRowid;
});
test.after(async () => { if (app) await app.close(); });

function balanceOf(code) {
  const row = db.prepare(`
    SELECT ROUND(COALESCE(SUM(l.Debit), 0) - COALESCE(SUM(l.Credit), 0), 2) AS v
    FROM JournalLines l JOIN Accounts a ON a.AccountID = l.AccountID WHERE a.Code = ?`).get(code);
  return row.v || 0;
}
function trialBalanced() {
  const t = db.prepare('SELECT ROUND(SUM(Debit),2) d, ROUND(SUM(Credit),2) c FROM JournalLines').get();
  return Math.abs((t.d || 0) - (t.c || 0)) < 0.005;
}

let quoteId;

test('a quotation records what was offered', async () => {
  const res = await app.post('/api/quotations', {
    customerId, machineId, quoteDate: '2026-08-10', validUntil: '2026-09-10',
    items: [
      { inventoryId: hoseId, description: 'R2 hose 1/2"', unit: 'm', qty: 2, rate: 1560 },
      { description: 'Crimping charge — 1/2" (2 ends)', unit: 'end', qty: 2, rate: 600 },
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.match(res.body.quoteNo, /^QTN\/\d{4}\/0001$/);
  quoteId = res.body.quoteId;

  const list = await app.get('/api/quotations');
  assert.equal(list.body[0].Total, 4320);
  assert.equal(list.body[0].Status, 'open');
});

test('an empty quotation is refused', async () => {
  const res = await app.post('/api/quotations', { customerId, quoteDate: '2026-08-10', items: [] });
  assert.equal(res.status, 400);
});

let jobId;

test('converting a quotation carries its lines onto a job card', async () => {
  const res = await app.post(`/api/quotations/${quoteId}/convert`, { receivedAt: '2026-08-11' });
  assert.equal(res.status, 200, res.text);
  assert.match(res.body.jobNo, /^JOB\/\d{4}\/0001$/);
  jobId = res.body.jobId;

  const job = await app.get(`/api/jobs/${jobId}`);
  assert.equal(job.body.items.length, 2);
  assert.equal(job.body.Total, 4320);
  assert.equal(job.body.MachineName, 'HEX-18');
  assert.equal(job.body.Status, 'open');
  assert.equal(db.prepare('SELECT Status FROM Quotations WHERE QuoteID = ?').get(quoteId).Status, 'accepted');
});

test('converting the same quotation twice returns the job already made', async () => {
  const res = await app.post(`/api/quotations/${quoteId}/convert`, {});
  assert.equal(res.body.alreadyConverted, true);
  assert.equal(res.body.jobId, jobId);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM JobCards').get().c, 1);
});

test('a job moves through its statuses and stamps completion', async () => {
  const wip = await app.put(`/api/jobs/${jobId}`, { status: 'in-progress' });
  assert.equal(wip.status, 200);
  assert.equal(wip.body.job.Status, 'in-progress');
  assert.equal(wip.body.job.CompletedAt, null);

  const done = await app.put(`/api/jobs/${jobId}`, { status: 'completed', completedAt: '2026-08-12' });
  assert.equal(done.body.job.Status, 'completed');
  assert.equal(done.body.job.CompletedAt, '2026-08-12');

  const bad = await app.put(`/api/jobs/${jobId}`, { status: 'teleported' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Unknown job status/);
});

test('technician labour accrues a liability the moment the work is done', async () => {
  const accruedBefore = balanceOf('2200');

  const res = await app.post(`/api/jobs/${jobId}/labour`, {
    workerId, workType: 'crimping', units: 2, unitLabel: 'end', rate: 300,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.amount, 600);

  // Cost recognised now; cash has not moved.
  assert.equal(balanceOf('5200'), 600, 'the labour is a cost of sales');
  assert.equal(balanceOf('2200'), accruedBefore - 600, 'and a liability owed to the worker');
  assert.equal(balanceOf('1110'), 0, 'no cash has left the till yet');
  assert.ok(trialBalanced());
});

test('labour with no quantity or rate is refused', async () => {
  const res = await app.post(`/api/jobs/${jobId}/labour`, { workerId, units: 0, rate: 300 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /quantity and a rate/);
});

test('what is owed to technicians is grouped by worker', async () => {
  const res = await app.get('/api/labour/owed');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 600);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.workers[0].workerName, 'Sunil');
  assert.equal(res.body.workers[0].amount, 600);
});

test('paying the technician clears the accrual instead of double-counting the cost', async () => {
  const owed = await app.get('/api/labour/owed');
  const ids = owed.body.workers[0].items.map((i) => i.JobLabourID);

  const res = await app.post('/api/labour/pay', {
    workerId, jobLabourIds: ids, paymentDate: '2026-08-15', method: 'Cash',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.amount, 600);

  assert.equal(balanceOf('2200'), 0, 'the liability is settled');
  assert.equal(balanceOf('1110'), -600, 'cash left the till');
  assert.equal(balanceOf('5200'), 600, 'the cost is recognised ONCE, not twice');
  assert.ok(trialBalanced());

  const after = await app.get('/api/labour/owed');
  assert.equal(after.body.total, 0);
});

test('the same labour cannot be paid twice', async () => {
  const paid = db.prepare('SELECT JobLabourID FROM JobLabour WHERE LabourPaymentID IS NOT NULL').all()
    .map((r) => r.JobLabourID);
  const res = await app.post('/api/labour/pay', { workerId, jobLabourIds: paid, paymentDate: '2026-08-16' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Already paid/);
});

test('a job produces the payload the billing engine expects', async () => {
  const res = await app.get(`/api/jobs/${jobId}/invoice-payload`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.billedToName, 'HEX-18', 'machine jobs bill to the machine, as the shop writes them');
  assert.equal(res.body.items.length, 2);
  // Stocked lines carry their cost for the billing-time snapshot; manual ones do not.
  const hoseLine = res.body.items.find((i) => i.inventoryId === hoseId);
  assert.equal(hoseLine.cost, 355);
  assert.equal(res.body.items.find((i) => !i.inventoryId).cost, 0);
});

test('the job invoices through the normal billing path and is marked off', async () => {
  const payload = (await app.get(`/api/jobs/${jobId}/invoice-payload`)).body;
  const inv = await app.post('/api/invoices/finalize', {
    billedToName: payload.billedToName, billedToAddress: payload.billedToAddress,
    items: payload.items, discount: 0,
  });
  assert.equal(inv.status, 200, inv.text);

  const mark = await app.post(`/api/jobs/${jobId}/invoiced`, { invoiceId: inv.body.invoiceId });
  assert.equal(mark.status, 200);

  const job = await app.get(`/api/jobs/${jobId}`);
  assert.equal(job.body.Status, 'invoiced');
  assert.equal(job.body.InvoiceNo, inv.body.invoiceNo);
  assert.equal(db.prepare('SELECT JobID FROM Invoices WHERE InvoiceID = ?').get(inv.body.invoiceId).JobID, jobId);

  // Stock actually moved for the hose line.
  assert.equal(db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(hoseId).Qty, 48);
});

test('an invoiced job is locked against further edits', async () => {
  const res = await app.put(`/api/jobs/${jobId}`, { status: 'open' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot be moved back/);

  const second = await app.get(`/api/jobs/${jobId}/invoice-payload`);
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already been invoiced/);
});

test('the books still balance after the whole workshop cycle', async () => {
  const tb = await app.get('/api/ledger/trial-balance');
  assert.equal(tb.body.totals.balanced, true);
  const bs = await app.get('/api/ledger/balance-sheet');
  assert.equal(bs.body.balanced, true, `off by ${bs.body.difference}`);
});

test('workshop writes are audited', () => {
  const seen = db.prepare(
    "SELECT DISTINCT Entity FROM AuditLog WHERE Entity IN ('quotation','job','job-labour','labour-payment')"
  ).all().map((r) => r.Entity);
  ['quotation', 'job', 'job-labour', 'labour-payment'].forEach((e) =>
    assert.ok(seen.includes(e), `${e} was not audited`));
});
