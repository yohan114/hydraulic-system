'use strict';

/**
 * Workshop operations: quotations, job cards, and technician labour.
 *
 * The shop's actual workflow — a machine arrives, a hose is made, a technician
 * does the crimping, the job goes out — had no record. An invoice was the only
 * artefact, which meant:
 *
 *   - nothing tracked a job that was in progress or waiting for parts;
 *   - the technician's earnings were inferred by pattern-matching the words
 *     "Technical charge" or "Crimping" in a line description, and marked paid by
 *     a boolean on the invoice;
 *   - `Workers` and `LabourPayments` had been built and never used.
 *
 * This adds the record that was missing, and links it to what already exists:
 *
 *   Quotation  →  Job Card  →  Invoice
 *                    ↓
 *                 JobLabour  →  a real Worker, accrued and then paid
 *
 * Technician labour is now ACCRUED when the job is completed
 * (Dr Cost of Sales — Technical Labour / Cr Accrued Technical Labour) and the
 * accrual is cleared when the worker is actually paid. That is what account 2200
 * was seeded for in migration 0005; until now nothing posted to it.
 */

module.exports = {
  name: 'quotations, job cards and technician labour',

  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS Quotations (
      QuoteID    INTEGER PRIMARY KEY,
      QuoteNo    TEXT NOT NULL UNIQUE,
      CustomerID INTEGER REFERENCES Customers(CustomerID),
      MachineID  INTEGER REFERENCES Machines(MachineID),
      QuoteDate  TEXT NOT NULL,
      ValidUntil TEXT,
      Status     TEXT NOT NULL DEFAULT 'open',
      Notes      TEXT,
      CreatedAt  TEXT,
      UpdatedAt  TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_quote_customer ON Quotations(CustomerID)');

    db.exec(`CREATE TABLE IF NOT EXISTS QuotationItems (
      QuoteItemID INTEGER PRIMARY KEY,
      QuoteID     INTEGER NOT NULL REFERENCES Quotations(QuoteID) ON DELETE CASCADE,
      InventoryID INTEGER REFERENCES Inventory(InventoryID),
      Description TEXT,
      Unit        TEXT,
      Qty         REAL NOT NULL DEFAULT 0,
      Rate        REAL NOT NULL DEFAULT 0
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_qi_quote ON QuotationItems(QuoteID)');

    db.exec(`CREATE TABLE IF NOT EXISTS JobCards (
      JobID       INTEGER PRIMARY KEY,
      JobNo       TEXT NOT NULL UNIQUE,
      CustomerID  INTEGER REFERENCES Customers(CustomerID),
      MachineID   INTEGER REFERENCES Machines(MachineID),
      QuoteID     INTEGER REFERENCES Quotations(QuoteID),
      InvoiceID   INTEGER REFERENCES Invoices(InvoiceID),
      Description TEXT,
      HoseSpec    TEXT,
      Status      TEXT NOT NULL DEFAULT 'open',
      Priority    TEXT NOT NULL DEFAULT 'normal',
      ReceivedAt  TEXT NOT NULL,
      PromisedAt  TEXT,
      CompletedAt TEXT,
      Notes       TEXT,
      CreatedAt   TEXT,
      UpdatedAt   TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_status ON JobCards(Status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_customer ON JobCards(CustomerID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_machine ON JobCards(MachineID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_invoice ON JobCards(InvoiceID)');

    db.exec(`CREATE TABLE IF NOT EXISTS JobCardItems (
      JobItemID   INTEGER PRIMARY KEY,
      JobID       INTEGER NOT NULL REFERENCES JobCards(JobID) ON DELETE CASCADE,
      InventoryID INTEGER REFERENCES Inventory(InventoryID),
      Description TEXT,
      Unit        TEXT,
      Qty         REAL NOT NULL DEFAULT 0,
      Rate        REAL NOT NULL DEFAULT 0
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_ji_job ON JobCardItems(JobID)');

    db.exec(`CREATE TABLE IF NOT EXISTS JobLabour (
      JobLabourID INTEGER PRIMARY KEY,
      JobID       INTEGER NOT NULL REFERENCES JobCards(JobID) ON DELETE CASCADE,
      WorkerID    INTEGER REFERENCES Workers(WorkerID),
      WorkType    TEXT NOT NULL DEFAULT 'crimping',
      Units       REAL NOT NULL DEFAULT 0,
      UnitLabel   TEXT NOT NULL DEFAULT 'end',
      Rate        REAL NOT NULL DEFAULT 0,
      Amount      REAL NOT NULL DEFAULT 0,
      -- Set when the accrual has been settled by a LabourPayments row.
      LabourPaymentID INTEGER REFERENCES LabourPayments(LabourPaymentID),
      Notes       TEXT,
      CreatedAt   TEXT,
      CHECK (Units >= 0 AND Rate >= 0)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_jl_job ON JobLabour(JobID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_jl_worker ON JobLabour(WorkerID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_jl_payment ON JobLabour(LabourPaymentID)');

    // Link an invoice back to the job it came from, without disturbing the
    // invoice tables that already exist.
    const invCols = new Set(db.prepare('PRAGMA table_info(Invoices)').all().map((r) => r.name));
    if (!invCols.has('JobID')) db.exec('ALTER TABLE Invoices ADD COLUMN JobID INTEGER REFERENCES JobCards(JobID)');
  },

  down(db) {
    ['JobLabour', 'JobCardItems', 'JobCards', 'QuotationItems', 'Quotations']
      .forEach((t) => db.exec(`DROP TABLE IF EXISTS ${t}`));
  },
};
