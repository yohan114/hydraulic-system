'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, createToken, verifyToken } = require('../lib/auth');

test('password hashing round-trips and rejects wrong passwords', async () => {
  const stored = await hashPassword('s3cret-pw');
  assert.match(stored, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(await verifyPassword('s3cret-pw', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('each hash uses a fresh salt', async () => {
  assert.notEqual(await hashPassword('same'), await hashPassword('same'));
});

test('verifyPassword tolerates malformed stored values', async () => {
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', 'scrypt$only-two'), false);
});

test('token round-trips with claims', () => {
  const secret = 'server-secret';
  const now = 1_700_000_000_000;
  const token = createToken({ sub: 'admin' }, secret, 3600, now);
  const claims = verifyToken(token, secret, now);
  assert.ok(claims);
  assert.equal(claims.sub, 'admin');
  assert.equal(claims.exp, Math.floor(now / 1000) + 3600);
});

test('token fails on expiry', () => {
  const secret = 'server-secret';
  const now = 1_700_000_000_000;
  const token = createToken({ sub: 'admin' }, secret, 60, now);
  assert.equal(verifyToken(token, secret, now + 61_000), null);
  assert.ok(verifyToken(token, secret, now + 59_000));
});

test('token fails on tamper or wrong secret', () => {
  const now = 1_700_000_000_000;
  const token = createToken({ sub: 'admin' }, 'secret-a', 3600, now);
  assert.equal(verifyToken(token, 'secret-b', now), null);

  const [body] = token.split('.');
  assert.equal(verifyToken(`${body}.deadbeef`, 'secret-a', now), null);
  assert.equal(verifyToken('not-a-token', 'secret-a', now), null);
  assert.equal(verifyToken('', 'secret-a', now), null);
});

test('checkCredentials fails closed on database error instead of falling back to default admin', async () => {
  const connection = require('../db');
  const authRoutes = require('../routes/auth');
  const originalQuery = connection.query;

  try {
    // Simulate a transient database error (e.g. disk corruption, locked, busy)
    connection.query = async () => {
      throw new Error('database disk image is malformed (injected failure)');
    };

    const state = await authRoutes.provisioningState();
    assert.equal(state.provisioned, false);
    assert.equal(state.tableMissing, false);
    assert.match(state.error, /malformed/);

    const creds = await authRoutes.checkCredentials('admin', 'admin123');
    assert.equal(creds.ok, false, 'must fail closed — never accept default admin during DB errors');
    assert.ok(creds.dbError, 'reports database error instead of allowing login');
  } finally {
    connection.query = originalQuery;
  }
});

