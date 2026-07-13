'use strict';
const express = require('express');
const xlsx = require('xlsx');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');
const ledger = require('../services/stockLedger');
const { invoiceMutex } = require('../lib/mutex');
const { requireRole, roleOf } = require('./auth');
const { loadRateCard, getCostComparison, rateCardSet } = require('../services/ratecard');
const pricingEngine = require('../services/pricingEngine');

const adminOnly = requireRole('admin');

// SupplierID is nullable, so it needs NULL rather than sql.n()'s throw-on-blank.
function supplierRef(v) { return v == null || v === '' ? 'NULL' : sql.n(v); }

// Only admins may set cost/price/market fields. A cashier can still add or
// correct a product (name, spec, qty, unit, supplier, reorder level) but their
// pricing edits are ignored — on edit the stored values are preserved, on
// create they default to 0.
function canEditPricing(req) { return roleOf(req) === 'admin'; }
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}
const upload = multer({ dest: UPLOAD_DIR });
const router = express.Router();

router.get('/api/inventory', async (req, res) => {
    try {
        const data = await connection.query(
            `SELECT Inventory.*, Suppliers.Name AS SupplierName
             FROM Inventory LEFT JOIN Suppliers ON Inventory.SupplierID = Suppliers.SupplierID
             ORDER BY Inventory.InventoryID DESC`
        );
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Items at or below their per-item reorder threshold (defaults to 5 when unset).
router.get('/api/inventory/low-stock', async (req, res) => {
    try {
        const data = await connection.query(
            `SELECT Inventory.InventoryID, Inventory.UniqueID, Inventory.ProductName, Inventory.SpecificationCode,
                    Inventory.Qty, Inventory.Unit, COALESCE(Inventory.ReorderLevel, 5) AS ReorderLevel,
                    Suppliers.Name AS SupplierName
             FROM Inventory LEFT JOIN Suppliers ON Inventory.SupplierID = Suppliers.SupplierID
             WHERE Inventory.Qty <= COALESCE(Inventory.ReorderLevel, 5)
             ORDER BY (COALESCE(Inventory.ReorderLevel, 5) - Inventory.Qty) DESC, Inventory.Qty ASC`
        );
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
        // Attach the suggested 70%-of-market-mid unit bill (floored at cost) so the
        // invoice picker can default the rate to it. Never below cost.
        const withSuggested = data.map((r) => {
            // Priority-1 market: outside-company benchmark, else datasheet MarketMid.
            const grade = String(r.ProductName || '').trim().split(/\s+/)[0];
            const mk = pricingEngine.resolveMarket({ specCode: r.SpecificationCode, hoseGrade: grade, hoseSize: r.Size, fallbackMarket: r.MarketMid });
            const s = pricingEngine.suggestFromCostMarket(r.Cost, mk.marketPrice, { ferrule: pricingEngine.isFerrule(r.SpecificationCode) });
            return { ...r, MarketPrice: mk.marketPrice, MarketSource: mk.marketSource, SuggestedBill: s.suggestedUnit, SuggestedFloored: s.floored, PricingRuleApplied: s.rule };
        });
        res.json(withSuggested);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.post('/api/inventory', async (req, res) => {
    try {
        const { uniqueId, productName, specificationCode, size, description, length, qty, unit, price, cost, supplierId, reorderLevel } = req.body;
        if (!uniqueId || !productName) return res.status(400).json({ error: 'UniqueID and ProductName are required' });
        const check = await connection.query(`SELECT UniqueID FROM Inventory WHERE UniqueID = ${sql.q(uniqueId)}`);
        if (check.length > 0) return res.status(400).json({ error: 'UniqueID already exists' });

        // Non-admins cannot set pricing; those fields default to 0.
        const priceVal = canEditPricing(req) ? sql.n(price, 0) : 0;
        const costVal = canEditPricing(req) ? sql.n(cost, 0) : 0;
        const sqlStr = `INSERT INTO Inventory (UniqueID, ProductName, SpecificationCode, [Size], Description, [Length], Qty, Unit, Price, Cost, SupplierID, ReorderLevel, CreatedAt, UpdatedAt)
            VALUES (${sql.q(uniqueId)}, ${sql.q(productName)}, ${sql.q(specificationCode)}, ${sql.q(size)}, ${sql.q(description)}, ${sql.n(length, 0)}, ${sql.n(qty, 0)}, ${sql.q(unit)}, ${priceVal}, ${costVal}, ${supplierRef(supplierId)}, ${sql.n(reorderLevel, 5)}, Now(), Now())`;

        await connection.execute(sqlStr);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.put('/api/inventory/:id', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const { productName, specificationCode, size, description, length, qty, unit, price, cost, supplierId, reorderLevel } = req.body;

        // A cashier may edit the product but not its pricing: keep the stored
        // Cost/Price untouched for non-admins.
        let priceSet, costSet;
        if (canEditPricing(req)) {
            priceSet = `Price = ${sql.n(price, 0)}`;
            costSet = `Cost = ${sql.n(cost, 0)}`;
        } else {
            priceSet = 'Price = Price';
            costSet = 'Cost = Cost';
        }
        const sqlStr = `UPDATE Inventory SET
            ProductName = ${sql.q(productName)},
            SpecificationCode = ${sql.q(specificationCode)},
            [Size] = ${sql.q(size)},
            Description = ${sql.q(description)},
            [Length] = ${sql.n(length, 0)},
            Qty = ${sql.n(qty, 0)},
            Unit = ${sql.q(unit)},
            ${priceSet},
            ${costSet},
            SupplierID = ${supplierRef(supplierId)},
            ReorderLevel = ${sql.n(reorderLevel, 5)},
            UpdatedAt = Now()
            WHERE InventoryID = ${id}`;

        await connection.execute(sqlStr);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.delete('/api/inventory/:id', adminOnly, async (req, res) => {
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


// Record a stock purchase: logs it to Purchases, refreshes the item's
// last-purchase price/date and supplier, optionally overwrites the costing
// price, and (when qty > 0) books a stock-IN movement so quantity goes up.
// Wrapped in the invoice mutex so the Qty read-modify-write can't race a
// concurrent invoice finalize.
router.post('/api/inventory/:id/purchase', adminOnly, async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const b = req.body || {};
        const unitPrice = money.round2(money.num(b.unitPrice));
        const qty = money.round2(money.num(b.qty));
        if (!(unitPrice > 0)) return res.status(400).json({ error: 'A positive unit price is required' });

        const result = await invoiceMutex.runExclusive(async () => {
            const inv = await connection.query(`SELECT InventoryID, Cost FROM Inventory WHERE InventoryID = ${id}`);
            if (inv.length === 0) return { notFound: true };

            const supplierSet = (b.supplierId != null && b.supplierId !== '') ? `, SupplierID = ${supplierRef(b.supplierId)}` : '';
            const costSet = b.updateCost ? `, Cost = ${unitPrice}` : '';
            await connection.execute(
                `UPDATE Inventory SET LastPurchasePrice = ${unitPrice}, LastPurchaseDate = ${sql.dbDate(b.date) === 'NULL' ? 'Now()' : sql.dbDate(b.date)}${supplierSet}${costSet}, UpdatedAt = Now()
                 WHERE InventoryID = ${id}`
            );
            await connection.execute(
                `INSERT INTO Purchases (InventoryID, SupplierID, Qty, UnitPrice, PurchaseDate, Notes, CreatedAt)
                 VALUES (${id}, ${supplierRef(b.supplierId)}, ${qty}, ${unitPrice}, ${sql.dbDate(b.date) === 'NULL' ? 'Now()' : sql.dbDate(b.date)}, ${sql.q(b.notes)}, Now())`
            );

            let movement = null;
            if (qty > 0) {
                movement = await ledger.recordMovement({
                    inventoryId: id, type: 'IN', qtyChange: qty,
                    notes: `Purchase${b.notes ? ' — ' + b.notes : ''}`,
                });
            }
            return { movement };
        });

        if (result.notFound) return res.status(404).json({ error: 'Inventory item not found' });
        res.json({ success: true, newQty: result.movement ? result.movement.newQty : undefined });
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

// Crimping rates from the Rate Card, by hose size — feeds the invoice
// "Add Crimping" picker (charge = per-end rate × number of ends). Read-only, so
// any role may fetch it while billing.
router.get('/api/ratecard/crimping', async (req, res) => {
    try {
        const rows = await connection.query(
            "SELECT RateID, Label, SizeCode, SizeInch, Unit, OurCost, OurPrice FROM RateCard WHERE Category = 'crimping' ORDER BY SizeInch"
        );
        res.json(rows.map((r) => ({
            rateId: r.RateID,
            label: r.Label,
            sizeCode: r.SizeCode,
            sizeInch: r.SizeInch,
            unit: r.Unit || 'end',
            ourCost: money.round2(r.OurCost),
            ourPrice: money.round2(r.OurPrice),
        })));
    } catch (err) {
        res.status(500).json({ error: 'Could not load crimping rates. Run "npm run migrate" first. ' + err.message });
    }
});

// Column list + value tuple shared by Rate Card insert/update.

router.post('/api/ratecard', adminOnly, async (req, res) => {
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


router.put('/api/ratecard/:id', adminOnly, async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        await connection.execute(`UPDATE RateCard SET ${rateCardSet(req.body || {})} WHERE RateID = ${id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.delete('/api/ratecard/:id', adminOnly, async (req, res) => {
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
