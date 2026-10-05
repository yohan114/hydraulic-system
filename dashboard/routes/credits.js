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
const auditLog = require('../lib/auditLog');
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

// 1b. List approvals (pending, approved, consumed, rejected)
router.get('/api/approvals', async (req, res) => {
  try {
    const db = connection._db;
    const status = req.query.status || null;
    let query = `
      SELECT a.*, c.CustomerID, cust.Name AS CustomerName, c.RemainingAmount AS CreditRemaining
      FROM Approvals a
      LEFT JOIN CustomerCredits c ON c.CreditID = CAST(a.TargetID AS INTEGER)
      LEFT JOIN Customers cust ON cust.CustomerID = c.CustomerID
      WHERE 1=1
    `;
    const params = [];
    if (status) {
      query += ' AND a.Status = ?';
      params.push(status);
    }
    query += ' ORDER BY a.ApprovalID DESC';
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

      // Transactional Business Audit (AUD-01, T26)
      auditLog.recordBusinessAudit(db, {
        actorId: actor,
        actorRole: req.user && req.user.role,
        action: 'credit_refund',
        entityType: 'CustomerCredits',
        entityId: String(id),
        payloadBefore: { remainingAmount: maxRefund, status: credit.Status },
        payloadAfter: { remainingAmount: remaining, status: newStatus, refundId, amount, paymentMethod: method },
        reason: body.notes || 'Customer credit refund payout',
      });
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

// 4. Dual-Control Approval Workflow (T23 - T25)

// 4a. Request refund approval
router.post('/api/credits/:id/refund/request', async (req, res) => {
  try {
    const db = connection._db;
    const id = Number(req.params.id);
    const body = req.body || {};
    const actor = (req.user && (req.user.sub || req.user.username)) || 'requester';

    const credit = db.prepare('SELECT * FROM CustomerCredits WHERE CreditID = ?').get(id);
    if (!credit) return res.status(404).json({ error: 'Customer credit not found' });
    if (credit.Status !== 'open') {
      return res.status(400).json({ error: `Credit is already ${credit.Status} and cannot be refunded.` });
    }

    const amount = body.amount != null ? money.round2(Number(body.amount)) : money.round2(credit.RemainingAmount);
    if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero.' });
    if (amount > credit.RemainingAmount + 0.005) {
      return res.status(400).json({ error: 'Amount exceeds remaining credit.' });
    }

    const paymentMethod = body.paymentMethod || 'Cash';
    const payloadHash = hashPayload({ creditId: id, amount, paymentMethod });

    const ins = db.prepare(`
      INSERT INTO Approvals (ApprovalType, TargetEntity, TargetID, PayloadHash, RequestedBy, Status, DecisionReason, ExpiresAt)
      VALUES ('refund', 'CustomerCredits', ?, ?, ?, 'pending', ?, datetime('now', '+24 hours'))
    `).run(String(id), payloadHash, actor, body.notes || null);

    res.json({
      success: true,
      approvalId: ins.lastInsertRowid,
      status: 'pending',
      requestedAmount: amount,
      paymentMethod,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4b. Approve / reject refund request
router.post('/api/credits/:id/refund/approve', async (req, res) => {
  try {
    const db = connection._db;
    const id = Number(req.params.id);
    const body = req.body || {};
    const actor = (req.user && (req.user.sub || req.user.username)) || 'approver';
    const approvalId = Number(body.approvalId);

    const approval = db.prepare('SELECT * FROM Approvals WHERE ApprovalID = ?').get(approvalId);
    if (!approval) return res.status(404).json({ error: 'Approval request not found.' });

    // T23: Requester cannot approve own refund
    if (approval.RequestedBy === actor) {
      return res.status(403).json({
        error: 'Requester cannot approve their own refund request.',
        code: 'SELF_APPROVAL_PROHIBITED',
      });
    }

    if (approval.Status !== 'pending') {
      return res.status(400).json({ error: `Approval is currently ${approval.Status} and cannot be approved.` });
    }

    const decision = body.decision === 'rejected' ? 'rejected' : 'approved';
    db.prepare(`
      UPDATE Approvals
      SET Status = ?, ApprovedBy = ?, ApprovedAt = datetime('now', 'localtime'), DecisionReason = ?
      WHERE ApprovalID = ?
    `).run(decision, actor, body.reason || null, approvalId);

    res.json({
      success: true,
      approvalId,
      status: decision,
      approvedBy: actor,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4c. Execute approved refund payout
router.post('/api/credits/:id/refund/execute', async (req, res) => {
  try {
    const db = connection._db;
    const id = Number(req.params.id);
    const body = req.body || {};
    const actor = (req.user && (req.user.sub || req.user.username)) || 'cashier';
    const approvalId = Number(body.approvalId);

    const credit = db.prepare('SELECT * FROM CustomerCredits WHERE CreditID = ?').get(id);
    if (!credit) return res.status(404).json({ error: 'Customer credit not found.' });

    const approval = db.prepare('SELECT * FROM Approvals WHERE ApprovalID = ?').get(approvalId);
    if (!approval) return res.status(404).json({ error: 'Approval record not found.' });

    // T25: Replay attack prevention: already consumed approval cannot be executed again
    if (approval.Status === 'consumed') {
      return res.status(409).json({
        error: 'Approval voucher has already been consumed.',
        code: 'APPROVAL_ALREADY_CONSUMED',
      });
    }

    if (approval.Status !== 'approved') {
      return res.status(400).json({ error: `Approval must be approved before execution (current status: ${approval.Status}).` });
    }

    const amount = body.amount != null ? money.round2(Number(body.amount)) : money.round2(credit.RemainingAmount);
    const paymentMethod = body.paymentMethod || 'Cash';

    // T24: Approved transaction content altered (hash mismatch)
    const currentHash = hashPayload({ creditId: id, amount, paymentMethod });
    if (currentHash !== approval.PayloadHash) {
      return res.status(409).json({
        error: 'Current execution parameters do not match approved specification.',
        code: 'HASH_MISMATCH',
      });
    }

    const refundDate = String(body.refundDate || new Date().toISOString().slice(0, 10));
    let refundId = null;
    let posting = null;

    db.transaction(() => {
      // Mark approval consumed
      db.prepare("UPDATE Approvals SET Status = 'consumed' WHERE ApprovalID = ?").run(approvalId);

      const remaining = money.round2(credit.RemainingAmount - amount);
      const newStatus = remaining <= 0.005 ? 'refunded' : 'open';

      db.prepare(`
        UPDATE CustomerCredits SET RemainingAmount = ?, Status = ? WHERE CreditID = ?
      `).run(remaining, newStatus, id);

      const ins = db.prepare(`
        INSERT INTO Refunds (CreditID, CustomerID, Amount, RefundDate, PaymentMethod, ReferenceNo, ApprovedBy, ExecutedBy, CreatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      `).run(id, credit.CustomerID, amount, refundDate, paymentMethod, body.referenceNo || null, approval.ApprovedBy, actor);

      refundId = ins.lastInsertRowid;
      posting = glPosting.postRefund(refundId, { postedBy: actor });

      auditLog.recordBusinessAudit(db, {
        actorId: actor,
        actorRole: req.user && req.user.role,
        action: 'credit_refund_dual_control',
        entityType: 'CustomerCredits',
        entityId: String(id),
        payloadBefore: { remainingAmount: credit.RemainingAmount, status: credit.Status },
        payloadAfter: { remainingAmount: remaining, status: newStatus, refundId, amount, approvalId },
        reason: `Approved by ${approval.ApprovedBy}: ${approval.DecisionReason || 'Dual-control refund'}`,
      });
    })();

    res.json({
      success: true,
      refundId,
      creditId: id,
      amount,
      remainingCredit: money.round2(credit.RemainingAmount - amount),
      paymentMethod,
      approvalId,
      journal: posting,
    });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ error: err.message });
  }
});

module.exports = router;
