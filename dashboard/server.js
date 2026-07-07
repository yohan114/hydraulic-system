const express = require('express');
const cors = require('cors');
const ADODB = require('node-adodb');
const path = require('path');
const xlsx = require('xlsx');
const multer = require('multer');
const fs = require('fs');

const upload = multer({ dest: 'uploads/' });
const app = express();
const PORT = 9999;

// Set up node-adodb with appropriate provider
const connectionString = `Provider=Microsoft.ACE.OLEDB.12.0;Data Source=../HydraulicHoseRepair.accdb;Persist Security Info=False;`;
const connection = ADODB.open(connectionString, true);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper for dates
const formatDbDate = (dateStr) => {
    if (!dateStr) return 'NULL';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'NULL';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `#${yyyy}-${mm}-${dd} 00:00:00#`;
};

// Helper for generating next Invoice No
async function getNextInvoiceNo(dateStr) {
    const now = dateStr ? new Date(dateStr) : new Date();
    const y = isNaN(now.getTime()) ? new Date().getFullYear() : now.getFullYear();
    const m = isNaN(now.getTime()) ? String(new Date().getMonth() + 1).padStart(2, '0') : String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `INV/${y}/${m}/`;
    
    try {
        const rows = await connection.query(`SELECT InvoiceNo FROM Invoices WHERE InStr(1, InvoiceNo, '${prefix}') = 1`);
        let maxSeq = 0;
        for (const row of rows) {
            if (!row.InvoiceNo) continue;
            const match = row.InvoiceNo.match(new RegExp(`^${prefix}(\\d+)$`));
            if (match) {
                const seq = parseInt(match[1], 10);
                if (seq > maxSeq) maxSeq = seq;
            }
        }
        return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
    } catch (e) {
        // Fallback
        return `${prefix}001`;
    }
}

// --- Dashboard & Charts ---
app.get('/api/dashboard', async (req, res) => {
    try {
        const invItems = await connection.query('SELECT COUNT(*) AS total FROM Inventory');
        const invQty = await connection.query('SELECT SUM(Qty) AS totalQty FROM Inventory');
        const lowStock = await connection.query('SELECT COUNT(*) AS lowStock FROM Inventory WHERE Qty <= 5');
        
        const recentInvoices = await connection.query('SELECT TOP 5 * FROM Invoices WHERE Status = "Finalized" ORDER BY FinalizedAt DESC');
        const movements = await connection.query('SELECT TOP 5 StockMovements.*, Inventory.ProductName FROM StockMovements LEFT JOIN Inventory ON StockMovements.InventoryID = Inventory.InventoryID ORDER BY MovementDate DESC');
        
        // Quantity by product
        const qtyByProduct = await connection.query('SELECT TOP 10 ProductName, Qty FROM Inventory ORDER BY Qty DESC');
        
        // Most used inventory items
        const topItems = await connection.query(`
            SELECT TOP 10 Inventory.ProductName, SUM(InvoiceItems.Qty) as UsedQty 
            FROM (InvoiceItems 
            INNER JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID) 
            INNER JOIN Invoices ON InvoiceItems.InvoiceID = Invoices.InvoiceID 
            WHERE Invoices.Status = 'Finalized' 
            GROUP BY Inventory.ProductName 
            ORDER BY SUM(InvoiceItems.Qty) DESC
        `);

        // Monthly invoice totals
        // For MS Access, formatting dates to YYYY-MM is tricky in SQL, doing it in JS
        const allFinalized = await connection.query(`SELECT FinalizedAt, GrandTotal FROM Invoices WHERE Status = 'Finalized'`);
        const salesByMonth = {};
        allFinalized.forEach(inv => {
            const date = new Date(inv.FinalizedAt);
            if (!isNaN(date)) {
                const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                salesByMonth[month] = (salesByMonth[month] || 0) + inv.GrandTotal;
            }
        });

        res.json({
            stats: {
                totalInventory: invItems[0]?.total || 0,
                totalQty: invQty[0]?.totalQty || 0,
                lowStock: lowStock[0]?.lowStock || 0
            },
            recentInvoices,
            movements,
            qtyByProduct,
            topItems,
            salesByMonth
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- Inventory ---
app.get('/api/inventory', async (req, res) => {
    try {
        const data = await connection.query('SELECT * FROM Inventory ORDER BY InventoryID DESC');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/inventory/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.json([]);
        const safeQ = q.replace(/'/g, "''");
        const sql = `SELECT * FROM Inventory WHERE UniqueID LIKE '%${safeQ}%' OR ProductName LIKE '%${safeQ}%' OR SpecificationCode LIKE '%${safeQ}%' OR Unit LIKE '%${safeQ}%'`;
        const data = await connection.query(sql);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/inventory', async (req, res) => {
    try {
        const { uniqueId, productName, specificationCode, size, description, length, qty, unit, price } = req.body;
        // Check duplicate UniqueID
        const check = await connection.query(`SELECT UniqueID FROM Inventory WHERE UniqueID = '${uniqueId.replace(/'/g, "''")}'`);
        if (check.length > 0) return res.status(400).json({ error: 'UniqueID already exists' });

        const sql = `INSERT INTO Inventory (UniqueID, ProductName, SpecificationCode, [Size], Description, [Length], Qty, Unit, Price, CreatedAt, UpdatedAt) 
            VALUES ('${uniqueId.replace(/'/g, "''")}', '${productName.replace(/'/g, "''")}', '${specificationCode.replace(/'/g, "''")}', '${(size || '').replace(/'/g, "''")}', '${(description || '').replace(/'/g, "''")}', ${parseFloat(length)}, ${parseFloat(qty)}, '${unit.replace(/'/g, "''")}', ${parseFloat(price || 0)}, Now(), Now())`;
        
        await connection.execute(sql);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/inventory/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { productName, specificationCode, size, description, length, qty, unit, price } = req.body;
        const sql = `UPDATE Inventory SET 
            ProductName = '${productName.replace(/'/g, "''")}', 
            SpecificationCode = '${specificationCode.replace(/'/g, "''")}', 
            [Size] = '${(size || '').replace(/'/g, "''")}', 
            Description = '${(description || '').replace(/'/g, "''")}', 
            [Length] = ${parseFloat(length)}, 
            Qty = ${parseFloat(qty)}, 
            Unit = '${unit.replace(/'/g, "''")}', 
            Price = ${parseFloat(price || 0)},
            UpdatedAt = Now() 
            WHERE InventoryID = ${id}`;
        
        await connection.execute(sql);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/inventory/:id', async (req, res) => {
    try {
        const { id } = req.params;
        // Check if used in invoice
        const check = await connection.query(`SELECT InvoiceItemID FROM InvoiceItems WHERE InventoryID = ${id}`);
        if (check.length > 0) return res.status(400).json({ error: 'Cannot delete: item is used in invoice history' });

        await connection.execute(`DELETE FROM Inventory WHERE InventoryID = ${id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Invoices ---
app.get('/api/invoices', async (req, res) => {
    try {
        const data = await connection.query('SELECT * FROM Invoices ORDER BY InvoiceID DESC');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/invoices/next-no', async (req, res) => {
    try {
        const { date } = req.query;
        const nextNo = await getNextInvoiceNo(date);
        res.json({ nextInvoiceNo: nextNo });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Export Invoices in one excel sheet
app.get('/api/invoices/export', async (req, res) => {
    try {
        const sql = `
            SELECT Invoices.InvoiceNo, InvoiceItems.ItemDescription, InvoiceItems.Unit, InvoiceItems.Qty, InvoiceItems.Rate, InvoiceItems.Amount, Invoices.GrandTotal 
            FROM Invoices 
            INNER JOIN InvoiceItems ON Invoices.InvoiceID = InvoiceItems.InvoiceID 
            ORDER BY Invoices.InvoiceID DESC, InvoiceItems.InvoiceItemID ASC
        `;
        const data = await connection.query(sql);
        
        // Map fields to clean headers requested by the user
        const formattedData = data.map(row => ({
            'Invoice Number': row.InvoiceNo,
            'Description': row.ItemDescription,
            'Unit': row.Unit,
            'Qty': row.Qty,
            'Rate': row.Rate,
            'Amount': row.Amount,
            'Total Amount': row.GrandTotal
        }));

        const ws = xlsx.utils.json_to_sheet(formattedData);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, "Invoices");
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Invoices_Export.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating export');
    }
});

app.get('/api/invoices/:id', async (req, res) => {
    try {
        const invoice = await connection.query(`SELECT * FROM Invoices WHERE InvoiceID = ${req.params.id}`);
        if (invoice.length === 0) return res.status(404).json({ error: 'Invoice not found' });
        
        const items = await connection.query(`
            SELECT InvoiceItems.*, Inventory.ProductName, Inventory.SpecificationCode 
            FROM InvoiceItems 
            LEFT JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID 
            WHERE InvoiceItems.InvoiceID = ${req.params.id}
        `);
        
        res.json({ ...invoice[0], items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create/Update Draft Invoice
app.post('/api/invoices/draft', async (req, res) => {
    try {
        const { invoiceNo, invoiceDate, poNo, poDate, deliveryDate, billedToName, billedToAddress, deliveredToName, deliveredToAddress, subTotal, ssclRate, ssclAmount, vatRate, vatAmount, grandTotal, items } = req.body;
        
        // Basic check
        if (!invoiceNo) return res.status(400).json({ error: 'InvoiceNo required' });
        let finalInvoiceNo = invoiceNo;
        if (!finalInvoiceNo || finalInvoiceNo === 'AUTO') {
            finalInvoiceNo = await getNextInvoiceNo(invoiceDate);
        }
        
        const safeStr = (s) => (s || '').toString().replace(/'/g, "''");

        // Insert Invoice header
        const insertInvoiceSql = `INSERT INTO Invoices (InvoiceNo, InvoiceDate, PONo, PODate, DeliveryDate, BilledToName, BilledToAddress, DeliveredToName, DeliveredToAddress, SubTotal, SSCLRate, SSCLAmount, VATRate, VATAmount, GrandTotal, Status, CreatedAt) 
            VALUES ('${safeStr(finalInvoiceNo)}', ${formatDbDate(invoiceDate)}, '${safeStr(poNo)}', ${formatDbDate(poDate)}, ${formatDbDate(deliveryDate)}, '${safeStr(billedToName)}', '${safeStr(billedToAddress)}', '${safeStr(deliveredToName)}', '${safeStr(deliveredToAddress)}', ${subTotal || 0}, ${ssclRate || 0}, ${ssclAmount || 0}, ${vatRate || 0}, ${vatAmount || 0}, ${grandTotal || 0}, 'Draft', Now())`;
        
        await connection.execute(insertInvoiceSql);
        
        const invoiceData = await connection.query(`SELECT TOP 1 InvoiceID FROM Invoices ORDER BY InvoiceID DESC`);
        const invoiceId = invoiceData[0].InvoiceID;

        // Insert Items
        if (items && items.length > 0) {
            for (const item of items) {
                const invIdVal = item.inventoryId ? item.inventoryId : 'NULL';
                await connection.execute(`INSERT INTO InvoiceItems (InvoiceID, InventoryID, ItemDescription, Unit, [Length], Qty, Rate, Amount) 
                    VALUES (${invoiceId}, ${invIdVal}, '${safeStr(item.description)}', '${safeStr(item.unit)}', ${item.length || 0}, ${item.qty || 0}, ${item.rate || 0}, ${item.amount || 0})`);
            }
        }
        
        res.json({ success: true, invoiceId, invoiceNo: finalInvoiceNo });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Finalize Invoice
app.post('/api/invoices/finalize', async (req, res) => {
    let invoiceId = null;
    try {
        const { invoiceNo, invoiceDate, poNo, poDate, deliveryDate, billedToName, billedToAddress, deliveredToName, deliveredToAddress, subTotal, ssclRate, ssclAmount, vatRate, vatAmount, grandTotal, items } = req.body;
        
        if (!items || items.length === 0) return res.status(400).json({ error: 'Invoice must have at least one item' });
        
        // 1. Validate Stock
        for (const item of items) {
            if (item.qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than zero' });
            
            if (item.inventoryId) {
                const inv = await connection.query(`SELECT Qty, ProductName FROM Inventory WHERE InventoryID = ${item.inventoryId}`);
                if (inv.length === 0) return res.status(400).json({ error: `Inventory item ${item.inventoryId} not found` });
                if (inv[0].Qty < item.qty) {
                    return res.status(400).json({ error: `Not enough stock for ${inv[0].ProductName}. Available: ${inv[0].Qty}, Requested: ${item.qty}` });
                }
            }
        }
        
        let finalInvoiceNo = invoiceNo;
        if (!finalInvoiceNo || finalInvoiceNo === 'AUTO') {
            finalInvoiceNo = await getNextInvoiceNo(invoiceDate);
        }

        const safeStr = (s) => (s || '').toString().replace(/'/g, "''");

        // 2. Insert Invoice
        const insertInvoiceSql = `INSERT INTO Invoices (InvoiceNo, InvoiceDate, PONo, PODate, DeliveryDate, BilledToName, BilledToAddress, DeliveredToName, DeliveredToAddress, SubTotal, SSCLRate, SSCLAmount, VATRate, VATAmount, GrandTotal, Status, CreatedAt, FinalizedAt) 
            VALUES ('${safeStr(finalInvoiceNo)}', ${formatDbDate(invoiceDate)}, '${safeStr(poNo)}', ${formatDbDate(poDate)}, ${formatDbDate(deliveryDate)}, '${safeStr(billedToName)}', '${safeStr(billedToAddress)}', '${safeStr(deliveredToName)}', '${safeStr(deliveredToAddress)}', ${subTotal || 0}, ${ssclRate || 0}, ${ssclAmount || 0}, ${vatRate || 0}, ${vatAmount || 0}, ${grandTotal || 0}, 'Finalized', Now(), Now())`;
        
        await connection.execute(insertInvoiceSql);
        
        const invoiceData = await connection.query(`SELECT TOP 1 InvoiceID FROM Invoices ORDER BY InvoiceID DESC`);
        invoiceId = invoiceData[0].InvoiceID;

        // 3. Process Items and Deduct Stock
        for (const item of items) {
            const invIdVal = item.inventoryId ? item.inventoryId : 'NULL';
            // Insert Item
            await connection.execute(`INSERT INTO InvoiceItems (InvoiceID, InventoryID, ItemDescription, Unit, [Length], Qty, Rate, Amount) 
                VALUES (${invoiceId}, ${invIdVal}, '${safeStr(item.description)}', '${safeStr(item.unit)}', ${item.length || 0}, ${item.qty || 0}, ${item.rate || 0}, ${item.amount || 0})`);
            
            if (item.inventoryId) {
                // Get current Qty
                const inv = await connection.query(`SELECT Qty FROM Inventory WHERE InventoryID = ${item.inventoryId}`);
                const prevQty = inv[0].Qty;
                const newQty = prevQty - item.qty;
                
                // Update Inventory Qty
                await connection.execute(`UPDATE Inventory SET Qty = ${newQty}, UpdatedAt = Now() WHERE InventoryID = ${item.inventoryId}`);
                
                // Insert Stock Movement
                await connection.execute(`INSERT INTO StockMovements (InventoryID, InvoiceID, MovementType, QtyChange, PreviousQty, NewQty, MovementDate, Notes) 
                    VALUES (${item.inventoryId}, ${invoiceId}, 'OUT', ${-item.qty}, ${prevQty}, ${newQty}, Now(), 'Invoice Finalized ${safeStr(finalInvoiceNo)}')`);
            }
        }
        
        res.json({ success: true, invoiceId, invoiceNo: finalInvoiceNo });
    } catch (err) {
        // Simple manual rollback if invoice was created but something failed
        if (invoiceId) {
            try {
                // Revert stock manually
                const itemsQ = await connection.query(`SELECT InventoryID, Qty FROM InvoiceItems WHERE InvoiceID = ${invoiceId}`);
                for (const item of itemsQ) {
                    await connection.execute(`UPDATE Inventory SET Qty = Qty + ${item.Qty} WHERE InventoryID = ${item.InventoryID}`);
                    await connection.execute(`DELETE FROM StockMovements WHERE InvoiceID = ${invoiceId} AND InventoryID = ${item.InventoryID}`);
                }
                await connection.execute(`DELETE FROM InvoiceItems WHERE InvoiceID = ${invoiceId}`);
                await connection.execute(`DELETE FROM Invoices WHERE InvoiceID = ${invoiceId}`);
            } catch (rollbackErr) {
                console.error('Rollback failed:', rollbackErr);
            }
        }
        res.status(500).json({ error: err.message });
    }
});

// --- Stock Movements ---
app.get('/api/movements', async (req, res) => {
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

// Export Stock Movements as Excel sheet
app.get('/api/movements/export', async (req, res) => {
    try {
        const sql = `
            SELECT StockMovements.MovementDate, Invoices.InvoiceNo, Inventory.UniqueID, Inventory.SpecificationCode, Inventory.ProductName, StockMovements.MovementType, StockMovements.QtyChange, StockMovements.PreviousQty, StockMovements.NewQty, StockMovements.Notes 
            FROM (StockMovements 
            LEFT JOIN Inventory ON StockMovements.InventoryID = Inventory.InventoryID)
            LEFT JOIN Invoices ON StockMovements.InvoiceID = Invoices.InvoiceID 
            ORDER BY StockMovements.MovementID DESC
        `;
        const data = await connection.query(sql);
        
        // Format for Excel columns
        const excelData = data.map(row => ({
            'Date': row.MovementDate ? new Date(row.MovementDate).toLocaleDateString() : '',
            'Invoice Number': row.InvoiceNo || 'N/A',
            'Unique ID': row.UniqueID || 'N/A',
            'Spec Code': row.SpecificationCode || 'N/A',
            'Product Name': row.ProductName || 'N/A',
            'Movement Type': row.MovementType,
            'Quantity Change': row.QtyChange,
            'Previous Quantity': row.PreviousQty,
            'New Quantity': row.NewQty,
            'Notes': row.Notes || ''
        }));

        const ws = xlsx.utils.json_to_sheet(excelData);
        
        // Auto-fit column widths
        const maxLens = {};
        excelData.forEach(row => {
            Object.keys(row).forEach(key => {
                const len = String(row[key] || '').length;
                maxLens[key] = Math.max(maxLens[key] || key.length, len);
            });
        });
        ws['!cols'] = Object.keys(maxLens).map(key => ({ wch: maxLens[key] + 4 }));

        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, "Stock Movements");
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Stock_Movements_Export.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating export');
    }
});

// --- Import and Export ---
app.get('/api/inventory/export', async (req, res) => {
    try {
        const data = await connection.query('SELECT * FROM Inventory ORDER BY InventoryID ASC');
        const ws = xlsx.utils.json_to_sheet(data);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, "Inventory");
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Inventory_Export.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        res.status(500).send('Error generating export');
    }
});

app.post('/api/inventory/import', upload.single('file'), async (req, res) => {
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
            
            const name = (row.ProductName || '').toString().replace(/'/g, "''");
            const spec = (row.SpecificationCode || '').toString().replace(/'/g, "''");
            const size = (row.Size || '').toString().replace(/'/g, "''");
            const desc = (row.Description || '').toString().replace(/'/g, "''");
            const length = parseFloat(row.Length) || 0;
            const qty = parseFloat(row.Qty) || 0;
            const unit = (row.Unit || 'Nos').toString().replace(/'/g, "''");
            const price = parseFloat(row.Price) || 0;
            const uIdSafe = uniqueId.replace(/'/g, "''");

            const existing = await connection.query(`SELECT InventoryID FROM Inventory WHERE UniqueID = '${uIdSafe}'`);
            if (existing.length > 0) {
                await connection.execute(`UPDATE Inventory SET 
                    ProductName = '${name}', SpecificationCode = '${spec}', [Size] = '${size}', Description = '${desc}', 
                    [Length] = ${length}, Qty = ${qty}, Unit = '${unit}', Price = ${price}, UpdatedAt = Now() 
                    WHERE UniqueID = '${uIdSafe}'`);
            } else {
                await connection.execute(`INSERT INTO Inventory (UniqueID, ProductName, SpecificationCode, [Size], Description, [Length], Qty, Unit, Price, CreatedAt, UpdatedAt) 
                    VALUES ('${uIdSafe}', '${name}', '${spec}', '${size}', '${desc}', ${length}, ${qty}, '${unit}', ${price}, Now(), Now())`);
            }
            processed++;
        }
        
        fs.unlinkSync(req.file.path);
        res.json({ success: true, processed });
    } catch (err) {
        if(fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).send(err.message);
    }
});

// --- Cost Comparison Analysis ---
const costComparisonList = [
    { name: '1/4" R1', spec: 'R1', size: 0.25, outsideCost: 950 },
    { name: '5/16" R1', spec: 'R1', size: 0.3125, outsideCost: 1050 },
    { name: '3/8" R1', spec: 'R1', size: 0.375, outsideCost: 1150 },
    { name: '1/4" R2', spec: 'R2', size: 0.25, outsideCost: 1200 },
    { name: '5/16" R2', spec: 'R2', size: 0.3125, outsideCost: 1300 },
    { name: '3/8" R2', spec: 'R2', size: 0.375, outsideCost: 1400 },
    { name: '1/2" R2', spec: 'R2', size: 0.5, outsideCost: 1600 },
    { name: '5/8" R2', spec: 'R2', size: 0.625, outsideCost: 1950 },
    { name: '3/4" R2', spec: 'R2', size: 0.75, outsideCost: 2300 },
    { name: '1" R2', spec: 'R2', size: 1.0, outsideCost: 3000 },
    { name: '1-1/4" R2', spec: 'R2', size: 1.25, outsideCost: 3950 },
    { name: '5/8" 4SP', spec: '4SP', size: 0.625, outsideCost: 2900 },
    { name: '3/4" 4SH', spec: '4SH', size: 0.75, outsideCost: 3800 },
    { name: '1" 4SH', spec: '4SH', size: 1.0, outsideCost: 4700 },
    { name: '1-1/4" 4SH', spec: '4SH', size: 1.25, outsideCost: 5900 }
];

async function getCostComparison(connection) {
    const inventory = await connection.query("SELECT * FROM Inventory WHERE ProductName LIKE '%Rubber pipe%'");
    
    return costComparisonList.map(item => {
        // Find matching item in our database
        // Matches spec in name and size
        const match = inventory.find(inv => {
            const nameUpper = (inv.ProductName || '').toUpperCase();
            const invSize = parseFloat(inv.Size) || 0;
            return nameUpper.includes(item.spec) && Math.abs(invSize - item.size) < 0.001;
        });

        const ourPriceMeter = match ? parseFloat(match.Price || 0) : 0;
        // Conversion factor: 1 meter = 3.28084 feet
        const ourPriceFoot = parseFloat((ourPriceMeter / 3.28084).toFixed(2));
        const diffFoot = parseFloat((item.outsideCost - ourPriceFoot).toFixed(2));
        const savingsPct = item.outsideCost > 0 ? parseFloat(((diffFoot / item.outsideCost) * 100).toFixed(1)) : 0;

        return {
            name: item.name,
            spec: item.spec,
            size: item.size,
            ourPriceMeter: ourPriceMeter,
            ourPriceFoot: ourPriceFoot,
            outsideCost: item.outsideCost,
            diffFoot: diffFoot,
            savingsPct: savingsPct,
            matched: !!match
        };
    });
}

// Helper to match an invoice item against our costComparisonList
function matchInvoiceItemToOutsideCost(productName, specCode) {
    if (!productName || !specCode) return null;
    
    const nameUpper = productName.toUpperCase();
    let spec = null;
    if (nameUpper.includes('R1')) spec = 'R1';
    else if (nameUpper.includes('R2')) spec = 'R2';
    else if (nameUpper.includes('4SP')) spec = '4SP';
    else if (nameUpper.includes('4SH')) spec = '4SH';
    
    if (!spec) return null;
    
    const sizeMap = {
        '6': 0.25,     // 1/4"
        '8': 0.3125,   // 5/16"
        '10': 0.375,   // 3/8"
        '13': 0.5,     // 1/2"
        '16': 0.625,   // 5/8"
        '19': 0.75,    // 3/4"
        '25': 1.0,     // 1"
        '32': 1.25     // 1-1/4"
    };
    
    const size = sizeMap[specCode.toString().trim()];
    if (size === undefined) return null;
    
    return costComparisonList.find(c => c.spec === spec && Math.abs(c.size - size) < 0.001);
}

// Compare single invoice against outside rates (including SSCL and VAT)
app.get('/api/invoices/:id/compare', async (req, res) => {
    try {
        const invoice = await connection.query(`SELECT * FROM Invoices WHERE InvoiceID = ${req.params.id}`);
        if (invoice.length === 0) return res.status(404).json({ error: 'Invoice not found' });
        
        const items = await connection.query(`
            SELECT InvoiceItems.*, Inventory.ProductName, Inventory.SpecificationCode 
            FROM InvoiceItems 
            LEFT JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID 
            WHERE InvoiceItems.InvoiceID = ${req.params.id}
        `);

        let ourSubtotal = 0;
        let outsideSubtotal = 0;

        const comparedItems = items.map(item => {
            const ourAmt = parseFloat(item.Amount || 0);
            ourSubtotal += ourAmt;

            // Check if matches outside hose price
            const match = matchInvoiceItemToOutsideCost(item.ProductName, item.SpecificationCode);
            let outsideAmt = 0; // Default to 0 (labor, fittings, sundries included in outside hose price)
            let outsideRate = 0; // Default to 0
            let matched = false;

            if (match) {
                // Formula: length (feet) = Qty (meters) * 3.28084
                const qtyMeters = parseFloat(item.Qty || 0);
                const lengthFeet = qtyMeters * 3.28084;
                
                outsideAmt = parseFloat((lengthFeet * match.outsideCost).toFixed(2));
                outsideRate = match.outsideCost; // Rate per foot
                matched = true;
            }

            outsideSubtotal += outsideAmt;

            return {
                description: item.ItemDescription,
                unit: item.Unit,
                qty: item.Qty,
                ourRate: item.Rate,
                ourAmount: ourAmt,
                outsideRate: outsideRate,
                outsideAmount: outsideAmt,
                matched: matched,
                outsideUnit: matched ? 'ft' : item.Unit,
                outsideQty: matched ? parseFloat((item.Qty * 3.28084).toFixed(2)) : item.Qty
            };
        });

        // VAT & SSCL calculations
        const ssclRate = parseFloat(invoice[0].SSCLRate || 0);
        const vatRate = parseFloat(invoice[0].VATRate || 0);

        const ourSscl = parseFloat((ourSubtotal * (ssclRate / 100)).toFixed(2));
        const ourPreVat = ourSubtotal + ourSscl;
        const ourVat = parseFloat((ourPreVat * (vatRate / 100)).toFixed(2));
        const ourGrandTotal = ourPreVat + ourVat;

        const outsideSscl = 0; // Outside has no SSCL
        const outsideVat = 0; // Outside has no VAT
        const outsideGrandTotal = outsideSubtotal; // Grand total is just the subtotal

        const netSavings = parseFloat((outsideGrandTotal - ourGrandTotal).toFixed(2));

        res.json({
            invoiceNo: invoice[0].InvoiceNo,
            invoiceDate: invoice[0].InvoiceDate,
            billedToName: invoice[0].BilledToName,
            taxes: {
                ssclRate,
                vatRate,
                ourSubtotal: parseFloat(ourSubtotal.toFixed(2)),
                ourSscl,
                ourVat,
                ourGrandTotal: parseFloat(ourGrandTotal.toFixed(2)),
                outsideSubtotal: parseFloat(outsideSubtotal.toFixed(2)),
                outsideSscl,
                outsideVat,
                outsideGrandTotal: parseFloat(outsideGrandTotal.toFixed(2)),
                netSavings
            },
            items: comparedItems
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Export single invoice comparison as Excel sheet
app.get('/api/invoices/:id/compare-export', async (req, res) => {
    try {
        const invoice = await connection.query(`SELECT * FROM Invoices WHERE InvoiceID = ${req.params.id}`);
        if (invoice.length === 0) return res.status(404).send('Invoice not found');
        
        const items = await connection.query(`
            SELECT InvoiceItems.*, Inventory.ProductName, Inventory.SpecificationCode 
            FROM InvoiceItems 
            LEFT JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID 
            WHERE InvoiceItems.InvoiceID = ${req.params.id}
        `);

        let ourSubtotal = 0;
        let outsideSubtotal = 0;

        const excelRows = items.map((item, idx) => {
            const ourAmt = parseFloat(item.Amount || 0);
            ourSubtotal += ourAmt;

            const match = matchInvoiceItemToOutsideCost(item.ProductName, item.SpecificationCode);
            let outsideAmt = 0; // Default to 0 (labor, fittings, sundries included in outside hose price)
            let outsideRate = 0; // Default to 0
            let matched = false;

            if (match) {
                const qtyMeters = parseFloat(item.Qty || 0);
                const lengthFeet = qtyMeters * 3.28084;
                outsideAmt = parseFloat((lengthFeet * match.outsideCost).toFixed(2));
                outsideRate = match.outsideCost;
                matched = true;
            }

            outsideSubtotal += outsideAmt;

            return {
                '#': String(idx + 1).padStart(2, '0'),
                'Description': item.ItemDescription,
                'Our Qty': item.Qty,
                'Our Unit': item.Unit,
                'Our Rate (Rs.)': item.Rate,
                'Our Amount (Rs.)': ourAmt,
                'Outside Qty': matched ? parseFloat((item.Qty * 3.28084).toFixed(2)) : item.Qty,
                'Outside Unit': matched ? 'ft' : item.Unit,
                'Outside Rate (Rs.)': outsideRate,
                'Outside Amount (Rs.)': outsideAmt,
                'Savings (Rs.)': parseFloat((outsideAmt - ourAmt).toFixed(2))
            };
        });

        // Compute taxes
        const ssclRate = parseFloat(invoice[0].SSCLRate || 0);
        const vatRate = parseFloat(invoice[0].VATRate || 0);

        const ourSscl = parseFloat((ourSubtotal * (ssclRate / 100)).toFixed(2));
        const ourVat = parseFloat(((ourSubtotal + ourSscl) * (vatRate / 100)).toFixed(2));
        const ourGrand = ourSubtotal + ourSscl + ourVat;

        const outsideSscl = 0; // Outside has no SSCL
        const outsideVat = 0; // Outside has no VAT
        const outsideGrand = outsideSubtotal; // Grand total is just the subtotal

        const netSavings = outsideGrand - ourGrand;

        // Add blank rows and summary rows
        excelRows.push({}); // Empty separator row
        excelRows.push({ 'Description': 'SUBTOTAL', 'Our Amount (Rs.)': ourSubtotal, 'Outside Amount (Rs.)': outsideSubtotal, 'Savings (Rs.)': outsideSubtotal - ourSubtotal });
        excelRows.push({ 'Description': `SSCL (${ssclRate}%)`, 'Our Amount (Rs.)': ourSscl, 'Outside Amount (Rs.)': outsideSscl, 'Savings (Rs.)': outsideSscl - ourSscl });
        excelRows.push({ 'Description': `VAT (${vatRate}%)`, 'Our Amount (Rs.)': ourVat, 'Outside Amount (Rs.)': outsideVat, 'Savings (Rs.)': outsideVat - ourVat });
        excelRows.push({ 'Description': 'GRAND TOTAL', 'Our Amount (Rs.)': ourGrand, 'Outside Amount (Rs.)': outsideGrand, 'Savings (Rs.)': netSavings });

        const ws = xlsx.utils.json_to_sheet(excelRows);
        
        // Auto-fit column widths
        const maxLens = {};
        excelRows.forEach(row => {
            Object.keys(row).forEach(key => {
                const len = String(row[key] || '').length;
                maxLens[key] = Math.max(maxLens[key] || key.length, len);
            });
        });
        ws['!cols'] = Object.keys(maxLens).map(key => ({ wch: maxLens[key] + 4 }));

        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, "Invoice Comparison");
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

app.get('/api/costs/compare', async (req, res) => {
    try {
        const data = await getCostComparison(connection);
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/costs/export', async (req, res) => {
    try {
        const data = await getCostComparison(connection);
        
        // Format for Excel columns
        const excelData = data.map(row => ({
            'Hose Specification': row.name,
            'Our Cost (per Meter)': row.ourPriceMeter,
            'Our Cost (per Foot)': row.ourPriceFoot,
            'Outside Cost (per Foot)': row.outsideCost,
            'Savings (per Foot)': row.diffFoot,
            'Savings (%)': row.savingsPct + '%'
        }));

        const ws = xlsx.utils.json_to_sheet(excelData);
        
        // Auto-fit column widths
        const maxLens = {};
        excelData.forEach(row => {
            Object.keys(row).forEach(key => {
                const len = String(row[key] || '').length;
                maxLens[key] = Math.max(maxLens[key] || key.length, len);
            });
        });
        ws['!cols'] = Object.keys(maxLens).map(key => ({ wch: maxLens[key] + 4 }));

        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, "Cost Comparison");
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Disposition', 'attachment; filename="Cost_Comparison.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error generating export');
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
