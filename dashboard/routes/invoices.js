'use strict';
const express = require('express');
const xlsx = require('xlsx');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const billing = require('../services/billing');
const finance = require('../lib/finance');
const invoiceNoLib = require('../lib/invoiceNo');
const { invoiceMutex } = require('../lib/mutex');
const { loadRateCardSafe, matchLineRate, lineMarketMid } = require('../services/ratecard');
const ledger = require('../services/stockLedger');
const pdf = require('../services/pdf');
const { buildInvoiceHtml } = require('../services/invoicePdf');
const router = express.Router();

async function getNextInvoiceNo(dateStr) {
    const date = dateStr ? new Date(dateStr) : new Date();
    const prefix = invoiceNoLib.monthPrefix(isNaN(date.getTime()) ? new Date() : date);
    // No silent fallback: a query failure here must surface, otherwise we could
    // blindly return `${prefix}001` and collide with an existing number.
    const rows = await connection.query(
        `SELECT InvoiceNo FROM Invoices WHERE InvoiceNo LIKE '${sql.esc(prefix)}%'`
    );
    return invoiceNoLib.nextForPrefix(rows.map((r) => r.InvoiceNo), prefix);
}

// Resolve the InvoiceID for a just-inserted, uniquely-numbered invoice.
// Asserts exactly one row so a duplicate number can never attach items/stock to
// the wrong (older) invoice.

async function resolveInvoiceIdByNo(invoiceNo) {
    const rows = await connection.query(`SELECT InvoiceID FROM Invoices WHERE InvoiceNo = ${sql.q(invoiceNo)}`);
    if (rows.length !== 1) {
        throw new Error(`Expected exactly one invoice for ${invoiceNo}, found ${rows.length}. Aborting to avoid corrupting another invoice.`);
    }
    return rows[0].InvoiceID;
}

// ============================================================
// Dashboard & Charts
// ============================================================

// Attach derived balance/payment status without trusting stale columns.
function enrichInvoices(rows) {
    return rows.map((inv) => {
        const pay = billing.paymentStatus(inv.GrandTotal, inv.AmountPaid);
        return {
            ...inv,
            Balance: inv.Status === 'Finalized' ? pay.balance : 0,
            PaymentStatus: inv.Status === 'Finalized' ? pay.status : inv.Status,
        };
    });
}

// GET /api/invoices
//   - No `page` param  -> full array (backward compatible: comparison list,
//     export-stats, prefetch all rely on this shape).
//   - `page` present   -> server-side paginated envelope
//     { invoices, total, page, pageSize, totalPages }, with optional `search`
//     (invoice no / customer) and `status` filters. Keeps history fast on
//     thousands of invoices instead of shipping them all to the browser.
router.get('/api/invoices', async (req, res) => {
    try {
        const { page, pageSize, search, status } = req.query;

        const conds = [];
        if (search && String(search).trim()) {
            const s = sql.esc(String(search).trim());
            conds.push(`(InvoiceNo LIKE '%${s}%' OR BilledToName LIKE '%${s}%')`);
        }
        if (status && String(status).trim() && String(status) !== 'All') {
            conds.push(`Status = ${sql.q(status)}`);
        }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

        if (page === undefined) {
            const data = await connection.query(`SELECT * FROM Invoices ${where} ORDER BY InvoiceID DESC`);
            return res.json(enrichInvoices(data));
        }

        const sizeRaw = parseInt(pageSize, 10);
        const size = Number.isFinite(sizeRaw) ? Math.min(Math.max(sizeRaw, 1), 200) : 25;
        const pageRaw = parseInt(page, 10);
        const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

        const totalRow = await connection.query(`SELECT COUNT(*) AS c FROM Invoices ${where}`);
        const total = (totalRow[0] && totalRow[0].c) || 0;
        const totalPages = Math.max(1, Math.ceil(total / size));
        const safePage = Math.min(pageNum, totalPages);
        const offset = (safePage - 1) * size;

        const data = await connection.query(
            `SELECT * FROM Invoices ${where} ORDER BY InvoiceID DESC LIMIT ${size} OFFSET ${offset}`
        );
        res.json({ invoices: enrichInvoices(data), total, page: safePage, pageSize: size, totalPages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/invoices/next-no', async (req, res) => {
    try {
        const { date } = req.query;
        const nextNo = await getNextInvoiceNo(date);
        res.json({ nextInvoiceNo: nextNo });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export Invoices in one excel sheet

router.get('/api/invoices/export', async (req, res) => {
    try {
        const sqlStr = `
            SELECT Invoices.InvoiceNo, InvoiceItems.ItemDescription, InvoiceItems.Unit, InvoiceItems.Qty, InvoiceItems.Rate, InvoiceItems.Amount, Invoices.GrandTotal
            FROM Invoices
            INNER JOIN InvoiceItems ON Invoices.InvoiceID = InvoiceItems.InvoiceID
            ORDER BY Invoices.InvoiceID DESC, InvoiceItems.InvoiceItemID ASC
        `;
        const data = await connection.query(sqlStr);

        const formattedData = data.map((row) => ({
            'Invoice Number': row.InvoiceNo,
            'Description': row.ItemDescription,
            'Unit': row.Unit,
            'Qty': row.Qty,
            'Rate': row.Rate,
            'Amount': row.Amount,
            'Total Amount': row.GrandTotal,
        }));

        const ws = xlsx.utils.json_to_sheet(formattedData);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Invoices');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Invoices_Export.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating export');
    }
});

// Outstanding receivables (finalized, non-cancelled invoices with a balance).

router.get('/api/invoices/:id', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const invoice = await connection.query(`SELECT * FROM Invoices WHERE InvoiceID = ${id}`);
        if (invoice.length === 0) return res.status(404).json({ error: 'Invoice not found' });

        const items = await connection.query(`
            SELECT InvoiceItems.*, Inventory.ProductName, Inventory.SpecificationCode, Inventory.Cost
            FROM InvoiceItems
            LEFT JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID
            WHERE InvoiceItems.InvoiceID = ${id}
        `);

        const pay = billing.paymentStatus(invoice[0].GrandTotal, invoice[0].AmountPaid);
        res.json({ ...invoice[0], items, Balance: pay.balance, PaymentStatusDerived: pay.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Shared helpers for building an invoice from a request body ---

// Normalise the items array coming from the client into engine-friendly rows.

function normaliseItems(rawItems) {
    return (Array.isArray(rawItems) ? rawItems : []).map((it) => ({
        inventoryId: it.inventoryId != null && it.inventoryId !== '' ? Number(it.inventoryId) : null,
        description: String(it.description || ''),
        unit: String(it.unit || ''),
        length: money.num(it.length),
        qty: money.num(it.qty),
        rate: money.num(it.rate),
    }));
}

// Look up current stock for the inventory ids referenced by the items.

async function loadStock(items) {
    const ids = [...new Set(items.filter((i) => i.inventoryId != null).map((i) => i.inventoryId))];
    const stockById = new Map();
    const nameById = new Map();
    for (const id of ids) {
        const inv = await connection.query(`SELECT Qty, ProductName FROM Inventory WHERE InventoryID = ${sql.n(id)}`);
        if (inv.length > 0) {
            stockById.set(id, money.num(inv[0].Qty));
            nameById.set(id, inv[0].ProductName);
        }
    }
    return { stockById, nameById };
}

// Insert the line items for an invoice using engine-computed amounts.

async function insertItems(invoiceId, items, lineAmounts) {
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const invIdVal = item.inventoryId != null ? sql.n(item.inventoryId) : 'NULL';
        await connection.execute(
            `INSERT INTO InvoiceItems (InvoiceID, InventoryID, ItemDescription, Unit, [Length], Qty, Rate, Amount)
             VALUES (${invoiceId}, ${invIdVal}, ${sql.q(item.description)}, ${sql.q(item.unit)}, ${sql.n(item.length, 0)}, ${sql.n(item.qty, 0)}, ${sql.n(item.rate, 0)}, ${lineAmounts[i]})`
        );
    }
}

// Column list + value tuple shared by draft insert and finalize.

function invoiceHeaderColumns() {
    return `InvoiceNo, InvoiceDate, PONo, PODate, DeliveryDate, BilledToName, BilledToAddress, DeliveredToName, DeliveredToAddress, SubTotal, SSCLRate, SSCLAmount, VATRate, VATAmount, Discount, RoundOff, GrandTotal`;
}

function invoiceHeaderValues(body, totals, invoiceNo) {
    return `${sql.q(invoiceNo)}, ${sql.dbDate(body.invoiceDate)}, ${sql.q(body.poNo)}, ${sql.dbDate(body.poDate)}, ${sql.dbDate(body.deliveryDate)}, ${sql.q(body.billedToName)}, ${sql.q(body.billedToAddress)}, ${sql.q(body.deliveredToName)}, ${sql.q(body.deliveredToAddress)}, ${totals.subTotal}, ${totals.ssclRate}, ${totals.ssclAmount}, ${totals.vatRate}, ${totals.vatAmount}, ${totals.discount}, ${totals.roundOff}, ${totals.grandTotal}`;
}

// Create or update a DRAFT invoice. Recomputes all money server-side.

router.post('/api/invoices/draft', async (req, res) => {
    try {
        const body = req.body || {};
        const items = normaliseItems(body.items);
        const check = billing.validateInvoice({ ...body, items }, { requireCustomer: false });
        if (!check.ok) return res.status(400).json({ error: check.errors.join(' ') });

        const totals = billing.computeTotals({
            items,
            ssclRate: body.ssclRate,
            vatRate: body.vatRate,
            discount: body.discount,
            roundToRupee: body.roundToRupee,
        });

        // The whole create/update runs under the mutex so the "is this still a
        // Draft?" guard is atomic with the header/item rewrite (otherwise a
        // concurrent finalize/cancel could be silently overwritten).
        const result = await invoiceMutex.runExclusive(async () => {
            // Update an existing draft (locked once finalized/cancelled).
            if (body.invoiceId) {
                const invId = sql.n(body.invoiceId);
                const existing = await connection.query(`SELECT Status, InvoiceNo FROM Invoices WHERE InvoiceID = ${invId}`);
                if (existing.length === 0) { const e = new Error('Invoice not found'); e.httpStatus = 404; throw e; }
                if (existing[0].Status !== 'Draft') {
                    const e = new Error(`Invoice is ${existing[0].Status} and locked from editing.`);
                    e.httpStatus = 403;
                    throw e;
                }
                const invoiceNo = existing[0].InvoiceNo;
                await connection.execute(
                    `UPDATE Invoices SET InvoiceDate = ${sql.dbDate(body.invoiceDate)}, PONo = ${sql.q(body.poNo)}, PODate = ${sql.dbDate(body.poDate)}, DeliveryDate = ${sql.dbDate(body.deliveryDate)}, BilledToName = ${sql.q(body.billedToName)}, BilledToAddress = ${sql.q(body.billedToAddress)}, DeliveredToName = ${sql.q(body.deliveredToName)}, DeliveredToAddress = ${sql.q(body.deliveredToAddress)}, SubTotal = ${totals.subTotal}, SSCLRate = ${totals.ssclRate}, SSCLAmount = ${totals.ssclAmount}, VATRate = ${totals.vatRate}, VATAmount = ${totals.vatAmount}, Discount = ${totals.discount}, RoundOff = ${totals.roundOff}, GrandTotal = ${totals.grandTotal} WHERE InvoiceID = ${invId}`
                );
                await connection.execute(`DELETE FROM InvoiceItems WHERE InvoiceID = ${invId}`);
                await insertItems(invId, items, totals.lineAmounts);
                return { invoiceId: invId, invoiceNo };
            }

            // New draft -> allocate a number and insert.
            const invoiceNo = await getNextInvoiceNo(body.invoiceDate);
            await connection.execute(
                `INSERT INTO Invoices (${invoiceHeaderColumns()}, Status, AmountPaid, PaymentStatus, CreatedAt)
                 VALUES (${invoiceHeaderValues(body, totals, invoiceNo)}, 'Draft', 0, 'Unpaid', Now())`
            );
            const invoiceId = await resolveInvoiceIdByNo(invoiceNo);
            await insertItems(invoiceId, items, totals.lineAmounts);
            return { invoiceId, invoiceNo };
        });

        res.json({ success: true, invoiceId: result.invoiceId, invoiceNo: result.invoiceNo, totals });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ error: err.message });
    }
});

// Finalize an invoice: recompute money, validate stock, deduct inventory, lock.

router.post('/api/invoices/finalize', async (req, res) => {
    const body = req.body || {};
    const items = normaliseItems(body.items);

    // Validate structure + customer before touching the database.
    const structural = billing.validateInvoice({ ...body, items }, { requireCustomer: true });
    if (!structural.ok) return res.status(400).json({ error: structural.errors.join(' ') });

    const totals = billing.computeTotals({
        items,
        ssclRate: body.ssclRate,
        vatRate: body.vatRate,
        discount: body.discount,
        roundToRupee: body.roundToRupee,
    });

    // The whole finalize (stock check -> insert -> deduct -> lock) and its
    // compensation run inside a single mutex critical section so that:
    //  - two invoices can't both pass the stock check on the same units, and
    //  - a mid-way failure is unwound before any other stock writer can run.
    try {
        const result = await invoiceMutex.runExclusive(async () => {
            // Stock validation inside the lock (avoids check/deduct races).
            const { stockById, nameById } = await loadStock(items);
            const stockCheck = billing.validateInvoice({ ...body, items }, { checkStock: true, stockById, nameById });
            if (!stockCheck.ok) { const e = new Error(stockCheck.errors.join(' ')); e.httpStatus = 400; throw e; }

            let invoiceId;
            let invoiceNo;
            let usedExistingDraft = false;

            if (body.invoiceId) {
                const invId = sql.n(body.invoiceId);
                const existing = await connection.query(`SELECT Status, InvoiceNo FROM Invoices WHERE InvoiceID = ${invId}`);
                if (existing.length === 0) { const e = new Error('Invoice not found'); e.httpStatus = 404; throw e; }
                if (existing[0].Status !== 'Draft') {
                    const e = new Error(`Invoice is ${existing[0].Status} and cannot be finalized again.`);
                    e.httpStatus = 403;
                    throw e;
                }
                invoiceId = invId;
                invoiceNo = existing[0].InvoiceNo;
                usedExistingDraft = true;
                // NOTE: the header is left as 'Draft' here — it is only flipped to
                // 'Finalized' as the very last step, so a failure mid-deduction
                // leaves a recoverable draft rather than a half-finalized invoice.
            } else {
                invoiceNo = await getNextInvoiceNo(body.invoiceDate);
                await connection.execute(
                    `INSERT INTO Invoices (${invoiceHeaderColumns()}, Status, AmountPaid, PaymentStatus, CreatedAt, FinalizedAt)
                     VALUES (${invoiceHeaderValues(body, totals, invoiceNo)}, 'Finalized', 0, 'Unpaid', Now(), Now())`
                );
                try {
                    invoiceId = await resolveInvoiceIdByNo(invoiceNo);
                } catch (resolveErr) {
                    // Remove the orphan header we just inserted before failing.
                    try { await connection.execute(`DELETE FROM Invoices WHERE InvoiceNo = ${sql.q(invoiceNo)}`); } catch (_) {}
                    throw resolveErr;
                }
            }

            // Track deductions in memory so compensation reverses EXACTLY what was
            // applied, regardless of where a failure occurs.
            const applied = [];
            try {
                if (usedExistingDraft) await connection.execute(`DELETE FROM InvoiceItems WHERE InvoiceID = ${invoiceId}`);
                await insertItems(invoiceId, items, totals.lineAmounts);

                for (const item of items) {
                    if (item.inventoryId == null) continue;
                    const qty = money.num(item.qty);
                    await ledger.recordMovement({
                        inventoryId: item.inventoryId, invoiceId, type: 'OUT', qtyChange: -qty,
                        notes: `Invoice Finalized ${invoiceNo}`,
                    });
                    applied.push({ inventoryId: item.inventoryId, qty }); // record right after the deduction lands
                }

                // Lock the invoice as the final step (existing draft only; a new
                // invoice was already inserted as Finalized above).
                if (usedExistingDraft) {
                    await connection.execute(
                        `UPDATE Invoices SET InvoiceDate = ${sql.dbDate(body.invoiceDate)}, PONo = ${sql.q(body.poNo)}, PODate = ${sql.dbDate(body.poDate)}, DeliveryDate = ${sql.dbDate(body.deliveryDate)}, BilledToName = ${sql.q(body.billedToName)}, BilledToAddress = ${sql.q(body.billedToAddress)}, DeliveredToName = ${sql.q(body.deliveredToName)}, DeliveredToAddress = ${sql.q(body.deliveredToAddress)}, SubTotal = ${totals.subTotal}, SSCLRate = ${totals.ssclRate}, SSCLAmount = ${totals.ssclAmount}, VATRate = ${totals.vatRate}, VATAmount = ${totals.vatAmount}, Discount = ${totals.discount}, RoundOff = ${totals.roundOff}, GrandTotal = ${totals.grandTotal}, Status = 'Finalized', PaymentStatus = 'Unpaid', FinalizedAt = Now() WHERE InvoiceID = ${invoiceId}`
                    );
                }
            } catch (workErr) {
                // Compensate inside the lock: reverse exactly the deductions applied.
                try {
                    for (const d of applied) {
                        await connection.execute(`UPDATE Inventory SET Qty = Qty + ${money.num(d.qty)} WHERE InventoryID = ${sql.n(d.inventoryId)}`);
                    }
                    await connection.execute(`DELETE FROM StockMovements WHERE InvoiceID = ${invoiceId}`);
                    await connection.execute(`DELETE FROM InvoiceItems WHERE InvoiceID = ${invoiceId}`);
                    if (!usedExistingDraft) {
                        await connection.execute(`DELETE FROM Invoices WHERE InvoiceID = ${invoiceId}`);
                    }
                    // Existing drafts keep Status='Draft' (never flipped), so they
                    // remain a recoverable, editable draft with consistent stock.
                } catch (compErr) {
                    console.error('Finalize compensation failed:', compErr);
                }
                throw workErr;
            }

            return { invoiceId, invoiceNo };
        });

        res.json({ success: true, invoiceId: result.invoiceId, invoiceNo: result.invoiceNo, totals });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ error: err.message });
    }
});

// Cancel / void an invoice. Finalized invoices restore their deducted stock.

router.post('/api/invoices/:id/cancel', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const reason = (req.body && req.body.reason) || '';
        await invoiceMutex.runExclusive(async () => {
            const invoice = await connection.query(`SELECT Status, AmountPaid FROM Invoices WHERE InvoiceID = ${id}`);
            if (invoice.length === 0) { const e = new Error('Invoice not found'); e.httpStatus = 404; throw e; }
            const status = invoice[0].Status;
            if (status === 'Cancelled') { const e = new Error('Invoice is already cancelled.'); e.httpStatus = 400; throw e; }

            // Refuse to void an invoice that has money against it — otherwise the
            // collected cash would silently disappear from all reporting. The
            // operator must refund/clear the payments first.
            const paid = money.round2(invoice[0].AmountPaid);
            if (paid > 0) {
                const e = new Error(`Cannot cancel: ${money.formatLKR(paid)} has been recorded as paid. Refund/clear the payment(s) first.`);
                e.httpStatus = 400;
                throw e;
            }

            if (status === 'Finalized') {
                // Reverse the stock this invoice deducted.
                const its = await connection.query(`SELECT InventoryID, Qty FROM InvoiceItems WHERE InvoiceID = ${id} AND InventoryID IS NOT NULL`);
                for (const it of its) {
                    await ledger.recordMovement({
                        inventoryId: it.InventoryID, invoiceId: id, type: 'IN', qtyChange: money.num(it.Qty),
                        notes: 'Invoice Cancelled: ' + String(reason).slice(0, 180),
                    });
                }
            }

            await connection.execute(
                `UPDATE Invoices SET Status = 'Cancelled', CancelledAt = Now(), CancelReason = ${sql.q(reason)} WHERE InvoiceID = ${id}`
            );
        });
        res.json({ success: true });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ error: err.message });
    }
});


function readTier(req) {
    const t = String((req.query && req.query.tier) || 'mid').toLowerCase();
    return ['low', 'mid', 'high'].includes(t) ? t : 'mid';
}

// Match an invoice line to a hose rate first, then a fitting rate.

// Server-rendered PDF of the invoice via headless Chromium. Falls back with a
// 501 (not a crash) when puppeteer isn't installed, so the client can use the
// browser print dialog instead.
router.get('/api/invoices/:id/pdf', async (req, res) => {
    try {
        if (!pdf.isAvailable()) {
            return res.status(501).json({ error: 'PDF export is not available on the server (puppeteer is not installed). Use Print instead.', code: 'PDF_UNAVAILABLE' });
        }
        const id = sql.n(req.params.id);
        const invoice = await connection.query(`SELECT * FROM Invoices WHERE InvoiceID = ${id}`);
        if (invoice.length === 0) return res.status(404).json({ error: 'Invoice not found' });
        const items = await connection.query(`
            SELECT InvoiceItems.*, Inventory.ProductName, Inventory.SpecificationCode
            FROM InvoiceItems LEFT JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID
            WHERE InvoiceItems.InvoiceID = ${id}`);

        const html = buildInvoiceHtml(invoice[0], items);
        const buffer = await pdf.htmlToPdf(html);
        const safeNo = String(invoice[0].InvoiceNo || `invoice-${id}`).replace(/[^\w.-]+/g, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeNo}.pdf"`);
        res.send(buffer);
    } catch (err) {
        console.error('PDF generation failed:', err.message);
        res.status(500).json({ error: 'Could not generate PDF. ' + err.message });
    }
});


router.get('/api/invoices/:id/compare', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const invoice = await connection.query(`SELECT * FROM Invoices WHERE InvoiceID = ${id}`);
        if (invoice.length === 0) return res.status(404).json({ error: 'Invoice not found' });

        const items = await connection.query(`
            SELECT InvoiceItems.*, Inventory.ProductName, Inventory.SpecificationCode, Inventory.Cost, Inventory.MarketMid
            FROM InvoiceItems
            LEFT JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID
            WHERE InvoiceItems.InvoiceID = ${id}
        `);

        const rates = await loadRateCardSafe();
        let ourSubtotal = 0;      // what we billed (our price)
        let outsideSubtotal = 0;  // market mid
        let ourCostSubtotal = 0;  // our landed cost

        const comparedItems = items.map((item) => {
            const qty = money.num(item.Qty);
            const ourAmt = money.num(item.Amount);                    // Our Price (billed)
            const ourCostAmt = money.round2(qty * money.num(item.Cost)); // Our Cost
            const marketUnit = lineMarketMid(rates, item);            // Market Mid, per unit
            const marketAmt = money.round2(qty * marketUnit);         // Market Mid, line total

            ourSubtotal += ourAmt;
            ourCostSubtotal += ourCostAmt;
            outsideSubtotal += marketAmt;

            return {
                description: item.ItemDescription,
                unit: item.Unit,
                qty: item.Qty,
                ourRate: item.Rate,
                ourAmount: ourAmt,        // Our Price
                ourCost: ourCostAmt,      // Our Cost
                marketRate: marketUnit,   // Market Mid, per unit
                outsideRate: marketUnit,  // (kept for backward compatibility)
                outsideAmount: marketAmt, // Market Mid, line total
                matched: marketAmt > 0,
                outsideUnit: item.Unit,
                outsideQty: item.Qty,
            };
        });

        ourSubtotal = money.round2(ourSubtotal);
        outsideSubtotal = money.round2(outsideSubtotal);
        ourCostSubtotal = money.round2(ourCostSubtotal);

        const ssclRate = money.num(invoice[0].SSCLRate);
        const vatRate = money.num(invoice[0].VATRate);
        const ourSscl = money.round2(ourSubtotal * (ssclRate / 100));
        const ourPreVat = money.round2(ourSubtotal + ourSscl);
        const ourVat = money.round2(ourPreVat * (vatRate / 100));
        const ourGrandTotal = money.round2(ourPreVat + ourVat);
        const outsideGrandTotal = outsideSubtotal;
        const netSavings = money.round2(outsideGrandTotal - ourGrandTotal);

        // Our profit on this job = net-of-tax revenue − our cost of materials.
        const profit = finance.jobProfit({ revenueExTax: ourSubtotal, materialCost: ourCostSubtotal });

        res.json({
            invoiceNo: invoice[0].InvoiceNo,
            invoiceDate: invoice[0].InvoiceDate,
            billedToName: invoice[0].BilledToName,
            tier: 'mid',
            taxes: {
                ssclRate,
                vatRate,
                ourSubtotal,
                ourSscl,
                ourVat,
                ourGrandTotal,
                outsideSubtotal,
                outsideSscl: 0,
                outsideVat: 0,
                outsideGrandTotal,
                netSavings,
            },
            profit: {
                ourCost: ourCostSubtotal,
                revenue: ourSubtotal,
                grossProfit: profit.grossProfit,
                grossMarginPct: profit.grossMarginPct,
            },
            items: comparedItems,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/invoices/:id/compare-export', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const invoice = await connection.query(`SELECT * FROM Invoices WHERE InvoiceID = ${id}`);
        if (invoice.length === 0) return res.status(404).send('Invoice not found');

        const items = await connection.query(`
            SELECT InvoiceItems.*, Inventory.ProductName, Inventory.SpecificationCode, Inventory.Cost, Inventory.MarketMid
            FROM InvoiceItems
            LEFT JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID
            WHERE InvoiceItems.InvoiceID = ${id}
        `);

        const rates = await loadRateCardSafe();
        let ourSubtotal = 0;
        let outsideSubtotal = 0;
        let ourCostSubtotal = 0;

        const excelRows = items.map((item, idx) => {
            const qty = money.num(item.Qty);
            const ourAmt = money.num(item.Amount);
            const ourCostAmt = money.round2(qty * money.num(item.Cost));
            const marketUnit = lineMarketMid(rates, item);
            const marketAmt = money.round2(qty * marketUnit);
            ourSubtotal += ourAmt;
            ourCostSubtotal += ourCostAmt;
            outsideSubtotal += marketAmt;

            return {
                '#': String(idx + 1).padStart(2, '0'),
                'Description': item.ItemDescription,
                'Qty': item.Qty,
                'Unit': item.Unit,
                'Our Cost (Rs.)': ourCostAmt,
                'Our Price (Rs.)': ourAmt,
                'Job Profit (Rs.)': money.round2(ourAmt - ourCostAmt),
                'Market Mid Rate (Rs.)': marketUnit,
                'Market Mid Amount (Rs.)': marketAmt,
                'Vs Market (Rs.)': money.round2(marketAmt - ourAmt),
            };
        });

        ourSubtotal = money.round2(ourSubtotal);
        outsideSubtotal = money.round2(outsideSubtotal);
        ourCostSubtotal = money.round2(ourCostSubtotal);

        const ssclRate = money.num(invoice[0].SSCLRate);
        const vatRate = money.num(invoice[0].VATRate);

        const ourSscl = money.round2(ourSubtotal * (ssclRate / 100));
        const ourVat = money.round2((ourSubtotal + ourSscl) * (vatRate / 100));
        const ourGrand = money.round2(ourSubtotal + ourSscl + ourVat);

        const outsideSscl = 0;
        const outsideVat = 0;
        const outsideGrand = outsideSubtotal;

        const netSavings = money.round2(outsideGrand - ourGrand);

        excelRows.push({});
        excelRows.push({ 'Description': 'OUR COST', 'Our Cost (Rs.)': ourCostSubtotal, 'Job Profit (Rs.)': money.round2(ourSubtotal - ourCostSubtotal) });
        excelRows.push({ 'Description': 'SUBTOTAL', 'Our Price (Rs.)': ourSubtotal, 'Market Mid Amount (Rs.)': outsideSubtotal, 'Vs Market (Rs.)': money.round2(outsideSubtotal - ourSubtotal) });
        excelRows.push({ 'Description': `SSCL (${ssclRate}%)`, 'Our Price (Rs.)': ourSscl, 'Market Mid Amount (Rs.)': outsideSscl, 'Vs Market (Rs.)': outsideSscl - ourSscl });
        excelRows.push({ 'Description': `VAT (${vatRate}%)`, 'Our Price (Rs.)': ourVat, 'Market Mid Amount (Rs.)': outsideVat, 'Vs Market (Rs.)': outsideVat - ourVat });
        excelRows.push({ 'Description': 'GRAND TOTAL', 'Our Price (Rs.)': ourGrand, 'Market Mid Amount (Rs.)': outsideGrand, 'Vs Market (Rs.)': netSavings });

        const ws = xlsx.utils.json_to_sheet(excelRows);

        const maxLens = {};
        excelRows.forEach((row) => {
            Object.keys(row).forEach((key) => {
                const len = String(row[key] || '').length;
                maxLens[key] = Math.max(maxLens[key] || key.length, len);
            });
        });
        ws['!cols'] = Object.keys(maxLens).map((key) => ({ wch: maxLens[key] + 4 }));

        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Invoice Comparison');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

        const safeInvNo = invoice[0].InvoiceNo.replace(/[^A-Z0-9]/gi, '_');
        res.setHeader('Content-Disposition', `attachment; filename="Invoice_Comparison_${safeInvNo}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating export');
    }
});


module.exports = router;
