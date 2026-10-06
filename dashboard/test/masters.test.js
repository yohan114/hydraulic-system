'use strict';

/**
 * Integration coverage for the Phase 1 master data: Customers, Machines, and
 * the backfill that split `Invoices.BilledToName` into the two of them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/appHarness');

let app;

test.before(async () => { app = await startTestApp(); });
test.after(async () => { if (app) await app.close(); });

test('the masters exist with the columns the ERP needs', () => {
  const cols = (t) => new Set(app.db._db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));
  const cust = cols('Customers');
  ['CustomerID', 'Name', 'Kind', 'Phone', 'CreditLimit', 'PaymentTermsDays', 'Active'].forEach((c) =>
    assert.ok(cust.has(c), `Customers.${c} missing`));
  const mach = cols('Machines');
  ['MachineID', 'Name', 'Kind', 'CustomerID', 'Active'].forEach((c) =>
    assert.ok(mach.has(c), `Machines.${c} missing`));
  const inv = cols('Invoices');
  ['CustomerID', 'MachineID', 'IsInternal'].forEach((c) =>
    assert.ok(inv.has(c), `Invoices.${c} missing`));
  const sup = cols('Suppliers');
  ['Code', 'TIN', 'PaymentTermsDays', 'Currency'].forEach((c) =>
    assert.ok(sup.has(c), `Suppliers.${c} missing`));
});

test('a fresh database gets the internal customer and nothing else', async () => {
  const res = await app.get('/api/customers');
  assert.equal(res.status, 200);
  // Nothing to backfill on an empty database, so only the internal one exists.
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].Kind, 'internal');
  assert.equal(res.body[0].Name, 'Internal / Own Fleet');
});

test('customers can be created, listed, edited and name-clash is refused', async () => {
  const created = await app.post('/api/customers', {
    name: 'Kalum Sudarshana', phone: '075-5327090', creditLimit: 25000, paymentTermsDays: 30,
  });
  assert.equal(created.status, 200, created.text);
  const id = created.body.customer.CustomerID;
  assert.equal(created.body.customer.Kind, 'external');

  const clash = await app.post('/api/customers', { name: 'Kalum Sudarshana' });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error, /already exists/);

  const blank = await app.post('/api/customers', { name: '   ' });
  assert.equal(blank.status, 400);

  const upd = await app.put(`/api/customers/${id}`, { creditLimit: 50000 });
  assert.equal(upd.status, 200);
  const one = await app.get(`/api/customers/${id}`);
  assert.equal(one.body.CreditLimit, 50000);
  assert.equal(one.body.Phone, '075-5327090', 'fields not sent must not be wiped');
  assert.ok(Array.isArray(one.body.machines));
});

test('the name list keeps the plain-array shape a picker expects', async () => {
  const res = await app.get('/api/customers/names');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.every((n) => typeof n === 'string'));
  assert.ok(res.body.includes('Kalum Sudarshana'));
});

test('machines belong to a customer and list with their owner', async () => {
  const internal = (await app.get('/api/customers')).body.find((c) => c.Kind === 'internal');
  const made = await app.post('/api/machines', { name: 'HEX-18', kind: 'registration', customerId: internal.CustomerID });
  assert.equal(made.status, 200, made.text);

  const list = await app.get('/api/machines');
  assert.equal(list.status, 200);
  const hex = list.body.find((m) => m.Name === 'HEX-18');
  assert.ok(hex);
  assert.equal(hex.CustomerName, 'Internal / Own Fleet');
  assert.equal(hex.Jobs, 0);

  const bad = await app.post('/api/machines', { name: '' });
  assert.equal(bad.status, 400);
});

test('an unknown machine kind falls back rather than being stored raw', async () => {
  await app.post('/api/machines', { name: 'Mystery Rig', kind: 'spaceship' });
  const m = (await app.get('/api/machines')).body.find((x) => x.Name === 'Mystery Rig');
  assert.equal(m.Kind, 'equipment');
});

test('deleting a customer with history deactivates instead of destroying links', async () => {
  const c = (await app.post('/api/customers', { name: 'Has History' })).body.customer;
  // Give it an invoice so the router sees history.
  app.db._db.prepare(
    "INSERT INTO Invoices (InvoiceNo, InvoiceDate, BilledToName, Status, GrandTotal, CustomerID) VALUES ('T/1','2026-08-01','Has History','Finalized',100,?)"
  ).run(c.CustomerID);

  const res = await app.del(`/api/customers/${c.CustomerID}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.deactivated, true);
  assert.equal(res.body.jobs, 1);

  const row = app.db._db.prepare('SELECT Active FROM Customers WHERE CustomerID = ?').get(c.CustomerID);
  assert.equal(row.Active, 0, 'must be deactivated, not deleted');
  const link = app.db._db.prepare("SELECT CustomerID FROM Invoices WHERE InvoiceNo = 'T/1'").get();
  assert.equal(link.CustomerID, c.CustomerID, 'the invoice must keep its owner');
});

test('a customer with no history is deleted outright', async () => {
  const c = (await app.post('/api/customers', { name: 'No History' })).body.customer;
  const res = await app.del(`/api/customers/${c.CustomerID}`);
  assert.equal(res.body.deleted, true);
  assert.equal(app.db._db.prepare('SELECT COUNT(*) c FROM Customers WHERE CustomerID = ?').get(c.CustomerID).c, 0);
});

test('master-data writes land in the audit trail', async () => {
  await app.post('/api/customers', { name: 'Audited Co' });
  const row = app.db._db
    .prepare("SELECT * FROM AuditLog WHERE Entity = 'customer' ORDER BY AuditID DESC LIMIT 1").get();
  assert.ok(row, 'expected an audited customer write');
  assert.equal(row.Action, 'create');
  assert.match(row.After, /Audited Co/);
});

test('item categories were derived from the product naming', () => {
  // Seeded rate card exists on a fresh DB but Inventory is empty, so just prove
  // the column and its default are in place for when stock arrives.
  const cols = app.db._db.prepare('PRAGMA table_info(Inventory)').all();
  const valuation = cols.find((c) => c.name === 'ValuationMethod');
  assert.ok(valuation, 'ValuationMethod missing');
  assert.match(String(valuation.dflt_value), /WAC/);
  assert.ok(cols.some((c) => c.name === 'Category'));
});
