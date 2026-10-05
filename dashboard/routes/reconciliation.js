'use strict';

const express = require('express');
const connection = require('../db');
const reconciliation = require('../services/reconciliation');
const router = express.Router();

router.get('/api/reconciliation/status', async (req, res) => {
  try {
    const report = reconciliation.runFullReconciliation(connection._db);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/reconciliation/completeness', async (req, res) => {
  try {
    const completeness = reconciliation.checkCompleteness(connection._db);
    res.json(completeness);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/reconciliation/inventory', async (req, res) => {
  try {
    const inv = reconciliation.reconcileInventory(connection._db);
    res.json(inv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/reconciliation/ar', async (req, res) => {
  try {
    const ar = reconciliation.reconcileAccountsReceivable(connection._db);
    res.json(ar);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/reconciliation/ap', async (req, res) => {
  try {
    const ap = reconciliation.reconcileAccountsPayable(connection._db);
    res.json(ap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
