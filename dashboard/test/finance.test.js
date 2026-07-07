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
  matchRate,
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

test('matchRate finds the seeded row', () => {
  const m = matchRate(RATECARD_SEED, { productName: 'Rubber pipe R2', specCode: '13' });
  assert.ok(m);
  assert.equal(m.label, '1/2" R2');
  assert.equal(m.outsidePrice, 1600);
  assert.equal(matchRate(RATECARD_SEED, { productName: 'Fitting', specCode: '13' }), null);
  assert.equal(matchRate(RATECARD_SEED, { productName: 'Rubber pipe R2', specCode: '99' }), null);
});

test('compareLine converts metres->feet and applies per-foot rates', () => {
  const rate = { spec: 'R2', sizeInch: 0.5, ourCost: 744, ourPrice: 1200, outsidePrice: 1600 };
  const r = compareLine({ qty: 2 }, rate); // 2 m -> feet rounded to 6.56 for a consistent table
  assert.equal(r.matched, true);
  assert.equal(r.feet, 6.56);
  assert.equal(r.ourCost, 4880.64); // 6.56 * 744
  assert.equal(r.ourPrice, 7872); // 6.56 * 1200
  assert.equal(r.outsidePrice, 10496); // 6.56 * 1600
});

test('compareLine unmatched falls back to billed amount', () => {
  const r = compareLine({ qty: 5, ourAmount: 1234.5 }, null);
  assert.equal(r.matched, false);
  assert.equal(r.outsidePrice, 0);
  assert.equal(r.ourPrice, 1234.5);
});

test('rate card seed is internally consistent', () => {
  assert.equal(RATECARD_SEED.length, 15);
  for (const r of RATECARD_SEED) {
    assert.ok(r.ourCost < r.ourPrice, `${r.label}: cost should be below price`);
    assert.ok(r.ourPrice < r.outsidePrice, `${r.label}: our price should undercut outside`);
    assert.ok(['R1', 'R2', '4SP', '4SH'].includes(r.spec));
  }
});
