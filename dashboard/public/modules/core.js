/* ===== CORE: state, auth, navigation, helpers — split from app.js; loaded as an ordered classic script (shared global scope) ===== */
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
    // Snap floating-point noise to 15 significant digits BEFORE scaling, exactly
    // like server lib/money.js. Without this, a product such as 0.025 * 1.4 lands
    // one ULP below the 0.035 tie and the preview/print rounds DOWN to 0.03 while
    // the server stores 0.04 — making the printed bill disagree with the DB.
    const snapped = Number(n.toPrecision(15));
    const base = isFinite(snapped) ? snapped : n;
    const shifted = Number(`${base}e2`);
    if (!isFinite(shifted)) return Math.round(base * 100) / 100;
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
        'suppliers': 'Suppliers',
        'new-invoice': 'Invoice Document',
        'history': 'Invoice History',
        'transactions': 'Stock Movements',
        'export-invoices': 'Export Invoices',
        'cost-analysis': 'Rate Card',
        'invoice-comparison': 'Invoice Comparison',
        'price-analysis': 'Price Analysis',
        'labour': 'Labour',
        'expenses': 'Expenses',
        'reports': 'Profit & Loss',
    };
    document.getElementById('page-title').textContent = titles[sectionId];

    if (sectionId === 'dashboard') loadDashboard();
    else if (sectionId === 'inventory') loadInventory();
    else if (sectionId === 'suppliers') loadSuppliers();
    else if (sectionId === 'history') loadHistory();
    else if (sectionId === 'transactions') loadTransactions();
    else if (sectionId === 'export-invoices') loadExportStats();
    else if (sectionId === 'cost-analysis') loadRateCard();
    else if (sectionId === 'invoice-comparison') loadInvoiceComparisonList();
    else if (sectionId === 'price-analysis') loadPriceAnalysis();
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

