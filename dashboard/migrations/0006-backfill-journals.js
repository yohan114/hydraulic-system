'use strict';

/**
 * Open the books on the existing history.
 *
 * Posts every historical event that already happened, so the ledger starts life
 * agreeing with the operational tables rather than from zero:
 *
 *   1. Opening stock   Dr Inventory / Cr Opening Balance Equity, valued at what
 *                      is on the shelf today PLUS everything consumed since, so
 *                      that after the invoice postings draw it down the closing
 *                      stock equals the current inventory value exactly.
 *   2. Invoices        External ones as sales, internal ones as workshop cost
 *                      (services/glPosting.js states both treatments).
 *   3. Payments        Only those against external invoices — a "payment" on an
 *                      internal job is the old system closing the job, not cash.
 *   4. Expenses, labour payments and purchases, if any exist.
 *
 * Cancelled invoices are deliberately NOT posted. A void never became a
 * transaction and its stock was already restored by the cancel flow.
 *
 * Everything posts with allowClosedPeriod, because this is history being
 * recorded rather than new activity being entered.
 */

module.exports = {
  name: 'backfill opening journals',

  up(db) {
    // These services read the shared connection, which during a migration is
    // the same database handle we have here.
    const ledgerSvc = require('../services/ledger');
    const gl = require('../services/glPosting');
    const money = require('../lib/money');
    ledgerSvc.clearAccountCache();   // the chart was only just seeded

    const opts = { allowClosedPeriod: true, postedBy: 'migration 0006' };

    // ---- 1. opening stock ------------------------------------------------
    const onShelf = db.prepare('SELECT ROUND(SUM(Qty * COALESCE(Cost,0)), 2) AS v FROM Inventory').get().v || 0;
    const consumed = db.prepare(`
      SELECT ROUND(SUM(ii.Qty * COALESCE(ii.UnitCostAtBilling, 0)), 2) AS v
      FROM InvoiceItems ii JOIN Invoices i ON i.InvoiceID = ii.InvoiceID
      WHERE i.Status = 'Finalized'`).get().v || 0;
    const openingStock = money.round2(onShelf + consumed);

    const firstDate = db.prepare(
      "SELECT MIN(DATE(InvoiceDate)) AS d FROM Invoices WHERE Status = 'Finalized'"
    ).get().d;

    if (openingStock > 0 && firstDate) {
      // Dated the day before the first invoice so the stock exists before it is used.
      const openedOn = new Date(`${firstDate}T00:00:00Z`);
      openedOn.setUTCDate(openedOn.getUTCDate() - 1);
      ledgerSvc.postEntry({
        date: openedOn.toISOString().slice(0, 10),
        memo: 'Opening stock brought into the ledger',
        sourceType: 'opening', sourceID: 'stock',
        postedBy: opts.postedBy, allowClosedPeriod: true,
        lines: [
          { accountCode: gl.ACC.STOCK, debit: openingStock, memo: 'Stock on hand plus everything consumed since' },
          { accountCode: gl.ACC.OPENING_EQUITY, credit: openingStock },
        ],
      });
    }

    // ---- 2. invoices -----------------------------------------------------
    const invoices = db.prepare(
      "SELECT InvoiceID FROM Invoices WHERE Status = 'Finalized' ORDER BY DATE(InvoiceDate), InvoiceID"
    ).all();
    for (const { InvoiceID } of invoices) gl.postInvoice(InvoiceID, opts);

    // ---- 3. payments (external only) ------------------------------------
    const payments = db.prepare(`
      SELECT p.PaymentID FROM Payments p JOIN Invoices i ON i.InvoiceID = p.InvoiceID
      WHERE i.IsInternal = 0 ORDER BY DATE(p.PaymentDate), p.PaymentID`).all();
    for (const { PaymentID } of payments) gl.postPayment(PaymentID, opts);

    // ---- 4. whatever else is on the books --------------------------------
    for (const { ExpenseID } of db.prepare('SELECT ExpenseID FROM Expenses').all()) gl.postExpense(ExpenseID, opts);
    for (const { LabourPaymentID } of db.prepare('SELECT LabourPaymentID FROM LabourPayments').all()) gl.postLabourPayment(LabourPaymentID, opts);

    // Historical purchases are NOT posted. Their quantities are already sitting
    // in Inventory.Qty, so they are inside the opening stock figure above —
    // posting them again would debit the same stock twice. Purchases from here
    // on post normally; the opening snapshot subsumes everything before it.

    // ---- reconcile -------------------------------------------------------
    // A backfill that does not tie back is worse than no backfill, so prove it
    // here: the entry either balances and matches stock, or the migration fails
    // and rolls back.
    const totals = db.prepare('SELECT ROUND(SUM(Debit),2) d, ROUND(SUM(Credit),2) c FROM JournalLines').get();
    if (money.round2(totals.d) !== money.round2(totals.c)) {
      throw new Error(`Backfill does not balance: debits ${totals.d} vs credits ${totals.c}`);
    }

    const stockBalance = db.prepare(`
      SELECT ROUND(SUM(l.Debit) - SUM(l.Credit), 2) AS v
      FROM JournalLines l JOIN Accounts a ON a.AccountID = l.AccountID
      WHERE a.Code = ?`).get(gl.ACC.STOCK).v || 0;
    if (money.round2(stockBalance) !== money.round2(onShelf)) {
      throw new Error(`Ledger stock ${stockBalance} does not match inventory value ${onShelf}`);
    }
  },

  down(db) {
    // Remove only what this migration created; anything posted since is left.
    db.exec(`DELETE FROM JournalLines WHERE JournalID IN
      (SELECT JournalID FROM JournalEntries WHERE PostedBy = 'migration 0006')`);
    db.exec("DELETE FROM JournalEntries WHERE PostedBy = 'migration 0006'");
  },
};
