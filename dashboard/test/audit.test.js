'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, toJson, entityFromPath } = require('../lib/audit');

test('redact blanks anything that looks like a secret, at any depth', () => {
  const out = redact({
    username: 'admin',
    password: 'hunter2',
    nested: { PasswordHash: 'abc', token: 't', keep: 1 },
    list: [{ secret: 's' }, { ok: 2 }],
  });
  assert.equal(out.username, 'admin');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.nested.PasswordHash, '[redacted]');
  assert.equal(out.nested.token, '[redacted]');
  assert.equal(out.nested.keep, 1);
  assert.equal(out.list[0].secret, '[redacted]');
  assert.equal(out.list[1].ok, 2);
});

test('redact leaves primitives and null alone', () => {
  assert.equal(redact(null), null);
  assert.equal(redact(5), 5);
  assert.equal(redact('x'), 'x');
});

test('toJson caps oversized payloads instead of bloating the table', () => {
  const big = { items: Array.from({ length: 2000 }, (_, i) => ({ i, name: 'hydraulic hose' })) };
  const s = toJson(big);
  assert.ok(s.length <= 4001, `expected a capped string, got ${s.length}`);
  assert.ok(s.endsWith('…'));
  assert.equal(toJson(undefined), null);
  assert.equal(toJson(null), null);
});

test('toJson survives a circular payload rather than throwing', () => {
  const a = { name: 'x' };
  a.self = a;
  assert.equal(toJson(a), null);
});

test('entityFromPath reads the entity and numeric id off the route', () => {
  assert.deepEqual(entityFromPath('/api/inventory/12'), { entity: 'inventory', entityId: '12' });
  assert.deepEqual(entityFromPath('/api/inventory'), { entity: 'inventory', entityId: null });
  // A sub-resource is not an id.
  assert.deepEqual(entityFromPath('/api/invoices/finalize'), { entity: 'invoices', entityId: null });
  assert.deepEqual(entityFromPath('/health'), { entity: null, entityId: null });
  assert.deepEqual(entityFromPath(''), { entity: null, entityId: null });
});
