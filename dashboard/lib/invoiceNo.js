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

// ---------------------------------------------------------------------------
// Revisions
//
// A corrected invoice keeps the number the customer already has and gains a
// revision suffix: INV/2026/09/003 -> INV/2026/09/003-R1 -> ...-R2. Two things
// make this safe:
//
//  - nextForPrefix matches `^prefix(\d+)$`, so a suffixed number is invisible to
//    the sequencer and a revision never consumes next month's numbering;
//  - the suffix is derived from the ORIGINAL number, so a revision of a revision
//    still reads -R2 rather than -R1-R1.
// ---------------------------------------------------------------------------

const REVISION_RE = /^(.*?)-R(\d+)$/;

/**
 * The number without its revision suffix.
 * @param {string} invoiceNo e.g. 'INV/2026/09/003-R2'
 * @returns {string} e.g. 'INV/2026/09/003'
 */
function baseNo(invoiceNo) {
  const m = REVISION_RE.exec(String(invoiceNo || ''));
  return m ? m[1] : String(invoiceNo || '');
}

/**
 * Which revision a number is. 0 for an original.
 * @param {string} invoiceNo
 * @returns {number}
 */
function revisionIndex(invoiceNo) {
  const m = REVISION_RE.exec(String(invoiceNo || ''));
  if (!m) return 0;
  const n = parseInt(m[2], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The number for revision `n` of an invoice, whatever the given number's own
 * revision is.
 *
 * @param {string} invoiceNo any number in the chain
 * @param {number} n the revision to build (1-based)
 * @returns {string}
 */
function revisionNo(invoiceNo, n) {
  const seq = Math.max(1, Math.floor(Number(n) || 1));
  return `${baseNo(invoiceNo)}-R${seq}`;
}

/**
 * The next free revision number for a chain, given every number already issued.
 *
 * Scans for the highest -R suffix on the same base rather than counting rows, so
 * a gap in the chain (or a number issued by hand) cannot cause a collision.
 *
 * @param {string} invoiceNo any number in the chain
 * @param {string[]} existingNos every InvoiceNo already in the database
 * @returns {string}
 */
function nextRevisionNo(invoiceNo, existingNos) {
  const base = baseNo(invoiceNo);
  let maxSeq = 0;
  for (const no of existingNos || []) {
    if (!no || baseNo(no) !== base) continue;
    const seq = revisionIndex(no);
    if (seq > maxSeq) maxSeq = seq;
  }
  return revisionNo(base, maxSeq + 1);
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  monthPrefix, nextForPrefix, nextInvoiceNo, escapeRegExp,
  baseNo, revisionIndex, revisionNo, nextRevisionNo,
};
