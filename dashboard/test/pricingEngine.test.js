'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const eng = require('../services/pricingEngine');
const imp = require('../services/pricingImport');

// ---- normalisation ----
test('normSize strips inch marks and whitespace', () => {
  assert.equal(eng.normSize('1/2"'), '1/2');
  assert.equal(eng.normSize('1-1/4"'), '1-1/4');
  assert.equal(eng.normSize('1"'), '1');
  assert.equal(eng.normSize(' 5/8 ” '), '5/8');
});

test('hoseKey composes grade + size', () => {
  assert.equal(eng.hoseKey('R2', '1/2"'), 'R2 1/2');
  assert.equal(eng.hoseKey('4sh', '1-1/4"'), '4SH 1-1/4');
});

test('parseHose pulls grade + size from messy descriptions', () => {
  assert.deepEqual(eng.parseHose('R2 hydraulic hose 5/8" (ID 16mm)'), { grade: 'R2', size: '5/8' });
  assert.deepEqual(eng.parseHose('EN856 4SH hydraulic hose, ID 25mm'), { grade: '4SH', size: '1' });
  assert.deepEqual(eng.parseHose('Rubber pipe R2 Fabric coverd hydraulic hose - 13'), { grade: 'R2', size: '1/2' });
  assert.equal(eng.parseHose('Technical charges'), null);
});

// ---- the 80% floored suggestion (≈20% below market) ----
test('suggestUnit = 80% of market mid when that is above cost', () => {
  assert.deepEqual(eng.suggestUnit(360, 850), { suggested: 680, floored: false, rule: 'marketMinus20' });
  assert.deepEqual(eng.suggestUnit(290, 650), { suggested: 520, floored: false, rule: 'marketMinus20' });
});

test('suggestUnit floors at cost when 80% mid drops below cost', () => {
  // 80% of 450 = 360 < cost 400 -> floored at 400
  assert.deepEqual(eng.suggestUnit(400, 450), { suggested: 400, floored: true, rule: 'costFloor' });
});

test('suggestUnit with no market falls back to cost', () => {
  assert.deepEqual(eng.suggestUnit(120, 0), { suggested: 120, floored: true, rule: 'costFloor' });
});

test('ferrule floor uses cost × 1.25 when it beats 80% market', () => {
  // 80% of 110 = 88; cost×1.25 = 125 -> ferrule floor wins
  assert.deepEqual(eng.suggestUnit(100, 110, { ferrule: true }), { suggested: 125, floored: true, rule: 'ferruleFloor' });
  // When 80% market clears the ferrule floor, market wins (marketMinus20)
  assert.deepEqual(eng.suggestUnit(100, 200, { ferrule: true }), { suggested: 160, floored: false, rule: 'marketMinus20' });
});

test('isFerrule detects sleeve spec codes', () => {
  assert.equal(eng.isFerrule('00210-10'), true);
  assert.equal(eng.isFerrule('00110-04'), true);
  assert.equal(eng.isFerrule('2SN'), true);
  assert.equal(eng.isFerrule('22611-04-04'), false); // union
  assert.equal(eng.isFerrule('10011N-06'), false);   // weld fitting
});

// ---- status classification ----
test('priceStatus classifies against cost + market mid', () => {
  assert.equal(eng.priceStatus({ cost: 100, rate: 80, marketMid: 1000 }), eng.STATUS.BELOW_COST);
  assert.equal(eng.priceStatus({ cost: 100, rate: 1100, marketMid: 1000 }), eng.STATUS.AT_ABOVE_MARKET);
  assert.equal(eng.priceStatus({ cost: 100, rate: 700, marketMid: 1000 }), eng.STATUS.BELOW_FLOOR); // < 800 floor
  assert.equal(eng.priceStatus({ cost: 100, rate: 900, marketMid: 1000 }), eng.STATUS.HEALTHY);     // between 800 and 1000
  // cost above the 80% floor -> at-cost-floor regime
  assert.equal(eng.priceStatus({ cost: 850, rate: 850, marketMid: 1000 }), eng.STATUS.AT_COST_FLOOR);
});

// ---- end-to-end against the committed master JSON ----
test('getPricingForItem prices crimping per end (default 2 ends)', () => {
  const r = eng.getPricingForItem({ type: 'crimping', hoseSize: '5/8"', ends: 2 });
  assert.equal(r.source, 'crimping-charges');
  assert.equal(r.suggestedUnit, 680);  // 850 x 0.80
  assert.equal(r.suggestedBill, 1360); // 680 x 2 ends
  assert.equal(r.marketMid, 1700);     // 850 x 2
  assert.equal(r.rule, 'marketMinus20');
});

test('getPricingForItem prices a fitting by spec code (outside benchmark wins)', () => {
  const r = eng.getPricingForItem({ type: 'fitting', specCode: '22611-04-04', qty: 3 });
  assert.equal(r.source, 'unit-prices');
  assert.equal(r.marketSource, 'outside-benchmark');
  assert.equal(r.costUnit, 138.48);
  assert.equal(r.marketUnit, 300); // outside 300 overrides the datasheet 620
  assert.equal(r.suggestedUnit, 240); // 300 x 0.80, still above cost
  assert.equal(r.suggestedBill, 720); // 240 x 3
  assert.equal(r.rule, 'marketMinus20');
});

test('getPricingForItem applies the ferrule floor for a ferrule spec code', () => {
  const r = eng.getPricingForItem({ type: 'fitting', specCode: '00210-10', qty: 1 });
  assert.equal(r.source, 'unit-prices');
  // 80% of 1054 = 843.2; cost×1.25 = 823.34 -> market still wins here
  assert.equal(r.suggestedUnit, 843.2);
  assert.equal(r.rule, 'marketMinus20');
});

test('getPricingForItem prices hose per metre (outside benchmark wins)', () => {
  const r = eng.getPricingForItem({ type: 'hose', description: 'R2 hydraulic hose 1/2"', length: 4 });
  assert.equal(r.source, 'hose-cost-market');
  assert.equal(r.marketSource, 'outside-benchmark');
  assert.equal(r.marketUnit, 2400); // outside 2400/m overrides the datasheet 1900
  assert.equal(r.suggestedUnit, 1920); // 2400 x 0.80
  assert.equal(r.suggestedBill, 7680); // 1920 x 4m
});

test('getPricingForItem returns a manual warning when nothing matches', () => {
  const r = eng.getPricingForItem({ type: 'fitting', specCode: 'NOPE-99' });
  assert.equal(r.source, 'manual');
  assert.equal(r.rule, 'manual');
  assert.match(r.warning, /No market benchmark/);
});

// ---- outside-company benchmark = priority-1 market source ----
test('outsideMarketForItem matches a union spec code from the benchmark list', () => {
  const r = eng.outsideMarketForItem({ specCode: '22611-04-04' });
  assert.equal(r.source, 'outside-benchmark');
  assert.equal(r.price, 300); // competitor counter price (datasheet mid was 620)
});

test('outsideMarketForItem matches hose by grade + size (2SN = R2)', () => {
  const r = eng.outsideMarketForItem({ hoseGrade: 'R2', hoseSize: '1/2"' });
  assert.equal(r.price, 2400); // outside per-metre (datasheet mid was 1900)
});

test('resolveMarket prefers the outside benchmark over the datasheet fallback', () => {
  const r = eng.resolveMarket({ specCode: '22611-04-04', fallbackMarket: 620 });
  assert.equal(r.marketPrice, 300);
  assert.equal(r.marketSource, 'outside-benchmark');
});

test('resolveMarket falls back to the datasheet when no outside match', () => {
  const r = eng.resolveMarket({ specCode: 'NOPE-1', fallbackMarket: 620 });
  assert.equal(r.marketPrice, 620);
  assert.equal(r.marketSource, 'datasheet-mid');
});

test('getPricingForItem uses the outside benchmark and suggests 80% of it', () => {
  const r = eng.getPricingForItem({ type: 'fitting', specCode: '22611-04-04', qty: 1 });
  assert.equal(r.marketSource, 'outside-benchmark');
  assert.equal(r.marketUnit, 300);
  assert.equal(r.suggestedUnit, 240); // 300 × 0.80, still above cost 138.48
});

// ---- crimping: wire-type (2-wire vs 4-wire) shop rates ----
test('wireTypeOf maps grades and literal wire strings', () => {
  assert.equal(eng.wireTypeOf('R2'), '2-wire');
  assert.equal(eng.wireTypeOf('2SN'), '2-wire');
  assert.equal(eng.wireTypeOf('1SN'), '2-wire');
  assert.equal(eng.wireTypeOf('4SH'), '4-wire');
  assert.equal(eng.wireTypeOf('4SP'), '4-wire');
  assert.equal(eng.wireTypeOf('spiral'), '4-wire');
  assert.equal(eng.wireTypeOf('4-wire'), '4-wire');
  assert.equal(eng.wireTypeOf('2-wire'), '2-wire');
});

test('getCrimpingPricing uses the 2-wire shop rate by default', () => {
  const r = eng.getCrimpingPricing({ hoseSize: '1/2"', hoseWireType: '2-wire', ends: 2 });
  assert.equal(r.internalCostPerEnd, 336.33);
  assert.equal(r.marketPerEnd, 600);   // 2-wire 1/2"
  assert.equal(r.billedPerEnd, 600);   // default = market
  assert.equal(r.internalCostTotal, 672.66);
  assert.equal(r.marketTotal, 1200);
  assert.equal(r.billedTotal, 1200);
  assert.equal(r.warning, null);
});

test('getCrimpingPricing uses the 4-wire shop rate when selected', () => {
  const r = eng.getCrimpingPricing({ hoseSize: '1/2"', hoseWireType: '4-wire', ends: 2 });
  assert.equal(r.marketPerEnd, 800);   // 4-wire 1/2" (2-wire was 600)
  assert.equal(r.billedTotal, 1600);
});

test('getCrimpingPricing warns when a 4-wire size is undefined', () => {
  const r = eng.getCrimpingPricing({ hoseSize: '1/4"', hoseWireType: '4-wire', ends: 2 });
  assert.equal(r.marketPerEnd, 0);     // no 4-wire 1/4" rate
  assert.match(r.warning, /No 4-wire shop rate/);
});

test('getCrimpingPricing flags a manual billed rate below internal cost', () => {
  const r = eng.getCrimpingPricing({ hoseSize: '1', hoseWireType: '2-wire', ends: 2, billedPerEnd: 400 });
  assert.equal(r.internalCostPerEnd, 453);
  assert.match(r.warning, /below internal cost/);
});

// ---- import parses the bundled workbook ----
test('importWorkbook parses the datasheet into keyed maps', () => {
  const parsed = imp.parseWorkbook(imp.DEFAULT_WORKBOOK_PATH);
  assert.equal(parsed.hose.length, 15);
  assert.equal(parsed.fittings.length, 68);
  assert.equal(parsed.crimping.length, 8);
  const master = imp.buildMaster(parsed, '2026-01-01');
  assert.equal(master.crimping['5/8'].marketMid, 850);
  assert.equal(master.fittings['22611-04-04'].sellLKR, 620);
  assert.equal(master.hose['R2 1/2'].landedPerM, 355.23);
});
