'use strict';

/**
 * Bulk reprice — bring every inventory item in line with the current pricing
 * model, so all price-showing screens (Inventory, Price Analysis, Invoice
 * Comparison, Cost vs Bill vs Market) display the same figures the invoice
 * editor now bills at:
 *
 *   MarketMid = resolved market  (outside-company benchmark → datasheet mid)
 *   Price     = suggested bill   = max(Cost, Market × 0.80)   [ferrules: max(Cost × 1.25, Market × 0.80)]
 *
 * Only the item catalogue is touched (Price / MarketMid / UpdatedAt). Finalized
 * invoices keep their own billing-time snapshots and are unaffected; stock,
 * customers, and payments are untouched.
 *
 * Usage:
 *   node reprice.js            # dry run (shows what would change, no writes)
 *   node reprice.js --apply    # apply
 */

const connection = require('./db');
const money = require('./lib/money');
const sql = require('./lib/sql');
const engine = require('./services/pricingEngine');

async function main() {
  const apply = process.argv.includes('--apply');

  const items = await connection.query('SELECT InventoryID, ProductName, SpecificationCode, Size, Price, Cost, MarketMid FROM Inventory');
  let priceChanged = 0, marketChanged = 0, outside = 0;
  const preview = [];

  for (const it of items) {
    const grade = String(it.ProductName || '').trim().split(/\s+/)[0];
    const mk = engine.resolveMarket({
      specCode: it.SpecificationCode, hoseGrade: grade, hoseSize: it.Size,
      description: it.ProductName, fallbackMarket: it.MarketMid,
    });
    const ferrule = engine.isFerrule(it.SpecificationCode);
    const s = engine.suggestFromCostMarket(it.Cost, mk.marketPrice, { ferrule });

    const newMarket = money.round2(mk.marketPrice);
    const newPrice = money.round2(s.suggestedUnit);
    if (mk.marketSource === 'outside-benchmark') outside++;
    if (money.round2(money.num(it.MarketMid)) !== newMarket) marketChanged++;
    if (money.round2(money.num(it.Price)) !== newPrice) priceChanged++;
    if (preview.length < 12) preview.push(`${it.SpecificationCode}: Price ${money.num(it.Price)}→${newPrice} · Mkt ${money.num(it.MarketMid)}→${newMarket} (${mk.marketSource})`);

    if (apply) {
      await connection.execute(
        `UPDATE Inventory SET Price = ${newPrice}, MarketMid = ${newMarket}, UpdatedAt = Now() WHERE InventoryID = ${sql.n(it.InventoryID)}`
      );
    }
  }

  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — Price = 80% of resolved market (floored at cost; ferrules at cost×1.25); MarketMid = outside benchmark where available.`);
  console.log(`items: ${items.length} | price changes: ${priceChanged} | market changes: ${marketChanged} | outside-benchmark matches: ${outside}`);
  console.log('sample:'); preview.forEach((p) => console.log('  ' + p));
  if (!apply) console.log('\nNo changes written. Re-run with --apply to persist.');
}

main().catch((e) => { console.error('Reprice failed:', e.message); process.exit(1); });
