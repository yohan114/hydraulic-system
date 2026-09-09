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

// --- revisions -------------------------------------------------------------

const { baseNo, revisionIndex, revisionNo, nextRevisionNo } = require('../lib/invoiceNo');

test('a revision suffix is stripped back to the number the customer was given', () => {
  assert.equal(baseNo('INV/2026/09/003'), 'INV/2026/09/003');
  assert.equal(baseNo('INV/2026/09/003-R1'), 'INV/2026/09/003');
  assert.equal(baseNo('INV/2026/09/003-R12'), 'INV/2026/09/003');
  assert.equal(baseNo(''), '');
  assert.equal(baseNo(null), '');
});

test('revisionIndex says which revision a number is; an original is zero', () => {
  assert.equal(revisionIndex('INV/2026/09/003'), 0);
  assert.equal(revisionIndex('INV/2026/09/003-R1'), 1);
  assert.equal(revisionIndex('INV/2026/09/003-R12'), 12);
  assert.equal(revisionIndex('INV/2026/09/003-R0'), 0, 'R0 is not a revision');
});

test('revising a revision builds -R2, never -R1-R1', () => {
  assert.equal(revisionNo('INV/2026/09/003', 1), 'INV/2026/09/003-R1');
  assert.equal(revisionNo('INV/2026/09/003-R1', 2), 'INV/2026/09/003-R2');
  assert.equal(revisionNo('INV/2026/09/003-R1', 0), 'INV/2026/09/003-R1', 'the sequence starts at one');
});

test('the next revision comes from the highest suffix on the chain, not a count', () => {
  const existing = ['INV/2026/09/003', 'INV/2026/09/003-R1', 'INV/2026/09/003-R2'];
  assert.equal(nextRevisionNo('INV/2026/09/003', existing), 'INV/2026/09/003-R3');
  assert.equal(nextRevisionNo('INV/2026/09/003-R2', existing), 'INV/2026/09/003-R3',
    'asking from anywhere in the chain gives the same answer');

  // A gap must not cause a collision with a number already issued.
  assert.equal(nextRevisionNo('INV/2026/09/003', ['INV/2026/09/003', 'INV/2026/09/003-R5']),
    'INV/2026/09/003-R6');

  // A different invoice's revisions are none of this chain's business.
  assert.equal(nextRevisionNo('INV/2026/09/003', ['INV/2026/09/004-R9', 'INV/2026/09/003']),
    'INV/2026/09/003-R1');
});

test('a revision number is invisible to the monthly sequencer', () => {
  // This is what stops a revision from consuming next month's numbering.
  const existing = ['INV/2026/09/001', 'INV/2026/09/002', 'INV/2026/09/002-R1', 'INV/2026/09/002-R2'];
  assert.equal(nextForPrefix(existing, 'INV/2026/09/'), 'INV/2026/09/003');
});
