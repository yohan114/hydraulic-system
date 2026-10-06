'use strict';

/**
 * Granular Role-Based Access Control (RBAC), Permission Registry, and Session Lifecycle.
 *
 * THE GAP THIS CLOSES
 *
 * 1. Previously, the system used coarse string checks ('admin', 'cashier', 'viewer')
 *    or a blanket viewerReadOnlyGuard. There was no fine-grained permission enforcement,
 *    no separation of duties for refunds/adjustments, and no scope isolation.
 *
 * 2. Tokens were stateless 12-hour signed blobs. Changing a user's password or demoting
 *    their role did not revoke outstanding active tokens (AUTH-02).
 *
 * THE STRUCTURES
 *
 *   Permissions:     Defines unique granular actions (e.g., 'invoice.finalize', 'journal.reverse').
 *   Roles:           Defines system and custom roles (admin, manager, cashier, viewer).
 *   RolePermissions: Maps permissions to roles.
 *   UserRoles:       Assigns roles to users.
 *   UserScopes:      Limits user access to specific company/site boundaries.
 *   Sessions:        Server-side session registry with revocation and AuthVersion checks.
 */

const PERMISSIONS = [
  // Invoices
  ['invoice.read', 'View invoices and line items', 'invoices'],
  ['invoice.create', 'Create and edit draft invoices', 'invoices'],
  ['invoice.finalize', 'Finalize invoices and deduct stock', 'invoices'],
  ['invoice.revise', 'Revise and supersede invoices', 'invoices'],
  ['invoice.cancel', 'Cancel unpaid invoices', 'invoices'],
  // Receipts & Payments
  ['receipt.read', 'View customer payments and allocations', 'payments'],
  ['receipt.create', 'Record customer payments', 'payments'],
  ['receipt.correct', 'Void receipts and reverse payments', 'payments'],
  // Credits & Refunds
  ['refund.request', 'Request cash refund from credit', 'refunds'],
  ['refund.approve', 'Approve customer refund voucher', 'refunds'],
  ['refund.execute', 'Execute physical cash or bank refund', 'refunds'],
  // Inventory
  ['inventory.read', 'View stock catalogue and items', 'inventory'],
  ['inventory.adjust', 'Manual stock adjustment and stocktake', 'inventory'],
  ['inventory.cost.view', 'View unit costs and purchase prices', 'inventory'],
  // General Ledger
  ['journal.read', 'View general ledger entries', 'ledger'],
  ['journal.create', 'Post manual journal entries', 'ledger'],
  ['journal.reverse', 'Reverse ledger journal entries', 'ledger'],
  ['period.close', 'Close accounting period', 'ledger'],
  ['period.reopen', 'Reopen accounting period', 'ledger'],
  // Reports
  ['report.financial.view', 'View balance sheet, P&L, trial balance', 'reports'],
  ['report.financial.export', 'Export financial statements', 'reports'],
  ['report.operational.view', 'View sales and workshop reports', 'reports'],
  // Users & Master Data
  ['user.manage', 'Create, update and manage user accounts', 'users'],
  ['customer.manage', 'Create and edit customer master data', 'customers'],
  ['supplier.manage', 'Create and edit supplier master data', 'suppliers'],
  ['pricing.manage', 'Update pricing rules and rate cards', 'pricing'],
  ['job.manage', 'Create and transition workshop job cards', 'jobs'],
  ['procurement.manage', 'Create purchase orders and bills', 'procurement'],
];

const ROLES = [
  ['admin', 'Full system administrator with unrestricted privileges'],
  ['manager', 'Workshop manager with operational and financial controls'],
  ['cashier', 'Point of sale cashier for drafting, finalizing, and receipts'],
  ['viewer', 'Read-only observer for audits and reporting'],
];

const CASHIER_PERMS = new Set([
  'invoice.read', 'invoice.create', 'invoice.finalize', 'invoice.revise',
  'receipt.read', 'receipt.create',
  'refund.request',
  'inventory.read',
  'customer.manage',
  'job.manage',
  'report.operational.view',
]);

const VIEWER_PERMS = new Set([
  'invoice.read',
  'receipt.read',
  'inventory.read',
  'journal.read',
  'report.financial.view',
  'report.operational.view',
]);

module.exports = {
  name: 'rbac permissions, user roles and session tracking',

  up(db) {
    const now = "datetime('now', 'localtime')";

    // 1. Add AuthVersion and IsActive to Users table if missing
    try {
      db.exec('ALTER TABLE Users ADD COLUMN AuthVersion INTEGER NOT NULL DEFAULT 1');
    } catch (_) {}
    try {
      db.exec('ALTER TABLE Users ADD COLUMN IsActive INTEGER NOT NULL DEFAULT 1');
    } catch (_) {}

    // 2. Permissions table
    db.exec(`CREATE TABLE IF NOT EXISTS Permissions (
      PermissionID INTEGER PRIMARY KEY,
      Code         TEXT NOT NULL UNIQUE,
      Description  TEXT NOT NULL,
      Module       TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_permissions_code ON Permissions(Code)');

    // 3. Roles table
    db.exec(`CREATE TABLE IF NOT EXISTS Roles (
      RoleID      INTEGER PRIMARY KEY,
      Name        TEXT NOT NULL UNIQUE,
      Description TEXT
    )`);

    // 4. RolePermissions mapping
    db.exec(`CREATE TABLE IF NOT EXISTS RolePermissions (
      RoleID       INTEGER NOT NULL REFERENCES Roles(RoleID) ON DELETE CASCADE,
      PermissionID INTEGER NOT NULL REFERENCES Permissions(PermissionID) ON DELETE CASCADE,
      PRIMARY KEY (RoleID, PermissionID)
    )`);

    // 5. UserRoles mapping
    db.exec(`CREATE TABLE IF NOT EXISTS UserRoles (
      UserID  INTEGER NOT NULL REFERENCES Users(UserID) ON DELETE CASCADE,
      RoleID  INTEGER NOT NULL REFERENCES Roles(RoleID) ON DELETE CASCADE,
      PRIMARY KEY (UserID, RoleID)
    )`);

    // 6. UserScopes table
    db.exec(`CREATE TABLE IF NOT EXISTS UserScopes (
      ScopeID   INTEGER PRIMARY KEY,
      UserID    INTEGER NOT NULL REFERENCES Users(UserID) ON DELETE CASCADE,
      CompanyID INTEGER NOT NULL DEFAULT 1,
      SiteID    TEXT NOT NULL DEFAULT 'main',
      UNIQUE (UserID, CompanyID, SiteID)
    )`);

    // 7. Sessions table
    db.exec(`CREATE TABLE IF NOT EXISTS Sessions (
      SessionID     TEXT PRIMARY KEY,
      UserID        INTEGER NOT NULL REFERENCES Users(UserID) ON DELETE CASCADE,
      AuthVersion   INTEGER NOT NULL DEFAULT 1,
      CreatedAt     TEXT NOT NULL DEFAULT (${now}),
      ExpiresAt     TEXT NOT NULL,
      RevokedAt     TEXT,
      RevokedReason TEXT,
      LastSeenAt    TEXT NOT NULL DEFAULT (${now}),
      IPAddress     TEXT,
      UserAgent     TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON Sessions(UserID, RevokedAt)');

    // 8. Seed Permissions
    const insPerm = db.prepare(
      'INSERT OR IGNORE INTO Permissions (Code, Description, Module) VALUES (?, ?, ?)'
    );
    for (const [code, desc, mod] of PERMISSIONS) {
      insPerm.run(code, desc, mod);
    }

    // 9. Seed Roles
    const insRole = db.prepare(
      'INSERT OR IGNORE INTO Roles (Name, Description) VALUES (?, ?)'
    );
    for (const [name, desc] of ROLES) {
      insRole.run(name, desc);
    }

    // 10. Map Role Permissions
    const allPerms = db.prepare('SELECT PermissionID, Code FROM Permissions').all();
    const permMap = new Map(allPerms.map((p) => [p.Code, p.PermissionID]));
    const roleRows = db.prepare('SELECT RoleID, Name FROM Roles').all();
    const roleMap = new Map(roleRows.map((r) => [r.Name, r.RoleID]));

    const insRolePerm = db.prepare(
      'INSERT OR IGNORE INTO RolePermissions (RoleID, PermissionID) VALUES (?, ?)'
    );

    const adminId = roleMap.get('admin');
    const managerId = roleMap.get('manager');
    const cashierId = roleMap.get('cashier');
    const viewerId = roleMap.get('viewer');

    for (const [code, permId] of permMap.entries()) {
      // Admin gets everything
      if (adminId) insRolePerm.run(adminId, permId);
      // Manager gets everything except user.manage
      if (managerId && code !== 'user.manage') insRolePerm.run(managerId, permId);
      // Cashier gets cashier subset
      if (cashierId && CASHIER_PERMS.has(code)) insRolePerm.run(cashierId, permId);
      // Viewer gets read-only subset
      if (viewerId && VIEWER_PERMS.has(code)) insRolePerm.run(viewerId, permId);
    }

    // 11. Backfill existing Users into UserRoles and UserScopes
    try {
      const users = db.prepare('SELECT UserID, Role FROM Users').all();
      const insUserRole = db.prepare('INSERT OR IGNORE INTO UserRoles (UserID, RoleID) VALUES (?, ?)');
      const insUserScope = db.prepare('INSERT OR IGNORE INTO UserScopes (UserID, CompanyID, SiteID) VALUES (?, 1, "main")');

      for (const u of users) {
        const rName = String(u.Role || 'admin').toLowerCase();
        const rId = roleMap.get(rName) || adminId;
        if (rId) insUserRole.run(u.UserID, rId);
        insUserScope.run(u.UserID);
      }
    } catch (_) {}
  },

  down(db) {
    db.exec('DROP TABLE IF EXISTS Sessions');
    db.exec('DROP TABLE IF EXISTS UserScopes');
    db.exec('DROP TABLE IF EXISTS UserRoles');
    db.exec('DROP TABLE IF EXISTS RolePermissions');
    db.exec('DROP TABLE IF EXISTS Roles');
    db.exec('DROP TABLE IF EXISTS Permissions');
  },
};
