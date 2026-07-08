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
// Theme (light / dark)
// ----------------------------------------------------
function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const label = document.getElementById('themeToggleLabel');
    if (label) label.textContent = theme === 'dark' ? '☀️ Light mode' : '🌙 Dark mode';
}
function initTheme() {
    const saved = localStorage.getItem('theme');
    const theme = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(theme);
}
function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', next);
    applyTheme(next);
}

// ----------------------------------------------------
// Responsive sidebar (mobile off-canvas drawer)
// ----------------------------------------------------
function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebarBackdrop');
    const open = sb && sb.classList.toggle('open');
    if (bd) bd.classList.toggle('show', !!open);
}
function closeSidebar() {
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebarBackdrop');
    if (sb) sb.classList.remove('open');
    if (bd) bd.classList.remove('show');
}

// ----------------------------------------------------
// Toasts + top progress bar
// ----------------------------------------------------
function toast(message, type = 'info', ms = 3800) {
    const c = document.getElementById('toastContainer');
    if (!c) { console.log(`[${type}]`, message); return; }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const ic = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';
    el.innerHTML = '<span class="toast-ic"></span><span class="toast-msg"></span>';
    el.querySelector('.toast-ic').textContent = ic;
    el.querySelector('.toast-msg').textContent = message;
    c.appendChild(el);
    setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 220); }, ms);
}

let loadingCount = 0;
function beginLoading() {
    loadingCount++;
    const bar = document.getElementById('topProgress');
    if (bar) bar.classList.add('active');
}
function endLoading() {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0) {
        const bar = document.getElementById('topProgress');
        if (bar) bar.classList.remove('active');
    }
}

// ----------------------------------------------------
// Promise-based confirm / prompt dialog (replaces native confirm/prompt)
// ----------------------------------------------------
let _confirmResolver = null;
function confirmDialog(opts = {}) {
    const { title = 'Please confirm', message = '', confirmText = 'Confirm', danger = false, input = false, placeholder = '', defaultValue = '' } = opts;
    return new Promise((resolve) => {
        _confirmResolver = resolve;
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        const inp = document.getElementById('confirm-input');
        inp.style.display = input ? 'block' : 'none';
        inp.value = defaultValue || '';
        inp.placeholder = placeholder || '';
        const ok = document.getElementById('confirm-ok');
        ok.textContent = confirmText;
        ok.style.background = danger ? 'linear-gradient(135deg,#ef4444,#dc2626)' : '';
        openModal('confirmDialog');
        if (input) setTimeout(() => inp.focus(), 60);
    });
}
function resolveConfirm(ok) {
    const inp = document.getElementById('confirm-input');
    const usingInput = inp.style.display !== 'none';
    closeModal('confirmDialog');
    if (_confirmResolver) {
        const r = _confirmResolver;
        _confirmResolver = null;
        r(ok ? (usingInput ? inp.value : true) : (usingInput ? null : false));
    }
}
function promptDialog(opts) { return confirmDialog({ ...opts, input: true }); }

// ----------------------------------------------------
// Loading skeletons + empty states
// ----------------------------------------------------
function showSkeleton(tbodyId, cols, rows = 5) {
    const tb = document.getElementById(tbodyId);
    if (!tb) return;
    let html = '';
    for (let r = 0; r < rows; r++) {
        html += '<tr class="skeleton-row">';
        for (let c = 0; c < cols; c++) {
            const w = 45 + ((r * 17 + c * 31) % 45);
            html += `<td><span class="skeleton" style="width:${w}%"></span></td>`;
        }
        html += '</tr>';
    }
    tb.innerHTML = html;
}
function emptyRow(tbodyId, cols, emoji, title, sub) {
    const tb = document.getElementById(tbodyId);
    if (tb) tb.innerHTML = `<tr><td colspan="${cols}"><div class="empty-state"><div class="empty-emoji">${emoji}</div><h3>${title}</h3><p>${sub || ''}</p></div></td></tr>`;
}

// In-memory cache for stale-while-revalidate rendering + prefetch.
const dataCache = {};
function invalidateCache(...keys) {
    keys.forEach((k) => { delete dataCache[k]; });
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
    beginLoading();
    try {
        const res = await fetch(url, Object.assign({}, opts, { headers }));
        if (res.status === 401) {
            showLogin();
            throw new Error('Session expired. Please sign in again.');
        }
        return res;
    } finally {
        endLoading();
    }
}

// Download an export through authFetch (so an expired token shows the login
// screen instead of navigating the whole app to a raw 401 JSON page) and save
// the resulting blob. Keeps the token in the Authorization header, never a URL.
async function downloadExport(path, fallbackName) {
    try {
        const res = await authFetch(`${API_URL}${path}`);
        if (!res.ok) { toast('Export failed. Please try again.', 'error'); return; }
        const blob = await res.blob();
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename="?([^"]+)"?/.exec(cd);
        const filename = (m && m[1]) || fallbackName || 'export.xlsx';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        // authFetch already surfaced the login overlay on a 401.
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    initNavigation();

    // Enter key confirms the input dialog.
    const confirmInput = document.getElementById('confirm-input');
    if (confirmInput) confirmInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); resolveConfirm(true); } });

    const authed = await initAuth();
    if (authed) {
        loadDashboard();
        prefetchData(); // warm caches so tab switches are instant
    }

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
        prefetchData();
        toast(`Welcome back, ${data.username || 'admin'}`, 'success');
    } catch (err) {
        errEl.textContent = 'Could not reach the server.';
    }
}

// Warm the caches for the sections the user is most likely to open next, so
// switching tabs renders instantly (then revalidates in the background).
function prefetchData() {
    loadInventory({ background: true });
    loadHistory({ background: true });
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
        toast('Password updated', 'success');
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
            closeSidebar(); // dismiss the mobile drawer after choosing a page
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
        'cost-analysis': 'Rate Card',
        'invoice-comparison': 'Invoice Comparison',
        'labour': 'Labour',
        'expenses': 'Expenses',
        'reports': 'Profit & Loss',
    };
    document.getElementById('page-title').textContent = titles[sectionId];

    if (sectionId === 'dashboard') loadDashboard();
    else if (sectionId === 'inventory') loadInventory();
    else if (sectionId === 'history') loadHistory();
    else if (sectionId === 'transactions') loadTransactions();
    else if (sectionId === 'export-invoices') loadExportStats();
    else if (sectionId === 'cost-analysis') loadRateCard();
    else if (sectionId === 'invoice-comparison') loadInvoiceComparisonList();
    else if (sectionId === 'labour') loadLabour();
    else if (sectionId === 'expenses') loadExpenses();
    else if (sectionId === 'reports') loadReports();
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
function renderDashboard(data) {
    document.getElementById('stat-products').textContent = data.stats.totalInventory;
    document.getElementById('stat-qty').textContent = data.stats.totalQty;
    document.getElementById('stat-low-stock').textContent = data.stats.lowStock;

    const outEl = document.getElementById('stat-outstanding');
    if (outEl) outEl.textContent = formatCurrency(data.stats.outstandingTotal || 0);
    const outCountEl = document.getElementById('stat-outstanding-count');
    if (outCountEl) outCountEl.textContent = `${data.stats.outstandingCount || 0} invoice(s) with balance`;

    const invTbody = document.getElementById('recent-invoices-tbody');
    invTbody.innerHTML = '';
    if (!data.recentInvoices.length) emptyRow('recent-invoices-tbody', 4, '🧾', 'No finalized invoices yet', 'Create and finalize an invoice to see it here.');
    data.recentInvoices.forEach((inv) => {
        invTbody.innerHTML += `
            <tr>
                <td>${inv.InvoiceNo}</td>
                <td>${formatDate(inv.FinalizedAt)}</td>
                <td>${inv.BilledToName || ''}</td>
                <td>${formatCurrency(inv.GrandTotal)}</td>
            </tr>`;
    });

    const movTbody = document.getElementById('recent-movements-tbody');
    movTbody.innerHTML = '';
    if (!data.movements.length) emptyRow('recent-movements-tbody', 5, '📦', 'No stock movements yet', '');
    data.movements.forEach((m) => {
        const isOut = m.MovementType === 'OUT';
        movTbody.innerHTML += `
            <tr>
                <td>${formatDate(m.MovementDate)}</td>
                <td>${m.ProductName || ''}</td>
                <td><span class="badge ${isOut ? 'badge-low' : 'badge-finalized'}">${m.MovementType}</span></td>
                <td>${m.QtyChange}</td>
                <td>${m.NewQty}</td>
            </tr>`;
    });
}

async function loadDashboard() {
    if (dataCache.dashboard) renderDashboard(dataCache.dashboard);
    else {
        showSkeleton('recent-invoices-tbody', 4, 4);
        showSkeleton('recent-movements-tbody', 5, 4);
    }
    try {
        const res = await authFetch(`${API_URL}/dashboard`);
        const data = await res.json();
        dataCache.dashboard = data;
        renderDashboard(data);
        return;
    } catch (e) {
        console.error('Error loading dashboard', e);
        return;
    }
}

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
    if (!items.length) { emptyRow('inventory-tbody', 9, '📦', 'No products found', 'Add a product or adjust your search.'); return; }
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
        if (data.error) toast(data.error, 'error');
        else {
            closeModal('addProductModal');
            invalidateCache('inventory', 'dashboard');
            loadInventory();
            e.target.reset();
            document.getElementById('prod-id').value = '';
            document.getElementById('prod-unique').disabled = false;
            toast(id ? 'Product updated' : 'Product added', 'success');
        }
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
    if (invoiceItems.length === 0) return toast('Add at least one item', 'error');
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
        const ok = await confirmDialog({
            title: 'Finalize invoice?',
            message: 'Finalizing locks this invoice and permanently deducts inventory stock. This cannot be undone (only cancelled).',
            confirmText: 'Finalize & lock',
        });
        if (!ok) return;
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
        if (!res.ok || data.error) { toast(data.error || 'Save failed', 'error'); return; }

        currentInvoiceId = data.invoiceId;
        if (data.invoiceNo) document.getElementById('refInvoice').textContent = data.invoiceNo;
        invalidateCache('dashboard', 'invoices', 'inventory');
        toast(`Invoice ${data.invoiceNo} saved as ${status}`, 'success');
        loadDashboard();
        showSection('history');
    } catch (err) {
        toast(err.message || String(err), 'error');
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

function renderHistory(data) {
    const tbody = document.getElementById('history-tbody');
    tbody.innerHTML = '';
    if (!data.length) { emptyRow('history-tbody', 8, '🧾', 'No invoices yet', 'Create your first invoice from “New Invoice”.'); return; }
    data.forEach((inv) => {
        const isFinalized = inv.Status === 'Finalized';
        const isCancelled = inv.Status === 'Cancelled';
        const balance = Number(inv.Balance) || 0;
        const payBadge = isFinalized
            ? `<span class="badge ${paymentBadgeClass(inv.PaymentStatus)}">${inv.PaymentStatus}</span>`
            : '<span style="color:var(--text-muted)">—</span>';
        const safeNo = escAttr(inv.InvoiceNo).replace(/'/g, "\\'");

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
            </tr>`;
    });
}

async function loadHistory(opts = {}) {
    if (dataCache.invoices) {
        if (!opts.background) renderHistory(dataCache.invoices);
    } else if (!opts.background) {
        showSkeleton('history-tbody', 8);
    }
    try {
        const res = await authFetch(`${API_URL}/invoices`);
        const data = await res.json();
        dataCache.invoices = data;
        if (!opts.background) renderHistory(data);
    } catch (e) { console.error('Error loading history', e); }
}

async function viewInvoice(id) {
    try {
        const res = await authFetch(`${API_URL}/invoices/${id}`);
        const inv = await res.json();
        if (inv.error) return toast(inv.error, 'error');

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
    } catch (e) { toast('Error loading invoice', 'error'); }
}

// ----------------------------------------------------
// Payments
// ----------------------------------------------------
async function openPaymentModal(invoiceId, invoiceNo) {
    try {
        const res = await authFetch(`${API_URL}/invoices/${invoiceId}/payments`);
        const data = await res.json();
        if (!res.ok) return toast(data.error || 'Could not load payment details', 'error');

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
    } catch (e) { toast(e.message || String(e), 'error'); }
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
        if (!res.ok || data.error) { toast(data.error || 'Payment failed', 'error'); return; }
        invalidateCache('invoices', 'dashboard');
        toast(`Payment recorded — balance ${formatCurrency(data.balance)} (${data.status})`, 'success');
        closeModal('paymentModal');
        loadHistory();
        loadDashboard();
    } catch (err) {
        toast(err.message || String(err), 'error');
    } finally {
        submittingPayment = false;
        if (submitBtn) submitBtn.disabled = false;
    }
}

async function cancelInvoice(id, invoiceNo) {
    const reason = await promptDialog({
        title: `Cancel invoice ${invoiceNo}?`,
        message: 'Any stock deducted by this invoice will be restored. Enter a reason:',
        confirmText: 'Cancel invoice',
        danger: true,
        placeholder: 'e.g. customer changed the order',
    });
    if (reason === null) return;
    try {
        const res = await authFetch(`${API_URL}/invoices/${id}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
        });
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Cancel failed', 'error'); return; }
        invalidateCache('invoices', 'dashboard', 'inventory');
        toast(`Invoice ${invoiceNo} cancelled`, 'success');
        loadHistory();
        loadDashboard();
    } catch (err) { toast(err.message || String(err), 'error'); }
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
function exportInvoiceComparison(invoiceId) { downloadExport(`/invoices/${invoiceId}/compare-export`, 'Invoice_Comparison.xlsx'); }

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

function renderRateCard(data) {
    allRates = data;
    const tbody = document.getElementById('cost-analysis-tbody');
    tbody.innerHTML = '';
    if (!data.length) { emptyRow('cost-analysis-tbody', 7, '🏷️', 'No rates yet', 'Add a rate or run the migration to seed the researched defaults.'); return; }
    let sumSav = 0, sumMar = 0;
    data.forEach((r) => {
        sumSav += Number(r.savingsPct) || 0;
        sumMar += Number(r.marginPct) || 0;
        tbody.innerHTML += `
            <tr>
                <td><strong>${r.label}</strong></td>
                <td class="num">${formatCurrency(r.ourCost)}</td>
                <td class="num">${formatCurrency(r.ourPrice)}</td>
                <td class="num">${formatCurrency(r.outsidePrice)}</td>
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

const SIZECODE_INCH = { '6': 0.25, '8': 0.3125, '10': 0.375, '13': 0.5, '16': 0.625, '19': 0.75, '25': 1.0, '32': 1.25 };
function rateSyncSizeInch() {
    const code = document.getElementById('rate-sizecode').value;
    if (SIZECODE_INCH[code] !== undefined) document.getElementById('rate-sizeinch').value = SIZECODE_INCH[code];
}

function openRateModal(id) {
    document.getElementById('rateForm').reset();
    document.getElementById('rate-id').value = '';
    document.getElementById('rateModalTitle').textContent = 'Add Rate';
    if (id) {
        const r = allRates.find((x) => x.rateId === id);
        if (r) {
            document.getElementById('rate-id').value = r.rateId;
            document.getElementById('rate-label').value = r.label || '';
            document.getElementById('rate-spec').value = r.spec || 'R2';
            document.getElementById('rate-sizecode').value = r.sizeCode || '13';
            document.getElementById('rate-sizeinch').value = r.sizeInch || '';
            document.getElementById('rate-ourcost').value = r.ourCost || 0;
            document.getElementById('rate-ourprice').value = r.ourPrice || 0;
            document.getElementById('rate-outside').value = r.outsidePrice || 0;
            document.getElementById('rateModalTitle').textContent = 'Edit Rate';
        }
    } else {
        rateSyncSizeInch();
    }
    openModal('rateModal');
}

async function submitRate(e) {
    e.preventDefault();
    const id = document.getElementById('rate-id').value;
    const payload = {
        label: document.getElementById('rate-label').value,
        spec: document.getElementById('rate-spec').value,
        sizeCode: document.getElementById('rate-sizecode').value,
        sizeInch: document.getElementById('rate-sizeinch').value,
        unit: 'ft',
        ourCost: document.getElementById('rate-ourcost').value,
        ourPrice: document.getElementById('rate-ourprice').value,
        outsidePrice: document.getElementById('rate-outside').value,
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

// ----------------------------------------------------
// Labour (workers + payments)
// ----------------------------------------------------
let allWorkers = [];
function thisMonth() { return new Date().toISOString().slice(0, 7); }

async function loadLabour() {
    showSkeleton('labour-tbody', 6, 4);
    try {
        const [wRes, lRes] = await Promise.all([authFetch(`${API_URL}/workers`), authFetch(`${API_URL}/labour`)]);
        const workers = await wRes.json();
        const labour = await lRes.json();
        if (!wRes.ok) { toast(workers.error || 'Could not load workers', 'error'); return; }
        allWorkers = Array.isArray(workers) ? workers : [];
        renderWorkers(allWorkers);
        renderLabour(Array.isArray(labour) ? labour : []);
        loadTechnical();
    } catch (e) { console.error('Error loading labour', e); }
}

// Technician charges owed (from each invoice's "Technical charges" line)
async function loadTechnical() {
    showSkeleton('technical-tbody', 7, 4);
    try {
        const res = await authFetch(`${API_URL}/labour/technical`);
        const data = await res.json();
        if (!res.ok) { toast(data.error || 'Could not load technician charges', 'error'); return; }
        renderTechnical(data);
    } catch (e) { console.error('Error loading technical charges', e); }
}

function renderTechnical(data) {
    const tb = document.getElementById('technical-tbody');
    tb.innerHTML = '';
    const rows = (data && data.charges) || [];
    if (!rows.length) { emptyRow('technical-tbody', 7, '🔧', 'No technical charges yet', 'Finalized invoices with a “Technical charges” line show up here.'); }
    rows.forEach((r) => {
        const safeNo = escAttr(r.invoiceNo).replace(/'/g, "\\'");
        const status = r.paid
            ? `<span class="badge badge-paid">Paid</span>`
            : `<span class="badge badge-unpaid">Unpaid</span>`;
        const action = r.paid
            ? `<button class="btn btn-text" style="color:var(--danger)" onclick="unpayTechnical(${r.invoiceId}, '${safeNo}')">Mark Unpaid</button>`
            : `<button class="btn btn-text" style="color:var(--success)" onclick="openTechPay(${r.invoiceId}, '${safeNo}', ${r.amount})">Mark Paid</button>`;
        tb.innerHTML += `
            <tr>
                <td><strong>${r.invoiceNo}</strong></td>
                <td>${formatDate(r.invoiceDate)}</td>
                <td>${r.billedToName || 'Walk-in'}</td>
                <td class="num">${formatCurrency(r.amount)}</td>
                <td>${status}</td>
                <td>${r.paid ? (r.workerName || '<span style="color:var(--text-muted)">Unassigned</span>') : '—'}</td>
                <td>${action}</td>
            </tr>`;
    });
    const t = (data && data.totals) || {};
    document.getElementById('tech-stat-total').textContent = formatCurrency(t.totalCharge);
    document.getElementById('tech-stat-paid').textContent = formatCurrency(t.totalPaid);
    document.getElementById('tech-stat-out').textContent = formatCurrency(t.outstanding);
}

function openTechPay(invoiceId, invoiceNo, amount) {
    document.getElementById('techpay-invoice-id').value = invoiceId;
    document.getElementById('techpay-invoice-no').textContent = invoiceNo;
    document.getElementById('techpay-amount').textContent = formatCurrency(amount);
    document.getElementById('techpay-date').value = new Date().toISOString().split('T')[0];
    const sel = document.getElementById('techpay-worker');
    sel.innerHTML = '<option value="">— Unassigned —</option>' + allWorkers.map((w) => `<option value="${w.WorkerID}">${w.Name}</option>`).join('');
    openModal('techPayModal');
}

async function submitTechPay(e) {
    e.preventDefault();
    const invoiceId = document.getElementById('techpay-invoice-id').value;
    const payload = {
        workerId: document.getElementById('techpay-worker').value || null,
        paidDate: document.getElementById('techpay-date').value,
        method: document.getElementById('techpay-method').value,
    };
    try {
        const res = await authFetch(`${API_URL}/labour/technical/${invoiceId}/pay`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Could not mark paid', 'error'); return; }
        closeModal('techPayModal');
        invalidateCache('dashboard');
        loadLabour();
        toast('Technician charge marked paid', 'success');
    } catch (err) { toast(String(err), 'error'); }
}

async function unpayTechnical(invoiceId, invoiceNo) {
    const ok = await confirmDialog({ title: `Mark unpaid?`, message: `Undo the technician payment for ${invoiceNo}? This removes the linked labour payment.`, confirmText: 'Mark unpaid', danger: true });
    if (!ok) return;
    try {
        const res = await authFetch(`${API_URL}/labour/technical/${invoiceId}/unpay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Failed', 'error'); return; }
        invalidateCache('dashboard');
        loadLabour();
        toast('Marked unpaid', 'success');
    } catch (err) { toast(String(err), 'error'); }
}

function renderWorkers(workers) {
    const tb = document.getElementById('workers-tbody');
    tb.innerHTML = '';
    if (!workers.length) { emptyRow('workers-tbody', 3, '👷', 'No workers', 'Add your team members.'); }
    else workers.forEach((w) => {
        tb.innerHTML += `<tr><td><strong>${w.Name}</strong></td><td>${w.Role || '-'}</td><td><button class="btn btn-text" style="color:var(--danger)" onclick="deleteWorker(${w.WorkerID})">Del</button></td></tr>`;
    });
    document.getElementById('labour-stat-workers').textContent = workers.filter((w) => w.Active !== 0).length;
    // populate labour worker select
    const sel = document.getElementById('labour-worker');
    if (sel) sel.innerHTML = '<option value="">— Monthly total (whole team) —</option>' + workers.map((w) => `<option value="${w.WorkerID}">${w.Name}</option>`).join('');
}

function renderLabour(rows) {
    const tb = document.getElementById('labour-tbody');
    tb.innerHTML = '';
    const month = thisMonth();
    let monthTotal = 0, allTotal = 0;
    if (!rows.length) emptyRow('labour-tbody', 6, '💵', 'No labour payments yet', 'Record monthly wages or per-worker payments.');
    rows.forEach((p) => {
        const amt = Number(p.Amount) || 0;
        allTotal += amt;
        if ((p.PayPeriod || '').startsWith(month)) monthTotal += amt;
        const techMatch = String(p.Notes || '').match(/^TECHPAYOUT#\d+ · (.+)$/);
        const worker = techMatch
            ? `${p.WorkerName || 'Technician'} <span style="font-size:11px;color:var(--text-muted)">· job ${techMatch[1]}</span>`
            : (p.WorkerName || '<span style="color:var(--text-muted)">Whole team</span>');
        tb.innerHTML += `
            <tr>
                <td>${formatDate(p.PaymentDate)}</td>
                <td>${worker}</td>
                <td>${p.PayPeriod || '-'}</td>
                <td class="num">${formatCurrency(amt)}</td>
                <td>${p.Method || '-'}</td>
                <td><button class="btn btn-text" style="color:var(--danger)" onclick="deleteLabour(${p.LabourPaymentID})">Del</button></td>
            </tr>`;
    });
    document.getElementById('labour-stat-month').textContent = formatCurrency(monthTotal);
    document.getElementById('labour-stat-total').textContent = formatCurrency(allTotal);
}

function openWorkerModal() { document.getElementById('workerForm').reset(); openModal('workerModal'); }
async function submitWorker(e) {
    e.preventDefault();
    try {
        const res = await authFetch(`${API_URL}/workers`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: document.getElementById('worker-name').value, role: document.getElementById('worker-role').value }),
        });
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Save failed', 'error'); return; }
        closeModal('workerModal'); loadLabour(); toast('Worker added', 'success');
    } catch (err) { toast(String(err), 'error'); }
}
async function deleteWorker(id) {
    const ok = await confirmDialog({ title: 'Delete worker?', message: 'Their past payments stay in the ledger.', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await authFetch(`${API_URL}/workers/${id}`, { method: 'DELETE' }); loadLabour(); toast('Worker deleted', 'success'); }
    catch (err) { toast(String(err), 'error'); }
}

function openLabourModal() {
    document.getElementById('labourForm').reset();
    document.getElementById('labour-period').value = thisMonth();
    document.getElementById('labour-date').value = new Date().toISOString().split('T')[0];
    openModal('labourModal');
}
async function submitLabour(e) {
    e.preventDefault();
    const payload = {
        workerId: document.getElementById('labour-worker').value || null,
        amount: document.getElementById('labour-amount').value,
        payPeriod: document.getElementById('labour-period').value,
        paymentDate: document.getElementById('labour-date').value,
        method: document.getElementById('labour-method').value,
        notes: document.getElementById('labour-notes').value,
    };
    try {
        const res = await authFetch(`${API_URL}/labour`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Save failed', 'error'); return; }
        closeModal('labourModal'); loadLabour(); invalidateCache('dashboard'); toast('Labour payment recorded', 'success');
    } catch (err) { toast(String(err), 'error'); }
}
async function deleteLabour(id) {
    const ok = await confirmDialog({ title: 'Delete payment?', message: 'Remove this labour payment?', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await authFetch(`${API_URL}/labour/${id}`, { method: 'DELETE' }); loadLabour(); toast('Payment deleted', 'success'); }
    catch (err) { toast(String(err), 'error'); }
}

// ----------------------------------------------------
// Expenses
// ----------------------------------------------------
async function loadExpenses() {
    showSkeleton('expenses-tbody', 6, 4);
    try {
        const res = await authFetch(`${API_URL}/expenses`);
        const rows = await res.json();
        if (!res.ok) { toast(rows.error || 'Could not load expenses', 'error'); return; }
        renderExpenses(Array.isArray(rows) ? rows : []);
    } catch (e) { console.error('Error loading expenses', e); }
}
function renderExpenses(rows) {
    const tb = document.getElementById('expenses-tbody');
    tb.innerHTML = '';
    const month = thisMonth();
    let monthTotal = 0, allTotal = 0;
    if (!rows.length) emptyRow('expenses-tbody', 6, '🧾', 'No expenses yet', 'Log rent, electricity, purchases and more.');
    rows.forEach((x) => {
        const amt = Number(x.Amount) || 0;
        allTotal += amt;
        const d = x.ExpenseDate ? new Date(x.ExpenseDate) : null;
        if (d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === month) monthTotal += amt;
        tb.innerHTML += `
            <tr>
                <td>${formatDate(x.ExpenseDate)}</td>
                <td><span class="badge badge-ok">${x.Category || 'Other'}</span></td>
                <td>${x.Notes || '-'}</td>
                <td>${x.Method || '-'}</td>
                <td class="num">${formatCurrency(amt)}</td>
                <td><button class="btn btn-text" style="color:var(--danger)" onclick="deleteExpense(${x.ExpenseID})">Del</button></td>
            </tr>`;
    });
    document.getElementById('exp-stat-month').textContent = formatCurrency(monthTotal);
    document.getElementById('exp-stat-total').textContent = formatCurrency(allTotal);
}
function openExpenseModal() {
    document.getElementById('expenseForm').reset();
    document.getElementById('expense-date').value = new Date().toISOString().split('T')[0];
    openModal('expenseModal');
}
async function submitExpense(e) {
    e.preventDefault();
    const payload = {
        category: document.getElementById('expense-category').value,
        amount: document.getElementById('expense-amount').value,
        expenseDate: document.getElementById('expense-date').value,
        method: document.getElementById('expense-method').value,
        notes: document.getElementById('expense-notes').value,
    };
    try {
        const res = await authFetch(`${API_URL}/expenses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Save failed', 'error'); return; }
        closeModal('expenseModal'); loadExpenses(); toast('Expense saved', 'success');
    } catch (err) { toast(String(err), 'error'); }
}
async function deleteExpense(id) {
    const ok = await confirmDialog({ title: 'Delete expense?', message: 'Remove this expense from the ledger?', confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await authFetch(`${API_URL}/expenses/${id}`, { method: 'DELETE' }); loadExpenses(); toast('Expense deleted', 'success'); }
    catch (err) { toast(String(err), 'error'); }
}

// ----------------------------------------------------
// Reports: Monthly P&L + per-invoice profit
// ----------------------------------------------------
async function loadReports() {
    showSkeleton('pl-tbody', 10, 3);
    showSkeleton('invoice-profit-tbody', 7, 4);
    try {
        const [plRes, ipRes] = await Promise.all([authFetch(`${API_URL}/reports/pl`), authFetch(`${API_URL}/reports/invoice-profit`)]);
        const pl = await plRes.json();
        const ip = await ipRes.json();
        if (!plRes.ok) { toast(pl.error || 'Could not load P&L', 'error'); return; }
        renderPL(pl);
        renderInvoiceProfit(ip);
    } catch (e) { console.error('Error loading reports', e); }
}

function signed(n) {
    const v = Number(n) || 0;
    const color = v >= 0 ? '#10b981' : '#ef4444';
    return `<span style="color:${color};font-weight:600;">${formatCurrency(v)}</span>`;
}

function renderPL(pl) {
    const t = pl.totals || {};
    document.getElementById('pl-stat-revenue').textContent = formatCurrency(t.revenue);
    document.getElementById('pl-stat-costs').textContent = formatCurrency(t.totalCosts);
    document.getElementById('pl-stat-net').innerHTML = signed(t.netProfit);
    document.getElementById('pl-stat-margin').textContent = `${(t.netMarginPct == null ? 0 : t.netMarginPct)}% margin`;
    document.getElementById('pl-stat-cash').innerHTML = signed(t.cashNet);

    const tb = document.getElementById('pl-tbody');
    tb.innerHTML = '';
    const months = pl.months || [];
    if (!months.length) { emptyRow('pl-tbody', 10, '📈', 'No data yet', 'Finalize invoices and log labour/expenses to see your P&L.'); return; }
    months.forEach((m) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${m.month}</strong></td>
                <td class="num">${formatCurrency(m.revenue)}</td>
                <td class="num">${formatCurrency(m.cogs)}</td>
                <td class="num">${formatCurrency(m.grossProfit)}</td>
                <td class="num">${formatCurrency(m.labour)}</td>
                <td class="num">${formatCurrency(m.expenses)}</td>
                <td class="num">${signed(m.netProfit)}</td>
                <td class="num">${m.netMarginPct == null ? '-' : m.netMarginPct + '%'}</td>
                <td class="num">${formatCurrency(m.paymentsIn)}</td>
                <td class="num">${formatCurrency(m.cashOut)}</td>
            </tr>`;
    });
}

function renderInvoiceProfit(ip) {
    const tb = document.getElementById('invoice-profit-tbody');
    tb.innerHTML = '';
    const rows = (ip && ip.invoices) || [];
    if (!rows.length) { emptyRow('invoice-profit-tbody', 7, '🧾', 'No finalized invoices', ''); return; }
    rows.forEach((r) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${r.invoiceNo}</strong></td>
                <td>${formatDate(r.invoiceDate)}</td>
                <td>${r.billedToName || 'Walk-in'}</td>
                <td class="num">${formatCurrency(r.revenueExTax)}</td>
                <td class="num">${formatCurrency(r.materialCost)}</td>
                <td class="num">${signed(r.grossProfit)}</td>
                <td class="num">${r.grossMarginPct == null ? '-' : r.grossMarginPct + '%'}</td>
            </tr>`;
    });
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
        if (data.error) return toast(data.error, 'error');

        document.getElementById('compare-details-placeholder').style.display = 'none';
        document.getElementById('compare-details-panel').style.display = 'flex';

        document.getElementById('compare-inv-no').textContent = `Invoice: ${data.invoiceNo}`;
        document.getElementById('compare-inv-meta').textContent = `Customer: ${data.billedToName || 'Walk-in'} | Date: ${formatDate(data.invoiceDate)}`;

        const exportBtn = document.getElementById('btnExportSingleCompare');
        exportBtn.setAttribute('onclick', `exportInvoiceComparison(${id})`);

        document.getElementById('compare-stat-our').textContent = formatCurrency(data.taxes.ourGrandTotal);
        document.getElementById('compare-stat-outside').textContent = formatCurrency(data.taxes.outsideGrandTotal);
        document.getElementById('compare-stat-savings').textContent = formatCurrency(data.taxes.netSavings);

        const profit = data.profit || {};
        document.getElementById('compare-stat-profit').textContent = formatCurrency(profit.grossProfit);
        document.getElementById('compare-stat-profit-pct').textContent = `${profit.grossMarginPct == null ? 0 : profit.grossMarginPct}% margin · cost ${formatCurrency(profit.ourCost)}`;

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
            const profit = (Number(it.ourAmount) || 0) - (Number(it.ourCost) || 0);
            itemsTbody.innerHTML += `
                <tr>
                    <td><strong>${it.description}</strong></td>
                    <td class="num">${it.qty} ${it.unit}</td>
                    <td class="num">${formatCurrency(it.ourAmount)}</td>
                    <td class="num">${formatCurrency(it.ourCost)}</td>
                    <td class="num" style="color: ${profit >= 0 ? '#10b981' : '#ef4444'}; font-weight: 600;">${formatCurrency(profit)}</td>
                    <td class="num">${it.matched ? formatCurrency(it.outsideAmount) : '<span style="color:var(--text-muted)">—</span>'}</td>
                    <td class="num" style="color: ${savings >= 0 ? '#10b981' : '#ef4444'}; font-weight: 600;">${it.matched ? formatCurrency(savings) : '—'}</td>
                </tr>
            `;
        });
    } catch (e) {
        console.error('Error fetching invoice comparison', e);
        toast('Error fetching invoice comparison details', 'error');
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
            invalidateCache('inventory', 'dashboard');
            toast(`Import successful — ${data.processed} item(s) added/updated`, 'success');
            loadInventory();
            loadDashboard();
        } else {
            const err = await res.text();
            toast(`Import failed: ${err}`, 'error');
        }
    } catch (e) {
        toast('Error during import.', 'error');
        console.error(e);
    } finally {
        if (btn) {
            btn.innerHTML = '<i class="ri-upload-2-line"></i> Import';
            btn.disabled = false;
        }
        event.target.value = '';
    }
}
