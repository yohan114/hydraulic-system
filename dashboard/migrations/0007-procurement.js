'use strict';

/**
 * Procurement and payables: Purchase Order → Goods Receipt → Purchase Bill →
 * Supplier Payment, plus landed-cost allocation.
 *
 * Until now the only money the system tracked was money coming IN. Stock arrived
 * through a single "record purchase" endpoint that set a cost and nothing else —
 * no order, no receipt, no supplier bill, no payable.
 *
 * The accounting shape, and why GRNI exists:
 *
 *   Goods receipt   Dr Inventory      Cr Goods Received Not Invoiced (2150)
 *   Landed cost     Dr Inventory      Cr Accounts Payable
 *   Supplier bill   Dr GRNI           Cr Accounts Payable
 *   Payment         Dr Accounts Payable   Cr Cash / Bank
 *
 * GRNI is the accrual between the van arriving and the invoice arriving. Without
 * it, stock that has been received but not yet billed either sits off the books
 * or overstates payables. Its balance is a live to-do list: anything left in
 * GRNI is stock you have but have not been invoiced for.
 *
 * Landed cost matters specifically for this shop: item costs are already derived
 * as CIF x duty from a shipment spreadsheet. Making that an allocation against a
 * receipt turns a manual calculation into a posting that reconciles.
 */

const ACCOUNTS = [
  ['2150', 'Goods Received Not Invoiced', 'Stock received from a supplier but not yet invoiced'],
  ['5910', 'Purchase Price Variance', 'Difference between what a receipt was valued at and what the bill charged'],
];

module.exports = {
  name: 'procurement and payables',

  up(db) {
    const { typeOfCode } = require('../lib/ledger');
    const insAcct = db.prepare(
      `INSERT OR IGNORE INTO Accounts (Code, Name, Type, Notes, Active, CreatedAt)
       VALUES (?, ?, ?, ?, 1, datetime('now','localtime'))`
    );
    for (const [code, name, notes] of ACCOUNTS) insAcct.run(code, name, typeOfCode(code), notes);

    db.exec(`CREATE TABLE IF NOT EXISTS PurchaseOrders (
      POID         INTEGER PRIMARY KEY,
      PONo         TEXT NOT NULL UNIQUE,
      SupplierID   INTEGER REFERENCES Suppliers(SupplierID),
      OrderDate    TEXT NOT NULL,
      ExpectedDate TEXT,
      Status       TEXT NOT NULL DEFAULT 'open',
      Currency     TEXT NOT NULL DEFAULT 'LKR',
      ExchangeRate REAL NOT NULL DEFAULT 1,
      Notes        TEXT,
      CreatedAt    TEXT,
      UpdatedAt    TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_po_supplier ON PurchaseOrders(SupplierID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_po_status ON PurchaseOrders(Status)');

    db.exec(`CREATE TABLE IF NOT EXISTS PurchaseOrderItems (
      POItemID    INTEGER PRIMARY KEY,
      POID        INTEGER NOT NULL REFERENCES PurchaseOrders(POID) ON DELETE CASCADE,
      InventoryID INTEGER REFERENCES Inventory(InventoryID),
      Description TEXT,
      Qty         REAL NOT NULL DEFAULT 0,
      UnitPrice   REAL NOT NULL DEFAULT 0,
      ReceivedQty REAL NOT NULL DEFAULT 0,
      BilledQty   REAL NOT NULL DEFAULT 0,
      CHECK (Qty >= 0 AND UnitPrice >= 0)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_poi_po ON PurchaseOrderItems(POID)');

    db.exec(`CREATE TABLE IF NOT EXISTS GoodsReceipts (
      GRNID       INTEGER PRIMARY KEY,
      GRNNo       TEXT NOT NULL UNIQUE,
      POID        INTEGER REFERENCES PurchaseOrders(POID),
      SupplierID  INTEGER REFERENCES Suppliers(SupplierID),
      ReceiptDate TEXT NOT NULL,
      Status      TEXT NOT NULL DEFAULT 'posted',
      Notes       TEXT,
      CreatedAt   TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_grn_po ON GoodsReceipts(POID)');

    db.exec(`CREATE TABLE IF NOT EXISTS GoodsReceiptItems (
      GRNItemID   INTEGER PRIMARY KEY,
      GRNID       INTEGER NOT NULL REFERENCES GoodsReceipts(GRNID) ON DELETE CASCADE,
      POItemID    INTEGER REFERENCES PurchaseOrderItems(POItemID),
      InventoryID INTEGER REFERENCES Inventory(InventoryID),
      Description TEXT,
      Qty         REAL NOT NULL DEFAULT 0,
      UnitPrice   REAL NOT NULL DEFAULT 0,
      -- Unit cost after freight/duty was spread over the receipt. This is what
      -- the stock is actually valued at.
      LandedUnitCost REAL,
      CHECK (Qty >= 0)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_grni_grn ON GoodsReceiptItems(GRNID)');

    db.exec(`CREATE TABLE IF NOT EXISTS LandedCosts (
      LandedCostID INTEGER PRIMARY KEY,
      GRNID        INTEGER NOT NULL REFERENCES GoodsReceipts(GRNID) ON DELETE CASCADE,
      CostType     TEXT NOT NULL,
      Amount       REAL NOT NULL DEFAULT 0,
      Allocation   TEXT NOT NULL DEFAULT 'value',
      SupplierID   INTEGER REFERENCES Suppliers(SupplierID),
      Notes        TEXT,
      CreatedAt    TEXT,
      CHECK (Amount >= 0)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_lc_grn ON LandedCosts(GRNID)');

    db.exec(`CREATE TABLE IF NOT EXISTS PurchaseBills (
      BillID         INTEGER PRIMARY KEY,
      BillNo         TEXT NOT NULL UNIQUE,
      SupplierBillNo TEXT,
      SupplierID     INTEGER REFERENCES Suppliers(SupplierID),
      GRNID          INTEGER REFERENCES GoodsReceipts(GRNID),
      BillDate       TEXT NOT NULL,
      DueDate        TEXT,
      Status         TEXT NOT NULL DEFAULT 'posted',
      Subtotal       REAL NOT NULL DEFAULT 0,
      TaxAmount      REAL NOT NULL DEFAULT 0,
      Total          REAL NOT NULL DEFAULT 0,
      AmountPaid     REAL NOT NULL DEFAULT 0,
      Notes          TEXT,
      CreatedAt      TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_bill_supplier ON PurchaseBills(SupplierID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_bill_grn ON PurchaseBills(GRNID)');

    db.exec(`CREATE TABLE IF NOT EXISTS PurchaseBillItems (
      BillItemID  INTEGER PRIMARY KEY,
      BillID      INTEGER NOT NULL REFERENCES PurchaseBills(BillID) ON DELETE CASCADE,
      GRNItemID   INTEGER REFERENCES GoodsReceiptItems(GRNItemID),
      InventoryID INTEGER REFERENCES Inventory(InventoryID),
      Description TEXT,
      Qty         REAL NOT NULL DEFAULT 0,
      UnitPrice   REAL NOT NULL DEFAULT 0
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_bi_bill ON PurchaseBillItems(BillID)');

    db.exec(`CREATE TABLE IF NOT EXISTS SupplierPayments (
      SPaymentID  INTEGER PRIMARY KEY,
      SupplierID  INTEGER REFERENCES Suppliers(SupplierID),
      BillID      INTEGER REFERENCES PurchaseBills(BillID),
      Amount      REAL NOT NULL DEFAULT 0,
      PaymentDate TEXT NOT NULL,
      Method      TEXT,
      Notes       TEXT,
      CreatedAt   TEXT,
      CHECK (Amount > 0)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sp_supplier ON SupplierPayments(SupplierID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sp_bill ON SupplierPayments(BillID)');
  },

  down(db) {
    ['SupplierPayments', 'PurchaseBillItems', 'PurchaseBills', 'LandedCosts',
      'GoodsReceiptItems', 'GoodsReceipts', 'PurchaseOrderItems', 'PurchaseOrders']
      .forEach((t) => db.exec(`DROP TABLE IF EXISTS ${t}`));
    db.exec("DELETE FROM Accounts WHERE Code IN ('2150', '5910')");
  },
};
