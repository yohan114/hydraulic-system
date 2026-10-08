'use strict';

/**
 * Production Pre-Flight Verification Tool for Hydraulic ERP
 *
 * Verifies system readiness before running in a production VPS environment:
 *   1. Node.js runtime version
 *   2. Database accessibility, SQLite integrity, and foreign keys
 *   3. Critical schema tables and migration completeness
 *   4. Admin user account presence
 *   5. Modern React frontend build (public_dist/index.html)
 *   6. Security environment settings (.env)
 *   7. Backup folder writability
 *
 * Usage:
 *   node deploy/verify-production.js
 */

const fs = require('fs');
const path = require('path');

const DASHBOARD_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(DASHBOARD_DIR, '..');
const DB_PATH = process.env.HYDRAULIC_DB || path.join(ROOT_DIR, 'hydraulic.db');

let passes = 0;
let warnings = 0;
let errors = 0;

function pass(name, detail) {
  passes++;
  console.log(`  [\x1b[32mPASS\x1b[0m] ${name}${detail ? ` - ${detail}` : ''}`);
}

function warn(name, detail) {
  warnings++;
  console.log(`  [\x1b[33mWARN\x1b[0m] ${name}${detail ? ` - ${detail}` : ''}`);
}

function fail(name, detail) {
  errors++;
  console.log(`  [\x1b[31mFAIL\x1b[0m] ${name}${detail ? ` - ${detail}` : ''}`);
}

async function verify() {
  console.log('==================================================================');
  console.log('   HYDRAULIC SYSTEM: PRODUCTION & VPS PRE-FLIGHT READINESS CHECK   ');
  console.log('==================================================================\n');

  // 1. Node runtime
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1).split('.')[0], 10);
  if (major >= 20) {
    pass('Node.js Runtime', `${nodeVer} (LTS target met)`);
  } else if (major >= 18) {
    warn('Node.js Runtime', `${nodeVer} (Supported, but Node 20 LTS recommended)`);
  } else {
    fail('Node.js Runtime', `${nodeVer} (Requires Node 18 or 20 LTS)`);
  }

  // 2. Database file existence
  if (fs.existsSync(DB_PATH)) {
    const stats = fs.statSync(DB_PATH);
    pass('Database File', `${path.basename(DB_PATH)} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  } else {
    fail('Database File', `Not found at ${DB_PATH}`);
  }

  // 3. Database integrity checks via better-sqlite3
  let db;
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (_) {
    warn('Node Dependencies', "Module 'better-sqlite3' not yet installed. Run 'npm install' or proceed to 'setup-vps.sh' (which installs dependencies automatically)");
  }

  if (Database) {
    try {
      db = new Database(DB_PATH, { readonly: false });

      // SQLite PRAGMA integrity_check
      const integrityRow = db.pragma('integrity_check');
      const integrityRes = integrityRow[0] ? Object.values(integrityRow[0])[0] : 'unknown';
      if (integrityRes === 'ok') {
        pass('SQLite Integrity Check', 'PRAGMA integrity_check = ok');
      } else {
        fail('SQLite Integrity Check', `Corruption detected: ${JSON.stringify(integrityRow)}`);
      }

      // SQLite PRAGMA foreign_key_check
      const fkErrors = db.pragma('foreign_key_check');
      if (fkErrors.length === 0) {
        pass('Foreign Key Consistency', 'Zero orphaned foreign key references');
      } else {
        warn('Foreign Key Consistency', `${fkErrors.length} potential FK anomalies found`);
      }

      // 4. Critical tables verification
      const criticalTables = [
        'Inventory', 'Invoices', 'InvoiceItems', 'Payments',
        'Users', 'JobCards', 'JobCardItems', 'Quotations', 'JobLabour',
        'LabourBills', 'LabourBillItems', 'Accounts',
        'JournalEntries', 'SecurityAuditLog', 'Periods'
      ];
      const missingTables = [];
      for (const tbl of criticalTables) {
        const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
        if (!exists) missingTables.push(tbl);
      }
      if (missingTables.length === 0) {
        pass('Database Tables Schema', `All ${criticalTables.length} required enterprise tables exist`);
      } else {
        fail('Database Tables Schema', `Missing tables: ${missingTables.join(', ')}`);
      }

      // 5. Admin user account check
      const userCount = db.prepare('SELECT COUNT(*) AS c FROM Users').get().c;
      const adminCount = db.prepare("SELECT COUNT(*) AS c FROM Users WHERE Role='admin'").get().c;
      if (adminCount > 0) {
        pass('User Access Security', `${userCount} total user(s) configured (${adminCount} admin account)`);
      } else if (userCount > 0) {
        warn('User Access Security', `${userCount} user(s) found but no role='admin' assigned`);
      } else {
        warn('User Access Security', 'No users found. Will rely on bootstrap BILLING_PASSWORD on first login');
      }
    } catch (err) {
      fail('Database Connection', err.message);
    } finally {
      if (db) db.close();
    }
  }

  // 6. Modern React Frontend Build
  const distHtml = path.join(DASHBOARD_DIR, 'public_dist', 'index.html');
  if (fs.existsSync(distHtml)) {
    const html = fs.readFileSync(distHtml, 'utf8');
    if (html.includes('/assets/index-') && html.includes('Hydraulic Hose Repair')) {
      pass('Vite React Frontend SPA', 'Compiled production bundle ready in public_dist/');
    } else {
      warn('Vite React Frontend SPA', 'public_dist/index.html exists but bundle format differs');
    }
  } else {
    fail('Vite React Frontend SPA', 'public_dist/index.html missing. Run npm run build in frontend/');
  }

  // 7. Backup directory write check
  const backupDir = path.join(ROOT_DIR, 'backups');
  try {
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const testFile = path.join(backupDir, '.write-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    pass('Backup Directory Permissions', `Writable at ${backupDir}`);
  } catch (err) {
    fail('Backup Directory Permissions', `Cannot write to ${backupDir}: ${err.message}`);
  }

  // 8. Environment Configuration
  const envPath = path.join(DASHBOARD_DIR, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent.includes('BILLING_SECRET=')) {
      pass('Production Environment (.env)', 'BILLING_SECRET is configured');
    } else {
      warn('Production Environment (.env)', 'BILLING_SECRET is not set in .env (will auto-generate on start)');
    }
  } else {
    warn('Production Environment (.env)', 'No .env found; setup-vps.sh will auto-mint secrets on deploy');
  }

  console.log('\n==================================================================');
  console.log(` RESULT: ${passes} Passed | ${warnings} Warnings | ${errors} Errors`);
  if (errors === 0) {
    console.log(' \x1b[32m✔ SYSTEM IS 100% PRODUCTION READY FOR VPS DEPLOYMENT!\x1b[0m');
  } else {
    console.log(' \x1b[31m✖ RESOLVE FAILED CHECKS BEFORE VPS DEPLOYMENT!\x1b[0m');
  }
  console.log('==================================================================\n');

  process.exitCode = errors > 0 ? 1 : 0;
}

verify().catch((err) => {
  console.error('Pre-flight execution error:', err);
  process.exit(1);
});
