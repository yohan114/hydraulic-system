'use strict';

/**
 * Formula injection defense for CSV and Spreadsheet exports (T28).
 * Prepend single quote (') if string starts with =, +, -, or @.
 */

function sanitizeFormula(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (/^[=\+\-@]/.test(trimmed)) {
    return "'" + val;
  }
  return val;
}

function sanitizeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const clean = Array.isArray(row) ? [] : {};
  for (const [key, value] of Object.entries(row)) {
    clean[key] = typeof value === 'string' ? sanitizeFormula(value) : value;
  }
  return clean;
}

module.exports = {
  sanitizeFormula,
  sanitizeRow,
};
