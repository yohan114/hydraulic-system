'use strict';
const express = require('express');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const billing = require('../services/billing');
const glPosting = require('../services/glPosting');
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
        const pay = billing.paymentStatus(invoice[0].GrandTotal, invoice[0].AmountPaid);
        // Only a finalized invoice can carry an outstanding balance; drafts and
        // cancelled invoices report zero so they never look like receivables.
        const isFinalized = invoice[0].Status === 'Finalized';
        res.json({
            invoiceId: id,
            invoiceStatus: invoice[0].Status,
            grandTotal: money.round2(invoice[0].GrandTotal),
            amountPaid: pay.amountPaid,
            balance: isFinalized ? pay.balance : 0,
            status: isFinalized ? pay.status : invoice[0].Status,
            payments,
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

        await invoiceMutex.runExclusive(async () => {
            const invoice = await connection.query(`SELECT GrandTotal, AmountPaid, Status FROM Invoices WHERE InvoiceID = ${id}`);
            if (invoice.length === 0) { const e = new Error('Invoice not found'); e.httpStatus = 404; throw e; }
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

            await connection.execute(
                `INSERT INTO Payments (InvoiceID, Amount, PaymentDate, Method, Notes, CreatedAt)
                 VALUES (${id}, ${amount}, ${sql.dbDate(body.date) === 'NULL' ? 'Now()' : sql.dbDate(body.date)}, ${sql.q(body.method || 'Cash')}, ${sql.q(body.notes)}, Now())`
            );
            // Derive AmountPaid from the authoritative payment history rather than
            // incrementing the stored value, so it can never drift out of sync.
            const sumRows = await connection.query(`SELECT SUM(Amount) AS total FROM Payments WHERE InvoiceID = ${id}`);
            const newPaid = money.round2(money.num(sumRows[0] && sumRows[0].total));
            const pay = billing.paymentStatus(invoice[0].GrandTotal, newPaid);
            await connection.execute(
                `UPDATE Invoices SET AmountPaid = ${newPaid}, PaymentStatus = ${sql.q(pay.status)} WHERE InvoiceID = ${id}`
            );
        });

        const invoice = await connection.query(`SELECT GrandTotal, AmountPaid FROM Invoices WHERE InvoiceID = ${id}`);
        const pay = billing.paymentStatus(invoice[0].GrandTotal, invoice[0].AmountPaid);

        // Post the receipt. Internal jobs have no receivable, so glPosting
        // returns null for them rather than inventing cash.
        let posting = null;
        try {
            const last = await connection.query(
                `SELECT PaymentID FROM Payments WHERE InvoiceID = ${id} ORDER BY PaymentID DESC LIMIT 1`);
            if (last.length) posting = glPosting.postPayment(last[0].PaymentID, { postedBy: req.user && req.user.username });
        } catch (postErr) {
            console.error('Ledger posting failed for payment on invoice', id, '-', postErr.message);
            posting = { error: postErr.message };
        }

        res.json({ success: true, amountPaid: pay.amountPaid, balance: pay.balance, status: pay.status, posting });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ error: 'Could not record payment. Ensure the database is migrated. ' + err.message });
    }
});


module.exports = router;
