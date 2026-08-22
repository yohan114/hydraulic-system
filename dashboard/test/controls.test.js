'use strict';

/**
 * Period controls end to end: depreciation, stock takes, receivables ageing and
 * the year-end close — with the ledger agreeing at every step.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/appHarness');

let app;
let db;
let hoseId;
let unionId;

test.before(async () => {
  app = await startTestApp();
  db = app.db._db;
  const mk = (uid, name, qty, cost, cat) => db.prepare(
    `INSERT INTO Inventory (UniqueID, ProductName, Unit, Qty, Cost, Price, Category, ValuationMethod)
     VALUES (?, ?, 'm', ?, ?, 0, ?, 'WAC')`).run(uid, name, qty, cost, cat).lastInsertRowid;
  hoseId = mk('HOSE-R2-13', 'R2 hose 1/2"', 100, 355, 'Hose');
  unionId = mk('UNION-13', 'BSP union 1/2"', 40, 100, 'Union');

  // Opening stock so the ledger has something to reconcile against.
  const ledgerSvc = require('../services/ledger');
  ledgerSvc.postEntry({
    date: '2026-01-01', memo: 'Opening stock',
    sourceType: 'opening', sourceID: 'stock',
    lines: [{ accountCode: '1300', debit: 39500 }, { accountCode: '3900', credit: 39500 }],
  });
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

test('the asset and depreciation accounts were added', async () => {
  const codes = (await app.get('/api/accounts')).body.map((a) => a.Code);
  ['1510', '1590', '6400'].forEach((c) => assert.ok(codes.includes(c), `${c} missing`));
});

test('the historical tax codes are seeded but inactive', async () => {
  const res = await app.get('/api/tax-codes');
  assert.equal(res.status, 200);
  const vat = res.body.find((t) => t.Code === 'VAT');
  assert.equal(vat.Rate, 18);
  assert.equal(vat.Active, 0, 'the shop no longer charges it');
});

let assetId;

test('registering the crimping machine puts it on the balance sheet', async () => {
  const res = await app.post('/api/assets', {
    code: 'PM-001', name: 'Crimping machine', category: 'Plant',
    inServiceFrom: '2026-01-01', cost: 480000, residual: 0, lifeMonths: 60, paidFrom: 'bank',
  });
  assert.equal(res.status, 200, res.text);
  assetId = res.body.assetId;
  assert.equal(balanceOf('1510'), 480000);
  assert.ok(trialBalanced());
});

test('an asset owned before the books opened posts at the opening date, not acquisition', async () => {
  const accumBefore = balanceOf('1590');
  const plantBefore = balanceOf('1510');

  // Bought in January, books opened in May: four months already depreciated.
  const res = await app.post('/api/assets', {
    name: 'Old bench press', inServiceFrom: '2026-01-01', postingDate: '2026-05-21',
    cost: 120000, residual: 0, lifeMonths: 60, accumulated: 8000, opening: true,
  });
  assert.equal(res.status, 200, res.text);

  assert.equal(balanceOf('1510'), plantBefore + 120000);
  assert.equal(balanceOf('1590'), accumBefore - 8000, 'the depreciation already taken comes forward');
  assert.ok(trialBalanced());

  // Both entries sit at the opening date, not in January.
  const entries = db.prepare(`
    SELECT EntryDate FROM JournalEntries
    WHERE SourceType IN ('asset', 'asset-opening-dep') ORDER BY JournalID DESC LIMIT 2`).all();
  entries.forEach((e) => assert.equal(e.EntryDate, '2026-05-21',
    'an opening asset belongs on the ledger when the books opened'));

  // Its age still counts from January, so the next charge is not the first.
  const asset = (await app.get('/api/assets')).body.find((x) => x.Name === 'Old bench press');
  assert.equal(asset.InServiceFrom, '2026-01-01');
  assert.equal(asset.Accumulated, 8000);
  assert.equal(asset.NetBookValue, 112000);
});

test('a bad posting date is refused', async () => {
  const res = await app.post('/api/assets', {
    name: 'Bad date', inServiceFrom: '2026-01-01', postingDate: 'January', cost: 100, lifeMonths: 12,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Posting date/);
});

test('an asset with no cost is refused', async () => {
  const res = await app.post('/api/assets', { name: 'Nothing', inServiceFrom: '2026-01-01', cost: 0 });
  assert.equal(res.status, 400);
});

// Two assets are on the books by now: the crimping machine (480,000 / 60 =
// 8,000 a month) and the bench press (120,000 / 60 = 2,000).
const MONTHLY = 8000 + 2000;

test('a depreciation run charges the period and posts it', async () => {
  const res = await app.post('/api/assets/depreciation/run', { period: '2026-08' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.total, MONTHLY);
  assert.equal(res.body.charged.length, 2, 'every active asset is charged');
  assert.equal(res.body.charged.find((c) => c.assetId === assetId).charge, 8000);
  assert.equal(balanceOf('6400'), MONTHLY, 'the charge is an expense');
  assert.equal(balanceOf('1590'), -(MONTHLY + 8000), 'accumulated includes the 8,000 brought forward');
  assert.ok(trialBalanced());

  const asset = (await app.get('/api/assets')).body.find((a) => a.AssetID === assetId);
  assert.equal(asset.Accumulated, 8000);
  assert.equal(asset.NetBookValue, 472000);
});

test('running the same period twice charges nothing more', async () => {
  const again = await app.post('/api/assets/depreciation/run', { period: '2026-08' });
  assert.equal(again.body.total, 0, 'the period was already charged');
  assert.equal(balanceOf('6400'), MONTHLY, 'depreciation must not double');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM DepreciationEntries WHERE Period = '2026-08'").get().c, 2);
});

test('a later period charges again, and the run is recorded per asset', async () => {
  const res = await app.post('/api/assets/depreciation/run', { period: '2026-09' });
  assert.equal(res.body.total, MONTHLY);
  assert.equal(balanceOf('6400'), MONTHLY * 2);
  const entries = await app.get('/api/assets/depreciation');
  assert.equal(entries.body.length, 4, 'two assets x two periods');
  assert.equal(entries.body[0].Period, '2026-09');
});

test('a bad period is refused', async () => {
  const res = await app.post('/api/assets/depreciation/run', { period: 'August' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /YYYY-MM/);
});

test('stock valuation totals the shelf and reconciles to the ledger', async () => {
  const res = await app.get('/api/stock/valuation');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 39500);        // 100 x 355 + 40 x 100
  assert.equal(res.body.ledgerStock, 39500);
  assert.equal(res.body.reconciled, true);
  assert.equal(res.body.difference, 0);
  assert.equal(res.body.byCategory[0].category, 'Hose');
  assert.equal(res.body.negative.length, 0);
});

let takeId;

test('opening a stock take freezes the system quantities onto a count sheet', async () => {
  const res = await app.post('/api/stock-takes', { takeDate: '2026-09-30' });
  assert.equal(res.status, 200, res.text);
  takeId = res.body.takeId;
  assert.match(res.body.takeNo, /^ST\/\d{4}\/0001$/);
  assert.equal(res.body.lines, 2);

  const detail = await app.get(`/api/stock-takes/${takeId}`);
  // Counted defaults to system, so an untouched sheet has no variance.
  assert.equal(detail.body.totalVariance, 0);
  assert.equal(detail.body.lines.length, 2);
});

test('the draft count sheet exports with the Counted column blank', async () => {
  const res = await app.getBuffer(`/api/stock-takes/${takeId}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /Stock_Count_ST_\d{4}_0001\.xlsx/);

  const xlsx = require('xlsx');
  const wb = xlsx.read(res.buffer, { type: 'buffer' });
  const rows = xlsx.utils.sheet_to_json(wb.Sheets['Count Sheet'], { defval: '' });
  assert.equal(rows.length, 2, 'one row per stock line');
  rows.forEach((r) => {
    assert.ok(r['System Qty'] !== '', 'the system figure is shown so it can be checked against');
    assert.equal(r['Counted Qty'], '', 'a sheet that pre-fills the answer invites confirming, not counting');
  });
  assert.ok(rows.some((r) => r.Category === 'Hose'));
});

test('entering counts produces a variance without changing stock yet', async () => {
  const detail = await app.get(`/api/stock-takes/${takeId}`);
  const hoseLine = detail.body.lines.find((l) => l.inventoryId === hoseId);
  const unionLine = detail.body.lines.find((l) => l.inventoryId === unionId);

  const res = await app.put(`/api/stock-takes/${takeId}`, {
    counts: [
      { stockTakeItemId: hoseLine.stockTakeItemId, countedQty: 96 },   // 4 short
      { stockTakeItemId: unionLine.stockTakeItemId, countedQty: 43 },  // 3 over
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.shortages, -1420);    // 4 x 355
  assert.equal(res.body.overages, 300);       // 3 x 100
  assert.equal(res.body.totalVariance, -1120);

  // Nothing has moved until it is posted.
  assert.equal(db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(hoseId).Qty, 100);
});

test('posting the take adjusts stock and puts the difference through the ledger', async () => {
  const stockBefore = balanceOf('1300');
  const res = await app.post(`/api/stock-takes/${takeId}/post`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.adjusted, 2);
  assert.equal(res.body.totalVariance, -1120);

  assert.equal(db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(hoseId).Qty, 96);
  assert.equal(db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(unionId).Qty, 43);
  assert.equal(balanceOf('1300'), stockBefore - 1120);
  assert.equal(balanceOf('5900'), 1120, 'the loss lands in Stock Adjustments');
  assert.ok(trialBalanced());

  // The movement is on the audit trail, not a silent quantity edit.
  const moves = db.prepare("SELECT * FROM StockMovements WHERE MovementType = 'ADJUST'").all();
  assert.equal(moves.length, 2);
  assert.match(moves[0].Notes, /Stock take ST/);
});

test('stock still reconciles to the ledger after the adjustment', async () => {
  const res = await app.get('/api/stock/valuation');
  assert.equal(res.body.reconciled, true, `off by ${res.body.difference}`);
  assert.equal(res.body.total, 38380);        // 96 x 355 + 43 x 100
});

test('a posted stock take cannot be posted or edited again', async () => {
  const again = await app.post(`/api/stock-takes/${takeId}/post`);
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already been posted/);

  const edit = await app.put(`/api/stock-takes/${takeId}`, { counts: [] });
  assert.equal(edit.status, 400);
});

test('receivables ageing buckets what customers owe', async () => {
  const c = (await app.post('/api/customers', { name: 'Slow Payer', paymentTermsDays: 30 })).body.customer;
  db.prepare(`INSERT INTO Invoices (InvoiceNo, InvoiceDate, BilledToName, Status, GrandTotal, AmountPaid, IsInternal, CustomerID)
    VALUES ('AR/1', '2026-06-01', 'Slow Payer', 'Finalized', 5000, 1000, 0, ?)`).run(c.CustomerID);
  // An internal job must never appear as a receivable.
  db.prepare(`INSERT INTO Invoices (InvoiceNo, InvoiceDate, BilledToName, Status, GrandTotal, AmountPaid, IsInternal)
    VALUES ('INT/9', '2026-06-01', 'HEX-18', 'Finalized', 9000, 0, 1)`).run();

  const res = await app.get('/api/receivables/ageing?asAt=2026-09-30');
  assert.equal(res.status, 200);
  assert.equal(res.body.invoices.length, 1, 'internal work is not a receivable');
  assert.equal(res.body.invoices[0].Outstanding, 4000);
  assert.equal(res.body.invoices[0].Due, '2026-07-01', 'due date honours the payment terms');
  assert.equal(res.body.buckets.older, 4000, '91 days past due');
  assert.equal(res.body.buckets.total, 4000);
});

test('the year-end close sweeps profit into retained earnings', async () => {
  const before = await app.get('/api/ledger/pl');
  const netBefore = before.body.netProfit;
  assert.notEqual(netBefore, 0, 'there should be something to close');

  const res = await app.post('/api/ledger/close-year', { throughDate: '2026-12-31' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.netProfit, netBefore);

  // Every P&L account is now flat, and the net sits in Retained Earnings.
  const after = await app.get('/api/ledger/pl');
  assert.equal(after.body.revenue, 0);
  assert.equal(after.body.cogs, 0);
  assert.equal(after.body.expensesTotal, 0);
  assert.equal(after.body.netProfit, 0);
  assert.equal(balanceOf('3200'), -netBefore, 'the loss/profit carried to equity');
  assert.ok(trialBalanced());

  const bs = await app.get('/api/ledger/balance-sheet');
  assert.equal(bs.body.balanced, true, `off by ${bs.body.difference}`);
});

test('closing again when there is nothing left is refused', async () => {
  const res = await app.post('/api/ledger/close-year', { throughDate: '2026-12-31' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /nothing to close/);
});

test('control writes are audited', () => {
  const seen = db.prepare(
    "SELECT DISTINCT Entity FROM AuditLog WHERE Entity IN ('asset','depreciation','stock-take','year-end')"
  ).all().map((r) => r.Entity);
  ['asset', 'depreciation', 'stock-take', 'year-end'].forEach((e) =>
    assert.ok(seen.includes(e), `${e} was not audited`));
});
