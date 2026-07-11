'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { num, round2, sumMoney, clamp, formatLKR } = require('../lib/money');

test('num coerces and falls back', () => {
  assert.equal(num('12.5'), 12.5);
  assert.equal(num(''), 0);
  assert.equal(num(null), 0);
  assert.equal(num('abc'), 0);
  assert.equal(num('abc', 7), 7);
  assert.equal(num(Infinity), 0);
  assert.equal(num('1e3'), 1000);
});

test('round2 rounds half away from zero using decimal form', () => {
  assert.equal(round2(1.005), 1.01); // classic binary-FP trap
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(19.999), 20);
  assert.equal(round2(0.005), 0.01);
  assert.equal(round2(0.004), 0);
  assert.equal(round2(-1.005), -1.01);
  assert.equal(round2(1234.5649), 1234.56);
  assert.equal(round2(1234.565), 1234.57);
});

test('round2 rounds half-cent ties up even on computed products (1-ULP noise)', () => {
  // 0.03 * 116.5 === 3.495 exactly, but the double is 3.4949999999999997.
  assert.equal(round2(0.03 * 116.5), 3.5);
  assert.equal(round2(0.03 * 2993.5), 89.81);
  assert.equal(round2(0.03 * 3130.5), 93.92);
  // A value genuinely below the tie must still round down.
  assert.equal(round2(3.4949), 3.49);
  assert.equal(round2(3.494), 3.49);
});

test('round2 handles junk safely and never returns -0', () => {
  assert.equal(round2('not a number'), 0);
  assert.equal(round2(null), 0);
  assert.equal(round2(NaN), 0);
  assert.ok(Object.is(round2(-0.0001), 0));
});

test('sumMoney rounds each addend then the total', () => {
  assert.equal(sumMoney([0.1, 0.1, 0.1]), 0.3);
  assert.equal(sumMoney([1.004, 1.004]), 2); // each -> 1.00
  assert.equal(sumMoney([1.005, 1.005]), 2.02); // each -> 1.01
  assert.equal(sumMoney([]), 0);
});

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.equal(clamp('abc', 0, 10), 0);
});

test('formatLKR groups and fixes 2dp', () => {
  assert.equal(formatLKR(1234.5), 'Rs. 1,234.50');
  assert.equal(formatLKR(0), 'Rs. 0.00');
  assert.equal(formatLKR(1000000), 'Rs. 1,000,000.00');
});
