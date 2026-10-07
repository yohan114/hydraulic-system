'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/appHarness');

let app;
let db;
let labourBillsService;

test.before(async () => {
  app = await startTestApp({ auth: true });
  db = app.db._db;
  labourBillsService = require('../services/labourBills');

  // Seed user accounts for each workflow role
  const { hashPassword } = require('../lib/auth');
  const pwdHash = await hashPassword('password123');

  const users = [
    ['admin', 'admin', 1],
    ['ws_sup', 'workshop_supervisor', 1],
    ['om_user', 'operations_manager', 1],
    ['ho_user', 'ho_accounts', 1],
    ['dgm_user', 'dgm', 1],
    ['chair_user', 'chairman', 1],
    ['ws_acc', 'workshop_accounts', 1],
  ];

  for (const [u, r, v] of users) {
    db.prepare('INSERT OR REPLACE INTO Users (Username, PasswordHash, Role, AuthVersion) VALUES (?, ?, ?, ?)').run(u, pwdHash, r, v);
  }
});

test.after(async () => {
  if (app) await app.close();
});

function createTestInvoiceWithLabour(custName, invDate, crimpAmt, latheAmt) {
  const custRes = db.prepare("INSERT INTO Customers (Name, Kind) VALUES (?, 'external')").run(custName);
  const custId = custRes.lastInsertRowid;

  const invNo = `INV-TEST-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const total = crimpAmt + latheAmt;
  const invRes = db.prepare(`
    INSERT INTO Invoices (InvoiceNo, InvoiceDate, BilledToName, GrandTotal, Status, TechChargePaid, CustomerID)
    VALUES (?, ?, ?, ?, 'Finalized', 0, ?)
  `).run(invNo, invDate, custName, total, custId);
  const invId = invRes.lastInsertRowid;

  if (crimpAmt > 0) {
    db.prepare(`
      INSERT INTO InvoiceItems (InvoiceID, ItemDescription, Qty, Rate, Amount)
      VALUES (?, 'Crimping charge 1/2', 1, ?, ?)
    `).run(invId, crimpAmt, crimpAmt);
  }
  if (latheAmt > 0) {
    db.prepare(`
      INSERT INTO InvoiceItems (InvoiceID, ItemDescription, Qty, Rate, Amount)
      VALUES (?, 'Lathe Charge turning', 1, ?, ?)
    `).run(invId, latheAmt, latheAmt);
  }

  return { invId, invNo, total };
}

test('LB01: Trigger 1 - Total labour >= 15,000 auto-generates Labour Bill', async () => {
  await app.login('admin', 'password123');

  // Create 2 invoices totaling 16,000 (exceeds 15,000 threshold)
  createTestInvoiceWithLabour('Customer LB01-A', '2026-10-01', 8000, 2000);
  createTestInvoiceWithLabour('Customer LB01-B', '2026-10-02', 4000, 2000);

  const trig = await labourBillsService.evaluateTriggers({ actor: 'system' });
  assert.equal(trig.triggered, true, 'Trigger 1 should fire on >= 15000');
  assert.match(trig.billNo, /^LB\/\d{4}\/\d{2}\/\d{3}$/);
  assert.equal(trig.totalAmount, 16000);
  assert.equal(trig.jobCount, 2);

  const details = labourBillsService.getBillDetails(trig.billId);
  assert.equal(details.bill.Status, 'GENERATED');
  assert.equal(details.items.length, 2);
  assert.equal(details.approvals.length, 1);
  assert.equal(details.approvals[0].Action, 'GENERATE');
  assert.equal(details.integrity.valid, true);
});

test('LB02: Multi-stage workflow: Certify -> OM Approve -> HO Approve -> Pay & Close', async () => {
  // Get the bill from LB01
  const billsRes = await app.get('/api/labour-bills');
  assert.equal(billsRes.status, 200);
  const bill = billsRes.body.bills[0];
  const billId = bill.BillID;

  // 1. Workshop Supervisor certifies
  await app.login('ws_sup', 'password123');
  const certRes = await app.post(`/api/labour-bills/${billId}/certify`, { note: 'Workshop verified lines' });
  assert.equal(certRes.status, 200);
  assert.equal(certRes.body.bill.Status, 'CERTIFIED');

  // 2. Segregation of duties: ws_sup cannot approve as OM
  const illegalOmRes = await app.post(`/api/labour-bills/${billId}/approve-om`, { note: 'Attempting self-approval' });
  assert.equal(illegalOmRes.status, 403, 'Workshop supervisor cannot hit OM endpoint');

  // 3. Operations Manager approves
  await app.login('om_user', 'password123');
  const omRes = await app.post(`/api/labour-bills/${billId}/approve-om`, { note: 'Operations approved' });
  assert.equal(omRes.status, 200);
  assert.equal(omRes.body.bill.Status, 'OM_APPROVED');

  // 4. Head Office Accounts approves
  await app.login('ho_user', 'password123');
  const hoRes = await app.post(`/api/labour-bills/${billId}/approve-ho`, { note: 'HO verified against invoice ledgers' });
  assert.equal(hoRes.status, 200);
  assert.equal(hoRes.body.bill.Status, 'HO_APPROVED');

  // 5. DGM & Chairman can view but cannot pay or alter
  await app.login('dgm_user', 'password123');
  const dgmView = await app.get(`/api/labour-bills/${billId}`);
  assert.equal(dgmView.status, 200);
  const dgmWrite = await app.post(`/api/labour-bills/${billId}/pay`, { paymentDate: '2026-10-07', method: 'Cash' });
  assert.equal(dgmWrite.status, 403, 'DGM is strictly read-only');

  await app.login('chair_user', 'password123');
  const chairView = await app.get(`/api/labour-bills/${billId}`);
  assert.equal(chairView.status, 200);
  const chairWrite = await app.post(`/api/labour-bills/${billId}/pay`, { paymentDate: '2026-10-07', method: 'Cash' });
  assert.equal(chairWrite.status, 403, 'Chairman is strictly read-only');

  // 6. Workshop Accounts records payout, settles GL, and closes bill
  await app.login('ws_acc', 'password123');
  const payRes = await app.post(`/api/labour-bills/${billId}/pay`, {
    paymentDate: '2026-10-07',
    method: 'Cash',
    paymentRef: 'VOUCHER-991',
    paidTo: 'Workshop Turning Crew',
    notes: 'Paid in full',
  });
  assert.equal(payRes.status, 200);
  assert.equal(payRes.body.bill.Status, 'CLOSED');
  assert.equal(payRes.body.integrity.valid, true);

  // 7. Verify all invoices in bill are now TechChargePaid = 1
  const items = db.prepare('SELECT InvoiceID FROM LabourBillItems WHERE BillID = ?').all(billId);
  for (const it of items) {
    const inv = db.prepare('SELECT TechChargePaid FROM Invoices WHERE InvoiceID = ?').get(it.InvoiceID);
    assert.equal(inv.TechChargePaid, 1, 'Invoice tech charges marked paid');
  }

  // 8. Verify encrypted archive is decryptable
  const sealedRes = await app.get(`/api/labour-bills/${billId}/sealed`);
  assert.equal(sealedRes.status, 200);
  assert.equal(sealedRes.body.verified, true);
  assert.equal(sealedRes.body.payload.bill.Status, 'CLOSED');
});

test('LB03: Rejection workflow: OM rejects -> RETURNED -> Workshop re-certifies', async () => {
  // Create another bill using force
  createTestInvoiceWithLabour('Customer Reject-Test', '2026-10-03', 3000, 0);
  const trig = await labourBillsService.evaluateTriggers({ actor: 'admin', force: true, reason: 'Reject test bill' });
  const billId = trig.billId;

  // Workshop certifies
  await app.login('ws_sup', 'password123');
  await app.post(`/api/labour-bills/${billId}/certify`, { note: 'Initial certify' });

  // OM rejects with reason
  await app.login('om_user', 'password123');
  const rejWithoutReason = await app.post(`/api/labour-bills/${billId}/reject`, { reason: '' });
  assert.equal(rejWithoutReason.status, 400, 'Rejection requires mandatory reason');

  const rejRes = await app.post(`/api/labour-bills/${billId}/reject`, { reason: 'Incorrect lathe job card attached' });
  assert.equal(rejRes.status, 200);
  assert.equal(rejRes.body.bill.Status, 'RETURNED');

  // Workshop supervisor can re-certify after correction
  await app.login('ws_sup', 'password123');
  const recertRes = await app.post(`/api/labour-bills/${billId}/certify`, { note: 'Corrected job cards verified' });
  assert.equal(recertRes.status, 200);
  assert.equal(recertRes.body.bill.Status, 'CERTIFIED');
});

test('LB04: Integrity check detects database tampering', async () => {
  // Get active bill
  const billsRes = await app.get('/api/labour-bills');
  const billId = billsRes.body.bills[0].BillID;

  // Verification succeeds originally
  const okVer = labourBillsService.verifyBillIntegrity(billId);
  assert.equal(okVer.valid, true);

  // Directly tamper with content hash in database
  db.prepare("UPDATE LabourBills SET ContentHash = 'tampered_hash_123' WHERE BillID = ?").run(billId);
  const badVer = labourBillsService.verifyBillIntegrity(billId);
  assert.equal(badVer.valid, false, 'Tampering must be detected');
  assert.match(badVer.error, /mismatch/i);

  // Restore valid hash
  db.prepare('UPDATE LabourBills SET ContentHash = ? WHERE BillID = ?').run(okVer.lastRecordHash ? okVer.lastRecordHash : '0'.repeat(64), billId);
});

test('LB05: Invoices locked in a labour bill cannot be manually marked paid via job-profit bypass', async () => {
  await app.login('admin', 'password123');
  // Find an invoice that belongs to a labour bill
  const billedItem = db.prepare('SELECT InvoiceNo FROM LabourBillItems LIMIT 1').get();
  assert.ok(billedItem);

  const bypassRes = await app.post('/api/job-profit/mark-paid', {
    invoiceNumbers: [billedItem.InvoiceNo],
    paid: false,
  });
  assert.equal(bypassRes.status, 409, 'Direct bypass should be blocked with HTTP 409');
  assert.match(bypassRes.body.error, /locked under Labour Bill/i);
});

test('LB06: Trigger 2 - Job count >= 10 generates Labour Bill even when amount < 15,000', async () => {
  await app.login('admin', 'password123');

  // Create 10 small jobs with Rs. 250 each (total = 2,500 < 15,000)
  for (let i = 1; i <= 10; i++) {
    createTestInvoiceWithLabour(`Small Job Customer ${i}`, '2026-10-05', 0, 250);
  }

  const trig = await labourBillsService.evaluateTriggers({ actor: 'system' });
  assert.equal(trig.triggered, true, 'Trigger 2 must fire on >= 10 jobs');
  assert.match(trig.triggerReason, /Job Count/i);
  assert.equal(trig.jobCount, 10);
  assert.equal(trig.totalAmount, 2500);
});

test('LB07: Trigger 3 - Aging >= 15 calendar days generates Labour Bill', async () => {
  await app.login('admin', 'password123');

  // Create 1 single job dated 20 days ago (amount = 1,000, jobs = 1)
  const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  createTestInvoiceWithLabour('Old Aging Customer', twentyDaysAgo, 1000, 0);

  const trig = await labourBillsService.evaluateTriggers({ actor: 'system' });
  assert.equal(trig.triggered, true, 'Trigger 3 must fire on >= 15 days');
  assert.match(trig.triggerReason, /Aging/i);
  assert.equal(trig.jobCount, 1);
});

test('LB08: SQLite triggers prevent UPDATE or DELETE on CLOSED bill', async () => {
  // Find a closed bill
  const closed = db.prepare("SELECT BillID FROM LabourBills WHERE Status = 'CLOSED' LIMIT 1").get();
  assert.ok(closed, 'Expected at least one closed bill');

  // Attempt to delete closed bill -> must raise ABORT
  assert.throws(() => {
    db.prepare('DELETE FROM LabourBills WHERE BillID = ?').run(closed.BillID);
  }, /can never be deleted|cannot be deleted/i);

  // Attempt to update closed bill -> must raise ABORT
  assert.throws(() => {
    db.prepare("UPDATE LabourBills SET Status = 'GENERATED' WHERE BillID = ?").run(closed.BillID);
  }, /sealed and cannot be changed/i);

  // Attempt to delete from LabourBillApprovals -> must raise ABORT
  assert.throws(() => {
    db.prepare('DELETE FROM LabourBillApprovals WHERE BillID = ?').run(closed.BillID);
  }, /immutable/i);
});

test('LB09: Settings endpoint updates thresholds and persists correctly', async () => {
  await app.login('admin', 'password123');

  const updateRes = await app.put('/api/labour-bills/settings', {
    minAmount: 20000,
    minJobs: 15,
    maxDays: 30,
    enabled: true,
  });
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.settings.MinAmount, 20000);
  assert.equal(updateRes.body.settings.MinJobs, 15);
  assert.equal(updateRes.body.settings.MaxDays, 30);

  // Restore default settings
  await app.put('/api/labour-bills/settings', {
    minAmount: 15000,
    minJobs: 10,
    maxDays: 15,
    enabled: true,
  });
});
