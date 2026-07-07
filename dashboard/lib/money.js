'use strict';

/**
 * Money & numeric helpers for the billing engine.
 *
 * All monetary values in this system are Sri Lankan Rupees (LKR) with two
 * decimal places. Floating point arithmetic is not safe for money, so every
 * amount that is stored or printed goes through {@link round2}, which rounds
 * half away from zero using the decimal string form of the number to avoid
 * binary representation artifacts (e.g. 1.005 -> 1.01, not 1.00).
 *
 * This module has zero dependencies so it can be unit-tested on any platform,
 * independent of the Windows-only MS Access data layer.
 */

/**
 * Coerce an arbitrary value to a finite number.
 * Returns `fallback` (default 0) when the value is null/blank/NaN/Infinity.
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Round a value to 2 decimal places, half away from zero.
 *
 * We build the scaled value from the number's decimal string
 * (e.g. "1.005e2") so that the rounding sees the value the user typed
 * rather than its nearest binary double, which is what makes the classic
 * 1.005 / 2.675 cases round correctly.
 *
 * @param {*} value
 * @returns {number} value rounded to 2 dp (0 when not finite)
 */
function round2(value) {
  const n = num(value, NaN);
  if (!Number.isFinite(n)) return 0;
  // A computed product such as 0.03 * 116.5 lands on 3.4949999999999997 — one
  // ULP below the exact 3.495 tie — and would round DOWN to 3.49. Re-rounding
  // to 15 significant digits first snaps that noise away (-> 3.495) so genuine
  // half-cent ties round up, while values that are truly below a tie are left
  // untouched (money magnitudes never need more than 15 sig digits at 2 dp).
  const snapped = Number(n.toPrecision(15));
  const base = Number.isFinite(snapped) ? snapped : n;
  const shifted = Number(`${base}e2`);
  if (!Number.isFinite(shifted)) return Math.round(base * 100) / 100;
  const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted));
  const result = Number(`${rounded}e-2`);
  // Normalise -0 to 0 so totals never print "Rs. -0.00".
  return Object.is(result, -0) ? 0 : result;
}

/**
 * Sum a list of amounts accurately (each rounded, then the total rounded).
 * @param {number[]} amounts
 * @returns {number}
 */
function sumMoney(amounts) {
  let total = 0;
  for (const a of amounts) total += round2(a);
  return round2(total);
}

/**
 * Clamp a number into [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  const n = num(value);
  return Math.min(Math.max(n, min), max);
}

/**
 * Format an amount as "Rs. 1,234.50" (LKR grouping, 2 dp).
 * @param {*} value
 * @returns {string}
 */
function formatLKR(value) {
  const n = round2(value);
  return 'Rs. ' + n.toLocaleString('en-LK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

module.exports = { num, round2, sumMoney, clamp, formatLKR };
