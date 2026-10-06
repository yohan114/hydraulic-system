/* ===== CONTROLS: assets, stock valuation, stock takes, ageing, year-end ===== */

let ctlTab = 'stock';

function ctlShowTab(tab) {
    ctlTab = tab;
    ['stock', 'takes', 'assets', 'ageing', 'recon', 'credits'].forEach((t) => {
        const pane = document.getElementById(`ctl-pane-${t}`);
        if (pane) pane.style.display = t === tab ? '' : 'none';
        const btn = document.getElementById(`ctl-tab-${t}`);
        if (btn) {
            btn.classList.toggle('btn-primary', t === tab);
            btn.classList.toggle('btn-secondary', t !== tab);
        }
    });
    loadControls();
}

async function loadControls() {
    try {
        if (ctlTab === 'stock') renderStockValuation(await (await authFetch(`${API_URL}/stock/valuation`)).json());
        else if (ctlTab === 'takes') renderStockTakes(await (await authFetch(`${API_URL}/stock-takes`)).json());
        else if (ctlTab === 'assets') renderAssets(await (await authFetch(`${API_URL}/assets`)).json());
        else if (ctlTab === 'ageing') renderAgeing(await (await authFetch(`${API_URL}/receivables/ageing`)).json());
        else if (ctlTab === 'recon') renderReconciliation(await (await authFetch(`${API_URL}/reconciliation/status`)).json());
        else if (ctlTab === 'credits') loadCreditsAndApprovals();
    } catch (e) { console.error('Error loading controls', e); }
}

function renderStockValuation(d) {
    // The reconciliation banner is the point of this screen: does the shelf
    // agree with the books?
    document.getElementById('ctl-stock-recon').innerHTML = d.reconciled
        ? `<div class="bc-warn" style="background:#dcfce7;color:#166534;">✓ Stock on the shelf agrees with the ledger — ${formatCurrency(d.total)}</div>`
        : `<div class="bc-warn" style="background:#fee2e2;color:#991b1b;">⚠ Shelf ${formatCurrency(d.total)} vs ledger ${formatCurrency(d.ledgerStock)} — difference ${formatCurrency(d.difference)}</div>`;

    const tb = document.getElementById('ctl-stock-tbody');
    tb.innerHTML = d.byCategory.map((c) => `
        <tr>
            <td><strong>${escAttr(c.category)}</strong></td>
            <td class="num">${c.items}</td>
            <td class="num">${c.qty}</td>
            <td class="num">${formatCurrency(c.value)}</td>
            <td class="num">${d.total > 0 ? ((c.value / d.total) * 100).toFixed(1) + '%' : '—'}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="flat" style="text-align:center;padding:20px;">No stock</td></tr>';

    document.getElementById('ctl-stock-tfoot').innerHTML = `
        <tr class="analysis-total"><td><strong>TOTAL</strong></td><td class="num">${d.count}</td><td></td>
            <td class="num"><strong>${formatCurrency(d.total)}</strong></td><td></td></tr>`;

    document.getElementById('ctl-stock-negative').innerHTML = d.negative.length
        ? `<p class="analysis-note neg"><strong>${d.negative.length} item(s) show negative stock</strong> — a data problem worth fixing:
           ${d.negative.map((n) => escAttr(n.name)).join(', ')}</p>` : '';
}

function renderStockTakes(rows) {
    const tb = document.getElementById('ctl-takes-tbody');
    tb.innerHTML = '';
    if (!rows.length) { emptyRow('ctl-takes-tbody', 6, '📋', 'No stock takes yet', 'Open one to count the shelf against the system.'); return; }
    rows.forEach((t) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${escAttr(t.TakeNo)}</strong></td>
                <td>${formatDate(t.TakeDate)}</td>
                <td class="num">${t.Lines}</td>
                <td>${escAttr(t.CountedBy) || '<span class="flat">—</span>'}</td>
                <td><span class="badge ${t.Status === 'posted' ? 'badge-finalized' : 'badge-draft'}">${escAttr(t.Status)}</span></td>
                <td><button class="btn btn-text" onclick="openStockTake(${t.StockTakeID})">${t.Status === 'posted' ? 'View' : 'Count'}</button></td>
            </tr>`;
    });
}

function renderAssets(rows) {
    const tb = document.getElementById('ctl-assets-tbody');
    tb.innerHTML = '';
    const active = rows.filter((a) => a.Status === 'active');
    document.getElementById('ctl-asset-cost').textContent = formatCurrency(active.reduce((a, x) => a + x.Cost, 0));
    document.getElementById('ctl-asset-nbv').textContent = formatCurrency(active.reduce((a, x) => a + x.NetBookValue, 0));

    if (!rows.length) { emptyRow('ctl-assets-tbody', 7, '🏭', 'No fixed assets registered', 'Register the crimping machine so its depreciation reaches the books.'); return; }
    rows.forEach((a) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${escAttr(a.Name)}</strong>${a.Code ? `<br><span style="font-size:11px;color:var(--text-muted);">${escAttr(a.Code)}</span>` : ''}</td>
                <td>${escAttr(a.Category) || '<span class="flat">—</span>'}</td>
                <td>${formatDate(a.InServiceFrom)}</td>
                <td class="num">${formatCurrency(a.Cost)}</td>
                <td class="num">${formatCurrency(a.Accumulated)}</td>
                <td class="num"><strong>${formatCurrency(a.NetBookValue)}</strong></td>
                <td>${a.LifeMonths} mo${a.LastPeriod ? `<br><span style="font-size:11px;color:var(--text-muted);">to ${escAttr(a.LastPeriod)}</span>` : ''}</td>
            </tr>`;
    });
}

function renderAgeing(d) {
    const b = d.buckets;
    document.getElementById('ctl-ageing-buckets').innerHTML = `
        <div class="jp-foot-cell"><span class="k">Not yet due</span><span class="v">${formatCurrency(b.current)}</span></div>
        <div class="jp-foot-cell"><span class="k">1–30 days</span><span class="v">${formatCurrency(b.d30)}</span></div>
        <div class="jp-foot-cell"><span class="k">31–60 days</span><span class="v">${formatCurrency(b.d60)}</span></div>
        <div class="jp-foot-cell"><span class="k">61–90 days</span><span class="v">${formatCurrency(b.d90)}</span></div>
        <div class="jp-foot-cell"><span class="k">Over 90 days</span><span class="v neg">${formatCurrency(b.older)}</span></div>
        <div class="jp-foot-cell jp-unpaid"><span class="k">Owed by customers</span><span class="v">${formatCurrency(b.total)}</span></div>`;

    const tb = document.getElementById('ctl-ageing-tbody');
    tb.innerHTML = '';
    if (!d.invoices.length) { emptyRow('ctl-ageing-tbody', 6, '✅', 'Nothing outstanding', 'Every external invoice is settled.'); return; }
    d.invoices.forEach((i) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${escAttr(i.InvoiceNo)}</strong></td>
                <td>${escAttr(i.CustomerName) || '<span class="flat">—</span>'}</td>
                <td>${formatDate(i.InvoiceDate)}</td>
                <td>${formatDate(i.Due)}</td>
                <td class="num">${formatCurrency(i.GrandTotal)}</td>
                <td class="num neg">${formatCurrency(i.Outstanding)}</td>
            </tr>`;
    });
}

// ---- actions ----

async function runDepreciation(period, allowFuture) {
    period = period || prompt('Charge depreciation for which month? (YYYY-MM)', new Date().toISOString().slice(0, 7));
    if (!period) return;
    try {
        const res = await authFetch(`${API_URL}/assets/depreciation/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(allowFuture ? { period, allowFuture: true } : { period }),
        });
        const d = await res.json();
        if (!res.ok) {
            // A month that has not begun is nearly always a typo, so it is refused
            // by default — but let someone who means it say so.
            if (/has not started yet/.test(d.error || '') && confirm(`${d.error}\n\nCharge ${period} anyway?`)) {
                return runDepreciation(period, true);
            }
            return toast(d.error || 'Could not run depreciation', 'error');
        }
        toast(d.total > 0
            ? `Charged ${formatCurrency(d.total)} across ${d.charged.length} asset(s) for ${period}`
            : `Nothing to charge for ${period}${d.skipped.length ? ` (${d.skipped.length} skipped)` : ''}`,
            d.total > 0 ? 'success' : 'info');
        loadControls();
    } catch (e) { toast(String(e), 'error'); }
}

function openAssetModal() {
    document.getElementById('asset-name').value = '';
    document.getElementById('asset-code').value = '';
    document.getElementById('asset-category').value = 'Plant';
    document.getElementById('asset-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('asset-cost').value = '';
    document.getElementById('asset-residual').value = '0';
    document.getElementById('asset-life').value = '60';
    document.getElementById('asset-opening').checked = false;
    openModal('assetModal');
}

async function submitAsset(event) {
    event.preventDefault();
    try {
        const res = await authFetch(`${API_URL}/assets`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: document.getElementById('asset-name').value.trim(),
                code: document.getElementById('asset-code').value.trim(),
                category: document.getElementById('asset-category').value,
                inServiceFrom: document.getElementById('asset-date').value,
                cost: Number(document.getElementById('asset-cost').value) || 0,
                residual: Number(document.getElementById('asset-residual').value) || 0,
                lifeMonths: Number(document.getElementById('asset-life').value) || 0,
                opening: document.getElementById('asset-opening').checked,
            }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not register the asset', 'error');
        closeModal('assetModal');
        toast('Asset registered', 'success');
        ctlShowTab('assets');
    } catch (e) { toast(String(e), 'error'); }
}

async function newStockTake() {
    if (!confirm('Open a new count sheet with the current system quantities?')) return;
    try {
        const res = await authFetch(`${API_URL}/stock-takes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ takeDate: new Date().toISOString().slice(0, 10) }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not open the stock take', 'error');
        toast(`${d.takeNo} opened with ${d.lines} line(s)`, 'success');
        ctlShowTab('takes');
        openStockTake(d.takeId);
    } catch (e) { toast(String(e), 'error'); }
}

async function openStockTake(takeId) {
    try {
        const res = await authFetch(`${API_URL}/stock-takes/${takeId}`);
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not load the stock take', 'error');
        const posted = d.Status === 'posted';

        document.getElementById('stockTakeTitle').textContent = `${d.TakeNo} — ${formatDate(d.TakeDate)}${posted ? ' (posted)' : ''}`;
        document.getElementById('stock-take-id').value = takeId;
        document.getElementById('stockTakeBody').innerHTML = `
            <p class="analysis-note">Enter what you actually counted. Lines that agree are left alone; the difference posts to Stock Adjustments.</p>
            <div class="table-responsive" style="max-height:420px;overflow-y:auto;">
                <table class="table">
                    <thead><tr><th>Item</th><th class="num">System</th><th class="num">Counted</th><th class="num">Diff</th><th class="num">Value</th></tr></thead>
                    <tbody>${d.lines.map((l) => `
                        <tr>
                            <td>${escAttr(l.name)}<br><span style="font-size:11px;color:var(--text-muted);">${escAttr(l.category) || ''}</span></td>
                            <td class="num">${l.systemQty}</td>
                            <td class="num">${posted ? l.countedQty
                                : `<input type="number" class="form-control st-count" data-id="${l.stockTakeItemId}" step="0.01" value="${l.countedQty}" style="width:110px;text-align:right;">`}</td>
                            <td class="num ${l.qtyDiff < 0 ? 'neg' : l.qtyDiff > 0 ? 'pos' : 'flat'}">${l.qtyDiff || ''}</td>
                            <td class="num ${l.valueDiff < 0 ? 'neg' : l.valueDiff > 0 ? 'pos' : 'flat'}">${l.valueDiff ? formatCurrency(l.valueDiff) : ''}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            <p class="analysis-note">Shortages <span class="neg">${formatCurrency(d.shortages)}</span> ·
               overages <span class="pos">${formatCurrency(d.overages)}</span> ·
               net <strong>${formatCurrency(d.totalVariance)}</strong></p>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="downloadCountSheet(${takeId})">
                    <i class="ri-file-excel-line"></i> ${posted ? 'Download result' : 'Download count sheet'}
                </button>
                ${posted ? '' : `
                <button class="btn btn-secondary" onclick="saveStockTake()">Save counts</button>
                <button class="btn btn-primary admin-only" onclick="postStockTake()">Post &amp; adjust stock</button>`}
            </div>`;
        openModal('stockTakeModal');
    } catch (e) { toast(String(e), 'error'); }
}

function downloadCountSheet(takeId) {
    downloadExport(`/stock-takes/${takeId}/export`, 'Stock_Count_Sheet.xlsx');
}

async function saveStockTake() {
    const takeId = document.getElementById('stock-take-id').value;
    const counts = [...document.querySelectorAll('.st-count')].map((el) => ({
        stockTakeItemId: Number(el.dataset.id), countedQty: Number(el.value) || 0,
    }));
    try {
        const res = await authFetch(`${API_URL}/stock-takes/${takeId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ counts }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not save the counts', 'error');
        toast(`Saved — net variance ${formatCurrency(d.totalVariance)}`, 'success');
        openStockTake(takeId);
    } catch (e) { toast(String(e), 'error'); }
}

async function postStockTake() {
    const takeId = document.getElementById('stock-take-id').value;
    await saveStockTake();
    if (!confirm('Post this count? Stock will be adjusted to the counted quantities and the difference goes to Stock Adjustments.')) return;
    try {
        const res = await authFetch(`${API_URL}/stock-takes/${takeId}/post`, { method: 'POST' });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not post the stock take', 'error');
        closeModal('stockTakeModal');
        toast(`Posted — ${d.adjusted} line(s) adjusted, net ${formatCurrency(d.totalVariance)}`, 'success');
        ctlShowTab('stock');
    } catch (e) { toast(String(e), 'error'); }
}

async function closeYear() {
    const through = prompt('Close the year through which date? (YYYY-MM-DD)', `${new Date().getFullYear()}-12-31`);
    if (!through) return;
    if (!confirm(`Sweep all income and expense accounts to Retained Earnings as at ${through}? This posts a journal and cannot be undone except by reversing it.`)) return;
    try {
        const res = await authFetch(`${API_URL}/ledger/close-year`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ throughDate: through }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not close the year', 'error');
        toast(`Year closed — ${formatCurrency(d.netProfit)} carried to Retained Earnings`, 'success');
    } catch (e) { toast(String(e), 'error'); }
}

/* ==========================================================================
   DOMAIN RECONCILIATION & CONTINUOUS CONTROL VERIFICATION
   ========================================================================== */

function renderReconciliation(d) {
    if (!d) return;

    // 1. Reconciliation Banner
    const banner = document.getElementById('ctl-recon-banner');
    if (banner) {
        banner.innerHTML = d.isBalanced
            ? `<div class="bc-warn" style="background:#dcfce7;color:#166534;font-size:14px;padding:14px 20px;border-radius:8px;">
                <strong>✓ All Control Accounts Reconciled</strong> — Stock (1300), AR (1200), AP (2100) and GL journals are 100% balanced with zero orphaned transactions.
               </div>`
            : `<div class="bc-warn" style="background:#fee2e2;color:#991b1b;font-size:14px;padding:14px 20px;border-radius:8px;">
                <strong>⚠ Control Account Variance Detected</strong> — Review subledger valuations against General Ledger postings below.
               </div>`;
    }

    // 2. Stat Cards Grid
    const statsGrid = document.getElementById('ctl-recon-stats');
    if (statsGrid) {
        const inv = d.inventory || {};
        const ar = d.accountsReceivable || {};
        const ap = d.accountsPayable || {};
        const comp = d.completeness || { orphanedInvoices: [], orphanedPayments: [] };

        const invOk = !!inv.isReconciled;
        const arOk = !!ar.isReconciled;
        const apOk = !!ap.isReconciled;
        const compOk = !!comp.isComplete;

        statsGrid.innerHTML = `
            <div class="stat-card">
                <div class="stat-icon" style="background:${invOk ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)'};color:${invOk ? '#10b981' : '#ef4444'};">
                    <i class="ri-box-3-line"></i>
                </div>
                <div class="stat-details">
                    <h3>Stock vs GL 1300</h3>
                    <p style="font-size:18px;">${formatCurrency(inv.subledgerValuation || 0)}</p>
                    <span style="font-size:12px;color:${invOk ? 'var(--success)' : 'var(--danger)'};">
                        ${invOk ? '✓ Reconciled' : `Diff: ${formatCurrency(inv.difference || 0)}`}
                    </span>
                </div>
            </div>

            <div class="stat-card">
                <div class="stat-icon" style="background:${arOk ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)'};color:${arOk ? '#10b981' : '#ef4444'};">
                    <i class="ri-user-received-line"></i>
                </div>
                <div class="stat-details">
                    <h3>AR vs GL 1200</h3>
                    <p style="font-size:18px;">${formatCurrency(ar.subledgerBalance || 0)}</p>
                    <span style="font-size:12px;color:${arOk ? 'var(--success)' : 'var(--danger)'};">
                        ${arOk ? '✓ Reconciled' : `Diff: ${formatCurrency(ar.difference || 0)}`}
                    </span>
                </div>
            </div>

            <div class="stat-card">
                <div class="stat-icon" style="background:${apOk ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)'};color:${apOk ? '#10b981' : '#ef4444'};">
                    <i class="ri-truck-line"></i>
                </div>
                <div class="stat-details">
                    <h3>AP vs GL 2100</h3>
                    <p style="font-size:18px;">${formatCurrency(ap.subledgerBalance || 0)}</p>
                    <span style="font-size:12px;color:${apOk ? 'var(--success)' : 'var(--danger)'};">
                        ${apOk ? '✓ Reconciled' : `Diff: ${formatCurrency(ap.difference || 0)}`}
                    </span>
                </div>
            </div>

            <div class="stat-card">
                <div class="stat-icon" style="background:${compOk ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)'};color:${compOk ? '#10b981' : '#ef4444'};">
                    <i class="ri-shield-check-line"></i>
                </div>
                <div class="stat-details">
                    <h3>Journal Completeness</h3>
                    <p style="font-size:18px;">${compOk ? '100% Posted' : `${(comp.orphanedInvoices.length + comp.orphanedPayments.length)} Exception(s)`}</p>
                    <span style="font-size:12px;color:${compOk ? 'var(--success)' : 'var(--danger)'};">
                        ${compOk ? '✓ No Missing Postings' : 'Action Required'}
                    </span>
                </div>
            </div>
        `;
    }

    // 3. Table Rows
    const tb = document.getElementById('ctl-recon-tbody');
    if (tb) {
        const rows = [
            {
                name: 'Inventory Stock Valuation',
                code: '1300',
                sub: d.inventory?.subledgerValuation || 0,
                gl: d.inventory?.glBalance || 0,
                diff: d.inventory?.difference || 0,
                ok: d.inventory?.isReconciled,
            },
            {
                name: 'Accounts Receivable (Trade Debtors)',
                code: '1200',
                sub: d.accountsReceivable?.subledgerBalance || 0,
                gl: d.accountsReceivable?.glBalance || 0,
                diff: d.accountsReceivable?.difference || 0,
                ok: d.accountsReceivable?.isReconciled,
            },
            {
                name: 'Accounts Payable (Trade Creditors)',
                code: '2100',
                sub: d.accountsPayable?.subledgerBalance || 0,
                gl: d.accountsPayable?.glBalance || 0,
                diff: d.accountsPayable?.difference || 0,
                ok: d.accountsPayable?.isReconciled,
            },
        ];

        tb.innerHTML = rows.map((r) => `
            <tr>
                <td><strong>${escAttr(r.name)}</strong></td>
                <td><span style="font-family:monospace;font-weight:600;color:var(--text-muted);">${escAttr(r.code)}</span></td>
                <td class="num">${formatCurrency(r.sub)}</td>
                <td class="num">${formatCurrency(r.gl)}</td>
                <td class="num" style="color:${r.ok ? 'var(--success)' : 'var(--danger)'};font-weight:600;">
                    ${formatCurrency(r.diff)}
                </td>
                <td>
                    <span class="badge ${r.ok ? 'badge-finalized' : 'badge-cancelled'}">
                        ${r.ok ? 'Balanced' : 'Discrepancy'}
                    </span>
                </td>
            </tr>
        `).join('');
    }

    // 4. Completeness Card
    const compBody = document.getElementById('ctl-completeness-body');
    if (compBody) {
        const invs = (d.completeness && d.completeness.orphanedInvoices) || [];
        const pays = (d.completeness && d.completeness.orphanedPayments) || [];

        if (invs.length === 0 && pays.length === 0) {
            compBody.innerHTML = `
                <div style="display:flex;align-items:center;gap:12px;color:var(--success);font-size:14px;">
                    <i class="ri-checkbox-circle-fill" style="font-size:20px;"></i>
                    <span>All finalized invoices, revisions, and customer payment receipts have verified General Ledger journal entries.</span>
                </div>
            `;
        } else {
            let html = '<div style="margin-bottom:12px;color:var(--danger);font-weight:600;">⚠ The following records exist without corresponding GL Journal Entries:</div>';
            if (invs.length) {
                html += `
                    <h4 style="font-size:13px;margin:8px 0;">Orphaned Finalized Invoices (${invs.length})</h4>
                    <table class="table" style="margin-bottom:16px;">
                        <thead><tr><th>Invoice #</th><th>Date</th><th class="num">Grand Total</th><th>Type</th></tr></thead>
                        <tbody>${invs.map((i) => `
                            <tr>
                                <td><strong>#${escAttr(i.InvoiceNo || i.InvoiceID)}</strong></td>
                                <td>${formatDate(i.InvoiceDate)}</td>
                                <td class="num">${formatCurrency(i.GrandTotal)}</td>
                                <td><span class="badge ${i.IsInternal ? 'badge-draft' : 'badge-finalized'}">${i.IsInternal ? 'Internal Fleet' : 'Customer'}</span></td>
                            </tr>
                        `).join('')}</tbody>
                    </table>
                `;
            }
            if (pays.length) {
                html += `
                    <h4 style="font-size:13px;margin:8px 0;">Orphaned Receipts (${pays.length})</h4>
                    <table class="table">
                        <thead><tr><th>Payment ID</th><th>Invoice ID</th><th>Date</th><th>Method</th><th class="num">Amount</th></tr></thead>
                        <tbody>${pays.map((p) => `
                            <tr>
                                <td>#${p.PaymentID}</td>
                                <td>Invoice #${p.InvoiceID}</td>
                                <td>${formatDate(p.PaymentDate)}</td>
                                <td>${escAttr(p.Method)}</td>
                                <td class="num">${formatCurrency(p.Amount)}</td>
                            </tr>
                        `).join('')}</tbody>
                    </table>
                `;
            }
            compBody.innerHTML = html;
        }
    }
}

/* ==========================================================================
   CUSTOMER CREDITS & DUAL-CONTROL APPROVAL WORKFLOW
   ========================================================================== */

async function loadCreditsAndApprovals() {
    try {
        const [creditsRes, approvalsRes] = await Promise.all([
            authFetch(`${API_URL}/credits`),
            authFetch(`${API_URL}/approvals`),
        ]);

        const credits = creditsRes.ok ? await creditsRes.json() : [];
        const approvals = approvalsRes.ok ? await approvalsRes.json() : [];

        renderCreditsTable(credits);
        renderApprovalsTable(approvals);
    } catch (e) { console.error('Error loading credits/approvals', e); }
}

function renderCreditsTable(rows) {
    const tb = document.getElementById('ctl-credits-tbody');
    if (!tb) return;
    if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="7" class="flat" style="text-align:center;padding:24px;">No customer credits on record.</td></tr>';
        return;
    }
    tb.innerHTML = rows.map((c) => {
        const isOpen = c.Status === 'open';
        const actionBtn = isOpen
            ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="openRefundRequestModal(${c.CreditID}, ${c.RemainingAmount}, '${escAttr(c.CustomerName || '')}')">Request Refund</button>`
            : '—';
        return `
            <tr>
                <td><strong>CRD-${c.CreditID}</strong></td>
                <td><strong>${escAttr(c.CustomerName || 'Customer #' + c.CustomerID)}</strong></td>
                <td><span style="font-size:12px;color:var(--text-muted);">${escAttr(c.SourceType)} (${escAttr(c.SourceID)})</span></td>
                <td class="num">${formatCurrency(c.OriginalAmount)}</td>
                <td class="num" style="font-weight:600;color:${isOpen ? 'var(--primary)' : 'var(--text-muted)'};">${formatCurrency(c.RemainingAmount)}</td>
                <td><span class="badge ${isOpen ? 'badge-finalized' : 'badge-draft'}">${escAttr(c.Status)}</span></td>
                <td>${actionBtn}</td>
            </tr>
        `;
    }).join('');
}

function renderApprovalsTable(rows) {
    const tb = document.getElementById('ctl-approvals-tbody');
    if (!tb) return;
    if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="7" class="flat" style="text-align:center;padding:24px;">No approvals in queue.</td></tr>';
        return;
    }
    tb.innerHTML = rows.map((a) => {
        const isPending = a.Status === 'pending';
        const isApproved = a.Status === 'approved';
        let actions = '—';

        if (isPending) {
            actions = `
                <div style="display:flex;gap:6px;">
                    <button class="btn btn-success" style="padding:4px 10px;font-size:12px;" onclick="decideRefundApproval(${a.TargetID}, ${a.ApprovalID}, 'approved')">Approve</button>
                    <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;color:var(--danger);" onclick="decideRefundApproval(${a.TargetID}, ${a.ApprovalID}, 'rejected')">Reject</button>
                </div>
            `;
        } else if (isApproved) {
            actions = `
                <button class="btn btn-primary" style="padding:4px 10px;font-size:12px;" onclick="executeApprovedRefund(${a.TargetID}, ${a.ApprovalID}, ${a.CreditRemaining || 0})">Execute Payout</button>
            `;
        }

        const badgeClass = a.Status === 'approved' ? 'badge-finalized' : a.Status === 'consumed' ? 'badge-paid' : a.Status === 'rejected' ? 'badge-cancelled' : 'badge-draft';

        return `
            <tr>
                <td><strong>APP-${a.ApprovalID}</strong></td>
                <td><span style="font-weight:600;text-transform:uppercase;font-size:11px;">${escAttr(a.ApprovalType)}</span></td>
                <td>${escAttr(a.CustomerName || 'Credit #' + a.TargetID)}</td>
                <td>${escAttr(a.RequestedBy)}</td>
                <td><span class="badge ${badgeClass}">${escAttr(a.Status)}</span></td>
                <td>
                    <span style="font-size:12px;color:var(--text-muted);font-family:monospace;" title="${escAttr(a.PayloadHash || '')}">
                        ${a.DecisionReason ? escAttr(a.DecisionReason) : (a.PayloadHash ? a.PayloadHash.slice(0, 10) + '…' : '—')}
                    </span>
                </td>
                <td>${actions}</td>
            </tr>
        `;
    }).join('');
}

function openRefundRequestModal(creditId, remainingAmount, customerName) {
    document.getElementById('ref-req-credit-id').value = creditId;
    document.getElementById('ref-req-customer-name').textContent = customerName || `Credit #${creditId}`;
    document.getElementById('ref-req-remaining').textContent = formatCurrency(remainingAmount);
    document.getElementById('ref-req-amount').value = remainingAmount;
    document.getElementById('ref-req-amount').max = remainingAmount;
    document.getElementById('ref-req-notes').value = '';
    openModal('refundRequestModal');
}

async function submitRefundRequest(e) {
    e.preventDefault();
    const creditId = document.getElementById('ref-req-credit-id').value;
    const amount = Number(document.getElementById('ref-req-amount').value);
    const paymentMethod = document.getElementById('ref-req-method').value;
    const notes = document.getElementById('ref-req-notes').value;

    try {
        const res = await authFetch(`${API_URL}/credits/${creditId}/refund/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, paymentMethod, notes }),
        });
        const data = await res.json();
        if (!res.ok) return toast(data.error || 'Could not submit refund request', 'error');

        closeModal('refundRequestModal');
        toast(`Refund request submitted for approval (APP-${data.approvalId})`, 'success');
        loadCreditsAndApprovals();
    } catch (err) { toast(String(err), 'error'); }
}

async function decideRefundApproval(creditId, approvalId, decision) {
    const reason = decision === 'rejected' ? prompt('Reason for rejection:') : 'Approved by manager';
    if (decision === 'rejected' && reason === null) return;

    try {
        const res = await authFetch(`${API_URL}/credits/${creditId}/refund/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approvalId, decision, reason }),
        });
        const data = await res.json();
        if (!res.ok) {
            return toast(data.error || 'Approval failed: ' + (data.code || ''), 'error');
        }
        toast(`Approval updated: ${decision}`, 'success');
        loadCreditsAndApprovals();
    } catch (err) { toast(String(err), 'error'); }
}

async function executeApprovedRefund(creditId, approvalId, amount) {
    if (!confirm(`Execute refund payout for Credit #${creditId}? This will post the journal to Account 2150 (Credits) & Cash.`)) return;

    try {
        const res = await authFetch(`${API_URL}/credits/${creditId}/refund/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ approvalId, amount }),
        });
        const data = await res.json();
        if (!res.ok) {
            return toast(data.error || 'Execution failed: ' + (data.code || ''), 'error');
        }
        toast(`Refund #${data.refundId} executed and posted to ledger!`, 'success');
        loadCreditsAndApprovals();
    } catch (err) { toast(String(err), 'error'); }
}
