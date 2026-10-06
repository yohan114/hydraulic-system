'use strict';

/**
 * Versioned schema migrations.
 *
 * `migrate.js` holds the BASELINE — the tables and columns the system had before
 * the ERP work started — and stays idempotent. Everything from here on is a
 * numbered migration in `migrations/NNNN-name.js`, applied once, in order, and
 * recorded in `SchemaVersion`.
 *
 * Rules that make a live in-place migration safe to run on a shop's only copy of
 * its books:
 *
 *  - A safety copy of the database is taken BEFORE any pending migration runs.
 *    If the copy cannot be written, nothing is applied.
 *  - Each migration runs inside a transaction, so a failure leaves the schema
 *    exactly as it was rather than half-applied.
 *  - Applied migrations are checksummed. Editing a migration that has already
 *    run is a mistake (the two databases would diverge silently), so it is
 *    reported rather than ignored.
 *  - Migrations never DROP or rename in place. Add a column, backfill it, switch
 *    reads over, retire the old one in a later release.
 *
 * A migration module looks like:
 *
 *   module.exports = {
 *     name: 'audit log',
 *     up(db)   { db.exec('CREATE TABLE ...'); },
 *     down(db) { db.exec('DROP TABLE ...'); },   // optional
 *   };
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FILE_RE = /^(\d{4})-([A-Za-z0-9-]+)\.js$/;

/** Create the bookkeeping table. Safe to call repeatedly. */
function ensureVersionTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS SchemaVersion (
    Version   TEXT PRIMARY KEY,
    Name      TEXT NOT NULL,
    Checksum  TEXT NOT NULL,
    AppliedAt TEXT NOT NULL
  )`);
}

/**
 * Every migration on disk, in version order.
 * @param {string} [dir]
 * @returns {Array<{version:string, slug:string, file:string, name:string, checksum:string, up:Function, down:(Function|undefined)}>}
 */
function loadMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((f) => ({ f, m: FILE_RE.exec(f) }))
    .filter((x) => x.m)
    .sort((a, b) => a.m[1].localeCompare(b.m[1]))
    .map(({ f, m }) => {
      const file = path.join(dir, f);
      const mod = require(file);
      if (typeof mod.up !== 'function') throw new Error(`Migration ${f} has no up()`);
      return {
        version: m[1],
        slug: m[2],
        file,
        name: mod.name || m[2].replace(/-/g, ' '),
        checksum: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16),
        up: mod.up,
        down: mod.down,
      };
    });
}

/** Versions already recorded as applied, as a Map version -> row. */
function appliedMap(db) {
  ensureVersionTable(db);
  const rows = db.prepare('SELECT Version, Name, Checksum, AppliedAt FROM SchemaVersion').all();
  return new Map(rows.map((r) => [r.Version, r]));
}

/**
 * What would run, and whether anything already applied has since been edited.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [dir]
 * @returns {{pending:Array, applied:Array, drifted:Array}}
 */
function status(db, dir) {
  const all = loadMigrations(dir);
  const done = appliedMap(db);
  const pending = [];
  const applied = [];
  const drifted = [];
  for (const m of all) {
    const row = done.get(m.version);
    if (!row) { pending.push(m); continue; }
    applied.push(m);
    if (row.Checksum !== m.checksum) drifted.push({ version: m.version, name: m.name, was: row.Checksum, now: m.checksum });
  }
  return { pending, applied, drifted };
}

/**
 * Apply every pending migration, in order, each in its own transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] report what would run, change nothing
 * @param {boolean} [opts.backup=true] take a safety copy before the first one
 * @param {Function} [opts.log] progress sink (default: console.log)
 * @param {string} [opts.dir]
 * @returns {Promise<{applied:string[], skipped:string[], drifted:Array, backupFile:(string|null)}>}
 */
async function applyPending(db, opts = {}) {
  const log = opts.log || (() => {});
  const { pending, applied: already, drifted } = status(db, opts.dir);
  const result = { applied: [], skipped: already.map((m) => `${m.version} ${m.name}`), drifted, backupFile: null };

  if (drifted.length) {
    // Not fatal — the schema is whatever it is — but it means a migration file
    // was edited after running, so two databases can no longer be assumed equal.
    drifted.forEach((d) => log(`WARNING: migration ${d.version} (${d.name}) changed after it was applied`));
  }
  if (!pending.length) return result;

  if (opts.dryRun) {
    pending.forEach((m) => log(`would apply ${m.version} ${m.name}`));
    return result;
  }

  if (opts.backup !== false) {
    // Deliberately not caught: no safety copy, no migration.
    const { backupBeforeMigration } = require('./backup');
    result.backupFile = await backupBeforeMigration(db, pending[0].version);
    log(`Safety copy: ${result.backupFile}`);
  }

  const insert = db.prepare(
    'INSERT INTO SchemaVersion (Version, Name, Checksum, AppliedAt) VALUES (?, ?, ?, ?)'
  );
  for (const m of pending) {
    const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const run = db.transaction(() => {
      m.up(db);
      insert.run(m.version, m.name, m.checksum, at);
    });
    try {
      run();
      result.applied.push(`${m.version} ${m.name}`);
      log(`applied ${m.version} ${m.name}`);
    } catch (e) {
      throw new Error(`Migration ${m.version} (${m.name}) failed and was rolled back: ${e.message}`);
    }
  }
  return result;
}

/**
 * Undo a single applied migration. Only for development — reversing a migration
 * on a live database is a restore-from-backup job, not a code path.
 * @param {import('better-sqlite3').Database} db
 * @param {string} version
 * @param {string} [dir]
 */
function rollback(db, version, dir) {
  const m = loadMigrations(dir).find((x) => x.version === version);
  if (!m) throw new Error(`No migration ${version}`);
  if (typeof m.down !== 'function') throw new Error(`Migration ${version} (${m.name}) is not reversible`);
  ensureVersionTable(db);
  db.transaction(() => {
    m.down(db);
    db.prepare('DELETE FROM SchemaVersion WHERE Version = ?').run(version);
  })();
}

module.exports = { loadMigrations, ensureVersionTable, status, applyPending, rollback, MIGRATIONS_DIR };
