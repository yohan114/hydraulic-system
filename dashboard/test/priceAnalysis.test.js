'use strict';

// Point ../db (required transitively by the service) at a throwaway file so no
// real database is touched; only the pure computeLineMetrics is exercised here.
const path = require('path');
const os = require('os');
process.env.HYDRAULIC_DB = path.join(os.tmpdir(), 'hydraulic-priceanalysis-test.db');

const test = require('node:test');
const assert = require('node:assert');
const { computeLineMetrics, lineSnapshot } = require('../services/priceAnalysis');

test('healthy margin -> ok', () => {
  const m = computeLineMetrics({ unitCost: 100, ourRate: 200, marketRate: 250, qty: 3 });
  assert.strictEqual(m.priceFlag, 'ok');
  assert.strictEqual(m.profitAmount, 300);   // (200-100)*3
  assert.strictEqual(m.marginPercent, 50);   // (200-100)/200
  assert.strictEqual(m.marketGap, -150);     // (200-250)*3 -> under market
});

test('billed below cost -> below-cost (critical)', () => {
  const m = computeLineMetrics({ unitCost: 300, ourRate: 200, marketRate: 400, qty: 2 });
  assert.strictEqual(m.priceFlag, 'below-cost');
  assert.strictEqual(m.profitAmount, -200);  // loss
  assert.ok(m.marginPercent < 0);
});

test('billed above market -> over-market', () => {
  const m = computeLineMetrics({ unitCost: 100, ourRate: 500, marketRate: 300, qty: 1 });
  assert.strictEqual(m.priceFlag, 'over-market');
  assert.strictEqual(m.marketGap, 200);      // (500-300)*1 -> above market
});

test('thin margin under threshold -> low-margin', () => {
  const m = computeLineMetrics({ unitCost: 90, ourRate: 100, marketRate: 120, qty: 1 });
  assert.strictEqual(m.priceFlag, 'low-margin'); // 10% < 15% default
  assert.strictEqual(m.marginPercent, 10);
});

test('low-margin threshold is configurable', () => {
  const strict = computeLineMetrics({ unitCost: 80, ourRate: 100, marketRate: 120, qty: 1, lowMarginThreshold: 25 });
  assert.strictEqual(strict.priceFlag, 'low-margin'); // 20% < 25%
  const lenient = computeLineMetrics({ unitCost: 80, ourRate: 100, marketRate: 120, qty: 1, lowMarginThreshold: 15 });
  assert.strictEqual(lenient.priceFlag, 'ok');        // 20% >= 15%
});

test('below-cost outranks over-market', () => {
  // rate below cost AND above market -> below-cost wins (money loss is worse)
  const m = computeLineMetrics({ unitCost: 300, ourRate: 250, marketRate: 200, qty: 1 });
  assert.strictEqual(m.priceFlag, 'below-cost');
});

test('service line with no cost/market -> ok, full profit', () => {
  const m = computeLineMetrics({ unitCost: 0, ourRate: 1500, marketRate: 0, qty: 1 });
  assert.strictEqual(m.priceFlag, 'ok');
  assert.strictEqual(m.profitAmount, 1500);
  assert.strictEqual(m.marginPercent, 100);
});

test('zero rate is handled without dividing by zero', () => {
  // rate 0 with a real cost is genuinely below cost (given away); margin math
  // must not divide by zero.
  const m = computeLineMetrics({ unitCost: 50, ourRate: 0, marketRate: 0, qty: 1 });
  assert.strictEqual(m.marginPercent, 0);      // no NaN/Infinity
  assert.strictEqual(m.priceFlag, 'below-cost');
});

test('fully zero line (no cost, no rate) -> ok', () => {
  const m = computeLineMetrics({ unitCost: 0, ourRate: 0, marketRate: 0, qty: 1 });
  assert.strictEqual(m.marginPercent, 0);
  assert.strictEqual(m.priceFlag, 'ok');
});

test('lineSnapshot returns the full stored column set, rounded', () => {
  const s = lineSnapshot({ unitCost: 100.005, ourRate: 200, marketRate: 250, qty: 2 });
  assert.deepStrictEqual(Object.keys(s).sort(), [
    'marginPercent', 'marketBillRate', 'marketGap', 'ourBillRate', 'priceFlag',
    'pricingRuleApplied', 'pricingSource', 'profitAmount', 'suggestedBillRate', 'unitCostAtBilling',
  ]);
  assert.strictEqual(s.unitCostAtBilling, 100.01);
  assert.strictEqual(s.ourBillRate, 200);
  // Suggested = max(cost, 250 × 0.80 = 200) = 200 (per unit).
  assert.strictEqual(s.suggestedBillRate, 200);
  assert.strictEqual(s.pricingSource, 'inventory');
  assert.strictEqual(s.pricingRuleApplied, 'marketMinus20');
});
