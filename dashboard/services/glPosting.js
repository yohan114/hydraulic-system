'use strict';

/**
 * Posting rules — how a business event becomes a journal entry.
 *
 * One place, so the accounting treatment of an event is stated once and every
 * caller gets the same answer. Each function builds the lines and hands them to
 * services/ledger.js, which enforces balance, chart membership and period.
 *
 * THE TREATMENTS
 *
 *   External invoice     Dr Accounts Receivable
 *                        Cr Sales — Parts / Sales — Technical
 *                        Cr Taxes Payable          (SSCL/VAT, collected for the state)
 *                        Dr Cost of Sales — Parts
 *                        Cr Inventory              (at landed cost)
 *
 *   Internal invoice     Dr Internal Repairs & Maintenance
 *                        Cr Inventory              (at landed cost)
 *     Work on the shop's own plant. No sale, no receivable, no cash: the parts
 *     simply move off the shelf and become a cost of running the workshop. The
 *     billed "price" on an internal job is an internal transfer figure and is
 *     deliberately NOT revenue.
 *
 *   Customer payment     Dr Cash in Hand
 *                        Cr Accounts Receivable
 *     Only for external invoices. A "payment" recorded against an internal job
 *     is the old system closing the job, not money arriving, and is not posted.
 *
 *   Expense              Dr the matching expense account
 *                        Cr Cash in Hand
 *
 *   Labour paid          Dr Wages & Labour Paid
 *                        Cr Cash in Hand
 *
 *   Stock purchase       Dr Inventory
 *                        Cr Accounts Payable   (or Cash when paid on the spot)
 */

const connection = require('../db');
const money = require('../lib/money');
const ledgerSvc = require('./ledger');
const auditLog = require('../lib/auditLog');

const ACC = {
  CASH: '1110',
  BANK: '1120',
  AR: '1200',
  STOCK: '1300',
  AP: '2100',
  TAX_PAYABLE: '2300',
  OPENING_EQUITY: '3900',
  SALES_PARTS: '4100',
  SALES_TECHNICAL: '4200',
  COGS_PARTS: '5100',
  STOCK_ADJUST: '5900',
  WAGES: '6100',
  SUNDRY: '6200',
  OTHER_EXPENSE: '6300',
  INTERNAL_WORK: '6900',
  CUSTOMER_CREDIT: '2400',
};

// A line is technical/crimping/welding/lathe labour rather than a part.
const TECHNICAL_RE = /technical charge|crimping|welding|lathe/i;
const NON_TECHNICAL_RE = /fitting|rod|sundr/i;

/** Split an invoice's billed value between parts and technical labour. */
function splitRevenue(lines) {
  let parts = 0;
  let technical = 0;
  for (const l of lines) {
    const amount = money.round2(money.num(l.Qty) * money.num(l.Rate));
    const desc = String(l.ItemDescription || '');
    if (TECHNICAL_RE.test(desc) && !NON_TECHNICAL_RE.test(desc)) technical = money.round2(technical + amount);
    else parts = money.round2(parts + amount);
  }
  return { parts, technical };
}

/** What the parts on this invoice cost us, at the price they were booked in at. */
function costOfLines(lines) {
  return money.round2(lines.reduce(
    (a, l) => a + money.num(l.Qty) * money.num(l.UnitCostAtBilling), 0));
}

function invoiceLines(invoiceId) {
  return connection._db.prepare(
    'SELECT ItemDescription, Qty, Rate, UnitCostAtBilling FROM InvoiceItems WHERE InvoiceID = ?'
  ).all(invoiceId);
}

/**
 * Post a finalized invoice.
 *
 * @param {number} invoiceId
 * @param {object} [opts] { postedBy, allowClosedPeriod }
 * @returns {object|null} the posting result, or null when there is nothing to post
 */
function postInvoice(invoiceId, opts = {}) {
  const db = connection._db;
  const inv = db.prepare('SELECT * FROM Invoices WHERE InvoiceID = ?').get(invoiceId);
  if (!inv) throw new ledgerSvc.LedgerError(`Invoice ${invoiceId} not found`, 404);
  if (inv.Status !== 'Finalized') return null;   // drafts and voids are not transactions

  const items = invoiceLines(invoiceId);
  const cost = costOfLines(items);
  const date = String(inv.InvoiceDate || '').slice(0, 10);
  const lines = [];

  if (inv.IsInternal) {
    // Own plant: stock becomes a workshop cost. Nothing else moves.
    if (cost <= 0) return null;
    lines.push(
      { accountCode: ACC.INTERNAL_WORK, debit: cost, memo: `Internal work ${inv.InvoiceNo}`, customerId: inv.CustomerID || null },
      { accountCode: ACC.STOCK, credit: cost, memo: `Parts used on ${inv.InvoiceNo}` }
    );
  } else {
    const rawRevenue = splitRevenue(items);
    const tax = money.round2(money.num(inv.SSCLAmount) + money.num(inv.VATAmount));
    const discount = money.round2(money.num(inv.Discount));
    const roundOff = money.round2(money.num(inv.RoundOff));
    const grandTotal = money.round2(money.num(inv.GrandTotal));

    // Total gross before discount/roundoff
    const grossTotal = money.round2(rawRevenue.parts + rawRevenue.technical);
    let netParts = rawRevenue.parts;
    let netTech = rawRevenue.technical;

    // Adjust revenue proportionally for discounts & roundoffs so AR exactly equals GrandTotal
    if (grossTotal > 0 && (discount !== 0 || roundOff !== 0)) {
      const netGross = money.round2(grossTotal - discount + roundOff);
      const ratio = netGross / grossTotal;
      netParts = money.round2(rawRevenue.parts * ratio);
      netTech = money.round2(netGross - netParts);
    }

    const receivable = grandTotal > 0 ? grandTotal : money.round2(netParts + netTech + tax);
    if (receivable <= 0 && cost <= 0) return null;

    if (receivable > 0) {
      lines.push({
        accountCode: ACC.AR,
        debit: receivable,
        memo: `Invoice ${inv.InvoiceNo}${inv.BilledToName ? ` (${inv.BilledToName})` : ''}`,
        customerId: inv.CustomerID || null,
      });
    }
    if (netParts > 0) {
      lines.push({ accountCode: ACC.SALES_PARTS, credit: netParts, customerId: inv.CustomerID || null });
    }
    if (netTech > 0) {
      lines.push({ accountCode: ACC.SALES_TECHNICAL, credit: netTech, customerId: inv.CustomerID || null });
    }
    if (tax > 0) {
      lines.push({ accountCode: ACC.TAX_PAYABLE, credit: tax, memo: 'SSCL / VAT collected' });
    }

    if (cost > 0) {
      lines.push(
        { accountCode: ACC.COGS_PARTS, debit: cost, memo: `Cost of parts on ${inv.InvoiceNo}` },
        { accountCode: ACC.STOCK, credit: cost, memo: `Parts sold on ${inv.InvoiceNo}` }
      );
    }
  }

  if (!lines.length) return null;
  return ledgerSvc.postEntry({
    date,
    memo: inv.IsInternal ? `Internal job ${inv.InvoiceNo}` : `Invoice ${inv.InvoiceNo}`,
    sourceType: 'invoice',
    sourceID: invoiceId,
    postedBy: opts.postedBy,
    allowClosedPeriod: opts.allowClosedPeriod,
    lines,
  });
}

/**
 * Post a customer payment. Payments against internal jobs are not cash and are
 * skipped — see the module comment.
 */
function postPayment(paymentId, opts = {}) {
  const db = connection._db;
  const p = db.prepare(`
    SELECT p.*, i.InvoiceNo, i.IsInternal, i.CustomerID
    FROM Payments p JOIN Invoices i ON i.InvoiceID = p.InvoiceID
    WHERE p.PaymentID = ?`).get(paymentId);
  if (!p) throw new ledgerSvc.LedgerError(`Payment ${paymentId} not found`, 404);
  if (p.IsInternal) return null;

  const amount = money.round2(p.Amount);
  if (amount <= 0) return null;

  const cashAccount = /bank|transfer|cheque|card/i.test(p.Method || '') ? ACC.BANK : ACC.CASH;
  return ledgerSvc.postEntry({
    date: String(p.PaymentDate || '').slice(0, 10),
    memo: `Payment for ${p.InvoiceNo}`,
    sourceType: 'payment',
    sourceID: paymentId,
    postedBy: opts.postedBy,
    allowClosedPeriod: opts.allowClosedPeriod,
    lines: [
      { accountCode: cashAccount, debit: amount, memo: p.Method || 'Cash' },
      { accountCode: ACC.AR, credit: amount, customerId: p.CustomerID },
    ],
  });
}

// Expense category -> account. Anything unrecognised lands in Other Operating.
const EXPENSE_ACCOUNT = {
  electricity: ACC.SUNDRY,
  sundry: ACC.SUNDRY,
  utilities: ACC.SUNDRY,
  wages: ACC.WAGES,
  labour: ACC.WAGES,
  salary: ACC.WAGES,
};

function accountForExpense(category) {
  const key = String(category || '').trim().toLowerCase();
  return EXPENSE_ACCOUNT[key] || ACC.OTHER_EXPENSE;
}

function postExpense(expenseId, opts = {}) {
  const e = connection._db.prepare('SELECT * FROM Expenses WHERE ExpenseID = ?').get(expenseId);
  if (!e) throw new ledgerSvc.LedgerError(`Expense ${expenseId} not found`, 404);
  const amount = money.round2(e.Amount);
  if (amount <= 0) return null;

  const cashAccount = /bank|transfer|cheque|card/i.test(e.Method || '') ? ACC.BANK : ACC.CASH;
  return ledgerSvc.postEntry({
    date: String(e.ExpenseDate || '').slice(0, 10),
    memo: `Expense — ${e.Category || 'other'}${e.Notes ? `: ${e.Notes}` : ''}`,
    sourceType: 'expense',
    sourceID: expenseId,
    postedBy: opts.postedBy,
    allowClosedPeriod: opts.allowClosedPeriod,
    lines: [
      { accountCode: accountForExpense(e.Category), debit: amount },
      { accountCode: cashAccount, credit: amount },
    ],
  });
}

function postLabourPayment(labourPaymentId, opts = {}) {
  const l = connection._db.prepare('SELECT * FROM LabourPayments WHERE LabourPaymentID = ?').get(labourPaymentId);
  if (!l) throw new ledgerSvc.LedgerError(`Labour payment ${labourPaymentId} not found`, 404);
  const amount = money.round2(l.Amount);
  if (amount <= 0) return null;

  const cashAccount = /bank|transfer|cheque|card/i.test(l.Method || '') ? ACC.BANK : ACC.CASH;
  return ledgerSvc.postEntry({
    date: String(l.PaymentDate || '').slice(0, 10),
    memo: `Labour paid${l.PayPeriod ? ` for ${l.PayPeriod}` : ''}`,
    sourceType: 'labour',
    sourceID: labourPaymentId,
    postedBy: opts.postedBy,
    allowClosedPeriod: opts.allowClosedPeriod,
    lines: [
      { accountCode: ACC.WAGES, debit: amount },
      { accountCode: cashAccount, credit: amount },
    ],
  });
}

function postPurchase(purchaseId, opts = {}) {
  const p = connection._db.prepare('SELECT * FROM Purchases WHERE PurchaseID = ?').get(purchaseId);
  if (!p) throw new ledgerSvc.LedgerError(`Purchase ${purchaseId} not found`, 404);
  const value = money.round2(money.num(p.Qty) * money.num(p.UnitPrice));
  if (value <= 0) return null;

  return ledgerSvc.postEntry({
    date: String(p.PurchaseDate || '').slice(0, 10),
    memo: `Stock purchase${p.Notes ? ` — ${p.Notes}` : ''}`,
    sourceType: 'purchase',
    sourceID: purchaseId,
    postedBy: opts.postedBy,
    allowClosedPeriod: opts.allowClosedPeriod,
    lines: [
      { accountCode: ACC.STOCK, debit: value },
      { accountCode: ACC.AP, credit: value, supplierId: p.SupplierID },
    ],
  });
}

/** Reverse the journal a cancelled invoice produced, if it had one. */
function reverseInvoice(invoiceId, opts = {}) {
  const journalId = ledgerSvc.isPosted('invoice', invoiceId);
  if (!journalId) return null;
  return ledgerSvc.reverseEntry(journalId, opts);
}

/**
 * Core accounting handler for invoice classification changes (Internal <-> External).
 * Automatically reverses existing journal entries using double-entry reversal logic (T31)
 * and triggers reposting of the invoice to the appropriate General Ledger accounts.
 *
 * @param {number|string} invoiceId
 * @param {boolean|number} targetIsInternal
 * @param {object} [opts] { postedBy, actorRole, reason, allowClosedPeriod }
 * @returns {object} { success, invoiceId, invoiceNo, isInternal, paymentStatus, reversalJournal, newJournal, message }
 */
function reclassifyInvoice(invoiceId, targetIsInternal, opts = {}) {
  const db = connection._db;
  const id = Number(invoiceId);
  const actor = opts.postedBy || 'system';
  const role = opts.actorRole || 'admin';
  const reason = String(opts.reason || 'Invoice classification changed').trim();
  const isInternal = Boolean(targetIsInternal);

  const inv = db.prepare('SELECT * FROM Invoices WHERE InvoiceID = ?').get(id);
  if (!inv) throw new ledgerSvc.LedgerError(`Invoice ${id} not found`, 404);
  if (inv.Status !== 'Finalized') {
    throw new ledgerSvc.LedgerError(`Cannot reclassify invoice in '${inv.Status}' status. Only Finalized invoices can be reclassified.`, 400);
  }

  const currentIsInternal = Boolean(inv.IsInternal);
  if (currentIsInternal === isInternal) {
    throw new ledgerSvc.LedgerError(`Invoice ${inv.InvoiceNo} is already classified as ${isInternal ? 'Internal' : 'External'}.`, 400);
  }

  // Payments cannot exist on internal work
  if (isInternal) {
    const pay = db.prepare('SELECT COUNT(*) AS c FROM Payments WHERE InvoiceID = ?').get(id);
    if (pay && pay.c > 0) {
      throw new ledgerSvc.LedgerError('Cannot convert to Internal while customer payments exist. Reallocate or refund payments first.', 409);
    }
  }

  // Period status check
  const invDate = String(inv.InvoiceDate || '').slice(0, 10);
  const period = invDate.slice(0, 7);
  if (!opts.allowClosedPeriod && ledgerSvc.periodStatus(db, period) === 'closed') {
    throw new ledgerSvc.LedgerError(`Period ${period} is closed — cannot reclassify invoice in a closed period.`, 409);
  }

  return db.transaction(() => {
    // 1. Automatically reverse existing journal entry using double-entry reversal
    let reversal = null;
    const prevJournalId = ledgerSvc.isPosted('invoice', id);
    if (prevJournalId) {
      reversal = ledgerSvc.reverseEntry(prevJournalId, {
        postedBy: actor,
        memo: `Reversal of ${inv.InvoiceNo} due to reclassification from ${currentIsInternal ? 'Internal' : 'External'} to ${isInternal ? 'Internal' : 'External'}: ${reason}`,
        allowClosedPeriod: opts.allowClosedPeriod,
      });
    }

    // 2. Adjust payment status and customer assignment
    let newPaymentStatus = 'Unpaid';
    if (isInternal) {
      newPaymentStatus = 'Not Applicable';
    } else {
      const paid = money.num(inv.AmountPaid);
      const grand = money.num(inv.GrandTotal);
      newPaymentStatus = paid >= grand ? 'Paid' : (paid > 0 ? 'Partial' : 'Unpaid');
    }

    let customerId = inv.CustomerID;
    if (isInternal && !customerId) {
      const internalCust = db.prepare("SELECT CustomerID FROM Customers WHERE Kind = 'internal' ORDER BY CustomerID ASC LIMIT 1").get();
      if (internalCust) customerId = internalCust.CustomerID;
    }

    db.prepare(`
      UPDATE Invoices
      SET IsInternal = ?, PaymentStatus = ?, CustomerID = ?
      WHERE InvoiceID = ?
    `).run(isInternal ? 1 : 0, newPaymentStatus, customerId || null, id);

    // 3. Post to General Ledger with the new classification
    //    - Internal: Dr 6900 (Internal R&M) / Cr 1300 (Stock at landed cost)
    //    - External: Dr 1200 (AR) / Cr 4100/4200 (Sales) / Cr 2300 (Taxes) / Dr 5100 (COGS) / Cr 1300 (Stock)
    const newJournal = postInvoice(id, {
      postedBy: actor,
      allowClosedPeriod: opts.allowClosedPeriod,
    });

    // 4. Record Business Audit Log
    try {
      auditLog.recordBusinessAudit(db, {
        actorId: actor,
        actorRole: role,
        action: 'reclassify_invoice',
        entityType: 'Invoices',
        entityId: String(id),
        payloadBefore: { isInternal: currentIsInternal, paymentStatus: inv.PaymentStatus },
        payloadAfter: { isInternal, paymentStatus: newPaymentStatus, reason },
        reason,
      });
    } catch (_) {}

    return {
      success: true,
      invoiceId: id,
      invoiceNo: inv.InvoiceNo,
      isInternal,
      paymentStatus: newPaymentStatus,
      reversalJournal: reversal,
      newJournal,
      message: `Invoice ${inv.InvoiceNo} successfully reclassified to ${isInternal ? 'Internal Fleet' : 'Commercial (External)'}.`,
    };
  })();
}

/**
 * Post a customer credit liability (e.g. from downward revision overpayment).
 * Cash in till was preserved, so:
 * Dr Cash (1110)
 * Cr Customer Credits (2400)
 */
function postCustomerCredit(creditId, opts = {}) {
  const db = connection._db;
  const c = db.prepare('SELECT * FROM CustomerCredits WHERE CreditID = ?').get(creditId);
  if (!c) throw new ledgerSvc.LedgerError(`CustomerCredit ${creditId} not found`, 404);
  const amount = money.round2(c.OriginalAmount);
  if (amount <= 0) return null;

  const date = String(opts.date || c.CreatedAt || '').slice(0, 10);
  return ledgerSvc.postEntry({
    date,
    memo: `Customer credit #${c.CreditID} — ${c.Notes || 'overpayment'}`,
    sourceType: 'customer_credit',
    sourceID: creditId,
    postedBy: opts.postedBy,
    allowClosedPeriod: opts.allowClosedPeriod,
    lines: [
      { accountCode: ACC.CASH, debit: amount, memo: 'Overpayment held as credit liability' },
      { accountCode: ACC.CUSTOMER_CREDIT, credit: amount, customerId: c.CustomerID, memo: `Credit #${c.CreditID}` },
    ],
  });
}

/**
 * Post a physical cash or bank refund against a customer credit.
 * Dr Customer Credits (2400)
 * Cr Cash in Hand (1110) or Bank (1120)
 */
function postRefund(refundId, opts = {}) {
  const db = connection._db;
  const r = db.prepare('SELECT * FROM Refunds WHERE RefundID = ?').get(refundId);
  if (!r) throw new ledgerSvc.LedgerError(`Refund ${refundId} not found`, 404);
  const amount = money.round2(r.Amount);
  if (amount <= 0) return null;

  const cashAccount = /bank|transfer|cheque|card/i.test(r.PaymentMethod || '') ? ACC.BANK : ACC.CASH;
  const date = String(r.RefundDate || '').slice(0, 10);
  const entry = ledgerSvc.postEntry({
    date,
    memo: `Refund #${r.RefundID} for credit #${r.CreditID}`,
    sourceType: 'refund',
    sourceID: refundId,
    postedBy: opts.postedBy,
    allowClosedPeriod: opts.allowClosedPeriod,
    lines: [
      { accountCode: ACC.CUSTOMER_CREDIT, debit: amount, customerId: r.CustomerID, memo: `Refund #${r.RefundID}` },
      { accountCode: cashAccount, credit: amount, memo: r.PaymentMethod || 'Cash' },
    ],
  });
  if (entry && entry.journalId) {
    db.prepare('UPDATE Refunds SET JournalID = ? WHERE RefundID = ?').run(entry.journalId, refundId);
  }
  return entry;
}

module.exports = {
  ACC, TECHNICAL_RE,
  splitRevenue, costOfLines, accountForExpense,
  postInvoice, postPayment, postExpense, postLabourPayment, postPurchase, reverseInvoice,
  reclassifyInvoice, logAuditReversal: ledgerSvc.logAuditReversal,
  postCustomerCredit, postRefund,
};
