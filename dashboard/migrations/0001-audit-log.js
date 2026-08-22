'use strict';

/**
 * Audit trail.
 *
 * Nothing in the system recorded who changed what. For a set of books that is
 * the difference between "the stock is wrong" and "the stock is wrong because
 * this user adjusted it on Tuesday".
 *
 * One row per state-changing API call: the actor, the route, the entity it
 * touched and — where the route can supply it — the before/after payload as
 * JSON. Reads are not logged; they would bury the writes.
 */

module.exports = {
  name: 'audit log',

  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS AuditLog (
      AuditID    INTEGER PRIMARY KEY,
      At         TEXT NOT NULL,
      Username   TEXT,
      Role       TEXT,
      Method     TEXT NOT NULL,
      Path       TEXT NOT NULL,
      Entity     TEXT,
      EntityID   TEXT,
      Action     TEXT,
      Status     INTEGER,
      Before     TEXT,
      After      TEXT,
      IP         TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_at ON AuditLog(At)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_entity ON AuditLog(Entity, EntityID)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_user ON AuditLog(Username)');
  },

  down(db) {
    db.exec('DROP TABLE IF EXISTS AuditLog');
  },
};
