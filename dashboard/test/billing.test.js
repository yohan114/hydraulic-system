'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  lineAmount,
  computeTotals,
  validateInvoice,
  paymentStatus,
  lineMargin,
} = require('../lib/billing');

test('lineAmount rounds qty*rate', () => {
  assert.equal(lineAmount(3, 333.33), 999.99);
  assert.equal(lineAmount(2, 1500), 3000);
  assert.equal(lineAmount('1.5', '10'), 15);
});

test('computeTotals: standard SSCL 2.5% then VAT 18%', () => {
  const t = computeTotals({ items: [{ qty: 1, rate: 1000 }], ssclRate: 2.5, vatRate: 18 });
  assert.equal(t.subTotal, 1000);
  assert.equal(t.ssclAmount, 25);
  assert.equal(t.preVat, 1025);
  assert.equal(t.vatAmount, 184.5);
  assert.equal(t.afterTax, 1209.5);
  assert.equal(t.discount, 0);
  assert.equal(t.roundOff, 0);
  assert.equal(t.grandTotal, 1209.5);
});

test('computeTotals: discount after tax + round to nearest rupee', () => {
  const t = computeTotals({
    items: [{ qty: 3, rate: 333.33 }],
    ssclRate: 2.5,
    vatRate: 18,
    discount: 10,
    roundToRupee: true,
  });
  assert.equal(t.subTotal, 999.99);
  assert.equal(t.ssclAmount, 25);
  assert.equal(t.preVat, 1024.99);
  assert.equal(t.vatAmount, 184.5);
  assert.equal(t.afterTax, 1209.49);
  assert.equal(t.discount, 10);
  assert.equal(t.grandTotal, 1199);
  assert.equal(t.roundOff, -0.49);
});

test('computeTotals: multiple lines sum accurately', () => {
  const t = computeTotals({
    items: [
      { qty: 2, rate: 1500 }, // 3000
      { qty: 1, rate: 0 }, //    0
      { qty: 4.5, rate: 12.1 }, // 54.45
    ],
    ssclRate: 2.5,
    vatRate: 18,
  });
  assert.equal(t.subTotal, 3054.45);
});

test('computeTotals: discount clamps to the taxed total', () => {
  const t = computeTotals({ items: [{ qty: 1, rate: 100 }], ssclRate: 0, vatRate: 0, discount: 99999 });
  assert.equal(t.afterTax, 100);
  assert.equal(t.discount, 100);
  assert.equal(t.grandTotal, 0);
});

test('computeTotals: tax rates are clamped to a sane range', () => {
  const t = computeTotals({ items: [{ qty: 1, rate: 100 }], ssclRate: 999, vatRate: -5 });
  assert.equal(t.ssclRate, 100);
  assert.equal(t.vatRate, 0);
});

test('computeTotals: client-sent amounts are ignored (recompute from items)', () => {
  const t = computeTotals({
    items: [{ qty: 1, rate: 1000 }],
    subTotal: 999999, // hostile client values must not leak through
    grandTotal: 1,
  });
  assert.equal(t.subTotal, 1000);
  assert.notEqual(t.grandTotal, 1);
});

test('validateInvoice flags empty / bad rows', () => {
  assert.equal(validateInvoice({ items: [] }).ok, false);

  const bad = validateInvoice({
    items: [
      { description: '', qty: 0, rate: -1 },
      { description: 'ok', qty: 2, rate: 5 },
    ],
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('description')));
  assert.ok(bad.errors.some((e) => e.includes('greater than zero')));
  assert.ok(bad.errors.some((e) => e.includes('zero or positive')));
});

test('validateInvoice requires a customer when asked', () => {
  const r = validateInvoice(
    { items: [{ description: 'x', qty: 1, rate: 1 }], billedToName: '   ' },
    { requireCustomer: true }
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Billed To')));
});

test('validateInvoice enforces aggregated stock', () => {
  const stockById = new Map([[7, 5]]);
  const nameById = new Map([[7, 'Rubber pipe R2']]);
  const r = validateInvoice(
    {
      items: [
        { description: 'a', qty: 3, rate: 1, inventoryId: 7 },
        { description: 'b', qty: 4, rate: 1, inventoryId: 7 }, // 3+4 = 7 > 5
      ],
    },
    { checkStock: true, stockById, nameById }
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Not enough stock')));

  const ok = validateInvoice(
    { items: [{ description: 'a', qty: 2, rate: 1, inventoryId: 7 }] },
    { checkStock: true, stockById, nameById }
  );
  assert.equal(ok.ok, true);
});

test('paymentStatus derives status + balance', () => {
  assert.deepEqual(paymentStatus(1000, 0), { status: 'Unpaid', balance: 1000, amountPaid: 0 });
  assert.deepEqual(paymentStatus(1000, 400), { status: 'Partial', balance: 600, amountPaid: 400 });
  assert.deepEqual(paymentStatus(1000, 1000), { status: 'Paid', balance: 0, amountPaid: 1000 });
  assert.deepEqual(paymentStatus(1000, 1200), { status: 'Paid', balance: 0, amountPaid: 1200 });
  assert.deepEqual(paymentStatus(0, 0), { status: 'Paid', balance: 0, amountPaid: 0 });
  assert.equal(paymentStatus(1000, 999.999).status, 'Paid'); // rounds to 1000
});

test('lineMargin computes margin and below-cost flag', () => {
  assert.deepEqual(lineMargin(1000, 600), { marginAmount: 400, marginPct: 40, belowCost: false, hasCost: true });
  assert.deepEqual(lineMargin(1000, 0), { marginAmount: 1000, marginPct: 100, belowCost: false, hasCost: false });
  assert.deepEqual(lineMargin(500, 800), { marginAmount: -300, marginPct: -60, belowCost: true, hasCost: true });
  assert.deepEqual(lineMargin(0, 100), { marginAmount: -100, marginPct: null, belowCost: true, hasCost: true });
});
