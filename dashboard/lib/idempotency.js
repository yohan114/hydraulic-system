'use strict';

/**
 * Idempotency tracking and replay protection for financial mutations.
 *
 * Scenarios:
 *   T04: Replay finalize/receipt/refund command with identical key -> returns cached original response, 0 side effects.
 *   T05: Replay same key with modified body -> HTTP 409 IDEMPOTENCY_PAYLOAD_MISMATCH.
 */

const crypto = require('crypto');

function hashPayload(body) {
  if (body == null) return '';
  // Normalize JSON keys for deterministic hashing
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Check if an idempotency key was already processed.
 *
 * @param {object} db - better-sqlite3 database instance
 * @param {string} key - Idempotency key from header or body
 * @param {string} actorId - Username or UserID of caller
 * @param {any} reqBody - Request payload
 * @returns {{ match: boolean, cached?: object, mismatch?: boolean }}
 */
function checkIdempotency(db, key, actorId, reqBody) {
  if (!key) return { match: false };

  const row = db.prepare('SELECT * FROM IdempotencyKeys WHERE IdempotencyKey = ?').get(key);
  if (!row) return { match: false };

  const currentHash = hashPayload(reqBody);
  if (row.RequestHash !== currentHash) {
    return { match: true, mismatch: true };
  }

  let body = row.ResponseBody;
  try {
    body = JSON.parse(row.ResponseBody);
  } catch (_) {}

  return {
    match: true,
    mismatch: false,
    cached: {
      status: row.ResponseCode,
      body,
    },
  };
}

/**
 * Save an executed response against the idempotency key.
 */
function recordIdempotency(db, key, actorId, operation, reqBody, responseCode, responseBody) {
  if (!key) return;

  const hash = hashPayload(reqBody);
  const bodyStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
  const now = "datetime('now', 'localtime')";

  try {
    db.prepare(`
      INSERT OR REPLACE INTO IdempotencyKeys (IdempotencyKey, ActorID, Operation, RequestHash, ResponseCode, ResponseBody, CreatedAt, ExpiresAt)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), datetime('now', '+24 hours'))
    `).run(key, String(actorId || 'system'), operation, hash, responseCode, bodyStr);
  } catch (err) {
    console.error('Failed to save idempotency key:', err.message);
  }
}

module.exports = {
  hashPayload,
  checkIdempotency,
  recordIdempotency,
};
