'use strict';

/**
 * Reconcile the live Inventory against the authoritative shipment datasheet
 * (invoice HS25E1112W1) — NON-DESTRUCTIVE.
 *
 * This is the "smart update" for a system that is already in use: it upserts
 * every item from data/shipment-HS25E1112W1.json onto the existing Inventory
 * WITHOUT deleting invoices or their line items. For each shipment item it:
 *   - finds the matching legacy row (by clean UniqueID, else by normalised spec
 *     code, else by hose grade+bore) and UPDATES it in place — correcting Qty,
 *     Cost (landed) and Price (sell), and normalising UniqueID / description; or
 *   - INSERTS it when the system has never had that part (the missing items); and
 *   - zeroes the stock of items that were ordered but NOT received (they stay in
 *     the catalogue at Qty 0, ready to receive when the supplier ships them).
 *
 * Every change is logged, and a summary is printed, so the correction is
 * auditable. Run on the Windows machine that hosts the Access DB:
 *
 *     cd dashboard
 *     node reconcile-inventory.js            # apply
 *     node reconcile-inventory.js --dry-run  # preview only, write nothing
 *
 * For a brand-new / empty database use reseed-inventory.js instead (full rebuild).
 */

const path = require('path');
const ADODB = require('node-adodb');
const { q, n } = require('./lib/sql');

const DB = path.join(__dirname, '..', 'HydraulicHoseRepair.accdb');
const MASTER = require('./data/shipment-HS25E1112W1.json');
const DRY_RUN = process.argv.includes('--dry-run');

// Normalise a spec code for matching: uppercase, strip spaces/punctuation and a
// single trailing letter-suffix group (T / W / ST) that the old sheet omitted.
const norm = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
const matchKey = (c) => norm(c).replace(/(ST|T|W)$/, '');

async function run() {
  const connection = ADODB.open(
    `Provider=Microsoft.ACE.OLEDB.12.0;Data Source=${DB};Persist Security Info=False;`,
    true
  );

  const existing = await connection.query('SELECT * FROM Inventory');
  console.log(`Loaded ${existing.length} existing inventory rows.`);

  // Index existing rows so a shipment item can find its legacy twin even when the
  // old UniqueID differs (old codes lack the T/W/ST suffix; old hoses have a long
  // generated name). We key on the normalised spec code found in any of the
  // UniqueID / SpecificationCode / ProductName columns.
  const byKey = new Map();
  const addKey = (k, row) => { if (k && !byKey.has(k)) byKey.set(k, row); };
  for (const row of existing) {
    addKey(matchKey(row.UniqueID), row);
    if (row.SpecificationCode) addKey(matchKey(row.SpecificationCode), row);
    if (row.ProductName) addKey(matchKey(row.ProductName), row);
  }
  // Hose rows in the old DB carry no spec code — key them by grade + bore(mm).
  const hoseKey = (spec, bore) => `HOSE:${String(spec).toUpperCase()}:${bore}`;
  for (const row of existing) {
    const name = String(row.ProductName || '');
    const grade = (name.match(/\b(4SP|4SH|R2|R1)\b/) || [])[1];
    const bore = (name.match(/(\d+)\s*mm/i) || String(row.Description || '').match(/(\d+)\s*mm/i) || [])[1];
    if (grade && bore) addKey(hoseKey(grade, bore), row);
  }

  const log = { added: [], qtyFixed: [], priceChanged: [], zeroed: [], updated: [], failed: [] };

  for (const it of MASTER.items) {
    // Locate the legacy row for this shipment item.
    let match = null;
    if (it.category === 'Hose') {
      const bore = (String(it.description).match(/(\d+)\s*mm/i) || [])[1];
      match = byKey.get(hoseKey(it.subtype, bore)) || byKey.get(matchKey(it.uniqueId));
    } else {
      match = byKey.get(matchKey(it.specificationCode)) || byKey.get(matchKey(it.uniqueId));
    }

    const desc = it.received ? it.description
      : `${it.description}  [ON ORDER - not yet received, shipment ${MASTER.shipment.invoice}]`;

    try {
      if (match) {
        const oldQty = Number(match.Qty) || 0;
        const oldPrice = Number(match.Price) || 0;
        const oldCost = Number(match.Cost) || 0;
        if (oldQty !== it.stockQty) {
          (it.received ? log.qtyFixed : log.zeroed).push(
            `${it.specificationCode || it.uniqueId}: qty ${oldQty} -> ${it.stockQty}`);
        }
        if (oldPrice !== it.price) log.priceChanged.push(
          `${it.specificationCode || it.uniqueId}: sell ${oldPrice} -> ${it.price}`);
        if (!DRY_RUN) {
          await connection.execute(
            `UPDATE Inventory SET
               UniqueID = ${q(it.uniqueId)}, ProductName = ${q(it.productName)},
               SpecificationCode = ${q(it.specificationCode)}, [Size] = ${q(it.size)},
               Description = ${q(desc)}, Qty = ${n(it.stockQty)}, Unit = ${q(it.unit)},
               Price = ${n(it.price)}, Cost = ${n(it.cost)}, UpdatedAt = Now()
             WHERE InventoryID = ${n(match.InventoryID)}`);
        }
        if (oldQty === it.stockQty && oldPrice === it.price && oldCost === it.cost) {
          log.updated.push(it.uniqueId);
        }
      } else {
        log.added.push(`${it.no} ${it.specificationCode || it.uniqueId} (${it.description})`);
        if (!DRY_RUN) {
          await connection.execute(
            `INSERT INTO Inventory (UniqueID, ProductName, SpecificationCode, [Size], Description, [Length], Qty, Unit, Price, Cost, CreatedAt, UpdatedAt)
             VALUES (${q(it.uniqueId)}, ${q(it.productName)}, ${q(it.specificationCode)}, ${q(it.size)}, ${q(desc)}, 0, ${n(it.stockQty)}, ${q(it.unit)}, ${n(it.price)}, ${n(it.cost)}, Now(), Now())`);
        }
      }
    } catch (e) {
      log.failed.push(`${it.uniqueId}: ${e.message}`);
    }
  }

  const line = '-'.repeat(60);
  console.log(`\n${line}\nRECONCILIATION SUMMARY  (invoice ${MASTER.shipment.invoice})${DRY_RUN ? '  [DRY RUN - nothing written]' : ''}\n${line}`);
  console.log(`Missing items ADDED           : ${log.added.length}`);
  log.added.forEach((s) => console.log(`   + ${s}`));
  console.log(`Quantity ERRORS corrected     : ${log.qtyFixed.length}`);
  log.qtyFixed.forEach((s) => console.log(`   ~ ${s}`));
  console.log(`Not-received stock zeroed     : ${log.zeroed.length}`);
  log.zeroed.forEach((s) => console.log(`   0 ${s}`));
  console.log(`Sell prices updated           : ${log.priceChanged.length}`);
  console.log(`Rows already correct          : ${log.updated.length}`);
  if (log.failed.length) {
    console.log(`FAILED                        : ${log.failed.length}`);
    log.failed.forEach((s) => console.log(`   ! ${s}`));
    process.exitCode = 1;
  }
  console.log(line);
  console.log(DRY_RUN ? 'Dry run complete. Re-run without --dry-run to apply.' : 'Reconciliation applied.');
}

run().catch((err) => { console.error('Reconcile error:', err.message); process.exit(1); });
