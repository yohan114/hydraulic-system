/* ===== INVENTORY: products, stock, transactions, rate card, import/export — split from app.js; loaded as an ordered classic script (shared global scope) ===== */
// ----------------------------------------------------
// Inventory
// ----------------------------------------------------
let allInventory = [];

async function loadInventory(opts = {}) {
    if (dataCache.inventory) {
        allInventory = dataCache.inventory;
        if (!opts.background) renderInventory(allInventory);
    } else if (!opts.background) {
        showSkeleton('inventory-tbody', 9);
    }
    try {
        const res = await authFetch(`${API_URL}/inventory`);
        const data = await res.json();
        dataCache.inventory = data;
        allInventory = data;
        if (!opts.background) renderInventory(data);
    } catch (e) {
        console.error('Error loading inventory', e);
    }
}

function renderInventory(items) {
    const tbody = document.getElementById('inventory-tbody');
    tbody.innerHTML = '';
    if (!items.length) { emptyRow('inventory-tbody', 10, '📦', 'No products found', 'Add a product or adjust your search.'); return; }
    items.forEach((item) => {
        const reorder = item.ReorderLevel == null ? 5 : item.ReorderLevel;
        const low = Number(item.Qty) <= Number(reorder);
        tbody.innerHTML += `
            <tr>
                <td>${escAttr(item.UniqueID)}</td>
                <td><strong>${escAttr(item.ProductName)}</strong></td>
                <td>${escAttr(item.SpecificationCode)}</td>
                <td>${escAttr(item.Size) || '-'}</td>
                <td>${item.Length}</td>
                <td><span class="badge ${low ? 'badge-low' : 'badge-ok'}" title="Reorder at ${reorder}">${item.Qty}</span></td>
                <td>${escAttr(item.Unit)}</td>
                <td>${formatCurrency(item.Price || 0)}</td>
                <td>${item.SupplierName ? escAttr(item.SupplierName) : '<span style="color:var(--text-muted)">—</span>'}</td>
                <td>
                    <button class="btn btn-text" onclick="openPurchaseModal(${item.InventoryID})" title="Record a stock purchase">Buy</button>
                    <button class="btn btn-text" onclick="editProduct(${item.InventoryID})">Edit</button>
                    <button class="btn btn-text text-danger" style="color:red" onclick="deleteProduct(${item.InventoryID})">Del</button>
                </td>
            </tr>
        `;
    });
}

function searchInventory() {
    const q = document.getElementById('inventorySearch').value.toLowerCase();
    const filtered = allInventory.filter((i) =>
        i.UniqueID.toLowerCase().includes(q) ||
        i.ProductName.toLowerCase().includes(q) ||
        i.SpecificationCode.toLowerCase().includes(q)
    );
    renderInventory(filtered);
}

function editProduct(id) {
    const p = allInventory.find((i) => i.InventoryID === id);
    if (!p) return;
    document.getElementById('prod-id').value = p.InventoryID;
    document.getElementById('prod-unique').value = p.UniqueID;
    document.getElementById('prod-unique').disabled = true; // Can't edit unique ID
    document.getElementById('prod-name').value = p.ProductName;
    document.getElementById('prod-spec').value = p.SpecificationCode;
    document.getElementById('prod-size').value = p.Size || '';
    document.getElementById('prod-desc').value = p.Description || '';
    document.getElementById('prod-length').value = p.Length;
    document.getElementById('prod-qty').value = p.Qty;
    document.getElementById('prod-unit').value = p.Unit;
    document.getElementById('prod-price').value = p.Price || 0;
    const costEl = document.getElementById('prod-cost');
    if (costEl) costEl.value = p.Cost || 0;
    populateSupplierSelect('prod-supplier', p.SupplierID);
    const reorderEl = document.getElementById('prod-reorder');
    if (reorderEl) reorderEl.value = p.ReorderLevel == null ? 5 : p.ReorderLevel;
    const lastEl = document.getElementById('prod-lastpurchase');
    if (lastEl) lastEl.value = p.LastPurchasePrice ? `${formatCurrency(p.LastPurchasePrice)}${p.LastPurchaseDate ? ' on ' + formatDate(p.LastPurchaseDate) : ''}` : '—';

    document.getElementById('addProductTitle').textContent = 'Edit Product';
    openModal('addProductModal');
}

async function submitAddProduct(e) {
    e.preventDefault();
    const id = document.getElementById('prod-id').value;
    const costEl = document.getElementById('prod-cost');
    const payload = {
        uniqueId: document.getElementById('prod-unique').value,
        productName: document.getElementById('prod-name').value,
        specificationCode: document.getElementById('prod-spec').value,
        size: document.getElementById('prod-size').value,
        description: document.getElementById('prod-desc').value,
        length: document.getElementById('prod-length').value,
        qty: document.getElementById('prod-qty').value,
        unit: document.getElementById('prod-unit').value,
        price: document.getElementById('prod-price').value,
        cost: costEl ? costEl.value : 0,
        supplierId: document.getElementById('prod-supplier').value || null,
        reorderLevel: document.getElementById('prod-reorder').value,
    };

    const url = id ? `${API_URL}/inventory/${id}` : `${API_URL}/inventory`;
    const method = id ? 'PUT' : 'POST';

    try {
        const res = await authFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.error) toast(data.error, 'error');
        else {
            closeModal('addProductModal');
            invalidateCache('inventory', 'dashboard');
            loadInventory();
            loadDashboard({ background: true });
            e.target.reset();
            document.getElementById('prod-id').value = '';
            document.getElementById('prod-unique').disabled = false;
            toast(id ? 'Product updated' : 'Product added', 'success');
        }
    } catch (err) { toast(String(err), 'error'); }
}

function openAddProductModal() {
    const form = document.getElementById('addProductForm');
    if (form) form.reset();
    document.getElementById('prod-id').value = '';
    document.getElementById('prod-unique').disabled = false;
    document.getElementById('addProductTitle').textContent = 'Add Inventory Product';
    populateSupplierSelect('prod-supplier', '');
    const reorderEl = document.getElementById('prod-reorder');
    if (reorderEl) reorderEl.value = 5;
    const lastEl = document.getElementById('prod-lastpurchase');
    if (lastEl) lastEl.value = '—';
    openModal('addProductModal');
}

// ----------------------------------------------------
// Suppliers
// ----------------------------------------------------
let allSuppliers = [];

async function loadSuppliers(opts = {}) {
    if (!opts.background) showSkeleton('suppliers-tbody', 6);
    try {
        const res = await authFetch(`${API_URL}/suppliers`);
        const data = await res.json();
        if (!Array.isArray(data)) { toast(data.error || 'Could not load suppliers', 'error'); return; }
        allSuppliers = data;
        if (!opts.background) renderSuppliers(data);
    } catch (e) { console.error('Error loading suppliers', e); }
}

function renderSuppliers(items) {
    const tbody = document.getElementById('suppliers-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!items.length) { emptyRow('suppliers-tbody', 6, '🚚', 'No suppliers yet', 'Add a supplier to link it to inventory items.'); return; }
    items.forEach((s) => {
        tbody.innerHTML += `
            <tr>
                <td><strong>${escAttr(s.Name)}</strong></td>
                <td>${escAttr(s.ContactPerson) || '-'}</td>
                <td>${escAttr(s.Phone) || '-'}</td>
                <td>${escAttr(s.Email) || '-'}</td>
                <td>${s.ItemCount || 0}</td>
                <td>
                    <button class="btn btn-text" onclick="editSupplier(${s.SupplierID})">Edit</button>
                    <button class="btn btn-text text-danger" style="color:red" onclick="deleteSupplier(${s.SupplierID})">Del</button>
                </td>
            </tr>`;
    });
}

// Fill a <select> with the supplier list, selecting `selectedId` if given.
// Loads suppliers first if the cache is empty (e.g. product modal opened before
// the Suppliers tab was ever visited).
async function populateSupplierSelect(selectId, selectedId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    if (!allSuppliers.length) { try { await loadSuppliers({ background: true }); } catch (_) {} }
    const sid = selectedId == null ? '' : String(selectedId);
    sel.innerHTML = '<option value="">— None —</option>' +
        allSuppliers.map((s) => `<option value="${s.SupplierID}" ${String(s.SupplierID) === sid ? 'selected' : ''}>${escAttr(s.Name)}</option>`).join('');
}

function openSupplierModal() {
    document.getElementById('supplierForm').reset();
    document.getElementById('supplier-id').value = '';
    document.getElementById('supplierModalTitle').textContent = 'Add Supplier';
    openModal('supplierModal');
}

function editSupplier(id) {
    const s = allSuppliers.find((x) => x.SupplierID === id);
    if (!s) return;
    document.getElementById('supplier-id').value = s.SupplierID;
    document.getElementById('supplier-name').value = s.Name || '';
    document.getElementById('supplier-contact').value = s.ContactPerson || '';
    document.getElementById('supplier-phone').value = s.Phone || '';
    document.getElementById('supplier-email').value = s.Email || '';
    document.getElementById('supplier-address').value = s.Address || '';
    document.getElementById('supplier-notes').value = s.Notes || '';
    document.getElementById('supplierModalTitle').textContent = 'Edit Supplier';
    openModal('supplierModal');
}

async function submitSupplier(e) {
    e.preventDefault();
    const id = document.getElementById('supplier-id').value;
    const payload = {
        name: document.getElementById('supplier-name').value,
        contactPerson: document.getElementById('supplier-contact').value,
        phone: document.getElementById('supplier-phone').value,
        email: document.getElementById('supplier-email').value,
        address: document.getElementById('supplier-address').value,
        notes: document.getElementById('supplier-notes').value,
    };
    const url = id ? `${API_URL}/suppliers/${id}` : `${API_URL}/suppliers`;
    try {
        const res = await authFetch(url, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.error) return toast(data.error, 'error');
        closeModal('supplierModal');
        allSuppliers = [];            // force refresh so dropdowns pick up the change
        loadSuppliers();
        invalidateCache('inventory');
        toast(id ? 'Supplier updated' : 'Supplier added', 'success');
    } catch (err) { toast(String(err), 'error'); }
}

async function deleteSupplier(id) {
    const ok = await confirmDialog({ title: 'Delete supplier?', message: 'This removes the supplier record.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
        const res = await authFetch(`${API_URL}/suppliers/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.error) return toast(data.error, 'error');
        allSuppliers = [];
        loadSuppliers();
        toast('Supplier deleted', 'success');
    } catch (err) { toast(String(err), 'error'); }
}

// ----------------------------------------------------
// Record purchase (updates last purchase price + stock)
// ----------------------------------------------------
async function openPurchaseModal(inventoryId) {
    // The dashboard low-stock widget can call this before the inventory list has
    // loaded; make sure allInventory is populated so we can prefill the item.
    if (!allInventory.length) { try { await loadInventory({ background: true }); } catch (_) {} }
    const p = allInventory.find((i) => i.InventoryID === inventoryId);
    document.getElementById('purchaseForm').reset();
    document.getElementById('purchase-inventory-id').value = inventoryId;
    document.getElementById('purchase-item-label').textContent = p ? `${p.ProductName} — ${p.SpecificationCode} (in stock: ${p.Qty})` : '';
    document.getElementById('purchase-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('purchase-price').value = p && p.LastPurchasePrice ? p.LastPurchasePrice : (p && p.Cost ? p.Cost : 0);
    populateSupplierSelect('purchase-supplier', p ? p.SupplierID : '');
    openModal('purchaseModal');
}

async function submitPurchase(e) {
    e.preventDefault();
    const id = document.getElementById('purchase-inventory-id').value;
    const payload = {
        qty: document.getElementById('purchase-qty').value,
        unitPrice: document.getElementById('purchase-price').value,
        supplierId: document.getElementById('purchase-supplier').value || null,
        date: document.getElementById('purchase-date').value,
        updateCost: document.getElementById('purchase-updatecost').checked,
        notes: document.getElementById('purchase-notes').value,
    };
    try {
        const res = await authFetch(`${API_URL}/inventory/${id}/purchase`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.error) return toast(data.error, 'error');
        closeModal('purchaseModal');
        invalidateCache('inventory', 'dashboard', 'movements');
        loadInventory();
        loadDashboard({ background: true });
        toast('Purchase recorded' + (data.newQty != null ? ` — new stock: ${data.newQty}` : ''), 'success');
    } catch (err) { toast(String(err), 'error'); }
}

async function deleteProduct(id) {
    const ok = await confirmDialog({ title: 'Delete product?', message: 'This permanently removes the product from inventory.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
        const res = await authFetch(`${API_URL}/inventory/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.error) toast(data.error, 'error');
        else { invalidateCache('inventory', 'dashboard'); loadInventory(); toast('Product deleted', 'success'); }
    } catch (err) { toast(String(err), 'error'); }
}


// ----------------------------------------------------
// Transactions
// ----------------------------------------------------
async function loadTransactions() {
    if (dataCache.movements) renderTransactions(dataCache.movements);
    else showSkeleton('transactions-tbody', 9);
    try {
        const res = await authFetch(`${API_URL}/movements`);
        const data = await res.json();
        dataCache.movements = data;
        renderTransactions(data);
    } catch (e) { console.error('Error loading movements', e); }
}

function renderTransactions(data) {
    const tbody = document.getElementById('transactions-tbody');
    tbody.innerHTML = '';
    if (!data.length) { emptyRow('transactions-tbody', 9, '🔄', 'No stock movements yet', 'Finalizing or cancelling invoices records movements here.'); return; }
    data.forEach((m) => {
        const isOut = m.MovementType === 'OUT';
            tbody.innerHTML += `
                <tr>
                    <td>${formatDate(m.MovementDate)}</td>
                    <td>${m.InvoiceNo || '-'}</td>
                    <td><strong>${m.UniqueID || '-'}</strong></td>
                    <td>${m.SpecificationCode || '-'}</td>
                    <td>${m.ProductName || ''}</td>
                    <td><span class="badge ${isOut ? 'badge-low' : 'badge-finalized'}">${m.MovementType}</span></td>
                    <td><strong style="color:${isOut ? 'red' : 'green'}">${m.QtyChange}</strong></td>
                    <td>${m.NewQty}</td>
                    <td>${m.Notes || ''}</td>
                </tr>
            `;
    });
}

// ----------------------------------------------------
// Import & Export
// ----------------------------------------------------
function exportInventory() { downloadExport('/inventory/export', 'Inventory_Export.xlsx'); }
function exportAllInvoices() { downloadExport('/invoices/export', 'Invoices_Export.xlsx'); }
function exportCostComparison() { downloadExport('/costs/export', 'Cost_Comparison.xlsx'); }
function exportStockMovements() { downloadExport('/movements/export', 'Stock_Movements_Export.xlsx'); }
function exportInvoiceComparison(invoiceId) { downloadExport(`/invoices/${invoiceId}/compare-export?tier=${compareTier()}`, 'Invoice_Comparison.xlsx'); }

async function loadExportStats() {
    try {
        const res = await authFetch(`${API_URL}/invoices`);
        const data = await res.json();
        document.getElementById('export-count').textContent = data.length;
    } catch (e) {
        document.getElementById('export-count').textContent = '0';
    }
}

// ----------------------------------------------------
// Rate Card (editable)
// ----------------------------------------------------
let allRates = [];
async function loadRateCard() {
    if (dataCache.ratecard) renderRateCard(dataCache.ratecard);
    else showSkeleton('cost-analysis-tbody', 7);
    try {
        const res = await authFetch(`${API_URL}/ratecard`);
        const data = await res.json();
        if (!res.ok) { toast(data.error || 'Could not load rate card', 'error'); return; }
        dataCache.ratecard = data;
        renderRateCard(data);
    } catch (e) { console.error('Error loading rate card', e); }
}

const CATEGORY_LABEL = { hose: 'Hose (per metre)', fitting: 'Fittings (per end)', crimping: 'Crimping (per end)' };

function renderRateCard(data) {
    allRates = data;
    const tbody = document.getElementById('cost-analysis-tbody');
    tbody.innerHTML = '';
    if (!data.length) { emptyRow('cost-analysis-tbody', 9, '🏷️', 'No rates yet', 'Add a rate or run the migration to seed the researched defaults.'); return; }
    let sumSav = 0, sumMar = 0;
    let lastCat = null;
    data.forEach((r) => {
        sumSav += Number(r.savingsPct) || 0;
        sumMar += Number(r.marginPct) || 0;
        if (r.category !== lastCat) {
            lastCat = r.category;
            tbody.innerHTML += `<tr><td colspan="9" style="background:var(--secondary); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-muted);">${CATEGORY_LABEL[r.category] || r.category}</td></tr>`;
        }
        tbody.innerHTML += `
            <tr>
                <td><strong>${r.label}</strong></td>
                <td class="num">${formatCurrency(r.ourCost)}</td>
                <td class="num" style="font-weight:600;">${formatCurrency(r.ourPrice)}</td>
                <td class="num" style="color:var(--text-muted);">${formatCurrency(r.outsideLow)}</td>
                <td class="num">${formatCurrency(r.outsideMid)}</td>
                <td class="num" style="color:var(--text-muted);">${formatCurrency(r.outsideHigh)}</td>
                <td class="num" style="color:#10b981;font-weight:600;">${(Number(r.savingsPct) || 0).toFixed(1)}%</td>
                <td class="num" style="color:var(--primary);font-weight:600;">${(Number(r.marginPct) || 0).toFixed(1)}%</td>
                <td>
                    <button class="btn btn-text" onclick="openRateModal(${r.rateId})">Edit</button>
                    <button class="btn btn-text" style="color:var(--danger)" onclick="deleteRate(${r.rateId})">Del</button>
                </td>
            </tr>`;
    });
    document.getElementById('rate-stat-count').textContent = data.length;
    document.getElementById('rate-stat-savings').textContent = `${(data.length ? sumSav / data.length : 0).toFixed(1)}%`;
    document.getElementById('rate-stat-margin').textContent = `${(data.length ? sumMar / data.length : 0).toFixed(1)}%`;
}

const SIZECODE_INCH = { '6': 0.25, '8': 0.3125, '10': 0.375, '13': 0.5, '16': 0.625, '19': 0.75, '25': 1.0, '32': 1.25, '38': 1.5, '51': 2.0 };
function rateSyncSizeInch() {
    const code = document.getElementById('rate-sizecode').value;
    if (SIZECODE_INCH[code] !== undefined) document.getElementById('rate-sizeinch').value = SIZECODE_INCH[code];
}
function rateSyncUnit() {
    const cat = document.getElementById('rate-category').value;
    document.getElementById('rate-unit-label').textContent = cat === 'hose' ? 'metre' : 'end';
}

function openRateModal(id) {
    document.getElementById('rateForm').reset();
    document.getElementById('rate-id').value = '';
    document.getElementById('rateModalTitle').textContent = 'Add Rate';
    if (id) {
        const r = allRates.find((x) => x.rateId === id);
        if (r) {
            document.getElementById('rate-id').value = r.rateId;
            document.getElementById('rate-category').value = r.category || 'hose';
            document.getElementById('rate-label').value = r.label || '';
            document.getElementById('rate-spec').value = r.spec || '';
            document.getElementById('rate-sizecode').value = r.sizeCode || '';
            document.getElementById('rate-sizeinch').value = r.sizeInch || '';
            document.getElementById('rate-ourcost').value = r.ourCost || 0;
            document.getElementById('rate-ourprice').value = r.ourPrice || 0;
            document.getElementById('rate-outlow').value = r.outsideLow || 0;
            document.getElementById('rate-outmid').value = r.outsideMid || 0;
            document.getElementById('rate-outhigh').value = r.outsideHigh || 0;
            document.getElementById('rateModalTitle').textContent = 'Edit Rate';
        }
    }
    rateSyncUnit();
    openModal('rateModal');
}

async function submitRate(e) {
    e.preventDefault();
    const id = document.getElementById('rate-id').value;
    const payload = {
        category: document.getElementById('rate-category').value,
        label: document.getElementById('rate-label').value,
        spec: document.getElementById('rate-spec').value,
        sizeCode: document.getElementById('rate-sizecode').value,
        sizeInch: document.getElementById('rate-sizeinch').value,
        unit: document.getElementById('rate-category').value === 'hose' ? 'm' : 'end',
        ourCost: document.getElementById('rate-ourcost').value,
        ourPrice: document.getElementById('rate-ourprice').value,
        outsideLow: document.getElementById('rate-outlow').value,
        outsideMid: document.getElementById('rate-outmid').value,
        outsideHigh: document.getElementById('rate-outhigh').value,
    };
    try {
        const res = await authFetch(`${API_URL}/ratecard${id ? '/' + id : ''}`, {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Save failed', 'error'); return; }
        closeModal('rateModal');
        invalidateCache('ratecard');
        loadRateCard();
        toast(id ? 'Rate updated' : 'Rate added', 'success');
    } catch (err) { toast(String(err), 'error'); }
}

async function deleteRate(id) {
    const ok = await confirmDialog({ title: 'Delete rate?', message: 'Remove this rate from the Rate Card?', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
        const res = await authFetch(`${API_URL}/ratecard/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Delete failed', 'error'); return; }
        invalidateCache('ratecard');
        loadRateCard();
        toast('Rate deleted', 'success');
    } catch (err) { toast(String(err), 'error'); }
}

