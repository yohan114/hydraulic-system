// Base API URL
const API_URL = 'http://localhost:9999/api';

// State
let invoiceItems = [];
let nextItemId = 1;
let isInvoiceEditable = true;
let currentInvoiceId = null; // set when editing/viewing a saved invoice
let authToken = localStorage.getItem('billing_token') || '';
let authEnabled = true;
let savingInvoice = false; // guards against double-submit of an invoice
let modalSearchResults = []; // cached inventory search rows for the picker

// Escape a value for safe insertion into an HTML attribute (e.g. hose sizes
// like 1/2" would otherwise break value="..." attributes).
function escAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ----------------------------------------------------
// Money helpers (mirror server lib/money.js for accurate previews)
// ----------------------------------------------------
function round2(value) {
    const n = Number(value);
    if (!isFinite(n)) return 0;
    const shifted = Number(`${n}e2`);
    if (!isFinite(shifted)) return Math.round(n * 100) / 100;
    const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted));
    const out = Number(`${rounded}e-2`);
    return Object.is(out, -0) ? 0 : out;
}

// ----------------------------------------------------
// Auth-aware fetch
// ----------------------------------------------------
async function authFetch(url, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
        showLogin();
        throw new Error('Session expired. Please sign in again.');
    }
    return res;
}

// Build a GET URL for downloads (which cannot send an Authorization header).
function exportUrl(path) {
    let url = `${API_URL}${path}`;
    if (authToken) url += (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(authToken);
    return url;
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    initNavigation();

    const authed = await initAuth();
    if (authed) loadDashboard();

    // Set default dates
    const today = new Date().toISOString().split('T')[0];
    const invDateInput = document.getElementById('invDate');
    if (invDateInput) {
        invDateInput.value = today;
        invDateInput.addEventListener('change', fetchNextInvoiceNo);
    }
    const payDate = document.getElementById('pay-date');
    if (payDate) payDate.value = today;

    // Auto-generate unique ID
    const nameInput = document.getElementById('prod-name');
    const sizeInput = document.getElementById('prod-size');
    if (nameInput) nameInput.addEventListener('input', generateUniqueId);
    if (sizeInput) sizeInput.addEventListener('input', generateUniqueId);
});

// ----------------------------------------------------
// Authentication
// ----------------------------------------------------
async function initAuth() {
    try {
        const res = await fetch(`${API_URL}/auth/status`, {
            headers: authToken ? { Authorization: 'Bearer ' + authToken } : {},
        });
        const status = await res.json();
        authEnabled = status.authEnabled;
        if (authEnabled && !status.authenticated) {
            showLogin();
            return false;
        }
        hideLogin();
        setupAccountUI(status);
        return true;
    } catch (e) {
        // Server unreachable — show the login screen rather than a blank app.
        showLogin();
        return false;
    }
}

function setupAccountUI(status) {
    const footer = document.getElementById('sidebarFooter');
    if (!footer) return;
    if (authEnabled) {
        footer.style.display = 'flex';
        document.getElementById('accountName').textContent = (status && status.username) || 'admin';
        const warn = document.getElementById('defaultPwWarning');
        if (warn) warn.classList.toggle('show', !!(status && status.usingDefaultPassword));
    } else {
        footer.style.display = 'none';
    }
}

function showLogin() { document.getElementById('loginOverlay').classList.add('active'); }
function hideLogin() { document.getElementById('loginOverlay').classList.remove('active'); }

async function doLogin(e) {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    errEl.textContent = '';
    try {
        const res = await fetch(`${API_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error || 'Login failed'; return; }
        authToken = data.token;
        localStorage.setItem('billing_token', authToken);
        document.getElementById('loginPassword').value = '';
        hideLogin();
        await initAuth();
        loadDashboard();
    } catch (err) {
        errEl.textContent = 'Could not reach the server.';
    }
}

function logout() {
    authToken = '';
    localStorage.removeItem('billing_token');
    showLogin();
}

async function submitChangePassword(e) {
    e.preventDefault();
    const currentPassword = document.getElementById('cp-current').value;
    const newPassword = document.getElementById('cp-new').value;
    const err = document.getElementById('cp-error');
    err.textContent = '';
    try {
        const res = await authFetch(`${API_URL}/auth/change-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword }),
        });
        const data = await res.json();
        if (!res.ok) { err.textContent = data.error || 'Update failed'; return; }
        alert('Password updated successfully.');
        closeModal('changePasswordModal');
        document.getElementById('changePasswordForm').reset();
        const warn = document.getElementById('defaultPwWarning');
        if (warn) warn.classList.remove('show');
    } catch (e2) {
        err.textContent = e2.message;
    }
}

function generateUniqueId() {
    const isEdit = document.getElementById('prod-id').value;
    if (isEdit) return; // Don't auto-generate if editing existing

    const name = document.getElementById('prod-name').value.trim().toUpperCase();
    const size = document.getElementById('prod-size').value.trim().toUpperCase();

    let uniqueId = name.replace(/[^A-Z0-9]/g, '-');
    if (size) {
        uniqueId += '-' + size.replace(/[^A-Z0-9]/g, '-');
    }
    uniqueId = uniqueId.replace(/-+/g, '-').replace(/^-|-$/g, '');

    document.getElementById('prod-unique').value = uniqueId;
}

// Navigation
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach((item) => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const target = e.currentTarget.dataset.target;
            showSection(target);
            // Reaching the invoice page from the sidebar always starts a fresh
            // invoice, so a previously-viewed draft can't be overwritten by
            // accident. (viewInvoice() opens the page via showSection directly.)
            if (target === 'new-invoice') startNewInvoice();

            navItems.forEach((nav) => nav.classList.remove('active'));
            e.currentTarget.classList.add('active');
        });
    });
}

function showSection(sectionId) {
    document.querySelectorAll('.page-section').forEach((sec) => sec.classList.remove('active'));
    document.getElementById(sectionId).classList.add('active');

    const titles = {
        'dashboard': 'Dashboard',
        'inventory': 'Inventory Management',
        'new-invoice': 'Invoice Document',
        'history': 'Invoice History',
        'transactions': 'Stock Movements',
        'export-invoices': 'Export Invoices',
        'cost-analysis': 'Cost Analysis',
        'invoice-comparison': 'Invoice Comparison',
    };
    document.getElementById('page-title').textContent = titles[sectionId];

    if (sectionId === 'dashboard') loadDashboard();
    else if (sectionId === 'inventory') loadInventory();
    else if (sectionId === 'history') loadHistory();
    else if (sectionId === 'transactions') loadTransactions();
    else if (sectionId === 'export-invoices') loadExportStats();
    else if (sectionId === 'cost-analysis') loadCostAnalysis();
    else if (sectionId === 'invoice-comparison') loadInvoiceComparisonList();
}

// Helpers
const formatCurrency = (num) => 'Rs. ' + parseFloat(num || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatDate = (dateString) => (dateString ? new Date(dateString).toLocaleDateString() : '');

function setInvoiceEditable(editable) {
    isInvoiceEditable = editable;

    // Invoice number is always auto-assigned and never user-editable.
    const refInvoice = document.getElementById('refInvoice');
    if (refInvoice) refInvoice.contentEditable = 'false';

    const invDate = document.getElementById('invDate');
    if (invDate) invDate.disabled = !editable;

    const billedToName = document.getElementById('billedToName');
    if (billedToName) billedToName.disabled = !editable;
    const billedToAddress = document.getElementById('billedToAddress');
    if (billedToAddress) billedToAddress.disabled = !editable;

    const invSsclRate = document.getElementById('invSsclRate');
    if (invSsclRate) invSsclRate.disabled = !editable;
    const invVatRate = document.getElementById('invVatRate');
    if (invVatRate) invVatRate.disabled = !editable;
    const invDiscount = document.getElementById('invDiscount');
    if (invDiscount) invDiscount.disabled = !editable;
    const invRoundToRupee = document.getElementById('invRoundToRupee');
    if (invRoundToRupee) invRoundToRupee.disabled = !editable;

    const invNotes = document.getElementById('invNotes');
    if (invNotes) invNotes.contentEditable = editable ? 'true' : 'false';
    const invPaymentTerms = document.getElementById('invPaymentTerms');
    if (invPaymentTerms) invPaymentTerms.contentEditable = editable ? 'true' : 'false';
}

// ----------------------------------------------------
// Dashboard
// ----------------------------------------------------
async function loadDashboard() {
    try {
        const res = await authFetch(`${API_URL}/dashboard`);
        const data = await res.json();

        document.getElementById('stat-products').textContent = data.stats.totalInventory;
        document.getElementById('stat-qty').textContent = data.stats.totalQty;
        document.getElementById('stat-low-stock').textContent = data.stats.lowStock;

        const outEl = document.getElementById('stat-outstanding');
        if (outEl) outEl.textContent = formatCurrency(data.stats.outstandingTotal || 0);
        const outCountEl = document.getElementById('stat-outstanding-count');
        if (outCountEl) outCountEl.textContent = `${data.stats.outstandingCount || 0} invoice(s) with balance`;

        const invTbody = document.getElementById('recent-invoices-tbody');
        invTbody.innerHTML = '';
        data.recentInvoices.forEach((inv) => {
            invTbody.innerHTML += `
                <tr>
                    <td>${inv.InvoiceNo}</td>
                    <td>${formatDate(inv.FinalizedAt)}</td>
                    <td>${inv.BilledToName || ''}</td>
                    <td>${formatCurrency(inv.GrandTotal)}</td>
                </tr>
            `;
        });

        const movTbody = document.getElementById('recent-movements-tbody');
        movTbody.innerHTML = '';
        data.movements.forEach((m) => {
            const isOut = m.MovementType === 'OUT';
            movTbody.innerHTML += `
                <tr>
                    <td>${formatDate(m.MovementDate)}</td>
                    <td>${m.ProductName || ''}</td>
                    <td><span class="badge ${isOut ? 'badge-low' : 'badge-finalized'}">${m.MovementType}</span></td>
                    <td>${m.QtyChange}</td>
                    <td>${m.NewQty}</td>
                </tr>
            `;
        });
    } catch (e) {
        console.error('Error loading dashboard', e);
    }
}

// ----------------------------------------------------
// Inventory
// ----------------------------------------------------
let allInventory = [];

async function loadInventory() {
    try {
        const res = await authFetch(`${API_URL}/inventory`);
        allInventory = await res.json();
        renderInventory(allInventory);
    } catch (e) {
        console.error('Error loading inventory', e);
    }
}

function renderInventory(items) {
    const tbody = document.getElementById('inventory-tbody');
    tbody.innerHTML = '';
    items.forEach((item) => {
        tbody.innerHTML += `
            <tr>
                <td>${item.UniqueID}</td>
                <td><strong>${item.ProductName}</strong></td>
                <td>${item.SpecificationCode}</td>
                <td>${item.Size || '-'}</td>
                <td>${item.Length}</td>
                <td><span class="badge ${item.Qty <= 5 ? 'badge-low' : 'badge-ok'}">${item.Qty}</span></td>
                <td>${item.Unit}</td>
                <td>${formatCurrency(item.Price || 0)}</td>
                <td>
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
        if (data.error) alert(data.error);
        else {
            closeModal('addProductModal');
            loadInventory();
            e.target.reset();
            document.getElementById('prod-id').value = '';
            document.getElementById('prod-unique').disabled = false;
        }
    } catch (err) { alert(err); }
}

async function deleteProduct(id) {
    if (!confirm('Are you sure you want to delete this product?')) return;
    try {
        const res = await authFetch(`${API_URL}/inventory/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.error) alert(data.error);
        else loadInventory();
    } catch (err) { alert(err); }
}

// ----------------------------------------------------
// Modals
// ----------------------------------------------------
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ----------------------------------------------------
// New Invoice
// ----------------------------------------------------
function commitRef() { /* numbering handled by backend */ }

async function fetchNextInvoiceNo() {
    const titleElem = document.getElementById('invoice-view-title');
    const isCreateMode = titleElem && titleElem.textContent.includes('Create New Invoice');
    if (!isCreateMode) return; // Do not fetch if viewing an existing invoice!

    const invDateInput = document.getElementById('invDate');
    const dateVal = invDateInput ? invDateInput.value : '';
    const refElem = document.getElementById('refInvoice');
    if (!refElem) return;

    refElem.textContent = 'Loading...';
    try {
        const res = await authFetch(`${API_URL}/invoices/next-no?date=${encodeURIComponent(dateVal)}`);
        const data = await res.json();
        refElem.textContent = data.nextInvoiceNo || 'AUTO';
    } catch (e) {
        console.error('Error fetching next invoice number:', e);
        refElem.textContent = 'AUTO';
    }
}

async function startNewInvoice() {
    currentInvoiceId = null;
    setInvoiceEditable(true);
    document.getElementById('invDate').value = new Date().toISOString().split('T')[0];

    const billedToName = document.getElementById('billedToName');
    if (billedToName) billedToName.value = '';
    const billedToAddress = document.getElementById('billedToAddress');
    if (billedToAddress) billedToAddress.value = '';
    const deliveredToName = document.getElementById('deliveredToName');
    if (deliveredToName) deliveredToName.value = '';
    const deliveredToAddress = document.getElementById('deliveredToAddress');
    if (deliveredToAddress) deliveredToAddress.value = '';

    document.getElementById('invSsclRate').value = '2.5';
    document.getElementById('invVatRate').value = '18';
    document.getElementById('invDiscount').value = '0';
    document.getElementById('invRoundToRupee').checked = false;

    invoiceItems = [];
    renderInvoiceItems();

    document.getElementById('invoice-save-actions').style.display = 'flex';
    document.getElementById('btnSaveDraft').style.display = 'inline-flex';
    document.getElementById('btnFinalize').style.display = 'inline-flex';
    document.getElementById('addItemBtnContainer').style.display = 'flex';

    document.getElementById('invoice-view-title').textContent = 'Create New Invoice';

    await fetchNextInvoiceNo();
}

// Modal select inventory
async function searchModalInventory() {
    const q = document.getElementById('modalInventorySearch').value;
    try {
        const res = await authFetch(`${API_URL}/inventory/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        modalSearchResults = data; // cache so we can pass just the id to the handler
        const tbody = document.getElementById('modal-inventory-tbody');
        tbody.innerHTML = '';
        data.forEach((item) => {
            // Escape display cells; the Add button passes only the numeric id, so
            // product names containing " or ' can never break the markup.
            tbody.innerHTML += `
                <tr>
                    <td>${escAttr(item.UniqueID)}</td>
                    <td>${escAttr(item.ProductName)}</td>
                    <td>${escAttr(item.SpecificationCode)}</td>
                    <td>${item.Qty}</td>
                    <td>${formatCurrency(item.Price || 0)}</td>
                    <td><button class="btn btn-primary" onclick="addInventoryFromModal(${item.InventoryID})">Add</button></td>
                </tr>
            `;
        });
    } catch (e) {}
}

function addInventoryFromModal(invId) {
    const item = modalSearchResults.find((i) => i.InventoryID === invId);
    if (!item) return;
    invoiceItems.push({
        id: nextItemId++,
        inventoryId: item.InventoryID,
        desc: `${item.ProductName} - ${item.SpecificationCode}`,
        unit: item.Unit,
        length: item.Length,
        qty: 1,
        rate: item.Price || 0,
        cost: item.Cost || 0,
        maxQty: item.Qty,
    });
    closeModal('selectInventoryModal');
    renderInvoiceItems();
}

function addCustomRow() {
    invoiceItems.push({ id: nextItemId++, inventoryId: null, desc: '', unit: 'Nos', length: 0, qty: 1, rate: 0, cost: 0, maxQty: null });
    renderInvoiceItems();
}

function addStandardCharges() {
    if (!invoiceItems.find((it) => it.desc === 'Technical charges')) {
        invoiceItems.push({ id: nextItemId++, inventoryId: null, desc: 'Technical charges', unit: 'Nos', length: 0, qty: 1, rate: 1500, cost: 0, maxQty: null });
    }
    if (!invoiceItems.find((it) => it.desc === 'Sundries cost')) {
        invoiceItems.push({ id: nextItemId++, inventoryId: null, desc: 'Sundries cost', unit: 'Nos', length: 0, qty: 1, rate: 0, cost: 0, maxQty: null });
    }
    renderInvoiceItems();
}

function removeInvoiceItem(id) {
    invoiceItems = invoiceItems.filter((i) => i.id !== id);
    renderInvoiceItems();
}

function updateInvoiceItem(id, field, value) {
    const it = invoiceItems.find((i) => i.id === id);
    if (!it) return;
    if (field === 'qty' || field === 'rate' || field === 'length') value = parseFloat(value) || 0;
    it[field] = value;
    if (field === 'qty' || field === 'rate') calcInvoiceTotals();
}

// Margin hint HTML shown under a rate cell (auto price + margin feature).
function marginHintHtml(it) {
    const cost = Number(it.cost) || 0;
    const rate = Number(it.rate) || 0;
    if (cost <= 0) return '<div class="margin-hint muted"></div>'; // unknown cost -> nothing to show
    if (rate < cost) {
        return `<div class="margin-hint warn">⚠ below cost Rs.${cost.toFixed(2)}</div>`;
    }
    const pct = rate > 0 ? round2(((rate - cost) / rate) * 100) : 0;
    return `<div class="margin-hint ok">▲ ${pct}% margin</div>`;
}

function renderInvoiceItems() {
    const tbody = document.getElementById('invItemsBody');
    tbody.innerHTML = '';
    const editable = isInvoiceEditable;

    invoiceItems.forEach((it, idx) => {
        const amount = round2((it.qty || 0) * (it.rate || 0));
        tbody.innerHTML += `
            <tr class="item-row">
                <td class="idx">${String(idx + 1).padStart(2, '0')}</td>
                <td><input class="cell left" type="text" value="${escAttr(it.desc)}" oninput="updateInvoiceItem(${it.id}, 'desc', this.value)" ${editable ? '' : 'disabled'}></td>
                <td><input class="cell center" type="text" value="${escAttr(it.unit)}" oninput="updateInvoiceItem(${it.id}, 'unit', this.value)" ${editable ? '' : 'disabled'}></td>
                <td><input class="cell" type="number" value="${it.length}" min="0" step="0.01" oninput="updateInvoiceItem(${it.id}, 'length', this.value)" ${editable ? '' : 'disabled'}></td>
                <td>
                    <input class="cell" type="number" value="${it.qty}" min="0" step="0.01" oninput="updateInvoiceItem(${it.id}, 'qty', this.value)" ${editable ? '' : 'disabled'}>
                    ${it.maxQty !== null && editable ? `<div style="font-size:10px; color:gray">Max: ${it.maxQty}</div>` : ''}
                </td>
                <td>
                    <input class="cell" type="number" value="${it.rate}" min="0" step="0.01" oninput="updateInvoiceItem(${it.id}, 'rate', this.value)" ${editable ? '' : 'disabled'}>
                    ${editable ? marginHintHtml(it) : ''}
                </td>
                <td class="num row-amount">${amount.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td class="row-actions no-print">${editable ? `<button type="button" onclick="removeInvoiceItem(${it.id})" title="Delete">×</button>` : ''}</td>
            </tr>
        `;
    });

    const rowActionsElements = document.querySelectorAll('.row-actions');
    rowActionsElements.forEach((el) => (el.style.display = editable ? '' : 'none'));

    calcInvoiceTotals();
}

function calcInvoiceTotals() {
    let subTotal = 0;
    let materialCost = 0;

    // Pass 1: Find material cost (excludes the auto rows)
    invoiceItems.forEach((it) => {
        if (it.desc !== 'Sundries cost' && it.desc !== 'Technical charges') {
            materialCost += (it.qty || 0) * (it.rate || 0);
        }
    });

    // Auto-update Sundries cost and Technical charges
    const sundriesItem = invoiceItems.find((it) => it.desc === 'Sundries cost');
    if (sundriesItem) sundriesItem.rate = materialCost * 0.12;
    const techItem = invoiceItems.find((it) => it.desc === 'Technical charges');
    if (techItem) techItem.rate = materialCost * 0.9;

    // Pass 2: Calculate subTotal, update row amounts + margin hints
    const rows = document.querySelectorAll('#invItemsBody .item-row');
    invoiceItems.forEach((it, idx) => {
        const amt = round2((it.qty || 0) * (it.rate || 0));
        subTotal += amt;
        const row = rows[idx];
        if (!row) return;

        const rowAmtTd = row.querySelector('.row-amount');
        if (rowAmtTd) rowAmtTd.textContent = amt.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        // Reflect auto-calculated rates in their inputs
        if (it.desc === 'Sundries cost' || it.desc === 'Technical charges') {
            const rateInput = row.querySelector('input[oninput*="rate"]');
            if (rateInput && document.activeElement !== rateInput) rateInput.value = round2(it.rate).toFixed(2);
        }

        // Live-update the margin hint (e.g. when the rate drops below cost)
        const hint = row.querySelector('.margin-hint');
        if (hint && isInvoiceEditable) {
            const tmp = document.createElement('div');
            tmp.innerHTML = marginHintHtml(it);
            const fresh = tmp.firstElementChild;
            if (fresh) { hint.className = fresh.className; hint.textContent = fresh.textContent; }
        }
    });
    subTotal = round2(subTotal);

    // Clamp to [0,100] to match the server, so the preview total can't diverge
    // from what the server will actually store.
    const clampRate = (v) => Math.min(Math.max(parseFloat(v) || 0, 0), 100);
    const ssclRate = clampRate(document.getElementById('invSsclRate').value);
    const vatRate = clampRate(document.getElementById('invVatRate').value);
    const discountInput = parseFloat(document.getElementById('invDiscount').value) || 0;
    const roundToRupee = document.getElementById('invRoundToRupee').checked;

    document.getElementById('invSsclRateText').textContent = ssclRate;
    document.getElementById('invVatRateText').textContent = vatRate;

    // Mirror server tax order: SubTotal -> SSCL -> VAT -> Discount -> (Round off)
    const ssclAmt = round2(subTotal * (ssclRate / 100));
    const preVat = round2(subTotal + ssclAmt);
    const vatAmt = round2(preVat * (vatRate / 100));
    const afterTax = round2(preVat + vatAmt);
    const discount = round2(Math.min(Math.max(discountInput, 0), afterTax));
    let grand = round2(afterTax - discount);
    let roundOff = 0;
    if (roundToRupee) {
        const g = Math.round(grand);
        roundOff = round2(g - grand);
        grand = g;
    }

    document.getElementById('invSubTotal').textContent = formatCurrency(subTotal);
    document.getElementById('invSscl').textContent = formatCurrency(ssclAmt);
    document.getElementById('invVat').textContent = formatCurrency(vatAmt);
    document.getElementById('invDiscountVal').textContent = (discount > 0 ? '- ' : '') + formatCurrency(discount);
    const roRow = document.getElementById('invRoundOffRow');
    if (roundToRupee) {
        roRow.style.display = '';
        document.getElementById('invRoundOff').textContent = formatCurrency(roundOff);
    } else {
        roRow.style.display = 'none';
    }
    document.getElementById('invGrandTotal').textContent = formatCurrency(grand);

    return { subTotal, ssclRate, ssclAmt, vatRate, vatAmt, discount, roundOff, roundToRupee, grand };
}

async function saveInvoice(status) {
    if (invoiceItems.length === 0) return alert('Add at least one item');
    if (savingInvoice) return; // guard against double-click creating duplicates

    const totals = calcInvoiceTotals();
    // The server recomputes every amount from these facts — client totals are
    // only a preview and are intentionally not sent as authoritative money.
    const payload = {
        invoiceId: currentInvoiceId || undefined,
        invoiceNo: document.getElementById('refInvoice').textContent.trim(),
        invoiceDate: document.getElementById('invDate').value,
        billedToName: document.getElementById('billedToName') ? document.getElementById('billedToName').value : '',
        billedToAddress: document.getElementById('billedToAddress') ? document.getElementById('billedToAddress').value : '',
        deliveredToName: document.getElementById('deliveredToName') ? document.getElementById('deliveredToName').value : '',
        deliveredToAddress: document.getElementById('deliveredToAddress') ? document.getElementById('deliveredToAddress').value : '',
        ssclRate: totals.ssclRate,
        vatRate: totals.vatRate,
        discount: totals.discount,
        roundToRupee: totals.roundToRupee,
        items: invoiceItems.map((i) => ({
            inventoryId: i.inventoryId,
            description: i.desc,
            unit: i.unit,
            length: i.length,
            qty: i.qty,
            rate: i.rate,
        })),
    };

    const endpoint = status === 'Draft' ? 'draft' : 'finalize';

    if (status === 'Finalized') {
        if (!confirm('Finalizing will lock this invoice and deduct inventory stock permanently. Proceed?')) return;
    }

    savingInvoice = true;
    const btnDraft = document.getElementById('btnSaveDraft');
    const btnFinal = document.getElementById('btnFinalize');
    if (btnDraft) btnDraft.disabled = true;
    if (btnFinal) btnFinal.disabled = true;
    try {
        const res = await authFetch(`${API_URL}/invoices/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) { alert(data.error || 'Save failed'); return; }

        currentInvoiceId = data.invoiceId;
        if (data.invoiceNo) document.getElementById('refInvoice').textContent = data.invoiceNo;
        alert(`Invoice saved as ${status} (${data.invoiceNo})`);
        loadDashboard();
        showSection('history');
    } catch (err) {
        alert(err.message || err);
    } finally {
        savingInvoice = false;
        if (btnDraft) btnDraft.disabled = false;
        if (btnFinal) btnFinal.disabled = false;
    }
}

// ----------------------------------------------------
// History
// ----------------------------------------------------
function paymentBadgeClass(status) {
    if (status === 'Paid') return 'badge-paid';
    if (status === 'Partial') return 'badge-partial';
    if (status === 'Unpaid') return 'badge-unpaid';
    return 'badge-ok';
}
function statusBadgeClass(status) {
    if (status === 'Draft') return 'badge-draft';
    if (status === 'Finalized') return 'badge-finalized';
    if (status === 'Cancelled') return 'badge-cancelled';
    return 'badge-ok';
}

async function loadHistory() {
    try {
        const res = await authFetch(`${API_URL}/invoices`);
        const data = await res.json();
        const tbody = document.getElementById('history-tbody');
        tbody.innerHTML = '';
        data.forEach((inv) => {
            const isFinalized = inv.Status === 'Finalized';
            const isCancelled = inv.Status === 'Cancelled';
            const balance = Number(inv.Balance) || 0;
            const payBadge = isFinalized
                ? `<span class="badge ${paymentBadgeClass(inv.PaymentStatus)}">${inv.PaymentStatus}</span>`
                : '<span style="color:var(--text-muted)">—</span>';
            const safeNo = String(inv.InvoiceNo).replace(/'/g, "\\'");

            let actions = `<button class="btn btn-secondary btn-text" onclick="viewInvoice(${inv.InvoiceID})">View</button>`;
            if (isFinalized && balance > 0) {
                actions += ` <button class="btn btn-text" style="color:var(--success)" onclick="openPaymentModal(${inv.InvoiceID}, '${safeNo}')">Payment</button>`;
            }
            if (!isCancelled) {
                actions += ` <button class="btn btn-text" style="color:var(--danger)" onclick="cancelInvoice(${inv.InvoiceID}, '${safeNo}')">Cancel</button>`;
            }

            tbody.innerHTML += `
                <tr>
                    <td>${inv.InvoiceNo}</td>
                    <td>${formatDate(inv.InvoiceDate)}</td>
                    <td>${inv.BilledToName || ''}</td>
                    <td>${formatCurrency(inv.GrandTotal)}</td>
                    <td><span class="badge ${statusBadgeClass(inv.Status)}">${inv.Status}</span></td>
                    <td>${payBadge}</td>
                    <td>${isFinalized ? formatCurrency(balance) : '—'}</td>
                    <td>${actions}</td>
                </tr>
            `;
        });
    } catch (e) { console.error('Error loading history', e); }
}

async function viewInvoice(id) {
    try {
        const res = await authFetch(`${API_URL}/invoices/${id}`);
        const inv = await res.json();
        if (inv.error) return alert(inv.error);

        currentInvoiceId = inv.InvoiceID;
        document.getElementById('refInvoice').textContent = inv.InvoiceNo;
        document.getElementById('invDate').value = inv.InvoiceDate ? inv.InvoiceDate.split('T')[0] : '';
        const billedToName = document.getElementById('billedToName');
        if (billedToName) billedToName.value = inv.BilledToName || '';
        const billedToAddress = document.getElementById('billedToAddress');
        if (billedToAddress) billedToAddress.value = inv.BilledToAddress || '';
        const deliveredToName = document.getElementById('deliveredToName');
        if (deliveredToName) deliveredToName.value = inv.DeliveredToName || '';
        const deliveredToAddress = document.getElementById('deliveredToAddress');
        if (deliveredToAddress) deliveredToAddress.value = inv.DeliveredToAddress || '';

        document.getElementById('invSsclRate').value = inv.SSCLRate;
        document.getElementById('invVatRate').value = inv.VATRate;
        document.getElementById('invDiscount').value = Number(inv.Discount) || 0;
        document.getElementById('invRoundToRupee').checked = Math.abs(Number(inv.RoundOff) || 0) > 0;

        // Use the running counter (not idx) so ids stay unique after the user
        // adds more rows — otherwise a new row could collide with a loaded one
        // and edits/deletes would hit the wrong row.
        invoiceItems = inv.items.map((it) => ({
            id: nextItemId++,
            inventoryId: it.InventoryID,
            desc: it.ItemDescription,
            unit: it.Unit,
            length: it.Length,
            qty: it.Qty,
            rate: it.Rate,
            cost: it.Cost || 0,
            maxQty: null,
        }));

        const locked = inv.Status === 'Finalized' || inv.Status === 'Cancelled';
        setInvoiceEditable(!locked);
        renderInvoiceItems();

        if (locked) {
            document.getElementById('invoice-save-actions').style.display = 'flex';
            document.getElementById('btnSaveDraft').style.display = 'none';
            document.getElementById('btnFinalize').style.display = 'none';
            document.getElementById('addItemBtnContainer').style.display = 'none';
        } else {
            document.getElementById('invoice-save-actions').style.display = 'flex';
            document.getElementById('btnSaveDraft').style.display = 'inline-flex';
            document.getElementById('btnFinalize').style.display = 'inline-flex';
            document.getElementById('addItemBtnContainer').style.display = 'flex';
        }

        showSection('new-invoice');
        document.getElementById('invoice-view-title').textContent = `Viewing Invoice: ${inv.InvoiceNo} (${inv.Status})`;
    } catch (e) { alert('Error loading invoice'); }
}

// ----------------------------------------------------
// Payments
// ----------------------------------------------------
async function openPaymentModal(invoiceId, invoiceNo) {
    try {
        const res = await authFetch(`${API_URL}/invoices/${invoiceId}/payments`);
        const data = await res.json();
        if (!res.ok) return alert(data.error || 'Could not load payment details');

        document.getElementById('pay-invoice-id').value = invoiceId;
        document.getElementById('pay-invoice-no').textContent = invoiceNo || ('#' + invoiceId);
        document.getElementById('pay-grand-total').textContent = formatCurrency(data.grandTotal);
        document.getElementById('pay-balance').textContent = formatCurrency(data.balance);
        document.getElementById('pay-amount').value = '';
        document.getElementById('pay-amount').max = data.balance;
        document.getElementById('pay-notes').value = '';
        document.getElementById('pay-date').value = new Date().toISOString().split('T')[0];

        const hist = document.getElementById('pay-history');
        if (data.payments && data.payments.length) {
            hist.innerHTML = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Previous payments</div>' +
                data.payments.map((p) =>
                    `<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid var(--border-color)">
                        <span>${formatDate(p.PaymentDate)} · ${p.Method || ''}</span>
                        <strong>${formatCurrency(p.Amount)}</strong>
                    </div>`
                ).join('');
        } else {
            hist.innerHTML = '';
        }
        openModal('paymentModal');
    } catch (e) { alert(e.message || e); }
}

function setFullPayment() {
    const bal = document.getElementById('pay-amount').max;
    if (bal) document.getElementById('pay-amount').value = bal;
}

let submittingPayment = false;
async function submitPayment(e) {
    e.preventDefault();
    if (submittingPayment) return; // guard against double-click recording twice
    const invoiceId = document.getElementById('pay-invoice-id').value;
    const payload = {
        amount: parseFloat(document.getElementById('pay-amount').value) || 0,
        method: document.getElementById('pay-method').value,
        date: document.getElementById('pay-date').value,
        notes: document.getElementById('pay-notes').value,
    };
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submittingPayment = true;
    if (submitBtn) submitBtn.disabled = true;
    try {
        const res = await authFetch(`${API_URL}/invoices/${invoiceId}/payments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) { alert(data.error || 'Payment failed'); return; }
        alert(`Payment recorded. New balance: ${formatCurrency(data.balance)} (${data.status})`);
        closeModal('paymentModal');
        loadHistory();
        loadDashboard();
    } catch (err) {
        alert(err.message || err);
    } finally {
        submittingPayment = false;
        if (submitBtn) submitBtn.disabled = false;
    }
}

async function cancelInvoice(id, invoiceNo) {
    const reason = prompt(`Cancel invoice ${invoiceNo}?\nAny stock deducted by this invoice will be restored.\n\nEnter a reason:`);
    if (reason === null) return;
    try {
        const res = await authFetch(`${API_URL}/invoices/${id}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
        });
        const data = await res.json();
        if (!res.ok || data.error) { alert(data.error || 'Cancel failed'); return; }
        alert(`Invoice ${invoiceNo} cancelled.`);
        loadHistory();
        loadDashboard();
    } catch (err) { alert(err.message || err); }
}

// ----------------------------------------------------
// Auto-scale Print
// ----------------------------------------------------
window.onbeforeprint = function () {
    const page = document.querySelector('.page');
    if (!page) return;
    page.style.height = 'auto';
    page.style.maxHeight = 'none';
    page.style.overflow = 'visible';
    const trueHeight = page.offsetHeight;
    const targetHeight = 1118; // Approx 296mm at 96dpi
    if (trueHeight > targetHeight) {
        const scale = (targetHeight - 10) / trueHeight;
        page.style.zoom = scale;
    }
};

window.onafterprint = function () {
    const page = document.querySelector('.page');
    if (!page) return;
    page.style.height = '';
    page.style.maxHeight = '';
    page.style.overflow = '';
    page.style.zoom = '';
};

// ----------------------------------------------------
// Transactions
// ----------------------------------------------------
async function loadTransactions() {
    try {
        const res = await authFetch(`${API_URL}/movements`);
        const data = await res.json();
        const tbody = document.getElementById('transactions-tbody');
        tbody.innerHTML = '';
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
    } catch (e) {}
}

// ----------------------------------------------------
// Import & Export
// ----------------------------------------------------
function exportInventory() { window.location.href = exportUrl('/inventory/export'); }
function exportAllInvoices() { window.location.href = exportUrl('/invoices/export'); }
function exportCostComparison() { window.location.href = exportUrl('/costs/export'); }
function exportStockMovements() { window.location.href = exportUrl('/movements/export'); }
function exportInvoiceComparison(invoiceId) { window.location.href = exportUrl(`/invoices/${invoiceId}/compare-export`); }

async function loadExportStats() {
    try {
        const res = await authFetch(`${API_URL}/invoices`);
        const data = await res.json();
        document.getElementById('export-count').textContent = data.length;
    } catch (e) {
        document.getElementById('export-count').textContent = '0';
    }
}

async function loadCostAnalysis() {
    try {
        const res = await authFetch(`${API_URL}/costs/compare`);
        const data = await res.json();

        const tbody = document.getElementById('cost-analysis-tbody');
        tbody.innerHTML = '';

        let totalMatched = 0;
        let sumSavingsPct = 0;
        let maxSavingsPct = 0;

        data.forEach((row) => {
            const formattedOurMeter = row.matched ? formatCurrency(row.ourPriceMeter) : 'N/A';
            const formattedOurFoot = row.matched ? formatCurrency(row.ourPriceFoot) : 'N/A';
            const formattedDiff = row.matched ? formatCurrency(row.diffFoot) : 'N/A';
            const formattedSavingsPct = row.matched ? row.savingsPct.toFixed(1) + '%' : 'N/A';
            const badgeClass = row.matched ? 'badge-finalized' : 'badge-low';
            const badgeText = row.matched ? 'Matched' : 'Not Matched';

            if (row.matched) {
                totalMatched++;
                sumSavingsPct += row.savingsPct;
                if (row.savingsPct > maxSavingsPct) maxSavingsPct = row.savingsPct;
            }

            tbody.innerHTML += `
                <tr>
                    <td><strong>${row.name}</strong></td>
                    <td class="num">${formattedOurMeter}</td>
                    <td class="num">${formattedOurFoot}</td>
                    <td class="num">${formatCurrency(row.outsideCost)}</td>
                    <td class="num" style="color: ${row.matched && row.diffFoot >= 0 ? 'green' : 'red'}; font-weight: 600;">${formattedDiff}</td>
                    <td class="num" style="color: ${row.matched && row.savingsPct >= 0 ? 'green' : 'red'}; font-weight: 600;">${formattedSavingsPct}</td>
                    <td><span class="badge ${badgeClass}">${badgeText}</span></td>
                </tr>
            `;
        });

        const avgSavingsPct = totalMatched > 0 ? sumSavingsPct / totalMatched : 0;
        document.getElementById('cost-stat-count').textContent = `${totalMatched} / ${data.length}`;
        document.getElementById('cost-stat-avg').textContent = `${avgSavingsPct.toFixed(1)}%`;
        document.getElementById('cost-stat-max').textContent = `${maxSavingsPct.toFixed(1)}%`;
    } catch (e) {
        console.error('Error loading cost analysis', e);
    }
}

async function loadInvoiceComparisonList() {
    try {
        const res = await authFetch(`${API_URL}/invoices`);
        const data = await res.json();

        document.getElementById('compare-details-placeholder').style.display = 'flex';
        document.getElementById('compare-details-panel').style.display = 'none';

        const tbody = document.getElementById('compare-invoices-list-tbody');
        tbody.innerHTML = '';

        const finalizedInvoices = data.filter((inv) => inv.Status === 'Finalized');

        if (finalizedInvoices.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:gray;padding:20px;">No finalized invoices found</td></tr>';
            return;
        }

        finalizedInvoices.forEach((inv) => {
            tbody.innerHTML += `
                <tr>
                    <td><strong>${inv.InvoiceNo}</strong><br><span style="font-size:11px;color:gray;">${formatDate(inv.InvoiceDate)}</span></td>
                    <td>${inv.BilledToName || 'Walk-in'}</td>
                    <td><button class="btn btn-secondary btn-text" onclick="compareInvoice(${inv.InvoiceID})">Compare</button></td>
                </tr>
            `;
        });
    } catch (e) {
        console.error('Error loading comparison list', e);
    }
}

async function compareInvoice(id) {
    try {
        const res = await authFetch(`${API_URL}/invoices/${id}/compare`);
        const data = await res.json();
        if (data.error) return alert(data.error);

        document.getElementById('compare-details-placeholder').style.display = 'none';
        document.getElementById('compare-details-panel').style.display = 'flex';

        document.getElementById('compare-inv-no').textContent = `Invoice: ${data.invoiceNo}`;
        document.getElementById('compare-inv-meta').textContent = `Customer: ${data.billedToName || 'Walk-in'} | Date: ${formatDate(data.invoiceDate)}`;

        const exportBtn = document.getElementById('btnExportSingleCompare');
        exportBtn.setAttribute('onclick', `exportInvoiceComparison(${id})`);

        document.getElementById('compare-stat-our').textContent = formatCurrency(data.taxes.ourGrandTotal);
        document.getElementById('compare-stat-outside').textContent = formatCurrency(data.taxes.outsideGrandTotal);
        document.getElementById('compare-stat-savings').textContent = formatCurrency(data.taxes.netSavings);

        document.getElementById('compare-tax-sub-our').textContent = formatCurrency(data.taxes.ourSubtotal);
        document.getElementById('compare-tax-sub-out').textContent = formatCurrency(data.taxes.outsideSubtotal);
        document.getElementById('compare-tax-sub-save').textContent = formatCurrency(data.taxes.outsideSubtotal - data.taxes.ourSubtotal);

        document.getElementById('compare-tax-sscl-our').textContent = formatCurrency(data.taxes.ourSscl);
        document.getElementById('compare-tax-sscl-out').textContent = formatCurrency(data.taxes.outsideSscl);
        document.getElementById('compare-tax-sscl-save').textContent = formatCurrency(data.taxes.outsideSscl - data.taxes.ourSscl);

        document.getElementById('compare-tax-vat-our').textContent = formatCurrency(data.taxes.ourVat);
        document.getElementById('compare-tax-vat-out').textContent = formatCurrency(data.taxes.outsideVat);
        document.getElementById('compare-tax-vat-save').textContent = formatCurrency(data.taxes.outsideVat - data.taxes.ourVat);

        document.getElementById('compare-tax-grand-our').textContent = formatCurrency(data.taxes.ourGrandTotal);
        document.getElementById('compare-tax-grand-out').textContent = formatCurrency(data.taxes.outsideGrandTotal);
        document.getElementById('compare-tax-grand-save').textContent = formatCurrency(data.taxes.netSavings);

        const itemsTbody = document.getElementById('compare-items-tbody');
        itemsTbody.innerHTML = '';
        data.items.forEach((it) => {
            const savings = it.outsideAmount - it.ourAmount;
            itemsTbody.innerHTML += `
                <tr>
                    <td><strong>${it.description}</strong></td>
                    <td class="num">${it.qty} ${it.unit}</td>
                    <td class="num">${formatCurrency(it.ourRate)}</td>
                    <td class="num">${formatCurrency(it.ourAmount)}</td>
                    <td class="num">${it.outsideQty} ${it.outsideUnit}</td>
                    <td class="num">${formatCurrency(it.outsideRate)}</td>
                    <td class="num">${formatCurrency(it.outsideAmount)}</td>
                    <td class="num" style="color: ${savings >= 0 ? 'green' : 'red'}; font-weight: 600;">${formatCurrency(savings)}</td>
                </tr>
            `;
        });
    } catch (e) {
        console.error('Error fetching invoice comparison', e);
        alert('Error fetching invoice comparison details');
    }
}

async function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    const btn = document.querySelector(`button[onclick="document.getElementById('importFile').click()"]`);
    try {
        if (btn) {
            btn.innerHTML = '<i class="ri-loader-4-line"></i> Importing...';
            btn.disabled = true;
        }

        const res = await authFetch(`${API_URL}/inventory/import`, { method: 'POST', body: formData });

        if (res.ok) {
            const data = await res.json();
            alert(`Import successful! Added/Updated ${data.processed} items.`);
            loadInventory();
            loadDashboard();
        } else {
            const err = await res.text();
            alert(`Import failed: ${err}`);
        }
    } catch (e) {
        alert('Error during import.');
        console.error(e);
    } finally {
        if (btn) {
            btn.innerHTML = '<i class="ri-upload-2-line"></i> Import';
            btn.disabled = false;
        }
        event.target.value = '';
    }
}
