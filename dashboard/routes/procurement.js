'use strict';

/**
 * Procurement endpoints — purchase orders, goods receipts, supplier bills,
 * supplier payments, and the reports that show what is outstanding.
 *
 * All the work is in services/procurement.js; these are thin.
 */

const express = require('express');
const connection = require('../db');
const sql = require('../lib/sql');
const proc = require('../services/procurement');
const router = express.Router();

function fail(res, err) {
  res.status(err && err.httpStatus ? err.httpStatus : 500).json({ error: err.message || String(err) });
}
const actor = (req) => (req.user && req.user.username) || null;

// -------------------------------------------------------------- orders

router.get('/api/purchase-orders', async (req, res) => {
  try {
    const rows = await connection.query(`
      SELECT p.*, s.Name AS SupplierName,
             ROUND(COALESCE(SUM(i.Qty * i.UnitPrice), 0), 2) AS Total,
             COUNT(i.POItemID) AS Lines,
             ROUND(COALESCE(SUM(i.ReceivedQty), 0), 2) AS ReceivedQty,
             ROUND(COALESCE(SUM(i.Qty), 0), 2) AS OrderedQty
      FROM PurchaseOrders p
      LEFT JOIN Suppliers s ON s.SupplierID = p.SupplierID
      LEFT JOIN PurchaseOrderItems i ON i.POID = p.POID
      GROUP BY p.POID ORDER BY p.OrderDate DESC, p.POID DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not load purchase orders. Run "npm run migrate" first. ' + err.message });
  }
});

router.get('/api/purchase-orders/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const head = await connection.query(`
      SELECT p.*, s.Name AS SupplierName FROM PurchaseOrders p
      LEFT JOIN Suppliers s ON s.SupplierID = p.SupplierID WHERE p.POID = ${id}`);
    if (!head.length) return res.status(404).json({ error: 'Purchase order not found' });
    const items = await connection.query(`
      SELECT i.*, inv.ProductName, inv.Unit,
             ROUND(i.Qty * i.UnitPrice, 2) AS Amount
      FROM PurchaseOrderItems i
      LEFT JOIN Inventory inv ON inv.InventoryID = i.InventoryID
      WHERE i.POID = ${id} ORDER BY i.POItemID`);
    const total = items.reduce((a, i) => a + (i.Amount || 0), 0);
    res.json({
      ...head[0],
      items,
      Lines: items.length,
      Total: Math.round(total * 100) / 100,
      match: proc.matchReport(id),
    });
  } catch (err) { fail(res, err); }
});

router.post('/api/purchase-orders', async (req, res) => {
  try {
    const result = proc.createPurchaseOrder({ ...(req.body || {}), postedBy: actor(req) });
    res.locals.audit = { entity: 'purchase-order', entityId: result.poId, action: 'create' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

router.post('/api/purchase-orders/:id/cancel', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    await connection.execute(`UPDATE PurchaseOrders SET Status = 'cancelled', UpdatedAt = Now() WHERE POID = ${id}`);
    res.locals.audit = { entity: 'purchase-order', entityId: id, action: 'cancel' };
    res.json({ success: true });
  } catch (err) { fail(res, err); }
});

// ------------------------------------------------------------- receipts

router.get('/api/goods-receipts', async (req, res) => {
  try {
    const rows = await connection.query(`
      SELECT g.*, s.Name AS SupplierName, p.PONo,
             ROUND(COALESCE(SUM(gi.Qty * gi.UnitPrice), 0), 2) AS GoodsValue,
             ROUND(COALESCE((SELECT SUM(Amount) FROM LandedCosts lc WHERE lc.GRNID = g.GRNID), 0), 2) AS LandedCost,
             COUNT(gi.GRNItemID) AS Lines
      FROM GoodsReceipts g
      LEFT JOIN Suppliers s ON s.SupplierID = g.SupplierID
      LEFT JOIN PurchaseOrders p ON p.POID = g.POID
      LEFT JOIN GoodsReceiptItems gi ON gi.GRNID = g.GRNID
      GROUP BY g.GRNID ORDER BY g.ReceiptDate DESC, g.GRNID DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not load goods receipts. Run "npm run migrate" first. ' + err.message });
  }
});

router.get('/api/goods-receipts/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const head = await connection.query(`
      SELECT g.*, s.Name AS SupplierName, p.PONo FROM GoodsReceipts g
      LEFT JOIN Suppliers s ON s.SupplierID = g.SupplierID
      LEFT JOIN PurchaseOrders p ON p.POID = g.POID WHERE g.GRNID = ${id}`);
    if (!head.length) return res.status(404).json({ error: 'Goods receipt not found' });
    const items = await connection.query(`
      SELECT gi.*, inv.ProductName, inv.Unit FROM GoodsReceiptItems gi
      LEFT JOIN Inventory inv ON inv.InventoryID = gi.InventoryID
      WHERE gi.GRNID = ${id} ORDER BY gi.GRNItemID`);
    const costs = await connection.query(`SELECT * FROM LandedCosts WHERE GRNID = ${id} ORDER BY LandedCostID`);
    res.json({ ...head[0], items, landedCosts: costs });
  } catch (err) { fail(res, err); }
});

router.post('/api/goods-receipts', async (req, res) => {
  try {
    const result = proc.receiveGoods({ ...(req.body || {}), postedBy: actor(req) });
    res.locals.audit = { entity: 'goods-receipt', entityId: result.grnId, action: 'receive' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

// ---------------------------------------------------------------- bills

router.get('/api/purchase-bills', async (req, res) => {
  try {
    const rows = await connection.query(`
      SELECT b.*, s.Name AS SupplierName, g.GRNNo,
             ROUND(b.Total - b.AmountPaid, 2) AS Outstanding
      FROM PurchaseBills b
      LEFT JOIN Suppliers s ON s.SupplierID = b.SupplierID
      LEFT JOIN GoodsReceipts g ON g.GRNID = b.GRNID
      ORDER BY b.BillDate DESC, b.BillID DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not load supplier bills. Run "npm run migrate" first. ' + err.message });
  }
});

router.post('/api/purchase-bills', async (req, res) => {
  try {
    const result = proc.recordBill({ ...(req.body || {}), postedBy: actor(req) });
    res.locals.audit = { entity: 'purchase-bill', entityId: result.billId, action: 'create' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

router.post('/api/supplier-payments', async (req, res) => {
  try {
    const result = proc.paySupplier({ ...(req.body || {}), postedBy: actor(req) });
    res.locals.audit = { entity: 'supplier-payment', entityId: result.paymentId, action: 'pay' };
    res.json({ success: true, ...result });
  } catch (err) { fail(res, err); }
});

// ------------------------------------------------------------- reports

router.get('/api/payables/ageing', async (req, res) => {
  try { res.json(proc.payablesAgeing(req.query.asAt)); } catch (err) { fail(res, err); }
});

router.get('/api/goods-receipts/open/uninvoiced', async (req, res) => {
  try { res.json(proc.openReceipts()); } catch (err) { fail(res, err); }
});

router.get('/api/procurement/match', async (req, res) => {
  try { res.json(proc.matchReport(req.query.poId ? sql.n(req.query.poId) : null)); } catch (err) { fail(res, err); }
});

module.exports = router;
