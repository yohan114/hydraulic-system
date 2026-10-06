'use strict';

/**
 * Double-entry ledger engine (pure, dependency-free, unit-tested).
 *
 * The spine of the ERP. Every financial report — trial balance, profit & loss,
 * balance sheet, receivables — is derived from journal lines rather than being
 * re-scanned out of the operational tables, which is what let a tax-inclusive
 * total sit undetected inside "revenue" for months.
 *
 * Account codes carry their type in the first digit, so a code is enough to know
 * how a balance behaves:
 *
 *   1xxx  asset      debit-positive
 *   2xxx  liability  credit-positive
 *   3xxx  equity     credit-positive
 *   4xxx  income     credit-positive
 *   5xxx  cost of sales   debit-positive
 *   6xxx  expense    debit-positive
 *
 * Nothing here touches a database; services/ledger.js does the persistence.
 */

const { round2, num } = require('./money');

const TYPE = {
  ASSET: 'asset',
  LIABILITY: 'liability',
  EQUITY: 'equity',
  INCOME: 'income',
  COST_OF_SALES: 'cost_of_sales',
  EXPENSE: 'expense',
};

// First digit of the account code -> account type.
const TYPE_BY_PREFIX = {
  1: TYPE.ASSET,
  2: TYPE.LIABILITY,
  3: TYPE.EQUITY,
  4: TYPE.INCOME,
  5: TYPE.COST_OF_SALES,
  6: TYPE.EXPENSE,
};

// Types whose balance grows on the debit side.
const DEBIT_POSITIVE = new Set([TYPE.ASSET, TYPE.COST_OF_SALES, TYPE.EXPENSE]);

/** Types that close into profit for the period (everything else is a balance-sheet account). */
const PROFIT_TYPES = new Set([TYPE.INCOME, TYPE.COST_OF_SALES, TYPE.EXPENSE]);

/**
 * Percentage of `part` against `whole`, or null when there is no base to divide
 * by — so a report prints "—" rather than a misleading 0%.
 * @param {number} part
 * @param {number} whole
 * @returns {number|null}
 */
function pctOf(part, whole) {
  return whole > 0 ? round2((part / whole) * 100) : null;
}

/**
 * The account type implied by a code.
 * @param {string|number} code
 * @returns {string|null}
 */
function typeOfCode(code) {
  const first = String(code == null ? '' : code).trim()[0];
  return TYPE_BY_PREFIX[first] || null;
}

/** Whether a balance of this type increases on the debit side. */
function isDebitPositive(type) {
  return DEBIT_POSITIVE.has(type);
}

/**
 * Signed balance for an account, in the direction that reads naturally:
 * an asset with more debits is positive, a liability with more credits is
 * positive. Reports never have to remember which way round an account runs.
 *
 * @param {string} type
 * @param {number} debit  total debits
 * @param {number} credit total credits
 * @returns {number}
 */
function signedBalance(type, debit, credit) {
  const d = round2(debit);
  const c = round2(credit);
  return isDebitPositive(type) ? round2(d - c) : round2(c - d);
}

/**
 * Validate a set of journal lines before they are allowed near the database.
 *
 * A journal that does not balance is not a journal, and a line that is both a
 * debit and a credit is a mistake rather than a shorthand. Rejecting both here
 * means the ledger cannot be corrupted by a posting rule with a typo in it.
 *
 * @param {Array<{accountCode:string, debit?:number, credit?:number}>} lines
 * @returns {{ok:boolean, error:(string|null), debit:number, credit:number, lines:Array}}
 */
function validateEntry(lines) {
  const fail = (error) => ({ ok: false, error, debit: 0, credit: 0, lines: [] });
  if (!Array.isArray(lines) || lines.length < 2) {
    return fail('A journal entry needs at least two lines');
  }

  const clean = [];
  let debit = 0;
  let credit = 0;

  for (const [i, line] of lines.entries()) {
    const code = String((line && line.accountCode) || '').trim();
    if (!code) return fail(`Line ${i + 1} has no account`);
    if (!typeOfCode(code)) return fail(`Line ${i + 1}: unknown account code "${code}"`);

    const d = round2(num(line.debit));
    const c = round2(num(line.credit));
    if (d < 0 || c < 0) return fail(`Line ${i + 1}: debit and credit must not be negative`);
    if (d > 0 && c > 0) return fail(`Line ${i + 1}: a line is either a debit or a credit, not both`);
    if (d === 0 && c === 0) return fail(`Line ${i + 1}: has no amount`);

    debit = round2(debit + d);
    credit = round2(credit + c);
    clean.push({ ...line, accountCode: code, debit: d, credit: c });
  }

  if (debit !== credit) {
    return { ok: false, error: `Entry does not balance: debits ${debit} vs credits ${credit}`, debit, credit, lines: clean };
  }
  if (debit === 0) return fail('Entry has no value');

  return { ok: true, error: null, debit, credit, lines: clean };
}

/**
 * Roll raw per-account totals into a trial balance.
 *
 * @param {Array<{code:string, name:string, debit:number, credit:number}>} rows
 * @returns {{accounts:Array, totals:{debit:number, credit:number, balanced:boolean}}}
 */
function trialBalance(rows) {
  const accounts = (rows || []).map((r) => {
    const type = typeOfCode(r.code);
    const debit = round2(r.debit);
    const credit = round2(r.credit);
    const balance = signedBalance(type, debit, credit);
    return {
      code: r.code,
      name: r.name,
      type,
      debit,
      credit,
      balance,
      // Which column the net balance belongs in on a printed trial balance.
      debitBalance: balance > 0 && isDebitPositive(type) ? balance : (balance < 0 && !isDebitPositive(type) ? -balance : 0),
      creditBalance: balance > 0 && !isDebitPositive(type) ? balance : (balance < 0 && isDebitPositive(type) ? -balance : 0),
    };
  });

  const totals = accounts.reduce(
    (a, x) => ({ debit: round2(a.debit + x.debit), credit: round2(a.credit + x.credit) }),
    { debit: 0, credit: 0 }
  );
  return { accounts, totals: { ...totals, balanced: totals.debit === totals.credit } };
}

/**
 * Profit & loss for a period, from the income/cost/expense accounts.
 * @param {Array} accounts output of {@link trialBalance}.accounts
 * @returns {object}
 */
function profitAndLoss(accounts) {
  const pick = (type) => (accounts || []).filter((a) => a.type === type && a.balance !== 0);
  const sum = (rows) => round2(rows.reduce((a, r) => a + r.balance, 0));

  const income = pick(TYPE.INCOME);
  const costOfSales = pick(TYPE.COST_OF_SALES);
  const expenses = pick(TYPE.EXPENSE);

  const revenue = sum(income);
  const cogs = sum(costOfSales);
  const grossProfit = round2(revenue - cogs);
  const opex = sum(expenses);
  const netProfit = round2(grossProfit - opex);

  return {
    income, costOfSales, expenses,
    revenue, cogs, grossProfit, expensesTotal: opex, netProfit,
    grossMarginPct: revenue > 0 ? round2((grossProfit / revenue) * 100) : null,
    netMarginPct: revenue > 0 ? round2((netProfit / revenue) * 100) : null,
  };
}

/**
 * Balance sheet from the asset/liability/equity accounts.
 *
 * Profit for the period has not been closed to retained earnings, so it is
 * carried into equity explicitly — that is what makes the sheet balance.
 *
 * @param {Array} accounts output of {@link trialBalance}.accounts
 * @param {number} netProfit from {@link profitAndLoss}
 * @returns {object}
 */
function balanceSheet(accounts, netProfit) {
  const pick = (type) => (accounts || []).filter((a) => a.type === type && a.balance !== 0);
  const sum = (rows) => round2(rows.reduce((a, r) => a + r.balance, 0));

  const assets = pick(TYPE.ASSET);
  const liabilities = pick(TYPE.LIABILITY);
  const equity = pick(TYPE.EQUITY);

  const totalAssets = sum(assets);
  const totalLiabilities = sum(liabilities);
  const equityBooked = sum(equity);
  const profit = round2(netProfit);
  const totalEquity = round2(equityBooked + profit);

  return {
    assets, liabilities, equity,
    totalAssets, totalLiabilities,
    equityBooked, profitForPeriod: profit, totalEquity,
    totalLiabilitiesAndEquity: round2(totalLiabilities + totalEquity),
    // Rounding aside, a set of balanced journals must produce a balanced sheet.
    balanced: round2(totalAssets - (totalLiabilities + totalEquity)) === 0,
    difference: round2(totalAssets - (totalLiabilities + totalEquity)),
  };
}

/**
 * The period a date falls in, as `YYYY-MM`.
 * @param {string|Date} date
 * @returns {string}
 */
function periodOf(date) {
  const s = String(date || '');
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  TYPE, TYPE_BY_PREFIX, PROFIT_TYPES,
  typeOfCode, isDebitPositive, signedBalance, pctOf,
  validateEntry, trialBalance, profitAndLoss, balanceSheet, periodOf,
};
