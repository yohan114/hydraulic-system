'use strict';
const express = require('express');
const xlsx = require('xlsx');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const glPosting = require('../services/glPosting');
const billing = require('../services/billing');
const finance = require('../lib/finance');
const invoiceNoLib = require('../lib/invoiceNo');
const revision = require('../services/invoiceRevision');
const { invoiceMutex } = require('../lib/mutex');
const { loadRateCardSafe, matchLineRate, lineMarketMid } = require('../services/ratecard');
const ledger = require('../services/stockLedger');
const pdf = require('../services/pdf');
const { buildInvoiceHtml } = require('../services/invoicePdf');
const priceAnalysis = require('../services/priceAnalysis');
const pricingEngine = require('../services/pricingEngine');
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
        // Superseded originals are excluded: their replacement is also in here,
        // so including both would export the same job's lines twice under two
        // near-identical numbers and double the Total Amount column.
        const sqlStr = `
            SELECT Invoices.InvoiceNo, InvoiceItems.ItemDescription, InvoiceItems.Unit, InvoiceItems.Qty, InvoiceItems.Rate, InvoiceItems.Amount, Invoices.GrandTotal
            FROM Invoices
            INNER JOIN InvoiceItems ON Invoices.InvoiceID = InvoiceItems.InvoiceID
            WHERE Invoices.Status <> 'Revised'
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
        // Manual lines (crimping / technical) carry their own cost + market so the
        // billing-time snapshot is still accurate for them; ignored for stock items,
        // which snapshot from Inventory. Never affects the billed amount.
        cost: money.num(it.cost),
        marketMid: money.num(it.marketMid),
        pricingSource: it.pricingSource ? String(it.pricingSource) : null,
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

async function insertItems(invoiceId, items, lineAmounts, carriedBasis) {
    // Snapshot cost + market benchmark for each line AT BILLING TIME so a bill's
    // profitability is frozen (cost/market prices drift later). Purely additive —
    // does not affect the billed amounts or the stock logic.
    const costMarket = await priceAnalysis.loadCostMarket(items.map((it) => it.inventoryId));
    // How much of each carried-basis quantity a revision has used up so far.
    const usedFromBasis = new Map();
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const invIdVal = item.inventoryId != null ? sql.n(item.inventoryId) : 'NULL';
        const cm = costMarket.get(item.inventoryId) || { unitCost: 0, marketRate: 0, specCode: '' };
        // A parts line snapshots from Inventory; a manual line (crimping/technical)
        // carries its own cost + the source the client resolved it from.
        const isManual = item.inventoryId == null;
        // A REVISION keeps the original's cost basis for the parts it already
        // billed. Those units left the shelf once, at one cost; re-snapshotting
        // today's (possibly re-averaged) cost would move the Stock account by
        // qty x cost-drift against no physical change at all.
        //
        // Only the ORIGINAL QUANTITY carries though. Anything the revision adds
        // is leaving the shelf now and belongs at today's cost, so a line that
        // straddles both is billed at the blend of the two.
        const basis = !isManual && carriedBasis ? carriedBasis.get(item.inventoryId) : null;
        let unitCost = isManual ? money.num(item.cost) : cm.unitCost;
        if (basis) {
            const qty = money.num(item.qty);
            const used = money.num(usedFromBasis.get(item.inventoryId));
            const atOldCost = Math.max(0, Math.min(qty, basis.qty - used));
            const atNewCost = money.round2(qty - atOldCost);
            usedFromBasis.set(item.inventoryId, used + atOldCost);
            if (qty > 0) {
                unitCost = money.round2((atOldCost * basis.cost + atNewCost * cm.unitCost) / qty);
            }
        }
        // Market price by PRIORITY (Task 4): outside-company benchmark first, then
        // the datasheet mid (Inventory / client-supplied), then manual. Resolved
        // server-side so the snapshot is authoritative regardless of a stale client.
        const fallbackMarket = isManual ? money.num(item.marketMid) : cm.marketRate;
        const mk = pricingEngine.resolveMarket({ specCode: isManual ? null : cm.specCode, description: item.description, hoseSize: null, fallbackMarket });
        const marketRate = mk.marketPrice;
        let source;
        if (mk.marketSource === pricingEngine.MARKET_SOURCE.OUTSIDE) source = 'outside-benchmark';
        else if (item.pricingSource) source = item.pricingSource;            // e.g. crimping-charges
        else if (isManual) source = (marketRate > 0 || unitCost > 0 ? 'manual-priced' : 'manual');
        else source = mk.marketSource;                                       // datasheet-mid / manual
        // Ferrules get the stronger cost×1.25 floor — detect from the stock spec code.
        const ferrule = !isManual && pricingEngine.isFerrule(cm.specCode);
        const s = priceAnalysis.lineSnapshot({ unitCost, ourRate: item.rate, marketRate, qty: item.qty, source, ferrule });
        await connection.execute(
            `INSERT INTO InvoiceItems (InvoiceID, InventoryID, ItemDescription, Unit, [Length], Qty, Rate, Amount,
                UnitCostAtBilling, OurBillRate, MarketBillRate, SuggestedBillRate, PricingSource, PricingRuleApplied, ProfitAmount, MarginPercent, MarketGap, PriceFlag)
             VALUES (${invoiceId}, ${invIdVal}, ${sql.q(item.description)}, ${sql.q(item.unit)}, ${sql.n(item.length, 0)}, ${sql.n(item.qty, 0)}, ${sql.n(item.rate, 0)}, ${lineAmounts[i]},
                ${s.unitCostAtBilling}, ${s.ourBillRate}, ${s.marketBillRate}, ${s.suggestedBillRate}, ${sql.q(s.pricingSource)}, ${sql.q(s.pricingRuleApplied)}, ${s.profitAmount}, ${s.marginPercent}, ${s.marketGap}, ${sql.q(s.priceFlag)})`
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
            // Invoices are no longer taxed — force both rates to 0 authoritatively
            // (the billing engine is unchanged; 0% simply yields no tax).
            ssclRate: 0,
            vatRate: 0,
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
        // No tax on new invoices — force both rates to 0 (engine unchanged).
        ssclRate: 0,
        vatRate: 0,
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

        // Post the sale to the ledger. A posting problem must not un-finalize an
        // invoice that is already saved and has already moved stock, so it is
        // reported alongside the success rather than thrown.
        let posting = null;
        try {
            posting = glPosting.postInvoice(result.invoiceId, { postedBy: req.user && req.user.username });
        } catch (postErr) {
            console.error('Ledger posting failed for', result.invoiceNo, '-', postErr.message);
            posting = { error: postErr.message };
        }

        res.json({ success: true, invoiceId: result.invoiceId, invoiceNo: result.invoiceNo, totals, posting });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ error: err.message });
    }
});

// Revise a finalized invoice: supersede it with a corrected replacement.
//
// The original is never edited. It is reversed out in full — stock back, journal
// reversed, payments voided — and a replacement carrying the corrections is
// issued as INV/..../003-R1. See services/invoiceRevision.js for why this is the
// only lawful way to change a posted invoice.
router.post('/api/invoices/:id/revise', async (req, res) => {
    const id = sql.n(req.params.id);
    const body = req.body || {};
    const actor = (req.user && req.user.username) || null;

    // A revision without a reason is an untraceable edit wearing a better hat.
    const reason = String(body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Say why this invoice is being revised — the reason is recorded against both invoices.' });

    const items = normaliseItems(body.items);
    const structural = billing.validateInvoice({ ...body, items }, { requireCustomer: true });
    if (!structural.ok) return res.status(400).json({ error: structural.errors.join(' ') });

    // Cash already taken normally follows the customer onto the corrected bill.
    // Passing carryPayments: false instead voids it outright, for the case where
    // the money is genuinely going back.
    const carryPayments = body.carryPayments !== false;

    try {
        const result = await invoiceMutex.runExclusive(async () => {
            const original = await revision.loadRevisable(id);

            // New invoices are not taxed, but a handful of May-2026 invoices
            // still carry SSCL/VAT. A revision must bill on the SAME basis as
            // the invoice it replaces, or correcting an old bill would quietly
            // drop its tax and the replacement would total less than the
            // original for no stated reason.
            const totals = billing.computeTotals({
                items,
                ssclRate: money.num(original.SSCLRate),
                vatRate: money.num(original.VATRate),
                discount: body.discount,
                roundToRupee: body.roundToRupee,
            });

            // Availability is judged against the shelf AS IT WILL BE once the
            // original gives its stock back. Checking before the return would
            // fail a revision that merely re-rates the very parts it returns.
            const returning = await revision.originalStock(id);
            const returnedById = new Map(returning.map((r) => [Number(r.InventoryID), money.num(r.Qty)]));
            const originalCosts = await revision.originalCostBasis(id);
            const { stockById, nameById } = await loadStock(items);
            for (const [invId, qty] of returnedById) {
                if (stockById.has(invId)) stockById.set(invId, money.round2(stockById.get(invId) + qty));
            }
            const stockCheck = billing.validateInvoice({ ...body, items }, { checkStock: true, stockById, nameById });
            if (!stockCheck.ok) { const e = new Error(stockCheck.errors.join(' ')); e.httpStatus = 400; throw e; }

            const existingNos = await connection.query(
                `SELECT InvoiceNo FROM Invoices WHERE InvoiceNo = ${sql.q(invoiceNoLib.baseNo(original.InvoiceNo))}
                 OR InvoiceNo LIKE ${sql.q(`${invoiceNoLib.baseNo(original.InvoiceNo)}-R%`)}`
            );
            const newNo = invoiceNoLib.nextRevisionNo(original.InvoiceNo, existingNos.map((r) => r.InvoiceNo));
            const newRevisionNo = invoiceNoLib.revisionIndex(newNo);
            const invoiceDate = body.invoiceDate || String(original.InvoiceDate || '').slice(0, 10);

            // Nothing has moved yet. Every posting a revision makes lands on
            // this date, or falls back to it, so this one check is the whole
            // guarantee that the correction reaches the books.
            revision.assertPostable(invoiceDate);

            // Every movement applied, so a failure can unwind exactly what landed.
            const applied = [];
            let newId = null;
            try {
                // 1. Give the original's stock back.
                for (const [invId, qty] of returnedById) {
                    await ledger.recordMovement({
                        inventoryId: invId, invoiceId: id, type: 'IN', qtyChange: qty,
                        notes: `Revised as ${newNo}: ${reason}`.slice(0, 200),
                    });
                    applied.push({ inventoryId: invId, qtyChange: qty });
                }

                // 2. Void the payments standing against the original. The rows
                //    stay, stamped. Their JOURNALS are reversed at step 8, not
                //    here — see the note there.
                const openPayments = await connection.query(
                    `SELECT * FROM Payments WHERE InvoiceID = ${id} AND VoidedAt IS NULL ORDER BY PaymentID ASC`);
                for (const p of openPayments) {
                    await connection.execute(
                        `UPDATE Payments SET VoidedAt = Now(), VoidedBy = ${sql.q(actor)},
                         VoidReason = ${sql.q(`Superseded by ${newNo}: ${reason}`)} WHERE PaymentID = ${sql.n(p.PaymentID)}`);
                }

                // 3. Issue the replacement, already finalized.
                //
                // FinalizedAt is inherited, not stamped Now(). The dashboard
                // buckets sales by FinalizedAt while the price analysis buckets
                // by InvoiceDate; stamping today would move a September sale
                // into October on one chart and not the other, and the two would
                // silently disagree by a whole invoice.
                const finalizedAt = original.FinalizedAt
                    ? sql.q(String(original.FinalizedAt))
                    : 'Now()';
                await connection.execute(
                    `INSERT INTO Invoices (${invoiceHeaderColumns()}, Status, AmountPaid, PaymentStatus, CreatedAt, FinalizedAt,
                        RevisionOf, RevisionNo, ${revision.CARRIED_COLUMNS.join(', ')})
                     VALUES (${invoiceHeaderValues({ ...body, invoiceDate }, totals, newNo)}, 'Finalized', 0, 'Unpaid', Now(), ${finalizedAt},
                        ${id}, ${newRevisionNo}, ${revision.carriedValues(original).join(', ')})`
                );
                newId = await resolveInvoiceIdByNo(newNo);
                await insertItems(newId, items, totals.lineAmounts, originalCosts);

                for (const item of items) {
                    if (item.inventoryId == null) continue;
                    const qty = money.num(item.qty);
                    await ledger.recordMovement({
                        inventoryId: item.inventoryId, invoiceId: newId, type: 'OUT', qtyChange: -qty,
                        notes: `Invoice Finalized ${newNo} (revision of ${original.InvoiceNo})`,
                    });
                    applied.push({ inventoryId: item.inventoryId, qtyChange: -qty });
                }

                // 5. Retire the original.
                await connection.execute(
                    `UPDATE Invoices SET Status = 'Revised', AmountPaid = 0, PaymentStatus = 'Unpaid',
                        SupersededBy = ${newId}, RevisedAt = Now(), RevisedBy = ${sql.q(actor)},
                        RevisionReason = ${sql.q(reason)}
                     WHERE InvoiceID = ${id}`
                );

                // 6. Move everything that pointed AT the original onto the
                //    replacement, or the job card would keep showing a
                //    superseded number and the technician's charge would come
                //    back round as unpaid on a job already paid out.
                await connection.execute(
                    `UPDATE JobCards SET InvoiceID = ${newId}, UpdatedAt = Now() WHERE InvoiceID = ${id}`);
                // The marker is written as `TECHPAYOUT#<id> · <InvoiceNo>`, so it
                // has to be matched on the prefix. Matching the bare tag alone
                // would silently update nothing and the technician's charge would
                // come round as owed a second time on a job already paid out.
                // The trailing space keeps #4 from matching #40.
                await connection.execute(
                    `UPDATE LabourPayments SET Notes = ${sql.q(`TECHPAYOUT#${newId} · ${newNo}`)}
                     WHERE Notes = ${sql.q(`TECHPAYOUT#${money.num(id)}`)}
                        OR Notes LIKE ${sql.q(`TECHPAYOUT#${money.num(id)} %`)}`);

                // 7. Carry the cash across. Inside the lock, because the
                //    replacement's balance must not be observable as unpaid
                //    while another request could take a second payment for it.
                const paidBefore = money.round2(openPayments.reduce((a, p) => a + money.num(p.Amount), 0));
                const carriedIds = [];
                let carriedTotal = 0;
                if (carryPayments && paidBefore > 0) {
                    for (const p of openPayments) {
                        // The FULL amount carries, even when it exceeds the
                        // corrected bill. Capping it would reverse cash out of
                        // the books that is still sitting in the till: the
                        // over-payment belongs on the invoice as a credit the
                        // customer is owed, which is what a negative receivable
                        // is for. refundDue reports it so it gets handed back.
                        const amount = money.round2(money.num(p.Amount));
                        if (amount <= 0) continue;
                        // The carried payment keeps its original date only while
                        // that period is still open; postPayment posts on this
                        // date, so a closed one would silently fail to reach the
                        // books after the cash had already been moved.
                        const paidOn = revision.correctionDate(p.PaymentDate, invoiceDate);
                        await connection.execute(
                            `INSERT INTO Payments (InvoiceID, Amount, PaymentDate, Method, Notes, CreatedAt, CarriedFromPaymentID)
                             VALUES (${newId}, ${amount}, ${sql.dbDate(paidOn)}, ${sql.q(p.Method || 'Cash')},
                                ${sql.q(`Carried from ${original.InvoiceNo}`)}, Now(), ${sql.n(p.PaymentID)})`);
                        const last = await connection.query(
                            `SELECT PaymentID FROM Payments WHERE InvoiceID = ${newId} ORDER BY PaymentID DESC LIMIT 1`);
                        if (last.length) carriedIds.push(last[0].PaymentID);
                        carriedTotal = money.round2(carriedTotal + amount);
                    }
                    const pay = billing.paymentStatus(totals.grandTotal, carriedTotal);
                    await connection.execute(
                        `UPDATE Invoices SET AmountPaid = ${carriedTotal}, PaymentStatus = ${sql.q(pay.status)}
                         WHERE InvoiceID = ${newId}`);
                }

                // 8. LAST: reverse the original's journals.
                //
                // Deliberately after everything that can fail. A journal cannot
                // be un-reversed, so reversing early and then failing at step 3
                // or 7 would leave the books saying the invoice never happened
                // while the invoice, its payment and its stock all said it did —
                // which is precisely the mess this feature exists to clean up.
                const paymentReversals = [];
                for (const p of openPayments) {
                    try {
                        // Date-corrected like the invoice reversal: a payment
                        // taken in a month since closed still reverses, into the
                        // open period the revision is dated in.
                        paymentReversals.push(revision.reversePaymentJournal(p.PaymentID, {
                            postedBy: actor,
                            date: revision.correctionDate(p.PaymentDate, invoiceDate),
                        }));
                    } catch (e) {
                        console.error('Payment reversal failed for', p.PaymentID, '-', e.message);
                        paymentReversals.push({ paymentId: p.PaymentID, error: e.message });
                    }
                }
                let originalReversal = null;
                try {
                    originalReversal = revision.reverseInvoiceJournal(id, {
                        postedBy: actor,
                        date: revision.correctionDate(original.InvoiceDate, invoiceDate),
                    });
                } catch (e) {
                    console.error('Ledger reversal failed for invoice', id, '-', e.message);
                    originalReversal = { error: e.message };
                }

                return {
                    original, newId, newNo, newRevisionNo, invoiceDate, openPayments,
                    originalReversal, paymentReversals, totals, paidBefore, carriedTotal, carriedIds,
                };
            } catch (workErr) {
                // Undo the steps in reverse. Nothing has reached the ledger yet —
                // step 8 is the last thing in the try, deliberately — so this is
                // a pure data unwind and the books never learn anything happened.
                //
                // ORDER MATTERS. Everything that POINTS AT the replacement has to
                // let go of it before it can be deleted: SupersededBy is a real
                // foreign key, so deleting the replacement while the original
                // still references it would fail.
                //
                // Each step is attempted INDEPENDENTLY. Whatever made the forward
                // pass fail may well make one of these fail too, and abandoning
                // the rest of the rollback at that point is how an invoice ends
                // up half-revised — which is the exact state this whole feature
                // exists to get out of. Best effort, every step, always.
                const undo = async (what, statement) => {
                    try { await connection.execute(statement); }
                    catch (e) { console.error(`Revise rollback (${what}) failed:`, e.message); }
                };

                // step 7 — the carried cash
                if (newId != null) await undo('carried payments', `DELETE FROM Payments WHERE InvoiceID = ${newId}`);

                // step 6 — put the job card and the technician marker back
                if (newId != null) {
                    await undo('job card', `UPDATE JobCards SET InvoiceID = ${id}, UpdatedAt = Now() WHERE InvoiceID = ${newId}`);
                    await undo('technician marker',
                        `UPDATE LabourPayments SET Notes = ${sql.q(`TECHPAYOUT#${money.num(id)} · ${original.InvoiceNo}`)}
                         WHERE Notes LIKE ${sql.q(`TECHPAYOUT#${newId} %`)}`);
                }

                // step 5 — the original was never revised
                await undo('original status',
                    `UPDATE Invoices SET Status = 'Finalized', SupersededBy = NULL, RevisedAt = NULL,
                        RevisedBy = NULL, RevisionReason = NULL WHERE InvoiceID = ${id}`);

                // steps 4 and 1 — the replacement, and the stock both moved
                for (const m of applied.slice().reverse()) {
                    await undo('stock',
                        `UPDATE Inventory SET Qty = Qty - ${money.num(m.qtyChange)} WHERE InventoryID = ${sql.n(m.inventoryId)}`);
                }
                await undo('return movements',
                    `DELETE FROM StockMovements WHERE InvoiceID = ${id} AND Notes LIKE ${sql.q(`Revised as ${newNo}:%`)}`);
                if (newId != null) {
                    await undo('replacement movements', `DELETE FROM StockMovements WHERE InvoiceID = ${newId}`);
                    await undo('replacement items', `DELETE FROM InvoiceItems WHERE InvoiceID = ${newId}`);
                    await undo('replacement', `DELETE FROM Invoices WHERE InvoiceID = ${newId}`);
                }

                // step 2 — the payments still stand, so AmountPaid comes back
                await undo('payment voids',
                    `UPDATE Payments SET VoidedAt = NULL, VoidedBy = NULL, VoidReason = NULL
                     WHERE InvoiceID = ${id} AND VoidReason LIKE ${sql.q(`Superseded by ${newNo}%`)}`);
                try {
                    const restored = await revision.livePaidTotal(id);
                    const pay = billing.paymentStatus(original.GrandTotal, restored);
                    await undo('amount paid',
                        `UPDATE Invoices SET AmountPaid = ${restored}, PaymentStatus = ${sql.q(pay.status)}
                         WHERE InvoiceID = ${id}`);
                } catch (e) {
                    console.error('Revise rollback (amount paid) failed:', e.message);
                }
                throw workErr;
            }
        });

        // Post the replacement and the cash that came with it. Reported rather
        // than thrown: the invoice is saved and the stock has moved, so
        // un-saving it over a posting problem would be the worse outcome. This
        // is the same convention the finalize path uses.
        let posting = null;
        try {
            posting = glPosting.postInvoice(result.newId, { postedBy: actor });
        } catch (postErr) {
            console.error('Ledger posting failed for', result.newNo, '-', postErr.message);
            posting = { error: postErr.message };
        }
        const paymentPostings = [];
        for (const paymentId of result.carriedIds) {
            try { paymentPostings.push(glPosting.postPayment(paymentId, { postedBy: actor })); }
            catch (payErr) {
                console.error('Ledger posting failed for carried payment', paymentId, '-', payErr.message);
                paymentPostings.push({ paymentId, error: payErr.message });
            }
        }

        // Every way the books could have been missed, gathered into one field
        // the client actually reads. A revision that rearranged the invoice but
        // never reached the ledger must not look like a clean success.
        const ledgerErrors = [posting, result.originalReversal, ...result.paymentReversals, ...paymentPostings]
            .filter((p) => p && p.error)
            .map((p) => p.error);

        const totals = result.totals;
        const status = billing.paymentStatus(totals.grandTotal, result.carriedTotal);
        res.locals.audit = {
            entity: 'invoice',
            entityId: money.num(id),
            action: 'revise',
            before: { invoiceNo: result.original.InvoiceNo, grandTotal: money.round2(result.original.GrandTotal), amountPaid: result.paidBefore },
            after: { invoiceNo: result.newNo, grandTotal: totals.grandTotal, reason },
        };
        res.json({
            success: true,
            originalInvoiceId: money.num(id),
            originalInvoiceNo: result.original.InvoiceNo,
            invoiceId: result.newId,
            invoiceNo: result.newNo,
            revisionNo: result.newRevisionNo,
            reason,
            previousTotal: money.round2(result.original.GrandTotal),
            grandTotal: totals.grandTotal,
            difference: money.round2(totals.grandTotal - money.round2(result.original.GrandTotal)),
            paymentsVoided: result.openPayments.length,
            paymentsCarried: result.carriedTotal,
            // Cash the shop is holding that the corrected bill does not justify.
            // When the money was carried, that is whatever exceeds the new total
            // — it sits as a credit against the replacement until handed back.
            // When it was not carried, the operator has said the whole lot is
            // going back, so all of it is owed.
            refundDue: carryPayments
                ? money.round2(Math.max(0, result.carriedTotal - totals.grandTotal))
                : money.round2(result.paidBefore),
            balance: status.balance,
            paymentStatus: status.status,
            totals,
            posting,
            originalReversal: result.originalReversal,
            ledgerErrors: ledgerErrors.length ? [...new Set(ledgerErrors)] : null,
        });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ error: err.message });
    }
});

// The full revision chain an invoice belongs to, oldest first.
router.get('/api/invoices/:id/revisions', async (req, res) => {
    try {
        res.json({ chain: await revision.chain(sql.n(req.params.id)) });
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
            if (status === 'Revised') {
                const e = new Error('This invoice has already been superseded by a revision. Cancel the revision instead.');
                e.httpStatus = 400;
                throw e;
            }

            // Refuse to void an invoice that has money against it — otherwise the
            // collected cash would silently disappear from all reporting. Void
            // the payment first (which reverses its journal), or revise the
            // invoice instead, which carries the money onto the corrected bill.
            const paid = money.round2(invoice[0].AmountPaid);
            if (paid > 0) {
                const e = new Error(`Cannot cancel: ${money.formatLKR(paid)} has been recorded as paid. Void the payment first, or use Revise to correct the invoice and keep the money against it.`);
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

        // A void is corrected by reversing its journal, never by deleting one.
        let reversal = null;
        try {
            reversal = glPosting.reverseInvoice(id, { postedBy: req.user && req.user.username });
        } catch (revErr) {
            console.error('Ledger reversal failed for invoice', id, '-', revErr.message);
            reversal = { error: revErr.message };
        }

        res.json({ success: true, reversal });
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

        // billType is a display-only print preference (never stored).
        const billType = req.query.billType === 'outside' ? 'outside' : 'inside';
        const html = buildInvoiceHtml(invoice[0], items, { billType });
        const buffer = await pdf.htmlToPdf(html);
        const safeNo = String(invoice[0].InvoiceNo || `invoice-${id}`).replace(/[^\w.-]+/g, '_');
        const suffix = billType === 'outside' ? '_customer' : '';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeNo}${suffix}.pdf"`);
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
            // Stock lines: live market + cost (unchanged). Manual/labour lines
            // (crimping, welding) have no Inventory join, so use their billing-time
            // snapshot — crimping compares vs its market crimp rate, welding vs its
            // welding rate.
            const isManual = item.InventoryID == null;
            const costUnit = isManual ? money.num(item.UnitCostAtBilling) : money.num(item.Cost);
            const ourCostAmt = money.round2(qty * costUnit);          // Our Cost
            const snapMarket = money.num(item.MarketBillRate);
            const marketUnit = (isManual && snapMarket > 0) ? snapMarket : lineMarketMid(rates, item); // Market, per unit
            const marketAmt = money.round2(qty * marketUnit);         // Market, line total

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
            // Manual/labour lines (crimping, welding) compare against their own
            // billing-time snapshot; stock lines keep the live market + cost.
            const isManual = item.InventoryID == null;
            const costUnit = isManual ? money.num(item.UnitCostAtBilling) : money.num(item.Cost);
            const ourCostAmt = money.round2(qty * costUnit);
            const snapMarket = money.num(item.MarketBillRate);
            const marketUnit = (isManual && snapMarket > 0) ? snapMarket : lineMarketMid(rates, item);
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
