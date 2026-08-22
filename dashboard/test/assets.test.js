'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { monthsInService, monthlyCharge, runPeriod, stockValue, stockTakeVariance } = require('../lib/assets');

const CRIMPER = { assetId: 1, name: 'Crimping machine', cost: 480000, residual: 0, lifeMonths: 60, inServiceFrom: '2026-01-01' };

test('months in service counts from the month it was commissioned', () => {
  assert.equal(monthsInService('2026-01-01', '2026-01'), 1);
  assert.equal(monthsInService('2026-01-01', '2026-08'), 8);
  assert.equal(monthsInService('2026-08-15', '2026-08'), 1);
  assert.equal(monthsInService('2026-09-01', '2026-08'), 0, 'not yet in service');
  assert.equal(monthsInService('', '2026-08'), 0);
});

test('straight line charges the same amount each month', () => {
  const r = monthlyCharge({ ...CRIMPER, accumulated: 0 }, '2026-08');
  assert.equal(r.charge, 8000);            // 480,000 over 60 months
  assert.equal(r.accumulatedAfter, 8000);
  assert.equal(r.netBookValue, 472000);
  assert.equal(r.fullyDepreciated, false);
});

test('residual value is never depreciated away', () => {
  const r = monthlyCharge({ ...CRIMPER, residual: 60000, accumulated: 0 }, '2026-08');
  assert.equal(r.charge, 7000);            // (480,000 - 60,000) / 60
  const nearlyDone = monthlyCharge({ ...CRIMPER, residual: 60000, accumulated: 419000 }, '2026-08');
  assert.equal(nearlyDone.charge, 1000, 'the last charge stops exactly at residual');
  assert.equal(nearlyDone.netBookValue, 60000);
});

test('a fully depreciated asset stops charging instead of going negative', () => {
  const r = monthlyCharge({ ...CRIMPER, accumulated: 480000 }, '2026-08');
  assert.equal(r.charge, 0);
  assert.equal(r.fullyDepreciated, true);
  assert.match(r.reason, /already fully depreciated/);
  assert.equal(r.netBookValue, 0);
});

test('the final month absorbs the rounding so the total is exact', () => {
  // 1000 over 3 months does not divide evenly: 333.33 + 333.33 + 333.34.
  const asset = { cost: 1000, residual: 0, lifeMonths: 3, inServiceFrom: '2026-01-01' };
  const m1 = monthlyCharge({ ...asset, accumulated: 0 }, '2026-01');
  const m2 = monthlyCharge({ ...asset, accumulated: m1.accumulatedAfter }, '2026-02');
  const m3 = monthlyCharge({ ...asset, accumulated: m2.accumulatedAfter }, '2026-03');
  assert.equal(m1.charge, 333.33);
  assert.equal(m2.charge, 333.33);
  assert.equal(m3.charge, 333.34, 'the last month picks up the remainder');
  assert.equal(m1.charge + m2.charge + m3.charge, 1000);
  assert.equal(m3.fullyDepreciated, true);
});

test('assets with no life, nothing to depreciate, or not yet in service are skipped', () => {
  assert.match(monthlyCharge({ ...CRIMPER, lifeMonths: 0, accumulated: 0 }, '2026-08').reason, /no useful life/);
  assert.match(monthlyCharge({ ...CRIMPER, residual: 480000, accumulated: 0 }, '2026-08').reason, /nothing to depreciate/);
  assert.match(monthlyCharge({ ...CRIMPER, inServiceFrom: '2027-01-01', accumulated: 0 }, '2026-08').reason, /not yet in service/);
});

test('a period run totals the charges and explains what it skipped', () => {
  const r = runPeriod([
    { ...CRIMPER, accumulated: 0 },
    { assetId: 2, name: 'Old press', cost: 50000, residual: 0, lifeMonths: 24, inServiceFrom: '2020-01-01', accumulated: 50000 },
    { assetId: 3, name: 'New bench', cost: 12000, residual: 0, lifeMonths: 24, inServiceFrom: '2027-01-01', accumulated: 0 },
  ], '2026-08');
  assert.equal(r.lines.length, 1);
  assert.equal(r.total, 8000);
  assert.equal(r.skipped.length, 2);
  assert.deepEqual(r.skipped.map((s) => s.assetId).sort(), [2, 3]);
});

test('stock valuation groups by category and flags negative stock', () => {
  const r = stockValue([
    { qty: 10, cost: 355, category: 'Hose' },
    { qty: 5, cost: 100, category: 'Hose' },
    { qty: 20, cost: 50, category: 'Union' },
    { qty: -2, cost: 80, category: 'Union' },
    { qty: 3, cost: 10 },
  ]);
  assert.equal(r.total, 4920);            // 3550 + 500 + 1000 - 160 + 30
  assert.equal(r.byCategory[0].category, 'Hose');
  assert.equal(r.byCategory[0].value, 4050);
  assert.equal(r.byCategory.find((c) => c.category === 'Uncategorised').value, 30);
  assert.equal(r.negative.length, 1, 'negative stock is a data problem worth surfacing');
});

test('a stock take separates shortages from overages', () => {
  const r = stockTakeVariance([
    { inventoryId: 1, systemQty: 100, countedQty: 96, cost: 355 },   // 4 short
    { inventoryId: 2, systemQty: 20, countedQty: 23, cost: 100 },    // 3 over
    { inventoryId: 3, systemQty: 5, countedQty: 5, cost: 900 },      // agrees
  ]);
  assert.equal(r.lines[0].qtyDiff, -4);
  assert.equal(r.lines[0].valueDiff, -1420);
  assert.equal(r.lines[1].valueDiff, 300);
  assert.equal(r.lines[2].valueDiff, 0);
  assert.equal(r.shortages, -1420);
  assert.equal(r.overages, 300);
  assert.equal(r.totalVariance, -1120);
});
