'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { filesToPrune, todayStamp, KEEP_DAYS } = require('../lib/backup');

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
