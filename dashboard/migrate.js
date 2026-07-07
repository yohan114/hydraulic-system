'use strict';

/**
 * Idempotent schema upgrade for the smart-billing features.
 *
 * Adds the columns and tables introduced by the lock / accuracy / payment work
 * to an existing HydraulicHoseRepair.accdb, without touching data. Every
 * statement is run independently and "already exists" errors are swallowed, so
 * it is safe to run repeatedly — the server also calls {@link ensureSchema} on
 * boot so operators do not have to remember to run it by hand.
 *
 * Run standalone:  node migrate.js   (or: npm run migrate)
 */

const ADODB = require('node-adodb');

// Each entry is one DDL statement plus a human label for logging.
const COLUMN_UPGRADES = [
    ['Inventory.Price', 'ALTER TABLE Inventory ADD COLUMN Price DOUBLE'],
    ['Inventory.Cost', 'ALTER TABLE Inventory ADD COLUMN Cost DOUBLE'],
    ['Invoices.Discount', 'ALTER TABLE Invoices ADD COLUMN Discount CURRENCY'],
    ['Invoices.RoundOff', 'ALTER TABLE Invoices ADD COLUMN RoundOff CURRENCY'],
    ['Invoices.AmountPaid', 'ALTER TABLE Invoices ADD COLUMN AmountPaid CURRENCY'],
    ['Invoices.PaymentStatus', 'ALTER TABLE Invoices ADD COLUMN PaymentStatus VARCHAR(20)'],
    ['Invoices.CancelledAt', 'ALTER TABLE Invoices ADD COLUMN CancelledAt DATETIME'],
    ['Invoices.CancelReason', 'ALTER TABLE Invoices ADD COLUMN CancelReason MEMO'],
];

const TABLE_UPGRADES = [
    ['Payments', `CREATE TABLE Payments (
        [PaymentID] AUTOINCREMENT PRIMARY KEY,
        [InvoiceID] INT,
        [Amount] CURRENCY,
        [PaymentDate] DATETIME,
        [Method] VARCHAR(50),
        [Notes] MEMO,
        [CreatedAt] DATETIME
    )`],
    ['Users', `CREATE TABLE Users (
        [UserID] AUTOINCREMENT PRIMARY KEY,
        [Username] VARCHAR(100) UNIQUE NOT NULL,
        [PasswordHash] VARCHAR(255) NOT NULL,
        [Role] VARCHAR(50),
        [CreatedAt] DATETIME,
        [UpdatedAt] DATETIME
    )`],
];

// Indexes to ensure. A UNIQUE index on InvoiceNo makes a duplicate number fail
// loudly at insert time instead of silently attaching items to another invoice.
// (Fresh DBs from create_db.ps1 already declare InvoiceNo UNIQUE; this backfills
// older databases. It is skipped harmlessly if the index exists or if legacy
// duplicate data is present.)
const INDEX_UPGRADES = [
    ['Invoices.InvoiceNo (unique)', 'CREATE UNIQUE INDEX idx_Invoices_InvoiceNo ON Invoices (InvoiceNo)'],
];

// True when the driver error means "this column/table already exists".
function isAlreadyExists(message) {
    const m = String(message || '').toLowerCase();
    return (
        m.includes('already exists') ||
        m.includes('already has') ||
        m.includes('duplicate') ||
        // Access reports a re-added column as a general field-already-in-use error.
        m.includes('field') && m.includes('already')
    );
}

/**
 * Apply all pending upgrades against an open node-adodb connection.
 * @param {{execute: Function}} connection
 * @returns {Promise<{applied:string[], skipped:string[], failed:Array<{name:string,error:string}>}>}
 */
async function ensureSchema(connection) {
    const applied = [];
    const skipped = [];
    const failed = [];

    for (const [name, ddl] of [...COLUMN_UPGRADES, ...TABLE_UPGRADES]) {
        try {
            await connection.execute(ddl);
            applied.push(name);
        } catch (err) {
            if (isAlreadyExists(err.message)) {
                skipped.push(name);
            } else {
                failed.push({ name, error: err.message });
            }
        }
    }

    // Indexes are best-effort: an existing index or legacy duplicate data must
    // not fail the whole migration.
    for (const [name, ddl] of INDEX_UPGRADES) {
        try {
            await connection.execute(ddl);
            applied.push(name);
        } catch (err) {
            skipped.push(name);
        }
    }

    // Backfill sensible defaults so derived reads are stable on old rows.
    const backfills = [
        "UPDATE Invoices SET AmountPaid = 0 WHERE AmountPaid IS NULL",
        "UPDATE Invoices SET Discount = 0 WHERE Discount IS NULL",
        "UPDATE Invoices SET RoundOff = 0 WHERE RoundOff IS NULL",
        "UPDATE Inventory SET Cost = 0 WHERE Cost IS NULL",
    ];
    for (const stmt of backfills) {
        try { await connection.execute(stmt); } catch (_) { /* column may still be missing */ }
    }

    return { applied, skipped, failed };
}

async function main() {
    // Pass the x64 flag (second arg = true) to match server.js — otherwise
    // `npm run migrate` can fail on 64-bit Node while the server works.
    const connection = ADODB.open(
        'Provider=Microsoft.ACE.OLEDB.12.0;Data Source=../HydraulicHoseRepair.accdb;Persist Security Info=False;',
        true
    );
    console.log('Running schema upgrade...');
    const summary = await ensureSchema(connection);
    if (summary.applied.length) console.log('Applied:', summary.applied.join(', '));
    if (summary.skipped.length) console.log('Already present:', summary.skipped.join(', '));
    if (summary.failed.length) {
        console.error('Failed:');
        summary.failed.forEach((f) => console.error(`  - ${f.name}: ${f.error}`));
        process.exitCode = 1;
    }
    console.log('Done.');
}

module.exports = { ensureSchema };

if (require.main === module) {
    main().catch((err) => {
        console.error('Migration error:', err.message);
        process.exit(1);
    });
}
