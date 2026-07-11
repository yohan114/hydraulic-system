'use strict';

/**
 * Suppliers — vendors that inventory items are purchased from.
 *
 * Inventory rows carry a SupplierID plus LastPurchasePrice/LastPurchaseDate so
 * the "who do we buy this from and what did it last cost" question is answerable
 * for cost accuracy. Recording a purchase (see routes/inventory.js) updates
 * those fields and this module owns the supplier records themselves.
 */

const express = require('express');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const router = express.Router();

// List suppliers with a live count of how many inventory items each supplies.
router.get('/api/suppliers', async (req, res) => {
  try {
    const rows = await connection.query(`
      SELECT s.*, (SELECT COUNT(*) FROM Inventory i WHERE i.SupplierID = s.SupplierID) AS ItemCount
      FROM Suppliers s ORDER BY s.Name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not load suppliers. Run "npm run migrate" first. ' + err.message });
  }
});

router.post('/api/suppliers', async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Supplier name is required' });
    const info = await connection.execute(
      `INSERT INTO Suppliers (Name, ContactPerson, Phone, Email, Address, Notes, Active, CreatedAt, UpdatedAt)
       VALUES (${sql.q(b.name)}, ${sql.q(b.contactPerson)}, ${sql.q(b.phone)}, ${sql.q(b.email)}, ${sql.q(b.address)}, ${sql.q(b.notes)}, 1, Now(), Now())`
    );
    res.json({ success: true, supplierId: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/suppliers/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Supplier name is required' });
    await connection.execute(
      `UPDATE Suppliers SET Name = ${sql.q(b.name)}, ContactPerson = ${sql.q(b.contactPerson)},
        Phone = ${sql.q(b.phone)}, Email = ${sql.q(b.email)}, Address = ${sql.q(b.address)},
        Notes = ${sql.q(b.notes)}, Active = ${b.active === false ? 0 : 1}, UpdatedAt = Now()
       WHERE SupplierID = ${id}`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a supplier only when nothing references it; otherwise the link would
// dangle. The UI can reassign the items first.
router.delete('/api/suppliers/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const used = await connection.query(`SELECT COUNT(*) AS c FROM Inventory WHERE SupplierID = ${id}`);
    if ((used[0] && used[0].c) > 0) {
      return res.status(400).json({ error: `Cannot delete: ${used[0].c} inventory item(s) still use this supplier.` });
    }
    await connection.execute(`DELETE FROM Suppliers WHERE SupplierID = ${id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Purchase history for one supplier (most recent first) — the items bought and
// what they cost, for auditing cost changes over time.
router.get('/api/suppliers/:id/purchases', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const rows = await connection.query(`
      SELECT p.*, i.ProductName, i.UniqueID
      FROM Purchases p LEFT JOIN Inventory i ON p.InventoryID = i.InventoryID
      WHERE p.SupplierID = ${id} ORDER BY p.PurchaseID DESC LIMIT 200`);
    res.json(rows.map((r) => ({ ...r, UnitPrice: money.round2(r.UnitPrice), Qty: money.num(r.Qty) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
