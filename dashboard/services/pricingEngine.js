'use strict';

/**
 * Pricing engine — the single source of truth for what a line SHOULD bill at.
 *
 * Reads the pricing master imported from the E&C shipment datasheet
 * (dashboard/data/pricing-master.json, produced by services/pricingImport.js)
 * and, for any item, returns:
 *   - ourCost     : landed cost from the workbook
 *   - marketMid   : full market-mid benchmark from the workbook
 *   - suggestedBill: the DEFAULT bill = max(cost, marketMid × 0.70)
 *
 * The 70%-of-market-mid rule (floored at cost so we never bill below what we
 * paid) is applied per unit — hose per metre, fitting per piece, crimping per
 * end — then multiplied out. The operator can always override the suggestion
 * before saving; this engine only decides the DEFAULT.
 *
 * Lookup keys:
 *   - fittings / unions / ferrules / flanges → SpecCode        (Unit Prices sheet)
 *   - hose                                   → "GRADE SIZE"    (Cost vs Market sheet)
 *   - crimping                               → hose size       (Crimping Charges sheet)
 *
 * The pure helpers (normalisation, suggestUnit, priceStatus) carry no I/O and
 * are unit-tested directly.
 */

const fs = require('fs');
const path = require('path');
const money = require('../lib/money');

// Bill at 70% of the market mid by default. Floored at cost.
const MARKET_FACTOR = 0.70;

const DEFAULT_MASTER_PATH = path.join(__dirname, '..', 'data', 'pricing-master.json');

// Line pricing status (richer than the legacy price flag — drives the reports).
const STATUS = {
  BELOW_COST: 'below-cost',       // billed under our landed cost — we lose money
  AT_COST_FLOOR: 'at-cost-floor', // 70%×mid fell below cost, so we bill at the cost floor
  BELOW_70: 'below-70-market',    // billed under the 70% market floor (leaving money on the table)
  HEALTHY: 'healthy',             // between the 70% floor and full market mid
  AT_ABOVE_MARKET: 'at-above-market', // at/over the market mid (pricey vs the market)
  NO_MARKET: 'no-market',         // no market benchmark to judge against
};

const STATUS_LABEL = {
  'below-cost': 'Below Cost',
  'at-cost-floor': 'At Cost Floor',
  'below-70-market': 'Below 70% Market',
  healthy: 'Healthy Margin',
  'at-above-market': 'At/Above Market',
  'no-market': 'No Market Ref',
};

// ---------------------------------------------------------------------------
// Normalisation helpers (pure) — system descriptions and workbook labels differ.
// ---------------------------------------------------------------------------

// Normalise an inch size to a bare fraction key: '1/2"' -> '1/2', '1-1/4"' -> '1-1/4', '1"' -> '1'.
function normSize(size) {
  return String(size == null ? '' : size)
    .replace(/["″”'’]/g, '')  // drop inch marks / stray quotes
    .replace(/\s+/g, '')
    .trim();
}

// Normalise a fitting spec code for matching: upper-case, trimmed. '22611-04-04' stays as is.
function normSpecCode(code) {
  return String(code == null ? '' : code).trim().toUpperCase();
}

// Build the hose lookup key from a grade + size, e.g. ('R2', '1/2"') -> 'R2 1/2'.
function hoseKey(grade, size) {
  const g = String(grade == null ? '' : grade).trim().toUpperCase();
  const s = normSize(size);
  return g && s ? `${g} ${s}` : '';
}

// Parse a hose grade + size out of a free-text description / product name.
// Handles 'R2 hydraulic hose 5/8"', 'Rubber pipe R2 Fabric coverd hydraulic hose - 13',
// 'EN856 4SH hydraulic hose, ID 25mm', '4SP hydraulic hose 5/8" (ID 16mm)'.
// Returns { grade, size } (size normalised) or null when no grade is found.
function parseHose(description, sizeHint) {
  const d = String(description == null ? '' : description);
  const gradeM = d.match(/\b(4SH|4SP|R2|R1|1SN|2SN)\b/i);
  if (!gradeM) return null;
  let grade = gradeM[1].toUpperCase();
  // 2SN/1SN are ferrule grades that share the hose family — map to R2/R1 hose.
  if (grade === '2SN') grade = 'R2';
  if (grade === '1SN') grade = 'R1';

  let size = normSize(sizeHint);
  if (!size) {
    // Prefer an explicit inch fraction in the text ('5/8"', '1-1/4"', '1"').
    const inchM = d.match(/(\d+(?:-\d+\/\d+|\/\d+)?)\s*(?:"|″|inch|in\b)/i);
    if (inchM) size = normSize(inchM[1]);
  }
  if (!size) {
    // Fall back to an ID in mm ('ID 13mm' / '- 13') mapped to the inch size.
    const mmM = d.match(/(?:ID\s*)?(\d{1,2})\s*mm/i) || d.match(/-\s*(\d{1,2})\b/);
    if (mmM) size = MM_TO_INCH[mmM[1]] || '';
  }
  return { grade, size };
}

// Hose ID (mm) -> inch size key, matching the shipment datasheet rows.
const MM_TO_INCH = {
  '6': '1/4', '8': '5/16', '10': '3/8', '12': '1/2', '13': '1/2',
  '16': '5/8', '19': '3/4', '20': '3/4', '25': '1', '32': '1-1/4',
  '38': '1-1/2', '51': '2',
};

// ---------------------------------------------------------------------------
// The 70%-floored suggestion + line status (pure).
// ---------------------------------------------------------------------------

/**
 * Suggested unit bill = max(cost, marketMid × 0.70).
 * @returns {{ suggested:number, floored:boolean }} floored=true when the cost
 *          floor kicked in (i.e. 70%×mid was below cost).
 */
function suggestUnit(costUnit, marketUnit) {
  const cost = money.num(costUnit);
  const market = money.num(marketUnit);
  const seventy = money.round2(market * MARKET_FACTOR);
  if (market <= 0) {
    // No market reference: fall back to cost (never below cost).
    return { suggested: money.round2(Math.max(cost, 0)), floored: cost > 0 };
  }
  if (seventy < cost) return { suggested: money.round2(cost), floored: true };
  return { suggested: seventy, floored: false };
}

/**
 * Classify a billed unit rate against cost + market mid.
 * @returns {string} one of STATUS.*
 */
function priceStatus({ cost, rate, marketMid }) {
  const c = money.num(cost);
  const r = money.num(rate);
  const m = money.num(marketMid);
  if (c > 0 && r < c) return STATUS.BELOW_COST;
  if (m <= 0) return STATUS.NO_MARKET;
  const floor70 = m * MARKET_FACTOR;
  if (r >= m) return STATUS.AT_ABOVE_MARKET;
  // Below the market mid:
  if (floor70 < c) {
    // The 70% floor is under cost, so billing at/above cost IS the floored case.
    return STATUS.AT_COST_FLOOR;
  }
  if (r < floor70) return STATUS.BELOW_70; // undercharging vs the 70% floor
  return STATUS.HEALTHY;                    // between 70% floor and market mid
}

// ---------------------------------------------------------------------------
// Master data access.
// ---------------------------------------------------------------------------

let _cache = null;
let _cachePath = null;

function loadMaster(masterPath = DEFAULT_MASTER_PATH) {
  if (_cache && _cachePath === masterPath) return _cache;
  try {
    const raw = fs.readFileSync(masterPath, 'utf8');
    _cache = JSON.parse(raw);
  } catch (_) {
    _cache = { meta: { missing: true }, hose: {}, fittings: {}, crimping: {} };
  }
  _cachePath = masterPath;
  return _cache;
}

// Drop the cache so the next lookup re-reads the file (call after an import).
function clearCache() { _cache = null; _cachePath = null; }

// ---------------------------------------------------------------------------
// The lookups.
// ---------------------------------------------------------------------------

function lookupFitting(specCode, master = loadMaster()) {
  const key = normSpecCode(specCode);
  if (!key) return null;
  const f = master.fittings && master.fittings[key];
  if (!f) return null;
  return { costUnit: money.num(f.costLKR), marketUnit: money.num(f.sellLKR), source: 'unit-prices', meta: f };
}

function lookupHose({ grade, size, description }, master = loadMaster()) {
  let key = hoseKey(grade, size);
  if (!(master.hose && master.hose[key]) && description) {
    const parsed = parseHose(description, size);
    if (parsed) key = hoseKey(parsed.grade, parsed.size);
  }
  const h = master.hose && master.hose[key];
  if (!h) return null;
  return { costUnit: money.num(h.landedPerM), marketUnit: money.num(h.marketMidPerM), source: 'hose-cost-market', meta: h };
}

function lookupCrimping(size, master = loadMaster()) {
  const key = normSize(size);
  if (!key) return null;
  const c = master.crimping && master.crimping[key];
  if (!c) return null;
  return { costUnit: money.num(c.internalCostPerEnd), marketUnit: money.num(c.marketMid), source: 'crimping-charges', meta: c };
}

/**
 * Central pricing lookup. Returns unit + line figures and a source/warning.
 *
 * @param {object} p
 * @param {'fitting'|'hose'|'crimping'|string} [p.type]
 * @param {string} [p.specCode]   fitting spec code (Unit Prices key)
 * @param {string} [p.hoseGrade]  hose grade (R1/R2/4SP/4SH)
 * @param {string} [p.hoseSize]   hose / crimp size ('1/2"', '5/8"'...)
 * @param {string} [p.description] free text, used to infer hose grade/size
 * @param {number} [p.qty=1]      fitting piece count
 * @param {number} [p.length=0]   hose length (m)
 * @param {number} [p.ends=2]     crimp end count
 * @returns {{ourCost,marketMid,suggestedBill,costUnit,marketUnit,suggestedUnit,source,warning,status,floored}}
 */
function getPricingForItem(p = {}, master = loadMaster()) {
  const type = String(p.type || '').toLowerCase();
  let hit = null;
  let multiplier = 1;

  if (type === 'crimping' || (p.ends != null && !p.specCode && !p.hoseGrade && type !== 'hose' && type !== 'fitting')) {
    hit = lookupCrimping(p.hoseSize, master);
    multiplier = Math.max(1, money.num(p.ends) || 2);
  } else if (type === 'hose' || (!p.specCode && (p.hoseGrade || /\bhose\b/i.test(String(p.description || ''))))) {
    hit = lookupHose({ grade: p.hoseGrade, size: p.hoseSize, description: p.description }, master);
    multiplier = money.num(p.length) || 0;
  } else if (p.specCode) {
    hit = lookupFitting(p.specCode, master);
    multiplier = Math.max(1, money.num(p.qty) || 1);
  }

  // Last-ditch: try each lookup in turn so a mis-typed `type` still resolves.
  if (!hit && p.specCode) { hit = lookupFitting(p.specCode, master); multiplier = Math.max(1, money.num(p.qty) || 1); }
  if (!hit && (p.hoseGrade || p.description)) { hit = lookupHose({ grade: p.hoseGrade, size: p.hoseSize, description: p.description }, master); multiplier = money.num(p.length) || 0; }

  if (!hit) {
    return {
      ourCost: 0, marketMid: 0, suggestedBill: 0,
      costUnit: 0, marketUnit: 0, suggestedUnit: 0,
      source: 'manual', warning: 'No pricing-master match — enter the rate manually.',
      status: STATUS.NO_MARKET, floored: false,
    };
  }

  const { suggested, floored } = suggestUnit(hit.costUnit, hit.marketUnit);
  const mult = multiplier > 0 ? multiplier : 1;
  return {
    costUnit: money.round2(hit.costUnit),
    marketUnit: money.round2(hit.marketUnit),
    suggestedUnit: suggested,
    ourCost: money.round2(hit.costUnit * mult),
    marketMid: money.round2(hit.marketUnit * mult),
    suggestedBill: money.round2(suggested * mult),
    source: hit.source,
    warning: floored ? 'Below 70% market floor — using cost floor' : null,
    status: priceStatus({ cost: hit.costUnit, rate: suggested, marketMid: hit.marketUnit }),
    floored,
  };
}

// Convenience: per-unit suggestion for an already-known cost + market mid
// (used when the caller already has Inventory.Cost / Inventory.MarketMid).
function suggestFromCostMarket(costUnit, marketUnit) {
  const { suggested, floored } = suggestUnit(costUnit, marketUnit);
  return {
    costUnit: money.round2(money.num(costUnit)),
    marketUnit: money.round2(money.num(marketUnit)),
    suggestedUnit: suggested,
    floored,
    warning: floored ? 'Below 70% market floor — using cost floor' : null,
  };
}

module.exports = {
  MARKET_FACTOR, STATUS, STATUS_LABEL, DEFAULT_MASTER_PATH,
  normSize, normSpecCode, hoseKey, parseHose, MM_TO_INCH,
  suggestUnit, priceStatus, suggestFromCostMarket,
  loadMaster, clearCache,
  lookupFitting, lookupHose, lookupCrimping, getPricingForItem,
};
