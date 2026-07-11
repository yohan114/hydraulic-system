'use strict';

/**
 * SQL literal helpers for the Access (ACE OLEDB) dialect.
 *
 * node-adodb has no real parameter binding, so values are interpolated into
 * statements. These helpers make that safe:
 *   - `q()` single-quote-escapes and wraps strings (or emits NULL),
 *   - `n()` forces a value to a finite number and THROWS on anything else, so a
 *     malformed/injected numeric field fails the request instead of reaching
 *     the database,
 *   - `dbDate()` renders a JS date as an Access `#yyyy-mm-dd#` literal.
 */

/** Escape a string for use inside single quotes. */
function esc(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

/**
 * Quote a string as a SQL literal, or NULL when blank/absent.
 * @param {*} value
 * @param {boolean} [nullable=false] emit NULL for empty values instead of ''
 * @returns {string}
 */
function q(value, nullable = false) {
  if (value == null || value === '') return nullable ? 'NULL' : "''";
  return `'${esc(value)}'`;
}

/**
 * Coerce a value to a finite number for numeric SQL contexts.
 * Throws when the value is not a finite number, which callers surface as a
 * 400/500 rather than emitting an injectable fragment.
 * @param {*} value
 * @param {number} [fallback] used when value is null/undefined/''
 * @returns {number}
 */
function n(value, fallback) {
  if ((value == null || value === '') && fallback !== undefined) return numFinite(fallback);
  return numFinite(value);
}

function numFinite(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Render a date as an Access date literal `#yyyy-mm-dd hh:mm:ss#`, or NULL.
 * @param {Date|string} value
 * @returns {string}
 */
function dbDate(value) {
  if (!value) return 'NULL';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'NULL';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `#${yyyy}-${mm}-${dd} 00:00:00#`;
}

module.exports = { esc, q, n, dbDate };
