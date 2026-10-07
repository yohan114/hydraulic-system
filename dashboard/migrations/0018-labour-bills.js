'use strict';

/**
 * Workshop Labour Bills — automatic generation + multi-stage approval.
 *
 * A labour bill gathers every finalized invoice whose workshop labour
 * (crimping / welding / lathe / technical) has not yet been paid out, as soon
 * as ONE of three conditions is met (all thresholds live in LabourBillSettings):
 *
 *   1. total unbilled labour  >= MinAmount  (default Rs. 15,000)
 *   2. unbilled jobs           >= MinJobs    (default 10)
 *   3. days since oldest job   >= MaxDays    (default 15)
 *
 * Workflow:
 *   GENERATED -> CERTIFIED (workshop) -> OM_APPROVED (operations manager)
 *             -> HO_APPROVED (head-office accounts; DGM/Chairman view)
 *             -> CLOSED (workshop accounts paid; bill sealed + encrypted)
 *   OM/HO may reject -> RETURNED -> workshop re-certifies.
 *
 * Integrity guarantees enforced by the DATABASE itself (not just the app):
 *   - an invoice can sit in at most one bill (UNIQUE InvoiceID)
 *   - approval records can never be updated or deleted
 *   - a bill can never be deleted, and once CLOSED can never be updated
 *   - bill items can only change while the bill is GENERATED or RETURNED
 */

const NEW_ROLES = [
  ['workshop_supervisor', 'Workshop Supervisor - certifies auto-generated labour bills'],
  ['operations_manager', 'Operations Manager - first approval of labour bills'],
  ['ho_accounts', 'Head Office Accounts - final approval of labour bills'],
  ['dgm', 'Deputy General Manager - read-only oversight of labour bills'],
  ['chairman', 'Chairman - read-only oversight of labour bills'],
  ['workshop_accounts', 'Workshop Accounts - pays approved labour bills and closes them'],
];

const NEW_PERMISSIONS = [
  ['labourbill.view', 'View workshop labour bills and their approval trail', 'labour'],
  ['labourbill.certify', 'Certify an auto-generated labour bill (workshop)', 'labour'],
  ['labourbill.approve.om', 'Approve/reject a labour bill as Operations Manager', 'labour'],
  ['labourbill.approve.ho', 'Approve/reject a labour bill as Head Office Accounts', 'labour'],
  ['labourbill.pay', 'Record labour payment and close an approved labour bill', 'labour'],
  ['labourbill.admin', 'Change labour bill thresholds and run the trigger check', 'labour'],
];

const ROLE_GRANTS = {
  workshop_supervisor: ['labourbill.view', 'labourbill.certify'],
  operations_manager: ['labourbill.view', 'labourbill.approve.om'],
  ho_accounts: ['labourbill.view', 'labourbill.approve.ho'],
  dgm: ['labourbill.view'],
  chairman: ['labourbill.view'],
  workshop_accounts: ['labourbill.view', 'labourbill.pay'],
  manager: ['labourbill.view'],
};

module.exports = {
  name: 'workshop labour bills with automatic generation and approval workflow',

  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS LabourBillSettings (
      SettingsID     INTEGER PRIMARY KEY CHECK (SettingsID = 1),
      MinAmount      REAL    NOT NULL DEFAULT 15000,
      MinJobs        INTEGER NOT NULL DEFAULT 10,
      MaxDays        INTEGER NOT NULL DEFAULT 15,
      Enabled        INTEGER NOT NULL DEFAULT 1,
      LastCheckedAt  TEXT,
      UpdatedAt      TEXT,
      UpdatedBy      TEXT
    )`);
    db.prepare(`INSERT OR IGNORE INTO LabourBillSettings (SettingsID, MinAmount, MinJobs, MaxDays, Enabled, UpdatedAt)
      VALUES (1, 15000, 10, 15, 1, datetime('now','localtime'))`).run();

    db.exec(`CREATE TABLE IF NOT EXISTS LabourBills (
      BillID          INTEGER PRIMARY KEY,
      BillNo          TEXT NOT NULL UNIQUE,
      Status          TEXT NOT NULL DEFAULT 'GENERATED'
                      CHECK (Status IN ('GENERATED','CERTIFIED','OM_APPROVED','HO_APPROVED','RETURNED','CLOSED')),
      TriggerCodes    TEXT NOT NULL,
      TriggerReason   TEXT NOT NULL,
      TotalAmount     REAL NOT NULL DEFAULT 0,
      JobCount        INTEGER NOT NULL DEFAULT 0,
      PeriodFrom      TEXT,
      PeriodTo        TEXT,
      ContentHash     TEXT NOT NULL,
      CreatedAt       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      CreatedBy       TEXT NOT NULL DEFAULT 'system',
      UpdatedAt       TEXT,
      PaidAt          TEXT,
      PaymentDate     TEXT,
      PaymentMethod   TEXT,
      PaymentRef      TEXT,
      PaidTo          TEXT,
      LabourPaymentID INTEGER REFERENCES LabourPayments(LabourPaymentID),
      ClosedAt        TEXT,
      ClosedBy        TEXT,
      SealedBlob      TEXT,
      SealIV          TEXT,
      SealTag         TEXT,
      SealHash        TEXT,
      CHECK (TotalAmount >= 0 AND JobCount >= 0)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS IX_LabourBills_Status ON LabourBills(Status)');

    db.exec(`CREATE TABLE IF NOT EXISTS LabourBillItems (
      BillItemID    INTEGER PRIMARY KEY,
      BillID        INTEGER NOT NULL REFERENCES LabourBills(BillID),
      InvoiceID     INTEGER NOT NULL UNIQUE REFERENCES Invoices(InvoiceID),
      InvoiceNo     TEXT NOT NULL,
      InvoiceDate   TEXT,
      Customer      TEXT,
      Crimping      REAL NOT NULL DEFAULT 0,
      Welding       REAL NOT NULL DEFAULT 0,
      Lathe         REAL NOT NULL DEFAULT 0,
      Technical     REAL NOT NULL DEFAULT 0,
      LineTotal     REAL NOT NULL DEFAULT 0
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS IX_LabourBillItems_Bill ON LabourBillItems(BillID)');

    db.exec(`CREATE TABLE IF NOT EXISTS LabourBillApprovals (
      ApprovalID   INTEGER PRIMARY KEY,
      BillID       INTEGER NOT NULL REFERENCES LabourBills(BillID),
      Seq          INTEGER NOT NULL,
      Stage        TEXT NOT NULL,
      Action       TEXT NOT NULL,
      ActorID      TEXT NOT NULL,
      ActorRole    TEXT,
      Note         TEXT,
      StatusFrom   TEXT,
      StatusTo     TEXT,
      SignedHash   TEXT NOT NULL,
      PrevHash     TEXT NOT NULL,
      RecordHash   TEXT NOT NULL,
      At           TEXT NOT NULL,
      UNIQUE (BillID, Seq)
    )`);

    // ---- database-level immutability --------------------------------------
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS TRG_LBA_NoUpdate BEFORE UPDATE ON LabourBillApprovals
      BEGIN SELECT RAISE(ABORT, 'Labour bill approval records are immutable'); END;

      CREATE TRIGGER IF NOT EXISTS TRG_LBA_NoDelete BEFORE DELETE ON LabourBillApprovals
      BEGIN SELECT RAISE(ABORT, 'Labour bill approval records are immutable'); END;

      CREATE TRIGGER IF NOT EXISTS TRG_LB_NoDelete BEFORE DELETE ON LabourBills
      BEGIN SELECT RAISE(ABORT, 'Labour bills can never be deleted'); END;

      CREATE TRIGGER IF NOT EXISTS TRG_LB_ClosedLocked BEFORE UPDATE ON LabourBills
      WHEN OLD.Status = 'CLOSED'
      BEGIN SELECT RAISE(ABORT, 'A closed labour bill is sealed and cannot be changed'); END;

      CREATE TRIGGER IF NOT EXISTS TRG_LBI_InsertLocked BEFORE INSERT ON LabourBillItems
      WHEN (SELECT Status FROM LabourBills WHERE BillID = NEW.BillID) NOT IN ('GENERATED','RETURNED')
      BEGIN SELECT RAISE(ABORT, 'Labour bill items are locked once the bill is certified'); END;

      CREATE TRIGGER IF NOT EXISTS TRG_LBI_UpdateLocked BEFORE UPDATE ON LabourBillItems
      BEGIN SELECT RAISE(ABORT, 'Labour bill items cannot be edited'); END;

      CREATE TRIGGER IF NOT EXISTS TRG_LBI_DeleteLocked BEFORE DELETE ON LabourBillItems
      WHEN (SELECT Status FROM LabourBills WHERE BillID = OLD.BillID) NOT IN ('GENERATED','RETURNED')
      BEGIN SELECT RAISE(ABORT, 'Labour bill items are locked once the bill is certified'); END;
    `);

    // ---- roles & permissions (kept in step with lib/endpointAuthorization) --
    const hasRbac = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Roles'").get();
    if (hasRbac) {
      const insRole = db.prepare('INSERT OR IGNORE INTO Roles (Name, Description) VALUES (?, ?)');
      for (const [name, desc] of NEW_ROLES) insRole.run(name, desc);
      const insPerm = db.prepare('INSERT OR IGNORE INTO Permissions (Code, Description, Module) VALUES (?, ?, ?)');
      for (const [code, desc, mod] of NEW_PERMISSIONS) insPerm.run(code, desc, mod);
      const roleId = (n) => (db.prepare('SELECT RoleID FROM Roles WHERE Name = ?').get(n) || {}).RoleID;
      const permId = (c) => (db.prepare('SELECT PermissionID FROM Permissions WHERE Code = ?').get(c) || {}).PermissionID;
      const grant = db.prepare('INSERT OR IGNORE INTO RolePermissions (RoleID, PermissionID) VALUES (?, ?)');
      for (const [role, perms] of Object.entries(ROLE_GRANTS)) {
        const r = roleId(role);
        if (!r) continue;
        for (const p of perms) { const pid = permId(p); if (pid) grant.run(r, pid); }
      }
      const admin = roleId('admin');
      if (admin) for (const [code] of NEW_PERMISSIONS) { const pid = permId(code); if (pid) grant.run(admin, pid); }
    }
  },
};
