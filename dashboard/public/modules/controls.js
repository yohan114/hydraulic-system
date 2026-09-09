/* ===== CONTROLS: assets, stock valuation, stock takes, ageing, year-end ===== */

let ctlTab = 'stock';

function ctlShowTab(tab) {
    ctlTab = tab;
    ['stock', 'takes', 'assets', 'ageing'].forEach((t) => {
        document.getElementById(`ctl-pane-${t}`).style.display = t === tab ? '' : 'none';
        const btn = document.getElementById(`ctl-tab-${t}`);
        btn.classList.toggle('btn-primary', t === tab);
        btn.classList.toggle('btn-secondary', t !== tab);
    });
    loadControls();
}

async function loadControls() {
    try {
        if (ctlTab === 'stock') renderStockValuation(await (await authFetch(`${API_URL}/stock/valuation`)).json());
        else if (ctlTab === 'takes') renderStockTakes(await (await authFetch(`${API_URL}/stock-takes`)).json());
        else if (ctlTab === 'assets') renderAssets(await (await authFetch(`${API_URL}/assets`)).json());
        else renderAgeing(await (await authFetch(`${API_URL}/receivables/ageing`)).json());
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
