'use strict';

/**
 * Customers. There is no separate customers table — a customer is just the
 * `BilledToName` on an invoice — so this exposes the distinct names for the
 * billing screen's autocomplete / quick-pick.
 */

const express = require('express');
const connection = require('../db');
const router = express.Router();

router.get('/api/customers', async (req, res) => {
  try {
    const rows = await connection.query(
      "SELECT DISTINCT BilledToName FROM Invoices WHERE BilledToName IS NOT NULL AND BilledToName <> '' ORDER BY BilledToName"
    );
    res.json(rows.map((r) => r.BilledToName));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
