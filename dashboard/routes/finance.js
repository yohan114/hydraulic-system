'use strict';
const express = require('express');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const billing = require('../services/billing');
const finance = require('../lib/finance');
const glPosting = require('../services/glPosting');
const ledgerSvc = require('../services/ledger');
const router = express.Router();

/**
 * Post the row that was just inserted into `table` to the General Ledger.
 *
 * A posting failure is RETURNED, never thrown: the operational record is
 * already saved and correct, and losing an expense to a chart-of-accounts
 * problem would be the worse outcome. The caller surfaces it alongside the
 * success so it is visible rather than silent.
 */
async function postLatest(table, idCol, post, req) {
    try {
        const last = await connection.query(`SELECT ${idCol} FROM ${table} ORDER BY ${idCol} DESC LIMIT 1`);
        if (!last.length) return null;
        return post(last[0][idCol], { postedBy: req.user && req.user.username });
    } catch (err) {
        console.error(`Ledger posting failed for ${table}:`, err.message);
        return { error: err.message };
    }
}

/**
 * Reverse the journal a record produced, before that record is deleted.
 * Without this the posting would outlive its source and keep moving money.
 */
async function reverseFor(sourceType, sourceId, req) {
    try {
        const journalId = ledgerSvc.isPosted(sourceType, sourceId);
        if (!journalId) return null;
        return ledgerSvc.reverseEntry(journalId, { postedBy: req.user && req.user.username });
    } catch (err) {
        console.error(`Ledger reversal failed for ${sourceType} ${sourceId}:`, err.message);
        return { error: err.message };
    }
}

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
        const posting = await postLatest('LabourPayments', 'LabourPaymentID', glPosting.postLabourPayment, req);
        res.json({ success: true, posting });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.delete('/api/labour/:id', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        // Same orphan risk as expenses: reverse the posting before the row goes.
        const reversal = await reverseFor('labour', id, req);
        await connection.execute(`DELETE FROM LabourPayments WHERE LabourPaymentID = ${id}`);
        res.json({ success: true, reversal });
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
        const posting = await postLatest('LabourPayments', 'LabourPaymentID', glPosting.postLabourPayment, req);
        res.json({ success: true, amount, posting });
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
        const posting = await postLatest('Expenses', 'ExpenseID', glPosting.postExpense, req);
        res.json({ success: true, posting });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.delete('/api/expenses/:id', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        // Reverse the journal BEFORE the row goes: once the expense is deleted
        // its posting would be an orphan that still moves cash in the ledger.
        const reversal = await reverseFor('expense', id, req);
        await connection.execute(`DELETE FROM Expenses WHERE ExpenseID = ${id}`);
        res.json({ success: true, reversal });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


module.exports = router;
