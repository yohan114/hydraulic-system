'use strict';

/**
 * Hardened Transactional Business Audit Log & Security Audit Log.
 *
 * Scenarios:
 *   T26: Injected disk/DB error on BusinessAuditLog write -> Financial transaction rolls back completely.
 *   T27: Sensitive export requested -> Request authorized; entry written to SecurityAuditLog with IP & row count.
 */

const crypto = require('crypto');

/**
 * Synchronous in-transaction audit record.
 * Must throw on failure so enclosing db.transaction rolls back!
 */
function recordBusinessAudit(db, {
  txId,
  actorId,
  actorRole,
  action,
  entityType,
  entityId,
  payloadBefore,
  payloadAfter,
  reason,
}) {
  const transactionId = txId || crypto.randomUUID();
  const beforeStr = payloadBefore != null ? (typeof payloadBefore === 'string' ? payloadBefore : JSON.stringify(payloadBefore)) : null;
  const afterStr = payloadAfter != null ? (typeof payloadAfter === 'string' ? payloadAfter : JSON.stringify(payloadAfter)) : null;

  const stmt = db.prepare(`
    INSERT INTO BusinessAuditLog (TxID, At, ActorID, ActorRole, Action, EntityType, EntityID, PayloadBefore, PayloadAfter, Reason)
    VALUES (?, datetime('now', 'localtime'), ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    transactionId,
    String(actorId || 'system'),
    actorRole || null,
    String(action),
    String(entityType),
    String(entityId),
    beforeStr,
    afterStr,
    reason || null
  );

  return transactionId;
}

/**
 * Security audit record for access events, downloads, and policy checks.
 */
function recordSecurityAudit(db, {
  actorId,
  actorRole,
  action,
  resource,
  ip,
  rowCount,
  details,
}) {
  try {
    const detailsStr = details != null ? (typeof details === 'string' ? details : JSON.stringify(details)) : null;
    const stmt = db.prepare(`
      INSERT INTO SecurityAuditLog (At, ActorID, ActorRole, Action, Resource, IPAddress, RowCount, Details)
      VALUES (datetime('now', 'localtime'), ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      String(actorId || 'anonymous'),
      actorRole || null,
      String(action),
      resource || null,
      ip || null,
      rowCount != null ? Number(rowCount) : null,
      detailsStr
    );
  } catch (err) {
    console.error('Failed to write SecurityAuditLog:', err.message);
  }
}

module.exports = {
  recordBusinessAudit,
  recordSecurityAudit,
};
