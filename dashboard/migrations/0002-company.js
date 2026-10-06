'use strict';

/**
 * Company master.
 *
 * The shop's identity was hardcoded in the PDF template (services/invoicePdf.js),
 * so changing a phone number meant editing source. It also blocks anything
 * multi-entity later, and an ERP needs one place to hold the fiscal year start
 * and base currency that the General Ledger will key off.
 *
 * Single row by design: CompanyID is pinned to 1 by a CHECK, so there is no way
 * to end up with two "current" companies. Seeded from the values that were in
 * the template, so the printed invoice does not change appearance.
 */

const SEED = {
  Name: 'Edward and Christie',
  Tagline: 'Hydraulic Hose Repair',
  BaseCurrency: 'LKR',
  FiscalYearStartMonth: 1,
  InvoicePrefix: 'INV',
};

module.exports = {
  name: 'company master',

  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS Company (
      CompanyID            INTEGER PRIMARY KEY CHECK (CompanyID = 1),
      Name                 TEXT NOT NULL,
      Tagline              TEXT,
      Address              TEXT,
      Phone                TEXT,
      Email                TEXT,
      Website              TEXT,
      TIN                  TEXT,
      VATNo                TEXT,
      BaseCurrency         TEXT NOT NULL DEFAULT 'LKR',
      FiscalYearStartMonth INTEGER NOT NULL DEFAULT 1,
      InvoicePrefix        TEXT NOT NULL DEFAULT 'INV',
      LogoPath             TEXT,
      UpdatedAt            TEXT
    )`);

    const exists = db.prepare('SELECT COUNT(*) AS c FROM Company').get().c;
    if (!exists) {
      db.prepare(`INSERT INTO Company
        (CompanyID, Name, Tagline, BaseCurrency, FiscalYearStartMonth, InvoicePrefix, UpdatedAt)
        VALUES (1, @Name, @Tagline, @BaseCurrency, @FiscalYearStartMonth, @InvoicePrefix, datetime('now','localtime'))`
      ).run(SEED);
    }
  },

  down(db) {
    db.exec('DROP TABLE IF EXISTS Company');
  },
};
