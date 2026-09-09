'use strict';

/**
 * Pricing master import — turns the E&C shipment datasheet workbook into the
 * structured pricing lookup the billing system prices from.
 *
 *   Workbook: data/EC_Shipment_HS25E1112W1_Datasheet.xlsx
 *     - "Cost vs Market"     → hose   (landed cost + market mid, per metre)
 *     - "Unit Prices (bill)" → fittings (cost + sell, per piece, keyed by SpecCode)
 *     - "Crimping Charges"   → crimping (internal cost + market, per END, by size)
 *
 *   Output:  data/pricing-master.json   (committed; the engine reads it)
 *
 * Run standalone to (re)generate the JSON:   node services/pricingImport.js
 * or upload a fresh workbook through the Pricing Master admin screen.
 */

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const money = require('../lib/money');
const { normSize, normSpecCode, hoseKey } = require('./pricingEngine');

const DEFAULT_WORKBOOK_PATH = path.join(__dirname, '..', 'data', 'EC_Shipment_HS25E1112W1_Datasheet.xlsx');
const DEFAULT_MASTER_PATH = path.join(__dirname, '..', 'data', 'pricing-master.json');

function sheetRows(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
}

function num(v) { return typeof v === 'number' && isFinite(v) ? v : (v == null || v === '' ? null : Number(v)); }
function isNum(v) { const n = num(v); return typeof n === 'number' && isFinite(n); }

// --- HOSE: "Cost vs Market", section A. Rows look like ["R2 1/2"", metres, mktMid, costUSD, costCIF, landed, marketMid, markup]
function parseHose(wb) {
  const rows = sheetRows(wb, 'Cost vs Market');
  const out = [];
  for (const r of rows) {
    const label = r[0];
    if (typeof label !== 'string') continue;
    if (!/^(R1|R2|4SP|4SH)\s+\S/.test(label.trim())) continue; // hose rows only (skip totals/headers)
    const landed = num(r[5]);
    const marketMid = num(r[6]);
    if (!isNum(landed) || !isNum(marketMid)) continue;
    const sp = label.trim().split(/\s+/);
    const grade = sp.shift().toUpperCase();
    const size = normSize(sp.join(' '));
    out.push({
      key: hoseKey(grade, size),
      grade, size,
      landedPerM: money.round2(landed),
      marketMidPerM: money.round2(marketMid),
    });
  }
  return out;
}

// --- FITTINGS: "Unit Prices (bill)". Data rows: [No, Type, Code, Size, Desc, Qty, Weight, CostUSD, CostLKR, SellLKR, Margin, Recv]
function parseFittings(wb) {
  const rows = sheetRows(wb, 'Unit Prices (bill)');
  const out = [];
  for (const r of rows) {
    if (!isNum(r[0])) continue;                 // skip section headers / subtotals (No is blank there)
    const code = r[2];
    if (typeof code !== 'string' || !code.trim()) continue;
    const costLKR = num(r[8]);
    const sellLKR = num(r[9]);
    if (!isNum(costLKR) || !isNum(sellLKR)) continue;
    out.push({
      specCode: normSpecCode(code),
      no: num(r[0]),
      type: r[1] != null ? String(r[1]) : '',
      size: r[3] != null ? String(r[3]) : '',
      description: r[4] != null ? String(r[4]) : '',
      costLKR: money.round2(costLKR),
      sellLKR: money.round2(sellLKR),
      received: String(r[11] || '').toUpperCase() !== 'NO',
    });
  }
  return out;
}

// --- CRIMPING: "Crimping Charges", section B. Data rows: [Size, timeMin, labour, amort, consum, INTERNAL, mktLow, mktMid, mktHigh, marginMid, margin%]
function parseCrimping(wb) {
  const rows = sheetRows(wb, 'Crimping Charges');
  const out = [];
  for (const r of rows) {
    const label = r[0];
    if (typeof label !== 'string') continue;
    if (!/["″]\s*$/.test(label.trim())) continue; // size rows end with an inch mark
    const internal = num(r[5]);
    const mid = num(r[7]);
    if (!isNum(internal) || !isNum(mid)) continue;
    out.push({
      size: normSize(label),
      internalCostPerEnd: money.round2(internal),
      marketLow: money.round2(num(r[6]) || 0),
      marketMid: money.round2(mid),
      marketHigh: money.round2(num(r[8]) || 0),
      marginPerEndAtMid: money.round2(num(r[9]) || 0),
    });
  }
  return out;
}

// --- Meta from the "Summary" sheet (exchange rate, duty factor, invoice no).
function parseMeta(wb) {
  const rows = sheetRows(wb, 'Summary');
  let exchangeRate = null, dutyFactor = null, invoice = null;
  for (const r of rows) {
    const label = String(r[0] || '').toLowerCase();
    if (label.includes('exchange rate') && isNum(r[1])) exchangeRate = num(r[1]);
    if (label.includes('duty factor') && isNum(r[1])) dutyFactor = num(r[1]);
    if (typeof r[1] === 'string' && /Invoice\s+(\S+)/i.test(r[1]) && !invoice) {
      const m = r[1].match(/Invoice\s+(\S+)/i); if (m) invoice = m[1];
    }
  }
  return { exchangeRate, dutyFactor, invoice };
}

/** Parse a workbook (path or already-read xlsx object) into structured arrays. */
function parseWorkbook(input) {
  const wb = typeof input === 'string' ? xlsx.readFile(input)
    : (input && input.SheetNames ? input : xlsx.read(input, { type: 'buffer' }));
  return {
    meta: parseMeta(wb),
    hose: parseHose(wb),
    fittings: parseFittings(wb),
    crimping: parseCrimping(wb),
  };
}

/** Turn parsed arrays into the keyed master the engine reads. */
function buildMaster(parsed, importedAt) {
  const master = {
    meta: {
      source: 'EC_Shipment_HS25E1112W1_Datasheet.xlsx',
      invoice: parsed.meta.invoice || 'HS25E1112W1',
      exchangeRate: parsed.meta.exchangeRate,
      dutyFactor: parsed.meta.dutyFactor,
      marketFactor: 0.80,
      importedAt: importedAt || null,
      counts: { hose: parsed.hose.length, fittings: parsed.fittings.length, crimping: parsed.crimping.length },
    },
    hose: {},
    fittings: {},
    crimping: {},
  };
  for (const h of parsed.hose) master.hose[h.key] = h;
  for (const f of parsed.fittings) master.fittings[f.specCode] = f;
  for (const c of parsed.crimping) master.crimping[c.size] = c;
  return master;
}

function readMaster(masterPath = DEFAULT_MASTER_PATH) {
  try { return JSON.parse(fs.readFileSync(masterPath, 'utf8')); }
  catch (_) { return null; }
}

function writeMaster(master, masterPath = DEFAULT_MASTER_PATH) {
  fs.writeFileSync(masterPath, JSON.stringify(master, null, 2) + '\n', 'utf8');
  return masterPath;
}

/** Parse + build + write in one go. Returns { master, path }. */
function importWorkbook({ workbookPath = DEFAULT_WORKBOOK_PATH, buffer, masterPath = DEFAULT_MASTER_PATH, importedAt } = {}) {
  const parsed = parseWorkbook(buffer || workbookPath);
  const master = buildMaster(parsed, importedAt || null);
  writeMaster(master, masterPath);
  return { master, path: masterPath };
}

module.exports = {
  DEFAULT_WORKBOOK_PATH, DEFAULT_MASTER_PATH,
  parseWorkbook, buildMaster, readMaster, writeMaster, importWorkbook,
};

// Standalone: regenerate the committed master JSON from the bundled workbook.
if (require.main === module) {
  const stamp = process.env.IMPORT_STAMP || null; // pass a fixed timestamp for reproducible commits
  const { master, path: p } = importWorkbook({ importedAt: stamp });
  console.log(`Wrote ${p}`);
  console.log(`  hose:     ${master.meta.counts.hose}`);
  console.log(`  fittings: ${master.meta.counts.fittings}`);
  console.log(`  crimping: ${master.meta.counts.crimping}`);
}
