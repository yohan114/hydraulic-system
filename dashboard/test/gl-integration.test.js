'use strict';

/**
 * The General Ledger driven through the real app: posting rules, the guards
 * that keep the books honest, and the statements coming out the other end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/appHarness');

let app;
let db;

test.before(async () => { app = await startTestApp(); db = app.db._db; });
test.after(async () => { if (app) await app.close(); });

/** Build a finalized invoice straight in the tables, then post it. */
function makeInvoice({ no, date, internal, lines, sscl = 0, vat = 0, customerId = null }) {
  const total = lines.reduce((a, l) => a + l.qty * l.rate, 0) + sscl + vat;
  const info = db.prepare(`INSERT INTO Invoices
    (InvoiceNo, InvoiceDate, BilledToName, Status, SubTotal, SSCLAmount, VATAmount, GrandTotal, IsInternal, CustomerID)
    VALUES (?, ?, 'Test', 'Finalized', ?, ?, ?, ?, ?, ?)`)
    .run(no, date, total - sscl - vat, sscl, vat, total, internal ? 1 : 0, customerId);
  const id = info.lastInsertRowid;
  const ins = db.prepare(`INSERT INTO InvoiceItems
    (InvoiceID, ItemDescription, Qty, Rate, Amount, UnitCostAtBilling) VALUES (?, ?, ?, ?, ?, ?)`);
  lines.forEach((l) => ins.run(id, l.desc, l.qty, l.rate, l.qty * l.rate, l.cost || 0));
  return id;
}

function balanceOf(code) {
  const row = db.prepare(`
    SELECT ROUND(COALESCE(SUM(l.Debit), 0) - COALESCE(SUM(l.Credit), 0), 2) AS v
    FROM JournalLines l JOIN Accounts a ON a.AccountID = l.AccountID WHERE a.Code = ?`).get(code);
  return row.v || 0;
}

test('the chart of accounts is seeded and every code has a valid type', async () => {
  const res = await app.get('/api/accounts');
  assert.equal(res.status, 200);
  assert.ok(res.body.length >= 19, `expected the seeded chart, got ${res.body.length}`);
  const { typeOfCode } = require('../lib/ledger');
  res.body.forEach((a) => assert.equal(a.Type, typeOfCode(a.Code), `${a.Code} has the wrong type`));
});

test('an external invoice posts revenue, receivable and cost of sales', () => {
  const gl = require('../services/glPosting');
  const id = makeInvoice({
    no: 'EXT/1', date: '2026-07-24', internal: false,
    lines: [
      { desc: 'R2 hose 1/2"', qty: 2, rate: 1000, cost: 355 },
      { desc: 'Crimping charge — 1/2"', qty: 2, rate: 600, cost: 0 },
    ],
  });
  const res = gl.postInvoice(id, { allowClosedPeriod: true });
  assert.ok(res && res.journalId);
  assert.equal(res.debit, res.credit, 'the entry must balance');

  assert.equal(balanceOf('1200'), 3200);     // AR = 2000 parts + 1200 technical
  assert.equal(balanceOf('4100'), -2000);    // credit balances read negative as raw debit-credit
  assert.equal(balanceOf('4200'), -1200);
  assert.equal(balanceOf('5100'), 710);      // 2 x 355
  assert.equal(balanceOf('1300'), -710);
});

test('an internal job posts workshop cost only — no sale, no receivable', () => {
  const gl = require('../services/glPosting');
  const arBefore = balanceOf('1200');
  const salesBefore = balanceOf('4100');

  const id = makeInvoice({
    no: 'INT/1', date: '2026-07-25', internal: true,
    lines: [{ desc: 'R2 hose 1/2"', qty: 4, rate: 1000, cost: 355 }],
  });
  const res = gl.postInvoice(id, { allowClosedPeriod: true });
  assert.ok(res.journalId);

  assert.equal(balanceOf('1200'), arBefore, 'internal work must not create a receivable');
  assert.equal(balanceOf('4100'), salesBefore, 'internal work must not create revenue');
  assert.equal(balanceOf('6900'), 1420, 'the parts become a workshop cost at landed cost');
});

test('tax on a sale is a liability, not income', () => {
  const gl = require('../services/glPosting');
  const id = makeInvoice({
    no: 'EXT/TAX', date: '2026-07-26', internal: false,
    lines: [{ desc: 'Part', qty: 1, rate: 1000, cost: 100 }], sscl: 25, vat: 184.5,
  });
  gl.postInvoice(id, { allowClosedPeriod: true });
  assert.equal(balanceOf('2300'), -209.5, 'SSCL + VAT sit in Taxes Payable');
});

test('posting the same invoice twice does not double the books', () => {
  const gl = require('../services/glPosting');
  const id = makeInvoice({
    no: 'EXT/DUP', date: '2026-07-27', internal: false,
    lines: [{ desc: 'Part', qty: 1, rate: 500, cost: 100 }],
  });
  const first = gl.postInvoice(id, { allowClosedPeriod: true });
  const ar = balanceOf('1200');
  const second = gl.postInvoice(id, { allowClosedPeriod: true });
  assert.equal(second.journalId, first.journalId);
  assert.equal(second.alreadyPosted, true);
  assert.equal(balanceOf('1200'), ar, 'a replay must change nothing');
});

test('a payment on an internal job is not treated as cash', () => {
  const gl = require('../services/glPosting');
  const internalId = db.prepare("SELECT InvoiceID FROM Invoices WHERE InvoiceNo = 'INT/1'").get().InvoiceID;
  const pay = db.prepare("INSERT INTO Payments (InvoiceID, Amount, PaymentDate, Method) VALUES (?, 4000, '2026-07-25', 'Cash')").run(internalId);
  const cashBefore = balanceOf('1110');
  const res = gl.postPayment(pay.lastInsertRowid, { allowClosedPeriod: true });
  assert.equal(res, null, 'an internal "payment" is bookkeeping, not money');
  assert.equal(balanceOf('1110'), cashBefore);
});

test('a payment on an external invoice clears the receivable into cash', () => {
  const gl = require('../services/glPosting');
  const extId = db.prepare("SELECT InvoiceID FROM Invoices WHERE InvoiceNo = 'EXT/1'").get().InvoiceID;
  const pay = db.prepare("INSERT INTO Payments (InvoiceID, Amount, PaymentDate, Method) VALUES (?, 3200, '2026-07-28', 'Cash')").run(extId);
  const arBefore = balanceOf('1200');
  gl.postPayment(pay.lastInsertRowid, { allowClosedPeriod: true });
  assert.equal(balanceOf('1110'), 3200);
  assert.equal(balanceOf('1200'), arBefore - 3200);
});

test('a bank payment lands in Bank rather than Cash in Hand', () => {
  const gl = require('../services/glPosting');
  const id = makeInvoice({ no: 'EXT/BANK', date: '2026-07-29', internal: false, lines: [{ desc: 'Part', qty: 1, rate: 900, cost: 0 }] });
  gl.postInvoice(id, { allowClosedPeriod: true });
  const pay = db.prepare("INSERT INTO Payments (InvoiceID, Amount, PaymentDate, Method) VALUES (?, 900, '2026-07-29', 'Bank Transfer')").run(id);
  const bankBefore = balanceOf('1120');
  gl.postPayment(pay.lastInsertRowid, { allowClosedPeriod: true });
  assert.equal(balanceOf('1120'), bankBefore + 900);
});

test('a reversal mirrors the original and leaves it standing', () => {
  const gl = require('../services/glPosting');
  const ledgerSvc = require('../services/ledger');
  const id = makeInvoice({ no: 'EXT/REV', date: '2026-07-30', internal: false, lines: [{ desc: 'Part', qty: 1, rate: 700, cost: 200 }] });
  const posted = gl.postInvoice(id, { allowClosedPeriod: true });
  const arAfterPost = balanceOf('1200');

  const rev = gl.reverseInvoice(id, {});
  assert.ok(rev.journalId && rev.journalId !== posted.journalId);
  assert.equal(balanceOf('1200'), arAfterPost - 700, 'the receivable is undone');
  // The original entry is untouched.
  assert.ok(db.prepare('SELECT JournalID FROM JournalEntries WHERE JournalID = ?').get(posted.journalId));
  // And it cannot be reversed twice.
  assert.throws(() => ledgerSvc.reverseEntry(posted.journalId), /already been reversed/);
});

test('the ledger refuses an entry that does not balance', () => {
  const ledgerSvc = require('../services/ledger');
  assert.throws(() => ledgerSvc.postEntry({
    date: '2026-08-01',
    lines: [{ accountCode: '1110', debit: 100 }, { accountCode: '4100', credit: 90 }],
  }), /does not balance/);
});

test('the ledger refuses an account that is not in the chart', () => {
  const ledgerSvc = require('../services/ledger');
  assert.throws(() => ledgerSvc.postEntry({
    date: '2026-08-01',
    lines: [{ accountCode: '1999', debit: 100 }, { accountCode: '4100', credit: 100 }],
  }), /not in the chart of accounts/);
});

test('a closed period refuses new postings', async () => {
  const ledgerSvc = require('../services/ledger');
  const close = await app.post('/api/ledger/periods/2026-07/close');
  assert.equal(close.status, 200);

  assert.throws(() => ledgerSvc.postEntry({
    date: '2026-07-15',
    lines: [{ accountCode: '1110', debit: 50 }, { accountCode: '4100', credit: 50 }],
  }), /Period 2026-07 is closed/);

  // An open period still accepts work, and reopening restores July.
  const ok = ledgerSvc.postEntry({
    date: '2026-08-15', memo: 'still open',
    lines: [{ accountCode: '1110', debit: 50 }, { accountCode: '4100', credit: 50 }],
  });
  assert.ok(ok.journalId);
  await app.post('/api/ledger/periods/2026-07/reopen');
  const after = ledgerSvc.postEntry({
    date: '2026-07-15', memo: 'reopened',
    lines: [{ accountCode: '1110', debit: 10 }, { accountCode: '4100', credit: 10 }],
  });
  assert.ok(after.journalId);
});

test('the trial balance balances and the statements agree with it', async () => {
  const tb = await app.get('/api/ledger/trial-balance');
  assert.equal(tb.status, 200);
  assert.equal(tb.body.totals.balanced, true,
    `debits ${tb.body.totals.debit} vs credits ${tb.body.totals.credit}`);

  const pl = await app.get('/api/ledger/pl');
  assert.equal(pl.status, 200);
  assert.equal(pl.body.netProfit, Math.round((pl.body.grossProfit - pl.body.expensesTotal) * 100) / 100);

  const bs = await app.get('/api/ledger/balance-sheet');
  assert.equal(bs.status, 200);
  assert.equal(bs.body.balanced, true, `balance sheet off by ${bs.body.difference}`);
});

test('the monthly P&L breaks the period down and agrees with the single-period one', async () => {
  const res = await app.get('/api/ledger/pl/monthly');
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.months.length > 0, 'expected at least one month of activity');

  // Newest first, and each month carries its own cash movement.
  const periods = res.body.months.map((m) => m.period);
  assert.deepEqual(periods, [...periods].sort().reverse());
  res.body.months.forEach((m) => {
    assert.equal(m.grossProfit, Math.round((m.revenue - m.cogs) * 100) / 100);
    assert.equal(m.netProfit, Math.round((m.grossProfit - m.expenses) * 100) / 100);
    assert.equal(m.cashNet, Math.round((m.cashIn - m.cashOut) * 100) / 100);
  });

  // The months must add up to what the single-period statement says.
  const pl = await app.get('/api/ledger/pl');
  assert.equal(res.body.totals.netProfit, pl.body.netProfit, 'monthly total must equal the period P&L');
  assert.equal(res.body.totals.revenue, pl.body.revenue);
});

test('the monthly P&L honours a date range', async () => {
  const all = await app.get('/api/ledger/pl/monthly');
  const narrowed = await app.get('/api/ledger/pl/monthly?from=2026-08-01&to=2026-08-31');
  assert.equal(narrowed.status, 200);
  assert.ok(narrowed.body.months.length <= all.body.months.length);
  narrowed.body.months.forEach((m) => assert.equal(m.period, '2026-08'));
});

test('an account ledger shows every movement with a running balance', async () => {
  const res = await app.get('/api/ledger/account/1300');
  assert.equal(res.status, 200);
  assert.equal(res.body.account.code, '1300');
  assert.ok(res.body.lines.length > 0);
  assert.equal(res.body.closing, balanceOf('1300'));

  const missing = await app.get('/api/ledger/account/1999');
  assert.equal(missing.status, 404);
});

test('a manual journal can be posted and is audited', async () => {
  const res = await app.post('/api/ledger/journals', {
    date: '2026-08-20', memo: 'Owner introduced cash',
    lines: [{ accountCode: '1110', debit: 5000 }, { accountCode: '3100', credit: 5000 }],
  });
  assert.equal(res.status, 200, res.text);
  assert.match(res.body.entryNo, /^JV\/2026-08\/\d{4}$/);

  const row = db.prepare("SELECT * FROM AuditLog WHERE Entity = 'journal' ORDER BY AuditID DESC LIMIT 1").get();
  assert.ok(row);
  assert.equal(row.Action, 'post');

  const bad = await app.post('/api/ledger/journals', {
    date: '2026-08-20', lines: [{ accountCode: '1110', debit: 10 }, { accountCode: '3100', credit: 5 }],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /does not balance/);
});

test('journal numbers run in sequence within a period', () => {
  const nos = db.prepare("SELECT EntryNo FROM JournalEntries WHERE Period = '2026-07' ORDER BY JournalID").all()
    .map((r) => r.EntryNo);
  const seqs = nos.map((n) => Number(n.split('/').pop()));
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b));
  assert.equal(new Set(nos).size, nos.length, 'journal numbers must be unique');
});
