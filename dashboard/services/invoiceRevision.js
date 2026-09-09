'use strict';

/**
 * Revising a posted invoice, and voiding a payment.
 *
 * WHY THIS EXISTS
 *
 * A finalized invoice is a fact: stock left the shelf, a journal was posted, and
 * the customer was handed a bill. When it turns out to be wrong, the answer is
 * never to edit it — an edited invoice destroys the trail that makes the books
 * worth anything. The answer is to SUPERSEDE it: reverse the original out in
 * full, and issue a replacement that carries the correction.
 *
 *   INV/2026/09/003   Status 'Revised', SupersededBy -> the replacement
 *   INV/2026/09/003-R1  Status 'Finalized', RevisionOf -> the original
 *
 * The original stops being a receivable and drops out of every report — they all
 * filter Status = 'Finalized' — while remaining on file, in full, with the
 * reason it was replaced.
 *
 * THE ORDER OF OPERATIONS, AND WHY
 *
 *   1. return the original's stock         so step 4 can check availability
 *                                          against the true shelf
 *   2. void the original's payments        cash stops belonging to a dead invoice
 *   3. reverse the original's journal      the books forget it happened
 *   4. insert + finalize the replacement   stock out again, at the new quantities
 *   5. post the replacement's journal      the books learn what really happened
 *   6. carry the cash forward              the customer does not pay twice
 *
 * Step 1 must precede step 4 or a revision that merely re-rates the same parts
 * would fail its own stock check against stock it is about to give back. Step 6
 * must follow step 4 because a payment can only be attached to an invoice that
 * exists.
 *
 * FAILURE
 *
 * Steps 1-4 run inside the invoice mutex with the same compensation pattern the
 * finalize path uses: every stock movement applied is remembered, and unwound in
 * reverse if a later step throws. Ledger postings (3, 5) are reported rather
 * than thrown, because a posting problem must not undo stock that has already
 * moved — that is the existing convention in routes/invoices.js and this follows
 * it rather than inventing a second one.
 *
 * IDEMPOTENCE
 *
 * Reversal is tolerant of work already done. An invoice whose journal was
 * already reversed by hand from the ledger screen reverses to a no-op rather
 * than an error, which is exactly the state INV/2026/09/003 is in.
 */

const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const invoiceNoLib = require('../lib/invoiceNo');
const billing = require('./billing');
const ledgerSvc = require('./ledger');

/** Local `YYYY-MM-DD HH:MM:SS`, matching the Now() shim every other write uses. */
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Thrown for anything the operator could reasonably fix; carries an HTTP status. */
class RevisionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RevisionError';
    this.httpStatus = status;
  }
}

/**
 * Numeric header fields that describe WHAT THE JOB WAS rather than what was
 * billed, and so must survive onto a replacement.
 *
 * Miss one and the replacement quietly changes meaning: drop IsInternal and work
 * on the shop's own fleet is reported as a sale; drop TechChargePaid and the
 * technician's charge is queued for payment a second time.
 *
 * The text/date header fields (PONo, dates, addresses) are deliberately NOT here
 * — the operator has them on screen while revising and invoiceHeaderColumns()
 * already writes them from the request.
 */
const CARRIED_COLUMNS = ['CustomerID', 'MachineID', 'IsInternal', 'JobID', 'TechChargePaid'];

/** Render the carried values as SQL numeric literals, NULL where unset. */
function carriedValues(original) {
  return CARRIED_COLUMNS.map((c) => {
    const v = original[c];
    return v == null || v === '' ? 'NULL' : String(sql.n(v));
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * What an invoice has actually been paid, counting only payments still standing.
 * @param {number} invoiceId
 * @returns {number}
 */
async function livePaidTotal(invoiceId) {
  const rows = await connection.query(
    `SELECT SUM(Amount) AS total FROM Payments WHERE InvoiceID = ${sql.n(invoiceId)} AND VoidedAt IS NULL`
  );
  return money.round2(money.num(rows[0] && rows[0].total));
}

/**
 * Reverse a payment's journal, tolerating one that was already reversed.
 * @returns {object|null} the reversal posting, or null when there was nothing to reverse
 */
function reversePaymentJournal(paymentId, opts = {}) {
  const journalId = ledgerSvc.isPosted('payment', paymentId);
  if (!journalId) return null;                       // internal jobs never post one
  const already = connection._db
    .prepare('SELECT JournalID FROM JournalEntries WHERE ReversalOf = ?').get(journalId);
  if (already) return null;                          // reversed by hand already
  return ledgerSvc.reverseEntry(journalId, opts);
}

/**
 * Reverse an invoice's journal, tolerating one that was already reversed.
 * @returns {object|null}
 */
function reverseInvoiceJournal(invoiceId, opts = {}) {
  const journalId = ledgerSvc.isPosted('invoice', invoiceId);
  if (!journalId) return null;
  const already = connection._db
    .prepare('SELECT JournalID FROM JournalEntries WHERE ReversalOf = ?').get(journalId);
  if (already) return null;
  return ledgerSvc.reverseEntry(journalId, opts);
}

/**
 * Void one payment: stamp it, reverse its journal, and re-derive AmountPaid from
 * the payments that remain. The row is never deleted — money that moved is a
 * fact even when it moved by mistake.
 *
 * @param {number} paymentId
 * @param {object} [opts] { reason, actor }
 * @returns {Promise<{paymentId:number, invoiceId:number, amount:number,
 *   amountPaid:number, balance:number, status:string, reversal:(object|null)}>}
 */
async function voidPayment(paymentId, opts = {}) {
  const id = sql.n(paymentId);
  const rows = await connection.query(`SELECT * FROM Payments WHERE PaymentID = ${id}`);
  if (rows.length === 0) throw new RevisionError('Payment not found', 404);
  const payment = rows[0];
  if (payment.VoidedAt) throw new RevisionError('That payment has already been voided.');

  const invoiceId = money.num(payment.InvoiceID);
  const inv = await connection.query(`SELECT GrandTotal FROM Invoices WHERE InvoiceID = ${sql.n(invoiceId)}`);
  const grandTotal = inv.length ? inv[0].GrandTotal : 0;

  // Checked BEFORE the payment is stamped. A payment whose journal cannot be
  // reversed must not be marked void: the invoice would go back to unpaid while
  // the ledger kept the cash, the customer would be chased for money they had
  // already handed over, and no route could ever retry the reversal — the void
  // filter would skip it forever.
  if (ledgerSvc.isPosted('payment', paymentId)) assertPostable(payment.PaymentDate);

  // Stamping the payment and re-deriving the invoice's balance are one change,
  // not two: a crash between them would leave a voided payment still counted as
  // money against the invoice.
  const db = connection._db;
  const pay = db.transaction(() => {
    db.prepare('UPDATE Payments SET VoidedAt = ?, VoidedBy = ?, VoidReason = ? WHERE PaymentID = ?')
      .run(nowStamp(), opts.actor || null, opts.reason || null, money.num(paymentId));
    const row = db.prepare(
      'SELECT SUM(Amount) AS total FROM Payments WHERE InvoiceID = ? AND VoidedAt IS NULL').get(invoiceId);
    const paid = money.round2(money.num(row && row.total));
    const status = billing.paymentStatus(grandTotal, paid);
    db.prepare('UPDATE Invoices SET AmountPaid = ?, PaymentStatus = ? WHERE InvoiceID = ?')
      .run(status.amountPaid, status.status, invoiceId);
    return status;
  })();

  let reversal = null;
  try {
    reversal = reversePaymentJournal(paymentId, { postedBy: opts.actor, memo: `Payment voided — ${opts.reason || 'no reason given'}` });
  } catch (err) {
    console.error('Ledger reversal failed for payment', paymentId, '-', err.message);
    reversal = { error: err.message };
  }

  return {
    paymentId: money.num(paymentId),
    invoiceId,
    amount: money.round2(payment.Amount),
    amountPaid: pay.amountPaid,
    balance: pay.balance,
    status: pay.status,
    reversal,
  };
}

// ---------------------------------------------------------------------------
// Revision
// ---------------------------------------------------------------------------

/**
 * Stock the original invoice deducted, keyed by inventory item.
 * A revision gives all of it back before taking what the corrected invoice needs.
 */
async function originalStock(invoiceId) {
  return connection.query(
    `SELECT InventoryID, SUM(Qty) AS Qty FROM InvoiceItems
     WHERE InvoiceID = ${sql.n(invoiceId)} AND InventoryID IS NOT NULL
     GROUP BY InventoryID`
  );
}

/**
 * What each part on the original actually cost when it left the shelf.
 *
 * A revision reuses these rather than re-reading Inventory.Cost. The cost is
 * re-averaged by every purchase, so re-snapshotting it would make a revision
 * that only fixes a RATE move the stock account by qty x cost-drift — money
 * appearing or vanishing with nothing physical behind it.
 *
 * Only the QUANTITY the original billed carries its old cost. If the revision
 * bills more of the same part, those extra units are leaving the shelf now and
 * belong at today's cost — so the caller blends the two.
 *
 * @returns {Promise<Map<number, {cost:number, qty:number}>>}
 */
async function originalCostBasis(invoiceId) {
  const rows = await connection.query(
    `SELECT InventoryID, SUM(Qty) AS Qty, MAX(UnitCostAtBilling) AS Cost FROM InvoiceItems
     WHERE InvoiceID = ${sql.n(invoiceId)} AND InventoryID IS NOT NULL AND UnitCostAtBilling IS NOT NULL
     GROUP BY InventoryID`
  );
  const byId = new Map();
  for (const r of rows) {
    byId.set(Number(r.InventoryID), { cost: money.num(r.Cost), qty: money.num(r.Qty) });
  }
  return byId;
}

/** Is the period containing this date closed to posting? */
function isClosed(date) {
  const d = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return ledgerSvc.periodStatus(connection._db, d.slice(0, 7)) === 'closed';
}

/**
 * The date a correction should be posted on.
 *
 * Same date as the original when that period is still open, so a same-month fix
 * lands in the month it belongs to. If the period has been closed, the
 * correction goes to the supplied date instead — a closed period is closed.
 */
function correctionDate(originalDate, fallbackDate) {
  const original = String(originalDate || '').slice(0, 10);
  const fallback = String(fallbackDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(original)) return fallback;
  return isClosed(original) ? fallback : original;
}

/**
 * Refuse a revision that could not reach the books, BEFORE anything moves.
 *
 * Every posting a revision makes lands either on its own date or, when the
 * original's period has been closed, falls back to it. So one check covers all
 * of them: if the date the revision is being given is itself in a closed period,
 * nothing can post.
 *
 * This has to be a refusal rather than a warning. The alternative — which is
 * what the first cut of this code did — is an invoice that is rearranged in
 * every table while the general ledger sits untouched, reported to the operator
 * as a success. That is the exact failure this whole feature exists to clean up.
 */
function assertPostable(date) {
  if (isClosed(date)) {
    throw new RevisionError(
      `Period ${String(date).slice(0, 7)} is closed, so the correction cannot reach the books. `
      + 'Give the revision a date in an open period, or reopen that period first.', 409);
  }
}

/**
 * Check a revision is allowed before anything is touched.
 * @returns {object} the original invoice row
 */
async function loadRevisable(invoiceId) {
  const rows = await connection.query(`SELECT * FROM Invoices WHERE InvoiceID = ${sql.n(invoiceId)}`);
  if (rows.length === 0) throw new RevisionError('Invoice not found', 404);
  const inv = rows[0];

  if (inv.Status === 'Draft') {
    throw new RevisionError(
      `${inv.InvoiceNo} is still a draft — edit it directly instead of revising it.`, 409);
  }
  if (inv.Status === 'Cancelled') {
    throw new RevisionError(`${inv.InvoiceNo} was cancelled. A cancelled invoice is not revised — raise a new one.`, 409);
  }
  if (inv.Status === 'Revised') {
    const by = await connection.query(
      `SELECT InvoiceNo FROM Invoices WHERE InvoiceID = ${sql.n(inv.SupersededBy)}`);
    const replacement = by.length ? by[0].InvoiceNo : 'a later revision';
    throw new RevisionError(
      `${inv.InvoiceNo} has already been revised — it was replaced by ${replacement}. Revise that one instead.`, 409);
  }
  if (inv.Status !== 'Finalized') {
    throw new RevisionError(`${inv.InvoiceNo} is ${inv.Status} and cannot be revised.`, 409);
  }
  return inv;
}

/**
 * The revision chain an invoice belongs to, oldest first.
 * @param {number} invoiceId any invoice in the chain
 */
async function chain(invoiceId) {
  const rows = await connection.query(`SELECT InvoiceNo FROM Invoices WHERE InvoiceID = ${sql.n(invoiceId)}`);
  if (rows.length === 0) throw new RevisionError('Invoice not found', 404);
  const base = invoiceNoLib.baseNo(rows[0].InvoiceNo);
  const all = await connection.query(
    `SELECT InvoiceID, InvoiceNo, InvoiceDate, Status, GrandTotal, AmountPaid, RevisionNo,
            RevisionOf, SupersededBy, RevisedAt, RevisedBy, RevisionReason
     FROM Invoices
     WHERE InvoiceNo = ${sql.q(base)} OR InvoiceNo LIKE ${sql.q(`${base}-R%`)}`
  );
  return all
    .filter((r) => invoiceNoLib.baseNo(r.InvoiceNo) === base)
    .sort((a, b) => invoiceNoLib.revisionIndex(a.InvoiceNo) - invoiceNoLib.revisionIndex(b.InvoiceNo));
}

module.exports = {
  RevisionError,
  CARRIED_COLUMNS,
  carriedValues,
  livePaidTotal,
  reversePaymentJournal,
  reverseInvoiceJournal,
  voidPayment,
  originalStock,
  originalCostBasis,
  isClosed,
  correctionDate,
  assertPostable,
  loadRevisable,
  chain,
};
