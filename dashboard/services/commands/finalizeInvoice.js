'use strict';

const connection = require('../../db');
const glPosting = require('../glPosting');
const { checkIdempotency, recordIdempotency } = require('../../lib/idempotency');
const { recordBusinessAudit } = require('../../lib/auditLog');

function assertPeriodOpen(db, date) {
  const period = String(date).slice(0, 7);
  const row = db.prepare("SELECT Status FROM Periods WHERE Period = ?").get(period);
  if (row && row.Status === 'closed') {
    const err = new Error(`Period ${period} is closed.`);
    err.httpStatus = 409;
    err.code = 'PERIOD_CLOSED';
    throw err;
  }
}

/**
 * Execute invoice finalization command directly (e.g. from background worker, API, or CLI).
 * Enforces identical business invariants:
 *  - Idempotency checking
 *  - Invoice status check (must be Draft)
 *  - Customer existence & Kind check (internal vs external)
 *  - Accounting period open check
 *  - Stock sufficiency validation
 *  - Synchronous inventory reduction & StockMovements insertion
 *  - Invoice status -> Finalized
 *  - Synchronous General Ledger entry posting via glPosting.postInvoice
 *  - Synchronous BusinessAuditLog writing
 *  - Atomic transaction rollback on any failure
 *
 * @param {object} command { invoiceId, idempotencyKey, payload }
 * @param {object} principal { username, role, userId }
 * @param {object} [dbOverride] optional SQLite db instance (defaults to connection._db)
 */
function executeFinalizeInvoice(command, principal = {}, dbOverride = null) {
  const db = dbOverride || connection._db;
  const { invoiceId, idempotencyKey, payload } = command;
  const actor = principal.username || principal.userId || 'system';
  const role = principal.role || 'system';

  if (!invoiceId) throw new Error('Invoice ID required');

  if (idempotencyKey) {
    const idemp = checkIdempotency(db, idempotencyKey, actor, payload || { invoiceId });
    if (idemp.match) {
      if (idemp.mismatch) {
        const err = new Error('Payload does not match idempotency key.');
        err.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
        err.httpStatus = 409;
        throw err;
      }
      return idemp.cached.body;
    }
  }

  const tx = db.transaction(() => {
    // 1. Fetch & lock draft
    const inv = db.prepare('SELECT * FROM Invoices WHERE InvoiceID = ?').get(invoiceId);
    if (!inv) {
      const err = new Error('Invoice not found');
      err.httpStatus = 404;
      throw err;
    }
    if (inv.Status !== 'Draft') {
      const err = new Error(`Invoice is ${inv.Status} and cannot be finalized.`);
      err.httpStatus = 403;
      throw err;
    }

    // 2. Resolve & enforce Ownership
    const customer = db.prepare('SELECT CustomerID, Kind FROM Customers WHERE CustomerID = ?').get(inv.CustomerID);
    if (!customer) {
      const err = new Error('Customer required for finalization');
      err.httpStatus = 400;
      throw err;
    }
    const isInternal = (customer.Kind && customer.Kind.toLowerCase() === 'internal') ? 1 : 0;

    // 3. Check Period
    const invoiceDate = String(inv.InvoiceDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
      const err = new Error('Invalid InvoiceDate format');
      err.httpStatus = 400;
      throw err;
    }
    assertPeriodOpen(db, invoiceDate);

    // 4. Validate stock & deduct inventory
    const items = db.prepare('SELECT * FROM InvoiceItems WHERE InvoiceID = ?').all(invoiceId);
    for (const item of items) {
      if (!item.InventoryID) continue;
      const stock = db.prepare('SELECT Qty, Cost FROM Inventory WHERE InventoryID = ?').get(item.InventoryID);
      if (!stock || stock.Qty < item.Qty) {
        const err = new Error(`Insufficient stock for item ID ${item.InventoryID}`);
        err.code = 'INSUFFICIENT_STOCK';
        err.httpStatus = 409;
        throw err;
      }
      const prev = stock.Qty;
      const next = prev - item.Qty;
      db.prepare('UPDATE Inventory SET Qty = ? WHERE InventoryID = ?').run(next, item.InventoryID);
      db.prepare(`INSERT INTO StockMovements (InventoryID, InvoiceID, MovementType, QtyChange, PreviousQty, NewQty, MovementDate, Notes)
                  VALUES (?, ?, 'OUT', ?, ?, ?, ?, ?)`
      ).run(item.InventoryID, invoiceId, -item.Qty, prev, next, invoiceDate, `INV:${inv.InvoiceNo}`);
    }

    // 5. Update Invoice status & stamp ownership
    const paymentStatus = isInternal ? 'Not Applicable' : 'Unpaid';
    db.prepare(`UPDATE Invoices SET Status = 'Finalized', IsInternal = ?, FinalizedAt = datetime('now'), PaymentStatus = ?
                WHERE InvoiceID = ?`).run(isInternal, paymentStatus, invoiceId);

    // 6. Post General Ledger Entry synchronously
    const journalResult = glPosting.postInvoice(invoiceId, { postedBy: actor });

    // 7. Write Transactional Business Audit
    recordBusinessAudit(db, {
      txId: `FIN-${invoiceId}-${Date.now()}`,
      actorId: actor,
      actorRole: role,
      action: 'invoice.finalize',
      entityType: 'invoice',
      entityId: String(invoiceId),
      payloadBefore: { invoiceId, status: inv.Status },
      payloadAfter: { invoiceId, grandTotal: inv.GrandTotal, isInternal, journalId: journalResult ? journalResult.journalId : null }
    });

    const result = {
      success: true,
      invoiceId,
      status: 'Finalized',
      journalId: journalResult ? journalResult.journalId : null,
      isInternal,
      paymentStatus
    };

    if (idempotencyKey) {
      recordIdempotency(db, idempotencyKey, actor, 'finalize_invoice', payload || { invoiceId }, 200, result);
    }

    return result;
  });

  return tx.immediate();
}

module.exports = {
  executeFinalizeInvoice
};
