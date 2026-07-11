'use strict';

/**
 * Invoice-number sequencing (pure logic, independent of the database).
 *
 * Numbers look like  INV/2026/07/001  — a fixed prefix, the 4-digit year, the
 * 2-digit month, then a zero-padded running sequence that resets every month.
 * The database layer supplies the list of numbers already issued for the target
 * month and this module returns the next one. Because the "read max + build
 * next" step is deterministic and side-effect free, the server can run it
 * inside a mutex to guarantee uniqueness even under concurrent requests.
 */

/**
 * Build the month prefix for a given date, e.g. "INV/2026/07/".
 * @param {Date|string} [date] defaults to now (caller passes a real Date)
 * @param {string} [base='INV'] leading token
 * @returns {string}
 */
function monthPrefix(date, base = 'INV') {
  const d = date instanceof Date ? date : new Date(date);
  const valid = !Number.isNaN(d.getTime());
  const now = valid ? d : new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${base}/${y}/${m}/`;
}

/**
 * Given the invoice numbers already present for a month, return the next one.
 *
 * @param {string[]} existingNos all InvoiceNo strings (any month; filtered here)
 * @param {string} prefix the month prefix from {@link monthPrefix}
 * @param {number} [pad=3] sequence zero-padding width
 * @returns {string} next invoice number, e.g. "INV/2026/07/004"
 */
function nextForPrefix(existingNos, prefix, pad = 3) {
  const re = new RegExp('^' + escapeRegExp(prefix) + '(\\d+)$');
  let maxSeq = 0;
  for (const no of existingNos || []) {
    if (!no) continue;
    const match = String(no).match(re);
    if (match) {
      const seq = parseInt(match[1], 10);
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    }
  }
  const width = Math.max(pad, String(maxSeq + 1).length);
  return `${prefix}${String(maxSeq + 1).padStart(width, '0')}`;
}

/**
 * Convenience: next number for a date, given every existing InvoiceNo.
 * @param {string[]} existingNos
 * @param {Date|string} [date]
 * @param {string} [base='INV']
 * @returns {string}
 */
function nextInvoiceNo(existingNos, date, base = 'INV') {
  const prefix = monthPrefix(date, base);
  return nextForPrefix(existingNos, prefix);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { monthPrefix, nextForPrefix, nextInvoiceNo, escapeRegExp };
