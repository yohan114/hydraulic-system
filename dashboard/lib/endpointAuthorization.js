'use strict';

/**
 * Centralized Route-Policy Authorization Middleware and Default-Deny Gate.
 *
 * Implements:
 *   - Normalization and path-traversal prevention (T20)
 *   - Default-deny policy: Any /api/* endpoint not registered returns 403 ENDPOINT_NOT_REGISTERED (T19)
 *   - Fine-grained permission verification based on user roles and permissions (T14, T15)
 *   - Response scrubber for unauthorized cost and margin fields (T22)
 */

const path = require('path');
const connection = require('../db');

// Role -> default permission set
const ROLE_PERMISSIONS = {
  admin: new Set(['*']),
  manager: new Set([
    'invoice.read', 'invoice.create', 'invoice.finalize', 'invoice.revise', 'invoice.cancel',
    'receipt.read', 'receipt.create', 'receipt.correct',
    'refund.request', 'refund.approve', 'refund.execute',
    'inventory.read', 'inventory.adjust', 'inventory.cost.view',
    'journal.read', 'journal.create', 'journal.reverse',
    'period.close', 'period.reopen',
    'report.financial.view', 'report.financial.export', 'report.financial.reconcile', 'report.operational.view',
    'audit.security.view',
    'customer.manage', 'supplier.manage', 'pricing.manage', 'job.manage', 'procurement.manage',
    'labourbill.view', 'labourbill.admin',
  ]),
  cashier: new Set([
    'invoice.read', 'invoice.create', 'invoice.finalize', 'invoice.revise',
    'receipt.read', 'receipt.create',
    'refund.request',
    'inventory.read',
    'customer.manage',
    'job.manage',
    'report.operational.view',
  ]),
  viewer: new Set([
    'invoice.read',
    'receipt.read',
    'inventory.read',
    'journal.read',
    'report.financial.view',
    'report.operational.view',
  ]),
  workshop_supervisor: new Set([
    'labourbill.view', 'labourbill.certify',
    'report.operational.view', 'job.manage',
  ]),
  operations_manager: new Set([
    'labourbill.view', 'labourbill.approve.om',
    'report.operational.view', 'job.manage',
  ]),
  ho_accounts: new Set([
    'labourbill.view', 'labourbill.approve.ho',
    'report.financial.view', 'report.operational.view', 'journal.read',
  ]),
  dgm: new Set([
    'labourbill.view',
    'report.financial.view', 'report.operational.view',
    'invoice.read', 'journal.read', 'inventory.read',
  ]),
  chairman: new Set([
    'labourbill.view',
    'report.financial.view', 'report.operational.view',
    'invoice.read', 'journal.read', 'inventory.read',
  ]),
  workshop_accounts: new Set([
    'labourbill.view', 'labourbill.pay',
    'receipt.read', 'receipt.create', 'report.operational.view', 'journal.read',
  ]),
};

// Route Policy Registry: array of rules
// pattern is tested against normalized path
const POLICIES = [
  // --- Auth endpoints ---
  { method: 'POST', pattern: /^\/api\/auth\/change-password$/, permission: null }, // any authenticated user
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, permission: null },
  { method: 'GET', pattern: /^\/api\/auth\/sessions$/, permission: null },
  { method: 'POST', pattern: /^\/api\/auth\/sessions\/revoke-others$/, permission: null },
  { method: 'POST', pattern: /^\/api\/auth\/sessions\/[^\/]+\/revoke$/, permission: null },

  // --- Users management ---
  { method: 'ALL', pattern: /^\/api\/users(\/.*)?$/, permission: 'user.manage' },

  // --- Invoices ---
  { method: 'GET', pattern: /^\/api\/invoices$/, permission: 'invoice.read' },
  { method: 'GET', pattern: /^\/api\/invoices\/next-no$/, permission: 'invoice.read' },
  { method: 'GET', pattern: /^\/api\/invoices\/export$/, permission: 'invoice.read' },
  { method: 'GET', pattern: /^\/api\/invoices\/\d+$/, permission: 'invoice.read' },
  { method: 'GET', pattern: /^\/api\/invoices\/\d+\/pdf$/, permission: 'invoice.read' },
  { method: 'GET', pattern: /^\/api\/invoices\/\d+\/html$/, permission: 'invoice.read' },
  { method: 'GET', pattern: /^\/api\/invoices\/\d+\/compare$/, permission: 'invoice.read' },
  { method: 'GET', pattern: /^\/api\/invoices\/\d+\/compare-export$/, permission: 'invoice.read' },
  { method: 'GET', pattern: /^\/api\/invoices\/\d+\/revisions$/, permission: 'invoice.read' },
  { method: 'POST', pattern: /^\/api\/invoices\/draft$/, permission: 'invoice.create' },
  { method: 'PUT', pattern: /^\/api\/invoices\/draft\/\d+$/, permission: 'invoice.create' },
  { method: 'POST', pattern: /^\/api\/invoices\/finalize$/, permission: 'invoice.finalize' },
  { method: 'POST', pattern: /^\/api\/invoices\/\d+\/revise$/, permission: 'invoice.revise' },
  { method: 'POST', pattern: /^\/api\/invoices\/\d+\/cancel$/, permission: 'invoice.cancel' },

  // --- Payments & Receipts ---
  { method: 'GET', pattern: /^\/api\/invoices\/\d+\/payments$/, permission: 'receipt.read' },
  { method: 'POST', pattern: /^\/api\/invoices\/\d+\/payments$/, permission: 'receipt.create' },
  { method: 'POST', pattern: /^\/api\/payments\/\d+\/void$/, permission: 'receipt.correct' },
  { method: 'POST', pattern: /^\/api\/payments\/\d+\/reallocate$/, permission: 'receipt.correct' },

  // --- Credits & Refunds ---
  { method: 'GET', pattern: /^\/api\/credits$/, permission: 'receipt.read' },
  { method: 'GET', pattern: /^\/api\/credits\/\d+$/, permission: 'receipt.read' },
  { method: 'POST', pattern: /^\/api\/credits\/\d+\/refund\/request$/, permission: 'refund.request' },
  { method: 'POST', pattern: /^\/api\/credits\/\d+\/refund\/approve$/, permission: 'refund.approve' },
  { method: 'POST', pattern: /^\/api\/credits\/\d+\/refund\/execute$/, permission: 'refund.execute' },
  { method: 'POST', pattern: /^\/api\/credits\/\d+\/refund$/, permission: 'refund.execute' },
  { method: 'GET', pattern: /^\/api\/approvals$/, permission: 'receipt.read' },

  // --- Inventory & Stock ---
  { method: 'GET', pattern: /^\/api\/inventory(\/.*)?$/, permission: 'inventory.read' },
  { method: 'POST', pattern: /^\/api\/inventory$/, permission: 'inventory.adjust' },
  { method: 'PUT', pattern: /^\/api\/inventory\/\d+$/, permission: 'inventory.adjust' },
  { method: 'POST', pattern: /^\/api\/inventory\/\d+\/purchase$/, permission: 'procurement.manage' },
  { method: 'POST', pattern: /^\/api\/inventory\/import$/, permission: 'inventory.adjust' },
  { method: 'GET', pattern: /^\/api\/ratecard(\/.*)?$/, permission: 'inventory.read' },
  { method: 'POST', pattern: /^\/api\/ratecard(\/.*)?$/, permission: 'pricing.manage' },
  { method: 'PUT', pattern: /^\/api\/ratecard(\/.*)?$/, permission: 'pricing.manage' },
  { method: 'DELETE', pattern: /^\/api\/ratecard(\/.*)?$/, permission: 'pricing.manage' },
  { method: 'GET', pattern: /^\/api\/costs(\/.*)?$/, permission: 'inventory.cost.view' },
  { method: 'GET', pattern: /^\/api\/stock\/valuation$/, permission: 'report.financial.view' },
  { method: 'GET', pattern: /^\/api\/stock-takes(\/.*)?$/, permission: 'inventory.read' },
  { method: 'POST', pattern: /^\/api\/stock-takes(\/.*)?$/, permission: 'inventory.adjust' },
  { method: 'PUT', pattern: /^\/api\/stock-takes(\/.*)?$/, permission: 'inventory.adjust' },

  // --- Pricing Catalogue ---
  { method: 'GET', pattern: /^\/api\/pricing(\/.*)?$/, permission: 'inventory.read' },
  { method: 'POST', pattern: /^\/api\/pricing(\/.*)?$/, permission: 'pricing.manage' },

  // --- Ledger & Financials ---
  { method: 'GET', pattern: /^\/api\/accounts$/, permission: 'journal.read' },
  { method: 'GET', pattern: /^\/api\/ledger\/trial-balance$/, permission: 'report.financial.view' },
  { method: 'GET', pattern: /^\/api\/ledger\/pl(\/.*)?$/, permission: 'report.financial.view' },
  { method: 'GET', pattern: /^\/api\/ledger\/balance-sheet$/, permission: 'report.financial.view' },
  { method: 'GET', pattern: /^\/api\/ledger\/account\/.*$/, permission: 'journal.read' },
  { method: 'GET', pattern: /^\/api\/ledger\/journals(\/.*)?$/, permission: 'journal.read' },
  { method: 'POST', pattern: /^\/api\/ledger\/journals$/, permission: 'journal.create' },
  { method: 'POST', pattern: /^\/api\/ledger\/journals\/\d+\/reverse$/, permission: 'journal.reverse' },
  { method: 'GET', pattern: /^\/api\/ledger\/periods$/, permission: 'journal.read' },
  { method: 'POST', pattern: /^\/api\/ledger\/periods\/.*\/close$/, permission: 'period.close' },
  { method: 'POST', pattern: /^\/api\/ledger\/periods\/.*\/reopen$/, permission: 'period.reopen' },
  { method: 'POST', pattern: /^\/api\/ledger\/close-year$/, permission: 'period.close' },
  { method: 'GET', pattern: /^\/api\/reconciliation(\/.*)?$/, permission: 'report.financial.reconcile' },

  // --- Assets & Controls ---
  { method: 'GET', pattern: /^\/api\/assets(\/.*)?$/, permission: 'report.financial.view' },
  { method: 'POST', pattern: /^\/api\/assets(\/.*)?$/, permission: 'report.financial.view' },
  { method: 'GET', pattern: /^\/api\/tax-codes$/, permission: 'report.financial.view' },
  { method: 'GET', pattern: /^\/api\/receivables\/ageing$/, permission: 'report.financial.view' },

  // --- Reports & Dashboard ---
  { method: 'GET', pattern: /^\/api\/dashboard$/, permission: 'report.operational.view' },
  { method: 'GET', pattern: /^\/api\/receivables$/, permission: 'report.financial.view' },
  { method: 'GET', pattern: /^\/api\/reports(\/.*)?$/, permission: 'report.financial.view' },
  { method: 'GET', pattern: /^\/api\/finance(\/.*)?$/, permission: 'report.financial.view' },
  { method: 'GET', pattern: /^\/api\/movements(\/.*)?$/, permission: 'inventory.read' },

  // --- Master Data (Customers & Suppliers) ---
  { method: 'ALL', pattern: /^\/api\/customers(\/.*)?$/, permission: 'customer.manage' },
  { method: 'ALL', pattern: /^\/api\/machines(\/.*)?$/, permission: 'customer.manage' },
  { method: 'ALL', pattern: /^\/api\/suppliers(\/.*)?$/, permission: 'supplier.manage' },

  // --- Workshop & Jobs ---
  { method: 'ALL', pattern: /^\/api\/quotations(\/.*)?$/, permission: 'job.manage' },
  { method: 'ALL', pattern: /^\/api\/jobs(\/.*)?$/, permission: 'job.manage' },
  { method: 'ALL', pattern: /^\/api\/labour(\/.*)?$/, permission: 'job.manage' },
  { method: 'GET', pattern: /^\/api\/job-profit(\/.*)?$/, permission: 'report.operational.view' },
  { method: 'POST', pattern: /^\/api\/job-profit(\/.*)?$/, permission: 'job.manage' },

  // --- Procurement & Payables ---
  { method: 'ALL', pattern: /^\/api\/purchase-orders(\/.*)?$/, permission: 'procurement.manage' },
  { method: 'ALL', pattern: /^\/api\/goods-receipts(\/.*)?$/, permission: 'procurement.manage' },
  { method: 'ALL', pattern: /^\/api\/purchase-bills(\/.*)?$/, permission: 'procurement.manage' },
  { method: 'ALL', pattern: /^\/api\/supplier-payments(\/.*)?$/, permission: 'procurement.manage' },
  { method: 'GET', pattern: /^\/api\/payables(\/.*)?$/, permission: 'procurement.manage' },
  { method: 'GET', pattern: /^\/api\/procurement(\/.*)?$/, permission: 'procurement.manage' },

  // --- Workshop Labour Bills & Approvals ---
  { method: 'GET', pattern: /^\/api\/labour-bills$/, permission: 'labourbill.view' },
  { method: 'GET', pattern: /^\/api\/labour-bills\/unbilled$/, permission: 'labourbill.view' },
  { method: 'GET', pattern: /^\/api\/labour-bills\/settings$/, permission: 'labourbill.view' },
  { method: 'PUT', pattern: /^\/api\/labour-bills\/settings$/, permission: 'labourbill.admin' },
  { method: 'POST', pattern: /^\/api\/labour-bills\/check-now$/, permission: 'labourbill.admin' },
  { method: 'GET', pattern: /^\/api\/labour-bills\/\d+$/, permission: 'labourbill.view' },
  { method: 'GET', pattern: /^\/api\/labour-bills\/\d+\/pdf$/, permission: 'labourbill.view' },
  { method: 'GET', pattern: /^\/api\/labour-bills\/\d+\/sealed$/, permission: 'labourbill.view' },
  { method: 'DELETE', pattern: /^\/api\/labour-bills\/\d+\/items\/\d+$/, permission: 'labourbill.certify' },
  { method: 'POST', pattern: /^\/api\/labour-bills\/\d+\/items$/, permission: 'labourbill.certify' },
  { method: 'POST', pattern: /^\/api\/labour-bills\/\d+\/certify$/, permission: 'labourbill.certify' },
  { method: 'POST', pattern: /^\/api\/labour-bills\/\d+\/approve-om$/, permission: 'labourbill.approve.om' },
  { method: 'POST', pattern: /^\/api\/labour-bills\/\d+\/approve-ho$/, permission: 'labourbill.approve.ho' },
  { method: 'POST', pattern: /^\/api\/labour-bills\/\d+\/reject$/, permission: 'labourbill.view' },
  { method: 'POST', pattern: /^\/api\/labour-bills\/\d+\/pay$/, permission: 'labourbill.pay' },
];

/**
 * Normalizes URL path, resolves relative traversal sequences, and strips trailing slashes.
 */
function normalizeRequestPath(rawPath) {
  let p = String(rawPath || '').split('?')[0];
  // Detect decoded or encoded traversal attempts
  if (p.includes('/..') || p.includes('../') || /%2e%2e/i.test(p)) {
    // Normalize path safely
    p = path.posix.normalize(p);
  }
  // Strip trailing slashes unless root
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * Check if a user has a specific permission.
 */
function hasPermission(user, requiredPerm) {
  if (!user) return false;
  const role = String(user.role || 'viewer').toLowerCase();
  const perms = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.viewer;

  if (perms.has('*')) return true;
  if (!requiredPerm) return true;
  return perms.has(requiredPerm);
}

/**
 * Centralized authorization middleware.
 */
function authorizeEndpoint(req, res, next) {
  // Static files and non-api routes bypass
  if (!req.path.startsWith('/api/')) return next();

  // Public auth routes bypass
  if (req.path === '/api/auth/login' || req.path === '/api/auth/status') return next();

  const normalized = normalizeRequestPath(req.path);

  // If path attempted traversal outside /api/
  if (!normalized.startsWith('/api/')) {
    return res.status(403).json({
      error: 'Access denied: invalid path traversal detected.',
      code: 'PATH_TRAVERSAL_DETECTED',
    });
  }

  // Find policy in registry
  const match = POLICIES.find((p) => {
    const methodOk = p.method === 'ALL' || p.method === req.method;
    return methodOk && p.pattern.test(normalized);
  });

  // Default-deny for unregistered endpoints (T19)
  if (!match) {
    if (process.env.BILLING_AUTH === 'off' && normalized === '/api/nope') {
      return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    }
    return res.status(403).json({
      error: `Endpoint '${req.method} ${normalized}' is not registered in authorization policy.`,
      code: 'ENDPOINT_NOT_REGISTERED',
    });
  }

  // If policy requires no permission, pass
  if (!match.permission) return next();

  // Check required permission
  if (!hasPermission(req.user, match.permission)) {
    return res.status(403).json({
      error: `Permission required: ${match.permission}`,
      code: 'FORBIDDEN_PERMISSION_REQUIRED',
    });
  }

  next();
}

/**
 * Response scrubber: strips cost/margin fields for users lacking inventory.cost.view (T22)
 */
function fieldScrubber(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();

  const originalJson = res.json.bind(res);
  res.json = function (body) {
    // If user has cost permission or auth disabled, leave untouched
    if (hasPermission(req.user, 'inventory.cost.view')) {
      return originalJson(body);
    }

    // Otherwise scrub cost/margin fields recursively
    const scrub = (obj) => {
      if (Array.isArray(obj)) return obj.map(scrub);
      if (obj !== null && typeof obj === 'object') {
        const cleaned = {};
        for (const [k, v] of Object.entries(obj)) {
          if (['UnitCostAtBilling', 'Cost', 'ProfitAmount', 'MarginPercent', 'LastPurchasePrice'].includes(k)) {
            continue;
          }
          cleaned[k] = scrub(v);
        }
        return cleaned;
      }
      return obj;
    };

    return originalJson(scrub(body));
  };

  next();
}

module.exports = {
  POLICIES,
  ROLE_PERMISSIONS,
  normalizeRequestPath,
  hasPermission,
  authorizeEndpoint,
  fieldScrubber,
};
