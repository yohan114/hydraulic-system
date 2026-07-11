'use strict';

// Load the auth module with authentication ON and an isolated secret/DB so the
// role guards evaluate as they would in production (they read these at require
// time). HYDRAULIC_DB points at a throwaway file so requiring ../db never opens
// the real database.
const path = require('path');
const os = require('os');
process.env.BILLING_AUTH = 'on';
process.env.BILLING_SECRET = 'roletest-secret';
process.env.HYDRAULIC_DB = path.join(os.tmpdir(), 'hydraulic-roles-test.db');

const test = require('node:test');
const assert = require('node:assert');
const auth = require('../routes/auth');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
function run(guard, req) {
  let nexted = false;
  const res = mockRes();
  guard(req, res, () => { nexted = true; });
  return { nexted, res };
}

test('requireRole lets a matching role through', () => {
  const { nexted, res } = run(auth.requireRole('admin'), { user: { role: 'admin' }, method: 'POST', path: '/api/x' });
  assert.strictEqual(nexted, true);
  assert.strictEqual(res.statusCode, 200);
});

test('requireRole blocks a non-matching role with 403', () => {
  const { nexted, res } = run(auth.requireRole('admin'), { user: { role: 'cashier' }, method: 'POST', path: '/api/x' });
  assert.strictEqual(nexted, false);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.code, 'FORBIDDEN');
});

test('requireRole accepts any of several roles', () => {
  const guard = auth.requireRole('admin', 'cashier');
  assert.strictEqual(run(guard, { user: { role: 'cashier' }, method: 'POST', path: '/api/x' }).nexted, true);
  assert.strictEqual(run(guard, { user: { role: 'viewer' }, method: 'POST', path: '/api/x' }).nexted, false);
});

test('roleOf normalises unknown/blank roles to admin', () => {
  assert.strictEqual(auth.roleOf({ user: { role: 'cashier' } }), 'cashier');
  assert.strictEqual(auth.roleOf({ user: { role: 'nonsense' } }), 'admin');
  assert.strictEqual(auth.roleOf({ user: {} }), 'admin');
});

test('viewerReadOnlyGuard: GET always passes', () => {
  assert.strictEqual(run(auth.viewerReadOnlyGuard, { user: { role: 'viewer' }, method: 'GET', path: '/api/inventory' }).nexted, true);
});

test('viewerReadOnlyGuard: viewer write is refused, staff write passes', () => {
  const viewer = run(auth.viewerReadOnlyGuard, { user: { role: 'viewer' }, method: 'POST', path: '/api/invoices/draft' });
  assert.strictEqual(viewer.nexted, false);
  assert.strictEqual(viewer.res.statusCode, 403);

  const cashier = run(auth.viewerReadOnlyGuard, { user: { role: 'cashier' }, method: 'POST', path: '/api/invoices/draft' });
  assert.strictEqual(cashier.nexted, true);
});

test('viewerReadOnlyGuard: viewer may still hit auth endpoints (change own password)', () => {
  const { nexted } = run(auth.viewerReadOnlyGuard, { user: { role: 'viewer' }, method: 'POST', path: '/api/auth/change-password' });
  assert.strictEqual(nexted, true);
});
