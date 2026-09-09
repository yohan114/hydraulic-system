'use strict';

/**
 * Invoice revisions and payment voids.
 *
 * THE GAP THIS CLOSES
 *
 * A finalized invoice was a dead end. It could not be edited, and it could not
 * even be cancelled once a payment had been recorded against it — the cancel
 * route refuses while AmountPaid > 0, and nothing could void a payment. So a
 * bill with a genuine mistake on it (a charge left off, the wrong customer, the
 * wrong rate) had no lawful way to be corrected.
 *
 * INV/2026/09/003 is the case in point: the crimping charge was left off, the
 * operator tried to cancel it four times, was refused every time, and ended up
 * reversing both journals by hand from the ledger screen. That fixed the books
 * and left the invoice, the payment and the stock all saying something else.
 *
 * THE TREATMENT
 *
 * A posted invoice is never edited. It is SUPERSEDED: the original is reversed
 * out in full and a replacement carrying the corrections is issued in its place.
 *
 *   Original    Status -> 'Revised', SupersededBy -> the replacement.
 *               Its stock comes back, its journal is reversed, its payments are
 *               voided. It stops being a receivable and drops out of every
 *               report, all of which filter Status = 'Finalized'.
 *
 *   Replacement A new invoice row numbered from the original with a revision
 *               suffix — INV/2026/09/003 becomes INV/2026/09/003-R1 — so the
 *               customer holding the old bill can see at a glance that this is
 *               the same job, corrected. RevisionOf points back; RevisionNo says
 *               which revision it is.
 *
 * The suffix deliberately does NOT consume a new sequence number:
 * lib/invoiceNo.js matches `^prefix(\d+)$`, so 'INV/2026/09/003-R1' is invisible
 * to the sequencer and next month's numbering is unaffected.
 *
 * PAYMENTS
 *
 * Money already taken is real. Voiding a payment does not delete it — it stamps
 * VoidedAt and reverses its journal, and AmountPaid is derived from the payments
 * that are still standing. When an invoice is revised the cash normally carries
 * forward onto the replacement, which is why a carried payment records where it
 * came from.
 */

module.exports = {
  name: 'invoice revisions and payment voids',

  up(db) {
    const cols = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));

    // --- Invoices: the revision chain --------------------------------------
    const inv = cols('Invoices');
    // The invoice this one replaces. Null on an original.
    if (!inv.has('RevisionOf')) db.exec('ALTER TABLE Invoices ADD COLUMN RevisionOf INTEGER REFERENCES Invoices(InvoiceID)');
    // 0 = original, 1 = first revision, and so on. Drives the -R{n} suffix.
    if (!inv.has('RevisionNo')) db.exec('ALTER TABLE Invoices ADD COLUMN RevisionNo INTEGER NOT NULL DEFAULT 0');
    // The invoice that replaced this one. Null unless Status = 'Revised'.
    if (!inv.has('SupersededBy')) db.exec('ALTER TABLE Invoices ADD COLUMN SupersededBy INTEGER REFERENCES Invoices(InvoiceID)');
    if (!inv.has('RevisedAt')) db.exec('ALTER TABLE Invoices ADD COLUMN RevisedAt TEXT');
    if (!inv.has('RevisedBy')) db.exec('ALTER TABLE Invoices ADD COLUMN RevisedBy TEXT');
    if (!inv.has('RevisionReason')) db.exec('ALTER TABLE Invoices ADD COLUMN RevisionReason TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_inv_revision_of ON Invoices(RevisionOf)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_inv_superseded_by ON Invoices(SupersededBy)');

    // --- Payments: voiding --------------------------------------------------
    // Payments is created by the baseline in migrate.js, which always runs
    // before the numbered migrations, so the table is here.
    const pay = cols('Payments');
    if (!pay.has('VoidedAt')) db.exec('ALTER TABLE Payments ADD COLUMN VoidedAt TEXT');
    if (!pay.has('VoidedBy')) db.exec('ALTER TABLE Payments ADD COLUMN VoidedBy TEXT');
    if (!pay.has('VoidReason')) db.exec('ALTER TABLE Payments ADD COLUMN VoidReason TEXT');
    // Set when this payment is the carried-forward copy of one voided on a
    // superseded invoice, so the cash can be traced across the revision.
    if (!pay.has('CarriedFromPaymentID')) db.exec('ALTER TABLE Payments ADD COLUMN CarriedFromPaymentID INTEGER REFERENCES Payments(PaymentID)');
  },

  down(db) {
    // SQLite cannot drop a column on the versions this ships against, and the
    // columns are additive and nullable, so leaving them is harmless. The
    // indexes are ours to remove.
    db.exec('DROP INDEX IF EXISTS idx_inv_revision_of');
    db.exec('DROP INDEX IF EXISTS idx_inv_superseded_by');
  },
};
