'use strict';

/**
 * Super Plan Acceptance Tests (Phases 3, 4 & 5):
 *
 *   T03: Change external invoice print layout (DocumentView = 'COMPANY_DETAILED')
 *   T04: Replay finalize command with same key returns cached original response
 *   T05: Replay same key with modified body returns HTTP 409 IDEMPOTENCY_PAYLOAD_MISMATCH
 *   T06: Concurrent stock-consuming finalize: two parallel requests consuming remaining 1 item
 *   T11: Wrong-invoice collection correction: reallocate payment from Invoice A to Invoice B
 *   T12: Closed-period correction: revise invoice from closed month dated into open month
 *   T17: IDOR: Access out-of-scope record returns HTTP 404 NOT_FOUND
 *   T18: Scoped list & aggregate query returns only allowed site records
 *   T21: Protected extra fields in payment payload rejected with HTTP 400 INVALID_PROTECTED_FIELD
 *   T23: Requester approves own refund returns HTTP 403 SELF_APPROVAL_PROHIBITED
 *   T24: Approved transaction content altered returns HTTP 409 HASH_MISMATCH
 *   T25: Approval replay attack: executing already consumed approval returns HTTP 409 APPROVAL_ALREADY_CONSUMED
 *   T26: Mandatory business audit failure rolls back financial transaction completely
 *   T27: Sensitive export requested writes entry to SecurityAuditLog with IP & row count
 *   T28: Formula injection in CSV/Excel export sanitized with leading quote
 *   T29: Internal background job command service validates identical domain invariants
 *   T30: Database backup restoration drill passes integrity check & trial balance balances
 *   T31: GL Trial Balance completeness check detects orphaned invoice missing journal
 *   T32: Technician labour accrual & payout: accrues to 2200, clears without double-costing
 *   T33: Pricing catalogue update leaves historical finalized invoice rates intact
 *   T34: Quotation -> Job -> Invoice conversion preserves IsInternal = 1
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startTestApp } = require('./helpers/appHarness');

let app;
let db;
let reconciliation;
let executeFinalizeInvoice;
let verifyBackupIntegrity;
let backupBeforeMigration;
let sanitizeFormula;
let hashPassword;
let jobsService;
let Database;

test.before(async () => {
  app = await startTestApp({ auth: true });
  db = app.db._db;

  reconciliation = require('../services/reconciliation');
  ({ executeFinalizeInvoice } = require('../services/commands/finalizeInvoice'));
  ({ verifyBackupIntegrity, backupBeforeMigration } = require('../lib/backup'));
  ({ sanitizeFormula } = require('../lib/sanitize'));
  ({ hashPassword } = require('../lib/auth'));
  jobsService = require('../services/jobs');
  Database = require('better-sqlite3');

  // Explicitly seed admin user row with password 'admin123' so subsequent logins remain valid after non-bootstrap users exist
  const adminHash = await hashPassword('admin123');
  db.prepare("INSERT OR REPLACE INTO Users (Username, PasswordHash, Role, AuthVersion) VALUES ('admin', ?, 'admin', 1)").run(adminHash);

  await app.login('admin', 'admin123');
});

test.after(async () => {
  if (app) await app.close();
});

function balanceOf(code) {
  const row = db.prepare(`
    SELECT ROUND(COALESCE(SUM(l.Debit), 0) - COALESCE(SUM(l.Credit), 0), 2) AS v
    FROM JournalLines l JOIN Accounts a ON a.AccountID = l.AccountID WHERE a.Code = ?`).get(code);
  return row ? (row.v || 0) : 0;
}

test('T03: change external invoice print layout (DocumentView = COMPANY_DETAILED) includes internal costs', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T03', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T03-HOSE', productName: 'T03 Hose 1/2', unit: 'm',
    qty: 50, price: 2000, cost: 800,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T03-HOSE').InventoryID;

  const arBefore = balanceOf('1200');
  const salesBefore = balanceOf('4100');
  const cogsBefore = balanceOf('5100');
  const stockBefore = balanceOf('1300');

  const finRes = await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-10-02',
    billedToName: 'Customer T03',
    customerId: custId,
    items: [{ inventoryId: invId, description: 'T03 Hose 1/2', qty: 2, rate: 2000, cost: 800 }],
  });
  assert.equal(finRes.status, 200);
  const invoiceId = finRes.body.invoiceId;

  // Request HTML with COMPANY_DETAILED view
  const htmlRes = await app.get(`/api/invoices/${invoiceId}/html?DocumentView=COMPANY_DETAILED`);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.text, /COMPANY DETAILED COPY/i);
  assert.match(htmlRes.text, /Unit Cost/i);
  assert.match(htmlRes.text, /Total Cost/i);
  assert.match(htmlRes.text, /Gross Margin/i);

  // Revenue & GL remain standard external sale
  assert.equal(balanceOf('1200') - arBefore, 4000, 'Accounts receivable increased by full billed amount 4000');
  assert.equal(balanceOf('4100') - salesBefore, -4000, 'Sales parts credited 4000');
  assert.equal(balanceOf('5100') - cogsBefore, 1600, 'Cost of sales parts debited 1600');
  assert.equal(balanceOf('1300') - stockBefore, -1600, 'Stock inventory credited 1600');
});

test('T04: replay finalize command with same idempotency key returns cached original response', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T04', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T04-HOSE', productName: 'T04 Hose', unit: 'm',
    qty: 20, price: 1500, cost: 600,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T04-HOSE').InventoryID;

  const payload = {
    invoiceDate: '2026-10-02',
    billedToName: 'Customer T04',
    customerId: custId,
    items: [{ inventoryId: invId, description: 'T04 Hose', qty: 2, rate: 1500, cost: 600 }],
  };

  const key = 'IDEMP-T04-KEY-1';
  const res1 = await app.post('/api/invoices/finalize', payload, { 'idempotency-key': key });
  assert.equal(res1.status, 200);
  const firstInvoiceId = res1.body.invoiceId;

  const stockAfterFirst = db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(invId).Qty;
  assert.equal(stockAfterFirst, 18, 'stock reduced from 20 to 18');
  const journalCount1 = db.prepare("SELECT COUNT(*) AS c FROM JournalEntries WHERE SourceType = 'invoice' AND SourceID = ?").get(String(firstInvoiceId)).c;
  assert.equal(journalCount1, 1);

  // Replay identical finalize with same key
  const res2 = await app.post('/api/invoices/finalize', payload, { 'idempotency-key': key });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.invoiceId, firstInvoiceId, 'returns same cached invoice ID');

  const stockAfterSecond = db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(invId).Qty;
  assert.equal(stockAfterSecond, 18, 'zero duplicate stock deduction');
  const journalCount2 = db.prepare("SELECT COUNT(*) AS c FROM JournalEntries WHERE SourceType = 'invoice' AND SourceID = ?").get(String(firstInvoiceId)).c;
  assert.equal(journalCount2, 1, 'zero duplicate journal entry');
});

test('T05: replay same idempotency key with modified body returns HTTP 409 IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T05', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T05-HOSE', productName: 'T05 Hose', unit: 'm',
    qty: 20, price: 1500, cost: 600,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T05-HOSE').InventoryID;

  const key = 'IDEMP-T05-KEY-1';
  const payload1 = {
    invoiceDate: '2026-10-02',
    billedToName: 'Customer T05',
    customerId: custId,
    items: [{ inventoryId: invId, description: 'T05 Hose', qty: 2, rate: 1500, cost: 600 }],
  };
  const res1 = await app.post('/api/invoices/finalize', payload1, { 'idempotency-key': key });
  assert.equal(res1.status, 200);

  // Replay with altered items
  const payload2 = {
    invoiceDate: '2026-10-02',
    billedToName: 'Customer T05',
    customerId: custId,
    items: [{ inventoryId: invId, description: 'T05 Hose Altered', qty: 5, rate: 1500, cost: 600 }],
  };
  const res2 = await app.post('/api/invoices/finalize', payload2, { 'idempotency-key': key });
  assert.equal(res2.status, 409);
  assert.equal(res2.body.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
});

test('T06: concurrent stock-consuming finalize: exactly 1 succeeds, 1 fails with HTTP 409 INSUFFICIENT_STOCK', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T06', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  // Create stock with only 1 item left
  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T06-HOSE-RARE', productName: 'T06 Rare Hose', unit: 'm',
    qty: 1, price: 3000, cost: 1200,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T06-HOSE-RARE').InventoryID;

  const payload = {
    invoiceDate: '2026-10-02',
    billedToName: 'Customer T06',
    customerId: custId,
    items: [{ inventoryId: invId, description: 'T06 Rare Hose', qty: 1, rate: 3000, cost: 1200 }],
  };

  // Launch two concurrent requests attempting to consume the single remaining unit
  const [p1, p2] = await Promise.all([
    app.post('/api/invoices/finalize', payload),
    app.post('/api/invoices/finalize', payload),
  ]);

  const statuses = [p1.status, p2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one must succeed (200) and one must fail (409)');

  const failedRes = p1.status === 409 ? p1 : p2;
  assert.equal(failedRes.body.code, 'INSUFFICIENT_STOCK');

  const stockRemaining = db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(invId).Qty;
  assert.equal(stockRemaining, 0, 'stock must be exactly 0, never negative');
});

test('T11: wrong-invoice collection correction: reallocate payment from Invoice A to Invoice B', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T11', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T11-HOSE', productName: 'T11 Hose', unit: 'm',
    qty: 50, price: 1000, cost: 400,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T11-HOSE').InventoryID;

  // Invoice A: 2000
  const invARes = await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-10-02', billedToName: 'Customer T11', customerId: custId,
    items: [{ inventoryId: invId, description: 'T11 Hose', qty: 2, rate: 1000, cost: 400 }],
  });
  const invAId = invARes.body.invoiceId;

  // Invoice B: 2000
  const invBRes = await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-10-02', billedToName: 'Customer T11', customerId: custId,
    items: [{ inventoryId: invId, description: 'T11 Hose', qty: 2, rate: 1000, cost: 400 }],
  });
  const invBId = invBRes.body.invoiceId;

  // Pay 2000 into Invoice A (wrong invoice)
  const payRes = await app.post(`/api/invoices/${invAId}/payments`, {
    amount: 2000, method: 'Cash', date: '2026-10-02',
  });
  assert.equal(payRes.status, 200);
  const paymentId = payRes.body.paymentId;

  // Verify Invoice A is Paid, B is Unpaid
  let invA = db.prepare('SELECT AmountPaid, PaymentStatus FROM Invoices WHERE InvoiceID = ?').get(invAId);
  let invB = db.prepare('SELECT AmountPaid, PaymentStatus FROM Invoices WHERE InvoiceID = ?').get(invBId);
  assert.equal(invA.PaymentStatus, 'Paid');
  assert.equal(invB.PaymentStatus, 'Unpaid');

  const cashBefore = balanceOf('1110');

  // Reallocate payment to Invoice B
  const reallocRes = await app.post(`/api/payments/${paymentId}/reallocate`, {
    targetInvoiceId: invBId,
    amount: 2000,
    notes: 'Payment originally recorded against wrong invoice',
  });
  assert.equal(reallocRes.status, 200, reallocRes.text);

  // Assertions: Invoice A balance restored, Invoice B credited
  invA = db.prepare('SELECT AmountPaid, PaymentStatus FROM Invoices WHERE InvoiceID = ?').get(invAId);
  invB = db.prepare('SELECT AmountPaid, PaymentStatus FROM Invoices WHERE InvoiceID = ?').get(invBId);
  assert.equal(invA.AmountPaid, 0);
  assert.equal(invA.PaymentStatus, 'Unpaid');
  assert.equal(invB.AmountPaid, 2000);
  assert.equal(invB.PaymentStatus, 'Paid');

  // Zero net change to cash in hand
  const cashAfter = balanceOf('1110');
  assert.equal(cashAfter, cashBefore, 'reallocation produces zero net cash change');
});

test('T12: closed-period correction: revise invoice from closed month dated into open month', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T12', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T12-HOSE', productName: 'T12 Hose', unit: 'm',
    qty: 30, price: 1000, cost: 400,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T12-HOSE').InventoryID;

  // Finalize invoice in July 2026
  const finRes = await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-07-15', billedToName: 'Customer T12', customerId: custId,
    items: [{ inventoryId: invId, description: 'T12 Hose', qty: 2, rate: 1000, cost: 400 }],
  });
  const origId = finRes.body.invoiceId;

  // Close period 2026-07
  db.prepare(`
    INSERT INTO Periods (Period, Status, ClosedAt, ClosedBy)
    VALUES ('2026-07', 'closed', datetime('now'), 'admin')
  `).run();

  try {
    // Attempting to revise into the closed period (defaulting to original date) fails
    const failRev = await app.post(`/api/invoices/${origId}/revise`, {
      reason: 'Rate correction',
      billedToName: 'Customer T12',
      customerId: custId,
      items: [{ inventoryId: invId, description: 'T12 Hose', qty: 2, rate: 1200, cost: 400 }],
    });
    assert.equal(failRev.status, 409);
    assert.match(failRev.body.error, /is closed/i);

    // Revising with invoiceDate in current open month (2026-10-02) succeeds!
    const okRev = await app.post(`/api/invoices/${origId}/revise`, {
      reason: 'Rate correction into open period',
      billedToName: 'Customer T12',
      customerId: custId,
      invoiceDate: '2026-10-02',
      items: [{ inventoryId: invId, description: 'T12 Hose', qty: 2, rate: 1200, cost: 400 }],
    });
    assert.equal(okRev.status, 200, okRev.text);
    assert.equal(okRev.body.grandTotal, 2400);

    // Verify original is Revised and period 2026-07 is still closed
    const origStatus = db.prepare('SELECT Status FROM Invoices WHERE InvoiceID = ?').get(origId).Status;
    assert.equal(origStatus, 'Revised');
    const periodRow = db.prepare("SELECT Status FROM Periods WHERE Period = '2026-07'").get();
    assert.equal(periodRow.Status, 'closed', 'period 2026-07 remains securely closed');
  } finally {
    db.prepare("DELETE FROM Periods WHERE Period = '2026-07'").run();
  }
});

test('T17: IDOR: user accessing invoice of other site returns HTTP 404 NOT_FOUND', async () => {
  await app.login('admin', 'admin123');

  // Create site-scoped user
  const userRes = await app.post('/api/users', { username: 'branch_user', password: 'password1234', role: 'cashier' });
  assert.equal(userRes.status, 200);
  const userId = db.prepare('SELECT UserID FROM Users WHERE Username = ?').get('branch_user').UserID;

  // Assign scope: branch-north only
  db.prepare('INSERT INTO UserScopes (UserID, SiteID) VALUES (?, ?)').run(userId, 'branch-north');

  // Create an invoice belonging to 'main' site
  const custRes = await app.post('/api/customers', { name: 'Customer Main Site', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const finRes = await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-10-02', billedToName: 'Customer Main Site', customerId: custId,
    siteId: 'main',
    items: [{ description: 'Main Service', qty: 1, rate: 500 }],
  });
  const mainInvId = finRes.body.invoiceId;

  // Log in as branch_user
  const loginRes = await app.post('/api/auth/login', { username: 'branch_user', password: 'password1234' });
  assert.equal(loginRes.status, 200);
  app.setToken(loginRes.body.token);

  // Attempt to access main site invoice -> 404 NOT_FOUND (preventing existence disclosure)
  const accessRes = await app.get(`/api/invoices/${mainInvId}`);
  assert.equal(accessRes.status, 404);
  assert.equal(accessRes.body.code, 'NOT_FOUND');
});

test('T18: scoped list & aggregate query returns only allowed site records', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Scoped List Customer', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  // Create invoice at branch-north
  await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-10-02', billedToName: 'Scoped Customer North', customerId: custId,
    siteId: 'branch-north',
    items: [{ description: 'North Part', qty: 1, rate: 700 }],
  });

  // Create invoice at branch-south
  await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-10-02', billedToName: 'Scoped Customer South', customerId: custId,
    siteId: 'branch-south',
    items: [{ description: 'South Part', qty: 1, rate: 900 }],
  });

  // Log in as branch_user (scoped to branch-north)
  const loginRes = await app.post('/api/auth/login', { username: 'branch_user', password: 'password1234' });
  app.setToken(loginRes.body.token);

  const listRes = await app.get('/api/invoices');
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body));
  assert.ok(listRes.body.length > 0);
  for (const inv of listRes.body) {
    assert.equal(inv.SiteID, 'branch-north', `invoice ${inv.InvoiceNo} belongs to ${inv.SiteID}, expected branch-north`);
  }
});

test('T21: protected extra fields in payment payload rejected with HTTP 400 INVALID_PROTECTED_FIELD', async () => {
  await app.login('admin', 'admin123');

  const invRow = db.prepare("SELECT InvoiceID FROM Invoices WHERE Status = 'Finalized' AND IsInternal = 0 LIMIT 1").get();
  assert.ok(invRow, 'finalized invoice exists');

  const payRes = await app.post(`/api/invoices/${invRow.InvoiceID}/payments`, {
    amount: 100,
    method: 'Cash',
    AmountPaid: 999999,
    IsInternal: 1,
  });

  assert.equal(payRes.status, 400);
  assert.equal(payRes.body.code, 'INVALID_PROTECTED_FIELD');
});

test('T23: requester attempting to approve own refund returns HTTP 403 SELF_APPROVAL_PROHIBITED', async () => {
  await app.login('admin', 'admin123');

  // Create user manager_alice with role manager (has both refund.request and refund.approve)
  await app.post('/api/users', { username: 'manager_alice', password: 'password1234', role: 'manager' });

  // Seed a customer credit
  const custRes = await app.post('/api/customers', { name: 'Credit Customer T23', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const insCredit = db.prepare(`
    INSERT INTO CustomerCredits (CustomerID, SourceType, SourceID, OriginalAmount, RemainingAmount, Status, CreatedAt, CreatedBy)
    VALUES (?, 'manual', '1', 5000, 5000, 'open', datetime('now'), 'admin')
  `).run(custId);
  const creditId = insCredit.lastInsertRowid;

  // Log in as manager_alice and request refund
  const loginRes = await app.post('/api/auth/login', { username: 'manager_alice', password: 'password1234' });
  app.setToken(loginRes.body.token);

  const reqRes = await app.post(`/api/credits/${creditId}/refund/request`, {
    amount: 1000, paymentMethod: 'Cash',
  });
  assert.equal(reqRes.status, 200);
  const approvalId = reqRes.body.approvalId;

  // Attempt self-approval as manager_alice
  const appRes = await app.post(`/api/credits/${creditId}/refund/approve`, {
    approvalId, decision: 'approved',
  });
  assert.equal(appRes.status, 403);
  assert.equal(appRes.body.code, 'SELF_APPROVAL_PROHIBITED');
});

test('T24: altered refund payload after approval returns HTTP 409 HASH_MISMATCH', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Credit Customer T24', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const insCredit = db.prepare(`
    INSERT INTO CustomerCredits (CustomerID, SourceType, SourceID, OriginalAmount, RemainingAmount, Status, CreatedAt, CreatedBy)
    VALUES (?, 'manual', '2', 5000, 5000, 'open', datetime('now'), 'admin')
  `).run(custId);
  const creditId = insCredit.lastInsertRowid;

  // manager_alice requests refund for 1000
  const loginRes = await app.post('/api/auth/login', { username: 'manager_alice', password: 'password1234' });
  app.setToken(loginRes.body.token);

  const reqRes = await app.post(`/api/credits/${creditId}/refund/request`, {
    amount: 1000, paymentMethod: 'Cash',
  });
  assert.equal(reqRes.status, 200);
  const approvalId = reqRes.body.approvalId;

  // Distinct user (admin) approves refund for 1000
  await app.login('admin', 'admin123');
  const appRes = await app.post(`/api/credits/${creditId}/refund/approve`, {
    approvalId, decision: 'approved',
  });
  assert.equal(appRes.status, 200, appRes.text);

  // Execute refund but alter amount to 1500 -> HASH_MISMATCH
  const execRes = await app.post(`/api/credits/${creditId}/refund/execute`, {
    approvalId, amount: 1500, paymentMethod: 'Cash',
  });
  assert.equal(execRes.status, 409);
  assert.equal(execRes.body.code, 'HASH_MISMATCH');
});

test('T25: replaying consumed refund approval returns HTTP 409 APPROVAL_ALREADY_CONSUMED', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Credit Customer T25', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const insCredit = db.prepare(`
    INSERT INTO CustomerCredits (CustomerID, SourceType, SourceID, OriginalAmount, RemainingAmount, Status, CreatedAt, CreatedBy)
    VALUES (?, 'manual', '3', 5000, 5000, 'open', datetime('now'), 'admin')
  `).run(custId);
  const creditId = insCredit.lastInsertRowid;

  // manager_alice requests refund for 1000
  const loginRes = await app.post('/api/auth/login', { username: 'manager_alice', password: 'password1234' });
  app.setToken(loginRes.body.token);

  const reqRes = await app.post(`/api/credits/${creditId}/refund/request`, {
    amount: 1000, paymentMethod: 'Cash',
  });
  assert.equal(reqRes.status, 200);
  const approvalId = reqRes.body.approvalId;

  // Distinct user (admin) approves refund
  await app.login('admin', 'admin123');
  const appRes = await app.post(`/api/credits/${creditId}/refund/approve`, {
    approvalId, decision: 'approved',
  });
  assert.equal(appRes.status, 200);

  // First execution succeeds -> status becomes consumed
  const exec1 = await app.post(`/api/credits/${creditId}/refund/execute`, {
    approvalId, amount: 1000, paymentMethod: 'Cash',
  });
  assert.equal(exec1.status, 200, exec1.text);

  // Second execution with same approval ID fails -> APPROVAL_ALREADY_CONSUMED
  const exec2 = await app.post(`/api/credits/${creditId}/refund/execute`, {
    approvalId, amount: 1000, paymentMethod: 'Cash',
  });
  assert.equal(exec2.status, 409);
  assert.equal(exec2.body.code, 'APPROVAL_ALREADY_CONSUMED');
});

test('T26: mandatory business audit failure rolls back financial transaction completely', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Credit Customer T26', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const insCredit = db.prepare(`
    INSERT INTO CustomerCredits (CustomerID, SourceType, SourceID, OriginalAmount, RemainingAmount, Status, CreatedAt, CreatedBy)
    VALUES (?, 'manual', '4', 3000, 3000, 'open', datetime('now'), 'admin')
  `).run(custId);
  const creditId = insCredit.lastInsertRowid;

  // Inject a failure trigger on BusinessAuditLog
  db.prepare(`
    CREATE TRIGGER fail_audit_t26 BEFORE INSERT ON BusinessAuditLog
    BEGIN
      SELECT RAISE(ABORT, 'Injected business audit disk failure');
    END;
  `).run();

  try {
    const refRes = await app.post(`/api/credits/${creditId}/refund`, {
      amount: 1000, paymentMethod: 'Cash',
    });
    assert.equal(refRes.status, 500, 'request must fail when audit fails');

    // Verify atomic rollback: credit remains open with 3000 untouched
    const credit = db.prepare('SELECT RemainingAmount, Status FROM CustomerCredits WHERE CreditID = ?').get(creditId);
    assert.equal(credit.RemainingAmount, 3000);
    assert.equal(credit.Status, 'open');

    // Verify zero refunds created
    const refundCount = db.prepare('SELECT COUNT(*) AS c FROM Refunds WHERE CreditID = ?').get(creditId).c;
    assert.equal(refundCount, 0);
  } finally {
    db.prepare('DROP TRIGGER IF EXISTS fail_audit_t26').run();
  }
});

test('T27: sensitive export requested writes entry to SecurityAuditLog with IP & row count', async () => {
  await app.login('admin', 'admin123');

  const auditCountBefore = db.prepare("SELECT COUNT(*) AS c FROM SecurityAuditLog WHERE Action = 'export_download'").get().c;

  const exportRes = await app.getBuffer('/api/job-profit/excel');
  assert.equal(exportRes.status, 200);

  const auditRow = db.prepare("SELECT * FROM SecurityAuditLog WHERE Action = 'export_download' ORDER BY LogID DESC LIMIT 1").get();
  assert.ok(auditRow);
  assert.equal(auditRow.Resource, '/api/job-profit/excel');
  assert.ok(auditRow.IPAddress !== undefined);
  assert.ok(auditRow.RowCount >= 0);
  assert.ok(db.prepare("SELECT COUNT(*) AS c FROM SecurityAuditLog WHERE Action = 'export_download'").get().c > auditCountBefore);
});

test('T28: formula injection in CSV/Excel export sanitized with leading quote', async () => {
  assert.equal(sanitizeFormula("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
  assert.equal(sanitizeFormula("+sum(1,2)"), "'+sum(1,2)");
  assert.equal(sanitizeFormula("@SUM(A1:A10)"), "'@SUM(A1:A10)");
  assert.equal(sanitizeFormula("-100"), "'-100");
  assert.equal(sanitizeFormula("Normal Text"), "Normal Text");
});

test('T29: internal background job invokes command service directly validating domain invariants', async () => {
  const custRes = await app.post('/api/customers', { name: 'Customer T29', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T29-HOSE', productName: 'T29 Hose', unit: 'm',
    qty: 20, price: 1000, cost: 400,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T29-HOSE').InventoryID;

  // Create a draft invoice
  const draftRes = await app.post('/api/invoices/draft', {
    invoiceDate: '2026-10-02',
    billedToName: 'Customer T29',
    customerId: custId,
    items: [{ inventoryId: invId, description: 'T29 Hose', qty: 2, rate: 1000, cost: 400 }],
  });
  const draftId = draftRes.body.invoiceId;

  // Background worker invokes command service
  const cmdResult = executeFinalizeInvoice(
    { invoiceId: draftId, idempotencyKey: 'BG-CMD-T29-1' },
    { username: 'bg_daemon', role: 'admin' },
    db
  );

  assert.equal(cmdResult.success, true);
  assert.equal(cmdResult.status, 'Finalized');

  // Verify DB state
  const inv = db.prepare('SELECT Status, PaymentStatus FROM Invoices WHERE InvoiceID = ?').get(draftId);
  assert.equal(inv.Status, 'Finalized');
  assert.equal(inv.PaymentStatus, 'Unpaid');

  const stock = db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(invId).Qty;
  assert.equal(stock, 18);

  const audit = db.prepare("SELECT * FROM BusinessAuditLog WHERE Action = 'invoice.finalize' AND EntityID = ?").get(String(draftId));
  assert.ok(audit);
  assert.equal(audit.ActorID, 'bg_daemon');
});

test('T30: database backup restoration drill passes integrity check & trial balance balances', async () => {
  const backupPath = await backupBeforeMigration(db, 'drill-test');
  assert.ok(backupPath);

  const integrity = verifyBackupIntegrity(backupPath);
  assert.equal(integrity.ok, true);
  assert.equal(integrity.integrityResult, 'ok');
  assert.equal(integrity.foreignKeysOk, true);

  // Restore drill: open backup and verify trial balance
  const restoredDb = new Database(backupPath, { readonly: true });
  try {
    const sums = restoredDb.prepare('SELECT ROUND(SUM(Debit), 2) AS d, ROUND(SUM(Credit), 2) AS c FROM JournalLines').get();
    assert.equal(sums.d, sums.c, 'restored database trial balance balances');
  } finally {
    restoredDb.close();
  }
});

test('T31: GL completeness check detects orphaned invoice missing journal entry', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T31', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const finRes = await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-10-02', billedToName: 'Customer T31', customerId: custId,
    items: [{ description: 'Completeness Test Item', qty: 1, rate: 500 }],
  });
  const invId = finRes.body.invoiceId;

  // Initial check: complete
  let comp = reconciliation.checkCompleteness(db);
  assert.equal(comp.isComplete, true);

  // Intentionally delete journal entry for this invoice
  db.prepare("DELETE FROM JournalLines WHERE JournalID IN (SELECT JournalID FROM JournalEntries WHERE SourceType = 'invoice' AND SourceID = ?)").run(String(invId));
  db.prepare("DELETE FROM JournalEntries WHERE SourceType = 'invoice' AND SourceID = ?").run(String(invId));

  // Completeness check detects the orphaned invoice
  comp = reconciliation.checkCompleteness(db);
  assert.equal(comp.isComplete, false);
  const found = comp.orphanedInvoices.some((i) => i.InvoiceID === invId);
  assert.equal(found, true, 'orphaned invoice detected by reconciliation service');

  // Verify completeness API endpoint
  const apiRes = await app.get('/api/reconciliation/completeness');
  assert.equal(apiRes.status, 200);
  assert.equal(apiRes.body.isComplete, false);
});

test('T32: technician labour accrues to account 2200 and clears upon payout without double-costing', async () => {
  await app.login('admin', 'admin123');

  // 1. Create a worker
  const insWorker = db.prepare("INSERT INTO Workers (Name, Role, Active) VALUES ('Sunil Technician', 'mechanic', 1)").run();
  const workerId = insWorker.lastInsertRowid;

  // 2. Create customer and job card
  const custRes = await app.post('/api/customers', { name: 'Labour Customer T32', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const jobRes = await app.post('/api/jobs', {
    jobType: 'hydraulic_repair', customerId: custId, description: 'Cylinder rebuild',
  });
  const jobId = jobRes.body.jobId;

  const accruedBefore = balanceOf('2200');
  const cashBefore = balanceOf('1110');

  // 3. Accrue technician labour: 2 units crimping @ 400 = 800
  const labourRes = await app.post(`/api/jobs/${jobId}/labour`, {
    workerId, workType: 'crimping', units: 2, unitLabel: 'end', rate: 400,
  });
  assert.equal(labourRes.status, 200);
  const labourId = labourRes.body.jobLabourId;

  // Cost recognized in 5200; liability recognized in 2200
  assert.equal(balanceOf('5200'), 800, 'labour cost recognized in 5200');
  assert.equal(balanceOf('2200'), accruedBefore - 800, 'liability owed to worker in 2200');
  assert.equal(balanceOf('1110'), cashBefore, 'cash in hand untouched');

  // 4. Pay technician
  const payRes = await app.post('/api/labour/pay', {
    workerId, jobLabourIds: [labourId], paymentDate: '2026-10-02', method: 'Cash',
  });
  assert.equal(payRes.status, 200);

  // Liability settled; cash paid; cost NOT recognized a second time
  assert.equal(balanceOf('2200'), accruedBefore, 'liability in 2200 is settled');
  assert.equal(balanceOf('1110'), cashBefore - 800, 'cash leaves the till');
  assert.equal(balanceOf('5200'), 800, 'labour cost remains 800, never double-costed');
});

test('T33: pricing catalogue update leaves historical finalized invoice rates intact', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T33', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T33-FITTING', productName: 'T33 Fitting 1/2', unit: 'pcs',
    qty: 10, price: 1200, cost: 500,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T33-FITTING').InventoryID;

  // Finalize invoice at 1200
  const finRes = await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-10-02', billedToName: 'Customer T33', customerId: custId,
    items: [{ inventoryId: invId, description: 'T33 Fitting 1/2', qty: 2, rate: 1200, cost: 500 }],
  });
  const invoiceId = finRes.body.invoiceId;

  // Update catalogue/inventory rate from 1200 to 1500
  db.prepare('UPDATE Inventory SET Price = 1500 WHERE InventoryID = ?').run(invId);

  // Historical invoice retains original 1200 rate and 2400 total
  const invItem = db.prepare('SELECT Rate, Amount FROM InvoiceItems WHERE InvoiceID = ?').get(invoiceId);
  assert.equal(invItem.Rate, 1200, 'historical line rate remains 1200');
  assert.equal(invItem.Amount, 2400);

  const invHeader = db.prepare('SELECT GrandTotal FROM Invoices WHERE InvoiceID = ?').get(invoiceId);
  assert.equal(invHeader.GrandTotal, 2400, 'historical invoice grand total untouched');
});

test('T34: internal job conversion preserves IsInternal = 1 across quotation -> job -> invoice', async () => {
  await app.login('admin', 'admin123');

  // 1. Internal Customer
  const custRes = await app.post('/api/customers', { name: 'Internal Fleet Unit 4', kind: 'internal' });
  const custId = custRes.body.customer.CustomerID;

  // 2. Create Quotation for internal customer
  const quoteRes = await app.post('/api/quotations', {
    customerId: custId,
    quoteDate: '2026-10-02',
    description: 'Internal Boom Hose Replacement',
    items: [{ description: 'Hydraulic Hose 3/4', qty: 2, rate: 2500, unit: 'm' }],
  });
  assert.equal(quoteRes.status, 200, quoteRes.text);
  const quoteId = quoteRes.body.quoteId;

  // 3. Convert Quotation to Job
  const convRes = await app.post(`/api/quotations/${quoteId}/convert`, {});
  assert.equal(convRes.status, 200);
  const jobId = convRes.body.jobId;

  // 4. Retrieve Job invoice payload
  const payloadRes = await app.get(`/api/jobs/${jobId}/invoice-payload`);
  assert.equal(payloadRes.status, 200);
  assert.equal(payloadRes.body.customerId, custId);

  // 5. Finalize invoice using job payload
  const finRes = await app.post('/api/invoices/finalize', {
    ...payloadRes.body,
    invoiceDate: '2026-10-02',
  });
  assert.equal(finRes.status, 200);
  const invoiceId = finRes.body.invoiceId;

  // 6. Assert IsInternal = 1 is preserved and PaymentStatus is 'Not Applicable'
  const invRow = db.prepare('SELECT IsInternal, CustomerID, PaymentStatus FROM Invoices WHERE InvoiceID = ?').get(invoiceId);
  assert.equal(invRow.IsInternal, 1, 'IsInternal = 1 preserved throughout full transition');
  assert.equal(invRow.CustomerID, custId);
  assert.equal(invRow.PaymentStatus, 'Not Applicable');
});
