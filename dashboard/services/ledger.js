'use strict';

/**
 * Ledger persistence — the only path by which anything reaches the books.
 *
 * Every posting goes through {@link postEntry}, which enforces the rules that
 * make a ledger trustworthy:
 *
 *   1. the entry must balance (lib/ledger.js validateEntry),
 *   2. every account must exist in the chart,
 *   3. the period must be open,
 *   4. the whole entry is written in ONE transaction — a half-posted journal is
 *      not a thing that can exist,
 *   5. a source event posts at most once, so replaying a backfill or
 *      double-clicking Finalize cannot double the books.
 *
 * Journals are never edited or deleted. A mistake is corrected by posting its
 * reversal, which is what leaves an audit trail worth having.
 */

const connection = require('../db');
const money = require('../lib/money');
const ledger = require('../lib/ledger');

/** Thrown for anything the caller could reasonably fix; carries an HTTP status. */
class LedgerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'LedgerError';
    this.httpStatus = status;
  }
}

/** code -> { AccountID, Code, Name, Type }, cached per process. */
let accountCache = null;
function accounts() {
  if (accountCache) return accountCache;
  const rows = connection._db.prepare('SELECT AccountID, Code, Name, Type, Active FROM Accounts').all();
  accountCache = new Map(rows.map((r) => [r.Code, r]));
  return accountCache;
}
function clearAccountCache() { accountCache = null; }

/** Next journal number for a date, e.g. JV/2026-08/0007. */
function nextEntryNo(db, period) {
  const row = db.prepare(
    "SELECT EntryNo FROM JournalEntries WHERE Period = ? ORDER BY JournalID DESC LIMIT 1"
  ).get(period);
  let seq = 1;
  if (row) {
    const m = /(\d+)$/.exec(row.EntryNo);
    if (m) seq = Number(m[1]) + 1;
  }
  return `JV/${period}/${String(seq).padStart(4, '0')}`;
}

/** Is this period open for posting? Unknown periods are open until closed. */
function periodStatus(db, period) {
  const row = db.prepare('SELECT Status FROM Periods WHERE Period = ?').get(period);
  return row ? row.Status : 'open';
}

/**
 * Post one balanced journal entry.
 *
 * @param {object} entry
 * @param {string} entry.date       `YYYY-MM-DD`
 * @param {string} [entry.memo]
 * @param {string} [entry.sourceType] e.g. 'invoice', 'payment', 'expense'
 * @param {string|number} [entry.sourceID]
 * @param {string} [entry.postedBy]
 * @param {boolean} [entry.allowClosedPeriod=false] backfills only
 * @param {Array<{accountCode:string, debit?:number, credit?:number, memo?:string,
 *   customerId?:number, supplierId?:number}>} entry.lines
 * @returns {{journalId:number, entryNo:string, period:string, debit:number, credit:number}}
 */
function postEntry(entry) {
  const db = connection._db;
  const date = String((entry && entry.date) || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new LedgerError(`Invalid posting date: ${entry && entry.date}`);
  const period = ledger.periodOf(date);

  const check = ledger.validateEntry(entry.lines);
  if (!check.ok) throw new LedgerError(check.error);

  const chart = accounts();
  for (const line of check.lines) {
    const acct = chart.get(line.accountCode);
    if (!acct) throw new LedgerError(`Account ${line.accountCode} is not in the chart of accounts`);
    if (!acct.Active) throw new LedgerError(`Account ${line.accountCode} (${acct.Name}) is inactive`);
  }

  if (!entry.allowClosedPeriod && periodStatus(db, period) === 'closed') {
    throw new LedgerError(`Period ${period} is closed — post the correction to an open period instead`);
  }

  // One event, one journal. Makes every posting path safely re-runnable.
  if (entry.sourceType && entry.sourceID != null) {
    const dup = db.prepare(
      'SELECT JournalID, EntryNo FROM JournalEntries WHERE SourceType = ? AND SourceID = ? AND ReversalOf IS NULL'
    ).get(String(entry.sourceType), String(entry.sourceID));
    if (dup) return { journalId: dup.JournalID, entryNo: dup.EntryNo, period, debit: check.debit, credit: check.credit, alreadyPosted: true };
  }

  const write = db.transaction(() => {
    const entryNo = nextEntryNo(db, period);
    const info = db.prepare(
      `INSERT INTO JournalEntries (EntryNo, EntryDate, Period, Memo, SourceType, SourceID, PostedAt, PostedBy, ReversalOf)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?, ?)`
    ).run(entryNo, date, period, entry.memo || null,
      entry.sourceType || null, entry.sourceID != null ? String(entry.sourceID) : null,
      entry.postedBy || null, entry.reversalOf || null);

    const journalId = info.lastInsertRowid;
    const insLine = db.prepare(
      `INSERT INTO JournalLines (JournalID, AccountID, Debit, Credit, Memo, CustomerID, SupplierID)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of check.lines) {
      insLine.run(journalId, chart.get(l.accountCode).AccountID, l.debit, l.credit,
        l.memo || null, l.customerId || null, l.supplierId || null);
    }
    return { journalId, entryNo };
  });

  const { journalId, entryNo } = write();
  return { journalId, entryNo, period, debit: check.debit, credit: check.credit, alreadyPosted: false };
}

/**
 * Reverse an existing journal by posting its mirror image. The original is left
 * exactly as it was — that is the point.
 *
 * @param {number} journalId
 * @param {object} [opts] { date, memo, postedBy, allowClosedPeriod }
 */
function reverseEntry(journalId, opts = {}) {
  const db = connection._db;
  const original = db.prepare('SELECT * FROM JournalEntries WHERE JournalID = ?').get(journalId);
  if (!original) throw new LedgerError(`Journal ${journalId} not found`, 404);

  const already = db.prepare('SELECT JournalID FROM JournalEntries WHERE ReversalOf = ?').get(journalId);
  if (already) throw new LedgerError(`Journal ${original.EntryNo} has already been reversed`);

  const lines = db.prepare(`
    SELECT a.Code AS accountCode, l.Debit, l.Credit, l.Memo, l.CustomerID, l.SupplierID
    FROM JournalLines l JOIN Accounts a ON a.AccountID = l.AccountID
    WHERE l.JournalID = ?`).all(journalId);

  return postEntry({
    date: opts.date || original.EntryDate.slice(0, 10),
    memo: opts.memo || `Reversal of ${original.EntryNo}${original.Memo ? ` — ${original.Memo}` : ''}`,
    sourceType: original.SourceType ? `${original.SourceType}:reversal` : null,
    sourceID: original.SourceID,
    postedBy: opts.postedBy,
    reversalOf: journalId,
    allowClosedPeriod: opts.allowClosedPeriod,
    // Swap the sides.
    lines: lines.map((l) => ({
      accountCode: l.accountCode,
      debit: money.round2(l.Credit),
      credit: money.round2(l.Debit),
      memo: l.Memo,
      customerId: l.CustomerID,
      supplierId: l.SupplierID,
    })),
  });
}

/**
 * Per-account debit/credit totals, optionally bounded by date.
 * @param {{from?:string, to?:string}} [range]
 * @returns {Array<{code:string, name:string, debit:number, credit:number}>}
 */
function accountTotals(range = {}) {
  const where = ['1=1'];
  const params = [];
  if (range.from) { where.push('j.EntryDate >= ?'); params.push(String(range.from).slice(0, 10)); }
  if (range.to) { where.push('j.EntryDate <= ?'); params.push(`${String(range.to).slice(0, 10)} 23:59:59`); }

  return connection._db.prepare(`
    SELECT a.Code AS code, a.Name AS name,
           ROUND(COALESCE(SUM(l.Debit), 0), 2) AS debit,
           ROUND(COALESCE(SUM(l.Credit), 0), 2) AS credit
    FROM Accounts a
    LEFT JOIN JournalLines l ON l.AccountID = a.AccountID
    LEFT JOIN JournalEntries j ON j.JournalID = l.JournalID AND ${where.join(' AND ')}
    GROUP BY a.AccountID
    HAVING debit <> 0 OR credit <> 0
    ORDER BY a.Code`).all(...params);
}

/** Every line on one account, oldest first, with a running balance. */
function accountLedger(code, range = {}) {
  const acct = accounts().get(String(code));
  if (!acct) throw new LedgerError(`Account ${code} is not in the chart of accounts`, 404);

  const where = ['l.AccountID = ?'];
  const params = [acct.AccountID];
  if (range.from) { where.push('j.EntryDate >= ?'); params.push(String(range.from).slice(0, 10)); }
  if (range.to) { where.push('j.EntryDate <= ?'); params.push(`${String(range.to).slice(0, 10)} 23:59:59`); }

  const rows = connection._db.prepare(`
    SELECT j.EntryNo, j.EntryDate, j.Memo AS entryMemo, j.SourceType, j.SourceID,
           l.Debit, l.Credit, l.Memo AS lineMemo
    FROM JournalLines l JOIN JournalEntries j ON j.JournalID = l.JournalID
    WHERE ${where.join(' AND ')}
    ORDER BY j.EntryDate, j.JournalID, l.LineID`).all(...params);

  let running = 0;
  const lines = rows.map((r) => {
    running = money.round2(running + ledger.signedBalance(acct.Type, r.Debit, r.Credit));
    return {
      entryNo: r.EntryNo,
      date: r.EntryDate,
      memo: r.lineMemo || r.entryMemo,
      sourceType: r.SourceType,
      sourceId: r.SourceID,
      debit: money.round2(r.Debit),
      credit: money.round2(r.Credit),
      balance: running,
    };
  });
  return { account: { code: acct.Code, name: acct.Name, type: acct.Type }, lines, closing: running };
}

/**
 * Per-period, per-account-type totals plus cash movement — everything a
 * month-by-month profit & loss needs, straight from the journals.
 *
 * Cash in/out is the debit/credit activity on the cash and bank accounts, which
 * is what actually moved rather than what was earned.
 *
 * @param {{from?:string, to?:string}} [range]
 * @returns {Array<{period:string, revenue:number, cogs:number, grossProfit:number,
 *   expenses:number, netProfit:number, marginPct:(number|null),
 *   cashIn:number, cashOut:number, cashNet:number}>}
 */
function monthlyProfitAndLoss(range = {}) {
  const where = ['1=1'];
  const params = [];
  if (range.from) { where.push('j.EntryDate >= ?'); params.push(String(range.from).slice(0, 10)); }
  if (range.to) { where.push('j.EntryDate <= ?'); params.push(`${String(range.to).slice(0, 10)} 23:59:59`); }

  const rows = connection._db.prepare(`
    SELECT j.Period AS period, a.Type AS type, a.Code AS code,
           ROUND(SUM(l.Debit), 2) AS debit, ROUND(SUM(l.Credit), 2) AS credit
    FROM JournalLines l
    JOIN JournalEntries j ON j.JournalID = l.JournalID
    JOIN Accounts a ON a.AccountID = l.AccountID
    WHERE ${where.join(' AND ')}
    GROUP BY j.Period, a.AccountID
    ORDER BY j.Period`).all(...params);

  const CASH = new Set(['1110', '1120']);
  const byPeriod = new Map();

  for (const r of rows) {
    if (!byPeriod.has(r.period)) {
      byPeriod.set(r.period, {
        period: r.period, revenue: 0, cogs: 0, expenses: 0, cashIn: 0, cashOut: 0,
      });
    }
    const p = byPeriod.get(r.period);
    const signed = ledger.signedBalance(r.type, r.debit, r.credit);

    if (r.type === ledger.TYPE.INCOME) p.revenue = money.round2(p.revenue + signed);
    else if (r.type === ledger.TYPE.COST_OF_SALES) p.cogs = money.round2(p.cogs + signed);
    else if (r.type === ledger.TYPE.EXPENSE) p.expenses = money.round2(p.expenses + signed);

    if (CASH.has(r.code)) {
      p.cashIn = money.round2(p.cashIn + money.num(r.debit));
      p.cashOut = money.round2(p.cashOut + money.num(r.credit));
    }
  }

  return [...byPeriod.values()]
    .map((p) => {
      const grossProfit = money.round2(p.revenue - p.cogs);
      const netProfit = money.round2(grossProfit - p.expenses);
      return {
        ...p,
        grossProfit,
        netProfit,
        marginPct: ledger.pctOf(netProfit, p.revenue),
        cashNet: money.round2(p.cashIn - p.cashOut),
      };
    })
    .sort((a, b) => b.period.localeCompare(a.period));
}

/** Has this business event already been posted? */
function isPosted(sourceType, sourceID) {
  const row = connection._db.prepare(
    'SELECT JournalID FROM JournalEntries WHERE SourceType = ? AND SourceID = ? AND ReversalOf IS NULL'
  ).get(String(sourceType), String(sourceID));
  return row ? row.JournalID : null;
}

module.exports = {
  LedgerError, postEntry, reverseEntry, accountTotals, accountLedger, monthlyProfitAndLoss,
  isPosted, periodStatus, clearAccountCache, nextEntryNo,
};
