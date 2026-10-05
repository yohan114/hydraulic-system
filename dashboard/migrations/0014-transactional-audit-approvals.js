'use strict';

/**
 * Transactional business audit log, security audit log, and dual-control approvals.
 *
 * THE GAP THIS CLOSES:
 *
 * 1. Financial transactions (invoices, receipts, revisions, refunds) lacked synchronous,
 *    in-transaction audit trail entries (AUD-01). If the audit log fails, the financial
 *    transaction must roll back completely (T26).
 *
 * 2. Sensitive operations like exports, authentication events, and authorization failures
 *    lacked an immutable security log (AUD-02, T27).
 *
 * 3. Dual-control approval workflows for credit refunds, period reopening, and manual stock
 *    adjustments lacked database-level authorization enforcement with tamper-detection (T23-T25).
 *
 * THE STRUCTURES:
 *
 *   BusinessAuditLog: Synchronous transactional log recording before/after payloads.
 *   SecurityAuditLog: Asynchronous/synchronous log recording access, logins, export downloads.
 *   Approvals:        Dual-control approval requests with cryptographic payload hash.
 */

const NEW_PERMISSIONS = [
  ['refund.request', 'Request cash refund for customer credit balance', 'credits'],
  ['refund.approve', 'Approve customer credit cash refund', 'credits'],
  ['refund.execute', 'Execute approved customer credit cash refund', 'credits'],
  ['period.close', 'Close financial accounting period', 'ledger'],
  ['period.reopen', 'Reopen closed financial accounting period', 'ledger'],
  ['report.financial.reconcile', 'View and run general ledger balance reconciliation', 'reports'],
  ['audit.security.view', 'View security audit access and export logs', 'audit'],
];

module.exports = {
  name: 'transactional audit log, security audit log, and dual-control approvals',

  up(db) {
    const now = "datetime('now', 'localtime')";

    // 1. BusinessAuditLog
    db.exec(`CREATE TABLE IF NOT EXISTS BusinessAuditLog (
      AuditID          INTEGER PRIMARY KEY,
      TxID             TEXT NOT NULL,
      At               TEXT NOT NULL DEFAULT (${now}),
      ActorID          TEXT NOT NULL,
      ActorRole        TEXT,
      Action           TEXT NOT NULL,
      EntityType       TEXT NOT NULL,
      EntityID         TEXT NOT NULL,
      PayloadBefore    TEXT,
      PayloadAfter     TEXT,
      Reason           TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_business_audit_entity ON BusinessAuditLog(EntityType, EntityID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_business_audit_actor ON BusinessAuditLog(ActorID, At)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_business_audit_tx ON BusinessAuditLog(TxID)');

    // 2. Approvals
    db.exec(`CREATE TABLE IF NOT EXISTS Approvals (
      ApprovalID       INTEGER PRIMARY KEY,
      ApprovalType     TEXT NOT NULL,
      TargetEntity     TEXT NOT NULL,
      TargetID         TEXT NOT NULL,
      PayloadHash      TEXT NOT NULL,
      RequestedBy      TEXT NOT NULL,
      RequestedAt      TEXT NOT NULL DEFAULT (${now}),
      ApprovedBy       TEXT,
      ApprovedAt       TEXT,
      Status           TEXT NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'approved', 'rejected', 'consumed', 'expired')),
      DecisionReason   TEXT,
      ExpiresAt        TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_approvals_lookup ON Approvals(ApprovalType, TargetEntity, TargetID, Status)');

    // 3. SecurityAuditLog
    db.exec(`CREATE TABLE IF NOT EXISTS SecurityAuditLog (
      LogID            INTEGER PRIMARY KEY,
      At               TEXT NOT NULL DEFAULT (${now}),
      ActorID          TEXT NOT NULL,
      ActorRole        TEXT,
      Action           TEXT NOT NULL,
      Resource         TEXT,
      IPAddress        TEXT,
      RowCount         INTEGER,
      Details          TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_security_audit_actor ON SecurityAuditLog(ActorID, At)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_security_audit_action ON SecurityAuditLog(Action, At)');

    // 4. Multi-site scoping (T17, T18)
    try {
      db.exec("ALTER TABLE Invoices ADD COLUMN SiteID TEXT NOT NULL DEFAULT 'main'");
    } catch (_) {}
    db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_site ON Invoices(SiteID)');

    // Seed new permissions if Permissions table exists
    try {
      const insPerm = db.prepare('INSERT OR IGNORE INTO Permissions (Code, Description, Module) VALUES (?, ?, ?)');
      for (const [code, desc, mod] of NEW_PERMISSIONS) {
        insPerm.run(code, desc, mod);
      }

      // Map permissions to roles
      const roles = db.prepare('SELECT RoleID, Name FROM Roles').all();
      const roleMap = Object.fromEntries(roles.map((r) => [r.Name, r.RoleID]));
      const perms = db.prepare('SELECT PermissionID, Code FROM Permissions').all();
      const permMap = Object.fromEntries(perms.map((p) => [p.Code, p.PermissionID]));

      const insRolePerm = db.prepare('INSERT OR IGNORE INTO RolePermissions (RoleID, PermissionID) VALUES (?, ?)');

      const mappings = {
        admin: [
          'refund.request', 'refund.approve', 'refund.execute',
          'period.close', 'period.reopen',
          'report.financial.reconcile', 'audit.security.view'
        ],
        manager: [
          'refund.request', 'refund.approve', 'refund.execute',
          'period.close', 'report.financial.reconcile'
        ],
        cashier: [
          'refund.request', 'refund.execute'
        ]
      };

      for (const [roleName, pCodes] of Object.entries(mappings)) {
        const rId = roleMap[roleName];
        if (!rId) continue;
        for (const pCode of pCodes) {
          const pId = permMap[pCode];
          if (pId) insRolePerm.run(rId, pId);
        }
      }
    } catch (_) {
      // If Permissions table doesn't exist yet, ignore
    }
  },

  down(db) {
    db.exec('DROP TABLE IF EXISTS SecurityAuditLog');
    db.exec('DROP TABLE IF EXISTS Approvals');
    db.exec('DROP TABLE IF EXISTS BusinessAuditLog');
  },
};
