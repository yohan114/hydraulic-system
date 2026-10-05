'use strict';
const express = require('express');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const billing = require('../services/billing');
const glPosting = require('../services/glPosting');
const revision = require('../services/invoiceRevision');
const { invoiceMutex } = require('../lib/mutex');
const router = express.Router();

router.get('/api/invoices/:id/payments', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const invoice = await connection.query(`SELECT GrandTotal, AmountPaid, Status FROM Invoices WHERE InvoiceID = ${id}`);
        if (invoice.length === 0) return res.status(404).json({ error: 'Invoice not found' });
        let payments = [];
        try {
            payments = await connection.query(`SELECT * FROM Payments WHERE InvoiceID = ${id} ORDER BY PaymentID ASC`);
        } catch (_) { /* Payments table not migrated yet */ }
        let allocations = [];
        try {
            allocations = await connection.query(`SELECT * FROM ReceiptAllocations WHERE InvoiceID = ${id} ORDER BY AllocationID ASC`);
        } catch (_) {}
        const pay = billing.paymentStatus(invoice[0].GrandTotal, invoice[0].AmountPaid);
        // Only a finalized invoice can carry an outstanding balance; drafts,
        // cancelled and superseded invoices report zero so they never look like
        // receivables.
        const isFinalized = invoice[0].Status === 'Finalized';
        res.json({
            invoiceId: id,
            invoiceStatus: invoice[0].Status,
            grandTotal: money.round2(invoice[0].GrandTotal),
            amountPaid: pay.amountPaid,
            balance: isFinalized ? pay.balance : 0,
            status: isFinalized ? pay.status : invoice[0].Status,
            payments,
            allocations,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.post('/api/invoices/:id/payments', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const body = req.body || {};
        const amount = money.round2(body.amount);
        if (!(amount > 0)) return res.status(400).json({ error: 'Payment amount must be greater than zero.' });

        let posting = null;
        await invoiceMutex.runExclusive(async () => {
            const invoice = await connection.query(`SELECT GrandTotal, AmountPaid, Status, IsInternal FROM Invoices WHERE InvoiceID = ${id}`);
            if (invoice.length === 0) { const e = new Error('Invoice not found'); e.httpStatus = 404; throw e; }
            if (invoice[0].IsInternal === 1) {
                const e = new Error('Payments cannot be recorded against internal company work.');
                e.httpStatus = 409;
                throw e;
            }
            if (invoice[0].Status !== 'Finalized') {
                const e = new Error(`Payments can only be recorded against finalized invoices (this one is ${invoice[0].Status}).`);
                e.httpStatus = 400;
                throw e;
            }
            const current = billing.paymentStatus(invoice[0].GrandTotal, invoice[0].AmountPaid);
            if (amount > current.balance + 0.005) {
                const e = new Error(`Payment ${money.formatLKR(amount)} exceeds the outstanding balance ${money.formatLKR(current.balance)}.`);
                e.httpStatus = 400;
                throw e;
            }

            const insRes = await connection.execute(
                `INSERT INTO Payments (InvoiceID, Amount, PaymentDate, Method, Notes, CreatedAt)
                 VALUES (${id}, ${amount}, ${sql.dbDate(body.date) === 'NULL' ? 'Now()' : sql.dbDate(body.date)}, ${sql.q(body.method || 'Cash')}, ${sql.q(body.notes)}, Now())`
            );
            const paymentId = insRes.lastInsertRowid;

            try {
                connection._db.prepare(`
                    INSERT INTO ReceiptAllocations (PaymentID, InvoiceID, Amount, AllocatedAt, AllocatedBy)
                    VALUES (?, ?, ?, ?, ?)
                `).run(
                    paymentId,
                    id,
                    amount,
                    sql.dbDate(body.date) === 'NULL' ? new Date().toISOString().slice(0, 10) : String(body.date).slice(0, 10),
                    (req.user && (req.user.sub || req.user.username)) || 'cashier'
                );
            } catch (_) {}

            // Derive AmountPaid from the authoritative payment history.
            const sumRows = await connection.query(
                `SELECT SUM(Amount) AS total FROM Payments WHERE InvoiceID = ${id} AND VoidedAt IS NULL`);
            const newPaid = money.round2(money.num(sumRows[0] && sumRows[0].total));
            const pay = billing.paymentStatus(invoice[0].GrandTotal, newPaid);
            await connection.execute(
                `UPDATE Invoices SET AmountPaid = ${newPaid}, PaymentStatus = ${sql.q(pay.status)} WHERE InvoiceID = ${id}`
            );

            // Post the receipt atomically: if GL posting fails, unwind the payment
            try {
                posting = glPosting.postPayment(paymentId, { postedBy: req.user && req.user.username });
            } catch (postErr) {
                try {
                    connection._db.prepare('DELETE FROM ReceiptAllocations WHERE PaymentID = ?').run(paymentId);
                } catch (_) {}
                await connection.execute(`DELETE FROM Payments WHERE PaymentID = ${paymentId}`);
                const rollbackPaid = money.round2(money.num((await connection.query(
                    `SELECT SUM(Amount) AS total FROM Payments WHERE InvoiceID = ${id} AND VoidedAt IS NULL`))[0]?.total));
                const rollbackPay = billing.paymentStatus(invoice[0].GrandTotal, rollbackPaid);
                await connection.execute(
                    `UPDATE Invoices SET AmountPaid = ${rollbackPaid}, PaymentStatus = ${sql.q(rollbackPay.status)} WHERE InvoiceID = ${id}`
                );
                throw postErr;
            }
        });

        const invoice = await connection.query(`SELECT GrandTotal, AmountPaid FROM Invoices WHERE InvoiceID = ${id}`);
        const pay = billing.paymentStatus(invoice[0].GrandTotal, invoice[0].AmountPaid);

        res.json({ success: true, amountPaid: pay.amountPaid, balance: pay.balance, status: pay.status, posting });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ error: 'Could not record payment. Ensure the database is migrated. ' + err.message });
    }
});


// Void a payment recorded in error.
//
// The row is never deleted — money that moved is a fact even when it moved by
// mistake. It is stamped, its journal is reversed, and the invoice's AmountPaid
// is re-derived from what is still standing. This is also what unblocks Cancel:
// an invoice can only be cancelled once nothing is paid against it.
router.post('/api/payments/:id/void', async (req, res) => {
    try {
        const reason = String((req.body && req.body.reason) || '').trim();
        if (!reason) return res.status(400).json({ error: 'Say why the payment is being voided — the reason is kept on the record.' });

        const result = await invoiceMutex.runExclusive(() => revision.voidPayment(sql.n(req.params.id), {
            reason,
            actor: (req.user && req.user.username) || null,
        }));
        res.locals.audit = {
            entity: 'payment',
            entityId: result.paymentId,
            action: 'void',
            before: { invoiceId: result.invoiceId, amount: result.amount },
            after: { reason, amountPaid: result.amountPaid },
        };
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ error: err.message });
    }
});


module.exports = router;
