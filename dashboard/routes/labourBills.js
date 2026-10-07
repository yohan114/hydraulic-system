'use strict';

const express = require('express');
const connection = require('../db');
const labourBills = require('../services/labourBills');
const router = express.Router();

function getActor(req) {
  return (req.user && (req.user.username || req.user.sub)) || 'system';
}

function getRole(req) {
  return (req.user && req.user.role) || 'viewer';
}

// 1. List bills
router.get('/api/labour-bills', async (req, res) => {
  try {
    const data = labourBills.listBills(req.query);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1b. Unbilled pool
router.get('/api/labour-bills/unbilled', async (req, res) => {
  try {
    const settings = labourBills.getSettings();
    const includeHistorical = req.query.includeHistorical === 'true';
    const startDate = includeHistorical ? null : (settings?.EffectiveDate || null);
    const data = labourBills.fetchUnbilledLabour(connection._db, { startDate });
    res.json({
      ...data,
      effectiveDate: settings?.EffectiveDate || null,
      filteredByEffectiveDate: Boolean(!includeHistorical && settings?.EffectiveDate),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Settings endpoints
router.get('/api/labour-bills/settings', async (req, res) => {
  try {
    res.json(labourBills.getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/labour-bills/settings', async (req, res) => {
  try {
    const updated = labourBills.updateSettings(req.body, getActor(req));
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Trigger check / manual generate
router.post('/api/labour-bills/check-now', async (req, res) => {
  try {
    const force = Boolean(req.body && req.body.force);
    const reason = req.body && req.body.reason;
    const result = await labourBills.evaluateTriggers({
      actor: getActor(req),
      force,
      reason,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Bill details
router.get('/api/labour-bills/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const details = labourBills.getBillDetails(id);
    if (!details) return res.status(404).json({ error: 'Labour bill not found' });
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Decrypt and inspect sealed archive
router.get('/api/labour-bills/:id/sealed', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
    const result = labourBills.openSealedBill(id, {
      actor: getActor(req),
      role: getRole(req),
      ip,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 5b. Remove job from draft bill (defers job back to unbilled pool for next bill)
router.delete('/api/labour-bills/:id/items/:itemId', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const itemId = parseInt(req.params.itemId, 10);
    const role = getRole(req);
    if (role !== 'workshop_supervisor' && role !== 'admin') {
      return res.status(403).json({ error: 'Only Workshop Supervisor or Admin can modify jobs in a labour bill.' });
    }
    const reason = (req.body && req.body.reason) || req.query.reason || '';
    const result = await labourBills.removeJobFromBill(id, itemId, {
      actor: getActor(req),
      role,
      reason,
    });
    res.json(result);
  } catch (err) {
    res.status(err.httpStatus || 400).json({ error: err.message, code: err.code });
  }
});

// 5c. Add unbilled job to draft bill
router.post('/api/labour-bills/:id/items', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const role = getRole(req);
    if (role !== 'workshop_supervisor' && role !== 'admin') {
      return res.status(403).json({ error: 'Only Workshop Supervisor or Admin can modify jobs in a labour bill.' });
    }
    const invoiceId = parseInt(req.body && req.body.invoiceId, 10);
    if (!invoiceId) return res.status(400).json({ error: 'invoiceId is required' });
    const reason = req.body && req.body.reason;
    const result = await labourBills.addJobToBill(id, invoiceId, {
      actor: getActor(req),
      role,
      reason,
    });
    res.json(result);
  } catch (err) {
    res.status(err.httpStatus || 400).json({ error: err.message, code: err.code });
  }
});

// 6. Workflow Action: Workshop Certify
router.post('/api/labour-bills/:id/certify', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const role = getRole(req);
    if (role !== 'workshop_supervisor' && role !== 'admin') {
      return res.status(403).json({ error: 'Only Workshop Supervisor or Admin can certify labour bills.' });
    }
    const updated = await labourBills.certifyBill(id, {
      actor: getActor(req),
      role,
      note: req.body && req.body.note,
    });
    res.json({ success: true, bill: updated.bill, integrity: updated.integrity });
  } catch (err) {
    res.status(err.httpStatus || 400).json({ error: err.message, code: err.code });
  }
});

// 7. Workflow Action: Operations Manager Approve
router.post('/api/labour-bills/:id/approve-om', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const role = getRole(req);
    if (role !== 'operations_manager' && role !== 'admin') {
      return res.status(403).json({ error: 'Only Operations Manager or Admin can grant OM approval.' });
    }
    const updated = await labourBills.approveOmBill(id, {
      actor: getActor(req),
      role,
      note: req.body && req.body.note,
    });
    res.json({ success: true, bill: updated.bill, integrity: updated.integrity });
  } catch (err) {
    res.status(err.httpStatus || 400).json({ error: err.message, code: err.code });
  }
});

// 8. Workflow Action: Head Office Accounts Approve
router.post('/api/labour-bills/:id/approve-ho', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const role = getRole(req);
    if (role !== 'ho_accounts' && role !== 'admin') {
      return res.status(403).json({ error: 'Only Head Office Accounts or Admin can grant final approval.' });
    }
    const updated = await labourBills.approveHoBill(id, {
      actor: getActor(req),
      role,
      note: req.body && req.body.note,
    });
    res.json({ success: true, bill: updated.bill, integrity: updated.integrity });
  } catch (err) {
    res.status(err.httpStatus || 400).json({ error: err.message, code: err.code });
  }
});

// 9. Workflow Action: Reject / Return to Workshop
router.post('/api/labour-bills/:id/reject', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const role = getRole(req);
    if (role !== 'operations_manager' && role !== 'ho_accounts' && role !== 'admin') {
      return res.status(403).json({ error: 'You do not have permission to return or reject this bill.' });
    }
    const reason = req.body && req.body.reason;
    const updated = await labourBills.rejectBill(id, {
      actor: getActor(req),
      role,
      reason,
    });
    res.json({ success: true, bill: updated.bill, integrity: updated.integrity });
  } catch (err) {
    res.status(err.httpStatus || 400).json({ error: err.message, code: err.code });
  }
});

// 10. Workflow Action: Workshop Accounts Pay & Close
router.post('/api/labour-bills/:id/pay', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const role = getRole(req);
    if (role !== 'workshop_accounts' && role !== 'admin') {
      return res.status(403).json({ error: 'Only Workshop Accounts or Admin can record settlement and close the bill.' });
    }
    const b = req.body || {};
    const updated = await labourBills.payAndCloseBill(id, {
      actor: getActor(req),
      role,
      paymentDate: b.paymentDate,
      method: b.method,
      paymentRef: b.paymentRef,
      paidTo: b.paidTo,
      notes: b.notes,
    });
    res.json({ success: true, bill: updated.bill, integrity: updated.integrity });
  } catch (err) {
    res.status(err.httpStatus || 400).json({ error: err.message, code: err.code });
  }
});

module.exports = router;
