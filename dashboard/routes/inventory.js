'use strict';
const express = require('express');
const xlsx = require('xlsx');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const { loadRateCard, getCostComparison, rateCardSet } = require('../services/ratecard');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}
const upload = multer({ dest: UPLOAD_DIR });
const router = express.Router();

router.get('/api/inventory', async (req, res) => {
    try {
        const data = await connection.query('SELECT * FROM Inventory ORDER BY InventoryID DESC');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/inventory/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json([]);
        const safeQ = sql.esc(q);
        const sqlStr = `SELECT * FROM Inventory WHERE UniqueID LIKE '%${safeQ}%' OR ProductName LIKE '%${safeQ}%' OR SpecificationCode LIKE '%${safeQ}%' OR Unit LIKE '%${safeQ}%'`;
        const data = await connection.query(sqlStr);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.post('/api/inventory', async (req, res) => {
    try {
        const { uniqueId, productName, specificationCode, size, description, length, qty, unit, price, cost } = req.body;
        if (!uniqueId || !productName) return res.status(400).json({ error: 'UniqueID and ProductName are required' });
        const check = await connection.query(`SELECT UniqueID FROM Inventory WHERE UniqueID = ${sql.q(uniqueId)}`);
        if (check.length > 0) return res.status(400).json({ error: 'UniqueID already exists' });

        const sqlStr = `INSERT INTO Inventory (UniqueID, ProductName, SpecificationCode, [Size], Description, [Length], Qty, Unit, Price, Cost, CreatedAt, UpdatedAt)
            VALUES (${sql.q(uniqueId)}, ${sql.q(productName)}, ${sql.q(specificationCode)}, ${sql.q(size)}, ${sql.q(description)}, ${sql.n(length, 0)}, ${sql.n(qty, 0)}, ${sql.q(unit)}, ${sql.n(price, 0)}, ${sql.n(cost, 0)}, Now(), Now())`;

        await connection.execute(sqlStr);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.put('/api/inventory/:id', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const { productName, specificationCode, size, description, length, qty, unit, price, cost } = req.body;
        const sqlStr = `UPDATE Inventory SET
            ProductName = ${sql.q(productName)},
            SpecificationCode = ${sql.q(specificationCode)},
            [Size] = ${sql.q(size)},
            Description = ${sql.q(description)},
            [Length] = ${sql.n(length, 0)},
            Qty = ${sql.n(qty, 0)},
            Unit = ${sql.q(unit)},
            Price = ${sql.n(price, 0)},
            Cost = ${sql.n(cost, 0)},
            UpdatedAt = Now()
            WHERE InventoryID = ${id}`;

        await connection.execute(sqlStr);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.delete('/api/inventory/:id', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const check = await connection.query(`SELECT InvoiceItemID FROM InvoiceItems WHERE InventoryID = ${id}`);
        if (check.length > 0) return res.status(400).json({ error: 'Cannot delete: item is used in invoice history' });

        await connection.execute(`DELETE FROM Inventory WHERE InventoryID = ${id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/ratecard', async (req, res) => {
    try {
        const rows = await loadRateCard();
        // Savings vs the Mid outside band, and our margin — for the Rate Card view.
        const withSavings = rows.map((r) => ({
            ...r,
            savingsPerUnit: money.round2(r.outsideMid - r.ourPrice),
            savingsPct: r.outsideMid > 0 ? money.round2(((r.outsideMid - r.ourPrice) / r.outsideMid) * 100) : 0,
            marginPct: r.ourPrice > 0 ? money.round2(((r.ourPrice - r.ourCost) / r.ourPrice) * 100) : 0,
        }));
        res.json(withSavings);
    } catch (err) {
        res.status(500).json({ error: 'Could not load rate card. Run "npm run migrate" first. ' + err.message });
    }
});

// Column list + value tuple shared by Rate Card insert/update.

router.post('/api/ratecard', async (req, res) => {
    try {
        const b = req.body || {};
        if (!String(b.label || '').trim()) return res.status(400).json({ error: 'Label is required' });
        await connection.execute(
            `INSERT INTO RateCard (Category, Spec, SizeCode, SizeInch, Label, Unit, OurCost, OurPrice, OutsideLow, OutsideMid, OutsideHigh, OutsidePrice, UpdatedAt)
             VALUES (${sql.q(b.category || 'hose')}, ${sql.q(b.spec)}, ${sql.q(b.sizeCode)}, ${sql.n(b.sizeInch, 0)}, ${sql.q(b.label)}, ${sql.q(b.unit || 'm')}, ${sql.n(b.ourCost, 0)}, ${sql.n(b.ourPrice, 0)}, ${sql.n(b.outsideLow, 0)}, ${sql.n(b.outsideMid, 0)}, ${sql.n(b.outsideHigh, 0)}, ${sql.n(b.outsideMid, 0)}, Now())`
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.put('/api/ratecard/:id', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        await connection.execute(`UPDATE RateCard SET ${rateCardSet(req.body || {})} WHERE RateID = ${id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.delete('/api/ratecard/:id', async (req, res) => {
    try {
        await connection.execute(`DELETE FROM RateCard WHERE RateID = ${sql.n(req.params.id)}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/inventory/export', async (req, res) => {
    try {
        const data = await connection.query('SELECT * FROM Inventory ORDER BY InventoryID ASC');
        const ws = xlsx.utils.json_to_sheet(data);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'Inventory');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Inventory_Export.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        res.status(500).send('Error generating export');
    }
});


router.post('/api/inventory/import', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded');

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(sheet);

        let processed = 0;

        for (const row of data) {
            if (!row.ProductName && !row.UniqueID) continue;

            let uniqueId = row.UniqueID;
            if (!uniqueId && row.ProductName) {
                uniqueId = row.ProductName.toUpperCase().replace(/[^A-Z0-9]/g, '-');
            }

            const length = money.num(row.Length);
            const qty = money.num(row.Qty);
            const price = money.num(row.Price);
            const cost = money.num(row.Cost);
            // MarketMid is optional in the sheet: only write it when the column is
            // present, so importing an older file never zeroes an existing benchmark.
            const hasMarketMid = row.MarketMid != null && row.MarketMid !== '';
            const marketMid = money.num(row.MarketMid);

            const existing = await connection.query(`SELECT InventoryID FROM Inventory WHERE UniqueID = ${sql.q(uniqueId)}`);
            if (existing.length > 0) {
                await connection.execute(`UPDATE Inventory SET
                    ProductName = ${sql.q(row.ProductName)}, SpecificationCode = ${sql.q(row.SpecificationCode)}, [Size] = ${sql.q(row.Size)}, Description = ${sql.q(row.Description)},
                    [Length] = ${length}, Qty = ${qty}, Unit = ${sql.q(row.Unit || 'Nos')}, Price = ${price}, Cost = ${cost}${hasMarketMid ? `, MarketMid = ${marketMid}` : ''}, UpdatedAt = Now()
                    WHERE UniqueID = ${sql.q(uniqueId)}`);
            } else {
                await connection.execute(`INSERT INTO Inventory (UniqueID, ProductName, SpecificationCode, [Size], Description, [Length], Qty, Unit, Price, Cost, MarketMid, CreatedAt, UpdatedAt)
                    VALUES (${sql.q(uniqueId)}, ${sql.q(row.ProductName)}, ${sql.q(row.SpecificationCode)}, ${sql.q(row.Size)}, ${sql.q(row.Description)}, ${length}, ${qty}, ${sql.q(row.Unit || 'Nos')}, ${price}, ${cost}, ${hasMarketMid ? marketMid : 0}, Now(), Now())`);
            }
            processed++;
        }

        fs.unlinkSync(req.file.path);
        res.json({ success: true, processed });
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).send(err.message);
    }
});


router.get('/api/costs/compare', async (req, res) => {
    try {
        const data = await getCostComparison();
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/costs/export', async (req, res) => {
    try {
        const data = await getCostComparison();

        const excelData = data.map((row) => ({
            'Category': row.category,
            'Specification': row.name,
            'Unit': row.unit,
            'Our Cost': row.ourCost,
            'Our Price': row.ourPrice,
            'Outside Low': row.outsideLow,
            'Outside Mid': row.outsideMid,
            'Outside High': row.outsideHigh,
            'Savings vs Mid (%)': row.savingsPct + '%',
            'Our Margin (%)': row.marginPct + '%',
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
        xlsx.utils.book_append_sheet(wb, ws, 'Cost Comparison');
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Cost_Comparison.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating export');
    }
});


module.exports = router;
