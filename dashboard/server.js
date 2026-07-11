'use strict';

/**
 * App entry — middleware, the auth gate, router mounts and boot.
 * All endpoint logic lives in routes/*.js; shared logic in services/*.js and
 * lib/*.js; data access in db.js.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const { ensureSchema } = require('./migrate');
const connection = require('./db');
const { runStartupBackup } = require('./lib/backup');
const { router: authRouter, requireAuth } = require('./routes/auth');

const PORT = process.env.PORT || 9999;
const AUTH_ENABLED = process.env.BILLING_AUTH !== 'off';
const FALLBACK_PASSWORD = process.env.BILLING_PASSWORD || 'admin123';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Auth gate: every /api route requires a valid token except the two public
// auth endpoints. Static assets (non-/api paths) are always served.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/auth/login' || req.path === '/api/auth/status') return next();
  return requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

// Feature routers — each owns its own /api/... paths.
app.use(authRouter);
app.use(require('./routes/inventory'));
app.use(require('./routes/invoices'));
app.use(require('./routes/customers'));
app.use(require('./routes/payments'));
app.use(require('./routes/reports'));
app.use(require('./routes/finance'));

async function start() {
  try {
    const summary = await ensureSchema(connection);
    if (summary && summary.applied.length) console.log('Schema:', summary.applied.join(', '));
    if (summary && summary.failed && summary.failed.length) {
      console.error('WARNING: some schema upgrades FAILED — run "npm run migrate":');
      summary.failed.forEach((f) => console.error(`  - ${f.name}: ${f.error}`));
    }
  } catch (e) {
    console.warn('Schema check skipped:', e.message);
  }

  // Daily safety snapshot to backups/YYYY-MM-DD.db (keeps the last 7 days).
  try {
    const b = await runStartupBackup(connection._db);
    if (b.file) console.log(`Backup: wrote ${b.file}${b.pruned.length ? ` (pruned ${b.pruned.length} old)` : ''}`);
    else if (b.skipped) console.log("Backup: today's snapshot already present.");
  } catch (e) {
    console.warn('Backup skipped:', e.message);
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(AUTH_ENABLED
      ? `Authentication ON. Default login: admin / ${FALLBACK_PASSWORD} (change it in the app).`
      : 'Authentication OFF (BILLING_AUTH=off).');
  }).on('error', (err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
}

start();
