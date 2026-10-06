'use strict';

/**
 * Controls: fixed assets, stock takes, tax codes, and the accounts they need.
 *
 * Three gaps this closes:
 *
 *  1. FIXED ASSETS. The crimping machine's amortisation is a hardcoded constant
 *     inside lib/ratecardSeed.js, so the charge never reaches the books and
 *     never stops once the machine is written down. Depreciation now posts.
 *
 *  2. STOCK TAKES. There is Rs 2.8m of stock on the shelf and no way to record a
 *     physical count against it. A take now posts its variance to Stock
 *     Adjustments rather than someone quietly editing a quantity.
 *
 *  3. TAX CODES. Deliberately minimal — the shop stopped charging SSCL/VAT, so
 *     this is a master and a report, not a module. It exists so that the day tax
 *     comes back there is somewhere for it to go.
 */

const ACCOUNTS = [
  ['1510', 'Plant & Machinery', 'Crimping machine, presses and workshop equipment at cost'],
  ['1590', 'Accumulated Depreciation', 'Contra-asset: what has been written off the plant so far'],
  ['6400', 'Depreciation', 'The periodic charge for wear on plant and machinery'],
];

module.exports = {
  name: 'fixed assets, stock takes and tax codes',

  up(db) {
    const { typeOfCode } = require('../lib/ledger');
    const insAcct = db.prepare(
      `INSERT OR IGNORE INTO Accounts (Code, Name, Type, Notes, Active, CreatedAt)
       VALUES (?, ?, ?, ?, 1, datetime('now','localtime'))`
    );
    for (const [code, name, notes] of ACCOUNTS) insAcct.run(code, name, typeOfCode(code), notes);

    db.exec(`CREATE TABLE IF NOT EXISTS FixedAssets (
      AssetID       INTEGER PRIMARY KEY,
      Code          TEXT UNIQUE,
      Name          TEXT NOT NULL,
      Category      TEXT,
      SupplierID    INTEGER REFERENCES Suppliers(SupplierID),
      PurchaseDate  TEXT,
      InServiceFrom TEXT NOT NULL,
      Cost          REAL NOT NULL DEFAULT 0,
      Residual      REAL NOT NULL DEFAULT 0,
      LifeMonths    INTEGER NOT NULL DEFAULT 0,
      Method        TEXT NOT NULL DEFAULT 'straight-line',
      Accumulated   REAL NOT NULL DEFAULT 0,
      Status        TEXT NOT NULL DEFAULT 'active',
      DisposedAt    TEXT,
      Notes         TEXT,
      CreatedAt     TEXT,
      UpdatedAt     TEXT,
      CHECK (Cost >= 0 AND Residual >= 0 AND LifeMonths >= 0)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_asset_status ON FixedAssets(Status)');

    // One row per asset per period actually charged. The UNIQUE constraint is
    // what stops a depreciation run being applied to the same month twice.
    db.exec(`CREATE TABLE IF NOT EXISTS DepreciationEntries (
      DepreciationID INTEGER PRIMARY KEY,
      AssetID        INTEGER NOT NULL REFERENCES FixedAssets(AssetID) ON DELETE CASCADE,
      Period         TEXT NOT NULL,
      Charge         REAL NOT NULL DEFAULT 0,
      AccumulatedAfter REAL NOT NULL DEFAULT 0,
      JournalID      INTEGER REFERENCES JournalEntries(JournalID),
      CreatedAt      TEXT,
      UNIQUE (AssetID, Period)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_dep_period ON DepreciationEntries(Period)');

    db.exec(`CREATE TABLE IF NOT EXISTS StockTakes (
      StockTakeID INTEGER PRIMARY KEY,
      TakeNo      TEXT NOT NULL UNIQUE,
      TakeDate    TEXT NOT NULL,
      Status      TEXT NOT NULL DEFAULT 'draft',
      CountedBy   TEXT,
      Notes       TEXT,
      JournalID   INTEGER REFERENCES JournalEntries(JournalID),
      CreatedAt   TEXT,
      PostedAt    TEXT
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS StockTakeItems (
      StockTakeItemID INTEGER PRIMARY KEY,
      StockTakeID INTEGER NOT NULL REFERENCES StockTakes(StockTakeID) ON DELETE CASCADE,
      InventoryID INTEGER NOT NULL REFERENCES Inventory(InventoryID),
      SystemQty   REAL NOT NULL DEFAULT 0,
      CountedQty  REAL NOT NULL DEFAULT 0,
      Cost        REAL NOT NULL DEFAULT 0,
      Notes       TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sti_take ON StockTakeItems(StockTakeID)');

    db.exec(`CREATE TABLE IF NOT EXISTS TaxCodes (
      TaxCodeID INTEGER PRIMARY KEY,
      Code      TEXT NOT NULL UNIQUE,
      Name      TEXT NOT NULL,
      Rate      REAL NOT NULL DEFAULT 0,
      AccountCode TEXT,
      Active    INTEGER NOT NULL DEFAULT 1,
      CreatedAt TEXT
    )`);

    // The two the shop used to charge, seeded inactive: they are history, and
    // they are what the May invoices carry.
    const insTax = db.prepare(
      `INSERT OR IGNORE INTO TaxCodes (Code, Name, Rate, AccountCode, Active, CreatedAt)
       VALUES (?, ?, ?, '2300', 0, datetime('now','localtime'))`
    );
    insTax.run('SSCL', 'Social Security Contribution Levy', 2.5);
    insTax.run('VAT', 'Value Added Tax', 18);
  },

  down(db) {
    ['StockTakeItems', 'StockTakes', 'DepreciationEntries', 'FixedAssets', 'TaxCodes']
      .forEach((t) => db.exec(`DROP TABLE IF EXISTS ${t}`));
    db.exec("DELETE FROM Accounts WHERE Code IN ('1510', '1590', '6400')");
  },
};
