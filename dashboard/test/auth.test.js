'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, createToken, verifyToken } = require('../lib/auth');

test('password hashing round-trips and rejects wrong passwords', () => {
  const stored = hashPassword('s3cret-pw');
  assert.match(stored, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword('s3cret-pw', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('each hash uses a fresh salt', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('verifyPassword tolerates malformed stored values', () => {
  assert.equal(verifyPassword('x', 'garbage'), false);
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', null), false);
  assert.equal(verifyPassword('x', 'scrypt$only-two'), false);
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
