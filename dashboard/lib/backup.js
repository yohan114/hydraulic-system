'use strict';

/**
 * Daily database backups.
 *
 * On server start we snapshot the live SQLite file to `backups/YYYY-MM-DD.db`
 * (one per calendar day) and keep only the most recent {@link KEEP_DAYS} files.
 * The copy uses better-sqlite3's online backup API so it is consistent even if
 * a write is in flight — a plain file copy of an open database can capture a
 * torn page.
 *
 * The pruning decision is a pure function ({@link filesToPrune}) so it can be
 * unit-tested without touching the filesystem.
 */

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 7;
const BACKUP_RE = /^(\d{4}-\d{2}-\d{2})\.db$/;

/** Local calendar date as `YYYY-MM-DD` (backups are named per local day). */
function todayStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Given the file names in the backup directory, return the ones to delete so
 * that only the newest `keep` dated backups survive. Non-matching names are
 * ignored (never deleted). Pure — no I/O.
 * @param {string[]} names
 * @param {number} [keep=KEEP_DAYS]
 * @returns {string[]} names to remove, oldest first
 */
function filesToPrune(names, keep = KEEP_DAYS) {
  const dated = names.filter((n) => BACKUP_RE.test(n)).sort(); // ISO names sort chronologically
  if (dated.length <= keep) return [];
  return dated.slice(0, dated.length - keep);
}

/**
 * Snapshot the database to backups/<today>.db and prune old files.
 * Never throws — a backup failure must not stop the server from starting; it is
 * logged and swallowed.
 *
 * @param {import('better-sqlite3').Database} db open database handle
 * @param {object} [opts]
 * @param {string} [opts.dir] backup directory (default: <db dir>/backups)
 * @param {Date}   [opts.now]
 * @returns {Promise<{file:string|null, skipped:boolean, pruned:string[]}>}
 */
async function runStartupBackup(db, opts = {}) {
  const result = { file: null, skipped: false, pruned: [] };
  try {
    const dbPath = db.name; // absolute path better-sqlite3 opened
    const dir = opts.dir || path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(dir, { recursive: true });

    const stamp = todayStamp(opts.now);
    const dest = path.join(dir, `${stamp}.db`);

    if (fs.existsSync(dest)) {
      result.skipped = true; // already have today's snapshot
    } else {
      // db.backup() is async and returns a promise; it produces a consistent copy.
      await db.backup(dest);
      result.file = dest;
    }

    for (const name of filesToPrune(fs.readdirSync(dir))) {
      try { fs.unlinkSync(path.join(dir, name)); result.pruned.push(name); } catch (_) {}
    }
  } catch (e) {
    console.warn('Backup skipped:', e.message);
  }
  return result;
}

module.exports = { runStartupBackup, filesToPrune, todayStamp, KEEP_DAYS };
