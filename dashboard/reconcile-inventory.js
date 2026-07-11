'use strict';

/**
 * Reconcile the live Inventory against the authoritative shipment datasheet
 * (invoice HS25E1112W1) — NON-DESTRUCTIVE.
 *
 * This is the "smart update" for a system that is already in use: it upserts
 * every item from data/shipment-HS25E1112W1.json onto the existing Inventory
 * WITHOUT deleting invoices or their line items, and WITHOUT overwriting live
 * stock counts. For each shipment item it:
 *   - finds the matching legacy row (by clean UniqueID, else by normalised spec
 *     code, else by hose grade+bore) and refreshes Cost (landed), Price (sell),
 *     description, size and unit — but PRESERVES its Qty, because a live row's
 *     quantity reflects real sales since the shipment; or
 *   - INSERTS it when the system has never had that part (the missing items),
 *     seeding Qty with the received quantity; and
 *   - zeroes the stock of items that were ordered but NOT received (phantom
 *     stock), leaving them in the catalogue at Qty 0.
 *
 * Because stock is preserved, the script is idempotent — safe to re-run. The six
 * one-time OPENING-quantity corrections (an item received 50 but entered 25,
 * etc.) are listed in SHIPMENT_RECONCILIATION.md and were applied to the DB once;
 * they are deliberately NOT re-applied here (that would double-count).
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

const connection = require('./lib/db');
const { q, n } = require('./lib/sql');

const MASTER = require('./data/shipment-HS25E1112W1.json');
const DRY_RUN = process.argv.includes('--dry-run');

// Normalise a spec code for matching: uppercase, strip spaces/punctuation and a
// single trailing letter-suffix group (T / W / ST) that the old sheet omitted.
const norm = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
const matchKey = (c) => norm(c).replace(/(ST|T|W)$/, '');

async function run() {
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

  const log = { added: [], priceChanged: [], zeroed: [], updated: [], failed: [] };

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
        // Stock quantity is PRESERVED: a live row's Qty reflects real sales since
        // the shipment, so we never overwrite it. The only exception is a
        // not-received item that is showing phantom stock — zero it. (The six
        // one-time opening-quantity corrections are documented in
        // SHIPMENT_RECONCILIATION.md and are applied once, not on every run.)
        const setQty = it.received ? oldQty : 0;
        if (!it.received && oldQty !== 0) log.zeroed.push(
          `${it.specificationCode || it.uniqueId}: qty ${oldQty} -> 0 (never received)`);
        if (oldPrice !== it.price) log.priceChanged.push(
          `${it.specificationCode || it.uniqueId}: sell ${oldPrice} -> ${it.price}`);
        if (!DRY_RUN) {
          await connection.execute(
            `UPDATE Inventory SET
               ProductName = ${q(it.productName)},
               SpecificationCode = ${q(it.specificationCode)}, [Size] = ${q(it.size)},
               Description = ${q(desc)}, Qty = ${n(setQty)}, Unit = ${q(it.unit)},
               Price = ${n(it.price)}, Cost = ${n(it.cost)}, MarketMid = ${n(it.marketMid, 0)}, UpdatedAt = Now()
             WHERE InventoryID = ${n(match.InventoryID)}`);
        }
        log.updated.push(it.uniqueId);
      } else {
        log.added.push(`${it.no} ${it.specificationCode || it.uniqueId} (${it.description})`);
        if (!DRY_RUN) {
          await connection.execute(
            `INSERT INTO Inventory (UniqueID, ProductName, SpecificationCode, [Size], Description, [Length], Qty, Unit, Price, Cost, MarketMid, CreatedAt, UpdatedAt)
             VALUES (${q(it.uniqueId)}, ${q(it.productName)}, ${q(it.specificationCode)}, ${q(it.size)}, ${q(desc)}, 0, ${n(it.stockQty)}, ${q(it.unit)}, ${n(it.price)}, ${n(it.cost)}, ${n(it.marketMid, 0)}, Now(), Now())`);
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
  console.log(`Not-received stock zeroed     : ${log.zeroed.length}`);
  log.zeroed.forEach((s) => console.log(`   0 ${s}`));
  console.log(`Sell prices updated           : ${log.priceChanged.length}`);
  console.log(`Rows refreshed (cost/price/…)  : ${log.updated.length}  (stock qty preserved)`);
  if (log.failed.length) {
    console.log(`FAILED                        : ${log.failed.length}`);
    log.failed.forEach((s) => console.log(`   ! ${s}`));
    process.exitCode = 1;
  }
  console.log(line);
  console.log(DRY_RUN ? 'Dry run complete. Re-run without --dry-run to apply.' : 'Reconciliation applied.');
}

run().catch((err) => { console.error('Reconcile error:', err.message); process.exit(1); });
