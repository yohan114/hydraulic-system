'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { loadMigrations, status, applyPending, rollback } = require('../lib/migrations');

// A scratch database plus a scratch migrations directory, so these tests never
// depend on (or are broken by) the real migrations shipped in migrations/.
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-test-'));
  const migDir = path.join(dir, 'migrations');
  fs.mkdirSync(migDir);
  const db = new Database(path.join(dir, 'test.db'));
  return {
    db,
    migDir,
    write(file, body) { fs.writeFileSync(path.join(migDir, file), body); },
    edit(file, body) {
      const p = path.join(migDir, file);
      delete require.cache[require.resolve(p)];
      fs.writeFileSync(p, body);
    },
    cleanup() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const TABLE = (n) => `module.exports = { name: '${n}', up(db){ db.exec('CREATE TABLE ${n} (id INTEGER)'); }, down(db){ db.exec('DROP TABLE ${n}'); } };`;

test('applyPending runs migrations in version order and records them', async () => {
  const s = scratch();
  try {
    s.write('0002-second.js', TABLE('second'));
    s.write('0001-first.js', TABLE('first'));

    const res = await applyPending(s.db, { dir: s.migDir, backup: false });
    assert.deepEqual(res.applied, ['0001 first', '0002 second']);

    const rows = s.db.prepare('SELECT Version FROM SchemaVersion ORDER BY Version').all();
    assert.deepEqual(rows.map((r) => r.Version), ['0001', '0002']);
    // Both tables really exist.
    assert.equal(s.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('first','second')").get().c, 2);
  } finally { s.cleanup(); }
});

test('applyPending is idempotent — a second run applies nothing', async () => {
  const s = scratch();
  try {
    s.write('0001-first.js', TABLE('first'));
    await applyPending(s.db, { dir: s.migDir, backup: false });
    const again = await applyPending(s.db, { dir: s.migDir, backup: false });
    assert.deepEqual(again.applied, []);
    assert.deepEqual(again.skipped, ['0001 first']);
  } finally { s.cleanup(); }
});

test('a failing migration rolls back and leaves the schema untouched', async () => {
  const s = scratch();
  try {
    s.write('0001-first.js', TABLE('first'));
    s.write('0002-bad.js', `module.exports = { name: 'bad', up(db){ db.exec('CREATE TABLE ok (id INTEGER)'); throw new Error('boom'); } };`);

    await assert.rejects(
      () => applyPending(s.db, { dir: s.migDir, backup: false }),
      /Migration 0002 \(bad\) failed and was rolled back: boom/
    );
    // 0001 stands; 0002's partial table was rolled back and it is not recorded.
    const names = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(names.includes('first'));
    assert.ok(!names.includes('ok'), 'partial work from the failed migration must not survive');
    assert.equal(s.db.prepare('SELECT COUNT(*) c FROM SchemaVersion').get().c, 1);
  } finally { s.cleanup(); }
});

test('dry run reports what would happen and changes nothing', async () => {
  const s = scratch();
  try {
    s.write('0001-first.js', TABLE('first'));
    const lines = [];
    const res = await applyPending(s.db, { dir: s.migDir, backup: false, dryRun: true, log: (m) => lines.push(m) });
    assert.deepEqual(res.applied, []);
    assert.deepEqual(lines, ['would apply 0001 first']);
    assert.equal(s.db.prepare('SELECT COUNT(*) c FROM SchemaVersion').get().c, 0);
    assert.equal(s.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='first'").get().c, 0);
  } finally { s.cleanup(); }
});

test('editing an already-applied migration is reported as drift', async () => {
  const s = scratch();
  try {
    s.write('0001-first.js', TABLE('first'));
    await applyPending(s.db, { dir: s.migDir, backup: false });

    s.edit('0001-first.js', TABLE('first') + '\n// changed after the fact');
    const lines = [];
    const res = await applyPending(s.db, { dir: s.migDir, backup: false, log: (m) => lines.push(m) });

    assert.equal(res.drifted.length, 1);
    assert.equal(res.drifted[0].version, '0001');
    assert.ok(lines.some((l) => /changed after it was applied/.test(l)));
  } finally { s.cleanup(); }
});

test('rollback undoes one migration and forgets its version', async () => {
  const s = scratch();
  try {
    s.write('0001-first.js', TABLE('first'));
    await applyPending(s.db, { dir: s.migDir, backup: false });
    rollback(s.db, '0001', s.migDir);

    assert.equal(s.db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='first'").get().c, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) c FROM SchemaVersion').get().c, 0);
  } finally { s.cleanup(); }
});

test('rollback refuses an unknown or irreversible migration', async () => {
  const s = scratch();
  try {
    s.write('0001-oneway.js', `module.exports = { name: 'oneway', up(db){ db.exec('CREATE TABLE oneway (id INTEGER)'); } };`);
    await applyPending(s.db, { dir: s.migDir, backup: false });
    assert.throws(() => rollback(s.db, '0009', s.migDir), /No migration 0009/);
    assert.throws(() => rollback(s.db, '0001', s.migDir), /not reversible/);
  } finally { s.cleanup(); }
});

test('only correctly named files are treated as migrations', () => {
  const s = scratch();
  try {
    s.write('0001-first.js', TABLE('first'));
    s.write('notes.md', 'ignore me');
    s.write('draft.js', 'module.exports = {};');
    const found = loadMigrations(s.migDir);
    assert.deepEqual(found.map((m) => m.version), ['0001']);
  } finally { s.cleanup(); }
});

test('the real migrations directory is well-formed and ordered', () => {
  const real = loadMigrations();
  assert.ok(real.length >= 2, 'expected the ERP migrations to be present');
  const versions = real.map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort(), 'migrations must be in version order');
  assert.equal(new Set(versions).size, versions.length, 'duplicate migration version');
  real.forEach((m) => {
    assert.equal(typeof m.up, 'function', `${m.version} needs up()`);
    assert.ok(m.name && m.name.length, `${m.version} needs a name`);
  });
});

test('status separates pending from applied', async () => {
  const s = scratch();
  try {
    s.write('0001-first.js', TABLE('first'));
    s.write('0002-second.js', TABLE('second'));
    await applyPending(s.db, { dir: s.migDir, backup: false });
    s.write('0003-third.js', TABLE('third'));

    const st = status(s.db, s.migDir);
    assert.deepEqual(st.applied.map((m) => m.version), ['0001', '0002']);
    assert.deepEqual(st.pending.map((m) => m.version), ['0003']);
    assert.deepEqual(st.drifted, []);
  } finally { s.cleanup(); }
});
