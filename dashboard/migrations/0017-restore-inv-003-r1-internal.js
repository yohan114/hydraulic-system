'use strict';

/**
 * Restore INV/2026/09/003-R1 (Invoice 41) as an active internal invoice and mark
 * original INV/2026/09/003 (Invoice 40) as Revised.
 *
 * User Requirement:
 *   "INV/2026/09/003-R1 is invoice not a cancell one this is internal invoice"
 *
 * Background:
 *   - LY-4524 is a company fleet vehicle (registered to CustomerID 1).
 *   - INV/2026/09/003 was originally issued for LY-4524. When a missing crimping
 *     charge was identified, revision INV/2026/09/003-R1 (Invoice 41) was created.
 *   - Migration 0016 mistakenly cancelled Invoice 41 thinking the reversal was
 *     an accidental transaction, and rolled back stock deductions.
 *   - In truth, INV/2026/09/003-R1 is a genuine internal work order / cost invoice
 *     for the company's own vehicle. As an internal invoice:
 *       1. Status = 'Finalized'
 *       2. IsInternal = 1, CustomerID = 1, MachineID = LY-4524
 *       3. PaymentStatus = 'Internal', AmountPaid = 0 (no cash/AR impact)
 *       4. Original Invoice 40 Status = 'Revised', SupersededBy = 41
 *       5. Stock consumed (-4.9m hose, -2 fittings, -2 ferrules) is deducted
 *          and recorded in StockMovements for Invoice 41
 *       6. GL Journal Entry is posted: Dr 6900 (Internal Workshop Expense) /
 *          Cr 1300 (Inventory Control) at parts cost
 */

module.exports = {
  name: 'restore inv 003 r1 as internal company fleet invoice',

  up(db) {
    // 1. Ensure machine LY-4524 is registered under Customer 1 (Internal / Own Fleet)
    let lyMach = db.prepare("SELECT MachineID FROM Machines WHERE Name = 'LY-4524'").get();
    if (!lyMach) {
      const res = db.prepare(`
        INSERT INTO Machines (Code, Name, Kind, CustomerID, Active, Notes, CreatedAt, UpdatedAt)
        VALUES ('M-LY-4524', 'LY-4524', 'registration', 1, 1, 'Company Fleet Vehicle', datetime('now','localtime'), datetime('now','localtime'))
      `).run();
      lyMach = { MachineID: res.lastInsertRowid };
    }

    // 2. Update original Invoice 40 (INV/2026/09/003) -> Status: Revised, SupersededBy: 41
    const inv40 = db.prepare("SELECT InvoiceID FROM Invoices WHERE InvoiceID = 40").get();
    if (inv40) {
      db.prepare(`
        UPDATE Invoices
        SET Status = 'Revised',
            CancelledAt = NULL,
            CancelReason = NULL,
            SupersededBy = 41,
            RevisionReason = 'crimping charge was left',
            RevisedAt = '2026-09-21 12:06:09',
            RevisedBy = 'operator',
            IsInternal = 1,
            CustomerID = 1,
            MachineID = ?,
            AmountPaid = 0,
            PaymentStatus = 'Internal'
        WHERE InvoiceID = 40
      `).run(lyMach.MachineID);
    }

    // 3. Update replacement Invoice 41 (INV/2026/09/003-R1) -> Status: Finalized, IsInternal: 1
    const inv41 = db.prepare("SELECT InvoiceID FROM Invoices WHERE InvoiceID = 41").get();
    if (inv41) {
      db.prepare(`
        UPDATE Invoices
        SET Status = 'Finalized',
            CancelledAt = NULL,
            CancelReason = NULL,
            RevisionOf = 40,
            RevisionNo = 1,
            SupersededBy = NULL,
            RevisedAt = NULL,
            RevisedBy = NULL,
            RevisionReason = NULL,
            IsInternal = 1,
            CustomerID = 1,
            MachineID = ?,
            AmountPaid = 0,
            PaymentStatus = 'Internal'
        WHERE InvoiceID = 41
      `).run(lyMach.MachineID);

      // 4. Deduct physical inventory & record stock movements for Invoice 41
      const existingMv = db.prepare("SELECT MovementID FROM StockMovements WHERE InvoiceID = 41").all();
      if (existingMv.length === 0) {
        // Deduct inventory quantities
        db.prepare("UPDATE Inventory SET Qty = Qty - 4.9 WHERE InventoryID = 216").run();
        db.prepare("UPDATE Inventory SET Qty = Qty - 2 WHERE InventoryID = 250").run();
        db.prepare("UPDATE Inventory SET Qty = Qty - 2 WHERE InventoryID = 242").run();

        const q216 = db.prepare("SELECT Qty FROM Inventory WHERE InventoryID = 216").get().Qty;
        const q250 = db.prepare("SELECT Qty FROM Inventory WHERE InventoryID = 250").get().Qty;
        const q242 = db.prepare("SELECT Qty FROM Inventory WHERE InventoryID = 242").get().Qty;

        const insMv = db.prepare(`
          INSERT INTO StockMovements (InventoryID, InvoiceID, MovementType, QtyChange, PreviousQty, NewQty, MovementDate, Notes)
          VALUES (?, 41, 'OUT', ?, ?, ?, '2026-09-21 12:06:09', 'Invoice Finalized INV/2026/09/003-R1')
        `);
        insMv.run(216, -4.9, q216 + 4.9, q216);
        insMv.run(250, -2, q250 + 2, q250);
        insMv.run(242, -2, q242 + 2, q242);
      }

      // 5. Ensure General Ledger Journal Entry for Invoice 41
      const existingJ = db.prepare("SELECT JournalID FROM JournalEntries WHERE SourceType = 'invoice' AND SourceID = '41'").get();
      if (!existingJ) {
        const items = db.prepare(
          "SELECT ItemDescription, Qty, Rate, UnitCostAtBilling FROM InvoiceItems WHERE InvoiceID = 41"
        ).all();
        const cost = Math.round(items.reduce((a, l) => a + (Number(l.Qty) || 0) * (Number(l.UnitCostAtBilling) || 0), 0) * 100) / 100;

        let entryNo = 'JV/2026-09/0009';
        const entryTaken = db.prepare("SELECT JournalID FROM JournalEntries WHERE EntryNo = ?").get(entryNo);
        if (entryTaken) {
          const lastEntry = db.prepare("SELECT EntryNo FROM JournalEntries WHERE Period = '2026-09' ORDER BY JournalID DESC LIMIT 1").get();
          let seq = 1;
          if (lastEntry) {
            const m = /(\d+)$/.exec(lastEntry.EntryNo);
            if (m) seq = Number(m[1]) + 1;
          }
          entryNo = `JV/2026-09/${String(seq).padStart(4, '0')}`;
        }

        const insJ = db.prepare(`
          INSERT INTO JournalEntries (EntryNo, EntryDate, Period, Memo, SourceType, SourceID, PostedAt, PostedBy)
          VALUES (?, '2026-09-08', '2026-09', 'Internal job INV/2026/09/003-R1', 'invoice', '41', '2026-09-21 12:06:09', 'system')
        `).run(entryNo);
        const journalId = insJ.lastInsertRowid;

        const acct6900 = db.prepare("SELECT AccountID FROM Accounts WHERE Code = '6900'").get();
        const acct1300 = db.prepare("SELECT AccountID FROM Accounts WHERE Code = '1300'").get();
        if (acct6900 && acct1300 && cost > 0) {
          db.prepare(`
            INSERT INTO JournalLines (JournalID, AccountID, Debit, Credit, Memo, CustomerID)
            VALUES (?, ?, ?, 0, 'Internal work INV/2026/09/003-R1', 1)
          `).run(journalId, acct6900.AccountID, cost);
          db.prepare(`
            INSERT INTO JournalLines (JournalID, AccountID, Debit, Credit, Memo)
            VALUES (?, ?, 0, ?, 'Parts used on INV/2026/09/003-R1')
          `).run(journalId, acct1300.AccountID, cost);
        }
      }
    }
  },

  down(db) {
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
  },
};
