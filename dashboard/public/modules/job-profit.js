/* ===== JOB PROFIT ANALYSIS: per-invoice profit + unpaid labour tracking (split module) ===== */

let jobProfitData = { invoices: [], totals: {} };
let jpInvoiceOptionsLoaded = false;

// Build the filter query. Explicit From/To override the Month picker.
function jpBuildQuery() {
    const p = new URLSearchParams();
    const from = document.getElementById('jp-from').value;
    const to = document.getElementById('jp-to').value;
    const month = document.getElementById('jp-month').value;
    if (from || to) {
        if (from) p.set('from', from);
        if (to) p.set('to', to);
    } else if (month) {
        p.set('from', month + '-01');
        // last day of the month
        const [y, m] = month.split('-').map(Number);
        const last = new Date(y, m, 0).getDate();
        p.set('to', `${month}-${String(last).padStart(2, '0')}`);
    }
    const sel = document.getElementById('jp-invoices');
    const chosen = sel ? [...sel.selectedOptions].map((o) => o.value) : [];
    if (chosen.length) p.set('invoices', chosen.join(','));
    p.set('status', document.getElementById('jp-status').value || 'all');
    return p;
}

function jpOnMonth() {
    // Picking a month clears explicit dates so the month takes effect.
    document.getElementById('jp-from').value = '';
    document.getElementById('jp-to').value = '';
}

async function jpLoadInvoiceOptions() {
    if (jpInvoiceOptionsLoaded) return;
    try {
        const res = await authFetch(`${API_URL}/invoices`);
        const data = await res.json();
        const finalized = (Array.isArray(data) ? data : []).filter((i) => i.Status === 'Finalized');
        const sel = document.getElementById('jp-invoices');
        if (sel) sel.innerHTML = finalized.map((i) => `<option value="${escAttr(i.InvoiceNo)}">${escAttr(i.InvoiceNo)}</option>`).join('');
        jpInvoiceOptionsLoaded = true;
    } catch (e) { console.error('Error loading invoice options', e); }
}

function jpFilterInvoiceOptions() {
    const q = document.getElementById('jp-invoice-search').value.toLowerCase();
    document.querySelectorAll('#jp-invoices option').forEach((o) => {
        o.hidden = q && !o.value.toLowerCase().includes(q);
    });
}

async function loadJobProfit() {
    await jpLoadInvoiceOptions();
    generateJobProfit();
}

async function generateJobProfit() {
    showSkeleton('job-profit-tbody', 10, 5);
    try {
        const res = await authFetch(`${API_URL}/job-profit?${jpBuildQuery().toString()}`);
        const data = await res.json();
        if (!res.ok) { toast(data.error || 'Could not load job profit analysis', 'error'); return; }
        jobProfitData = data;
        renderJobProfit(data);
    } catch (e) { console.error('Error loading job profit', e); }
}

function jpFmtPct(v) { return `${v == null ? 0 : v}%`; }
function jpProfitColor(v) { return Number(v) >= 0 ? '#10b981' : '#ef4444'; }
function jpMarginColor(m) { return m >= 20 ? '#10b981' : (m >= 0 ? '#f59e0b' : '#ef4444'); }

function renderJobProfit(data) {
    const t = data.totals || {};
    document.getElementById('jp-kpi-bill').textContent = formatCurrency(t.ourBill);
    document.getElementById('jp-kpi-cost').textContent = formatCurrency(t.materialCost);
    document.getElementById('jp-kpi-outside').textContent = formatCurrency(t.outsideCost);
    document.getElementById('jp-kpi-profit').innerHTML = `<span style="color:${jpProfitColor(t.grossProfit)}">${formatCurrency(t.grossProfit)}</span>`;
    document.getElementById('jp-kpi-margin').textContent = `${t.margin == null ? 0 : t.margin}% margin`;
    document.getElementById('jp-kpi-unpaid').innerHTML = `<span style="color:#dc2626;font-weight:700;">${formatCurrency(t.unpaidTech)}</span>`;
    document.getElementById('jp-kpi-unpaid-count').textContent = `${t.unpaidCount || 0} jobs unpaid`;

    const tb = document.getElementById('job-profit-tbody');
    tb.innerHTML = '';
    const rows = data.invoices || [];
    if (!rows.length) { emptyRow('job-profit-tbody', 10, '📊', 'No jobs match', 'Adjust the filters and Generate again.'); jpRenderFooter(t); return; }

    rows.forEach((inv) => {
        // Row tint: unpaid labour -> amber; else profit>0 green, profit<0 red.
        const unpaid = inv.techCharges > 0 && !inv.techPaid;
        const tint = unpaid ? 'background:rgba(245,158,11,.10);'
            : (inv.profit > 0 ? 'background:rgba(16,185,129,.08);' : (inv.profit < 0 ? 'background:rgba(239,68,68,.07);' : ''));
        const noEsc = escAttr(inv.invoiceNo).replace(/'/g, "\\'");
        const labour = inv.techPaid
            ? `<span class="badge" style="background:#dcfce7;color:#166534;cursor:pointer;font-weight:600;" onclick="toggleLabourPaid('${noEsc}', true)" title="Click to mark unpaid">🟢 Paid</span>`
            : `<span class="badge" style="background:#fee2e2;color:#991b1b;cursor:pointer;font-weight:600;" onclick="toggleLabourPaid('${noEsc}', false)" title="Click to mark paid">🔴 Unpaid</span>`;
        tb.innerHTML += `
            <tr style="${tint}">
                <td><strong>${escAttr(inv.invoiceNo)}</strong></td>
                <td>${formatDate(inv.invoiceDate)}</td>
                <td>${escAttr(inv.customer) || 'Walk-in'}</td>
                <td class="num">${formatCurrency(inv.ourBill)}</td>
                <td class="num">${formatCurrency(inv.outsideCost)}</td>
                <td class="num" style="color:${jpProfitColor(inv.profit)};font-weight:600;">${formatCurrency(inv.profit)}</td>
                <td class="num" style="color:${jpMarginColor(inv.margin)};font-weight:600;">${jpFmtPct(inv.margin)}</td>
                <td class="num">${formatCurrency(inv.techCharges)}</td>
                <td>${labour}</td>
                <td><button class="btn btn-text" onclick="toggleJobDetail(${inv.invoiceId})">View Details</button></td>
            </tr>
            <tr class="jp-detail-row" id="jp-detail-${inv.invoiceId}" style="display:none;">
                <td colspan="10" style="background:#fafafa;padding:0;">${jpDetailTable(inv)}</td>
            </tr>`;
    });

    jpRenderFooter(t);
}

function jpDetailTable(inv) {
    const rows = inv.lines.map((l, i) => {
        const tint = l.isTech ? 'background:#fff7ed;' : '';
        const diffColor = l.diff >= 0 ? '#10b981' : '#ef4444';
        return `<tr style="${tint}">
            <td class="num">${i + 1}</td>
            <td>${escAttr(l.description)}${l.isTech ? ' <span style="color:#c2410c;font-weight:700;" title="Technical / crimping labour">◆</span>' : ''}</td>
            <td>${escAttr(l.unit)}</td>
            <td class="num">${l.length || 0}</td>
            <td class="num">${l.qty}</td>
            <td class="num">${formatCurrency(l.ourCostRate)}</td>
            <td class="num">${formatCurrency(l.ourBilledRate)}</td>
            <td class="num">${formatCurrency(l.outsideRate)}</td>
            <td class="num">${formatCurrency(l.ourAmount)}</td>
            <td class="num">${formatCurrency(l.outsideAmount)}</td>
            <td class="num" style="color:${diffColor};font-weight:600;">${formatCurrency(l.diff)}</td>
        </tr>`;
    }).join('');
    return `<table class="table" style="margin:0;font-size:12px;">
        <thead><tr>
            <th class="num">#</th><th>Description</th><th>Unit</th><th class="num">Length</th><th class="num">Qty</th>
            <th class="num">Our Cost Rate</th><th class="num">Our Billed Rate</th><th class="num">Outside Market Rate</th>
            <th class="num">Our Amount</th><th class="num">Outside Amount</th><th class="num">Diff</th>
        </tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
}

function toggleJobDetail(invoiceId) {
    const row = document.getElementById(`jp-detail-${invoiceId}`);
    if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
}

function jpRenderFooter(t) {
    const el = document.getElementById('jp-footer');
    if (!el) return;
    el.innerHTML = `
        <div class="jp-foot-cell"><span class="k">Total Our Bill</span><span class="v">${formatCurrency(t.ourBill)}</span></div>
        <div class="jp-foot-cell"><span class="k">Total Our Cost</span><span class="v">${formatCurrency(t.materialCost)}</span></div>
        <div class="jp-foot-cell"><span class="k">Total Outside Cost</span><span class="v">${formatCurrency(t.outsideCost)}</span></div>
        <div class="jp-foot-cell"><span class="k">Total Profit</span><span class="v" style="color:${jpProfitColor(t.profit)};">${formatCurrency(t.profit)}</span></div>
        <div class="jp-foot-cell"><span class="k">Overall Margin</span><span class="v">${jpFmtPct(t.margin)}</span></div>
        <div class="jp-foot-cell jp-unpaid"><span class="k">Total UNPAID Technical Charges</span><span class="v">${formatCurrency(t.unpaidTech)}</span></div>`;
}

async function toggleLabourPaid(invoiceNo, currentlyPaid) {
    try {
        const res = await authFetch(`${API_URL}/job-profit/mark-paid`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceNumbers: [invoiceNo], paid: !currentlyPaid }),
        });
        const data = await res.json();
        if (data.error) return toast(data.error, 'error');
        toast(currentlyPaid ? 'Marked unpaid' : 'Marked paid', 'success');
        generateJobProfit();
        loadUnpaidLabour();
    } catch (err) { toast(String(err), 'error'); }
}

function exportJobProfitPdf() { downloadExport(`/job-profit/pdf?${jpBuildQuery().toString()}`, 'Job_Profit_Analysis.pdf'); }
function exportJobProfitExcel() { downloadExport(`/job-profit/excel?${jpBuildQuery().toString()}`, 'Job_Profit_Analysis.xlsx'); }

// Unpaid-labour total for the dashboard card + the nav badge.
async function loadUnpaidLabour() {
    try {
        const res = await authFetch(`${API_URL}/job-profit/unpaid-summary`);
        const d = await res.json();
        if (!res.ok) return;
        const statEl = document.getElementById('stat-unpaid-labour');
        if (statEl) statEl.textContent = formatCurrency(d.totalUnpaid);
        const cntEl = document.getElementById('stat-unpaid-labour-count');
        if (cntEl) cntEl.textContent = `${d.count || 0} jobs unpaid`;
        const badge = document.getElementById('jobProfitNavBadge');
        if (badge) {
            if (d.count > 0) { badge.style.display = 'inline-block'; badge.textContent = d.count; }
            else badge.style.display = 'none';
        }
    } catch (e) { /* non-fatal */ }
}
