'use strict';

/**
 * Fixed-asset depreciation (pure, dependency-free, unit-tested).
 *
 * Straight line: an asset loses (cost − residual) evenly over its useful life.
 * The workshop's crimping machine is the case that matters — its amortisation is
 * currently a hardcoded constant inside the rate card seed, which means the
 * charge never reaches the books and never stops when the machine is written
 * down.
 *
 * Two rules do most of the work here:
 *  - depreciation NEVER takes an asset below its residual value, so a fully
 *    written-down machine stops charging instead of going negative;
 *  - the final period absorbs the rounding remainder, so the sum of the monthly
 *    charges equals the depreciable amount exactly.
 */

const { round2, num } = require('./money');

/** `YYYY-MM` → a comparable integer, so period maths is not date maths. */
function periodIndex(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

/** How many whole months of service an asset has had by the end of `period`. */
function monthsInService(inServiceFrom, period) {
  const start = periodIndex(String(inServiceFrom || '').slice(0, 7));
  const end = periodIndex(period);
  if (start == null || end == null) return 0;
  return Math.max(0, end - start + 1);
}

/**
 * The depreciation charge for one asset in one period.
 *
 * @param {object} asset { cost, residual, lifeMonths, inServiceFrom, accumulated }
 * @param {string} period `YYYY-MM`
 * @returns {{charge:number, accumulatedAfter:number, netBookValue:number,
 *   fullyDepreciated:boolean, reason:(string|null)}}
 */
function monthlyCharge(asset, period) {
  const cost = round2(asset && asset.cost);
  const residual = round2(asset && asset.residual);
  const lifeMonths = Math.floor(num(asset && asset.lifeMonths));
  const accumulated = round2(asset && asset.accumulated);
  const depreciable = round2(Math.max(0, cost - residual));

  const nil = (reason) => ({
    charge: 0,
    accumulatedAfter: accumulated,
    netBookValue: round2(cost - accumulated),
    fullyDepreciated: accumulated >= depreciable,
    reason,
  });

  if (lifeMonths <= 0) return nil('no useful life set');
  if (depreciable <= 0) return nil('nothing to depreciate');
  if (accumulated >= depreciable) return nil('already fully depreciated');

  const months = monthsInService(asset && asset.inServiceFrom, period);
  if (months <= 0) return nil('not yet in service');

  // The last month of life absorbs whatever rounding has left over, so the
  // total charged is exactly the depreciable amount.
  const isFinalMonth = months >= lifeMonths;
  const straight = round2(depreciable / lifeMonths);
  const remaining = round2(depreciable - accumulated);
  const charge = isFinalMonth ? remaining : round2(Math.min(straight, remaining));

  const accumulatedAfter = round2(accumulated + charge);
  return {
    charge,
    accumulatedAfter,
    netBookValue: round2(cost - accumulatedAfter),
    fullyDepreciated: accumulatedAfter >= depreciable,
    reason: null,
  };
}

/**
 * Run one period across a set of assets.
 * @param {Array<object>} assets
 * @param {string} period
 * @returns {{lines:Array, total:number, skipped:Array}}
 */
function runPeriod(assets, period) {
  const lines = [];
  const skipped = [];
  let total = 0;

  for (const asset of assets || []) {
    const result = monthlyCharge(asset, period);
    if (result.charge > 0) {
      lines.push({ ...asset, ...result, period });
      total = round2(total + result.charge);
    } else {
      skipped.push({ assetId: asset.assetId, name: asset.name, reason: result.reason });
    }
  }
  return { lines, total, skipped };
}

/**
 * Value the stock on hand.
 * @param {Array<{qty:number, cost:number, category?:string}>} items
 * @returns {{total:number, byCategory:Array, negative:Array, count:number}}
 */
function stockValue(items) {
  const byCategory = new Map();
  const negative = [];
  let total = 0;

  for (const item of items || []) {
    const qty = num(item.qty);
    const cost = num(item.cost);
    const value = round2(qty * cost);
    const key = item.category || 'Uncategorised';
    if (!byCategory.has(key)) byCategory.set(key, { category: key, items: 0, qty: 0, value: 0 });
    const bucket = byCategory.get(key);
    bucket.items += 1;
    bucket.qty = round2(bucket.qty + qty);
    bucket.value = round2(bucket.value + value);
    total = round2(total + value);
    // Negative stock is a data problem, not a valuation — surface it.
    if (qty < 0) negative.push({ ...item, value });
  }

  return {
    total,
    byCategory: [...byCategory.values()].sort((a, b) => b.value - a.value),
    negative,
    count: (items || []).length,
  };
}

/**
 * Compare a physical count against what the system thinks is on the shelf.
 * @param {Array<{inventoryId:number, systemQty:number, countedQty:number, cost:number}>} lines
 * @returns {{lines:Array, totalVariance:number, shortages:number, overages:number}}
 */
function stockTakeVariance(lines) {
  let totalVariance = 0;
  let shortages = 0;
  let overages = 0;

  const out = (lines || []).map((l) => {
    const systemQty = num(l.systemQty);
    const countedQty = num(l.countedQty);
    const cost = num(l.cost);
    const qtyDiff = round2(countedQty - systemQty);
    const valueDiff = round2(qtyDiff * cost);
    totalVariance = round2(totalVariance + valueDiff);
    if (qtyDiff < 0) shortages = round2(shortages + valueDiff);
    if (qtyDiff > 0) overages = round2(overages + valueDiff);
    return { ...l, systemQty, countedQty, cost, qtyDiff, valueDiff };
  });

  return { lines: out, totalVariance, shortages, overages };
}

module.exports = { periodIndex, monthsInService, monthlyCharge, runPeriod, stockValue, stockTakeVariance };
