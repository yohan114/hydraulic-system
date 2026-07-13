'use strict';

/**
 * Pricing Master — admin import + lookups.
 *
 *   GET  /api/pricing/status    → meta (source, imported date, counts) + inventory match stats
 *   GET  /api/pricing/preview   → the full pricing preview table (cost / mid / 70% / margin)
 *   GET  /api/pricing/crimping  → crimping options (per end: cost / mid / suggested)
 *   GET  /api/pricing/suggest   → suggested price for ad-hoc params
 *   POST /api/pricing/import    → (admin) regenerate the master from the workbook and
 *                                 sync matched Inventory Cost/MarketMid from it
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const { requireRole } = require('./auth');
const engine = require('../services/pricingEngine');
const importer = require('../services/pricingImport');

const router = express.Router();
const adminOnly = requireRole('admin');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}
const upload = multer({ dest: UPLOAD_DIR });

// Margin at the suggested (70%) price = (suggested − cost) / suggested.
function marginPct(cost, suggested) {
  return suggested > 0 ? money.round2(((suggested - cost) / suggested) * 100) : 0;
}

// Flatten the master into preview rows across all three sources.
function previewRows(master) {
  const rows = [];
  for (const [code, f] of Object.entries(master.fittings || {})) {
    const ferrule = engine.isFerrule(code) || engine.isFerrule(f.type);
    const mk = engine.resolveMarket({ specCode: code, fallbackMarket: f.sellLKR });
    const s = engine.suggestUnit(f.costLKR, mk.marketPrice, { ferrule });
    rows.push({
      group: 'Fitting', key: code, label: `${f.type || ''} ${code}`.trim(), size: f.size || '',
      unit: 'pc', ourCost: money.round2(f.costLKR), marketMid: mk.marketPrice, marketSource: mk.marketSource,
      suggested: s.suggested, marginPct: marginPct(f.costLKR, s.suggested), floored: s.floored, rule: s.rule, source: 'unit-prices',
    });
  }
  for (const [key, h] of Object.entries(master.hose || {})) {
    const mk = engine.resolveMarket({ hoseGrade: h.grade, hoseSize: h.size, fallbackMarket: h.marketMidPerM });
    const s = engine.suggestUnit(h.landedPerM, mk.marketPrice);
    rows.push({
      group: 'Hose', key, label: `${h.grade} ${h.size}"`, size: h.size,
      unit: 'm', ourCost: money.round2(h.landedPerM), marketMid: mk.marketPrice, marketSource: mk.marketSource,
      suggested: s.suggested, marginPct: marginPct(h.landedPerM, s.suggested), floored: s.floored, rule: s.rule, source: 'hose-cost-market',
    });
  }
  // Crimping — one row per wire type (2-wire / 4-wire). Billed defaults to the
  // shop market/end (not the 80% rule); margin = (market − internal cost) / market.
  const crimp = engine.loadCrimpingRates();
  const crimpSizes = (crimp.sizes && crimp.sizes.length) ? crimp.sizes : Object.keys(crimp.internalCostPerEnd || {});
  for (const size of crimpSizes) {
    const cost = money.round2(money.num(crimp.internalCostPerEnd[size]));
    for (const [wire, table] of [['2-wire', crimp.market2Wire], ['4-wire', crimp.market4Wire]]) {
      if (!table || table[size] == null) continue;
      const market = money.round2(table[size]);
      rows.push({
        group: 'Crimping', key: `${size}-${wire}`, label: `Crimp ${size}" (${wire}, per end)`, size,
        unit: 'end', ourCost: cost, marketMid: market, marketSource: `${wire}-shop`,
        suggested: market, marginPct: marginPct(cost, market), floored: false, rule: 'crimp-market', source: 'crimping-charges',
      });
    }
  }
  return rows;
}

// Match every Inventory row against the master; optionally write back Cost/MarketMid.
async function reconcileInventory(master, { write } = {}) {
  const inv = await connection.query('SELECT InventoryID, ProductName, SpecificationCode, Size, Unit, Cost, MarketMid FROM Inventory');
  const matched = [];
  const unmatched = [];
  let outsideMatched = 0;
  for (const r of inv) {
    const grade = String(r.ProductName || '').trim().split(/\s+/)[0];
    if (engine.outsideMarketForItem({ specCode: r.SpecificationCode, hoseGrade: grade, hoseSize: r.Size, description: r.ProductName })) outsideMatched++;
    let hit = engine.lookupFitting(r.SpecificationCode, master);
    if (!hit) hit = engine.lookupHose({ grade, size: r.Size, description: r.ProductName }, master);
    if (!hit) { unmatched.push({ id: r.InventoryID, name: r.ProductName, spec: r.SpecificationCode }); continue; }
    matched.push({ id: r.InventoryID, cost: money.round2(hit.costUnit), market: money.round2(hit.marketUnit), source: hit.source });
    if (write) {
      await connection.execute(
        `UPDATE Inventory SET Cost = ${money.round2(hit.costUnit)}, MarketMid = ${money.round2(hit.marketUnit)}, UpdatedAt = Now() WHERE InventoryID = ${sql.n(r.InventoryID)}`
      );
    }
  }
  return { matched, unmatched, total: inv.length, outsideMatched };
}

router.get('/api/pricing/status', async (req, res) => {
  try {
    const master = importer.readMaster() || { meta: { missing: true }, hose: {}, fittings: {}, crimping: {} };
    const recon = await reconcileInventory(master, { write: false });
    res.json({
      meta: master.meta || {},
      counts: (master.meta && master.meta.counts) || {
        hose: Object.keys(master.hose || {}).length,
        fittings: Object.keys(master.fittings || {}).length,
        crimping: Object.keys(master.crimping || {}).length,
      },
      inventory: { total: recon.total, matched: recon.matched.length, unmatched: recon.unmatched.length, unmatchedItems: recon.unmatched.slice(0, 50), outsideMatched: recon.outsideMatched },
      benchmark: (() => { const b = engine.loadBenchmark(); return { source: (b.meta && b.meta.source) || null, hose: Object.keys(b.hose || {}).length, fittings: Object.keys(b.fittings || {}).length }; })(),
      marketFactor: engine.MARKET_FACTOR,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/pricing/preview', async (req, res) => {
  try {
    const master = importer.readMaster();
    if (!master) return res.json({ rows: [] });
    res.json({ rows: previewRows(master), marketFactor: engine.MARKET_FACTOR });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crimping options for the invoice picker — per END cost / mid / suggested.
// Crimping options — WIRE-TYPE aware (2-wire vs 4-wire shop rates). Each size
// carries its common internal cost/end plus the per-end market for each wire
// type (market4Wire is null where the workbook does not define it). The UI can
// switch wire type client-side without re-fetching.
router.get('/api/pricing/crimping', async (req, res) => {
  try {
    const data = engine.loadCrimpingRates();
    const sizes = data.sizes && data.sizes.length ? data.sizes : Object.keys(data.internalCostPerEnd || {});
    const list = sizes.map((size) => ({
      size,
      internalCostPerEnd: money.round2(money.num(data.internalCostPerEnd[size])),
      market2Wire: data.market2Wire && data.market2Wire[size] != null ? money.round2(data.market2Wire[size]) : null,
      market4Wire: data.market4Wire && data.market4Wire[size] != null ? money.round2(data.market4Wire[size]) : null,
    }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ad-hoc suggestion for a set of pricing params (see engine.getPricingForItem).
router.get('/api/pricing/suggest', async (req, res) => {
  try {
    const q = req.query || {};
    const r = engine.getPricingForItem({
      type: q.type, specCode: q.specCode, hoseGrade: q.hoseGrade, hoseSize: q.hoseSize,
      description: q.description, qty: money.num(q.qty), length: money.num(q.length),
      ends: q.ends != null ? money.num(q.ends) : undefined,
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-import the pricing master. Uses an uploaded .xlsx when provided, else the
// bundled datasheet. Syncs matched Inventory Cost/MarketMid unless sync=false.
router.post('/api/pricing/import', adminOnly, upload.single('file'), async (req, res) => {
  const uploaded = req.file ? req.file.path : null;
  try {
    const importedAt = new Date().toISOString();
    const opts = { importedAt };
    if (uploaded) opts.buffer = fs.readFileSync(uploaded);
    const { master } = importer.importWorkbook(opts);
    engine.clearCache();

    const doSync = String(req.query.sync || 'true') !== 'false';
    const recon = await reconcileInventory(master, { write: doSync });

    res.json({
      success: true,
      importedAt,
      counts: master.meta.counts,
      synced: doSync,
      inventory: { total: recon.total, matched: recon.matched.length, unmatched: recon.unmatched.length, unmatchedItems: recon.unmatched.slice(0, 50) },
    });
  } catch (err) {
    res.status(500).json({ error: 'Import failed: ' + err.message });
  } finally {
    if (uploaded) { try { fs.unlinkSync(uploaded); } catch (_) {} }
  }
});

module.exports = router;
