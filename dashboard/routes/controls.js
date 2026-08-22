'use strict';

/**
 * Period-control endpoints — fixed assets and depreciation, stock valuation and
 * stock takes, receivables ageing, and the year-end close.
 */

const express = require('express');
const xlsx = require('xlsx');
const connection = require('../db');
const sql = require('../lib/sql');
const controls = require('../services/controls');
const router = express.Router();

function fail(res, err) {
  res.status(err && err.httpStatus ? err.httpStatus : 500).json({ error: err.message || String(err) });
}
const actor = (req) => (req.user && req.user.username) || null;

// ------------------------------------------------------------ fixed assets

router.get('/api/assets', async (req, res) => {
  try { res.json(controls.listAssets()); } catch (err) {
    res.status(500).json({ error: 'Could not load fixed assets. Run "npm run migrate" first. ' + err.message });
  }
});

router.post('/api/assets', async (req, res) => {
  try {
    const result = controls.createAsset({ ...(req.body || {}), postedBy: actor(req) });
    res.locals.audit = { entity: 'asset', entityId: result.assetId, action: 'create' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

router.get('/api/assets/depreciation', async (req, res) => {
  try {
    const rows = await connection.query(`
      SELECT d.*, a.Name AS AssetName, a.Code AS AssetCode
      FROM DepreciationEntries d JOIN FixedAssets a ON a.AssetID = d.AssetID
      ${req.query.period ? `WHERE d.Period = ${sql.q(req.query.period)}` : ''}
      ORDER BY d.Period DESC, a.Name`);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.post('/api/assets/depreciation/run', async (req, res) => {
  try {
    const period = String((req.body || {}).period || '');
    const result = controls.runDepreciation(period, { postedBy: actor(req) });
    res.locals.audit = { entity: 'depreciation', entityId: period, action: 'run' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

// ------------------------------------------------------- stock valuation

router.get('/api/stock/valuation', async (req, res) => {
  try { res.json(controls.stockValuation()); } catch (err) { fail(res, err); }
});

router.get('/api/stock-takes', async (req, res) => {
  try {
    const rows = await connection.query(`
      SELECT t.*, (SELECT COUNT(*) FROM StockTakeItems i WHERE i.StockTakeID = t.StockTakeID) AS Lines
      FROM StockTakes t ORDER BY t.TakeDate DESC, t.StockTakeID DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not load stock takes. Run "npm run migrate" first. ' + err.message });
  }
});

router.post('/api/stock-takes', async (req, res) => {
  try {
    const result = controls.openStockTake({ ...(req.body || {}), countedBy: actor(req) });
    res.locals.audit = { entity: 'stock-take', entityId: result.takeId, action: 'open' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

router.get('/api/stock-takes/:id', async (req, res) => {
  try { res.json(controls.stockTakeDetail(sql.n(req.params.id))); } catch (err) { fail(res, err); }
});

/**
 * The count sheet as a spreadsheet, to carry round the racks.
 *
 * Grouped by category so the walk follows the shelves, with the Counted column
 * left BLANK rather than pre-filled with the system figure — a sheet that
 * already shows the answer invites confirming it instead of counting it.
 */
router.get('/api/stock-takes/:id/export', async (req, res) => {
  try {
    const detail = controls.stockTakeDetail(sql.n(req.params.id));
    const posted = detail.Status === 'posted';

    const rows = detail.lines.map((l, i) => ({
      '#': String(i + 1).padStart(3, '0'),
      'Category': l.category || 'Uncategorised',
      'Code': l.uniqueId || '',
      'Item': l.name || '',
      'Unit': l.unit || '',
      'System Qty': l.systemQty,
      // Blank on a draft: fill it in at the shelf.
      'Counted Qty': posted ? l.countedQty : '',
      'Difference': posted ? l.qtyDiff : '',
      'Value Difference': posted ? l.valueDiff : '',
      'Notes': l.notes || '',
    }));
    if (posted) {
      rows.push({});
      rows.push({ 'Item': 'TOTAL VARIANCE', 'Value Difference': detail.totalVariance });
    }

    const ws = xlsx.utils.json_to_sheet(rows.length ? rows : [{ 'Item': 'No stock' }]);
    const widths = {};
    rows.forEach((r) => Object.keys(r).forEach((k) => {
      widths[k] = Math.max(widths[k] || k.length, String(r[k] == null ? '' : r[k]).length);
    }));
    ws['!cols'] = Object.keys(widths).map((k) => ({ wch: Math.min(widths[k] + 4, 46) }));

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Count Sheet');
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="Stock_Count_${String(detail.TakeNo).replace(/[^A-Z0-9]/gi, '_')}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) { fail(res, err); }
});

router.put('/api/stock-takes/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    controls.setStockTakeCounts(id, (req.body || {}).counts);
    res.locals.audit = { entity: 'stock-take', entityId: id, action: 'count' };
    res.json({ success: true, ...controls.stockTakeDetail(id) });
  } catch (err) { fail(res, err); }
});

router.post('/api/stock-takes/:id/post', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const result = controls.postStockTake(id, { postedBy: actor(req) });
    res.locals.audit = { entity: 'stock-take', entityId: id, action: 'post' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

// ------------------------------------------------------------ ageing/close

router.get('/api/receivables/ageing', async (req, res) => {
  try { res.json(controls.receivablesAgeing(req.query.asAt)); } catch (err) { fail(res, err); }
});

router.get('/api/tax-codes', async (req, res) => {
  try { res.json(await connection.query('SELECT * FROM TaxCodes ORDER BY Code')); } catch (err) { fail(res, err); }
});

router.post('/api/ledger/close-year', async (req, res) => {
  try {
    const result = controls.closeYear((req.body || {}).throughDate, { postedBy: actor(req) });
    res.locals.audit = { entity: 'year-end', entityId: result.throughDate, action: 'close' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

module.exports = router;
