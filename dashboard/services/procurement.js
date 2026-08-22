'use strict';

/**
 * Procurement: Purchase Order → Goods Receipt → Purchase Bill → Payment.
 *
 * The receipt is where the real work happens. Posting one does three things that
 * must either all happen or none of them:
 *
 *   1. spreads freight/duty/clearing across the lines (lib/costing.js),
 *   2. raises stock and re-averages each item's cost,
 *   3. posts Dr Inventory / Cr Goods Received Not Invoiced.
 *
 * They run inside one database transaction, so a receipt cannot leave stock up
 * but the ledger untouched — the failure mode that makes stock and books
 * disagree for months before anyone notices.
 *
 * GRNI is the accrual between goods arriving and the invoice arriving. Its
 * balance is a live to-do list: whatever sits in it is stock you hold but have
 * not been billed for.
 */

const connection = require('../db');
const money = require('../lib/money');
const costing = require('../lib/costing');
const ledgerSvc = require('./ledger');
const { ACC } = require('./glPosting');

const GRNI = '2150';
const PPV = '5910';

class ProcurementError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ProcurementError';
    this.httpStatus = status;
  }
}

/** Next document number for a prefix, e.g. PO/2026/0007. */
function nextDocNo(prefix, table, column) {
  const year = new Date().getFullYear();
  const like = `${prefix}/${year}/%`;
  const row = connection._db.prepare(
    `SELECT ${column} AS no FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`
  ).get(like);
  let seq = 1;
  if (row) {
    const m = /(\d+)$/.exec(row.no);
    if (m) seq = Number(m[1]) + 1;
  }
  return `${prefix}/${year}/${String(seq).padStart(4, '0')}`;
}

// ------------------------------------------------------------- purchase order

/**
 * @param {object} po { supplierId, orderDate, expectedDate, currency, exchangeRate, notes,
 *   items: [{ inventoryId, description, qty, unitPrice }] }
 */
function createPurchaseOrder(po) {
  const db = connection._db;
  const items = (po.items || []).filter((i) => money.num(i.qty) > 0);
  if (!items.length) throw new ProcurementError('A purchase order needs at least one line with a quantity');
  const orderDate = String(po.orderDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) throw new ProcurementError('A valid order date is required');

  return db.transaction(() => {
    const poNo = nextDocNo('PO', 'PurchaseOrders', 'PONo');
    const info = db.prepare(`INSERT INTO PurchaseOrders
      (PONo, SupplierID, OrderDate, ExpectedDate, Status, Currency, ExchangeRate, Notes, CreatedAt, UpdatedAt)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`)
      .run(poNo, po.supplierId || null, orderDate, po.expectedDate || null,
        po.currency || 'LKR', money.num(po.exchangeRate, 1) || 1, po.notes || null);

    const ins = db.prepare(`INSERT INTO PurchaseOrderItems
      (POID, InventoryID, Description, Qty, UnitPrice) VALUES (?, ?, ?, ?, ?)`);
    for (const i of items) {
      ins.run(info.lastInsertRowid, i.inventoryId || null, i.description || null,
        money.num(i.qty), money.round2(i.unitPrice));
    }
    return { poId: info.lastInsertRowid, poNo };
  })();
}

// -------------------------------------------------------------- goods receipt

/**
 * Receive goods, allocate landed costs, raise stock and post to the ledger.
 *
 * @param {object} grn { poId, supplierId, receiptDate, notes,
 *   items: [{ poItemId, inventoryId, description, qty, unitPrice }],
 *   landedCosts: [{ costType, amount, allocation, supplierId, notes }] }
 */
function receiveGoods(grn) {
  const db = connection._db;
  const items = (grn.items || []).filter((i) => money.num(i.qty) > 0);
  if (!items.length) throw new ProcurementError('A goods receipt needs at least one line with a quantity');
  const receiptDate = String(grn.receiptDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) throw new ProcurementError('A valid receipt date is required');

  const landedCosts = (grn.landedCosts || []).filter((c) => money.num(c.amount) > 0);
  const allocation = costing.allocateLandedCosts(
    items.map((i) => ({ qty: money.num(i.qty), unitPrice: money.num(i.unitPrice) })),
    landedCosts.map((c) => ({ amount: money.num(c.amount), allocation: c.allocation }))
  );

  // Stock movement, cost re-average and the journal all commit together.
  const write = db.transaction(() => {
    const grnNo = nextDocNo('GRN', 'GoodsReceipts', 'GRNNo');
    const head = db.prepare(`INSERT INTO GoodsReceipts
      (GRNNo, POID, SupplierID, ReceiptDate, Status, Notes, CreatedAt)
      VALUES (?, ?, ?, ?, 'posted', ?, datetime('now','localtime'))`)
      .run(grnNo, grn.poId || null, grn.supplierId || null, receiptDate, grn.notes || null);
    const grnId = head.lastInsertRowid;

    const insItem = db.prepare(`INSERT INTO GoodsReceiptItems
      (GRNID, POItemID, InventoryID, Description, Qty, UnitPrice, LandedUnitCost)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insCost = db.prepare(`INSERT INTO LandedCosts
      (GRNID, CostType, Amount, Allocation, SupplierID, Notes, CreatedAt)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))`);
    const bumpPo = db.prepare('UPDATE PurchaseOrderItems SET ReceivedQty = ReceivedQty + ? WHERE POItemID = ?');

    items.forEach((i, idx) => {
      const alloc = allocation.lines[idx];
      insItem.run(grnId, i.poItemId || null, i.inventoryId || null, i.description || null,
        money.num(i.qty), money.round2(i.unitPrice), alloc.landedUnitCost);
      if (i.poItemId) bumpPo.run(money.num(i.qty), i.poItemId);

      if (i.inventoryId) {
        const inv = db.prepare('SELECT InventoryID, Qty, Cost FROM Inventory WHERE InventoryID = ?').get(i.inventoryId);
        if (!inv) throw new ProcurementError(`Inventory item ${i.inventoryId} not found`, 404);

        // Weighted average: the receipt is folded in at its LANDED cost.
        const avg = costing.weightedAverage({
          onHandQty: money.num(inv.Qty), onHandCost: money.num(inv.Cost),
          receiptQty: money.num(i.qty), receiptUnitCost: alloc.landedUnitCost,
        });
        db.prepare("UPDATE Inventory SET Qty = ?, Cost = ?, LastPurchasePrice = ?, LastPurchaseDate = ?, UpdatedAt = datetime('now','localtime') WHERE InventoryID = ?")
          .run(avg.qty, avg.unitCost, money.round2(i.unitPrice), receiptDate, i.inventoryId);

        db.prepare(`INSERT INTO StockMovements
          (InventoryID, InvoiceID, MovementType, QtyChange, PreviousQty, NewQty, MovementDate, Notes)
          VALUES (?, NULL, 'IN', ?, ?, ?, ?, ?)`)
          .run(i.inventoryId, money.num(i.qty), money.num(inv.Qty), avg.qty, receiptDate, `Goods receipt ${grnNo}`);
      }
    });

    for (const c of landedCosts) {
      insCost.run(grnId, c.costType || 'other', money.round2(c.amount),
        String(c.allocation || 'value').toLowerCase() === 'qty' ? 'qty' : 'value',
        c.supplierId || null, c.notes || null);
    }

    return { grnId, grnNo };
  });

  const { grnId, grnNo } = write();

  // Journal: stock in against the not-yet-invoiced accrual, plus the landed
  // costs which are owed to whoever carried and cleared the goods.
  const lines = [{ accountCode: ACC.STOCK, debit: allocation.totalLanded, memo: `Goods received ${grnNo}` }];
  if (allocation.totalBase > 0) {
    lines.push({ accountCode: GRNI, credit: allocation.totalBase, memo: `Awaiting supplier invoice — ${grnNo}`, supplierId: grn.supplierId || null });
  }
  if (allocation.totalAllocated > 0) {
    lines.push({ accountCode: ACC.AP, credit: allocation.totalAllocated, memo: `Freight, duty and clearing on ${grnNo}` });
  }

  const posting = ledgerSvc.postEntry({
    date: receiptDate,
    memo: `Goods receipt ${grnNo}`,
    sourceType: 'grn', sourceID: grnId,
    postedBy: grn.postedBy,
    lines,
  });

  syncPurchaseOrderStatus(grn.poId);
  return { grnId, grnNo, allocation, posting };
}

/** An order is closed once every line has been received in full. */
function syncPurchaseOrderStatus(poId) {
  if (!poId) return;
  const db = connection._db;
  const open = db.prepare(
    'SELECT COUNT(*) AS c FROM PurchaseOrderItems WHERE POID = ? AND ReceivedQty < Qty'
  ).get(poId).c;
  db.prepare("UPDATE PurchaseOrders SET Status = ?, UpdatedAt = datetime('now','localtime') WHERE POID = ? AND Status <> 'cancelled'")
    .run(open > 0 ? 'open' : 'received', poId);
}

// --------------------------------------------------------------- supplier bill

/**
 * Record a supplier invoice against a receipt.
 *
 * Clears GRNI for what was received. If the bill charges more or less than the
 * receipt was valued at, the difference is a purchase price variance rather than
 * being quietly buried in stock.
 */
function recordBill(bill) {
  const db = connection._db;
  const items = (bill.items || []).filter((i) => money.num(i.qty) > 0);
  const billDate = String(bill.billDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate)) throw new ProcurementError('A valid bill date is required');
  if (!items.length) throw new ProcurementError('A bill needs at least one line with a quantity');

  const subtotal = money.round2(items.reduce((a, i) => a + money.num(i.qty) * money.num(i.unitPrice), 0));
  const tax = money.round2(bill.taxAmount);
  const total = money.round2(subtotal + tax);

  // What the matching receipt put into GRNI, so we can clear exactly that.
  let grnValue = 0;
  if (bill.grnId) {
    grnValue = money.round2(db.prepare(
      'SELECT COALESCE(SUM(Qty * UnitPrice), 0) AS v FROM GoodsReceiptItems WHERE GRNID = ?'
    ).get(bill.grnId).v);
  }

  const write = db.transaction(() => {
    const billNo = nextDocNo('BILL', 'PurchaseBills', 'BillNo');
    const head = db.prepare(`INSERT INTO PurchaseBills
      (BillNo, SupplierBillNo, SupplierID, GRNID, BillDate, DueDate, Status, Subtotal, TaxAmount, Total, AmountPaid, Notes, CreatedAt)
      VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, 0, ?, datetime('now','localtime'))`)
      .run(billNo, bill.supplierBillNo || null, bill.supplierId || null, bill.grnId || null,
        billDate, bill.dueDate || null, subtotal, tax, total, bill.notes || null);
    const billId = head.lastInsertRowid;

    const insItem = db.prepare(`INSERT INTO PurchaseBillItems
      (BillID, GRNItemID, InventoryID, Description, Qty, UnitPrice) VALUES (?, ?, ?, ?, ?, ?)`);
    const bumpPo = db.prepare(`UPDATE PurchaseOrderItems SET BilledQty = BilledQty + ?
      WHERE POItemID = (SELECT POItemID FROM GoodsReceiptItems WHERE GRNItemID = ?)`);
    for (const i of items) {
      insItem.run(billId, i.grnItemId || null, i.inventoryId || null, i.description || null,
        money.num(i.qty), money.round2(i.unitPrice));
      if (i.grnItemId) bumpPo.run(money.num(i.qty), i.grnItemId);
    }
    return { billId, billNo };
  });

  const { billId, billNo } = write();

  const clearing = bill.grnId ? grnValue : subtotal;
  const variance = money.round2(subtotal - clearing);
  const lines = [];
  if (clearing > 0) lines.push({ accountCode: GRNI, debit: clearing, memo: `Invoice received for ${billNo}`, supplierId: bill.supplierId || null });
  if (variance > 0) lines.push({ accountCode: PPV, debit: variance, memo: 'Billed above the receipt value' });
  if (variance < 0) lines.push({ accountCode: PPV, credit: -variance, memo: 'Billed below the receipt value' });
  if (tax > 0) lines.push({ accountCode: ACC.TAX_PAYABLE, debit: tax, memo: 'Input tax' });
  lines.push({ accountCode: ACC.AP, credit: total, memo: `Owed on ${billNo}`, supplierId: bill.supplierId || null });

  const posting = ledgerSvc.postEntry({
    date: billDate,
    memo: `Supplier bill ${billNo}${bill.supplierBillNo ? ` (${bill.supplierBillNo})` : ''}`,
    sourceType: 'bill', sourceID: billId,
    postedBy: bill.postedBy,
    lines,
  });

  return { billId, billNo, subtotal, tax, total, variance, posting };
}

// ------------------------------------------------------------ supplier payment

function paySupplier(payment) {
  const db = connection._db;
  const amount = money.round2(payment.amount);
  if (!(amount > 0)) throw new ProcurementError('Payment amount must be greater than zero');
  const paymentDate = String(payment.paymentDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) throw new ProcurementError('A valid payment date is required');

  let supplierId = payment.supplierId || null;
  if (payment.billId) {
    const bill = db.prepare('SELECT * FROM PurchaseBills WHERE BillID = ?').get(payment.billId);
    if (!bill) throw new ProcurementError(`Bill ${payment.billId} not found`, 404);
    const outstanding = money.round2(bill.Total - bill.AmountPaid);
    if (amount > outstanding + 0.005) {
      throw new ProcurementError(`Payment ${money.formatLKR(amount)} exceeds the outstanding ${money.formatLKR(outstanding)} on ${bill.BillNo}`);
    }
    supplierId = supplierId || bill.SupplierID;
  }

  const write = db.transaction(() => {
    const info = db.prepare(`INSERT INTO SupplierPayments
      (SupplierID, BillID, Amount, PaymentDate, Method, Notes, CreatedAt)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
      .run(supplierId, payment.billId || null, amount, paymentDate, payment.method || 'Cash', payment.notes || null);

    if (payment.billId) {
      // Derived from the payment history, so it cannot drift out of step.
      const paid = money.round2(db.prepare(
        'SELECT COALESCE(SUM(Amount), 0) AS v FROM SupplierPayments WHERE BillID = ?'
      ).get(payment.billId).v);
      const bill = db.prepare('SELECT Total FROM PurchaseBills WHERE BillID = ?').get(payment.billId);
      db.prepare('UPDATE PurchaseBills SET AmountPaid = ?, Status = ? WHERE BillID = ?')
        .run(paid, paid + 0.005 >= money.round2(bill.Total) ? 'paid' : 'posted', payment.billId);
    }
    return info.lastInsertRowid;
  });

  const paymentId = write();
  const cashAccount = /bank|transfer|cheque|card/i.test(payment.method || '') ? ACC.BANK : ACC.CASH;
  const posting = ledgerSvc.postEntry({
    date: paymentDate,
    memo: `Paid supplier${payment.billId ? ` against bill ${payment.billId}` : ''}`,
    sourceType: 'supplier-payment', sourceID: paymentId,
    postedBy: payment.postedBy,
    lines: [
      { accountCode: ACC.AP, debit: amount, supplierId },
      { accountCode: cashAccount, credit: amount, memo: payment.method || 'Cash' },
    ],
  });

  return { paymentId, amount, posting };
}

// ----------------------------------------------------------------- reporting

/** Outstanding supplier balances, bucketed by age from their due date. */
function payablesAgeing(asAt) {
  const ref = String(asAt || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const bills = connection._db.prepare(`
    SELECT b.BillID, b.BillNo, b.SupplierBillNo, b.BillDate, b.DueDate, b.Total, b.AmountPaid,
           s.Name AS SupplierName, s.SupplierID
    FROM PurchaseBills b LEFT JOIN Suppliers s ON s.SupplierID = b.SupplierID
    WHERE ROUND(b.Total - b.AmountPaid, 2) > 0
    ORDER BY COALESCE(b.DueDate, b.BillDate)`).all();

  const rows = bills.map((b) => ({
    ...b,
    Outstanding: money.round2(b.Total - b.AmountPaid),
    Due: b.DueDate || b.BillDate,
  }));
  return {
    asAt: ref,
    bills: rows,
    buckets: costing.ageing(rows.map((r) => ({ date: r.Due, amount: r.Outstanding })), ref),
  };
}

/** Receipts that have not been fully invoiced — what GRNI is made of. */
function openReceipts() {
  return connection._db.prepare(`
    SELECT g.GRNID, g.GRNNo, g.ReceiptDate, s.Name AS SupplierName,
           ROUND(COALESCE(SUM(gi.Qty * gi.UnitPrice), 0), 2) AS ReceiptValue,
           (SELECT COUNT(*) FROM PurchaseBills b WHERE b.GRNID = g.GRNID) AS Bills
    FROM GoodsReceipts g
    LEFT JOIN GoodsReceiptItems gi ON gi.GRNID = g.GRNID
    LEFT JOIN Suppliers s ON s.SupplierID = g.SupplierID
    GROUP BY g.GRNID
    HAVING Bills = 0
    ORDER BY g.ReceiptDate DESC`).all();
}

/** Ordered vs received vs billed, per order line. */
function matchReport(poId) {
  const rows = connection._db.prepare(`
    SELECT p.PONo, i.POItemID, i.Description, inv.ProductName, i.Qty, i.ReceivedQty, i.BilledQty
    FROM PurchaseOrderItems i
    JOIN PurchaseOrders p ON p.POID = i.POID
    LEFT JOIN Inventory inv ON inv.InventoryID = i.InventoryID
    ${poId ? 'WHERE i.POID = ?' : ''}
    ORDER BY p.PONo, i.POItemID`).all(...(poId ? [poId] : []));

  return rows.map((r) => ({
    ...r,
    Description: r.Description || r.ProductName || '',
    match: costing.threeWayMatch(r.Qty, r.ReceivedQty, r.BilledQty),
  }));
}

module.exports = {
  ProcurementError, GRNI, PPV,
  nextDocNo, createPurchaseOrder, receiveGoods, recordBill, paySupplier,
  syncPurchaseOrderStatus, payablesAgeing, openReceipts, matchReport,
};
