'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { monthPrefix, nextForPrefix, nextInvoiceNo } = require('../lib/invoiceNo');

test('monthPrefix builds INV/YYYY/MM/', () => {
  assert.equal(monthPrefix(new Date(2026, 6, 7)), 'INV/2026/07/'); // month is 0-based -> July
  assert.equal(monthPrefix(new Date(2026, 0, 1)), 'INV/2026/01/');
  assert.equal(monthPrefix(new Date(2026, 11, 31)), 'INV/2026/12/');
});

test('nextForPrefix returns 001 for an empty month', () => {
  assert.equal(nextForPrefix([], 'INV/2026/07/'), 'INV/2026/07/001');
  assert.equal(nextForPrefix(['INV/2026/06/009'], 'INV/2026/07/'), 'INV/2026/07/001');
});

test('nextForPrefix increments the max sequence for the month', () => {
  const existing = ['INV/2026/07/001', 'INV/2026/07/003', 'INV/2026/07/002', 'INV/2026/06/050'];
  assert.equal(nextForPrefix(existing, 'INV/2026/07/'), 'INV/2026/07/004');
});

test('nextForPrefix ignores blanks and malformed numbers', () => {
  const existing = [null, '', 'INV/2026/07/', 'INV/2026/07/00X', 'INV/2026/07/007'];
  assert.equal(nextForPrefix(existing, 'INV/2026/07/'), 'INV/2026/07/008');
});

test('nextForPrefix grows padding past 999', () => {
  assert.equal(nextForPrefix(['INV/2026/07/999'], 'INV/2026/07/'), 'INV/2026/07/1000');
});

test('nextInvoiceNo composes prefix + sequence', () => {
  const existing = ['INV/2026/07/001', 'INV/2026/07/002'];
  assert.equal(nextInvoiceNo(existing, new Date(2026, 6, 15)), 'INV/2026/07/003');
});
