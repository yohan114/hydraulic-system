'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/appHarness');
const { hashPassword } = require('../lib/auth');

test('HttpOnly Cookie & Multi-Device Session Management', async (t) => {
  const app = await startTestApp({ auth: true });

  try {
    // Provision admin user so Sessions table tracks sessions with real UserID
    const adminHash = await hashPassword('admin123');
    app.db._db.prepare("INSERT OR REPLACE INTO Users (Username, PasswordHash, Role) VALUES ('admin', ?, 'admin')").run(adminHash);

    let token1 = '';
    let cookie1 = '';
    let session1 = '';

    await t.test('1. login sets HttpOnly cookie and returns token', async () => {
      const res = await app.post('/api/auth/login', {
        username: 'admin',
        password: 'admin123',
      });

      assert.equal(res.status, 200);
      assert.ok(res.body.token);
      assert.ok(res.body.sessionId);
      token1 = res.body.token;
      session1 = res.body.sessionId;

      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie, 'must include Set-Cookie header');
      assert.match(setCookie, /billing_token=/);
      assert.match(setCookie, /HttpOnly/i);

      cookie1 = setCookie.split(';')[0];
    });

    await t.test('2. accessing protected API via Cookie billing_token succeeds without Authorization header', async () => {
      const res = await app.get('/api/auth/status', { Cookie: cookie1 });
      assert.equal(res.status, 200);
      assert.equal(res.body.authenticated, true);
      assert.equal(res.body.username, 'admin');
    });

    let token2 = '';
    let session2 = '';
    let cookie2 = '';

    await t.test('3. second device logs in simultaneously and both are tracked in Sessions table', async () => {
      const res = await app.post('/api/auth/login', {
        username: 'admin',
        password: 'admin123',
      }, {
        'user-agent': 'DeviceTwo-Browser/1.0',
      });

      assert.equal(res.status, 200);
      token2 = res.body.token;
      session2 = res.body.sessionId;
      assert.notEqual(session1, session2, 'each device gets unique sessionId');

      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie);
      cookie2 = setCookie.split(';')[0];

      // Device 1 and Device 2 can both access protected endpoints concurrently
      const r1 = await app.get('/api/auth/status', { Authorization: `Bearer ${token1}` });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.authenticated, true);

      const r2 = await app.get('/api/auth/status', { Authorization: `Bearer ${token2}` });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.authenticated, true);
    });

    await t.test('4. GET /api/auth/sessions returns active sessions with isCurrent flag', async () => {
      const res = await app.get('/api/auth/sessions', {
        Authorization: `Bearer ${token2}`,
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length >= 2);

      const s2 = res.body.find((s) => s.sessionId === session2);
      assert.ok(s2, 'session 2 must be listed');
      assert.equal(s2.isCurrent, true, 'session 2 is current for token2');

      const s1 = res.body.find((s) => s.sessionId === session1);
      assert.ok(s1, 'session 1 must be listed');
      assert.equal(s1.isCurrent, false, 'session 1 is not current for token2');
    });

    await t.test('5. POST /api/auth/sessions/revoke-others terminates Device 1 but leaves Device 2 active', async () => {
      const res = await app.post('/api/auth/sessions/revoke-others', {}, {
        Authorization: `Bearer ${token2}`,
      });

      assert.equal(res.status, 200);
      assert.ok(res.body.revokedCount >= 1);

      // Device 1 is now rejected with SESSION_REVOKED
      const r1 = await app.get('/api/invoices', {
        Authorization: `Bearer ${token1}`,
      });
      assert.equal(r1.status, 401);
      assert.equal(r1.body.code, 'SESSION_REVOKED');

      // Device 2 remains fully active
      const r2 = await app.get('/api/invoices', {
        Authorization: `Bearer ${token2}`,
      });
      assert.equal(r2.status, 200);
    });

    await t.test('6. POST /api/auth/logout clears cookie and revokes session', async () => {
      const res = await app.post('/api/auth/logout', {}, {
        Authorization: `Bearer ${token2}`,
        Cookie: cookie2,
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);

      // Verify cookie clear header
      const setCookie = res.headers.get('set-cookie');
      assert.ok(setCookie);
      assert.match(setCookie, /billing_token=;/);

      // Device 2 is now revoked
      const r2 = await app.get('/api/invoices', {
        Authorization: `Bearer ${token2}`,
      });
      assert.equal(r2.status, 401);
      assert.equal(r2.body.code, 'SESSION_REVOKED');
    });
  } finally {
    await app.close();
  }
});
