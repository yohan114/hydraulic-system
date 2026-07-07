const express = require('express');
const cors = require('cors');
const ADODB = require('node-adodb');
const path = require('path');
const xlsx = require('xlsx');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

// --- Billing engine & helpers (pure, unit-tested in ./test) ---
const money = require('./lib/money');
const billing = require('./lib/billing');
const invoiceNoLib = require('./lib/invoiceNo');
const authLib = require('./lib/auth');
const sql = require('./lib/sql');
const { Mutex } = require('./lib/mutex');
const { ensureSchema } = require('./migrate');

const PORT = process.env.PORT || 9999;
const AUTH_ENABLED = process.env.BILLING_AUTH !== 'off';
const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 hours

// Ensure the multer upload dir exists (node-multer will not create it).
const UPLOAD_DIR = path.join(__dirname, 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}
const upload = multer({ dest: UPLOAD_DIR });

const app = express();

// Set up node-adodb with appropriate provider
const connectionString = `Provider=Microsoft.ACE.OLEDB.12.0;Data Source=../HydraulicHoseRepair.accdb;Persist Security Info=False;`;
const connection = ADODB.open(connectionString, true);

// Serialises invoice creation/finalisation so concurrent requests can never be
// handed the same invoice number or race the stock deduction (see lib/mutex.js).
const invoiceMutex = new Mutex();

app.use(cors());
app.use(express.json());

// ============================================================
// Authentication
// ============================================================

// A stable signing secret is persisted so tokens survive server restarts.
// It lives outside version control (.gitignore) and is generated on first run.
const SECRET_FILE = path.join(__dirname, '.auth-secret');
function loadOrCreateSecret() {
    if (process.env.BILLING_SECRET) return process.env.BILLING_SECRET;
    try {
        if (fs.existsSync(SECRET_FILE)) {
            const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
            if (s) return s;
        }
    } catch (_) {}
    const secret = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 }); } catch (_) {}
    return secret;
}
const AUTH_SECRET = loadOrCreateSecret();

// Fallback password used when no user has been provisioned in the Users table.
const DEFAULT_USERNAME = 'admin';
const FALLBACK_PASSWORD = process.env.BILLING_PASSWORD || 'admin123';

// Whether the Users table has been provisioned with at least one credential.
// Returns { provisioned, tableMissing }. tableMissing is true only when the
// Users table does not exist yet (fresh, un-migrated database).
async function provisioningState() {
    try {
        const rows = await connection.query('SELECT COUNT(*) AS c FROM Users');
        return { provisioned: ((rows[0] && rows[0].c) || 0) > 0, tableMissing: false };
    } catch (_) {
        return { provisioned: false, tableMissing: true };
    }
}

// Whether at least one user row exists (used to warn about the default password).
async function hasProvisionedUser() {
    const state = await provisioningState();
    return state.provisioned;
}

// Returns { ok, username } after checking credentials.
//
// Security policy (fails CLOSED):
//   - Once ANY user exists, only stored (hashed) credentials are accepted; the
//     built-in default is disabled and a lookup error denies access rather than
//     falling back to it.
//   - The default admin/admin123 is accepted ONLY to bootstrap a database that
//     has no users yet (empty or un-migrated Users table).
async function checkCredentials(username, password) {
    const uname = String(username || '').trim() || DEFAULT_USERNAME;
    const { provisioned } = await provisioningState();

    if (provisioned) {
        try {
            const rows = await connection.query(
                `SELECT PasswordHash FROM Users WHERE Username = ${sql.q(uname)}`
            );
            if (rows.length > 0 && rows[0].PasswordHash) {
                return { ok: authLib.verifyPassword(password, rows[0].PasswordHash), username: uname };
            }
        } catch (_) {
            // Fall through and deny — never re-enable the default on an error.
        }
        return { ok: false, username: uname }; // unknown user / lookup failed -> deny
    }

    // No users provisioned yet: allow the bootstrap default so setup is possible.
    const ok = uname === DEFAULT_USERNAME && String(password) === FALLBACK_PASSWORD;
    return { ok, username: uname };
}

function extractToken(req) {
    const header = req.headers['authorization'] || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    if (req.query && req.query.token) return String(req.query.token);
    return null;
}

// Gate mounted on /api (after the public auth routes below).
function requireAuth(req, res, next) {
    if (!AUTH_ENABLED) return next();
    const token = extractToken(req);
    const claims = token ? authLib.verifyToken(token, AUTH_SECRET) : null;
    if (!claims) {
        return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    }
    req.user = claims;
    next();
}

// --- Public auth endpoints ---
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!password) return res.status(400).json({ error: 'Password is required' });
        const result = await checkCredentials(username, password);
        if (!result.ok) return res.status(401).json({ error: 'Invalid username or password' });
        const token = authLib.createToken({ sub: result.username }, AUTH_SECRET, TOKEN_TTL_SECONDS);
        res.json({ token, username: result.username, expiresIn: TOKEN_TTL_SECONDS });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/status', async (req, res) => {
    const token = extractToken(req);
    const claims = token ? authLib.verifyToken(token, AUTH_SECRET) : null;
    res.json({
        authEnabled: AUTH_ENABLED,
        authenticated: !!claims || !AUTH_ENABLED,
        username: claims ? claims.sub : null,
        usingDefaultPassword: AUTH_ENABLED ? !(await hasProvisionedUser()) : false,
    });
});

// Everything below /api requires a valid token.
app.use('/api', requireAuth);

// Change the current user's password (provisions the Users table row).
app.post('/api/auth/change-password', async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!newPassword || String(newPassword).length < 4) {
            return res.status(400).json({ error: 'New password must be at least 4 characters' });
        }
        const username = (req.user && req.user.sub) || DEFAULT_USERNAME;
        const check = await checkCredentials(username, currentPassword);
        if (!check.ok) return res.status(401).json({ error: 'Current password is incorrect' });

        const hash = authLib.hashPassword(newPassword);
        const existing = await connection.query(`SELECT UserID FROM Users WHERE Username = ${sql.q(username)}`);
        if (existing.length > 0) {
            await connection.execute(
                `UPDATE Users SET PasswordHash = ${sql.q(hash)}, UpdatedAt = Now() WHERE Username = ${sql.q(username)}`
            );
        } else {
            await connection.execute(
                `INSERT INTO Users (Username, PasswordHash, Role, CreatedAt, UpdatedAt)
                 VALUES (${sql.q(username)}, ${sql.q(hash)}, 'admin', Now(), Now())`
            );
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not change password. Run "npm run migrate" first. ' + err.message });
    }
});

// Static assets (served without auth; the API gate protects all data).
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// Invoice numbering
// ============================================================
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
app.get('/api/dashboard', async (req, res) => {
    try {
        const invItems = await connection.query('SELECT COUNT(*) AS total FROM Inventory');
        const invQty = await connection.query('SELECT SUM(Qty) AS totalQty FROM Inventory');
        const lowStock = await connection.query('SELECT COUNT(*) AS lowStock FROM Inventory WHERE Qty <= 5');

        const recentInvoices = await connection.query('SELECT TOP 5 * FROM Invoices WHERE Status = "Finalized" ORDER BY FinalizedAt DESC');
        const movements = await connection.query('SELECT TOP 5 StockMovements.*, Inventory.ProductName FROM StockMovements LEFT JOIN Inventory ON StockMovements.InventoryID = Inventory.InventoryID ORDER BY MovementDate DESC');

        const qtyByProduct = await connection.query('SELECT TOP 10 ProductName, Qty FROM Inventory ORDER BY Qty DESC');

        const topItems = await connection.query(`
            SELECT TOP 10 Inventory.ProductName, SUM(InvoiceItems.Qty) as UsedQty
            FROM (InvoiceItems
            INNER JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID)
            INNER JOIN Invoices ON InvoiceItems.InvoiceID = Invoices.InvoiceID
            WHERE Invoices.Status = 'Finalized'
            GROUP BY Inventory.ProductName
            ORDER BY SUM(InvoiceItems.Qty) DESC
        `);

        const allFinalized = await connection.query(`SELECT FinalizedAt, GrandTotal FROM Invoices WHERE Status = 'Finalized'`);
        const salesByMonth = {};
        allFinalized.forEach((inv) => {
            const date = new Date(inv.FinalizedAt);
            if (!isNaN(date)) {
                const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                salesByMonth[month] = (salesByMonth[month] || 0) + money.num(inv.GrandTotal);
            }
        });

        // Accounts receivable (outstanding balances on finalized, non-cancelled invoices).
        let outstandingTotal = 0;
        let outstandingCount = 0;
        try {
            const ar = await connection.query(
                `SELECT GrandTotal, AmountPaid FROM Invoices WHERE Status = 'Finalized'`
            );
            ar.forEach((inv) => {
                const bal = money.round2(money.num(inv.GrandTotal) - money.num(inv.AmountPaid));
                if (bal > 0) { outstandingTotal += bal; outstandingCount++; }
            });
            outstandingTotal = money.round2(outstandingTotal);
        } catch (_) {
            // AmountPaid column not present yet (run migrate) -> report zero AR.
        }

        res.json({
            stats: {
                totalInventory: invItems[0]?.total || 0,
                totalQty: invQty[0]?.totalQty || 0,
                lowStock: lowStock[0]?.lowStock || 0,
                outstandingTotal,
                outstandingCount,
            },
            recentInvoices,
            movements,
            qtyByProduct,
            topItems,
            salesByMonth,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Inventory
// ============================================================
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
        const safeQ = sql.esc(q);
        const sqlStr = `SELECT * FROM Inventory WHERE UniqueID LIKE '%${safeQ}%' OR ProductName LIKE '%${safeQ}%' OR SpecificationCode LIKE '%${safeQ}%' OR Unit LIKE '%${safeQ}%'`;
        const data = await connection.query(sqlStr);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/inventory', async (req, res) => {
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

app.put('/api/inventory/:id', async (req, res) => {
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

app.delete('/api/inventory/:id', async (req, res) => {
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

// ============================================================
// Invoices
// ============================================================
app.get('/api/invoices', async (req, res) => {
    try {
        const data = await connection.query('SELECT * FROM Invoices ORDER BY InvoiceID DESC');
        // Attach derived balance/payment status without trusting stale columns.
        const enriched = data.map((inv) => {
            const pay = billing.paymentStatus(inv.GrandTotal, inv.AmountPaid);
            return {
                ...inv,
                Balance: inv.Status === 'Finalized' ? pay.balance : 0,
                PaymentStatus: inv.Status === 'Finalized' ? pay.status : inv.Status,
            };
        });
        res.json(enriched);
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
app.get('/api/receivables', async (req, res) => {
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

app.get('/api/invoices/:id', async (req, res) => {
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
app.post('/api/invoices/draft', async (req, res) => {
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
app.post('/api/invoices/finalize', async (req, res) => {
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
                    const invRef = sql.n(item.inventoryId);
                    const inv = await connection.query(`SELECT Qty FROM Inventory WHERE InventoryID = ${invRef}`);
                    const prevQty = money.num(inv[0].Qty);
                    const qty = money.num(item.qty);
                    const newQty = money.round2(prevQty - qty);
                    await connection.execute(`UPDATE Inventory SET Qty = ${newQty}, UpdatedAt = Now() WHERE InventoryID = ${invRef}`);
                    applied.push({ inventoryId: item.inventoryId, qty }); // record right after the deduction lands
                    await connection.execute(
                        `INSERT INTO StockMovements (InventoryID, InvoiceID, MovementType, QtyChange, PreviousQty, NewQty, MovementDate, Notes)
                         VALUES (${invRef}, ${invoiceId}, 'OUT', ${money.round2(-qty)}, ${prevQty}, ${newQty}, Now(), 'Invoice Finalized ${sql.esc(invoiceNo)}')`
                    );
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
app.post('/api/invoices/:id/cancel', async (req, res) => {
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
                    const invId = money.num(it.InventoryID);
                    const inv = await connection.query(`SELECT Qty FROM Inventory WHERE InventoryID = ${invId}`);
                    if (inv.length === 0) continue;
                    const prevQty = money.num(inv[0].Qty);
                    const newQty = money.round2(prevQty + money.num(it.Qty));
                    await connection.execute(`UPDATE Inventory SET Qty = ${newQty}, UpdatedAt = Now() WHERE InventoryID = ${invId}`);
                    await connection.execute(
                        `INSERT INTO StockMovements (InventoryID, InvoiceID, MovementType, QtyChange, PreviousQty, NewQty, MovementDate, Notes)
                         VALUES (${invId}, ${id}, 'IN', ${money.round2(money.num(it.Qty))}, ${prevQty}, ${newQty}, Now(), 'Invoice Cancelled: ${sql.esc(reason).slice(0, 180)}')`
                    );
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

// ============================================================
// Payments
// ============================================================
app.get('/api/invoices/:id/payments', async (req, res) => {
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

app.post('/api/invoices/:id/payments', async (req, res) => {
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
        res.json({ success: true, amountPaid: pay.amountPaid, balance: pay.balance, status: pay.status });
    } catch (err) {
        res.status(err.httpStatus || 500).json({ error: 'Could not record payment. Ensure the database is migrated. ' + err.message });
    }
});

// ============================================================
// Stock Movements
// ============================================================
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

app.get('/api/movements/export', async (req, res) => {
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

// ============================================================
// Import and Export (Inventory)
// ============================================================
app.get('/api/inventory/export', async (req, res) => {
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

            const length = money.num(row.Length);
            const qty = money.num(row.Qty);
            const price = money.num(row.Price);
            const cost = money.num(row.Cost);

            const existing = await connection.query(`SELECT InventoryID FROM Inventory WHERE UniqueID = ${sql.q(uniqueId)}`);
            if (existing.length > 0) {
                await connection.execute(`UPDATE Inventory SET
                    ProductName = ${sql.q(row.ProductName)}, SpecificationCode = ${sql.q(row.SpecificationCode)}, [Size] = ${sql.q(row.Size)}, Description = ${sql.q(row.Description)},
                    [Length] = ${length}, Qty = ${qty}, Unit = ${sql.q(row.Unit || 'Nos')}, Price = ${price}, Cost = ${cost}, UpdatedAt = Now()
                    WHERE UniqueID = ${sql.q(uniqueId)}`);
            } else {
                await connection.execute(`INSERT INTO Inventory (UniqueID, ProductName, SpecificationCode, [Size], Description, [Length], Qty, Unit, Price, Cost, CreatedAt, UpdatedAt)
                    VALUES (${sql.q(uniqueId)}, ${sql.q(row.ProductName)}, ${sql.q(row.SpecificationCode)}, ${sql.q(row.Size)}, ${sql.q(row.Description)}, ${length}, ${qty}, ${sql.q(row.Unit || 'Nos')}, ${price}, ${cost}, Now(), Now())`);
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

// ============================================================
// Cost Comparison Analysis
// ============================================================
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
    { name: '1-1/4" 4SH', spec: '4SH', size: 1.25, outsideCost: 5900 },
];

async function getCostComparison(connection) {
    const inventory = await connection.query("SELECT * FROM Inventory WHERE ProductName LIKE '%Rubber pipe%'");

    return costComparisonList.map((item) => {
        const match = inventory.find((inv) => {
            const nameUpper = (inv.ProductName || '').toUpperCase();
            const invSize = parseFloat(inv.Size) || 0;
            return nameUpper.includes(item.spec) && Math.abs(invSize - item.size) < 0.001;
        });

        const ourPriceMeter = match ? parseFloat(match.Price || 0) : 0;
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
            matched: !!match,
        };
    });
}

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
        '6': 0.25, '8': 0.3125, '10': 0.375, '13': 0.5,
        '16': 0.625, '19': 0.75, '25': 1.0, '32': 1.25,
    };

    const size = sizeMap[specCode.toString().trim()];
    if (size === undefined) return null;

    return costComparisonList.find((c) => c.spec === spec && Math.abs(c.size - size) < 0.001);
}

app.get('/api/invoices/:id/compare', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const invoice = await connection.query(`SELECT * FROM Invoices WHERE InvoiceID = ${id}`);
        if (invoice.length === 0) return res.status(404).json({ error: 'Invoice not found' });

        const items = await connection.query(`
            SELECT InvoiceItems.*, Inventory.ProductName, Inventory.SpecificationCode
            FROM InvoiceItems
            LEFT JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID
            WHERE InvoiceItems.InvoiceID = ${id}
        `);

        let ourSubtotal = 0;
        let outsideSubtotal = 0;

        const comparedItems = items.map((item) => {
            const ourAmt = parseFloat(item.Amount || 0);
            ourSubtotal += ourAmt;

            const match = matchInvoiceItemToOutsideCost(item.ProductName, item.SpecificationCode);
            let outsideAmt = 0;
            let outsideRate = 0;
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
                description: item.ItemDescription,
                unit: item.Unit,
                qty: item.Qty,
                ourRate: item.Rate,
                ourAmount: ourAmt,
                outsideRate: outsideRate,
                outsideAmount: outsideAmt,
                matched: matched,
                outsideUnit: matched ? 'ft' : item.Unit,
                outsideQty: matched ? parseFloat((item.Qty * 3.28084).toFixed(2)) : item.Qty,
            };
        });

        const ssclRate = parseFloat(invoice[0].SSCLRate || 0);
        const vatRate = parseFloat(invoice[0].VATRate || 0);

        const ourSscl = parseFloat((ourSubtotal * (ssclRate / 100)).toFixed(2));
        const ourPreVat = ourSubtotal + ourSscl;
        const ourVat = parseFloat((ourPreVat * (vatRate / 100)).toFixed(2));
        const ourGrandTotal = ourPreVat + ourVat;

        const outsideSscl = 0;
        const outsideVat = 0;
        const outsideGrandTotal = outsideSubtotal;

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
                netSavings,
            },
            items: comparedItems,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/invoices/:id/compare-export', async (req, res) => {
    try {
        const id = sql.n(req.params.id);
        const invoice = await connection.query(`SELECT * FROM Invoices WHERE InvoiceID = ${id}`);
        if (invoice.length === 0) return res.status(404).send('Invoice not found');

        const items = await connection.query(`
            SELECT InvoiceItems.*, Inventory.ProductName, Inventory.SpecificationCode
            FROM InvoiceItems
            LEFT JOIN Inventory ON InvoiceItems.InventoryID = Inventory.InventoryID
            WHERE InvoiceItems.InvoiceID = ${id}
        `);

        let ourSubtotal = 0;
        let outsideSubtotal = 0;

        const excelRows = items.map((item, idx) => {
            const ourAmt = parseFloat(item.Amount || 0);
            ourSubtotal += ourAmt;

            const match = matchInvoiceItemToOutsideCost(item.ProductName, item.SpecificationCode);
            let outsideAmt = 0;
            let outsideRate = 0;
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
                'Savings (Rs.)': parseFloat((outsideAmt - ourAmt).toFixed(2)),
            };
        });

        const ssclRate = parseFloat(invoice[0].SSCLRate || 0);
        const vatRate = parseFloat(invoice[0].VATRate || 0);

        const ourSscl = parseFloat((ourSubtotal * (ssclRate / 100)).toFixed(2));
        const ourVat = parseFloat(((ourSubtotal + ourSscl) * (vatRate / 100)).toFixed(2));
        const ourGrand = ourSubtotal + ourSscl + ourVat;

        const outsideSscl = 0;
        const outsideVat = 0;
        const outsideGrand = outsideSubtotal;

        const netSavings = outsideGrand - ourGrand;

        excelRows.push({});
        excelRows.push({ 'Description': 'SUBTOTAL', 'Our Amount (Rs.)': ourSubtotal, 'Outside Amount (Rs.)': outsideSubtotal, 'Savings (Rs.)': outsideSubtotal - ourSubtotal });
        excelRows.push({ 'Description': `SSCL (${ssclRate}%)`, 'Our Amount (Rs.)': ourSscl, 'Outside Amount (Rs.)': outsideSscl, 'Savings (Rs.)': outsideSscl - ourSscl });
        excelRows.push({ 'Description': `VAT (${vatRate}%)`, 'Our Amount (Rs.)': ourVat, 'Outside Amount (Rs.)': outsideVat, 'Savings (Rs.)': outsideVat - ourVat });
        excelRows.push({ 'Description': 'GRAND TOTAL', 'Our Amount (Rs.)': ourGrand, 'Outside Amount (Rs.)': outsideGrand, 'Savings (Rs.)': netSavings });

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

        const excelData = data.map((row) => ({
            'Hose Specification': row.name,
            'Our Cost (per Meter)': row.ourPriceMeter,
            'Our Cost (per Foot)': row.ourPriceFoot,
            'Outside Cost (per Foot)': row.outsideCost,
            'Savings (per Foot)': row.diffFoot,
            'Savings (%)': row.savingsPct + '%',
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

// ============================================================
// Boot
// ============================================================
async function start() {
    // Best-effort idempotent schema upgrade so new installs and existing
    // databases both gain the billing/lock/payment columns automatically.
    try {
        const summary = await ensureSchema(connection);
        if (summary && summary.applied.length) {
            console.log('Schema upgrades applied:', summary.applied.join(', '));
        }
        // Surface genuine (non-"already exists") failures loudly — a missing
        // required column would otherwise break invoice/payment saves silently.
        if (summary && summary.failed && summary.failed.length) {
            console.error('WARNING: some schema upgrades FAILED — run "npm run migrate" and check the DB:');
            summary.failed.forEach((f) => console.error(`  - ${f.name}: ${f.error}`));
        }
    } catch (e) {
        console.warn('Schema check skipped:', e.message);
    }

    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        if (AUTH_ENABLED) {
            console.log('Authentication is ON. Default login: admin / ' + FALLBACK_PASSWORD + ' (change it in the app).');
        } else {
            console.log('Authentication is OFF (BILLING_AUTH=off).');
        }
    });
}

start();
