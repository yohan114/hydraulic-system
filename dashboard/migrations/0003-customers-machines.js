'use strict';

/**
 * Customer and Machine masters, and the links from Invoices to both.
 *
 * Until now a "customer" was free text in `Invoices.BilledToName`, and that one
 * field was carrying three different things:
 *
 *   - machine / vehicle registrations   HEX-18, ZA-7092, 48-8072, MG-06
 *   - equipment or job descriptions     "Tractor Hose", "Service Bay"
 *   - actual people                     Sankalpa, Kalum Sudarshana, Akila
 *
 * The first two are the shop's OWN plant — they carry the shop's own address in
 * BilledToAddress — so they are internal work, not sales. This migration splits
 * them: real people become Customers, plant becomes Machines owned by a single
 * "Internal / Own Fleet" customer, and every invoice is linked to both plus an
 * `IsInternal` flag.
 *
 * CLASSIFICATION IS A PROPOSAL, NOT A FACT. It is derived from the billing
 * address (see SHOP_ADDRESS_RE), which is shop-specific and was verified against
 * this database: 26 internal / 5 external across 31 finalized invoices. Every
 * row it produces is editable afterwards, and `BilledToName` is left untouched
 * so nothing is lost if the classification turns out wrong.
 */

// An invoice billed to the shop's own address is work on the shop's own plant.
// Verified against every row in this database before being relied on.
const SHOP_ADDRESS_RE = /nawala|nugegoda|edward|christie/i;

// Plant is identified by a registration-like code (HEX-18, ZA-7092, 48-8072,
// SL - 14). Anything else internal is described equipment ("Tractor Hose").
const REGISTRATION_RE = /^[A-Z]{1,3}\s*-?\s*\d{1,5}$|^\d{2,3}\s*-\s*\d{3,5}$/i;

const INTERNAL_CUSTOMER = 'Internal / Own Fleet';

/** A phone number sitting in the address column is a contact, not an address. */
function looksLikePhone(s) {
  return /^[\d\s()+-]{7,}$/.test(String(s || '').trim());
}

function slugCode(name, prefix) {
  const s = String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20);
  return `${prefix}-${s || 'X'}`;
}

module.exports = {
  name: 'customers and machines',

  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS Customers (
      CustomerID       INTEGER PRIMARY KEY,
      Code             TEXT UNIQUE,
      Name             TEXT NOT NULL,
      Kind             TEXT NOT NULL DEFAULT 'external',
      Address          TEXT,
      Phone            TEXT,
      Email            TEXT,
      TIN              TEXT,
      CreditLimit      REAL NOT NULL DEFAULT 0,
      PaymentTermsDays INTEGER NOT NULL DEFAULT 0,
      Active           INTEGER NOT NULL DEFAULT 1,
      Notes            TEXT,
      CreatedAt        TEXT,
      UpdatedAt        TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_cust_name ON Customers(Name)');

    db.exec(`CREATE TABLE IF NOT EXISTS Machines (
      MachineID  INTEGER PRIMARY KEY,
      Code       TEXT UNIQUE,
      Name       TEXT NOT NULL,
      Kind       TEXT NOT NULL DEFAULT 'equipment',
      CustomerID INTEGER REFERENCES Customers(CustomerID),
      Active     INTEGER NOT NULL DEFAULT 1,
      Notes      TEXT,
      CreatedAt  TEXT,
      UpdatedAt  TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_machine_customer ON Machines(CustomerID)');

    // Additive only — BilledToName/BilledToAddress stay exactly as they are.
    const invCols = new Set(db.prepare('PRAGMA table_info(Invoices)').all().map((r) => r.name));
    if (!invCols.has('CustomerID')) db.exec('ALTER TABLE Invoices ADD COLUMN CustomerID INTEGER REFERENCES Customers(CustomerID)');
    if (!invCols.has('MachineID')) db.exec('ALTER TABLE Invoices ADD COLUMN MachineID INTEGER REFERENCES Machines(MachineID)');
    if (!invCols.has('IsInternal')) db.exec('ALTER TABLE Invoices ADD COLUMN IsInternal INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_inv_customer ON Invoices(CustomerID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_inv_machine ON Invoices(MachineID)');

    // ---- Backfill -------------------------------------------------------
    const now = `datetime('now','localtime')`;
    const insCustomer = db.prepare(
      `INSERT INTO Customers (Code, Name, Kind, Address, Phone, Notes, CreatedAt, UpdatedAt)
       VALUES (@Code, @Name, @Kind, @Address, @Phone, @Notes, ${now}, ${now})`
    );
    const insMachine = db.prepare(
      `INSERT INTO Machines (Code, Name, Kind, CustomerID, Notes, CreatedAt, UpdatedAt)
       VALUES (@Code, @Name, @Kind, @CustomerID, @Notes, ${now}, ${now})`
    );

    // One internal customer owns all the shop's own plant.
    let internalId = db.prepare('SELECT CustomerID FROM Customers WHERE Name = ?').get(INTERNAL_CUSTOMER);
    internalId = internalId ? internalId.CustomerID : insCustomer.run({
      Code: 'CUST-INTERNAL', Name: INTERNAL_CUSTOMER, Kind: 'internal',
      Address: null, Phone: null, Notes: 'Own fleet and workshop equipment — work recorded for costing, not sold.',
    }).lastInsertRowid;

    // Every distinct billing name, with the most complete address seen for it.
    const names = db.prepare(`
      SELECT BilledToName AS Name,
             MAX(COALESCE(BilledToAddress, '')) AS Addr,
             COUNT(*) AS Jobs
      FROM Invoices
      WHERE BilledToName IS NOT NULL AND TRIM(BilledToName) <> ''
      GROUP BY BilledToName`).all();

    const customerByName = new Map();
    const machineByName = new Map();

    for (const row of names) {
      const name = row.Name.trim();
      const addr = (row.Addr || '').trim();
      const internal = SHOP_ADDRESS_RE.test(addr);

      if (internal) {
        const kind = REGISTRATION_RE.test(name) ? 'registration' : 'equipment';
        const id = insMachine.run({
          Code: slugCode(name, 'M'), Name: name, Kind: kind, CustomerID: internalId,
          Notes: `Created from ${row.Jobs} historical invoice(s) billed to the shop's own address.`,
        }).lastInsertRowid;
        machineByName.set(name, id);
      } else {
        const phone = looksLikePhone(addr) ? addr : null;
        const id = insCustomer.run({
          Code: slugCode(name, 'C'), Name: name, Kind: 'external',
          Address: phone ? null : (addr || null), Phone: phone,
          Notes: `Created from ${row.Jobs} historical invoice(s).`,
        }).lastInsertRowid;
        customerByName.set(name, id);
      }
    }

    // Point every invoice at its customer, its machine, and flag internal work.
    const link = db.prepare('UPDATE Invoices SET CustomerID = ?, MachineID = ?, IsInternal = ? WHERE InvoiceID = ?');
    for (const inv of db.prepare('SELECT InvoiceID, BilledToName FROM Invoices').all()) {
      const name = (inv.BilledToName || '').trim();
      if (!name) continue;
      if (machineByName.has(name)) link.run(internalId, machineByName.get(name), 1, inv.InvoiceID);
      else if (customerByName.has(name)) link.run(customerByName.get(name), null, 0, inv.InvoiceID);
    }
  },

  down(db) {
    // The added Invoices columns are left in place: SQLite cannot drop a column
    // without rebuilding the table, and doing that to a live ledger to undo a
    // master-data migration is worse than leaving three nullable columns behind.
    db.exec('UPDATE Invoices SET CustomerID = NULL, MachineID = NULL, IsInternal = 0');
    db.exec('DROP TABLE IF EXISTS Machines');
    db.exec('DROP TABLE IF EXISTS Customers');
  },
};
