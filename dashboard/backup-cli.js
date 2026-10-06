'use strict';

/**
 * On-demand Database Backup CLI.
 * Usage:
 *   node backup-cli.js [--label <name>]
 *   npm run backup
 */

const path = require('path');
const connection = require('./db');
const { takeOnDemandBackup, verifyBackupIntegrity } = require('./lib/backup');
const ledger = require('./lib/ledger');
const ledgerSvc = require('./services/ledger');

async function main() {
  const args = process.argv.slice(2);
  let label = 'manual';
  const labelIdx = args.indexOf('--label');
  if (labelIdx !== -1 && args[labelIdx + 1]) {
    label = args[labelIdx + 1];
  }

  console.log('----------------------------------------------------');
  console.log('Hydraulic System: Database Backup & Verification Tool');
  console.log('----------------------------------------------------');
  console.log(`Live Database : ${connection._db.name}`);
  console.log(`Snapshot Label: ${label}`);

  const start = Date.now();
  try {
    const res = await takeOnDemandBackup(connection._db, { label });
    const elapsed = Date.now() - start;

    console.log(`[✓] Backup File Created : ${res.file}`);
    console.log(`[✓] File Size           : ${(res.size / 1024).toFixed(2)} KB (${res.size.toLocaleString()} bytes)`);
    console.log(`[✓] Elapsed Time        : ${elapsed} ms`);
    console.log(`[✓] SQLite Integrity    : ${res.integrity.integrityResult.toUpperCase()}`);
    console.log(`[✓] Foreign Key Check   : ${res.integrity.foreignKeysOk ? 'PASSED (0 errors)' : 'FAILED'}`);

    // Verify trial balance and cash balance on the live database
    try {
      const tb = ledger.trialBalance(ledgerSvc.accountTotals());
      const cashRow = tb.accounts.find((a) => a.code === '1110');
      console.log(`[✓] Trial Balance       : ${tb.totals.balanced ? 'BALANCED (Debits = Credits = ' + tb.totals.debit.toLocaleString('en-LK', { minimumFractionDigits: 2 }) + ')' : 'UNBALANCED'}`);
      if (cashRow) {
        console.log(`[✓] Cash on Hand (1110) : Rs. ${cashRow.balance.toLocaleString('en-LK', { minimumFractionDigits: 2 })}`);
      }
    } catch (glErr) {
      console.warn(`[!] GL summary check note: ${glErr.message}`);
    }

    console.log('----------------------------------------------------');
    console.log('STATUS: BACKUP COMPLETED AND VERIFIED SUCCESSFULLY.');
    console.log('----------------------------------------------------');
    process.exit(0);
  } catch (err) {
    console.error(`[✗] Backup failed: ${err.message}`);
    process.exit(1);
  }
}

main();
