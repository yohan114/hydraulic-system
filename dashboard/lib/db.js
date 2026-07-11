'use strict';

/**
 * Data layer — SQLite via better-sqlite3.
 *
 * Replaces the old Windows-only node-adodb + MS Access stack. better-sqlite3 is
 * a synchronous, cross-platform, in-process driver, so there is no COM/Access
 * install, no per-query process spawn, and the whole database is a single
 * portable file (`hydraulic.db`).
 *
 * The rest of the app was written against node-adodb's async
 * `connection.query(sql)` / `connection.execute(sql)` interface, so this module
 * exposes the same shape — each returns a Promise — meaning the existing
 * `await connection.query(...)` call sites keep working unchanged. Because the
 * underlying engine is synchronous, those awaits simply resolve immediately,
 * which also removes the read-modify-write races that the mutex used to guard.
 *
 * Access-compatibility: `Now()` is registered as a SQL function that returns the
 * current local datetime as `YYYY-MM-DD HH:MM:SS`, so the ~35 `Now()` call sites
 * and the ISO date literals from lib/sql.js all work without translation.
 */

const path = require('path');
const Database = require('better-sqlite3');

// Absolute path (independent of the process cwd) — the DB lives at the repo root,
// two levels up from dashboard/lib/. Override with HYDRAULIC_DB if needed.
const DB_PATH = process.env.HYDRAULIC_DB || path.join(__dirname, '..', '..', 'hydraulic.db');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
// Rollback journal keeps the database a single file at rest (no persistent
// -wal/-shm sidecars) — matches the "one portable file" backup story.

function pad2(n) { return String(n).padStart(2, '0'); }
db.function('Now', () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
});

// Run one statement. SELECT/PRAGMA return rows; everything else returns the
// better-sqlite3 run info ({ changes, lastInsertRowid }).
function runSql(sql) {
  const stmt = db.prepare(sql);
  return stmt.reader ? stmt.all() : stmt.run();
}

const connection = {
  query: (sql) => new Promise((resolve, reject) => {
    try { resolve(runSql(sql)); } catch (e) { reject(e); }
  }),
  execute: (sql) => new Promise((resolve, reject) => {
    try { resolve(runSql(sql)); } catch (e) { reject(e); }
  }),
  /** Underlying better-sqlite3 handle (for transactions / pragmas if needed). */
  _db: db,
};

module.exports = connection;
