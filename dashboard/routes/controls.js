'use strict';

/**
 * Period-control endpoints — fixed assets and depreciation, stock valuation and
 * stock takes, receivables ageing, and the year-end close.
 */

const express = require('express');
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
