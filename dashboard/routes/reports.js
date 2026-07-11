'use strict';
const express = require('express');
const xlsx = require('xlsx');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const billing = require('../services/billing');
const finance = require('../lib/finance');
const router = express.Router();

router.get('/api/dashboard', async (req, res) => {
    try {
        // Sales-by-month and receivables are both derived from ONE finalized-
        // invoice scan; the recent lists are small TOP-N reads.
        const finalizedSql = `SELECT FinalizedAt, GrandTotal, AmountPaid FROM Invoices WHERE Status = 'Finalized'`;
        // Low stock is now per-item: Qty at/below that item's ReorderLevel (default 5).
        const lowStockSql = `SELECT InventoryID, UniqueID, ProductName, SpecificationCode, Qty, Unit, COALESCE(ReorderLevel, 5) AS ReorderLevel
                             FROM Inventory WHERE Qty <= COALESCE(ReorderLevel, 5)
                             ORDER BY (COALESCE(ReorderLevel, 5) - Qty) DESC, Qty ASC`;
        const [invItems, invQty, lowStockItems, recentInvoices, movements, finalized] = await Promise.all([
            connection.query('SELECT COUNT(*) AS total FROM Inventory'),
            connection.query('SELECT SUM(Qty) AS totalQty FROM Inventory'),
            connection.query(lowStockSql).catch(() => connection.query('SELECT InventoryID, ProductName, Qty, Unit, 5 AS ReorderLevel FROM Inventory WHERE Qty <= 5')),
            connection.query("SELECT * FROM Invoices WHERE Status = 'Finalized' ORDER BY FinalizedAt DESC LIMIT 5"),
            connection.query('SELECT StockMovements.*, Inventory.ProductName FROM StockMovements LEFT JOIN Inventory ON StockMovements.InventoryID = Inventory.InventoryID ORDER BY MovementDate DESC LIMIT 5'),
            connection.query(finalizedSql).catch(() => connection.query(`SELECT FinalizedAt, GrandTotal FROM Invoices WHERE Status = 'Finalized'`)),
        ]);

        const salesByMonth = {};
        let outstandingTotal = 0;
        let outstandingCount = 0;
        finalized.forEach((inv) => {
            const date = new Date(inv.FinalizedAt);
            if (!isNaN(date)) {
                const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                salesByMonth[month] = (salesByMonth[month] || 0) + money.num(inv.GrandTotal);
            }
            const bal = money.round2(money.num(inv.GrandTotal) - money.num(inv.AmountPaid));
            if (bal > 0) { outstandingTotal += bal; outstandingCount++; }
        });
        outstandingTotal = money.round2(outstandingTotal);

        res.json({
            stats: {
                totalInventory: invItems[0]?.total || 0,
                totalQty: invQty[0]?.totalQty || 0,
                lowStock: lowStockItems.length,
                outstandingTotal,
                outstandingCount,
            },
            lowStockItems,
            recentInvoices,
            movements,
            salesByMonth,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/receivables', async (req, res) => {
    try {
        const data = await connection.query(
            `SELECT InvoiceID, InvoiceNo, InvoiceDate, BilledToName, GrandTotal, AmountPaid, FinalizedAt
             FROM Invoices WHERE Status = 'Finalized' ORDER BY InvoiceDate ASC`
        );
        const rows = [];
        let outstandingTotal = 0;
        for (const inv of data) {
            const pay = billing.paymentStatus(inv.GrandTotal, inv.AmountPaid);
            if (pay.balance <= 0) continue;
            outstandingTotal += pay.balance;
            rows.push({
                invoiceId: inv.InvoiceID,
                invoiceNo: inv.InvoiceNo,
                invoiceDate: inv.InvoiceDate,
                billedToName: inv.BilledToName,
                grandTotal: money.round2(inv.GrandTotal),
                amountPaid: pay.amountPaid,
                balance: pay.balance,
                status: pay.status,
            });
        }
        res.json({ outstandingTotal: money.round2(outstandingTotal), count: rows.length, invoices: rows });
    } catch (err) {
        res.status(500).json({ error: 'Could not load receivables. Run "npm run migrate" first. ' + err.message });
    }
});


function monthOf(dateVal) {
    const d = dateVal ? new Date(dateVal) : new Date();
    const use = isNaN(d.getTime()) ? new Date() : d;
    return `${use.getFullYear()}-${String(use.getMonth() + 1).padStart(2, '0')}`;
}

// Finalized invoices with net-of-tax revenue and material cost (COGS).

async function finalizedProfitRows() {
    const rows = await connection.query(`
        SELECT Invoices.InvoiceID, Invoices.InvoiceNo, Invoices.InvoiceDate, Invoices.BilledToName,
               Invoices.SubTotal, Invoices.Discount, Invoices.GrandTotal,
               SUM(InvoiceItems.Qty * Inventory.Cost) AS MaterialCost
        FROM ((Invoices INNER JOIN InvoiceItems ON Invoices.InvoiceID = InvoiceItems.InvoiceID)
              LEFT JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID)
        WHERE Invoices.Status = 'Finalized'
        GROUP BY Invoices.InvoiceID, Invoices.InvoiceNo, Invoices.InvoiceDate, Invoices.BilledToName,
                 Invoices.SubTotal, Invoices.Discount, Invoices.GrandTotal
        ORDER BY Invoices.InvoiceDate DESC
    `);
    return rows.map((r) => {
        const revenueExTax = money.round2(money.num(r.SubTotal) - money.num(r.Discount));
        const materialCost = money.round2(r.MaterialCost);
        const p = finance.jobProfit({ revenueExTax, materialCost });
        return {
            invoiceId: r.InvoiceID,
            invoiceNo: r.InvoiceNo,
            invoiceDate: r.InvoiceDate,
            billedToName: r.BilledToName,
            revenueExTax,
            materialCost,
            grossProfit: p.grossProfit,
            grossMarginPct: p.grossMarginPct,
            month: monthOf(r.InvoiceDate),
        };
    });
}


router.get('/api/reports/invoice-profit', async (req, res) => {
    try {
        const rows = await finalizedProfitRows();
        const totals = rows.reduce(
            (a, r) => ({
                revenueExTax: a.revenueExTax + r.revenueExTax,
                materialCost: a.materialCost + r.materialCost,
                grossProfit: a.grossProfit + r.grossProfit,
            }),
            { revenueExTax: 0, materialCost: 0, grossProfit: 0 }
        );
        res.json({
            invoices: rows,
            totals: {
                revenueExTax: money.round2(totals.revenueExTax),
                materialCost: money.round2(totals.materialCost),
                grossProfit: money.round2(totals.grossProfit),
            },
        });
    } catch (err) {
        res.status(500).json({ error: 'Could not compute invoice profit. Ensure the database is migrated. ' + err.message });
    }
});


// Price analysis: per-item our-price-vs-market-price with margins, plus a
// monthly trend — the consolidated, always-current replacement for the loose
// per-invoice comparison spreadsheets.
//
// Aggregated over finalized invoices; cost/market/list price come from the
// current Inventory row (same basis as the invoice-profit report). "Savings vs
// market" is what the customer saved by buying from us instead of at the market
// mid rate (positive = we undercut the market).
async function priceAnalysis() {
    const itemRows = await connection.query(`
        SELECT ii.InventoryID, i.UniqueID, i.ProductName, i.SpecificationCode, i.Unit,
               i.Cost AS UnitCost, i.MarketMid AS UnitMarket, i.Price AS ListPrice,
               SUM(ii.Qty) AS QtySold, SUM(ii.Qty * ii.Rate) AS OurRevenue
        FROM ((InvoiceItems ii INNER JOIN Invoices inv ON ii.InvoiceID = inv.InvoiceID)
              INNER JOIN Inventory i ON ii.InventoryID = i.InventoryID)
        WHERE inv.Status = 'Finalized'
        GROUP BY ii.InventoryID, i.UniqueID, i.ProductName, i.SpecificationCode, i.Unit, i.Cost, i.MarketMid, i.Price
    `);

    const items = itemRows.map((r) => {
        const qty = money.num(r.QtySold);
        const ourRevenue = money.round2(r.OurRevenue);
        const unitCost = money.num(r.UnitCost);
        const unitMarket = money.num(r.UnitMarket);
        const totalCost = money.round2(qty * unitCost);
        const marketRevenue = money.round2(qty * unitMarket);
        const grossProfit = money.round2(ourRevenue - totalCost);
        const avgOurRate = qty > 0 ? money.round2(ourRevenue / qty) : 0;
        return {
            inventoryId: r.InventoryID,
            uniqueId: r.UniqueID,
            productName: r.ProductName,
            specCode: r.SpecificationCode,
            unit: r.Unit,
            qtySold: qty,
            avgOurRate,
            listPrice: money.round2(r.ListPrice),
            marketMid: money.round2(unitMarket),
            unitCost: money.round2(unitCost),
            ourRevenue,
            marketRevenue,
            totalCost,
            grossProfit,
            marginPct: ourRevenue > 0 ? money.round2((grossProfit / ourRevenue) * 100) : 0,
            savingsVsMarket: money.round2(marketRevenue - ourRevenue),
        };
    }).sort((a, b) => b.ourRevenue - a.ourRevenue);

    const monthRows = await connection.query(`
        SELECT substr(inv.InvoiceDate, 1, 7) AS Month,
               SUM(ii.Qty * ii.Rate) AS OurRevenue,
               SUM(ii.Qty * COALESCE(i.Cost, 0)) AS MaterialCost,
               SUM(ii.Qty * COALESCE(i.MarketMid, 0)) AS MarketRevenue
        FROM ((InvoiceItems ii INNER JOIN Invoices inv ON ii.InvoiceID = inv.InvoiceID)
              LEFT JOIN Inventory i ON ii.InventoryID = i.InventoryID)
        WHERE inv.Status = 'Finalized'
        GROUP BY substr(inv.InvoiceDate, 1, 7)
        ORDER BY Month ASC
    `);

    const monthly = monthRows
        .filter((m) => m.Month)
        .map((m) => {
            const ourRevenue = money.round2(m.OurRevenue);
            const materialCost = money.round2(m.MaterialCost);
            const marketRevenue = money.round2(m.MarketRevenue);
            const grossProfit = money.round2(ourRevenue - materialCost);
            return {
                month: m.Month,
                ourRevenue,
                materialCost,
                marketRevenue,
                grossProfit,
                marginPct: ourRevenue > 0 ? money.round2((grossProfit / ourRevenue) * 100) : 0,
                savingsVsMarket: money.round2(marketRevenue - ourRevenue),
            };
        });

    const totals = items.reduce(
        (a, r) => ({
            qtySold: a.qtySold + r.qtySold,
            ourRevenue: a.ourRevenue + r.ourRevenue,
            marketRevenue: a.marketRevenue + r.marketRevenue,
            totalCost: a.totalCost + r.totalCost,
            grossProfit: a.grossProfit + r.grossProfit,
            savingsVsMarket: a.savingsVsMarket + r.savingsVsMarket,
        }),
        { qtySold: 0, ourRevenue: 0, marketRevenue: 0, totalCost: 0, grossProfit: 0, savingsVsMarket: 0 }
    );
    for (const k of Object.keys(totals)) totals[k] = money.round2(totals[k]);
    totals.marginPct = totals.ourRevenue > 0 ? money.round2((totals.grossProfit / totals.ourRevenue) * 100) : 0;

    return { items, monthly, totals };
}


router.get('/api/reports/price-analysis', async (req, res) => {
    try {
        res.json(await priceAnalysis());
    } catch (err) {
        res.status(500).json({ error: 'Could not compute price analysis. Ensure the database is migrated. ' + err.message });
    }
});


router.get('/api/reports/price-analysis/export', async (req, res) => {
    try {
        const { items } = await priceAnalysis();
        const excelData = items.map((r) => ({
            'Unique ID': r.uniqueId || '',
            'Product': r.productName || '',
            'Spec Code': r.specCode || '',
            'Unit': r.unit || '',
            'Qty Sold': r.qtySold,
            'Avg Our Rate': r.avgOurRate,
            'List Price': r.listPrice,
            'Market Mid': r.marketMid,
            'Unit Cost': r.unitCost,
            'Our Revenue': r.ourRevenue,
            'Market Revenue': r.marketRevenue,
            'Gross Profit': r.grossProfit,
            'Margin %': r.marginPct,
            'Customer Savings vs Market': r.savingsVsMarket,
        }));
        const ws = xlsx.utils.json_to_sheet(excelData);
        const maxLens = {};
        excelData.forEach((row) => Object.keys(row).forEach((key) => {
            maxLens[key] = Math.max(maxLens[key] || key.length, String(row[key] == null ? '' : row[key]).length);
        }));
        ws['!cols'] = Object.keys(maxLens).map((key) => ({ wch: maxLens[key] + 3 }));
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Price Analysis');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Price_Analysis.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating export');
    }
});


router.get('/api/reports/pl', async (req, res) => {
    try {
        const [profitRows, labour, expenses, payments] = await Promise.all([
            finalizedProfitRows(),
            connection.query('SELECT Amount, PayPeriod, PaymentDate FROM LabourPayments').catch(() => []),
            connection.query('SELECT Amount, ExpenseDate FROM Expenses').catch(() => []),
            connection.query("SELECT Payments.Amount, Payments.PaymentDate FROM Payments").catch(() => []),
        ]);

        const bucket = {}; // month -> { revenue, cogs, labour, expenses, paymentsIn }
        const M = (m) => (bucket[m] = bucket[m] || { revenue: 0, cogs: 0, labour: 0, expenses: 0, paymentsIn: 0 });

        profitRows.forEach((r) => { const b = M(r.month); b.revenue += r.revenueExTax; b.cogs += r.materialCost; });
        labour.forEach((l) => { const m = String(l.PayPeriod || '').match(/^\d{4}-\d{2}$/) ? l.PayPeriod : monthOf(l.PaymentDate); M(m).labour += money.num(l.Amount); });
        expenses.forEach((e) => { M(monthOf(e.ExpenseDate)).expenses += money.num(e.Amount); });
        payments.forEach((p) => { M(monthOf(p.PaymentDate)).paymentsIn += money.num(p.Amount); });

        const months = Object.keys(bucket).sort().reverse().map((m) => {
            const b = bucket[m];
            const pl = finance.monthlyPL(b);
            const cf = finance.cashFlow({ paymentsIn: b.paymentsIn, labourOut: b.labour, expensesOut: b.expenses });
            return { month: m, ...pl, paymentsIn: cf.inflow, cashOut: cf.outflow, cashNet: cf.net };
        });

        const grand = months.reduce(
            (a, m) => ({ revenue: a.revenue + m.revenue, cogs: a.cogs + m.cogs, labour: a.labour + m.labour, expenses: a.expenses + m.expenses, paymentsIn: a.paymentsIn + m.paymentsIn }),
            { revenue: 0, cogs: 0, labour: 0, expenses: 0, paymentsIn: 0 }
        );
        const totals = finance.monthlyPL(grand);
        const totalCash = finance.cashFlow({ paymentsIn: grand.paymentsIn, labourOut: grand.labour, expensesOut: grand.expenses });

        res.json({ months, totals: { ...totals, paymentsIn: totalCash.inflow, cashOut: totalCash.outflow, cashNet: totalCash.net } });
    } catch (err) {
        res.status(500).json({ error: 'Could not compute P&L. Ensure the database is migrated. ' + err.message });
    }
});


router.get('/api/movements', async (req, res) => {
    try {
        const data = await connection.query(`
            SELECT StockMovements.*, Inventory.UniqueID, Inventory.SpecificationCode, Inventory.ProductName, Invoices.InvoiceNo
            FROM (StockMovements
            LEFT JOIN Inventory ON StockMovements.InventoryID = Inventory.InventoryID)
            LEFT JOIN Invoices ON StockMovements.InvoiceID = Invoices.InvoiceID
            ORDER BY StockMovements.MovementID DESC
        `);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/movements/export', async (req, res) => {
    try {
        const sqlStr = `
            SELECT StockMovements.MovementDate, Invoices.InvoiceNo, Inventory.UniqueID, Inventory.SpecificationCode, Inventory.ProductName, StockMovements.MovementType, StockMovements.QtyChange, StockMovements.PreviousQty, StockMovements.NewQty, StockMovements.Notes
            FROM (StockMovements
            LEFT JOIN Inventory ON StockMovements.InventoryID = Inventory.InventoryID)
            LEFT JOIN Invoices ON StockMovements.InvoiceID = Invoices.InvoiceID
            ORDER BY StockMovements.MovementID DESC
        `;
        const data = await connection.query(sqlStr);

        const excelData = data.map((row) => ({
            'Date': row.MovementDate ? new Date(row.MovementDate).toLocaleDateString() : '',
            'Invoice Number': row.InvoiceNo || 'N/A',
            'Unique ID': row.UniqueID || 'N/A',
            'Spec Code': row.SpecificationCode || 'N/A',
            'Product Name': row.ProductName || 'N/A',
            'Movement Type': row.MovementType,
            'Quantity Change': row.QtyChange,
            'Previous Quantity': row.PreviousQty,
            'New Quantity': row.NewQty,
            'Notes': row.Notes || '',
        }));

        const ws = xlsx.utils.json_to_sheet(excelData);

        const maxLens = {};
        excelData.forEach((row) => {
            Object.keys(row).forEach((key) => {
                const len = String(row[key] || '').length;
                maxLens[key] = Math.max(maxLens[key] || key.length, len);
            });
        });
        ws['!cols'] = Object.keys(maxLens).map((key) => ({ wch: maxLens[key] + 4 }));

        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Stock Movements');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Stock_Movements_Export.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating export');
    }
});


module.exports = router;
