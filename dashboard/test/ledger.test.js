'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TYPE, typeOfCode, isDebitPositive, signedBalance,
  validateEntry, trialBalance, profitAndLoss, balanceSheet, periodOf,
} = require('../lib/ledger');

test('an account code carries its type in the first digit', () => {
  assert.equal(typeOfCode('1300'), TYPE.ASSET);
  assert.equal(typeOfCode('2100'), TYPE.LIABILITY);
  assert.equal(typeOfCode('3900'), TYPE.EQUITY);
  assert.equal(typeOfCode('4100'), TYPE.INCOME);
  assert.equal(typeOfCode('5100'), TYPE.COST_OF_SALES);
  assert.equal(typeOfCode('6900'), TYPE.EXPENSE);
  assert.equal(typeOfCode('9999'), null);
  assert.equal(typeOfCode(''), null);
  assert.equal(typeOfCode(null), null);
});

test('balances run in the direction each type actually behaves', () => {
  assert.ok(isDebitPositive(TYPE.ASSET));
  assert.ok(isDebitPositive(TYPE.EXPENSE));
  assert.ok(!isDebitPositive(TYPE.INCOME));
  assert.ok(!isDebitPositive(TYPE.LIABILITY));

  // Stock with more debits than credits is a positive asset.
  assert.equal(signedBalance(TYPE.ASSET, 1000, 250), 750);
  // Sales with more credits is positive income, not negative.
  assert.equal(signedBalance(TYPE.INCOME, 0, 32415.2), 32415.2);
  // An overdrawn asset reads negative.
  assert.equal(signedBalance(TYPE.ASSET, 100, 400), -300);
});

test('validateEntry accepts a balanced entry', () => {
  const r = validateEntry([
    { accountCode: '1200', debit: 6652.8 },
    { accountCode: '4100', credit: 6652.8 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.debit, 6652.8);
  assert.equal(r.credit, 6652.8);
});

test('validateEntry refuses everything that would corrupt the books', () => {
  const cases = [
    [[], /at least two lines/],
    [[{ accountCode: '1200', debit: 100 }], /at least two lines/],
    [[{ accountCode: '1200', debit: 100 }, { accountCode: '4100', credit: 90 }], /does not balance/],
    [[{ accountCode: '', debit: 100 }, { accountCode: '4100', credit: 100 }], /has no account/],
    [[{ accountCode: '9999', debit: 100 }, { accountCode: '4100', credit: 100 }], /unknown account code/],
    [[{ accountCode: '1200', debit: 100, credit: 50 }, { accountCode: '4100', credit: 50 }], /either a debit or a credit/],
    [[{ accountCode: '1200', debit: -100 }, { accountCode: '4100', credit: -100 }], /must not be negative/],
    [[{ accountCode: '1200' }, { accountCode: '4100', credit: 100 }], /has no amount/],
    [[{ accountCode: '1200', debit: 0 }, { accountCode: '4100', credit: 0 }], /has no amount/],
  ];
  for (const [lines, re] of cases) {
    const r = validateEntry(lines);
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(lines)}`);
    assert.match(r.error, re);
  }
});

test('validateEntry balances a multi-line entry to the cent', () => {
  const r = validateEntry([
    { accountCode: '1200', debit: 12166.4 },
    { accountCode: '4100', credit: 9268.4 },
    { accountCode: '4200', credit: 2898.0 },
    { accountCode: '5100', debit: 5805.1 },
    { accountCode: '1300', credit: 5805.1 },
  ]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.debit, r.credit);
});

test('trial balance nets each account into the right column', () => {
  const tb = trialBalance([
    { code: '1300', name: 'Stock', debit: 2944127.8, credit: 110198.02 },
    { code: '4100', name: 'Sales', debit: 0, credit: 23179.2 },
    { code: '1200', name: 'AR', debit: 32415.2, credit: 32415.2 },
  ]);
  const stock = tb.accounts.find((a) => a.code === '1300');
  assert.equal(stock.balance, 2833929.78);
  assert.equal(stock.debitBalance, 2833929.78);
  assert.equal(stock.creditBalance, 0);

  const sales = tb.accounts.find((a) => a.code === '4100');
  assert.equal(sales.creditBalance, 23179.2);
  assert.equal(sales.debitBalance, 0);

  // Fully settled receivable nets to nothing but still shows its activity.
  const ar = tb.accounts.find((a) => a.code === '1200');
  assert.equal(ar.balance, 0);
  assert.equal(ar.debit, 32415.2);
});

test('an overdrawn asset lands in the credit column of the trial balance', () => {
  const tb = trialBalance([{ code: '1110', name: 'Cash', debit: 100, credit: 400 }]);
  const cash = tb.accounts[0];
  assert.equal(cash.balance, -300);
  assert.equal(cash.creditBalance, 300);
  assert.equal(cash.debitBalance, 0);
});

test('P&L and balance sheet reconcile on the real shape of this shop', () => {
  const tb = trialBalance([
    { code: '1110', name: 'Cash', debit: 32415.2, credit: 0 },
    { code: '1300', name: 'Stock', debit: 2944127.8, credit: 110198.02 },
    { code: '3900', name: 'Opening equity', debit: 0, credit: 2944127.8 },
    { code: '4100', name: 'Sales — Parts', debit: 0, credit: 23179.2 },
    { code: '4200', name: 'Sales — Technical', debit: 0, credit: 9236.0 },
    { code: '5100', name: 'COGS', debit: 11775.02, credit: 0 },
    { code: '6900', name: 'Internal work', debit: 98423.0, credit: 0 },
  ]);
  assert.equal(tb.totals.balanced, true);

  const pl = profitAndLoss(tb.accounts);
  assert.equal(pl.revenue, 32415.2);
  assert.equal(pl.cogs, 11775.02);
  assert.equal(pl.grossProfit, 20640.18);
  assert.equal(pl.expensesTotal, 98423.0);
  // Internal fleet work costs more than external trade brings in.
  assert.equal(pl.netProfit, -77782.82);

  const bs = balanceSheet(tb.accounts, pl.netProfit);
  assert.equal(bs.totalAssets, 2866344.98);
  assert.equal(bs.balanced, true, `off by ${bs.difference}`);
  assert.equal(bs.difference, 0);
});

test('a balanced set of journals always yields a balanced sheet', () => {
  // Property check: any balanced entry keeps assets = liabilities + equity.
  const entries = [
    [['1110', 5000, 0], ['3100', 0, 5000]],
    [['1300', 1200, 0], ['2100', 0, 1200]],
    [['1200', 800, 0], ['4100', 0, 800]],
    [['5100', 300, 0], ['1300', 0, 300]],
    [['6300', 150, 0], ['1110', 0, 150]],
  ];
  const totals = new Map();
  for (const entry of entries) {
    const v = validateEntry(entry.map(([code, d, c]) => ({ accountCode: code, debit: d, credit: c })));
    assert.equal(v.ok, true, v.error);
    for (const [code, d, c] of entry) {
      const cur = totals.get(code) || { code, name: code, debit: 0, credit: 0 };
      cur.debit += d; cur.credit += c;
      totals.set(code, cur);
    }
  }
  const tb = trialBalance([...totals.values()]);
  assert.equal(tb.totals.balanced, true);
  const pl = profitAndLoss(tb.accounts);
  const bs = balanceSheet(tb.accounts, pl.netProfit);
  assert.equal(bs.balanced, true, `off by ${bs.difference}`);
});

test('periodOf reads the month off a date in any of the stored formats', () => {
  assert.equal(periodOf('2026-08-20'), '2026-08');
  assert.equal(periodOf('2026-05-22T00:00'), '2026-05');
  assert.equal(periodOf('2026-07-13 00:00:00'), '2026-07');
  assert.equal(periodOf(''), '');
});
