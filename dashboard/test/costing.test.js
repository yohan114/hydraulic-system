'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateLandedCosts, weightedAverage, threeWayMatch, ageing } = require('../lib/costing');

test('landed cost spreads by value and the parts sum to the whole', () => {
  // 100 + 300 = 400 of goods; 40 of freight -> 25% / 75%.
  const r = allocateLandedCosts(
    [{ qty: 10, unitPrice: 10 }, { qty: 10, unitPrice: 30 }],
    [{ amount: 40, allocation: 'value' }]
  );
  assert.equal(r.totalBase, 400);
  assert.equal(r.totalAllocated, 40);
  assert.equal(r.totalLanded, 440);
  assert.equal(r.lines[0].allocated, 10);
  assert.equal(r.lines[1].allocated, 30);
  assert.equal(r.lines[0].landedUnitCost, 11);
  assert.equal(r.lines[1].landedUnitCost, 33);
});

test('landed cost can spread by quantity instead of value', () => {
  // Container space is per unit, not per rupee: 30 units, 60 of cost -> 2 each.
  const r = allocateLandedCosts(
    [{ qty: 10, unitPrice: 100 }, { qty: 20, unitPrice: 5 }],
    [{ amount: 60, allocation: 'qty' }]
  );
  assert.equal(r.lines[0].allocated, 20);
  assert.equal(r.lines[1].allocated, 40);
  assert.equal(r.totalAllocated, 60);
});

test('a rounding remainder never leaks — allocated always equals the cost', () => {
  // Three equal lines and 10.00 of duty cannot divide evenly.
  const r = allocateLandedCosts(
    [{ qty: 1, unitPrice: 1 }, { qty: 1, unitPrice: 1 }, { qty: 1, unitPrice: 1 }],
    [{ amount: 10, allocation: 'value' }]
  );
  assert.equal(r.totalAllocated, 10, 'the parts must sum to exactly the whole');
  assert.equal(r.lines[0].allocated + r.lines[1].allocated + r.lines[2].allocated, 10);
});

test('several landed costs stack, each on its own basis', () => {
  const r = allocateLandedCosts(
    [{ qty: 10, unitPrice: 10 }, { qty: 10, unitPrice: 30 }],
    [{ amount: 40, allocation: 'value' }, { amount: 20, allocation: 'qty' }]
  );
  // Freight by value (10 / 30) plus clearing by qty (10 / 10).
  assert.equal(r.lines[0].allocated, 20);
  assert.equal(r.lines[1].allocated, 40);
  assert.equal(r.totalAllocated, 60);
  assert.equal(r.totalLanded, 460);
});

test('a receipt with no value or no quantity absorbs nothing rather than dividing by zero', () => {
  const noValue = allocateLandedCosts([{ qty: 5, unitPrice: 0 }], [{ amount: 100, allocation: 'value' }]);
  assert.equal(noValue.totalAllocated, 0);
  assert.ok(Number.isFinite(noValue.lines[0].landedUnitCost));

  const noQty = allocateLandedCosts([{ qty: 0, unitPrice: 10 }], [{ amount: 100, allocation: 'qty' }]);
  assert.equal(noQty.totalAllocated, 0);
  assert.equal(noQty.lines[0].landedUnitCost, 0, 'no quantity means no per-unit cost, not Infinity');
});

test('weighted average blends an existing balance with a new receipt', () => {
  // 10 @ 100 plus 10 @ 200 -> 20 @ 150.
  const r = weightedAverage({ onHandQty: 10, onHandCost: 100, receiptQty: 10, receiptUnitCost: 200 });
  assert.equal(r.qty, 20);
  assert.equal(r.unitCost, 150);
  assert.equal(r.value, 3000);
});

test('weighted average handles an empty, negative or zero-quantity store room', () => {
  const empty = weightedAverage({ onHandQty: 0, onHandCost: 0, receiptQty: 5, receiptUnitCost: 355 });
  assert.equal(empty.unitCost, 355);
  assert.equal(empty.qty, 5);

  // A negative balance is broken data; the incoming cost wins over nonsense.
  const negative = weightedAverage({ onHandQty: -3, onHandCost: 999, receiptQty: 5, receiptUnitCost: 100 });
  assert.equal(negative.unitCost, 100);

  const nothingIn = weightedAverage({ onHandQty: 8, onHandCost: 50, receiptQty: 0, receiptUnitCost: 900 });
  assert.equal(nothingIn.qty, 8);
  assert.equal(nothingIn.unitCost, 50, 'a zero receipt must not move the cost');
});

test('three-way match names each way a purchase can disagree', () => {
  assert.equal(threeWayMatch(10, 10, 10).status, 'matched');
  assert.equal(threeWayMatch(10, 10, 10).matched, true);
  assert.equal(threeWayMatch(10, 4, 4).status, 'part-received');
  assert.equal(threeWayMatch(10, 12, 12).status, 'over-received');
  assert.equal(threeWayMatch(10, 10, 12).status, 'over-billed');
  assert.equal(threeWayMatch(10, 10, 12).overBilled, 2);
  assert.equal(threeWayMatch(10, 10, 6).status, 'under-billed');
  // A tolerance absorbs a small overage rather than flagging it.
  assert.equal(threeWayMatch(10, 10.05, 10.05, 0.1).status, 'matched');
});

test('ageing drops each balance into the right bucket', () => {
  const a = ageing([
    { date: '2026-08-25', amount: 1000 },   // not yet due
    { date: '2026-08-01', amount: 500 },    // 19 days
    { date: '2026-07-01', amount: 300 },    // 50 days
    { date: '2026-05-20', amount: 200 },    // 92 days
  ], '2026-08-20');
  assert.equal(a.current, 1000);
  assert.equal(a.d30, 500);
  assert.equal(a.d60, 300);
  assert.equal(a.older, 200);
  assert.equal(a.total, 2000);
});

test('ageing ignores zero balances and survives a bad date', () => {
  assert.equal(ageing([{ date: '2026-08-01', amount: 0 }], '2026-08-20').total, 0);
  assert.equal(ageing([{ date: 'not-a-date', amount: 100 }], '2026-08-20').current, 100);
  assert.equal(ageing([{ date: '2026-08-01', amount: 100 }], 'rubbish').total, 0);
});
