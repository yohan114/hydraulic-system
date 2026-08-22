'use strict';

/**
 * The procurement cycle end to end: order, receive with landed costs, invoice,
 * pay — and the ledger agreeing at every step.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/appHarness');

let app;
let db;
let supplierId;
let itemA;
let itemB;

test.before(async () => {
  app = await startTestApp();
  db = app.db._db;

  supplierId = db.prepare(
    "INSERT INTO Suppliers (Name, Active, Currency, PaymentTermsDays) VALUES ('Henan Spark', 1, 'USD', 30)"
  ).run().lastInsertRowid;

  const mk = (uid, name, qty, cost) => db.prepare(
    `INSERT INTO Inventory (UniqueID, ProductName, Unit, Qty, Cost, Price, ValuationMethod)
     VALUES (?, ?, 'm', ?, ?, 0, 'WAC')`).run(uid, name, qty, cost).lastInsertRowid;
  itemA = mk('HOSE-R2-13', 'R2 hydraulic hose 1/2"', 10, 300);
  itemB = mk('UNION-13', 'BSP union 1/2"', 0, 0);
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

test('the procurement accounts were added to the chart', async () => {
  const res = await app.get('/api/accounts');
  const codes = res.body.map((a) => a.Code);
  assert.ok(codes.includes('2150'), 'Goods Received Not Invoiced missing');
  assert.ok(codes.includes('5910'), 'Purchase Price Variance missing');
  assert.equal(res.body.find((a) => a.Code === '2150').Type, 'liability');
});

let poId;
let poItemIds;

test('a purchase order records what was ordered', async () => {
  const res = await app.post('/api/purchase-orders', {
    supplierId, orderDate: '2026-08-01', expectedDate: '2026-09-15', currency: 'USD', exchangeRate: 305,
    items: [
      { inventoryId: itemA, description: 'R2 hose 1/2"', qty: 100, unitPrice: 280 },
      { inventoryId: itemB, description: 'BSP union 1/2"', qty: 50, unitPrice: 120 },
    ],
  });
  assert.equal(res.status, 200, res.text);
  assert.match(res.body.poNo, /^PO\/\d{4}\/0001$/);
  poId = res.body.poId;

  const detail = await app.get(`/api/purchase-orders/${poId}`);
  assert.equal(detail.body.Total, 34000);   // 28000 + 6000
  assert.equal(detail.body.Status, 'open');
  poItemIds = detail.body.items.map((i) => i.POItemID);
  assert.equal(detail.body.match[0].match.status, 'part-received');
});

test('an order with no lines is refused', async () => {
  const res = await app.post('/api/purchase-orders', { supplierId, orderDate: '2026-08-01', items: [] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least one line/);
});

let grnId;

test('receiving goods spreads landed cost, raises stock and posts to the ledger', async () => {
  const stockBefore = balanceOf('1300');

  const res = await app.post('/api/goods-receipts', {
    poId, supplierId, receiptDate: '2026-09-10',
    items: [
      { poItemId: poItemIds[0], inventoryId: itemA, qty: 100, unitPrice: 280 },
      { poItemId: poItemIds[1], inventoryId: itemB, qty: 50, unitPrice: 120 },
    ],
    // 28000 + 6000 = 34000 of goods; 3400 of duty and freight by value.
    landedCosts: [
      { costType: 'duty', amount: 2400, allocation: 'value' },
      { costType: 'freight', amount: 1000, allocation: 'value' },
    ],
  });
  assert.equal(res.status, 200, res.text);
  grnId = res.body.grnId;
  assert.match(res.body.grnNo, /^GRN\/\d{4}\/0001$/);

  const alloc = res.body.allocation;
  assert.equal(alloc.totalBase, 34000);
  assert.equal(alloc.totalAllocated, 3400, 'every rupee of duty and freight must land somewhere');
  assert.equal(alloc.totalLanded, 37400);

  // Stock went up at LANDED cost, weighted against what was already there.
  const a = db.prepare('SELECT Qty, Cost FROM Inventory WHERE InventoryID = ?').get(itemA);
  assert.equal(a.Qty, 110);
  // 10 @ 300 + 100 @ 308 = 33800 over 110 = 307.27
  assert.equal(a.Cost, 307.27);

  const b = db.prepare('SELECT Qty, Cost FROM Inventory WHERE InventoryID = ?').get(itemB);
  assert.equal(b.Qty, 50);
  assert.equal(b.Cost, 132, 'an empty item takes the landed cost directly');

  // Ledger: stock up by the landed total, split between GRNI and payables.
  assert.equal(balanceOf('1300'), stockBefore + 37400);
  assert.equal(balanceOf('2150'), -34000, 'goods sit in GRNI until invoiced');
  assert.equal(balanceOf('2100'), -3400, 'freight and duty are owed to whoever carried them');
  assert.ok(trialBalanced());
});

test('the receipt left a stock movement for the audit trail', () => {
  const moves = db.prepare("SELECT * FROM StockMovements WHERE MovementType = 'IN' ORDER BY MovementID DESC LIMIT 2").all();
  assert.equal(moves.length, 2);
  assert.match(moves[0].Notes, /Goods receipt GRN/);
  assert.equal(moves.find((m) => m.InventoryID === itemA).NewQty, 110);
});

test('the order closes once everything on it has arrived', async () => {
  const po = await app.get(`/api/purchase-orders/${poId}`);
  assert.equal(po.body.Status, 'received');
  po.body.match.forEach((m) => assert.equal(m.match.status, 'under-billed', 'received but not yet invoiced'));
});

test('an uninvoiced receipt shows up as what GRNI is made of', async () => {
  const res = await app.get('/api/goods-receipts/open/uninvoiced');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].ReceiptValue, 34000);
});

let billId;

test('the supplier bill clears GRNI and raises the payable', async () => {
  const grn = await app.get(`/api/goods-receipts/${grnId}`);
  const grnItems = grn.body.items;

  const res = await app.post('/api/purchase-bills', {
    supplierId, grnId, supplierBillNo: 'HS25E1112W1', billDate: '2026-09-20', dueDate: '2026-10-20',
    items: grnItems.map((g) => ({ grnItemId: g.GRNItemID, inventoryId: g.InventoryID, qty: g.Qty, unitPrice: g.UnitPrice })),
  });
  assert.equal(res.status, 200, res.text);
  billId = res.body.billId;
  assert.equal(res.body.subtotal, 34000);
  assert.equal(res.body.variance, 0);

  assert.equal(balanceOf('2150'), 0, 'GRNI is cleared once the invoice arrives');
  assert.equal(balanceOf('2100'), -(3400 + 34000));
  assert.ok(trialBalanced());
});

test('billing more than the receipt was valued at becomes a price variance', async () => {
  // A second small receipt, then a bill for more than it.
  const grn = await app.post('/api/goods-receipts', {
    supplierId, receiptDate: '2026-09-25',
    items: [{ inventoryId: itemB, qty: 10, unitPrice: 100 }],
  });
  const detail = await app.get(`/api/goods-receipts/${grn.body.grnId}`);
  const line = detail.body.items[0];

  const bill = await app.post('/api/purchase-bills', {
    supplierId, grnId: grn.body.grnId, billDate: '2026-09-26',
    items: [{ grnItemId: line.GRNItemID, inventoryId: itemB, qty: 10, unitPrice: 130 }],
  });
  assert.equal(bill.status, 200, bill.text);
  assert.equal(bill.body.variance, 300, '10 x 30 more than the receipt');
  assert.equal(balanceOf('5910'), 300, 'the difference is a variance, not buried in stock');
  assert.ok(trialBalanced());
});

test('paying a supplier moves the payable into cash', async () => {
  const apBefore = balanceOf('2100');
  const res = await app.post('/api/supplier-payments', {
    supplierId, billId, amount: 20000, paymentDate: '2026-10-05', method: 'Bank Transfer',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(balanceOf('2100'), apBefore + 20000);
  assert.equal(balanceOf('1120'), -20000, 'paid from the bank, not the till');
  assert.ok(trialBalanced());

  const bill = db.prepare('SELECT AmountPaid, Status FROM PurchaseBills WHERE BillID = ?').get(billId);
  assert.equal(bill.AmountPaid, 20000);
  assert.equal(bill.Status, 'posted', 'still part-paid');
});

test('overpaying a bill is refused', async () => {
  const res = await app.post('/api/supplier-payments', {
    supplierId, billId, amount: 999999, paymentDate: '2026-10-06', method: 'Cash',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /exceeds the outstanding/);
});

test('settling the balance marks the bill paid', async () => {
  const outstanding = db.prepare('SELECT ROUND(Total - AmountPaid, 2) AS v FROM PurchaseBills WHERE BillID = ?').get(billId).v;
  const res = await app.post('/api/supplier-payments', {
    supplierId, billId, amount: outstanding, paymentDate: '2026-10-10', method: 'Cash',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(db.prepare('SELECT Status FROM PurchaseBills WHERE BillID = ?').get(billId).Status, 'paid');
});

test('payables ageing buckets what is still owed', async () => {
  const res = await app.get('/api/payables/ageing?asAt=2026-11-30');
  assert.equal(res.status, 200);
  assert.ok(res.body.buckets.total > 0, 'the second bill is still outstanding');
  const sum = ['current', 'd30', 'd60', 'd90', 'older'].reduce((a, k) => a + res.body.buckets[k], 0);
  assert.equal(Math.round(sum * 100) / 100, res.body.buckets.total, 'the buckets must sum to the total');
});

test('the books still balance after the whole cycle', async () => {
  const tb = await app.get('/api/ledger/trial-balance');
  assert.equal(tb.body.totals.balanced, true);
  const bs = await app.get('/api/ledger/balance-sheet');
  assert.equal(bs.body.balanced, true, `off by ${bs.body.difference}`);
});

test('procurement writes are audited', () => {
  const rows = db.prepare(
    "SELECT DISTINCT Entity FROM AuditLog WHERE Entity IN ('purchase-order','goods-receipt','purchase-bill','supplier-payment')"
  ).all().map((r) => r.Entity);
  ['purchase-order', 'goods-receipt', 'purchase-bill', 'supplier-payment']
    .forEach((e) => assert.ok(rows.includes(e), `${e} was not audited`));
});
