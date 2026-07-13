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

// ---- the 70% floored suggestion ----
test('suggestUnit = 70% of market mid when that is above cost', () => {
  assert.deepEqual(eng.suggestUnit(360, 850), { suggested: 595, floored: false });
  assert.deepEqual(eng.suggestUnit(290, 650), { suggested: 455, floored: false });
});

test('suggestUnit floors at cost when 70% mid drops below cost', () => {
  // 70% of 500 = 350 < cost 400 -> floored at 400
  assert.deepEqual(eng.suggestUnit(400, 500), { suggested: 400, floored: true });
});

test('suggestUnit with no market falls back to cost', () => {
  assert.deepEqual(eng.suggestUnit(120, 0), { suggested: 120, floored: true });
});

// ---- status classification ----
test('priceStatus classifies against cost + market mid', () => {
  assert.equal(eng.priceStatus({ cost: 100, rate: 80, marketMid: 1000 }), eng.STATUS.BELOW_COST);
  assert.equal(eng.priceStatus({ cost: 100, rate: 1100, marketMid: 1000 }), eng.STATUS.AT_ABOVE_MARKET);
  assert.equal(eng.priceStatus({ cost: 100, rate: 600, marketMid: 1000 }), eng.STATUS.BELOW_70); // < 700 floor
  assert.equal(eng.priceStatus({ cost: 100, rate: 800, marketMid: 1000 }), eng.STATUS.HEALTHY);  // between 700 and 1000
  // cost above the 70% floor -> at-cost-floor regime
  assert.equal(eng.priceStatus({ cost: 800, rate: 800, marketMid: 1000 }), eng.STATUS.AT_COST_FLOOR);
});

// ---- end-to-end against the committed master JSON ----
test('getPricingForItem prices crimping per end (default 2 ends)', () => {
  const r = eng.getPricingForItem({ type: 'crimping', hoseSize: '5/8"', ends: 2 });
  assert.equal(r.source, 'crimping-charges');
  assert.equal(r.suggestedUnit, 595);
  assert.equal(r.suggestedBill, 1190); // 595 x 2 ends
  assert.equal(r.marketMid, 1700);     // 850 x 2
});

test('getPricingForItem prices a fitting by spec code', () => {
  const r = eng.getPricingForItem({ type: 'fitting', specCode: '22611-04-04', qty: 3 });
  assert.equal(r.source, 'unit-prices');
  assert.equal(r.costUnit, 138.48);
  assert.equal(r.marketUnit, 620);
  assert.equal(r.suggestedUnit, 434); // 620 x 0.70
  assert.equal(r.suggestedBill, 1302); // 434 x 3
});

test('getPricingForItem prices hose per metre from a description', () => {
  const r = eng.getPricingForItem({ type: 'hose', description: 'R2 hydraulic hose 1/2"', length: 4 });
  assert.equal(r.source, 'hose-cost-market');
  assert.equal(r.marketUnit, 1900);
  assert.equal(r.suggestedUnit, 1330); // 1900 x 0.70
  assert.equal(r.suggestedBill, 5320); // 1330 x 4m
});

test('getPricingForItem returns a manual warning when nothing matches', () => {
  const r = eng.getPricingForItem({ type: 'fitting', specCode: 'NOPE-99' });
  assert.equal(r.source, 'manual');
  assert.match(r.warning, /manually/);
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
