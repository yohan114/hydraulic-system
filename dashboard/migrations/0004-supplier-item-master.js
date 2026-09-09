'use strict';

/**
 * Master-data fields that procurement and stock valuation will need.
 *
 * Suppliers gains the commercial terms a purchase order has to carry (code,
 * payment terms, currency, tax id). Inventory gains a category for reporting and
 * an explicit valuation method, so stock value stops being an implicit choice
 * buried in whichever query happens to read `Cost`.
 *
 * Weighted average is the default because that is what the existing cost figures
 * already behave like: `Inventory.Cost` is a single landed cost per item that
 * gets overwritten on each purchase, which is WAC with a sample size of one.
 */

module.exports = {
  name: 'supplier and item master fields',

  up(db) {
    const cols = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));

    const sup = cols('Suppliers');
    if (!sup.has('Code')) db.exec('ALTER TABLE Suppliers ADD COLUMN Code TEXT');
    if (!sup.has('TIN')) db.exec('ALTER TABLE Suppliers ADD COLUMN TIN TEXT');
    if (!sup.has('PaymentTermsDays')) db.exec('ALTER TABLE Suppliers ADD COLUMN PaymentTermsDays INTEGER NOT NULL DEFAULT 0');
    if (!sup.has('Currency')) db.exec("ALTER TABLE Suppliers ADD COLUMN Currency TEXT NOT NULL DEFAULT 'LKR'");

    const inv = cols('Inventory');
    if (!inv.has('Category')) db.exec('ALTER TABLE Inventory ADD COLUMN Category TEXT');
    if (!inv.has('ValuationMethod')) db.exec("ALTER TABLE Inventory ADD COLUMN ValuationMethod TEXT NOT NULL DEFAULT 'WAC'");
    db.exec('CREATE INDEX IF NOT EXISTS idx_inv_category ON Inventory(Category)');

    // Categorise the existing stock from the naming the shop already uses, so
    // the field is useful on day one rather than 83 blanks. Anything that does
    // not match is left NULL for the owner to set.
    const rules = [
      ['Hose', "ProductName LIKE '%hose%' OR ProductName LIKE '%rubber pipe%'"],
      ['Ferrule', "ProductName LIKE '%ferrule%' OR ProductName LIKE '%2SN%' OR ProductName LIKE '%1SN%'"],
      ['Union', "ProductName LIKE '%union%' OR ProductName LIKE '%BSP%' OR ProductName LIKE '%JIC%' OR ProductName LIKE '%adapt%'"],
      ['Flange', "ProductName LIKE '%flange%'"],
      ['Fitting', "ProductName LIKE '%fitting%' OR ProductName LIKE '%nipple%' OR ProductName LIKE '%elbow%'"],
    ];
    for (const [category, where] of rules) {
      db.prepare(`UPDATE Inventory SET Category = ? WHERE Category IS NULL AND (${where})`).run(category);
    }
  },

  down(db) {
    // Columns are additive and nullable/defaulted; dropping them would mean
    // rebuilding two live tables. Clearing the derived category is enough to
    // undo what this migration decided.
    db.exec('UPDATE Inventory SET Category = NULL');
  },
};
