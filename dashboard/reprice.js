'use strict';

/**
 * Bulk reprice — set each inventory item's selling Price to a fixed discount
 * below its market-mid benchmark, floored at cost (never below cost):
 *
 *     Price = max( round2(MarketMid × (1 − pct/100)), Cost )
 *
 * Only the default Price used for FUTURE invoices changes. Finalized invoices
 * store their own rates and are unaffected; items with no market-mid benchmark
 * are left as-is.
 *
 * Usage:
 *   node reprice.js               # dry run at 40% below mid (no writes)
 *   node reprice.js 40 --apply    # apply 40% below market mid
 *   node reprice.js 30 --apply    # apply 30% below market mid
 */

const connection = require('./db');
const money = require('./lib/money');
const sql = require('./lib/sql');

async function main() {
  const pct = Number.isFinite(Number(process.argv[2])) ? Number(process.argv[2]) : 40;
  const apply = process.argv.includes('--apply');
  const factor = 1 - pct / 100;

  const items = await connection.query('SELECT InventoryID, ProductName, Price, Cost, MarketMid FROM Inventory');
  let repriced = 0;
  let floored = 0;
  let skippedNoMid = 0;

  for (const it of items) {
    const mid = money.num(it.MarketMid);
    const cost = money.num(it.Cost);
    if (mid <= 0) { skippedNoMid++; continue; }

    let newPrice = money.round2(mid * factor);
    if (newPrice < cost) { newPrice = money.round2(cost); floored++; }
    if (money.round2(money.num(it.Price)) !== newPrice) repriced++;

    if (apply) {
      await connection.execute(
        `UPDATE Inventory SET Price = ${newPrice}, UpdatedAt = Now() WHERE InventoryID = ${sql.n(it.InventoryID)}`
      );
    }
  }

  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — Price = MarketMid × ${factor.toFixed(2)} (${pct}% below mid), floored at cost`);
  console.log(`items: ${items.length} | changed: ${repriced} | floored at cost: ${floored} | no market mid (left as-is): ${skippedNoMid}`);
  if (!apply) console.log('No changes written. Re-run with --apply to persist.');
}

main().catch((e) => { console.error('Reprice failed:', e.message); process.exit(1); });
