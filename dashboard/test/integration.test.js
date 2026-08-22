'use strict';

/**
 * First integration coverage of the app itself.
 *
 * Everything else in test/ exercises a pure engine. These drive the real
 * express app — routers, auth gate, role guard, audit middleware, migrations —
 * against a throwaway database, which is where the ERP work will spend its risk.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/appHarness');

let app;

test.before(async () => { app = await startTestApp(); });
test.after(async () => { if (app) await app.close(); });

test('the app boots on a fresh database with the schema migrated', async () => {
  const res = await app.get('/api/inventory');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('migrations ran: SchemaVersion, AuditLog and Company all exist', () => {
  const names = app.db._db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  ['SchemaVersion', 'AuditLog', 'Company', 'Invoices', 'Inventory'].forEach((t) => {
    assert.ok(names.includes(t), `expected table ${t}`);
  });
  // Compare against what is actually on disk, so adding a migration does not
  // break this test — only failing to APPLY one does.
  const { loadMigrations } = require('../lib/migrations');
  const onDisk = loadMigrations().map((m) => m.version);
  const applied = app.db._db.prepare('SELECT Version FROM SchemaVersion ORDER BY Version').all().map((r) => r.Version);
  assert.deepEqual(applied, onDisk, 'every migration on disk should be applied to a fresh database');
});

test('the company master is seeded as exactly one row', () => {
  const rows = app.db._db.prepare('SELECT * FROM Company').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].CompanyID, 1);
  assert.equal(rows[0].Name, 'Edward and Christie');
  assert.equal(rows[0].BaseCurrency, 'LKR');
  // A second company must be impossible.
  assert.throws(() => app.db._db.prepare("INSERT INTO Company (CompanyID, Name) VALUES (2, 'Other')").run());
});

test('the rate card seeded so pricing has something to work with', async () => {
  const res = await app.get('/api/ratecard');
  assert.equal(res.status, 200);
  assert.ok(res.body.length >= 27, `expected the seeded rate card, got ${res.body.length}`);
});

test('a write is recorded in the audit trail; a read is not', async () => {
  const before = app.db._db.prepare('SELECT COUNT(*) c FROM AuditLog').get().c;

  await app.get('/api/inventory');
  assert.equal(app.db._db.prepare('SELECT COUNT(*) c FROM AuditLog').get().c, before,
    'GET requests must not be logged');

  const created = await app.post('/api/inventory', {
    uniqueId: 'TEST-HOSE-1', productName: 'R2 test hose', specificationCode: '13',
    unit: 'm', qty: 10, price: 1560, cost: 355,
  });
  assert.equal(created.status, 200, created.text);

  const row = app.db._db.prepare('SELECT * FROM AuditLog ORDER BY AuditID DESC LIMIT 1').get();
  assert.equal(row.Method, 'POST');
  assert.equal(row.Path, '/api/inventory');
  assert.equal(row.Entity, 'inventory');
  assert.equal(row.Status, 200);
  assert.match(row.After, /TEST-HOSE-1/);
  assert.ok(row.At && row.At.length >= 19);
});

test('the audit trail redacts secrets rather than storing them', async () => {
  const res = await app.post('/api/users', { username: 'tester', password: 'sup3rsecret', role: 'cashier' });
  // Whatever the route decides, the attempt must be logged without the password.
  const row = app.db._db
    .prepare("SELECT * FROM AuditLog WHERE Path = '/api/users' ORDER BY AuditID DESC LIMIT 1").get();
  assert.ok(row, `expected an audit row for the attempt (status ${res.status})`);
  assert.doesNotMatch(row.After || '', /sup3rsecret/, 'the password must never reach the audit table');
  assert.match(row.After || '', /redacted/);
});

test('a rejected write is still audited, with its real status', async () => {
  const res = await app.post('/api/inventory', {});   // no UniqueID / ProductName
  assert.ok(res.status >= 400, `expected a rejection, got ${res.status}`);
  const row = app.db._db.prepare('SELECT * FROM AuditLog ORDER BY AuditID DESC LIMIT 1').get();
  assert.equal(row.Status, res.status);
  assert.equal(row.Method, 'POST');
});

test('an unknown API route 404s instead of falling through to the SPA', async () => {
  const res = await app.get('/api/nope');
  assert.equal(res.status, 404);
});
