'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_OUTSIDE_COST_RATIO,
  jobProfit,
  pctOf,
  outsideCostRatio,
  outsideCostUnit,
  jobProfitAnalysis,
  materialCostOf,
  normaliseSpec,
  sizeInchFromCode,
  tierValueOf,
  matchRate,
  matchFitting,
  compareLine,
} = require('../lib/finance');
const { RATECARD_SEED } = require('../lib/ratecardSeed');
const { round2 } = require('../lib/money');

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

test('pctOf: null when there is no base', () => {
  assert.equal(pctOf(25, 200), 12.5);
  assert.equal(pctOf(25, 0), null);
  assert.equal(pctOf(-40, 100), -40);
});

test('outsideCostRatio: median Low/Mid of the card, constant when empty', () => {
  // Low/Mid of 0.4, 0.5, 0.6 -> median 0.5.
  const rates = [
    { outsideLow: 40, outsideMid: 100 },
    { outsideLow: 50, outsideMid: 100 },
    { outsideLow: 60, outsideMid: 100 },
  ];
  assert.equal(outsideCostRatio(rates), 0.5);
  // Even count -> mean of the middle pair; unpriced rows are ignored.
  assert.equal(outsideCostRatio([...rates.slice(0, 2), { outsideLow: 0, outsideMid: 0 }]), 0.45);
  assert.equal(outsideCostRatio([]), DEFAULT_OUTSIDE_COST_RATIO);
  assert.equal(outsideCostRatio(null), DEFAULT_OUTSIDE_COST_RATIO);
  // The seeded card sits in a believable trade band.
  const seeded = outsideCostRatio(RATECARD_SEED);
  assert.ok(seeded > 0.3 && seeded < 0.8, `seeded ratio out of band: ${seeded}`);
});

test('outsideCostUnit: item price beats Rate Card beats a derived estimate', () => {
  const rate = { outsideLow: 700, outsideMid: 1200 };

  assert.deepEqual(outsideCostUnit({ marketLow: 640, rate, marketMid: 1200, ratio: 0.5 }), { unit: 640, basis: 'item' });
  assert.deepEqual(outsideCostUnit({ rate, marketMid: 1200, ratio: 0.5 }), { unit: 700, basis: 'ratecard' });
  assert.deepEqual(outsideCostUnit({ marketMid: 1200, ratio: 0.5 }), { unit: 600, basis: 'derived' });
  // No ratio supplied -> the documented constant, still flagged as derived.
  assert.deepEqual(outsideCostUnit({ marketMid: 1000 }), { unit: round2(1000 * DEFAULT_OUTSIDE_COST_RATIO), basis: 'derived' });
  // Nothing to go on at all.
  assert.deepEqual(outsideCostUnit({}), { unit: 0, basis: 'none' });
  // A zero/blank Rate Card Low must not be mistaken for a real trade price.
  assert.equal(outsideCostUnit({ rate: { outsideLow: 0 }, marketMid: 1000, ratio: 0.5 }).basis, 'derived');
});

test('jobProfitAnalysis: the three comparisons of a healthy job', () => {
  // Bought at 4,000 what would have cost 6,000 locally; billed 9,000 where the
  // market would have billed 12,000.
  const a = jobProfitAnalysis({ ourCost: 4000, ourPrice: 9000, outsideCost: 6000, outsidePrice: 12000 });

  // (1) buying
  assert.equal(a.sourcing.gain, 2000);
  assert.equal(a.sourcing.gainPct, 33.33);
  assert.equal(a.sourcing.verdict, 'gain');
  // (1) P&L compare — same revenue, only the sourcing changes.
  assert.equal(a.sourcing.pl.revenue, 9000);
  assert.equal(a.sourcing.pl.ourProfit, 5000);
  assert.equal(a.sourcing.pl.outsideProfit, 3000);
  assert.equal(a.sourcing.pl.profitDelta, 2000);
  assert.equal(a.sourcing.pl.ourMarginPct, 55.56);
  assert.equal(a.sourcing.pl.outsideMarginPct, 33.33);

  // (2) selling
  assert.equal(a.pricing.customerSaving, 3000);
  assert.equal(a.pricing.customerSavingPct, 25);
  assert.equal(a.pricing.verdict, 'below');

  // (3) earning
  assert.equal(a.margin.grossProfit, 5000);
  assert.equal(a.margin.grossMarginPct, 55.56);
  assert.equal(a.margin.markupPct, 125);
  assert.equal(a.margin.verdict, 'profit');

  // The three reconcile: advantage = sourcing gain − customer saving.
  assert.equal(a.bridge.outsideProfit, 6000);
  assert.equal(a.bridge.advantage, -1000);
  assert.equal(a.bridge.advantage, round2(a.bridge.sourcingGain - a.bridge.customerSaving));
});

test('jobProfitAnalysis: losses and over-market pricing are named, not hidden', () => {
  // Paid more than the local market, and billed above it too.
  const a = jobProfitAnalysis({ ourCost: 7000, ourPrice: 6500, outsideCost: 5000, outsidePrice: 6000 });
  assert.equal(a.sourcing.gain, -2000);
  assert.equal(a.sourcing.verdict, 'loss');
  assert.equal(a.pricing.customerSaving, -500);
  assert.equal(a.pricing.verdict, 'above');
  assert.equal(a.margin.grossProfit, -500);
  assert.equal(a.margin.verdict, 'loss');
  assert.equal(a.bridge.advantage, round2(a.bridge.sourcingGain - a.bridge.customerSaving));
});

test('jobProfitAnalysis: no benchmarks -> null percentages, never a fake 0%', () => {
  const a = jobProfitAnalysis({ ourCost: 0, ourPrice: 0, outsideCost: 0, outsidePrice: 0 });
  assert.equal(a.sourcing.gainPct, null);
  assert.equal(a.pricing.customerSavingPct, null);
  assert.equal(a.margin.grossMarginPct, null);
  assert.equal(a.margin.markupPct, null);
  assert.equal(a.margin.verdict, 'break-even');
  assert.equal(a.sourcing.verdict, 'even');
  assert.equal(a.pricing.verdict, 'level');
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
