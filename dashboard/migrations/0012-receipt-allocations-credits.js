'use strict';

/**
 * Receipt allocations, customer credits, refunds, and idempotency tracking.
 *
 * THE GAP THIS CLOSES
 *
 * 1. Previously, payments were tied 1:1 to an InvoiceID without explicit allocation records.
 *    Downward revisions or payments exceeding balance could not track the unallocated portion
 *    as a genuine credit liability.
 *
 * 2. Excess cash was either discarded or reversed from the till, instead of holding it as a
 *    CustomerCredit liability until a physical refund was approved and executed.
 *
 * 3. Network retries / replays of financial mutations (finalize, receipt, revise) risked
 *    duplicate execution without a database-backed idempotency store.
 *
 * THE STRUCTURES
 *
 *   ReceiptAllocations: Links payments to invoices with exact amount.
 *   CustomerCredits:    Tracks credit balances owed to customers.
 *   Refunds:            Records formal, approved physical cash/bank refund payouts.
 *   IdempotencyKeys:    Stores actor, operation, request hash, response for replay defense.
 */

const ACCOUNTS = [
  ['2400', 'Customer Credits & Deposits', 'Credit balances owed to customers from downward revisions or overpayments'],
];

module.exports = {
  name: 'receipt allocations, customer credits, refunds and idempotency',

  up(db) {
    const now = "datetime('now', 'localtime')";

    // Seed Account 2400 in Accounts chart
    try {
      const { typeOfCode } = require('../lib/ledger');
      const insAcct = db.prepare(
        `INSERT OR IGNORE INTO Accounts (Code, Name, Type, Notes, Active, CreatedAt)
         VALUES (?, ?, ?, ?, 1, datetime('now','localtime'))`
      );
      for (const [code, name, notes] of ACCOUNTS) insAcct.run(code, name, typeOfCode(code), notes);
    } catch (_) {}

    // 1. ReceiptAllocations
    db.exec(`CREATE TABLE IF NOT EXISTS ReceiptAllocations (
      AllocationID     INTEGER PRIMARY KEY,
      PaymentID        INTEGER NOT NULL REFERENCES Payments(PaymentID) ON DELETE RESTRICT,
      InvoiceID        INTEGER NOT NULL REFERENCES Invoices(InvoiceID) ON DELETE RESTRICT,
      Amount           REAL NOT NULL CHECK (Amount > 0),
      AllocatedAt      TEXT NOT NULL,
      AllocatedBy      TEXT,
      CreatedAt        TEXT NOT NULL DEFAULT (${now})
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_allocations_payment ON ReceiptAllocations(PaymentID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_allocations_invoice ON ReceiptAllocations(InvoiceID)');

    // 2. CustomerCredits
    db.exec(`CREATE TABLE IF NOT EXISTS CustomerCredits (
      CreditID         INTEGER PRIMARY KEY,
      CustomerID       INTEGER NOT NULL REFERENCES Customers(CustomerID) ON DELETE RESTRICT,
      SourceType       TEXT NOT NULL CHECK (SourceType IN ('revision', 'overpayment', 'manual')),
      SourceID         INTEGER NOT NULL,
      OriginalAmount   REAL NOT NULL CHECK (OriginalAmount > 0),
      RemainingAmount  REAL NOT NULL CHECK (RemainingAmount >= 0),
      Status           TEXT NOT NULL DEFAULT 'open' CHECK (Status IN ('open', 'utilized', 'refunded', 'voided')),
      Notes            TEXT,
      CreatedAt        TEXT NOT NULL DEFAULT (${now}),
      CreatedBy        TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_credits_customer ON CustomerCredits(CustomerID, Status)');

    // 3. Refunds
    db.exec(`CREATE TABLE IF NOT EXISTS Refunds (
      RefundID         INTEGER PRIMARY KEY,
      CreditID         INTEGER NOT NULL REFERENCES CustomerCredits(CreditID) ON DELETE RESTRICT,
      CustomerID       INTEGER NOT NULL REFERENCES Customers(CustomerID) ON DELETE RESTRICT,
      Amount           REAL NOT NULL CHECK (Amount > 0),
      RefundDate       TEXT NOT NULL,
      PaymentMethod    TEXT NOT NULL CHECK (PaymentMethod IN ('Cash', 'Bank Transfer', 'Cheque')),
      ReferenceNo      TEXT,
      ApprovedBy       TEXT NOT NULL,
      ExecutedBy       TEXT NOT NULL,
      JournalID        INTEGER REFERENCES JournalEntries(JournalID),
      CreatedAt        TEXT NOT NULL DEFAULT (${now})
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_refunds_credit ON Refunds(CreditID)');

    // 4. IdempotencyKeys
    db.exec(`CREATE TABLE IF NOT EXISTS IdempotencyKeys (
      KeyID            INTEGER PRIMARY KEY,
      IdempotencyKey   TEXT NOT NULL UNIQUE,
      ActorID          TEXT NOT NULL,
      Operation        TEXT NOT NULL,
      RequestHash      TEXT NOT NULL,
      ResponseCode     INTEGER NOT NULL,
      ResponseBody     TEXT NOT NULL,
      CreatedAt        TEXT NOT NULL DEFAULT (${now}),
      ExpiresAt        TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_idempotency_lookup ON IdempotencyKeys(IdempotencyKey, ActorID)');

    // Backfill: populate ReceiptAllocations for existing non-voided payments
    try {
      const existing = db.prepare(`
        SELECT PaymentID, InvoiceID, Amount, PaymentDate
        FROM Payments
        WHERE (VoidedAt IS NULL OR VoidedAt = '')
          AND InvoiceID IS NOT NULL
          AND Amount > 0
      `).all();

      const insAlloc = db.prepare(`
        INSERT INTO ReceiptAllocations (PaymentID, InvoiceID, Amount, AllocatedAt, AllocatedBy, CreatedAt)
        VALUES (?, ?, ?, ?, 'migration-0012', ${now})
      `);

      for (const p of existing) {
        insAlloc.run(p.PaymentID, p.InvoiceID, p.Amount, p.PaymentDate || '2026-08-01');
      }
    } catch (_) {
      // Tolerate environments without legacy payments data
    }
  },

  down(db) {
    db.exec('DROP TABLE IF EXISTS ReceiptAllocations');
    db.exec('DROP TABLE IF EXISTS CustomerCredits');
    db.exec('DROP TABLE IF EXISTS Refunds');
    db.exec('DROP TABLE IF EXISTS IdempotencyKeys');
    db.exec("DELETE FROM Accounts WHERE Code = '2400'");
  },
};
