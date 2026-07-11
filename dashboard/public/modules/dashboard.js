/* ===== DASHBOARD: stats, labour, expenses, reports/P&L — split from app.js; loaded as an ordered classic script (shared global scope) ===== */
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

    renderLowStock(data.lowStockItems || []);
}

// Low-stock widget: items at/below their per-item reorder level, worst first.
function renderLowStock(items) {
    const tbody = document.getElementById('low-stock-tbody');
    if (!tbody) return;
    const badge = document.getElementById('low-stock-count-badge');
    if (badge) { badge.textContent = items.length; badge.style.display = items.length ? 'inline-block' : 'none'; }
    tbody.innerHTML = '';
    if (!items.length) { emptyRow('low-stock-tbody', 7, '✅', 'All stock levels healthy', 'No items are at or below their reorder level.'); return; }
    items.forEach((it) => {
        tbody.innerHTML += `
            <tr>
                <td><strong>${escAttr(it.UniqueID) || '-'}</strong></td>
                <td>${escAttr(it.ProductName) || ''}</td>
                <td>${escAttr(it.SpecificationCode) || '-'}</td>
                <td><span class="badge badge-low">${it.Qty} ${escAttr(it.Unit) || ''}</span></td>
                <td>${it.ReorderLevel}</td>
                <td>${it.SupplierName ? escAttr(it.SupplierName) : '<span style="color:var(--text-muted)">—</span>'}</td>
                <td><button class="btn btn-text" onclick="openPurchaseModal(${it.InventoryID})">Buy</button></td>
            </tr>`;
    });
}

async function loadDashboard(opts = {}) {
    if (dataCache.dashboard) renderDashboard(dataCache.dashboard);
    else if (!opts.background) {
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

let currentCompareId = null;
function compareTier() {
    const sel = document.getElementById('compare-tier');
    return sel ? sel.value : 'mid';
}
function reloadComparison() {
    if (currentCompareId) compareInvoice(currentCompareId);
}

async function compareInvoice(id) {
    try {
        currentCompareId = id;
        const tier = compareTier();
        const res = await authFetch(`${API_URL}/invoices/${id}/compare?tier=${tier}`);
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
            const vsMarket = (Number(it.outsideAmount) || 0) - (Number(it.ourAmount) || 0);
            const profit = (Number(it.ourAmount) || 0) - (Number(it.ourCost) || 0);
            itemsTbody.innerHTML += `
                <tr>
                    <td><strong>${it.description}</strong></td>
                    <td class="num">${it.qty} ${it.unit}</td>
                    <td class="num">${formatCurrency(it.ourCost)}</td>
                    <td class="num">${formatCurrency(it.ourAmount)}</td>
                    <td class="num" style="color: ${profit >= 0 ? '#10b981' : '#ef4444'}; font-weight: 600;">${formatCurrency(profit)}</td>
                    <td class="num">${it.matched ? formatCurrency(it.outsideAmount) : '<span style="color:var(--text-muted)">—</span>'}</td>
                    <td class="num" style="color: ${vsMarket >= 0 ? '#10b981' : '#ef4444'}; font-weight: 600;">${it.matched ? formatCurrency(vsMarket) : '—'}</td>
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
