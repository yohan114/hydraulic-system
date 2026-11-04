'use strict';

/**
 * Emergency Database Recovery & Scan Tool
 *
 * 1. Safely copies all current and backup database files to an external emergency directory.
 * 2. Scans all database snapshots and historical files.
 * 3. Inspects and counts all invoices, items, and finds the latest invoice in each database.
 * 4. Displays which file has the most up-to-date invoice records.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DASHBOARD_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(DASHBOARD_DIR, '..');

// Emergency safe backup location outside the git repo
const EMERGENCY_DIR = process.platform === 'win32'
  ? path.join(process.env.TEMP || 'C:\\temp', 'hydraulic_emergency_backups_' + Date.now())
  : '/var/backups/hydraulic_emergency_' + Date.now();

try {
  fs.mkdirSync(EMERGENCY_DIR, { recursive: true });
} catch (e) {}

console.log('==================================================================');
console.log('   HYDRAULIC SYSTEM: DATABASE RESCUE & INVOICE INSPECTION TOOL   ');
console.log('==================================================================\n');

const candidateFiles = new Set();

function addCandidate(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.size > 10000) {
        candidateFiles.add(path.resolve(filePath));
      }
    } catch (_) {}
  }
}

// 1. Current database
addCandidate(path.join(ROOT_DIR, 'hydraulic.db'));

// 2. Backups directory
const backupDirs = [
  path.join(ROOT_DIR, 'backups'),
  path.join(DASHBOARD_DIR, 'backups'),
  ROOT_DIR,
];

for (const bDir of backupDirs) {
  if (fs.existsSync(bDir)) {
    try {
      const entries = fs.readdirSync(bDir);
      for (const entry of entries) {
        if (entry.endsWith('.db') || entry.includes('.bak') || entry.includes('.backup')) {
          addCandidate(path.join(bDir, entry));
        }
      }
    } catch (_) {}
  }
}

// Emergency copy of all candidates
console.log(`[1] Creating Emergency Preserved Copies in:\n    ${EMERGENCY_DIR}\n`);
for (const file of candidateFiles) {
  try {
    const dest = path.join(EMERGENCY_DIR, path.basename(file) + '_' + Date.now());
    fs.copyFileSync(file, dest);
    console.log(`  ✓ Preserved: ${path.basename(file)} -> ${dest}`);
  } catch (err) {
    console.warn(`  ! Could not copy ${file}: ${err.message}`);
  }
}

console.log('\n[2] Scanning All Found Databases for Invoices:\n');
console.log('---------------------------------------------------------------------------------------------------------------');
console.log(
  'File Name'.padEnd(36) +
  'Size'.padEnd(12) +
  'Invoices'.padEnd(12) +
  'Items'.padEnd(10) +
  'Latest Invoice (Date & Customer)'
);
console.log('---------------------------------------------------------------------------------------------------------------');

let bestFile = null;
let maxInvoices = -1;

for (const file of candidateFiles) {
  const stat = fs.statSync(file);
  const sizeStr = (stat.size / 1024).toFixed(1) + ' KB';
  const baseName = path.basename(file);

  try {
    const db = new Database(file, { readonly: true });
    
    // Check if Invoices table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Invoices'").get();
    if (!tableExists) {
      console.log(baseName.padEnd(36) + sizeStr.padEnd(12) + 'No Invoices table');
      db.close();
      continue;
    }

    const invCount = db.prepare('SELECT count(*) c FROM Invoices').get().c;
    let itemCount = 0;
    try {
      itemCount = db.prepare('SELECT count(*) c FROM InvoiceItems').get().c;
    } catch (_) {}

    const latest = db.prepare(
      'SELECT InvoiceNo, InvoiceDate, GrandTotal, BilledToName FROM Invoices ORDER BY InvoiceID DESC LIMIT 1'
    ).get();

    const latestStr = latest
      ? `${latest.InvoiceNo} (${String(latest.InvoiceDate || '').slice(0, 10)}) - ${latest.BilledToName || 'Unknown'} (Rs. ${latest.GrandTotal})`
      : 'No invoices recorded';

    console.log(
      baseName.padEnd(36) +
      sizeStr.padEnd(12) +
      String(invCount).padEnd(12) +
      String(itemCount).padEnd(10) +
      latestStr
    );

    if (invCount > maxInvoices) {
      maxInvoices = invCount;
      bestFile = file;
    }

    db.close();
  } catch (err) {
    console.log(baseName.padEnd(36) + sizeStr.padEnd(12) + `Error: ${err.message}`);
  }
}

console.log('---------------------------------------------------------------------------------------------------------------\n');

if (bestFile) {
  console.log(`[RESULT] Database with the MOST invoice data:`);
  console.log(`         File: ${bestFile}`);
  console.log(`         Total Invoices: ${maxInvoices}`);
  console.log(`\nTo make this file active on the VPS, run:`);
  console.log(`  cp "${bestFile}" /var/www/hydraulic-system/hydraulic.db`);
  console.log(`  pm2 restart all\n`);
} else {
  console.log('No valid SQLite databases found with an Invoices table.');
}
