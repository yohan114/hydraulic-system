'use strict';

/**
 * Stock costing (pure, dependency-free, unit-tested).
 *
 * Two jobs, both of which used to be done by hand in a spreadsheet:
 *
 *  1. LANDED COST — spreading freight, duty and clearing over the lines of a
 *     goods receipt, so an item's cost is what it really cost to get it onto the
 *     shelf rather than just the supplier's price. This shop's item costs are
 *     already "CIF x duty"; this makes that a calculation the books can check.
 *
 *  2. WEIGHTED AVERAGE — folding a new receipt into an existing stock balance.
 *     `Inventory.Cost` behaved like a weighted average with a sample size of one
 *     (each purchase overwrote it); this makes it an actual one.
 */

const { round2, num } = require('./money');

/**
 * Spread landed costs across receipt lines.
 *
 * Allocation is by VALUE (a line worth twice as much carries twice the freight)
 * or by QUANTITY (each unit carries the same share — right for volumetric costs
 * like container space). The last line absorbs any rounding remainder so the
 * allocated total always equals the cost being allocated, to the cent.
 *
 * @param {Array<{qty:number, unitPrice:number}>} lines
 * @param {Array<{amount:number, allocation?:('value'|'qty')}>} costs
 * @returns {{lines:Array<{qty:number, unitPrice:number, baseAmount:number,
 *   allocated:number, landedAmount:number, landedUnitCost:number}>,
 *   totalBase:number, totalAllocated:number, totalLanded:number}}
 */
function allocateLandedCosts(lines, costs) {
  const rows = (lines || []).map((l) => {
    const qty = num(l.qty);
    const unitPrice = num(l.unitPrice);
    return { qty, unitPrice, baseAmount: round2(qty * unitPrice), allocated: 0 };
  });

  const totalBase = round2(rows.reduce((a, r) => a + r.baseAmount, 0));
  const totalQty = round2(rows.reduce((a, r) => a + r.qty, 0));

  for (const cost of costs || []) {
    const amount = round2(cost.amount);
    if (amount <= 0) continue;
    const byQty = String(cost.allocation || 'value').toLowerCase() === 'qty';
    const basis = byQty ? totalQty : totalBase;

    // Nothing to spread over: a receipt of zero value or zero quantity cannot
    // absorb a cost, so it is left unallocated rather than divided by zero.
    if (basis <= 0) continue;

    let running = 0;
    let lastIndex = -1;
    rows.forEach((r, i) => {
      const share = byQty ? r.qty : r.baseAmount;
      if (share <= 0) return;
      const portion = round2((share / basis) * amount);
      r.allocated = round2(r.allocated + portion);
      running = round2(running + portion);
      lastIndex = i;
    });
    // Rounding remainder goes to the last line that took a share, so the sum of
    // the parts is always exactly the whole.
    const remainder = round2(amount - running);
    if (remainder !== 0 && lastIndex >= 0) {
      rows[lastIndex].allocated = round2(rows[lastIndex].allocated + remainder);
    }
  }

  const out = rows.map((r) => {
    const landedAmount = round2(r.baseAmount + r.allocated);
    return {
      qty: r.qty,
      unitPrice: r.unitPrice,
      baseAmount: r.baseAmount,
      allocated: r.allocated,
      landedAmount,
      landedUnitCost: r.qty > 0 ? round2(landedAmount / r.qty) : 0,
    };
  });

  return {
    lines: out,
    totalBase,
    totalAllocated: round2(out.reduce((a, r) => a + r.allocated, 0)),
    totalLanded: round2(out.reduce((a, r) => a + r.landedAmount, 0)),
  };
}

/**
 * Fold a receipt into an existing stock balance at weighted average.
 *
 * Edge cases that matter in a real store room:
 *  - no stock on hand  -> the new cost simply becomes the cost;
 *  - negative stock    -> the old balance is meaningless, so the new cost wins
 *                         rather than producing a nonsense average;
 *  - zero incoming qty -> nothing changes.
 *
 * @param {object} p
 * @param {number} p.onHandQty
 * @param {number} p.onHandCost  current unit cost
 * @param {number} p.receiptQty
 * @param {number} p.receiptUnitCost landed unit cost
 * @returns {{qty:number, unitCost:number, value:number}}
 */
function weightedAverage(p) {
  const onHandQty = num(p && p.onHandQty);
  const onHandCost = num(p && p.onHandCost);
  const receiptQty = num(p && p.receiptQty);
  const receiptUnitCost = num(p && p.receiptUnitCost);

  if (receiptQty <= 0) {
    return { qty: round2(onHandQty), unitCost: round2(onHandCost), value: round2(onHandQty * onHandCost) };
  }
  const newQty = round2(onHandQty + receiptQty);
  if (onHandQty <= 0) {
    return { qty: newQty, unitCost: round2(receiptUnitCost), value: round2(newQty * receiptUnitCost) };
  }
  const value = round2(onHandQty * onHandCost + receiptQty * receiptUnitCost);
  const unitCost = newQty > 0 ? round2(value / newQty) : round2(receiptUnitCost);
  return { qty: newQty, unitCost, value: round2(newQty * unitCost) };
}

/**
 * Compare ordered / received / billed quantities — the three-way match.
 *
 * @param {number} ordered
 * @param {number} received
 * @param {number} billed
 * @param {number} [tolerance=0]
 * @returns {{status:string, overReceived:number, overBilled:number, matched:boolean}}
 */
function threeWayMatch(ordered, received, billed, tolerance = 0) {
  const o = round2(ordered);
  const r = round2(received);
  const b = round2(billed);
  const overReceived = round2(Math.max(0, r - o - tolerance));
  const overBilled = round2(Math.max(0, b - r - tolerance));

  let status = 'matched';
  if (overBilled > 0) status = 'over-billed';
  else if (overReceived > 0) status = 'over-received';
  else if (b < r - tolerance) status = 'under-billed';
  else if (r < o - tolerance) status = 'part-received';

  return { status, overReceived, overBilled, matched: status === 'matched' };
}

/**
 * Split outstanding balances into ageing buckets from a reference date.
 * @param {Array<{date:string, amount:number}>} items due dates and balances
 * @param {string} asAt `YYYY-MM-DD`
 * @returns {{current:number, d30:number, d60:number, d90:number, older:number, total:number}}
 */
function ageing(items, asAt) {
  const ref = new Date(`${String(asAt || '').slice(0, 10)}T00:00:00Z`);
  const out = { current: 0, d30: 0, d60: 0, d90: 0, older: 0, total: 0 };
  if (Number.isNaN(ref.getTime())) return out;

  for (const item of items || []) {
    const amount = round2(item.amount);
    if (amount === 0) continue;
    const due = new Date(`${String(item.date || '').slice(0, 10)}T00:00:00Z`);
    const days = Number.isNaN(due.getTime()) ? 0 : Math.floor((ref - due) / 86400000);
    if (days <= 0) out.current = round2(out.current + amount);
    else if (days <= 30) out.d30 = round2(out.d30 + amount);
    else if (days <= 60) out.d60 = round2(out.d60 + amount);
    else if (days <= 90) out.d90 = round2(out.d90 + amount);
    else out.older = round2(out.older + amount);
    out.total = round2(out.total + amount);
  }
  return out;
}

module.exports = { allocateLandedCosts, weightedAverage, threeWayMatch, ageing };
