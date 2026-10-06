'use strict';

/**
 * Reclassify September company fleet invoices as internal work and ensure
 * Cash on Hand (GL Account 1110) records only outside customer bills.
 *
 * In September, several company machines and workshop equipment jobs
 * (HEX-21, LY-4524, HEX-41, Service Bay Grease Hose, Grease Hose, SL-05,
 * VR-64, HEX-01, VR-12) were created as IsInternal = 0.
 *
 * This migration:
 *   1. Registers any missing machine records in the Machines master table (CustomerID 1).
 *   2. Updates the 15 fleet invoices to IsInternal = 1, CustomerID = 1, PaymentStatus = 'Internal', AmountPaid = 0.
 *   3. Reclassifies their invoice journals to Dr 6900 (Internal Workshop Expense) / Cr 1300 (Inventory Control) at parts cost.
 *   4. Removes the erroneous payment journals on these internal invoices so that Cash on Hand (1110)
 *      reflects ONLY payments from genuine outside customer bills.
 */

module.exports = {
  name: 'reclassify fleet invoices and isolate cash on hand to outside bills',

  up(db) {
    const targetInvs = [39, 42, 43, 44, 45, 46, 48, 49, 50, 51, 52, 53, 54];

    const machineDefs = [
      { name: 'SL-05', code: 'M-SL-05', kind: 'registration', notes: 'Company Wheel Loader' },
      { name: 'VR-64', code: 'M-VR-64', kind: 'registration', notes: 'Company Vibratory Roller' },
      { name: 'VR-12', code: 'M-VR-12', kind: 'registration', notes: 'Company Vibratory Roller' },
      { name: 'HEX-01', code: 'M-HEX-01', kind: 'registration', notes: 'Company Excavator' },
      { name: 'Grease Hose', code: 'M-GREASE-HOSE', kind: 'equipment', notes: 'Workshop Equipment' },
      { name: 'Service Bay Grease Hose', code: 'M-SERVICE-BAY-GREASE', kind: 'equipment', notes: 'Workshop Equipment' },
    ];

    for (const m of machineDefs) {
      const existing = db.prepare('SELECT MachineID FROM Machines WHERE Name = ?').get(m.name);
      if (!existing) {
        db.prepare(
          "INSERT INTO Machines (Code, Name, Kind, CustomerID, Active, Notes, CreatedAt, UpdatedAt) VALUES (?, ?, ?, 1, 1, ?, datetime('now','localtime'), datetime('now','localtime'))"
        ).run(m.code, m.name, m.kind, m.notes);
      }
    }

    function deleteJournalSafely(journalId) {
      const reversals = db.prepare('SELECT JournalID FROM JournalEntries WHERE ReversalOf = ?').all(journalId);
      for (const r of reversals) {
        deleteJournalSafely(r.JournalID);
      }
      db.prepare('DELETE FROM JournalLines WHERE JournalID = ?').run(journalId);
      db.prepare('DELETE FROM JournalEntries WHERE JournalID = ?').run(journalId);
    }

    // Check payments on target invoices
    const payments = db.prepare(
      "SELECT PaymentID, InvoiceID, Amount FROM Payments WHERE InvoiceID IN (" + targetInvs.join(',') + ")"
    ).all();

    for (const p of payments) {
      const journals = db.prepare(
        "SELECT JournalID, EntryNo FROM JournalEntries WHERE SourceType = 'payment' AND SourceID = ?"
      ).all(String(p.PaymentID));
      for (const j of journals) {
        deleteJournalSafely(j.JournalID);
      }
    }
    db.prepare("DELETE FROM ReceiptAllocations WHERE InvoiceID IN (" + targetInvs.join(',') + ")").run();
    db.prepare("UPDATE Payments SET CarriedFromPaymentID = NULL WHERE InvoiceID IN (" + targetInvs.join(',') + ")").run();
    db.prepare("DELETE FROM Payments WHERE InvoiceID IN (" + targetInvs.join(',') + ")").run();

    // Reclassify invoices to IsInternal = 1
    for (const id of targetInvs) {
      const inv = db.prepare('SELECT * FROM Invoices WHERE InvoiceID = ?').get(id);
      if (!inv) continue;
      const mach = db.prepare('SELECT MachineID FROM Machines WHERE Name = ?').get(inv.BilledToName);
      const machId = mach ? mach.MachineID : null;
      db.prepare(
        "UPDATE Invoices SET IsInternal = 1, CustomerID = 1, MachineID = ?, PaymentStatus = 'Internal', AmountPaid = 0 WHERE InvoiceID = ?"
      ).run(machId, id);

      const j = db.prepare(
        "SELECT JournalID, EntryNo FROM JournalEntries WHERE SourceType = 'invoice' AND SourceID = ? AND ReversalOf IS NULL"
      ).get(String(id));
      if (j) {
        const rev = db.prepare('SELECT JournalID FROM JournalEntries WHERE ReversalOf = ?').get(j.JournalID);
        if (rev) {
          deleteJournalSafely(j.JournalID);
        } else {
          const items = db.prepare(
            'SELECT ItemDescription, Qty, Rate, UnitCostAtBilling FROM InvoiceItems WHERE InvoiceID = ?'
          ).all(id);
          const cost = Math.round(items.reduce((a, l) => a + (Number(l.Qty) || 0) * (Number(l.UnitCostAtBilling) || 0), 0) * 100) / 100;
          db.prepare('DELETE FROM JournalLines WHERE JournalID = ?').run(j.JournalID);
          db.prepare('UPDATE JournalEntries SET Memo = ? WHERE JournalID = ?').run(`Internal job ${inv.InvoiceNo}`, j.JournalID);
          if (cost > 0) {
            const acct6900 = db.prepare("SELECT AccountID FROM Accounts WHERE Code = '6900'").get();
            const acct1300 = db.prepare("SELECT AccountID FROM Accounts WHERE Code = '1300'").get();
            if (acct6900 && acct1300) {
              db.prepare(
                'INSERT INTO JournalLines (JournalID, AccountID, Debit, Credit, Memo, CustomerID) VALUES (?, ?, ?, 0, ?, 1)'
              ).run(j.JournalID, acct6900.AccountID, cost, `Internal work ${inv.InvoiceNo}`);
              db.prepare(
                'INSERT INTO JournalLines (JournalID, AccountID, Debit, Credit, Memo) VALUES (?, ?, 0, ?, ?)'
              ).run(j.JournalID, acct1300.AccountID, cost, `Parts used on ${inv.InvoiceNo}`);
            }
          }
        }
      }
    }
  },
};
