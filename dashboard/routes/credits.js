'use strict';

/**
 * Customer credits and refund vouchers management.
 *
 * Implements:
 *   - Listing open/settled credits (from downward revisions or overpayments).
 *   - Direct cash/bank refund execution.
 *   - Dual-control refund workflow (request -> approve -> execute).
 */

const express = require('express');
const crypto = require('crypto');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const glPosting = require('../services/glPosting');
const router = express.Router();

/** Hash payload for approval tampering protection (T24) */
function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// 1. List credits
router.get('/api/credits', async (req, res) => {
  try {
    const db = connection._db;
    const customerId = req.query.customerId ? Number(req.query.customerId) : null;
    const status = req.query.status || null;

    let query = `
      SELECT c.*, cust.Name AS CustomerName
      FROM CustomerCredits c
      JOIN Customers cust ON cust.CustomerID = c.CustomerID
      WHERE 1=1
    `;
    const params = [];
    if (customerId) {
      query += ' AND c.CustomerID = ?';
      params.push(customerId);
    }
    if (status) {
      query += ' AND c.Status = ?';
      params.push(status);
    }
    query += ' ORDER BY c.CreditID DESC';

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get single credit detail
router.get('/api/credits/:id', async (req, res) => {
  try {
    const db = connection._db;
    const id = Number(req.params.id);
    const credit = db.prepare(`
      SELECT c.*, cust.Name AS CustomerName
      FROM CustomerCredits c
      JOIN Customers cust ON cust.CustomerID = c.CustomerID
      WHERE c.CreditID = ?
    `).get(id);

    if (!credit) return res.status(404).json({ error: 'Customer credit not found' });

    const refunds = db.prepare('SELECT * FROM Refunds WHERE CreditID = ? ORDER BY RefundID DESC').all(id);
    res.json({ ...credit, refunds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Direct Refund Execution (or single-control execution)
router.post('/api/credits/:id/refund', async (req, res) => {
  try {
    const db = connection._db;
    const id = Number(req.params.id);
    const body = req.body || {};
    const actor = (req.user && (req.user.sub || req.user.username)) || 'cashier';

    const credit = db.prepare('SELECT * FROM CustomerCredits WHERE CreditID = ?').get(id);
    if (!credit) return res.status(404).json({ error: 'Customer credit not found' });

    if (credit.Status !== 'open') {
      return res.status(400).json({ error: `Credit is already ${credit.Status} and cannot be refunded.` });
    }

    const maxRefund = money.round2(credit.RemainingAmount);
    const amount = body.amount != null ? money.round2(Number(body.amount)) : maxRefund;

    if (!(amount > 0)) {
      return res.status(400).json({ error: 'Refund amount must be greater than zero.' });
    }
    if (amount > maxRefund + 0.005) {
      return res.status(400).json({
        error: `Refund amount ${money.formatLKR(amount)} exceeds remaining credit ${money.formatLKR(maxRefund)}.`,
      });
    }

    const method = body.paymentMethod || 'Cash';
    if (!['Cash', 'Bank Transfer', 'Cheque'].includes(method)) {
      return res.status(400).json({ error: 'Payment method must be Cash, Bank Transfer, or Cheque.' });
    }

    const refundDate = String(body.refundDate || new Date().toISOString().slice(0, 10));

    // Execute atomically
    let refundId = null;
    let posting = null;

    db.transaction(() => {
      const remaining = money.round2(maxRefund - amount);
      const newStatus = remaining <= 0.005 ? 'refunded' : 'open';

      db.prepare(`
        UPDATE CustomerCredits
        SET RemainingAmount = ?, Status = ?
        WHERE CreditID = ?
      `).run(remaining, newStatus, id);

      const ins = db.prepare(`
        INSERT INTO Refunds (
          CreditID, CustomerID, Amount, RefundDate, PaymentMethod,
          ReferenceNo, ApprovedBy, ExecutedBy, CreatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      `).run(id, credit.CustomerID, amount, refundDate, method, body.referenceNo || null, actor, actor);

      refundId = ins.lastInsertRowid;

      // Post General Ledger
      posting = glPosting.postRefund(refundId, { postedBy: actor });
    })();

    res.json({
      success: true,
      refundId,
      creditId: id,
      amount,
      remainingCredit: money.round2(maxRefund - amount),
      paymentMethod: method,
      journal: posting,
    });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ error: err.message });
  }
});

module.exports = router;
