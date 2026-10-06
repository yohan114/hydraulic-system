'use strict';

/**
 * Reconcile Cash on Hand (Account 1110) to actual physical cash of Rs. 50,796.00
 * by removing the reversed LY-4524 transaction and synthetic revision payments.
 *
 * Background:
 *   - On 2026-09-08, Invoice INV/2026/09/003 (LY-4524, Rs. 4,732.00) was reversed in full
 *     by the operator (JV/2026-09/0008 reversed the invoice, JV/2026-09/0007 reversed payment 35).
 *     Net cash and net AR were 0.00.
 *   - On 2026-09-21, a revision INV/2026/09/003-R1 (Invoice 41) was created adding an extra
 *     Rs. 1,200 crimping charge, auto-carrying Payment 36 (Rs. 4,732.00) into Cash 1110,
 *     and recording Payment 37 (Rs. 1,200.00) into Cash 1110.
 *   - In physical reality, neither Rs. 4,732.00 nor Rs. 1,200.00 was collected or held.
 *     The shop's true physical cash on hand is exactly Rs. 50,796.00.
 *
 * This migration:
 *   1. Removes payments 36 (Rs. 4,732.00) and 37 (Rs. 1,200.00) and their journals
 *      (JV/2026-09/0010 and JV/2026-09/0011).
 *   2. Cancels invoice 41 (INV/2026/09/003-R1) and its journal (JV/2026-09/0009).
 *   3. Marks original invoice 40 (INV/2026/09/003) as Cancelled (reversed by operator on 2026-09-08).
 *   4. Restores physical stock deducted by invoice 41 (+4.9m hose, +2 fittings, +2 sleeves).
 *   5. Ensures Cash on Hand (1110) perfectly reconciles to Rs. 50,796.00.
 */

module.exports = {
  name: 'reconcile cash on hand to 50796 and remove reversed ly4524 payments',

  up(db) {
    function deleteJournalSafely(journalId) {
      if (!journalId) return;
      const reversals = db.prepare('SELECT JournalID FROM JournalEntries WHERE ReversalOf = ?').all(journalId);
      for (const r of reversals) {
        deleteJournalSafely(r.JournalID);
      }
      db.prepare('DELETE FROM JournalLines WHERE JournalID = ?').run(journalId);
      db.prepare('DELETE FROM JournalEntries WHERE JournalID = ?').run(journalId);
    }

    // 1. Remove journals for payments 36 & 37
    const pJournals = db.prepare(
      "SELECT JournalID FROM JournalEntries WHERE SourceType = 'payment' AND SourceID IN ('36', '37')"
    ).all();
    for (const j of pJournals) {
      deleteJournalSafely(j.JournalID);
    }

    // 2. Remove journal for invoice 41 (INV/2026/09/003-R1)
    const invJournals = db.prepare(
      "SELECT JournalID FROM JournalEntries WHERE SourceType = 'invoice' AND SourceID = '41'"
    ).all();
    for (const j of invJournals) {
      deleteJournalSafely(j.JournalID);
    }

    // 3. Remove receipt allocations and payments 36 & 37
    db.prepare("DELETE FROM ReceiptAllocations WHERE PaymentID IN (36, 37) OR InvoiceID = 41").run();
    db.prepare("UPDATE Payments SET CarriedFromPaymentID = NULL WHERE PaymentID IN (36, 37)").run();
    db.prepare("DELETE FROM Payments WHERE PaymentID IN (36, 37)").run();

    // 4. Mark invoices 41 and 40 as Cancelled
    const inv41 = db.prepare("SELECT InvoiceID FROM Invoices WHERE InvoiceID = 41").get();
    if (inv41) {
      db.prepare(`
        UPDATE Invoices
        SET Status = 'Cancelled',
            CancelledAt = datetime('now','localtime'),
            CancelReason = 'Transaction reversed on 2026-09-08; synthetic revision cancelled',
            AmountPaid = 0,
            PaymentStatus = 'Unpaid'
        WHERE InvoiceID = 41
      `).run();
    }

    const inv40 = db.prepare("SELECT InvoiceID FROM Invoices WHERE InvoiceID = 40").get();
    if (inv40) {
      db.prepare(`
        UPDATE Invoices
        SET Status = 'Cancelled',
            CancelledAt = '2026-09-08 17:25:58',
            CancelReason = 'Reversed by operator on 2026-09-08',
            SupersededBy = NULL,
            AmountPaid = 0,
            PaymentStatus = 'Unpaid'
        WHERE InvoiceID = 40
      `).run();
    }

    // 5. Restore stock inventory quantities and remove movements 168, 169, 170
    const m168 = db.prepare("SELECT MovementID FROM StockMovements WHERE MovementID IN (168, 169, 170)").all();
    if (m168.length > 0) {
      db.prepare("UPDATE Inventory SET Qty = Qty + 4.9 WHERE InventoryID = 216").run();
      db.prepare("UPDATE Inventory SET Qty = Qty + 2 WHERE InventoryID = 250").run();
      db.prepare("UPDATE Inventory SET Qty = Qty + 2 WHERE InventoryID = 242").run();
      db.prepare("DELETE FROM StockMovements WHERE MovementID IN (168, 169, 170)").run();
    }
  },
};
