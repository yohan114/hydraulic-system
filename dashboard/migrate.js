'use strict';

/**
 * SQLite schema bootstrap + Rate Card seed (idempotent).
 *
 * Creates any missing tables/columns/indexes on `hydraulic.db` and seeds the
 * Rate Card. Safe to run repeatedly — the server calls {@link ensureSchema} on
 * boot, and it can be run standalone:  node migrate.js   (or: npm run migrate)
 *
 * (Replaces the old Access DDL migration; the schema now lives here as plain
 *  SQLite `CREATE TABLE IF NOT EXISTS`.)
 */

const connection = require('./db');
const { RATECARD_SEED } = require('./lib/ratecardSeed');
const { lineSnapshot } = require('./services/priceAnalysis');

const TABLES = {
  Inventory: `CREATE TABLE IF NOT EXISTS Inventory (
    InventoryID INTEGER PRIMARY KEY, UniqueID TEXT, ProductName TEXT, SpecificationCode TEXT,
    Size TEXT, Description TEXT, Length REAL, Qty REAL, Unit TEXT, CreatedAt TEXT, UpdatedAt TEXT,
    Price REAL, Cost REAL, MarketMid REAL,
    SupplierID INTEGER, LastPurchasePrice REAL, LastPurchaseDate TEXT, ReorderLevel REAL)`,
  Invoices: `CREATE TABLE IF NOT EXISTS Invoices (
    InvoiceID INTEGER PRIMARY KEY, InvoiceNo TEXT, InvoiceDate TEXT, PONo TEXT, PODate TEXT, DeliveryDate TEXT,
    BilledToName TEXT, BilledToAddress TEXT, DeliveredToName TEXT, DeliveredToAddress TEXT,
    SubTotal REAL, SSCLRate REAL, SSCLAmount REAL, VATRate REAL, VATAmount REAL, GrandTotal REAL,
    Status TEXT, CreatedAt TEXT, FinalizedAt TEXT, Discount REAL, RoundOff REAL, AmountPaid REAL,
    PaymentStatus TEXT, CancelledAt TEXT, CancelReason TEXT)`,
  InvoiceItems: `CREATE TABLE IF NOT EXISTS InvoiceItems (
    InvoiceItemID INTEGER PRIMARY KEY, InvoiceID INTEGER, InventoryID INTEGER, ItemDescription TEXT,
    Unit TEXT, Length REAL, Qty REAL, Rate REAL, Amount REAL,
    UnitCostAtBilling REAL, OurBillRate REAL, MarketBillRate REAL,
    ProfitAmount REAL, MarginPercent REAL, MarketGap REAL, PriceFlag TEXT)`,
  StockMovements: `CREATE TABLE IF NOT EXISTS StockMovements (
    MovementID INTEGER PRIMARY KEY, InventoryID INTEGER, InvoiceID INTEGER, MovementType TEXT,
    QtyChange REAL, PreviousQty REAL, NewQty REAL, MovementDate TEXT, Notes TEXT)`,
  Payments: `CREATE TABLE IF NOT EXISTS Payments (
    PaymentID INTEGER PRIMARY KEY, InvoiceID INTEGER, Amount REAL, PaymentDate TEXT, Method TEXT, Notes TEXT, CreatedAt TEXT)`,
  Users: `CREATE TABLE IF NOT EXISTS Users (
    UserID INTEGER PRIMARY KEY, Username TEXT UNIQUE, PasswordHash TEXT, Role TEXT, CreatedAt TEXT, UpdatedAt TEXT)`,
  RateCard: `CREATE TABLE IF NOT EXISTS RateCard (
    RateID INTEGER PRIMARY KEY, Spec TEXT, SizeCode TEXT, SizeInch REAL, Label TEXT, Unit TEXT,
    OurCost REAL, OurPrice REAL, OutsidePrice REAL, UpdatedAt TEXT, Category TEXT,
    OutsideLow REAL, OutsideMid REAL, OutsideHigh REAL)`,
  Workers: `CREATE TABLE IF NOT EXISTS Workers (
    WorkerID INTEGER PRIMARY KEY, Name TEXT, Role TEXT, Active INTEGER, CreatedAt TEXT)`,
  LabourPayments: `CREATE TABLE IF NOT EXISTS LabourPayments (
    LabourPaymentID INTEGER PRIMARY KEY, WorkerID INTEGER, Amount REAL, PayPeriod TEXT, PaymentDate TEXT, Method TEXT, Notes TEXT, CreatedAt TEXT)`,
  Expenses: `CREATE TABLE IF NOT EXISTS Expenses (
    ExpenseID INTEGER PRIMARY KEY, Category TEXT, Amount REAL, ExpenseDate TEXT, Method TEXT, Notes TEXT, CreatedAt TEXT)`,
  Suppliers: `CREATE TABLE IF NOT EXISTS Suppliers (
    SupplierID INTEGER PRIMARY KEY, Name TEXT, ContactPerson TEXT, Phone TEXT, Email TEXT, Address TEXT,
    Notes TEXT, Active INTEGER, CreatedAt TEXT, UpdatedAt TEXT)`,
  Purchases: `CREATE TABLE IF NOT EXISTS Purchases (
    PurchaseID INTEGER PRIMARY KEY, InventoryID INTEGER, SupplierID INTEGER, Qty REAL, UnitPrice REAL,
    PurchaseDate TEXT, Notes TEXT, CreatedAt TEXT)`,
};

// Columns that may be absent on a database created by an earlier build — added
// if missing so schema evolution stays automatic.
const COLUMN_ENSURES = {
  Inventory: {
    Price: 'REAL', Cost: 'REAL', MarketMid: 'REAL',
    // Supplier link + last-purchase tracking (cost accuracy) + per-item reorder threshold.
    SupplierID: 'INTEGER', LastPurchasePrice: 'REAL', LastPurchaseDate: 'TEXT', ReorderLevel: 'REAL',
  },
  Invoices: { Discount: 'REAL', RoundOff: 'REAL', AmountPaid: 'REAL', PaymentStatus: 'TEXT', CancelledAt: 'TEXT', CancelReason: 'TEXT',
    // Whether this job's technical/crimping (labour) charge has been paid out to the worker.
    TechChargePaid: 'INTEGER' },
  RateCard: { Category: 'TEXT', OutsideLow: 'REAL', OutsideMid: 'REAL', OutsideHigh: 'REAL' },
  Users: { Role: 'TEXT' },
  // Cost-vs-bill-vs-market snapshot captured per line at billing time.
  InvoiceItems: {
    UnitCostAtBilling: 'REAL', OurBillRate: 'REAL', MarketBillRate: 'REAL',
    ProfitAmount: 'REAL', MarginPercent: 'REAL', MarketGap: 'REAL', PriceFlag: 'TEXT',
  },
};

const INDEXES = [
  // Unique invoice number makes a duplicate fail loudly at insert time.
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_Invoices_InvoiceNo ON Invoices(InvoiceNo)',
  'CREATE INDEX IF NOT EXISTS idx_inv_status ON Invoices(Status)',
  'CREATE INDEX IF NOT EXISTS idx_inv_finalizedat ON Invoices(FinalizedAt)',
  'CREATE INDEX IF NOT EXISTS idx_inv_date ON Invoices(InvoiceDate)',
  'CREATE INDEX IF NOT EXISTS idx_ii_invoice ON InvoiceItems(InvoiceID)',
  'CREATE INDEX IF NOT EXISTS idx_ii_inventory ON InvoiceItems(InventoryID)',
  'CREATE INDEX IF NOT EXISTS idx_sm_inventory ON StockMovements(InventoryID)',
  'CREATE INDEX IF NOT EXISTS idx_pay_invoice ON Payments(InvoiceID)',
  'CREATE INDEX IF NOT EXISTS idx_inv_supplier ON Inventory(SupplierID)',
  'CREATE INDEX IF NOT EXISTS idx_pur_inventory ON Purchases(InventoryID)',
  'CREATE INDEX IF NOT EXISTS idx_pur_supplier ON Purchases(SupplierID)',
];

/**
 * Apply the schema against the (better-sqlite3) connection from lib/db.js.
 * @param {{_db: import('better-sqlite3').Database}} conn
 * @returns {Promise<{applied:string[], skipped:string[], failed:Array<{name:string,error:string}>}>}
 */
async function ensureSchema(conn) {
  const applied = [];
  const skipped = [];
  const failed = [];
  const db = conn._db;

  for (const [name, ddl] of Object.entries(TABLES)) {
    try { db.exec(ddl); applied.push(name); } catch (e) { failed.push({ name, error: e.message }); }
  }

  for (const [table, cols] of Object.entries(COLUMN_ENSURES)) {
    let existing;
    try { existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)); }
    catch (_) { existing = new Set(); }
    for (const [col, type] of Object.entries(cols)) {
      if (existing.has(col)) { skipped.push(`${table}.${col}`); continue; }
      try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); applied.push(`${table}.${col}`); }
      catch (e) { failed.push({ name: `${table}.${col}`, error: e.message }); }
    }
  }

  for (const ddl of INDEXES) { try { db.exec(ddl); } catch (_) { /* legacy dup data */ } }

  const backfills = [
    'UPDATE Invoices SET AmountPaid = 0 WHERE AmountPaid IS NULL',
    'UPDATE Invoices SET Discount = 0 WHERE Discount IS NULL',
    'UPDATE Invoices SET RoundOff = 0 WHERE RoundOff IS NULL',
    'UPDATE Inventory SET Cost = 0 WHERE Cost IS NULL',
    'UPDATE Inventory SET MarketMid = 0 WHERE MarketMid IS NULL',
    // Default reorder threshold matches the old hard-coded low-stock rule (Qty <= 5).
    'UPDATE Inventory SET ReorderLevel = 5 WHERE ReorderLevel IS NULL',
    // Any pre-roles user rows are administrators (there was only ever one admin).
    "UPDATE Users SET Role = 'admin' WHERE Role IS NULL OR Role = ''",
    'UPDATE Invoices SET TechChargePaid = 0 WHERE TechChargePaid IS NULL',
  ];
  for (const s of backfills) { try { db.exec(s); } catch (_) {} }

  // Seed the Rate Card when empty, or when it only holds legacy rows (no Category).
  try {
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM RateCard').get().c;
    let doSeed = cnt === 0;
    if (!doSeed) {
      const cat = db.prepare('SELECT COUNT(*) AS c FROM RateCard WHERE Category IS NOT NULL').get().c;
      if (cat === 0) { db.exec('DELETE FROM RateCard'); doSeed = true; }
    }
    if (doSeed) {
      const ins = db.prepare(
        `INSERT INTO RateCard (Category, Spec, SizeCode, SizeInch, Label, Unit, OurCost, OurPrice, OutsideLow, OutsideMid, OutsideHigh, OutsidePrice, UpdatedAt)
         VALUES (@category, @spec, @sizeCode, @sizeInch, @label, @unit, @ourCost, @ourPrice, @outsideLow, @outsideMid, @outsideHigh, @outsideMid, datetime('now','localtime'))`
      );
      const seed = db.transaction((rows) => { for (const r of rows) ins.run(r); });
      seed(RATECARD_SEED);
      applied.push(`RateCard seed (${RATECARD_SEED.length} rows)`);
    }
  } catch (e) { failed.push({ name: 'RateCard seed', error: e.message }); }

  // Backfill the bill-comparison snapshot for lines written before it existed.
  // Best effort: no historical prices are kept, so the item's CURRENT cost/market
  // is used. New invoices snapshot the real values at billing time.
  try {
    const legacy = db.prepare(`
      SELECT ii.InvoiceItemID, ii.Qty, ii.Rate, inv.Cost, inv.MarketMid
      FROM InvoiceItems ii LEFT JOIN Inventory inv ON ii.InventoryID = inv.InventoryID
      WHERE ii.UnitCostAtBilling IS NULL`).all();
    if (legacy.length) {
      const upd = db.prepare(`UPDATE InvoiceItems SET
        UnitCostAtBilling=@unitCost, OurBillRate=@ourRate, MarketBillRate=@market,
        ProfitAmount=@profit, MarginPercent=@margin, MarketGap=@gap, PriceFlag=@flag
        WHERE InvoiceItemID=@id`);
      const tx = db.transaction((rowsIn) => {
        for (const r of rowsIn) {
          const s = lineSnapshot({ unitCost: r.Cost, ourRate: r.Rate, marketRate: r.MarketMid, qty: r.Qty });
          upd.run({
            id: r.InvoiceItemID, unitCost: s.unitCostAtBilling, ourRate: s.ourBillRate, market: s.marketBillRate,
            profit: s.profitAmount, margin: s.marginPercent, gap: s.marketGap, flag: s.priceFlag,
          });
        }
      });
      tx(legacy);
      applied.push(`bill snapshot backfill (${legacy.length} lines)`);
    }
  } catch (e) { failed.push({ name: 'bill snapshot backfill', error: e.message }); }

  return { applied, skipped, failed };
}

async function main() {
  console.log('Running SQLite schema bootstrap...');
  const summary = await ensureSchema(connection);
  if (summary.applied.length) console.log('Applied:', summary.applied.join(', '));
  if (summary.skipped.length) console.log('Already present:', summary.skipped.join(', '));
  if (summary.failed.length) {
    console.error('Failed:');
    summary.failed.forEach((f) => console.error(`  - ${f.name}: ${f.error}`));
    process.exitCode = 1;
  }
  console.log('Done.');
}

module.exports = { ensureSchema };

if (require.main === module) {
  main().catch((err) => { console.error('Migration error:', err.message); process.exit(1); });
}
