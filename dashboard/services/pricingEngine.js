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

// Bill at 80% of the market mid by default (≈20% below market). Floored at cost.
const MARKET_FACTOR = 0.80;
// Ferrules get stronger margin protection: the floor is cost × 1.25, not cost.
const FERRULE_COST_MULTIPLIER = 1.25;

const DEFAULT_MASTER_PATH = path.join(__dirname, '..', 'data', 'pricing-master.json');
const DEFAULT_BENCHMARK_PATH = path.join(__dirname, '..', 'data', 'outside-benchmark.json');
const DEFAULT_CRIMPING_PATH = path.join(__dirname, '..', 'data', 'crimping-rates.json');

// Where a line's MARKET price came from, in priority order (Task 4).
const MARKET_SOURCE = {
  OUTSIDE: 'outside-benchmark', // competitor counter price list (photos) — highest priority
  DATASHEET: 'datasheet-mid',   // shipment datasheet Market Mid / Sell LKR
  MANUAL: 'manual',             // admin fallback / no benchmark
};

// Which pricing rule set the default bill for a line.
const RULE = {
  MARKET_MINUS_20: 'marketMinus20', // default: market mid × 0.80 (above the floor)
  COST_FLOOR: 'costFloor',          // 80% mid fell below cost — billed at cost
  FERRULE_FLOOR: 'ferruleFloor',    // ferrule: billed at cost × 1.25 (stronger floor)
  MANUAL: 'manual',                 // no market benchmark / no mapping
};

const RULE_LABEL = {
  marketMinus20: 'Market −20%',
  costFloor: 'Cost Floor',
  ferruleFloor: 'Ferrule Floor',
  manual: 'Manual',
};

// Line pricing status (richer than the legacy price flag — drives the reports).
const STATUS = {
  BELOW_COST: 'below-cost',       // billed under our landed cost — we lose money
  AT_COST_FLOOR: 'at-cost-floor', // 80%×mid fell below cost, so we bill at the cost floor
  BELOW_FLOOR: 'below-market-floor', // billed under the 80% market floor (leaving money on the table)
  HEALTHY: 'healthy',             // between the 80% floor and full market mid
  AT_ABOVE_MARKET: 'at-above-market', // at/over the market mid (pricey vs the market)
  NO_MARKET: 'no-market',         // no market benchmark to judge against
};

const STATUS_LABEL = {
  'below-cost': 'Below Cost',
  'at-cost-floor': 'At Cost Floor',
  'below-market-floor': 'Below 80% Market',
  healthy: 'Healthy Margin',
  'at-above-market': 'At/Above Market',
  'no-market': 'No Market Ref',
};

// A ferrule (sleeve) — spec codes in the datasheet ferrule groups start with 00
// (00110 = 1SN, 00210 = 2SN, 00400 = spiral). Ferrules get the stronger floor.
function isFerrule(specCodeOrType) {
  const s = String(specCodeOrType == null ? '' : specCodeOrType).trim().toUpperCase();
  return /^00\d/.test(s) || ['1SN', '2SN', 'SPIRAL'].includes(s);
}

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
 * Suggested unit bill:
 *   default  = max(cost,        marketMid × 0.80)
 *   ferrule  = max(cost × 1.25, marketMid × 0.80)   (stronger margin protection)
 * We price ~20% under market but never below the applicable floor.
 *
 * @param {number} costUnit
 * @param {number} marketUnit
 * @param {{ferrule?:boolean}} [opts]
 * @returns {{ suggested:number, floored:boolean, rule:string }}
 *          rule ∈ marketMinus20 | costFloor | ferruleFloor | manual
 */
function suggestUnit(costUnit, marketUnit, opts = {}) {
  const cost = money.num(costUnit);
  const market = money.num(marketUnit);
  const ferrule = !!opts.ferrule;
  const floor = ferrule ? money.round2(cost * FERRULE_COST_MULTIPLIER) : money.round2(cost);
  const floorRule = ferrule ? RULE.FERRULE_FLOOR : RULE.COST_FLOOR;
  const marketTerm = money.round2(market * MARKET_FACTOR);

  if (market <= 0) {
    // No market reference: fall back to the floor (cost, or cost×1.25 for ferrules).
    return { suggested: money.round2(Math.max(floor, 0)), floored: cost > 0, rule: cost > 0 ? floorRule : RULE.MANUAL };
  }
  if (marketTerm < floor) return { suggested: floor, floored: true, rule: floorRule };
  return { suggested: marketTerm, floored: false, rule: RULE.MARKET_MINUS_20 };
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
  const floor80 = m * MARKET_FACTOR;
  if (r >= m) return STATUS.AT_ABOVE_MARKET;
  // Below the market mid:
  if (floor80 < c) {
    // The 80% floor is under cost, so billing at/above cost IS the floored case.
    return STATUS.AT_COST_FLOOR;
  }
  if (r < floor80) return STATUS.BELOW_FLOOR; // undercharging vs the 80% floor
  return STATUS.HEALTHY;                       // between 80% floor and market mid
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
function clearCache() { _cache = null; _cachePath = null; _benchCache = null; _crimpCache = null; }

// ---------------------------------------------------------------------------
// Crimping — wire-type (2-wire vs 4-wire) shop rates. Self-contained: this
// section drives ONLY crimping charges and does not touch hose / fitting pricing.
// ---------------------------------------------------------------------------

let _crimpCache = null;
function loadCrimpingRates(crimpPath = DEFAULT_CRIMPING_PATH) {
  if (_crimpCache) return _crimpCache;
  try { _crimpCache = JSON.parse(fs.readFileSync(crimpPath, 'utf8')); }
  catch (_) { _crimpCache = { sizes: [], internalCostPerEnd: {}, market2Wire: {}, market4Wire: {} }; }
  return _crimpCache;
}

// Map a hose grade / ferrule type (or a literal "4-wire"/"2-wire") to its
// crimping wire-type group.
//   R2 / 2SN / 1SN / R1 → 2-wire   ·   4SP / 4SH / spiral → 4-wire
function wireTypeOf(gradeOrType) {
  const s = String(gradeOrType == null ? '' : gradeOrType).toUpperCase();
  if (/4-?WIRE|4SP|4SH|SPIRAL/.test(s)) return '4-wire';
  return '2-wire';
}

/**
 * Crimping price for one line, by hose size + wire type + ends.
 * Internal cost/end is common; the market/end depends on the wire type.
 * Default billed/end = market/end (floor = internal cost/end).
 *
 * @param {{hoseSize:string, hoseWireType?:string, ends?:number, billedPerEnd?:number}} p
 * @returns {{size,hoseWireType,ends,internalCostPerEnd,marketPerEnd,billedPerEnd,
 *            internalCostTotal,marketTotal,billedTotal,warning}}
 */
function getCrimpingPricing(p = {}) {
  const data = loadCrimpingRates();
  const size = normSize(p.hoseSize);
  const wire = wireTypeOf(p.hoseWireType);
  const ends = Math.max(1, money.num(p.ends) || 2);

  const internalCostPerEnd = money.round2(money.num(data.internalCostPerEnd[size]));
  const table = wire === '4-wire' ? data.market4Wire : data.market2Wire;
  let warning = null;
  let marketPerEnd = table[size] != null ? money.round2(table[size]) : 0;
  if (table[size] == null) {
    warning = `No ${wire} shop rate for ${size}" — set the rate manually.`;
  }
  // Default billed = market/end; an explicit override wins.
  let billedPerEnd = p.billedPerEnd != null ? money.round2(money.num(p.billedPerEnd)) : marketPerEnd;
  if (billedPerEnd > 0 && internalCostPerEnd > 0 && billedPerEnd < internalCostPerEnd) {
    warning = `Billed rate ${billedPerEnd}/end is below internal cost ${internalCostPerEnd}/end.`;
  }
  return {
    size, hoseWireType: wire, ends,
    internalCostPerEnd, marketPerEnd, billedPerEnd,
    internalCostTotal: money.round2(internalCostPerEnd * ends),
    marketTotal: money.round2(marketPerEnd * ends),
    billedTotal: money.round2(billedPerEnd * ends),
    warning,
  };
}

// ---------------------------------------------------------------------------
// Outside-company benchmark (competitor price list) — the PRIORITY-1 market src.
// ---------------------------------------------------------------------------

let _benchCache = null;
function loadBenchmark(benchPath = DEFAULT_BENCHMARK_PATH) {
  if (_benchCache) return _benchCache;
  try { _benchCache = JSON.parse(fs.readFileSync(benchPath, 'utf8')); }
  catch (_) { _benchCache = { meta: { missing: true }, hose: {}, fittings: {} }; }
  return _benchCache;
}

/**
 * Resolve the outside-company market price for an item, if the list has an exact
 * match. Fittings match by spec code; hose by grade + size (or parsed from the
 * description). Returns { price, source } or null when there is no match.
 */
function outsideMarketForItem({ specCode, description, hoseGrade, hoseSize } = {}, bench = loadBenchmark()) {
  const code = normSpecCode(specCode);
  if (code && bench.fittings && bench.fittings[code] != null) {
    return { price: money.num(bench.fittings[code]), source: MARKET_SOURCE.OUTSIDE };
  }
  let grade = hoseGrade, size = hoseSize;
  if ((!grade || !size) && description) {
    const p = parseHose(description, hoseSize);
    if (p) { grade = grade || p.grade; size = size || p.size; }
  }
  const hk = hoseKey(grade, size);
  if (hk && bench.hose && bench.hose[hk] != null) {
    return { price: money.num(bench.hose[hk].marketPerM), source: MARKET_SOURCE.OUTSIDE };
  }
  return null;
}

/**
 * Resolve the MARKET price by priority (Task 4): outside benchmark → datasheet
 * (the caller's fallback) → manual. Returns { marketPrice, marketSource }.
 */
function resolveMarket({ specCode, description, hoseGrade, hoseSize, fallbackMarket } = {}) {
  const outside = outsideMarketForItem({ specCode, description, hoseGrade, hoseSize });
  if (outside && outside.price > 0) return { marketPrice: outside.price, marketSource: MARKET_SOURCE.OUTSIDE };
  const fb = money.num(fallbackMarket);
  if (fb > 0) return { marketPrice: money.round2(fb), marketSource: MARKET_SOURCE.DATASHEET };
  return { marketPrice: 0, marketSource: MARKET_SOURCE.MANUAL };
}

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
      source: 'manual', warning: ruleWarning(RULE.MANUAL),
      status: STATUS.NO_MARKET, rule: RULE.MANUAL, floored: false,
    };
  }

  const ferrule = hit.source === 'unit-prices' && isFerrule((hit.meta && (hit.meta.specCode || hit.meta.type)) || '');
  // Priority-1 market: an exact outside-company benchmark overrides the datasheet
  // mid for fittings + hose (crimping keeps its per-end datasheet market).
  let marketUnit = money.num(hit.marketUnit);
  let marketSource = marketUnit > 0 ? MARKET_SOURCE.DATASHEET : MARKET_SOURCE.MANUAL;
  if (hit.source !== 'crimping-charges') {
    const outside = outsideMarketForItem({ specCode: p.specCode, description: p.description, hoseGrade: p.hoseGrade, hoseSize: p.hoseSize });
    if (outside && outside.price > 0) { marketUnit = outside.price; marketSource = MARKET_SOURCE.OUTSIDE; }
  }
  const { suggested, floored, rule } = suggestUnit(hit.costUnit, marketUnit, { ferrule });
  const mult = multiplier > 0 ? multiplier : 1;
  return {
    costUnit: money.round2(hit.costUnit),
    marketUnit: money.round2(marketUnit),
    suggestedUnit: suggested,
    ourCost: money.round2(hit.costUnit * mult),
    marketMid: money.round2(marketUnit * mult),
    suggestedBill: money.round2(suggested * mult),
    source: hit.source,
    marketSource,
    warning: ruleWarning(rule),
    status: priceStatus({ cost: hit.costUnit, rate: suggested, marketMid: marketUnit }),
    rule,
    floored,
  };
}

// Rule-specific badge/warning text.
function ruleWarning(rule) {
  if (rule === RULE.COST_FLOOR) return '80% market below cost — cost floor applied';
  if (rule === RULE.FERRULE_FLOOR) return 'Ferrule floor — cost × 1.25 applied';
  if (rule === RULE.MANUAL) return 'No market benchmark';
  return null;
}

// Convenience: per-unit suggestion for an already-known cost + market mid
// (used when the caller already has Inventory.Cost / Inventory.MarketMid). Pass
// { ferrule:true } (or a spec code via ferrule detection at the call site) to
// apply the stronger ferrule floor.
function suggestFromCostMarket(costUnit, marketUnit, opts = {}) {
  const { suggested, floored, rule } = suggestUnit(costUnit, marketUnit, opts);
  return {
    costUnit: money.round2(money.num(costUnit)),
    marketUnit: money.round2(money.num(marketUnit)),
    suggestedUnit: suggested,
    floored,
    rule,
    warning: ruleWarning(rule),
  };
}

module.exports = {
  MARKET_FACTOR, FERRULE_COST_MULTIPLIER, STATUS, STATUS_LABEL, RULE, RULE_LABEL,
  MARKET_SOURCE, DEFAULT_MASTER_PATH, DEFAULT_BENCHMARK_PATH, DEFAULT_CRIMPING_PATH,
  normSize, normSpecCode, hoseKey, parseHose, MM_TO_INCH, isFerrule,
  suggestUnit, priceStatus, suggestFromCostMarket, ruleWarning,
  loadMaster, clearCache, loadBenchmark, outsideMarketForItem, resolveMarket,
  loadCrimpingRates, wireTypeOf, getCrimpingPricing,
  lookupFitting, lookupHose, lookupCrimping, getPricingForItem,
};
