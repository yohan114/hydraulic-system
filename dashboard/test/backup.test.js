'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { filesToPrune, todayStamp, KEEP_DAYS, takeOnDemandBackup, verifyBackupIntegrity, startDailyBackupScheduler } = require('../lib/backup');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');

test('filesToPrune keeps the newest N and drops the rest, oldest first', () => {
  const names = [
    '2026-07-01.db', '2026-07-02.db', '2026-07-03.db', '2026-07-04.db',
    '2026-07-05.db', '2026-07-06.db', '2026-07-07.db', '2026-07-08.db', '2026-07-09.db',
  ];
  const prune = filesToPrune(names, 7);
  assert.deepStrictEqual(prune, ['2026-07-01.db', '2026-07-02.db']);
});

test('filesToPrune returns nothing when at or under the limit', () => {
  assert.deepStrictEqual(filesToPrune(['2026-07-01.db', '2026-07-02.db'], 7), []);
  const seven = Array.from({ length: 7 }, (_, i) => `2026-07-0${i + 1}.db`);
  assert.deepStrictEqual(filesToPrune(seven, 7), []);
});

test('filesToPrune ignores non-backup file names', () => {
  const names = ['notes.txt', 'hydraulic.db', '2026-07-01.db', '2026-07-02.db', '.keep'];
  // only 2 dated backups -> nothing pruned, and the stray files are never touched
  assert.deepStrictEqual(filesToPrune(names, 1), ['2026-07-01.db']);
});

test('filesToPrune is order-independent (sorts chronologically by ISO name)', () => {
  const names = ['2026-07-09.db', '2026-07-01.db', '2026-07-05.db'];
  assert.deepStrictEqual(filesToPrune(names, 1), ['2026-07-01.db', '2026-07-05.db']);
});

test('todayStamp formats local date as YYYY-MM-DD', () => {
  assert.strictEqual(todayStamp(new Date(2026, 0, 5)), '2026-01-05');
  assert.strictEqual(todayStamp(new Date(2026, 11, 31)), '2026-12-31');
});

test('KEEP_DAYS is 7', () => {
  assert.strictEqual(KEEP_DAYS, 7);
});

test('takeOnDemandBackup creates an intact verified backup', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  const dbFile = path.join(tmpDir, 'test.db');
  const db = new Database(dbFile);
  try {
    db.exec("CREATE TABLE Test (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO Test VALUES (1, 'alpha');");
    const res = await takeOnDemandBackup(db, { dir: path.join(tmpDir, 'backups'), label: 'unit-test' });
    assert.ok(fs.existsSync(res.file));
    assert.strictEqual(res.integrity.ok, true);
    assert.strictEqual(res.integrity.foreignKeysOk, true);
    assert.strictEqual(res.integrity.integrityResult, 'ok');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('startDailyBackupScheduler returns an active timer that can be stopped', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-sched-'));
  const dbFile = path.join(tmpDir, 'test.db');
  const db = new Database(dbFile);
  try {
    const timer = startDailyBackupScheduler(db, { intervalMs: 100000 });
    assert.ok(timer);
    clearInterval(timer);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
