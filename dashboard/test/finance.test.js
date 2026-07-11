'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  jobProfit,
  monthlyPL,
  cashFlow,
  materialCostOf,
  normaliseSpec,
  sizeInchFromCode,
  tierValueOf,
  matchRate,
  matchFitting,
  compareLine,
} = require('../lib/finance');
const { RATECARD_SEED } = require('../lib/ratecardSeed');

test('jobProfit: gross and net with margins', () => {
  const r = jobProfit({ revenueExTax: 10000, materialCost: 6000, labourCost: 1500 });
  assert.equal(r.grossProfit, 4000);
  assert.equal(r.netProfit, 2500);
  assert.equal(r.grossMarginPct, 40);
  assert.equal(r.netMarginPct, 25);
});

test('jobProfit: zero revenue -> null margins, negatives allowed', () => {
  const r = jobProfit({ revenueExTax: 0, materialCost: 0 });
  assert.equal(r.grossMarginPct, null);
  const loss = jobProfit({ revenueExTax: 1000, materialCost: 1400 });
  assert.equal(loss.grossProfit, -400);
  assert.equal(loss.grossMarginPct, -40);
});

test('monthlyPL: revenue - cogs - labour - expenses', () => {
  const r = monthlyPL({ revenue: 500000, cogs: 300000, labour: 90000, expenses: 40000 });
  assert.equal(r.grossProfit, 200000);
  assert.equal(r.totalCosts, 430000);
  assert.equal(r.netProfit, 70000);
  assert.equal(r.grossMarginPct, 40);
  assert.equal(r.netMarginPct, 14);
});

test('cashFlow: in vs out', () => {
  assert.deepEqual(cashFlow({ paymentsIn: 120000, labourOut: 90000, expensesOut: 15000 }), {
    inflow: 120000, outflow: 105000, net: 15000,
  });
});

test('materialCostOf sums qty*cost accurately', () => {
  assert.equal(materialCostOf([{ qty: 3, cost: 520 }, { qty: 4, cost: 300 }, { qty: 1, cost: 0 }]), 2760);
  assert.equal(materialCostOf([]), 0);
});

test('normaliseSpec picks the right family', () => {
  assert.equal(normaliseSpec('Rubber pipe R2'), 'R2');
  assert.equal(normaliseSpec('Rubber pipe R1'), 'R1');
  assert.equal(normaliseSpec('Spiral 4SH hose'), '4SH');
  assert.equal(normaliseSpec('4SP high pressure'), '4SP');
  assert.equal(normaliseSpec('Fitting BSP'), null);
  // 4SH must win over the R inside "…4SH…" (contains no R token anyway)
  assert.equal(normaliseSpec('R2 something 4SH'), '4SH');
});

test('sizeInchFromCode maps mm bore to inches', () => {
  assert.equal(sizeInchFromCode('13'), 0.5);
  assert.equal(sizeInchFromCode('25'), 1.0);
  assert.equal(sizeInchFromCode('99'), undefined);
});

test('matchRate finds the seeded hose row (not fittings)', () => {
  const m = matchRate(RATECARD_SEED, { productName: 'Rubber pipe R2', specCode: '13' });
  assert.ok(m);
  assert.equal(m.category, 'hose');
  assert.equal(m.label, '1/2" R2 (2-wire)');
  assert.equal(m.outsideMid, 1950);
  assert.equal(matchRate(RATECARD_SEED, { productName: 'Fitting BSP', specCode: '13' }), null);
  assert.equal(matchRate(RATECARD_SEED, { productName: 'Rubber pipe R2', specCode: '99' }), null);
});

test('matchFitting matches hose-end lines by size', () => {
  const m = matchFitting(RATECARD_SEED, { productName: 'Hydraulic fitting BSP', specCode: '13' });
  assert.ok(m);
  assert.equal(m.category, 'fitting');
  assert.equal(m.sizeInch, 0.5);
  // A hose line must NOT be treated as a fitting.
  assert.equal(matchFitting(RATECARD_SEED, { productName: 'Rubber pipe R2', specCode: '13' }), null);
});

test('tierValueOf selects the right band (falls back to legacy)', () => {
  const rate = { outsideLow: 100, outsideMid: 200, outsideHigh: 300 };
  assert.equal(tierValueOf(rate, 'low'), 100);
  assert.equal(tierValueOf(rate, 'mid'), 200);
  assert.equal(tierValueOf(rate, 'high'), 300);
  assert.equal(tierValueOf(rate), 200); // default mid
  assert.equal(tierValueOf({ outsidePrice: 1600 }, 'high'), 1600); // legacy single price
});

test('compareLine is per-unit (no ft conversion) and tier-aware', () => {
  const rate = { unit: 'm', ourCost: 1170, ourPrice: 1560, outsideLow: 1075, outsideMid: 1950, outsideHigh: 3900 };
  const mid = compareLine({ qty: 2 }, rate); // 2 metres
  assert.equal(mid.matched, true);
  assert.equal(mid.qty, 2);
  assert.equal(mid.unit, 'm');
  assert.equal(mid.ourCost, 2340); // 2 * 1170
  assert.equal(mid.ourPrice, 3120); // 2 * 1560
  assert.equal(mid.outsidePrice, 3900); // 2 * 1950 (mid)
  assert.equal(compareLine({ qty: 2 }, rate, 'low').outsidePrice, 2150); // 2 * 1075
  assert.equal(compareLine({ qty: 2 }, rate, 'high').outsidePrice, 7800); // 2 * 3900
});

test('compareLine unmatched falls back to billed amount', () => {
  const r = compareLine({ qty: 5, ourAmount: 1234.5 }, null);
  assert.equal(r.matched, false);
  assert.equal(r.outsidePrice, 0);
  assert.equal(r.ourPrice, 1234.5);
});

test('tiered rate card seed is internally consistent', () => {
  assert.equal(RATECARD_SEED.length, 27);
  const cats = new Set();
  for (const r of RATECARD_SEED) {
    cats.add(r.category);
    assert.ok(['hose', 'fitting', 'crimping'].includes(r.category), `${r.label}: bad category`);
    assert.ok(r.outsideLow <= r.outsideMid && r.outsideMid <= r.outsideHigh, `${r.label}: tiers must ascend`);
    assert.ok(r.ourCost < r.ourPrice, `${r.label}: cost below price`);
    // Hose/fitting undercut the market (price at/below Mid); crimping is billed at
    // the market High tier, so its ceiling is High rather than Mid.
    const ceiling = r.category === 'crimping' ? r.outsideHigh : r.outsideMid;
    assert.ok(r.ourPrice <= ceiling, `${r.label}: our price should not exceed the outside ceiling`);
    assert.ok(['m', 'end'].includes(r.unit), `${r.label}: unit`);
  }
  assert.deepEqual([...cats].sort(), ['crimping', 'fitting', 'hose']);
});
