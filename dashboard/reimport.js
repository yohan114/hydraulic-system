'use strict';

/**
 * Full inventory REBUILD from the authoritative shipment datasheet
 * (invoice HS25E1112W1) — DESTRUCTIVE. Use this for a fresh / empty database,
 * or when you deliberately want to wipe and reload the catalogue.
 *
 *   cd dashboard
 *   node reimport.js
 *
 * It clears StockMovements, InvoiceItems, Invoices and Inventory, then inserts
 * all 84 items from data/shipment-HS25E1112W1.json with the correct landed Cost,
 * sell Price, received quantity, size and description. Not-received items are
 * inserted at Qty 0 and flagged in the description.
 *
 * ⚠️  If the system is already in use and you must keep existing invoices, run
 *     reconcile-inventory.js instead — it upserts non-destructively.
 *
 * (Previous version of this file read a hard-coded Windows path
 *  `D:\hy 1\Hydraulic Items.xlsx`, imported no cost, and carried the rough
 *  quantities. It has been replaced by the datasheet-driven master.)
 */

const connection = require('./lib/db');
const { q, n } = require('./lib/sql');

const MASTER = require('./data/shipment-HS25E1112W1.json');

async function run() {
  console.log('Clearing transactional tables and inventory...');
  for (const stmt of [
    'DELETE FROM StockMovements',
    'DELETE FROM InvoiceItems',
    'DELETE FROM Invoices',
    'DELETE FROM Inventory',
  ]) {
    try { await connection.execute(stmt); } catch (e) { console.warn('  (skip)', stmt, '-', e.message); }
  }

  console.log(`Inserting ${MASTER.items.length} items from datasheet ${MASTER.shipment.invoice}...`);
  let inserted = 0;
  for (const it of MASTER.items) {
    const desc = it.received ? it.description
      : `${it.description}  [ON ORDER - not yet received, shipment ${MASTER.shipment.invoice}]`;
    try {
      await connection.execute(
        `INSERT INTO Inventory (UniqueID, ProductName, SpecificationCode, [Size], Description, [Length], Qty, Unit, Price, Cost, MarketMid, CreatedAt, UpdatedAt)
         VALUES (${q(it.uniqueId)}, ${q(it.productName)}, ${q(it.specificationCode)}, ${q(it.size)}, ${q(desc)}, 0, ${n(it.stockQty)}, ${q(it.unit)}, ${n(it.price)}, ${n(it.cost)}, ${n(it.marketMid, 0)}, Now(), Now())`);
      inserted++;
    } catch (e) {
      console.error(`  Failed ${it.uniqueId}:`, e.message);
    }
  }

  const received = MASTER.items.filter((i) => i.received).length;
  console.log(`\nDone. Inserted ${inserted}/${MASTER.items.length} items ` +
    `(${received} received / ${MASTER.items.length - received} on-order at Qty 0).`);
}

run().catch((err) => { console.error('Reimport error:', err.message); process.exit(1); });
