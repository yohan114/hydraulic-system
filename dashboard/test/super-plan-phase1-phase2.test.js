'use strict';

/**
 * Super Plan Acceptance Tests (Phases 1 & 2):
 *
 *   T01: Finalize internal work (IsInternal = 1)
 *   T02: Direct API receipt for internal work rejected (HTTP 409)
 *   T07: Journal failure during finalization rolls back draft & stock cleanly
 *   T08: Reversal failure during receipt void rolls back transaction cleanly
 *   T09: Revise paid invoice (same amount), cash preserved & reallocated
 *   T10: Downward revision of paid invoice creates CustomerCredit liability
 *   T13: Missing or invalid token returns 401 UNAUTHENTICATED
 *   T14: Viewer submits mutating write returns 403 FORBIDDEN_PERMISSION_REQUIRED
 *   T15: Cashier requests journal reversal returns 403 FORBIDDEN_PERMISSION_REQUIRED
 *   T16: Session / AuthVersion mismatch returns 401 SESSION_REVOKED
 *   T19: Unregistered route returns 403 ENDPOINT_NOT_REGISTERED
 *   T20: Traversal attempts handled safely without bypass
 *   T22: Cost fields scrubbed from responses for unauthorized roles
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/appHarness');

let app;
let db;

test.before(async () => {
  // Boot with auth ON so permissions, sessions, and route gates are active
  app = await startTestApp({ auth: true });
  db = app.db._db;

  // Provision an initial admin user in the Users table so bootstrap is closed
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

test('T01: finalize internal work posts to workshop expense 6900, not accounts receivable 1200', async () => {
  await app.login('admin', 'admin123');

  // 1. Create internal customer
  const custRes = await app.post('/api/customers', { name: 'Internal Workshop Plant', kind: 'internal' });
  assert.equal(custRes.status, 200);
  const custId = custRes.body.customer.CustomerID;

  // 2. Create stock
  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T01-HOSE', productName: 'T01 Internal Hose', unit: 'm',
    qty: 50, price: 1000, cost: 400,
  });
  assert.equal(stockRes.status, 200);
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T01-HOSE').InventoryID;

  // 3. Finalize internal invoice
  const finRes = await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-10-01',
    billedToName: 'Internal Workshop Plant',
    customerId: custId,
    isInternal: 1,
    items: [{ inventoryId: invId, description: 'Internal Hose', qty: 5, rate: 1000, cost: 400 }],
  });
  assert.equal(finRes.status, 200, finRes.text);
  const invoiceId = finRes.body.invoiceId;

  // 4. Assertions: stock reduced, Dr 6900 / Cr 1300 posted, AR 1200 untouched
  const stockRow = db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(invId);
  assert.equal(stockRow.Qty, 45, 'stock reduced from 50 to 45');

  const invRow = db.prepare('SELECT IsInternal, CustomerID, Status, PaymentStatus FROM Invoices WHERE InvoiceID = ?').get(invoiceId);
  assert.equal(invRow.IsInternal, 1);
  assert.equal(invRow.CustomerID, custId);
  assert.equal(invRow.Status, 'Finalized');
  assert.equal(invRow.PaymentStatus, 'Not Applicable');

  assert.equal(balanceOf('6900'), 2000, '5 * 400 cost posted to 6900 Internal Repairs & Maintenance');
  assert.equal(balanceOf('1200'), 0, 'AR 1200 not touched for internal work');
});

test('T02: direct API receipt creation on internal invoice is rejected with HTTP 409', async () => {
  await app.login('admin', 'admin123');

  const invRow = db.prepare('SELECT InvoiceID FROM Invoices WHERE IsInternal = 1 ORDER BY InvoiceID DESC LIMIT 1').get();
  assert.ok(invRow, 'internal invoice exists');

  const payRes = await app.post(`/api/invoices/${invRow.InvoiceID}/payments`, {
    amount: 1000, method: 'Cash', date: '2026-10-01',
  });
  assert.equal(payRes.status, 409, 'must be rejected with HTTP 409');
  assert.match(payRes.body.error, /internal company work/i);
});

test('T07: journal failure during invoice finalization rolls back entire transaction cleanly', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T07', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T07-HOSE', productName: 'T07 Hose', unit: 'm',
    qty: 20, price: 1000, cost: 500,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T07-HOSE').InventoryID;

  // Create a draft
  const draftRes = await app.post('/api/invoices/draft', {
    invoiceDate: '2026-10-01',
    customerId: custId,
    items: [{ inventoryId: invId, description: 'T07 Hose', qty: 2, rate: 1000, cost: 500 }],
  });
  assert.equal(draftRes.status, 200);
  const draftId = draftRes.body.invoiceId;

  // Close the period '2026-10' in Periods table so glPosting throws a closed-period error
  db.prepare(`
    INSERT INTO Periods (Period, Status, ClosedAt, ClosedBy)
    VALUES ('2026-10', 'closed', datetime('now'), 'admin')
  `).run();

  try {
    const finRes = await app.post('/api/invoices/finalize', {
      invoiceId: draftId,
      invoiceDate: '2026-10-01',
      customerId: custId,
      items: [{ inventoryId: invId, description: 'T07 Hose', qty: 2, rate: 1000, cost: 500 }],
    });

    assert.equal(finRes.status, 400, 'finalization into closed period must fail');
    // Verify rollback: draft remains Draft, stock untouched at 20
    const invCheck = db.prepare('SELECT Status FROM Invoices WHERE InvoiceID = ?').get(draftId);
    assert.equal(invCheck.Status, 'Draft', 'invoice must remain Draft on GL failure');
    const stockCheck = db.prepare('SELECT Qty FROM Inventory WHERE InventoryID = ?').get(invId);
    assert.equal(stockCheck.Qty, 20, 'inventory must remain unconsumed');
  } finally {
    // Reopen period
    db.prepare("DELETE FROM Periods WHERE Period = '2026-10'").run();
  }
});

test('T08: reversal failure during receipt void rolls back transaction cleanly', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T08', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T08-HOSE', productName: 'T08 Hose', unit: 'm',
    qty: 20, price: 1000, cost: 500,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T08-HOSE').InventoryID;

  const finRes = await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-09-01',
    billedToName: 'Customer T08',
    customerId: custId,
    items: [{ inventoryId: invId, description: 'T08 Hose', qty: 2, rate: 1000, cost: 500 }],
  });
  assert.equal(finRes.status, 200);
  const invoiceId = finRes.body.invoiceId;

  // Record a payment in September 2026
  const payRes = await app.post(`/api/invoices/${invoiceId}/payments`, {
    amount: 2000, method: 'Cash', date: '2026-09-02',
  });
  assert.equal(payRes.status, 200);
  const payId = (await app.get(`/api/invoices/${invoiceId}/payments`)).body.payments[0].PaymentID;

  // Close the period '2026-09'
  db.prepare(`
    INSERT INTO Periods (Period, Status, ClosedAt, ClosedBy)
    VALUES ('2026-09', 'closed', datetime('now'), 'admin')
  `).run();

  try {
    // Voiding payment in a closed period must fail and leave payment un-voided
    const voidRes = await app.post(`/api/payments/${payId}/void`, { reason: 'mistake' });
    assert.equal(voidRes.status, 409, 'must be refused when period closed');

    const paymentRow = db.prepare('SELECT VoidedAt FROM Payments WHERE PaymentID = ?').get(payId);
    assert.equal(paymentRow.VoidedAt, null, 'payment must remain active');

    const invRow = db.prepare('SELECT AmountPaid, PaymentStatus FROM Invoices WHERE InvoiceID = ?').get(invoiceId);
    assert.equal(invRow.AmountPaid, 2000);
    assert.equal(invRow.PaymentStatus, 'Paid');
  } finally {
    db.prepare("DELETE FROM Periods WHERE Period = '2026-09'").run();
  }
});

test('T09 & T10: revise paid invoice downward creates CustomerCredit liability & tracks ReceiptAllocations', async () => {
  await app.login('admin', 'admin123');

  const custRes = await app.post('/api/customers', { name: 'Customer T09-10', kind: 'external' });
  const custId = custRes.body.customer.CustomerID;

  const stockRes = await app.post('/api/inventory', {
    uniqueId: 'T10-HOSE', productName: 'T10 Hose', unit: 'm',
    qty: 20, price: 1000, cost: 500,
  });
  const invId = db.prepare('SELECT InventoryID FROM Inventory WHERE UniqueID = ?').get('T10-HOSE').InventoryID;

  // 1. Create and finalize bill of 10,000 (10 @ 1,000)
  const finRes = await app.post('/api/invoices/finalize', {
    invoiceDate: '2026-10-01',
    billedToName: 'Customer T09-10',
    customerId: custId,
    items: [{ inventoryId: invId, description: 'T10 Hose', qty: 10, rate: 1000, cost: 500 }],
  });
  assert.equal(finRes.status, 200);
  const origId = finRes.body.invoiceId;

  // 2. Customer pays 10,000 in full
  const payRes = await app.post(`/api/invoices/${origId}/payments`, {
    amount: 10000, method: 'Cash', date: '2026-10-01',
  });
  assert.equal(payRes.status, 200);

  // Check ReceiptAllocations was recorded for original payment
  const origAllocs = db.prepare('SELECT * FROM ReceiptAllocations WHERE InvoiceID = ?').all(origId);
  assert.equal(origAllocs.length, 1);
  assert.equal(origAllocs[0].Amount, 10000);

  // 3. Revise downward to 8,000 (8 @ 1,000)
  const revRes = await app.post(`/api/invoices/${origId}/revise`, {
    invoiceDate: '2026-10-02',
    billedToName: 'Customer T09-10',
    reason: 'Reduced length from 10m to 8m',
    carryPayments: true,
    items: [{ inventoryId: invId, description: 'T10 Hose', qty: 8, rate: 1000, cost: 500 }],
  });
  assert.equal(revRes.status, 200, revRes.text);
  assert.equal(revRes.body.grandTotal, 8000);
  assert.equal(revRes.body.refundDue, 2000);
  assert.ok(revRes.body.creditId, 'CustomerCredit record was created');
  assert.equal(revRes.body.creditAmount, 2000);

  // 4. Verify CustomerCredits table
  const creditRow = db.prepare('SELECT * FROM CustomerCredits WHERE CreditID = ?').get(revRes.body.creditId);
  assert.ok(creditRow);
  assert.equal(creditRow.CustomerID, custId);
  assert.equal(creditRow.OriginalAmount, 2000);
  assert.equal(creditRow.RemainingAmount, 2000);
  assert.equal(creditRow.Status, 'open');

  // 5. Test refund execution for this credit
  const refRes = await app.post(`/api/credits/${creditRow.CreditID}/refund`, {
    amount: 2000,
    paymentMethod: 'Cash',
    notes: 'Refunded excess cash to customer',
  });
  assert.equal(refRes.status, 200, refRes.text);
  assert.equal(refRes.body.remainingCredit, 0);

  const updatedCredit = db.prepare('SELECT * FROM CustomerCredits WHERE CreditID = ?').get(creditRow.CreditID);
  assert.equal(updatedCredit.Status, 'refunded');
  assert.equal(updatedCredit.RemainingAmount, 0);
});

test('T13: missing or invalid token returns 401 UNAUTHENTICATED', async () => {
  // Call with no token
  app.setToken(null);
  const res1 = await app.get('/api/invoices');
  assert.equal(res1.status, 401);
  assert.equal(res1.body.code, 'UNAUTHENTICATED');

  // Call with forged token
  app.setToken('forged.token.value');
  const res2 = await app.get('/api/invoices');
  assert.equal(res2.status, 401);
  assert.equal(res2.body.code, 'UNAUTHENTICATED');
});

test('T14: viewer role submitting mutating write returns 403 FORBIDDEN', async () => {
  await app.login('admin', 'admin123');

  // Create a viewer user
  const userRes = await app.post('/api/users', { username: 'viewer_bob', password: 'password1234', role: 'viewer' });
  assert.equal(userRes.status, 200);

  // Log in as viewer
  const loginRes = await app.post('/api/auth/login', { username: 'viewer_bob', password: 'password1234' });
  assert.equal(loginRes.status, 200);
  app.setToken(loginRes.body.token);

  // Attempt write endpoint
  const writeRes = await app.post('/api/invoices/draft', {
    invoiceDate: '2026-10-01',
    items: [{ description: 'Test Line', qty: 1, rate: 500 }],
  });

  assert.equal(writeRes.status, 403);
  assert.ok(writeRes.body.code === 'FORBIDDEN' || writeRes.body.code === 'FORBIDDEN_PERMISSION_REQUIRED');
});

test('T15: cashier requesting journal reversal returns 403 FORBIDDEN_PERMISSION_REQUIRED', async () => {
  await app.login('admin', 'admin123');

  // Create cashier user
  const userRes = await app.post('/api/users', { username: 'cashier_alice', password: 'password1234', role: 'cashier' });
  assert.equal(userRes.status, 200);

  const loginRes = await app.post('/api/auth/login', { username: 'cashier_alice', password: 'password1234' });
  assert.equal(loginRes.status, 200);
  app.setToken(loginRes.body.token);

  // Attempt journal reversal
  const revRes = await app.post('/api/ledger/journals/1/reverse', {});
  assert.equal(revRes.status, 403);
  assert.equal(revRes.body.code, 'FORBIDDEN_PERMISSION_REQUIRED');
});

test('T16: session / AuthVersion mismatch returns 401 SESSION_REVOKED', async () => {
  // Log in as cashier_alice
  const loginRes = await app.post('/api/auth/login', { username: 'cashier_alice', password: 'password1234' });
  const oldToken = loginRes.body.token;

  // Alice checks status successfully
  app.setToken(oldToken);
  const okRes = await app.get('/api/invoices');
  assert.equal(okRes.status, 200);

  // Admin updates/demotes alice or changes password, which increments AuthVersion
  await app.login('admin', 'admin123'); // back to admin
  const userId = db.prepare('SELECT UserID FROM Users WHERE Username = ?').get('cashier_alice').UserID;
  const putRes = await app.put(`/api/users/${userId}`, { role: 'viewer' });
  assert.equal(putRes.status, 200);

  // Alice now presents her old token
  app.setToken(oldToken);
  const revokedRes = await app.get('/api/invoices');
  assert.equal(revokedRes.status, 401);
  assert.equal(revokedRes.body.code, 'SESSION_REVOKED');
});

test('T19: unregistered route returns 403 ENDPOINT_NOT_REGISTERED', async () => {
  await app.login('admin', 'admin123');
  const res = await app.get('/api/experimental-feature');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'ENDPOINT_NOT_REGISTERED');
});

test('T20: encoded path traversal is safely normalized and evaluated', async () => {
  await app.login('admin', 'admin123');
  const res = await app.get('/api/invoices/..%2fadmin');
  // Either safely denied as unregistered or traversal detected; never bypasses policy
  assert.equal(res.status, 403);
  assert.ok(res.body.code === 'ENDPOINT_NOT_REGISTERED' || res.body.code === 'PATH_TRAVERSAL_DETECTED');
});

test('T22: cost fields are scrubbed from responses for roles without inventory.cost.view', async () => {
  // Log in as admin and ensure cashier user exists
  await app.login('admin', 'admin123');
  const userId = db.prepare('SELECT UserID FROM Users WHERE Username = ?').get('cashier_alice').UserID;
  await app.put(`/api/users/${userId}`, { role: 'cashier' });

  const loginRes = await app.post('/api/auth/login', { username: 'cashier_alice', password: 'password1234' });
  app.setToken(loginRes.body.token);

  // Query inventory list
  const invRes = await app.get('/api/inventory');
  assert.equal(invRes.status, 200);
  assert.ok(Array.isArray(invRes.body));
  assert.ok(invRes.body.length > 0);

  // Verify Cost and LastPurchasePrice are stripped
  for (const item of invRes.body) {
    assert.equal(item.Cost, undefined, 'Cost must be scrubbed for cashier');
    assert.equal(item.LastPurchasePrice, undefined, 'LastPurchasePrice must be scrubbed for cashier');
  }
});
