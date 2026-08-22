'use strict';

/**
 * General Ledger endpoints — chart of accounts, journals, and the three
 * statements that now come OUT of the ledger rather than being re-scanned from
 * the operational tables.
 */

const express = require('express');
const connection = require('../db');
const sql = require('../lib/sql');
const ledger = require('../lib/ledger');
const ledgerSvc = require('../services/ledger');
const router = express.Router();

function range(q) {
  return { from: q.from || null, to: q.to || null };
}

function fail(res, err) {
  const status = err && err.httpStatus ? err.httpStatus : 500;
  res.status(status).json({ error: err.message || String(err) });
}

router.get('/api/accounts', async (req, res) => {
  try {
    const rows = await connection.query(`
      SELECT a.*, ROUND(COALESCE(SUM(l.Debit), 0), 2) AS Debit, ROUND(COALESCE(SUM(l.Credit), 0), 2) AS Credit
      FROM Accounts a LEFT JOIN JournalLines l ON l.AccountID = a.AccountID
      GROUP BY a.AccountID ORDER BY a.Code`);
    res.json(rows.map((r) => ({
      ...r,
      Balance: ledger.signedBalance(r.Type, r.Debit, r.Credit),
    })));
  } catch (err) {
    res.status(500).json({ error: 'Could not load the chart of accounts. Run "npm run migrate" first. ' + err.message });
  }
});

router.get('/api/ledger/trial-balance', async (req, res) => {
  try {
    res.json(ledger.trialBalance(ledgerSvc.accountTotals(range(req.query))));
  } catch (err) { fail(res, err); }
});

router.get('/api/ledger/pl', async (req, res) => {
  try {
    const tb = ledger.trialBalance(ledgerSvc.accountTotals(range(req.query)));
    res.json({ ...ledger.profitAndLoss(tb.accounts), balanced: tb.totals.balanced });
  } catch (err) { fail(res, err); }
});

/** Month-by-month profit & loss, with the cash that actually moved. */
router.get('/api/ledger/pl/monthly', async (req, res) => {
  try {
    const months = ledgerSvc.monthlyProfitAndLoss(range(req.query));
    const totals = months.reduce((a, m) => ({
      revenue: a.revenue + m.revenue, cogs: a.cogs + m.cogs, grossProfit: a.grossProfit + m.grossProfit,
      expenses: a.expenses + m.expenses, netProfit: a.netProfit + m.netProfit,
      cashIn: a.cashIn + m.cashIn, cashOut: a.cashOut + m.cashOut, cashNet: a.cashNet + m.cashNet,
    }), { revenue: 0, cogs: 0, grossProfit: 0, expenses: 0, netProfit: 0, cashIn: 0, cashOut: 0, cashNet: 0 });
    for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 100) / 100;
    totals.marginPct = ledger.pctOf(totals.netProfit, totals.revenue);
    res.json({ months, totals });
  } catch (err) { fail(res, err); }
});

router.get('/api/ledger/balance-sheet', async (req, res) => {
  try {
    // A balance sheet is always as-at a date, never a window: assets are what
    // you hold on the day, not what moved during a month.
    const asAt = req.query.asAt || req.query.to || null;
    const tb = ledger.trialBalance(ledgerSvc.accountTotals({ to: asAt }));
    const pl = ledger.profitAndLoss(tb.accounts);
    res.json({ asAt, ...ledger.balanceSheet(tb.accounts, pl.netProfit), netProfit: pl.netProfit });
  } catch (err) { fail(res, err); }
});

router.get('/api/ledger/account/:code', async (req, res) => {
  try {
    res.json(ledgerSvc.accountLedger(req.params.code, range(req.query)));
  } catch (err) { fail(res, err); }
});

router.get('/api/ledger/journals', async (req, res) => {
  try {
    const r = range(req.query);
    const where = ['1=1'];
    if (r.from) where.push(`j.EntryDate >= ${sql.q(String(r.from).slice(0, 10))}`);
    if (r.to) where.push(`j.EntryDate <= ${sql.q(`${String(r.to).slice(0, 10)} 23:59:59`)}`);
    if (req.query.source) where.push(`j.SourceType = ${sql.q(req.query.source)}`);

    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = await connection.query(`
      SELECT j.*, ROUND(COALESCE(SUM(l.Debit), 0), 2) AS Amount, COUNT(l.LineID) AS Lines
      FROM JournalEntries j LEFT JOIN JournalLines l ON l.JournalID = j.JournalID
      WHERE ${where.join(' AND ')}
      GROUP BY j.JournalID
      ORDER BY j.EntryDate DESC, j.JournalID DESC
      LIMIT ${limit}`);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/api/ledger/journals/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const head = await connection.query(`SELECT * FROM JournalEntries WHERE JournalID = ${id}`);
    if (!head.length) return res.status(404).json({ error: 'Journal not found' });
    const lines = await connection.query(`
      SELECT l.*, a.Code, a.Name, a.Type, c.Name AS CustomerName
      FROM JournalLines l
      JOIN Accounts a ON a.AccountID = l.AccountID
      LEFT JOIN Customers c ON c.CustomerID = l.CustomerID
      WHERE l.JournalID = ${id} ORDER BY l.LineID`);
    res.json({ ...head[0], lines });
  } catch (err) { fail(res, err); }
});

/** Manual journal — for adjustments the automatic rules do not cover. */
router.post('/api/ledger/journals', async (req, res) => {
  try {
    const b = req.body || {};
    const result = ledgerSvc.postEntry({
      date: b.date,
      memo: b.memo,
      sourceType: 'manual',
      sourceID: null,
      postedBy: (req.user && req.user.username) || null,
      lines: b.lines,
    });
    res.locals.audit = { entity: 'journal', entityId: result.journalId, action: 'post' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

router.post('/api/ledger/journals/:id/reverse', async (req, res) => {
  try {
    const result = ledgerSvc.reverseEntry(sql.n(req.params.id), {
      memo: (req.body || {}).memo,
      postedBy: (req.user && req.user.username) || null,
    });
    res.locals.audit = { entity: 'journal', entityId: req.params.id, action: 'reverse' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

// ------------------------------------------------------------------ periods

router.get('/api/ledger/periods', async (req, res) => {
  try {
    const rows = await connection.query(`
      SELECT j.Period,
             COUNT(DISTINCT j.JournalID) AS Journals,
             ROUND(COALESCE(SUM(l.Debit), 0), 2) AS Debit,
             COALESCE(p.Status, 'open') AS Status, p.ClosedAt, p.ClosedBy
      FROM JournalEntries j
      LEFT JOIN JournalLines l ON l.JournalID = j.JournalID
      LEFT JOIN Periods p ON p.Period = j.Period
      GROUP BY j.Period ORDER BY j.Period DESC`);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.post('/api/ledger/periods/:period/close', async (req, res) => {
  try {
    const period = String(req.params.period);
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM' });
    await connection.execute(`INSERT INTO Periods (Period, Status, ClosedAt, ClosedBy)
      VALUES (${sql.q(period)}, 'closed', Now(), ${sql.q((req.user && req.user.username) || '', true)})
      ON CONFLICT(Period) DO UPDATE SET Status='closed', ClosedAt=Now()`);
    res.locals.audit = { entity: 'period', entityId: period, action: 'close' };
    res.json({ success: true, period, status: 'closed' });
  } catch (err) { fail(res, err); }
});

router.post('/api/ledger/periods/:period/reopen', async (req, res) => {
  try {
    const period = String(req.params.period);
    await connection.execute(
      `UPDATE Periods SET Status='open', ClosedAt=NULL, ClosedBy=NULL WHERE Period = ${sql.q(period)}`);
    res.locals.audit = { entity: 'period', entityId: period, action: 'reopen' };
    res.json({ success: true, period, status: 'open' });
  } catch (err) { fail(res, err); }
});

module.exports = router;
