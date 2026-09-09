'use strict';

/**
 * Customer and Machine masters.
 *
 * A customer used to be free text on the invoice (`BilledToName`), and that one
 * field was carrying three different things at once: real people, the shop's own
 * vehicle registrations, and equipment descriptions. Migration 0003 split them —
 * people are Customers, the shop's own plant is Machines owned by an internal
 * customer, and every invoice points at both plus an `IsInternal` flag.
 *
 * `GET /api/customers/names` keeps returning a plain string array, which is the
 * shape a billing-screen quick-pick wants.
 */

const express = require('express');
const connection = require('../db');
const sql = require('../lib/sql');
const router = express.Router();

const KINDS = ['external', 'internal'];
const MACHINE_KINDS = ['registration', 'equipment', 'vehicle', 'plant'];

function bad(res, message) { return res.status(400).json({ error: message }); }

// ---------------------------------------------------------------- customers

router.get('/api/customers', async (req, res) => {
  try {
    const activeOnly = String(req.query.active || '') === '1';
    const rows = await connection.query(`
      SELECT c.*,
             (SELECT COUNT(*) FROM Invoices i WHERE i.CustomerID = c.CustomerID) AS Jobs,
             (SELECT COUNT(*) FROM Machines m WHERE m.CustomerID = c.CustomerID) AS MachineCount
      FROM Customers c
      ${activeOnly ? 'WHERE c.Active = 1' : ''}
      ORDER BY c.Kind DESC, c.Name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not load customers. Run "npm run migrate" first. ' + err.message });
  }
});

/** Plain name list, for a quick-pick on the billing screen. */
router.get('/api/customers/names', async (req, res) => {
  try {
    const rows = await connection.query('SELECT Name FROM Customers WHERE Active = 1 ORDER BY Name');
    res.json(rows.map((r) => r.Name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/customers/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const rows = await connection.query(`SELECT * FROM Customers WHERE CustomerID = ${id}`);
    if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
    const machines = await connection.query(`SELECT * FROM Machines WHERE CustomerID = ${id} ORDER BY Name`);
    res.json({ ...rows[0], machines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/customers', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return bad(res, 'Name is required');
    const kind = KINDS.includes(b.kind) ? b.kind : 'external';

    const clash = await connection.query(`SELECT CustomerID FROM Customers WHERE Name = ${sql.q(name)}`);
    if (clash.length) return bad(res, 'A customer with that name already exists');

    await connection.execute(`INSERT INTO Customers
      (Code, Name, Kind, Address, Phone, Email, TIN, CreditLimit, PaymentTermsDays, Active, Notes, CreatedAt, UpdatedAt)
      VALUES (${sql.q(b.code, true)}, ${sql.q(name)}, ${sql.q(kind)}, ${sql.q(b.address)}, ${sql.q(b.phone)},
              ${sql.q(b.email)}, ${sql.q(b.tin)}, ${sql.n(b.creditLimit, 0)}, ${sql.n(b.paymentTermsDays, 0)},
              1, ${sql.q(b.notes)}, Now(), Now())`);
    const row = await connection.query(`SELECT * FROM Customers WHERE Name = ${sql.q(name)}`);
    res.locals.audit = { entity: 'customer', entityId: row[0] && row[0].CustomerID, action: 'create' };
    res.json({ success: true, customer: row[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/customers/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const found = await connection.query(`SELECT * FROM Customers WHERE CustomerID = ${id}`);
    if (!found.length) return res.status(404).json({ error: 'Customer not found' });
    const before = found[0];

    const b = req.body || {};
    const name = String(b.name != null ? b.name : before.Name).trim();
    if (!name) return bad(res, 'Name is required');
    const keep = (v, prev) => (v != null ? v : prev);

    await connection.execute(`UPDATE Customers SET
      Code = ${sql.q(keep(b.code, before.Code), true)},
      Name = ${sql.q(name)},
      Kind = ${sql.q(KINDS.includes(b.kind) ? b.kind : before.Kind)},
      Address = ${sql.q(keep(b.address, before.Address))},
      Phone = ${sql.q(keep(b.phone, before.Phone))},
      Email = ${sql.q(keep(b.email, before.Email))},
      TIN = ${sql.q(keep(b.tin, before.TIN))},
      CreditLimit = ${sql.n(keep(b.creditLimit, before.CreditLimit), 0)},
      PaymentTermsDays = ${sql.n(keep(b.paymentTermsDays, before.PaymentTermsDays), 0)},
      Active = ${b.active === undefined ? sql.n(before.Active, 1) : (b.active ? 1 : 0)},
      Notes = ${sql.q(keep(b.notes, before.Notes))},
      UpdatedAt = Now()
      WHERE CustomerID = ${id}`);

    res.locals.audit = { entity: 'customer', entityId: id, action: 'update', before };
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/customers/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    // A customer with history is never deleted — its invoices would lose their
    // owner. Deactivating hides it from pickers while the links stay intact.
    const used = await connection.query(`SELECT COUNT(*) AS c FROM Invoices WHERE CustomerID = ${id}`);
    if (used[0].c > 0) {
      await connection.execute(`UPDATE Customers SET Active = 0, UpdatedAt = Now() WHERE CustomerID = ${id}`);
      res.locals.audit = { entity: 'customer', entityId: id, action: 'deactivate' };
      return res.json({ success: true, deactivated: true, jobs: used[0].c });
    }
    await connection.execute(`DELETE FROM Customers WHERE CustomerID = ${id}`);
    res.locals.audit = { entity: 'customer', entityId: id, action: 'delete' };
    res.json({ success: true, deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------- machines

router.get('/api/machines', async (req, res) => {
  try {
    const rows = await connection.query(`
      SELECT m.*, c.Name AS CustomerName,
             (SELECT COUNT(*) FROM Invoices i WHERE i.MachineID = m.MachineID) AS Jobs
      FROM Machines m LEFT JOIN Customers c ON m.CustomerID = c.CustomerID
      ORDER BY m.Kind, m.Name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Could not load machines. Run "npm run migrate" first. ' + err.message });
  }
});

router.post('/api/machines', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return bad(res, 'Name is required');

    await connection.execute(`INSERT INTO Machines (Code, Name, Kind, CustomerID, Active, Notes, CreatedAt, UpdatedAt)
      VALUES (${sql.q(b.code, true)}, ${sql.q(name)}, ${sql.q(MACHINE_KINDS.includes(b.kind) ? b.kind : 'equipment')},
              ${b.customerId ? sql.n(b.customerId) : 'NULL'}, 1, ${sql.q(b.notes)}, Now(), Now())`);
    res.locals.audit = { entity: 'machine', action: 'create' };
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/machines/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const found = await connection.query(`SELECT * FROM Machines WHERE MachineID = ${id}`);
    if (!found.length) return res.status(404).json({ error: 'Machine not found' });
    const before = found[0];

    const b = req.body || {};
    const name = String(b.name != null ? b.name : before.Name).trim();
    if (!name) return bad(res, 'Name is required');
    const keep = (v, prev) => (v != null ? v : prev);
    const owner = b.customerId != null ? b.customerId : before.CustomerID;

    await connection.execute(`UPDATE Machines SET
      Code = ${sql.q(keep(b.code, before.Code), true)},
      Name = ${sql.q(name)},
      Kind = ${sql.q(MACHINE_KINDS.includes(b.kind) ? b.kind : before.Kind)},
      CustomerID = ${owner == null ? 'NULL' : sql.n(owner)},
      Active = ${b.active === undefined ? sql.n(before.Active, 1) : (b.active ? 1 : 0)},
      Notes = ${sql.q(keep(b.notes, before.Notes))},
      UpdatedAt = Now()
      WHERE MachineID = ${id}`);

    res.locals.audit = { entity: 'machine', entityId: id, action: 'update', before };
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/machines/:id', async (req, res) => {
  try {
    const id = sql.n(req.params.id);
    const used = await connection.query(`SELECT COUNT(*) AS c FROM Invoices WHERE MachineID = ${id}`);
    if (used[0].c > 0) {
      await connection.execute(`UPDATE Machines SET Active = 0, UpdatedAt = Now() WHERE MachineID = ${id}`);
      res.locals.audit = { entity: 'machine', entityId: id, action: 'deactivate' };
      return res.json({ success: true, deactivated: true, jobs: used[0].c });
    }
    await connection.execute(`DELETE FROM Machines WHERE MachineID = ${id}`);
    res.locals.audit = { entity: 'machine', entityId: id, action: 'delete' };
    res.json({ success: true, deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
