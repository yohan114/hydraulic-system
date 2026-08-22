'use strict';

/**
 * Audit trail middleware.
 *
 * Records one row per state-changing API call (POST/PUT/PATCH/DELETE) once the
 * response status is known, so a rejected write is logged as a rejected write
 * rather than silently dropped.
 *
 * Design rules:
 *  - Reads are never logged. They would bury the writes and the table would grow
 *    without telling anyone anything.
 *  - Auditing must never break a request. Every failure here is swallowed; a
 *    broken audit table must not stop the shop invoicing.
 *  - Secrets never reach the log. Password fields are stripped from the body.
 *  - A route can enrich its own entry via `res.locals.audit = { entity, entityId,
 *    action, before, after }` — for example the invoice router naming the
 *    invoice it finalized.
 */

const SENSITIVE = /password|token|secret|hash/i;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_JSON = 4000;

/** Deep-copy a payload with secret-looking fields blanked. */
function redact(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v);
  }
  return out;
}

/** JSON for the log column, capped so one bulk import cannot bloat the table. */
function toJson(value) {
  if (value === undefined || value === null) return null;
  try {
    const s = JSON.stringify(redact(value));
    return s == null ? null : (s.length > MAX_JSON ? s.slice(0, MAX_JSON) + '…' : s);
  } catch (_) {
    return null;
  }
}

/**
 * Guess the entity and id from the route, e.g. /api/inventory/12 -> inventory/12.
 * A router that knows better overrides this via res.locals.audit.
 */
function entityFromPath(p) {
  const parts = String(p || '').split('/').filter(Boolean); // ['api','inventory','12']
  if (parts[0] !== 'api' || parts.length < 2) return { entity: null, entityId: null };
  const entity = parts[1];
  const maybeId = parts[2];
  return { entity, entityId: maybeId && /^\d+$/.test(maybeId) ? maybeId : null };
}

/**
 * @param {{_db: import('better-sqlite3').Database}} connection
 * @param {object} [opts]
 * @param {Function} [opts.userOf] req -> { username, role }
 * @returns {Function} express middleware
 */
function auditMiddleware(connection, opts = {}) {
  const userOf = opts.userOf || ((req) => req.user || {});
  let insert = null;

  function stmt() {
    if (insert) return insert;
    insert = connection._db.prepare(`INSERT INTO AuditLog
      (At, Username, Role, Method, Path, Entity, EntityID, Action, Status, Before, After, IP)
      VALUES (@At, @Username, @Role, @Method, @Path, @Entity, @EntityID, @Action, @Status, @Before, @After, @IP)`);
    return insert;
  }

  return function audit(req, res, next) {
    if (!MUTATING.has(req.method) || !req.path.startsWith('/api/')) return next();

    // Capture the body now: a router is free to mutate req.body as it works.
    const requestBody = toJson(req.body);

    res.on('finish', () => {
      try {
        const extra = res.locals.audit || {};
        const guess = entityFromPath(req.path);
        const user = userOf(req) || {};
        stmt().run({
          At: new Date().toISOString().replace('T', ' ').slice(0, 19),
          Username: user.username || user.sub || null,
          Role: user.role || null,
          Method: req.method,
          Path: req.originalUrl || req.path,
          Entity: extra.entity || guess.entity,
          EntityID: extra.entityId != null ? String(extra.entityId) : guess.entityId,
          Action: extra.action || null,
          Status: res.statusCode,
          Before: toJson(extra.before),
          After: extra.after !== undefined ? toJson(extra.after) : requestBody,
          IP: req.ip || (req.socket && req.socket.remoteAddress) || null,
        });
      } catch (_) {
        // Never let auditing break a request.
      }
    });

    next();
  };
}

module.exports = { auditMiddleware, redact, toJson, entityFromPath };
