'use strict';

/**
 * Domain Reconciliation & Completeness Engine.
 *
 * Verifies General Ledger control accounts against domain subledgers:
 *   1. Inventory stock valuation vs GL Account 1300.
 *   2. Accounts Receivable vs unpaid customer invoice balances (GL Account 1200).
 *   3. Accounts Payable vs open supplier bills (GL Account 2100).
 *   4. Completeness check: detects orphaned invoices or payments missing journal entries (T31).
 */

const money = require('../lib/money');

function getAccountBalance(db, code) {
  const row = db.prepare(`
    SELECT a.Type,
           ROUND(COALESCE(SUM(l.Debit), 0), 2) AS totalDebit,
           ROUND(COALESCE(SUM(l.Credit), 0), 2) AS totalCredit
    FROM Accounts a
    LEFT JOIN JournalLines l ON l.AccountID = a.AccountID
    WHERE a.Code = ?
    GROUP BY a.AccountID
  `).get(code);

  if (!row) return 0;
  // Asset (1xxx) & Expense (5xxx, 6xxx) are Debit-positive; Liabilities (2xxx), Equity (3xxx), Revenue (4xxx) are Credit-positive.
  const firstDigit = String(code).charAt(0);
  if (firstDigit === '1' || firstDigit === '5' || firstDigit === '6') {
    return money.round2(row.totalDebit - row.totalCredit);
  } else {
    return money.round2(row.totalCredit - row.totalDebit);
  }
}

/**
 * Reconcile physical inventory valuation against GL 1300.
 */
function reconcileInventory(db) {
  const row = db.prepare(`
    SELECT ROUND(SUM(Qty * Cost), 2) AS stockValuation
    FROM Inventory
    WHERE Qty > 0
  `).get();

  const stockValuation = row && row.stockValuation != null ? money.round2(row.stockValuation) : 0;
  const glBalance = getAccountBalance(db, '1300');
  const difference = money.round2(stockValuation - glBalance);

  return {
    accountCode: '1300',
    accountName: 'Inventory / Stock',
    subledgerValuation: stockValuation,
    glBalance,
    difference,
    isReconciled: Math.abs(difference) < 0.01,
  };
}

/**
 * Reconcile unpaid external customer invoices against GL 1200.
 */
function reconcileAccountsReceivable(db) {
  const row = db.prepare(`
    SELECT ROUND(SUM(GrandTotal - AmountPaid), 2) AS arBalance
    FROM Invoices
    WHERE Status = 'Finalized' AND IsInternal = 0
  `).get();

  const arBalance = row && row.arBalance != null ? money.round2(row.arBalance) : 0;
  const glBalance = getAccountBalance(db, '1200');
  const difference = money.round2(arBalance - glBalance);

  return {
    accountCode: '1200',
    accountName: 'Accounts Receivable',
    subledgerBalance: arBalance,
    glBalance,
    difference,
    isReconciled: Math.abs(difference) < 0.01,
  };
}

/**
 * Reconcile open supplier bills against GL 2100.
 */
function reconcileAccountsPayable(db) {
  let apBalance = 0;
  try {
    const row = db.prepare(`
      SELECT ROUND(SUM(GrandTotal - AmountPaid), 2) AS apBalance
      FROM SupplierBills
      WHERE Status = 'Open'
    `).get();
    if (row && row.apBalance != null) apBalance = money.round2(row.apBalance);
  } catch (_) {
    // SupplierBills table may not exist in some lightweight configs
  }

  const glBalance = getAccountBalance(db, '2100');
  const difference = money.round2(apBalance - glBalance);

  return {
    accountCode: '2100',
    accountName: 'Accounts Payable',
    subledgerBalance: apBalance,
    glBalance,
    difference,
    isReconciled: Math.abs(difference) < 0.01,
  };
}

/**
 * Completeness Check: detect finalized invoices and payments missing GL entries (T31).
 */
function checkCompleteness(db) {
  const orphanedInvoices = db.prepare(`
    SELECT i.InvoiceID, i.InvoiceNo, i.GrandTotal, i.InvoiceDate, i.IsInternal
    FROM Invoices i
    WHERE i.Status = 'Finalized'
      AND NOT EXISTS (
        SELECT 1 FROM JournalEntries je
        WHERE je.SourceType = 'invoice' AND (je.SourceID = CAST(i.InvoiceID AS TEXT) OR je.SourceID = i.InvoiceID)
      )
    ORDER BY i.InvoiceID ASC
  `).all();

  const orphanedPayments = db.prepare(`
    SELECT p.PaymentID, p.InvoiceID, p.Amount, p.PaymentDate, p.Method
    FROM Payments p
    JOIN Invoices i ON i.InvoiceID = p.InvoiceID
    WHERE i.IsInternal = 0
      AND NOT EXISTS (
        SELECT 1 FROM JournalEntries je
        WHERE je.SourceType = 'payment' AND (je.SourceID = CAST(p.PaymentID AS TEXT) OR je.SourceID = p.PaymentID)
      )
    ORDER BY p.PaymentID ASC
  `).all();

  return {
    orphanedInvoices,
    orphanedPayments,
    isComplete: orphanedInvoices.length === 0 && orphanedPayments.length === 0,
  };
}

/**
 * Run full reconciliation across all domains.
 */
function runFullReconciliation(db) {
  const inventory = reconcileInventory(db);
  const ar = reconcileAccountsReceivable(db);
  const ap = reconcileAccountsPayable(db);
  const completeness = checkCompleteness(db);

  const isBalanced = inventory.isReconciled && ar.isReconciled && ap.isReconciled && completeness.isComplete;

  return {
    isBalanced,
    inventory,
    accountsReceivable: ar,
    accountsPayable: ap,
    completeness,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getAccountBalance,
  reconcileInventory,
  reconcileAccountsReceivable,
  reconcileAccountsPayable,
  checkCompleteness,
  runFullReconciliation,
};
