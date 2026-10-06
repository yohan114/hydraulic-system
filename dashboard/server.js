'use strict';

/**
 * App entry — middleware, the auth gate, router mounts and boot.
 * All endpoint logic lives in routes/*.js; shared logic in services/*.js and
 * lib/*.js; data access in db.js.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');

const { migrateToLatest } = require('./migrate');
const connection = require('./db');
const { runStartupBackup, startDailyBackupScheduler } = require('./lib/backup');
const { auditMiddleware } = require('./lib/audit');
const { router: authRouter, requireAuth, viewerReadOnlyGuard } = require('./routes/auth');
const { authorizeEndpoint, fieldScrubber } = require('./lib/endpointAuthorization');

const PORT = process.env.PORT || 9999;
if (process.env.NODE_ENV === 'production' && process.env.BILLING_AUTH === 'off') {
  console.error('FATAL: BILLING_AUTH cannot be set to "off" in production environment.');
  process.exit(1);
}
const AUTH_ENABLED = process.env.BILLING_AUTH !== 'off';
const FALLBACK_PASSWORD = process.env.BILLING_PASSWORD || 'admin123';

const app = express();

// Enable proxy trust for reverse proxies (Nginx, Caddy, Cloudflare) on VPS
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY) {
  app.set('trust proxy', 1);
}

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Auth gate: every /api route requires a valid token except the two public
// auth endpoints. Static assets (non-/api paths) are always served.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/auth/login' || req.path === '/api/auth/status') return next();
  return requireAuth(req, res, next);
});

// Centralized endpoint policy authorization & default-deny
app.use(authorizeEndpoint);

// Sensitive field scrubber (masks cost data from unauthorized roles)
app.use(fieldScrubber);

// Role gate: viewers are read-only (writes are refused). requireAuth above has
// already populated req.user, so this can see the caller's role.
app.use(viewerReadOnlyGuard);

// Audit trail: one row per state-changing API call, written after the response
// so the recorded status is the real one. Reads are not logged.
app.use(auditMiddleware(connection));

app.use(express.static(path.join(__dirname, 'public')));

// Feature routers — each owns its own /api/... paths.
app.use(authRouter);
app.use(require('./routes/inventory'));
app.use(require('./routes/invoices'));
app.use(require('./routes/suppliers'));
app.use(require('./routes/customers'));
app.use(require('./routes/payments'));
app.use(require('./routes/reports'));
app.use(require('./routes/finance'));
app.use(require('./routes/users'));
app.use(require('./routes/jobProfit'));
app.use(require('./routes/pricing'));
app.use(require('./routes/ledger'));
app.use(require('./routes/procurement'));
app.use(require('./routes/jobs'));
app.use(require('./routes/controls'));
app.use(require('./routes/credits'));
app.use(require('./routes/reconciliation'));

async function start() {
  try {
    // Baseline, then any pending numbered migration. A safety copy of the
    // database is written first; if that copy cannot be made, nothing is
    // applied and the error surfaces here rather than half-migrating.
    const { baseline, migrations } = await migrateToLatest(connection, { log: (m) => console.log(' ', m) });
    if (baseline && baseline.applied.length) console.log('Schema:', baseline.applied.join(', '));
    if (baseline && baseline.failed && baseline.failed.length) {
      console.error('WARNING: some schema upgrades FAILED — run "npm run migrate":');
      baseline.failed.forEach((f) => console.error(`  - ${f.name}: ${f.error}`));
    }
    if (migrations && migrations.applied.length) console.log('Migrations:', migrations.applied.join(', '));
    if (migrations && migrations.drifted.length) {
      console.error('WARNING: these migrations were edited after being applied:');
      migrations.drifted.forEach((d) => console.error(`  - ${d.version} ${d.name}`));
    }
  } catch (e) {
    console.error('Migration failed — server not started:', e.message);
    process.exit(1);
  }

  // Daily safety snapshot to backups/YYYY-MM-DD.db (keeps the last 7 days).
  try {
    const b = await runStartupBackup(connection._db);
    if (b.file) console.log(`Backup: wrote ${b.file}${b.pruned.length ? ` (pruned ${b.pruned.length} old)` : ''}`);
    else if (b.skipped) console.log("Backup: today's snapshot already present.");
    startDailyBackupScheduler(connection._db);
  } catch (e) {
    console.warn('Backup skipped:', e.message);
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (AUTH_ENABLED) {
      const isCustom = !!process.env.BILLING_PASSWORD;
      console.log(`Authentication ON. ${isCustom ? 'Configured password in use.' : 'Default admin password in use (change it in settings).'}`);
    } else {
      console.log('Authentication OFF (BILLING_AUTH=off).');
    }
  }).on('error', (err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
}

// Exported so the integration tests can drive the real app (routers, auth gate,
// role guard and all) against a throwaway database without opening a port.
module.exports = { app, start };

if (require.main === module) start();
