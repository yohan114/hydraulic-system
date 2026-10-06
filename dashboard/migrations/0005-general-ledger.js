'use strict';

/**
 * The General Ledger: chart of accounts, journals, and accounting periods.
 *
 * Until now every financial figure was re-derived by scanning Invoices and
 * Expenses on each request, so nothing reconciled and nothing was auditable.
 * From here, money events post balanced journal entries and the reports read
 * the ledger.
 *
 * Design notes:
 *  - Account codes carry their type in the first digit (see lib/ledger.js), so
 *    a code is enough to know whether a balance is debit- or credit-positive.
 *  - `JournalLines` stores debit and credit as separate non-negative columns
 *    rather than one signed amount. It is the convention every accountant reads
 *    without translation, and a CHECK stops a line being both.
 *  - `Periods` lets a month be closed. Posting into a closed period is refused
 *    by the posting service, which is what stops last quarter quietly moving.
 *  - The chart below is deliberately small. Accounts for procurement (GRNI,
 *    payables) and fixed assets arrive with the phases that use them.
 */

const ACCOUNTS = [
  // --- assets ---
  ['1110', 'Cash in Hand', null],
  ['1120', 'Bank', null],
  ['1200', 'Accounts Receivable', 'What external customers owe us'],
  ['1300', 'Inventory / Stock', 'Hose, fittings and consumables on the shelf, at landed cost'],

  // --- liabilities ---
  ['2100', 'Accounts Payable', 'What we owe suppliers'],
  ['2200', 'Accrued Technical Labour', 'Crimping and technical charges earned by the worker but not yet paid out'],
  ['2300', 'Taxes Payable', 'SSCL / VAT collected on behalf of the state'],

  // --- equity ---
  ['3100', "Owner's Capital", null],
  ['3200', 'Retained Earnings', null],
  ['3900', 'Opening Balance Equity', 'Balancing account for balances brought in when the ledger was opened'],

  // --- income ---
  ['4100', 'Sales — Parts', null],
  ['4200', 'Sales — Technical & Crimping', null],

  // --- cost of sales ---
  ['5100', 'Cost of Sales — Parts', null],
  ['5200', 'Cost of Sales — Technical Labour', null],
  ['5900', 'Stock Adjustments', 'Write-offs, stock-take differences'],

  // --- expenses ---
  ['6100', 'Wages & Labour Paid', null],
  ['6200', 'Electricity & Sundry', null],
  ['6300', 'Other Operating Expenses', null],
  ['6900', 'Internal Repairs & Maintenance', "Work done on the shop's own plant — a cost of running the workshop, not a sale"],
];

module.exports = {
  name: 'general ledger',

  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS Accounts (
      AccountID INTEGER PRIMARY KEY,
      Code      TEXT NOT NULL UNIQUE,
      Name      TEXT NOT NULL,
      Type      TEXT NOT NULL,
      Notes     TEXT,
      Active    INTEGER NOT NULL DEFAULT 1,
      CreatedAt TEXT
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS JournalEntries (
      JournalID  INTEGER PRIMARY KEY,
      EntryNo    TEXT NOT NULL UNIQUE,
      EntryDate  TEXT NOT NULL,
      Period     TEXT NOT NULL,
      Memo       TEXT,
      SourceType TEXT,
      SourceID   TEXT,
      PostedAt   TEXT NOT NULL,
      PostedBy   TEXT,
      ReversalOf INTEGER REFERENCES JournalEntries(JournalID)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_je_date ON JournalEntries(EntryDate)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_je_period ON JournalEntries(Period)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_je_source ON JournalEntries(SourceType, SourceID)');

    db.exec(`CREATE TABLE IF NOT EXISTS JournalLines (
      LineID     INTEGER PRIMARY KEY,
      JournalID  INTEGER NOT NULL REFERENCES JournalEntries(JournalID) ON DELETE CASCADE,
      AccountID  INTEGER NOT NULL REFERENCES Accounts(AccountID),
      Debit      REAL NOT NULL DEFAULT 0,
      Credit     REAL NOT NULL DEFAULT 0,
      Memo       TEXT,
      CustomerID INTEGER REFERENCES Customers(CustomerID),
      SupplierID INTEGER REFERENCES Suppliers(SupplierID),
      CHECK (Debit >= 0 AND Credit >= 0),
      CHECK (NOT (Debit > 0 AND Credit > 0)),
      CHECK (Debit > 0 OR Credit > 0)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_jl_journal ON JournalLines(JournalID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_jl_account ON JournalLines(AccountID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_jl_customer ON JournalLines(CustomerID)');

    db.exec(`CREATE TABLE IF NOT EXISTS Periods (
      Period   TEXT PRIMARY KEY,
      Status   TEXT NOT NULL DEFAULT 'open',
      ClosedAt TEXT,
      ClosedBy TEXT
    )`);

    const { typeOfCode } = require('../lib/ledger');
    const ins = db.prepare(
      `INSERT OR IGNORE INTO Accounts (Code, Name, Type, Notes, Active, CreatedAt)
       VALUES (?, ?, ?, ?, 1, datetime('now','localtime'))`
    );
    for (const [code, name, notes] of ACCOUNTS) ins.run(code, name, typeOfCode(code), notes);
  },

  down(db) {
    db.exec('DROP TABLE IF EXISTS JournalLines');
    db.exec('DROP TABLE IF EXISTS JournalEntries');
    db.exec('DROP TABLE IF EXISTS Periods');
    db.exec('DROP TABLE IF EXISTS Accounts');
  },
};
