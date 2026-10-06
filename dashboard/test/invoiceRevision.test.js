'use strict';

/**
 * Revising a posted invoice, driven through the real app.
 *
 * Two invariants matter more than anything else here and are asserted after
 * every revision:
 *
 *   MONEY  — the trial balance still balances, and cash that was taken is
 *            either standing against an invoice or reported as a refund. It is
 *            never quietly created or destroyed.
 *   STOCK  — the shelf ends up holding exactly what the corrected invoice says
 *            it should, no matter how many times the invoice is revised.
 *
 * The motivating case is real: INV/2026/09/003 was finalized, paid in full, and
 * then found to be missing its crimping charge. Every attempt to cancel it was
 * refused because money was against it, so the operator reversed both journals
 * by hand and left the invoice, the payment and the stock all disagreeing. The
 * last test in this file reproduces exactly that state and revises out of it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/appHarness');

let app;
let db;

test.before(async () => { app = await startTestApp(); db = app.db._db; });
test.after(async () => { if (app) await app.close(); });

// --- helpers ---------------------------------------------------------------

function trialBalanced() {
  const row = db.prepare(
    'SELECT ROUND(SUM(Debit), 2) d, ROUND(SUM(Credit), 2) c FROM JournalLines').get();
  return Math.abs((row.d || 0) - (row.c || 0)) < 0.005;
}

function qtyOf(inventoryId) {
  return db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(inventoryId).Qty;
}

function invoiceRow(id) {
  return db.prepare('SELECT * FROM Invoices WHERE InvoiceID = ?').get(id);
}

function balanceOf(code) {
  const row = db.prepare(`
    SELECT ROUND(COALESCE(SUM(l.Debit), 0) - COALESCE(SUM(l.Credit), 0), 2) AS v
    FROM JournalLines l JOIN Accounts a ON a.AccountID = l.AccountID WHERE a.Code = ?`).get(code);
  return row.v || 0;
}

/**
 * Does the GENERAL LEDGER still agree with the invoices and payments it is
 * supposed to summarise?
 *
 * trialBalanced() alone is not enough and is the reason a whole class of bug
 * survived the first cut of these tests: when a posting fails to happen at all,
 * debits still equal credits. Nothing posted is perfectly balanced and
 * completely wrong. This compares the books against the subledger they describe:
 *
 *   Accounts Receivable  ==  what external finalized invoices are still owed
 *   Cash + Bank          ==  every payment still standing
 */
function reconciled() {
  const owed = db.prepare(`
    SELECT ROUND(COALESCE(SUM(GrandTotal - COALESCE(AmountPaid, 0)), 0), 2) v
    FROM Invoices WHERE Status = 'Finalized' AND COALESCE(IsInternal, 0) = 0`).get().v;
  const held = db.prepare(`
    SELECT ROUND(COALESCE(SUM(p.Amount), 0), 2) v
    FROM Payments p JOIN Invoices i ON i.InvoiceID = p.InvoiceID
    WHERE p.VoidedAt IS NULL AND COALESCE(i.IsInternal, 0) = 0`).get().v;
  const ar = balanceOf('1200');
  const cash = balanceOf('1110') + balanceOf('1120');
  return {
    ok: Math.abs(ar - owed) < 0.005 && Math.abs(cash - held) < 0.005,
    detail: `AR: ledger ${ar} vs invoices ${owed} | Cash: ledger ${cash} vs payments ${held}`,
  };
}

function assertReconciled(what) {
  const r = reconciled();
  assert.ok(r.ok, `${what} — the ledger no longer matches the invoices. ${r.detail}`);
}

/** Stock item ids, created once and reused. */
const stock = {};

async function makeStock(key, uniqueId, qty, cost, price) {
  const res = await app.post('/api/inventory', {
    uniqueId, productName: `${uniqueId} hose`, specificationCode: '13',
    unit: 'm', qty, price, cost,
  });
  assert.equal(res.status, 200, res.text);
  stock[key] = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get(uniqueId).InventoryID;
  return stock[key];
}

/**
 * Put the shelf back to a known quantity. Tests here deliberately drain stock,
 * so each one starts from the same place rather than from whatever the last one
 * left behind.
 */
function topUp(qty = 100) {
  db.prepare('UPDATE Inventory SET Qty = ? WHERE InventoryID IN (?, ?)').run(qty, stock.hose, stock.fitting);
}

/** The payload shape the invoice editor posts. */
function payload(overrides = {}) {
  return {
    invoiceDate: '2026-09-08',
    billedToName: 'LY-4524',
    billedToAddress: 'Nugegoda',
    discount: 0,
    items: [{ inventoryId: stock.hose, description: 'R1 hose 1/4"', unit: 'm', qty: 5, rate: 600, cost: 144 }],
    ...overrides,
  };
}

async function finalize(over = {}) {
  if (over.stockQty !== null) topUp(over.stockQty || 100);
  delete over.stockQty;
  const res = await app.post('/api/invoices/finalize', payload(over));
  assert.equal(res.status, 200, res.text);
  return res.body;
}

// --- the happy path --------------------------------------------------------

test('setup: stock to bill against', async () => {
  await makeStock('hose', 'REV-HOSE', 100, 144, 600);
  await makeStock('fitting', 'REV-FITTING', 50, 161, 576);
  assert.ok(stock.hose > 0 && stock.fitting > 0);
});

test('a revision needs a reason', async () => {
  const inv = await finalize();
  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, { ...payload(), reason: '  ' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Say why/);
  assert.equal(invoiceRow(inv.invoiceId).Status, 'Finalized', 'a refused revision changes nothing');
});

test('revising supersedes the original and issues -R1 in its place', async () => {
  const inv = await finalize();                       // 5 @ 600 = 3000
  const before = qtyOf(stock.hose);

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(),
    reason: 'Crimping charge was left off',
    items: [
      { inventoryId: stock.hose, description: 'R1 hose 1/4"', unit: 'm', qty: 5, rate: 600, cost: 144 },
      { description: 'Crimping charge — 1/4"', unit: 'nos', qty: 2, rate: 500, cost: 120 },
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.invoiceNo, `${inv.invoiceNo}-R1`, 'the customer keeps the number they were given');
  assert.equal(res.body.revisionNo, 1);
  assert.equal(res.body.previousTotal, 3000);
  assert.equal(res.body.grandTotal, 4000);            // 3000 + 2 x 500
  assert.equal(res.body.difference, 1000);

  const original = invoiceRow(inv.invoiceId);
  assert.equal(original.Status, 'Revised');
  assert.equal(original.SupersededBy, res.body.invoiceId);
  assert.equal(original.RevisionReason, 'Crimping charge was left off');
  assert.ok(original.RevisedAt, 'the moment it was superseded is recorded');

  const replacement = invoiceRow(res.body.invoiceId);
  assert.equal(replacement.Status, 'Finalized');
  assert.equal(replacement.RevisionOf, inv.invoiceId);
  assert.equal(replacement.RevisionNo, 1);

  // The parts did not change, so the shelf must not have moved.
  assert.equal(qtyOf(stock.hose), before, 'stock is returned and re-taken, netting to zero');
  assert.ok(trialBalanced());
});

test('the superseded original drops out of the invoice list as a receivable', async () => {
  const list = await app.get('/api/invoices');
  const revised = list.body.filter((i) => i.Status === 'Revised');
  assert.ok(revised.length >= 1);
  revised.forEach((i) => {
    assert.equal(i.Balance, 0, 'a superseded invoice is never owed');
    assert.equal(i.PaymentStatus, 'Revised');
  });
});

test('the revision chain reads oldest first from either end', async () => {
  const inv = await finalize();
  const r1 = await app.post(`/api/invoices/${inv.invoiceId}/revise`, { ...payload(), reason: 'wrong rate' });
  assert.equal(r1.status, 200, r1.text);
  const r2 = await app.post(`/api/invoices/${r1.body.invoiceId}/revise`, { ...payload(), reason: 'wrong rate again' });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.body.invoiceNo, `${inv.invoiceNo}-R2`, 'a revision of a revision is -R2, not -R1-R1');

  for (const id of [inv.invoiceId, r1.body.invoiceId, r2.body.invoiceId]) {
    const chain = await app.get(`/api/invoices/${id}/revisions`);
    assert.equal(chain.status, 200);
    assert.deepEqual(chain.body.chain.map((c) => c.InvoiceNo),
      [inv.invoiceNo, `${inv.invoiceNo}-R1`, `${inv.invoiceNo}-R2`]);
  }
});

// --- money -----------------------------------------------------------------

test('cash already taken carries onto the corrected bill', async () => {
  const inv = await finalize();                       // 3000
  const paid = await app.post(`/api/invoices/${inv.invoiceId}/payments`, { amount: 3000, method: 'Cash', date: '2026-09-08' });
  assert.equal(paid.status, 200, paid.text);
  const cashBefore = balanceOf('1110');

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(),
    reason: 'crimping charge missing',
    items: [
      { inventoryId: stock.hose, description: 'R1 hose 1/4"', unit: 'm', qty: 5, rate: 600, cost: 144 },
      { description: 'Crimping charge', unit: 'nos', qty: 1, rate: 800, cost: 120 },
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.paymentsVoided, 1);
  assert.equal(res.body.paymentsCarried, 3000, 'the customer does not pay twice');
  assert.equal(res.body.refundDue, 0);
  assert.equal(res.body.balance, 800, 'they now owe the difference');
  assert.equal(res.body.paymentStatus, 'Partial');

  assert.equal(invoiceRow(inv.invoiceId).AmountPaid, 0, 'the dead invoice holds no money');
  assert.equal(invoiceRow(res.body.invoiceId).AmountPaid, 3000);
  assert.equal(balanceOf('1110'), cashBefore, 'cash in hand is unchanged — the same money, on a different bill');
  assertReconciled('carrying cash onto a revision');

  const voided = db.prepare('SELECT * FROM Payments WHERE InvoiceID = ? ').all(inv.invoiceId);
  assert.equal(voided.length, 1, 'the original payment row is kept, not deleted');
  assert.ok(voided[0].VoidedAt);
  assert.match(voided[0].VoidReason, /Superseded by/);
  const carried = db.prepare('SELECT * FROM Payments WHERE InvoiceID = ?').all(res.body.invoiceId);
  assert.equal(carried[0].CarriedFromPaymentID, voided[0].PaymentID, 'the cash is traceable across the revision');
  assert.ok(trialBalanced());
});

test('a revision worth less than was paid keeps the cash on the books as a credit', async () => {
  const inv = await finalize();                       // 3000
  await app.post(`/api/invoices/${inv.invoiceId}/payments`, { amount: 3000, method: 'Cash', date: '2026-09-08' });
  const cashBefore = balanceOf('1110');

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(),
    reason: 'over-charged: only 3m of hose was used',
    items: [{ inventoryId: stock.hose, description: 'R1 hose 1/4"', unit: 'm', qty: 3, rate: 600, cost: 144 }],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.grandTotal, 1800);

  // The whole 3,000 follows the customer. Capping it at 1,800 would take 1,200
  // of cash off the books while it was still sitting in the till.
  assert.equal(res.body.paymentsCarried, 3000);
  assert.equal(balanceOf('1110'), cashBefore, 'the money has not moved, so nor has cash in hand');
  assert.equal(res.body.refundDue, 1200, 'the excess is surfaced, not buried');
  assert.equal(res.body.balance, 0);
  assert.equal(invoiceRow(res.body.invoiceId).AmountPaid, 3000);
  assert.equal(invoiceRow(res.body.invoiceId).PaymentStatus, 'Paid');
  assert.ok(trialBalanced());
  assertReconciled('a revision worth less than was paid');
});

test('carryPayments false voids the money instead of moving it', async () => {
  const inv = await finalize();
  await app.post(`/api/invoices/${inv.invoiceId}/payments`, { amount: 3000, method: 'Cash', date: '2026-09-08' });
  const cashBefore = balanceOf('1110');

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(), reason: 'billed the wrong customer', carryPayments: false,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.paymentsCarried, 0);
  assert.equal(res.body.refundDue, 3000, 'the money is going back and says so');
  assert.equal(res.body.balance, 3000);
  assert.equal(balanceOf('1110'), cashBefore - 3000, 'cash leaves the books when it leaves the till');
  assert.ok(trialBalanced());
  assertReconciled('revising with the money going back');
});

// --- stock -----------------------------------------------------------------

test('stock ends up matching the corrected invoice, not the original', async () => {
  const inv = await finalize({
    items: [{ inventoryId: stock.fitting, description: 'BSP straight', unit: 'nos', qty: 10, rate: 576, cost: 161 }],
  });
  const afterFirst = qtyOf(stock.fitting);

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(),
    reason: 'counted 10, actually fitted 4',
    items: [{ inventoryId: stock.fitting, description: 'BSP straight', unit: 'nos', qty: 4, rate: 576, cost: 161 }],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(qtyOf(stock.fitting), afterFirst + 6, 'the six that were never fitted come back');

  const movements = db.prepare(
    'SELECT MovementType, QtyChange FROM StockMovements WHERE InventoryID = ? ORDER BY MovementID DESC LIMIT 2').all(stock.fitting);
  assert.deepEqual(movements.map((m) => m.MovementType).sort(), ['IN', 'OUT'], 'the return and the re-take are both on the record');
});

test('a revision is checked against the shelf as it will be, not as it is', async () => {
  // Take the item down to nothing, then revise the invoice that emptied it to
  // the SAME quantity. A naive check against current stock would refuse this.
  const inv = await finalize({
    items: [{ inventoryId: stock.hose, description: 'R1 hose 1/4"', unit: 'm', qty: qtyOf(stock.hose), rate: 600, cost: 144 }],
  });
  assert.equal(qtyOf(stock.hose), 0);

  const qty = db.prepare('SELECT Qty FROM InvoiceItems WHERE InvoiceID = ?').get(inv.invoiceId).Qty;
  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(),
    reason: 're-rated at the agreed price',
    items: [{ inventoryId: stock.hose, description: 'R1 hose 1/4"', unit: 'm', qty, rate: 700, cost: 144 }],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(qtyOf(stock.hose), 0, 'the same parts, at a different price');
});

test('a revision that asks for more than exists is refused, and nothing moves', async () => {
  const inv = await finalize({
    stockQty: 10,
    items: [{ inventoryId: stock.hose, description: 'R1 hose 1/4"', unit: 'm', qty: 4, rate: 600, cost: 144 }],
  });
  const before = qtyOf(stock.hose);                   // 6

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(),
    reason: 'actually used much more',
    // 999 exceeds even the 10 the original gives back.
    items: [{ inventoryId: stock.hose, description: 'R1 hose 1/4"', unit: 'm', qty: 999, rate: 600, cost: 144 }],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Not enough stock/);
  assert.equal(qtyOf(stock.hose), before, 'a refused revision leaves the shelf alone');
  assert.equal(invoiceRow(inv.invoiceId).Status, 'Finalized', 'and leaves the invoice alone');
  assert.ok(trialBalanced());
});

test('a revision keeps the original cost basis, so re-rating moves no money on the shelf', async () => {
  const inv = await finalize({
    items: [{ inventoryId: stock.fitting, description: 'BSP straight', unit: 'nos', qty: 10, rate: 576, cost: 161 }],
  });
  const stockBefore = balanceOf('1300');
  const cogsBefore = balanceOf('5100');

  // The item is re-averaged by a later purchase, as it would be in real life.
  db.prepare('UPDATE Inventory SET Cost = 400 WHERE InventoryID = ?').run(stock.fitting);

  // A revision that changes ONLY the rate. Nothing physical happens.
  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(),
    reason: 'agreed a different rate',
    items: [{ inventoryId: stock.fitting, description: 'BSP straight', unit: 'nos', qty: 10, rate: 700, cost: 161 }],
  });
  assert.equal(res.status, 200, res.text);

  const line = db.prepare('SELECT UnitCostAtBilling FROM InvoiceItems WHERE InvoiceID = ?').get(res.body.invoiceId);
  assert.equal(line.UnitCostAtBilling, 161, 'the parts left the shelf once, at one cost');
  assert.equal(balanceOf('1300'), stockBefore, 'the stock account does not drift with the cost');
  assert.equal(balanceOf('5100'), cogsBefore, 'and neither does cost of sales');
  assert.ok(trialBalanced());

  db.prepare('UPDATE Inventory SET Cost = 161 WHERE InventoryID = ?').run(stock.fitting);
});

test('a revision does not move the sale into the month it was corrected in', async () => {
  const inv = await finalize();
  const before = invoiceRow(inv.invoiceId).FinalizedAt;
  db.prepare("UPDATE Invoices SET FinalizedAt = '2026-09-08 17:18:50' WHERE InvoiceID = ?").run(inv.invoiceId);
  assert.ok(before, 'the original was stamped when it was finalized');

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, { ...payload(), reason: 'corrected weeks later' });
  assert.equal(res.status, 200, res.text);
  assert.equal(invoiceRow(res.body.invoiceId).FinalizedAt, '2026-09-08 17:18:50',
    'the sale happened when it happened — the dashboard buckets on this');
});

test('billing more of a part than the original blends the old cost with today\'s', async () => {
  const inv = await finalize({
    items: [{ inventoryId: stock.fitting, description: 'BSP straight', unit: 'nos', qty: 4, rate: 576, cost: 161 }],
  });
  // The item is re-averaged upward before the revision.
  db.prepare('UPDATE Inventory SET Cost = 261 WHERE InventoryID = ?').run(stock.fitting);

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(),
    reason: 'six were fitted, not four',
    items: [{ inventoryId: stock.fitting, description: 'BSP straight', unit: 'nos', qty: 6, rate: 576, cost: 161 }],
  });
  assert.equal(res.status, 200, res.text);

  // 4 already off the shelf at 161, 2 leaving now at 261 -> (644 + 522) / 6.
  const line = db.prepare('SELECT UnitCostAtBilling FROM InvoiceItems WHERE InvoiceID = ?').get(res.body.invoiceId);
  assert.equal(line.UnitCostAtBilling, 194.33);
  assert.ok(trialBalanced());

  db.prepare('UPDATE Inventory SET Cost = 161 WHERE InventoryID = ?').run(stock.fitting);
});

test('the technician payout marker follows the replacement', async () => {
  const inv = await finalize();
  // The marker the technical-charges screen actually writes: id AND number.
  db.prepare("INSERT INTO LabourPayments (WorkerID, Amount, PaymentDate, Method, Notes, CreatedAt) VALUES (1, 500, '2026-09-08', 'Cash', ?, '2026-09-08')")
    .run(`TECHPAYOUT#${inv.invoiceId} · ${inv.invoiceNo}`);

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, { ...payload(), reason: 'wrong rate' });
  assert.equal(res.status, 200, res.text);

  const note = db.prepare("SELECT Notes FROM LabourPayments WHERE Notes LIKE 'TECHPAYOUT#%' ORDER BY LabourPaymentID DESC LIMIT 1").get().Notes;
  assert.equal(note, `TECHPAYOUT#${res.body.invoiceId} · ${res.body.invoiceNo}`,
    'matched on the prefix — an exact-equality match would silently update nothing and the technician would be paid twice');
});

test('a revision that fails partway leaves absolutely everything as it was', async () => {
  const inv = await finalize();
  await app.post(`/api/invoices/${inv.invoiceId}/payments`, { amount: 3000, method: 'Cash', date: '2026-09-08' });

  const before = {
    invoice: invoiceRow(inv.invoiceId),
    stock: qtyOf(stock.hose),
    journals: db.prepare('SELECT COUNT(*) c FROM JournalEntries').get().c,
    payments: db.prepare('SELECT COUNT(*) c FROM Payments').get().c,
    invoices: db.prepare('SELECT COUNT(*) c FROM Invoices').get().c,
  };

  // Fail at step 6 — AFTER the original has been retired and SupersededBy points
  // at the replacement. That is the ordering that used to break the rollback:
  // SupersededBy is a real foreign key, so deleting the replacement while the
  // original still referenced it aborted the compensation halfway through.
  const connection = require('../db');
  const realExecute = connection.execute;
  let fired = false;   // once only, so the rollback's own writes still run
  connection.execute = (s) => {
    if (!fired && String(s).includes('TECHPAYOUT')) {
      fired = true;
      return Promise.reject(new Error('boom: injected failure at step 6'));
    }
    return realExecute(s);
  };
  let res;
  try {
    res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, { ...payload(), reason: 'will not survive' });
  } finally {
    connection.execute = realExecute;
  }
  assert.equal(res.status, 500);
  assert.match(res.body.error, /injected failure/);

  const after = invoiceRow(inv.invoiceId);
  assert.equal(after.Status, 'Finalized', 'the original was never retired');
  assert.equal(after.SupersededBy, null);
  assert.equal(after.RevisedAt, null);
  assert.equal(after.AmountPaid, 3000, 'and its money is still against it');
  assert.equal(after.PaymentStatus, 'Paid');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM Payments WHERE VoidedAt IS NOT NULL AND InvoiceID = ?').get(inv.invoiceId).c, 0,
    'the payment is not left voided');
  assert.equal(qtyOf(stock.hose), before.stock, 'the shelf is untouched');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM Invoices').get().c, before.invoices, 'no half-built replacement survives');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM Payments').get().c, before.payments);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM JournalEntries').get().c, before.journals,
    'and the books never learned anything happened');
  assert.ok(trialBalanced());
  assertReconciled('a revision that failed partway');

  // Proof the invoice is not bricked: it still revises cleanly afterwards.
  topUp(100);
  const retry = await app.post(`/api/invoices/${inv.invoiceId}/revise`, { ...payload(), reason: 'second attempt' });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.body.ledgerErrors, null);
  assertReconciled('the retry after a failed revision');
});

// --- what may not be revised ----------------------------------------------

test('a draft, a cancelled invoice and an already-superseded one are all refused', async () => {
  const draft = await app.post('/api/invoices/draft', payload());
  assert.equal(draft.status, 200, draft.text);
  const d = await app.post(`/api/invoices/${draft.body.invoiceId}/revise`, { ...payload(), reason: 'x' });
  assert.equal(d.status, 409);
  assert.match(d.body.error, /still a draft/);

  const toCancel = await finalize();
  const cancelled = await app.post(`/api/invoices/${toCancel.invoiceId}/cancel`, { reason: 'test' });
  assert.equal(cancelled.status, 200, cancelled.text);
  const c = await app.post(`/api/invoices/${toCancel.invoiceId}/revise`, { ...payload(), reason: 'x' });
  assert.equal(c.status, 409);
  assert.match(c.body.error, /cancelled/);

  const inv = await finalize();
  const r1 = await app.post(`/api/invoices/${inv.invoiceId}/revise`, { ...payload(), reason: 'first' });
  assert.equal(r1.status, 200, r1.text);
  const again = await app.post(`/api/invoices/${inv.invoiceId}/revise`, { ...payload(), reason: 'second' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, new RegExp(r1.body.invoiceNo.replace(/[/]/g, '\\/')),
    'it names the invoice to revise instead');
});

test('a superseded invoice cannot be cancelled behind the revision', async () => {
  const inv = await finalize();
  const r = await app.post(`/api/invoices/${inv.invoiceId}/revise`, { ...payload(), reason: 'correction' });
  assert.equal(r.status, 200, r.text);

  const before = qtyOf(stock.hose);
  const cancel = await app.post(`/api/invoices/${inv.invoiceId}/cancel`, { reason: 'oops' });
  assert.equal(cancel.status, 400);
  assert.match(cancel.body.error, /already been superseded/);
  assert.equal(qtyOf(stock.hose), before, 'no second stock restoration');
});

// --- what the job kept -----------------------------------------------------

test('the replacement inherits what the job was, not just what was billed', async () => {
  const cust = await app.post('/api/customers', { name: 'Revision Test Co', kind: 'internal' });
  assert.equal(cust.status, 200, cust.text);
  const customerId = cust.body.customer.CustomerID;
  const mach = await app.post('/api/machines', { name: 'LY-4524', kind: 'vehicle', customerId });
  assert.equal(mach.status, 200, mach.text);
  const machineId = db.prepare('SELECT MachineID FROM Machines WHERE Name = ?').get('LY-4524').MachineID;

  const inv = await finalize();
  db.prepare('UPDATE Invoices SET IsInternal = 1, CustomerID = ?, MachineID = ?, TechChargePaid = 1 WHERE InvoiceID = ?')
    .run(customerId, machineId, inv.invoiceId);

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, { ...payload(), reason: 'wrong length' });
  assert.equal(res.status, 200, res.text);

  const replacement = invoiceRow(res.body.invoiceId);
  assert.equal(replacement.IsInternal, 1, 'own-fleet work must not become a sale');
  assert.equal(replacement.CustomerID, customerId);
  assert.equal(replacement.MachineID, machineId);
  assert.equal(replacement.TechChargePaid, 1, 'the technician is not queued for payment twice');

  // Internal work posts to Internal Repairs, never to Sales — the whole point
  // of carrying IsInternal across.
  const journal = db.prepare(`
    SELECT a.Code FROM JournalLines l
    JOIN JournalEntries j ON j.JournalID = l.JournalID
    JOIN Accounts a ON a.AccountID = l.AccountID
    WHERE j.SourceType = 'invoice' AND j.SourceID = ?`).all(String(res.body.invoiceId)).map((r) => r.Code);
  assert.ok(!journal.includes('4100') && !journal.includes('1200'),
    'an internal job must not invent revenue or a receivable');
});

// --- voiding a payment on its own -----------------------------------------

test('voiding a payment frees the invoice to be cancelled', async () => {
  const inv = await finalize();
  await app.post(`/api/invoices/${inv.invoiceId}/payments`, { amount: 3000, method: 'Cash', date: '2026-09-08' });

  const blocked = await app.post(`/api/invoices/${inv.invoiceId}/cancel`, { reason: 'wrong customer' });
  assert.equal(blocked.status, 400, 'paid invoices are still protected');

  const list = await app.get(`/api/invoices/${inv.invoiceId}/payments`);
  const paymentId = list.body.payments[0].PaymentID;

  const noReason = await app.post(`/api/payments/${paymentId}/void`, { reason: '' });
  assert.equal(noReason.status, 400, 'a void needs a reason too');

  const cashBefore = balanceOf('1110');
  const voided = await app.post(`/api/payments/${paymentId}/void`, { reason: 'entered against the wrong invoice' });
  assert.equal(voided.status, 200, voided.text);
  assert.equal(voided.body.amountPaid, 0);
  assert.equal(voided.body.balance, 3000);
  assert.equal(balanceOf('1110'), cashBefore - 3000);

  const twice = await app.post(`/api/payments/${paymentId}/void`, { reason: 'again' });
  assert.equal(twice.status, 400);
  assert.match(twice.body.error, /already been voided/);

  const now = await app.post(`/api/invoices/${inv.invoiceId}/cancel`, { reason: 'wrong customer' });
  assert.equal(now.status, 200, now.text);
  assert.ok(trialBalanced());
});

test('a voided payment stops counting, so the money can be recorded again', async () => {
  const inv = await finalize();
  await app.post(`/api/invoices/${inv.invoiceId}/payments`, { amount: 3000, method: 'Cash', date: '2026-09-08' });
  const list = await app.get(`/api/invoices/${inv.invoiceId}/payments`);
  await app.post(`/api/payments/${list.body.payments[0].PaymentID}/void`, { reason: 'wrong amount' });

  // Before the VoidedAt filter, AmountPaid stayed inflated and this was refused.
  const again = await app.post(`/api/invoices/${inv.invoiceId}/payments`, { amount: 3000, method: 'Cash', date: '2026-09-08' });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.balance, 0);
  assert.equal(invoiceRow(inv.invoiceId).AmountPaid, 3000, 'the voided one is not counted twice');
  assert.ok(trialBalanced());
});

// --- the invoice that started all this ------------------------------------

test('an invoice whose journals were already reversed by hand can still be revised', async () => {
  const inv = await finalize();
  const paid = await app.post(`/api/invoices/${inv.invoiceId}/payments`, { amount: 3000, method: 'Cash', date: '2026-09-08' });
  assert.equal(paid.status, 200, paid.text);

  // Reproduce INV/2026/09/003 exactly: both journals reversed from the ledger
  // screen, while the invoice, the payment and the stock still say otherwise.
  const paymentId = (await app.get(`/api/invoices/${inv.invoiceId}/payments`)).body.payments[0].PaymentID;
  const ledgerSvc = require('../services/ledger');
  const payJournal = ledgerSvc.isPosted('payment', paymentId);
  const invJournal = ledgerSvc.isPosted('invoice', inv.invoiceId);
  assert.equal((await app.post(`/api/ledger/journals/${payJournal}/reverse`, {})).status, 200);
  assert.equal((await app.post(`/api/ledger/journals/${invJournal}/reverse`, {})).status, 200);
  assert.equal(invoiceRow(inv.invoiceId).Status, 'Finalized', 'the invoice is untouched by a journal reversal');
  assert.equal(invoiceRow(inv.invoiceId).AmountPaid, 3000);

  const stockBefore = qtyOf(stock.hose);
  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(),
    reason: 'Mistakes not add crimping charge',
    items: [
      { inventoryId: stock.hose, description: 'R1 hose 1/4"', unit: 'm', qty: 5, rate: 600, cost: 144 },
      { description: 'Crimping charge', unit: 'nos', qty: 2, rate: 500, cost: 120 },
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.grandTotal, 4000);
  assert.equal(invoiceRow(inv.invoiceId).Status, 'Revised');
  assert.equal(qtyOf(stock.hose), stockBefore, 'the same parts on the corrected bill');

  // The replacement posts fresh, and the cash comes back onto the books with it.
  assert.ok(res.body.posting && res.body.posting.journalId, 'the replacement is on the books');
  assert.equal(res.body.paymentsCarried, 3000);
  assert.equal(res.body.balance, 1000, 'the customer owes the crimping charge');
  assert.ok(trialBalanced());
  assertReconciled('revising an invoice whose journals were already reversed');
});

// --- closed periods --------------------------------------------------------
//
// The books can only be corrected in a period that is open. Every posting a
// revision makes lands on the revision's date or falls back to it, so the guard
// is a single up-front check — and it must REFUSE, because the alternative is an
// invoice rearranged in every table while the ledger sits untouched.

test('a revision dated in a closed period is refused before anything moves', async () => {
  const inv = await finalize({ invoiceDate: '2026-03-10' });
  await app.post(`/api/invoices/${inv.invoiceId}/payments`, { amount: 3000, method: 'Cash', date: '2026-03-11' });

  const closed = await app.post('/api/ledger/periods/2026-03/close', {});
  assert.equal(closed.status, 200, closed.text);

  const journalsBefore = db.prepare('SELECT COUNT(*) c FROM JournalEntries').get().c;
  const stockBefore = qtyOf(stock.hose);

  const res = await app.post(`/api/invoices/${inv.invoiceId}/revise`, {
    ...payload(), invoiceDate: '2026-03-10', reason: 'crimping charge missing',
  });
  assert.equal(res.status, 409, res.text);
  assert.match(res.body.error, /2026-03 is closed/);

  assert.equal(invoiceRow(inv.invoiceId).Status, 'Finalized', 'the invoice is untouched');
  assert.equal(invoiceRow(inv.invoiceId).AmountPaid, 3000, 'and so is its money');
  assert.equal(qtyOf(stock.hose), stockBefore, 'and so is the shelf');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM JournalEntries').get().c, journalsBefore);
  assertReconciled('a refused revision');
});

test('the same invoice revises fine when dated into an open period', async () => {
  const inv = db.prepare("SELECT InvoiceID FROM Invoices WHERE InvoiceDate LIKE '2026-03-10%' AND Status = 'Finalized'").get();
  topUp(100);

  const res = await app.post(`/api/invoices/${inv.InvoiceID}/revise`, {
    ...payload(),
    invoiceDate: '2026-09-09',
    reason: 'crimping charge missing',
    items: [
      { inventoryId: stock.hose, description: 'R1 hose 1/4"', unit: 'm', qty: 5, rate: 600, cost: 144 },
      { description: 'Crimping charge', unit: 'nos', qty: 1, rate: 800, cost: 120 },
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ledgerErrors, null, 'everything reached the books');
  assert.ok(res.body.posting && res.body.posting.journalId, 'the replacement posted');
  assert.equal(res.body.paymentsCarried, 3000, 'the March cash follows into September');
  assert.ok(trialBalanced());
  assertReconciled('revising a closed-period invoice into an open one');
});

test('voiding a payment whose period is closed is refused, not half-done', async () => {
  const inv = await finalize({ invoiceDate: '2026-04-10' });
  await app.post(`/api/invoices/${inv.invoiceId}/payments`, { amount: 3000, method: 'Cash', date: '2026-04-11' });
  assert.equal((await app.post('/api/ledger/periods/2026-04/close', {})).status, 200);

  const paymentId = (await app.get(`/api/invoices/${inv.invoiceId}/payments`)).body.payments[0].PaymentID;
  const res = await app.post(`/api/payments/${paymentId}/void`, { reason: 'recorded twice' });
  assert.equal(res.status, 409, res.text);
  assert.match(res.body.error, /2026-04 is closed/);

  // The dangerous half-state: unpaid in the subledger, cash still in the ledger.
  assert.equal(invoiceRow(inv.invoiceId).AmountPaid, 3000, 'the payment still stands');
  assert.equal(db.prepare('SELECT VoidedAt FROM Payments WHERE PaymentID = ?').get(paymentId).VoidedAt, null);
  assertReconciled('a refused void');
});

test('a superseded invoice prints with a banner so it cannot be handed over as live', () => {
  const { buildInvoiceHtml } = require('../services/invoicePdf');
  const base = { InvoiceNo: 'INV/2026/09/003', InvoiceDate: '2026-09-08', BilledToName: 'LY-4524', GrandTotal: 4732 };
  const items = [{ ItemDescription: 'R1 hose', Unit: 'm', Qty: 4.9, Rate: 616 }];

  assert.ok(!buildInvoiceHtml({ ...base, Status: 'Finalized' }, items, {}).includes('class="voided"'),
    'a live invoice prints clean');
  assert.match(buildInvoiceHtml({ ...base, Status: 'Revised' }, items, {}), /NOT VALID/);
  assert.match(buildInvoiceHtml({ ...base, Status: 'Cancelled' }, items, {}), /CANCELLED/);
});

test('every revision was audited under the invoice, not the plural route name', () => {
  const rows = db.prepare(
    "SELECT Entity, Action, COUNT(*) c FROM AuditLog WHERE Action IN ('revise','void') GROUP BY Entity, Action").all();
  const revise = rows.find((r) => r.Action === 'revise');
  const voidRow = rows.find((r) => r.Action === 'void');
  assert.ok(revise && revise.Entity === 'invoice', 'revisions are filed under invoice');
  assert.ok(voidRow && voidRow.Entity === 'payment', 'voids are filed under payment');
});
