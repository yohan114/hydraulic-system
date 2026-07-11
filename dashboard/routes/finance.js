'use strict';
const express = require('express');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const billing = require('../services/billing');
const finance = require('../lib/finance');
const router = express.Router();

router.get('/api/workers', async (req, res) => {
    try {
        const rows = await connection.query('SELECT * FROM Workers ORDER BY Name');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Could not load workers. Run "npm run migrate" first. ' + err.message });
    }
});


router.post('/api/workers', async (req, res) => {
    try {
        const b = req.body || {};
        if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Worker name is required' });
        await connection.execute(
            `INSERT INTO Workers (Name, Role, Active, CreatedAt) VALUES (${sql.q(b.name)}, ${sql.q(b.role)}, ${b.active === false ? 0 : 1}, Now())`
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.put('/api/workers/:id', async (req, res) => {
    try {
        const b = req.body || {};
        await connection.execute(
            `UPDATE Workers SET Name = ${sql.q(b.name)}, Role = ${sql.q(b.role)}, Active = ${b.active === false ? 0 : 1} WHERE WorkerID = ${sql.n(req.params.id)}`
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.delete('/api/workers/:id', async (req, res) => {
    try {
        await connection.execute(`DELETE FROM Workers WHERE WorkerID = ${sql.n(req.params.id)}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/labour', async (req, res) => {
    try {
        const rows = await connection.query(
            `SELECT LabourPayments.*, Workers.Name AS WorkerName
             FROM LabourPayments LEFT JOIN Workers ON LabourPayments.WorkerID = Workers.WorkerID
             ORDER BY LabourPayments.PaymentDate DESC, LabourPayments.LabourPaymentID DESC`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Could not load labour payments. Run "npm run migrate" first. ' + err.message });
    }
});


router.post('/api/labour', async (req, res) => {
    try {
        const b = req.body || {};
        const amount = money.round2(b.amount);
        if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });
        const period = String(b.payPeriod || '').match(/^\d{4}-\d{2}$/) ? b.payPeriod : monthOf(b.paymentDate);
        const workerId = b.workerId ? sql.n(b.workerId) : 'NULL';
        await connection.execute(
            `INSERT INTO LabourPayments (WorkerID, Amount, PayPeriod, PaymentDate, Method, Notes, CreatedAt)
             VALUES (${workerId}, ${amount}, ${sql.q(period)}, ${sql.dbDate(b.paymentDate) === 'NULL' ? 'Now()' : sql.dbDate(b.paymentDate)}, ${sql.q(b.method || 'Cash')}, ${sql.q(b.notes)}, Now())`
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.delete('/api/labour/:id', async (req, res) => {
    try {
        await connection.execute(`DELETE FROM LabourPayments WHERE LabourPaymentID = ${sql.n(req.params.id)}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----- Technician charges: every finalized invoice's "Technical charges",
// tracked as owed-to-technician with a paid/unpaid marker. Marking one paid
// records it as a labour payment (Notes tagged TECHPAYOUT#<invoiceId>) so it
// also flows into the P&L labour cost; unpaying removes that payment. -----
const TECH_TAG = (invoiceId) => `TECHPAYOUT#${invoiceId}`;


router.get('/api/labour/technical', async (req, res) => {
    try {
        const [charges, payouts] = await Promise.all([
            connection.query(`
                SELECT Invoices.InvoiceID, Invoices.InvoiceNo, Invoices.InvoiceDate, Invoices.BilledToName,
                       SUM(InvoiceItems.Amount) AS TechAmount
                FROM Invoices INNER JOIN InvoiceItems ON Invoices.InvoiceID = InvoiceItems.InvoiceID
                WHERE Invoices.Status = 'Finalized' AND InvoiceItems.ItemDescription LIKE '%Technical%'
                GROUP BY Invoices.InvoiceID, Invoices.InvoiceNo, Invoices.InvoiceDate, Invoices.BilledToName
                ORDER BY Invoices.InvoiceDate DESC
            `),
            connection.query(`
                SELECT LabourPayments.*, Workers.Name AS WorkerName
                FROM LabourPayments LEFT JOIN Workers ON LabourPayments.WorkerID = Workers.WorkerID
                WHERE LabourPayments.Notes LIKE 'TECHPAYOUT#%'
            `).catch(() => []),
        ]);

        // Map paid markers by invoice id (parsed from the Notes tag).
        const paidBy = {};
        payouts.forEach((p) => {
            const m = String(p.Notes || '').match(/^TECHPAYOUT#(\d+)/);
            if (m) paidBy[m[1]] = p;
        });

        let totalCharge = 0, totalPaid = 0;
        const rows = charges
            .map((c) => {
                const amount = money.round2(c.TechAmount);
                const p = paidBy[c.InvoiceID];
                totalCharge += amount;
                if (p) totalPaid += money.num(p.Amount);
                return {
                    invoiceId: c.InvoiceID,
                    invoiceNo: c.InvoiceNo,
                    invoiceDate: c.InvoiceDate,
                    billedToName: c.BilledToName,
                    amount,
                    paid: !!p,
                    paidDate: p ? p.PaymentDate : null,
                    workerId: p ? p.WorkerID : null,
                    workerName: p ? p.WorkerName : null,
                    method: p ? p.Method : null,
                };
            })
            .filter((r) => r.amount > 0);

        res.json({
            charges: rows,
            totals: {
                totalCharge: money.round2(totalCharge),
                totalPaid: money.round2(totalPaid),
                outstanding: money.round2(totalCharge - totalPaid),
            },
        });
    } catch (err) {
        res.status(500).json({ error: 'Could not load technician charges. Run "npm run migrate" first. ' + err.message });
    }
});


router.post('/api/labour/technical/:invoiceId/pay', async (req, res) => {
    try {
        const invoiceId = sql.n(req.params.invoiceId);
        const b = req.body || {};
        const inv = await connection.query(`SELECT InvoiceNo, Status FROM Invoices WHERE InvoiceID = ${invoiceId}`);
        if (inv.length === 0) return res.status(404).json({ error: 'Invoice not found' });
        if (inv[0].Status !== 'Finalized') return res.status(400).json({ error: 'Only finalized invoices have payable technical charges.' });

        // Recompute the technical charge authoritatively from the line items.
        const agg = await connection.query(
            `SELECT SUM(Amount) AS a FROM InvoiceItems WHERE InvoiceID = ${invoiceId} AND ItemDescription LIKE '%Technical%'`
        );
        const amount = money.round2(agg[0] && agg[0].a);
        if (!(amount > 0)) return res.status(400).json({ error: 'This invoice has no technical charge to pay.' });

        // Replace any prior marker for this invoice, then record the payout.
        await connection.execute(`DELETE FROM LabourPayments WHERE Notes LIKE '${TECH_TAG(invoiceId)} %'`);
        const period = String(b.paidDate || '').match(/^\d{4}-\d{2}/) ? String(b.paidDate).slice(0, 7) : monthOf(b.paidDate);
        const workerId = b.workerId ? sql.n(b.workerId) : 'NULL';
        const notes = `${TECH_TAG(invoiceId)} · ${inv[0].InvoiceNo}`;
        await connection.execute(
            `INSERT INTO LabourPayments (WorkerID, Amount, PayPeriod, PaymentDate, Method, Notes, CreatedAt)
             VALUES (${workerId}, ${amount}, ${sql.q(period)}, ${sql.dbDate(b.paidDate) === 'NULL' ? 'Now()' : sql.dbDate(b.paidDate)}, ${sql.q(b.method || 'Cash')}, ${sql.q(notes)}, Now())`
        );
        res.json({ success: true, amount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.post('/api/labour/technical/:invoiceId/unpay', async (req, res) => {
    try {
        const invoiceId = sql.n(req.params.invoiceId);
        await connection.execute(`DELETE FROM LabourPayments WHERE Notes LIKE '${TECH_TAG(invoiceId)} %'`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/expenses', async (req, res) => {
    try {
        const rows = await connection.query('SELECT * FROM Expenses ORDER BY ExpenseDate DESC, ExpenseID DESC');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Could not load expenses. Run "npm run migrate" first. ' + err.message });
    }
});


router.post('/api/expenses', async (req, res) => {
    try {
        const b = req.body || {};
        const amount = money.round2(b.amount);
        if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });
        await connection.execute(
            `INSERT INTO Expenses (Category, Amount, ExpenseDate, Method, Notes, CreatedAt)
             VALUES (${sql.q(b.category || 'Other')}, ${amount}, ${sql.dbDate(b.expenseDate) === 'NULL' ? 'Now()' : sql.dbDate(b.expenseDate)}, ${sql.q(b.method || 'Cash')}, ${sql.q(b.notes)}, Now())`
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.delete('/api/expenses/:id', async (req, res) => {
    try {
        await connection.execute(`DELETE FROM Expenses WHERE ExpenseID = ${sql.n(req.params.id)}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


module.exports = router;
