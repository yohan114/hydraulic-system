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
    showSkeleton('job-profit-tbody', 14, 5);
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

// ---- The three comparisons: shared rendering helpers ----

// A percentage the server could not compute (no base to divide by) prints "—".
function jpPct(v) { return v == null ? '—' : `${v}%`; }
// `part` as a share of `whole`, to one decimal.
function jpShare(part, whole) { return Number(whole) > 0 ? `${Math.round((Number(part) / Number(whole)) * 1000) / 10}%` : '—'; }
function jpSetText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function jpSetMoney(id, v) { jpSetText(id, formatCurrency(v)); }

// Money whose sign carries meaning: green when it went our way, red when it did not.
function jpSetSigned(id, v) {
    const el = document.getElementById(id);
    if (!el) return;
    const n = Number(v) || 0;
    el.textContent = formatCurrency(n);
    el.classList.remove('pos', 'neg', 'flat');
    el.classList.add(n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat');
}

// One inline cell of signed money, for rows built as HTML strings.
function jpSignedCell(v) {
    const n = Number(v) || 0;
    return `<td class="num ${n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat'}" style="font-weight:600;">${formatCurrency(n)}</td>`;
}

// Where the outside-cost column came from, so an estimate never reads as a fact.
function jpOutsideCostNote(basis) {
    const b = basis || {};
    const parts = [];
    if (b.item) parts.push(`${b.item} from the item's own trade price`);
    if (b.ratecard) parts.push(`${b.ratecard} from the Rate Card's outside Low band`);
    if (b.derived) parts.push(`${b.derived} estimated from the market retail price`);
    if (!parts.length) return 'No outside cost benchmark is available — set Market Low on the stock items, or price the matching Rate Card rows.';
    let note = `Outside cost basis: ${parts.join(', ')}.`;
    if (b.none) note += ` ${b.none} line(s) have no outside benchmark and count as zero.`;
    return note;
}

function renderJobProfit(data) {
    const t = data.totals || {};
    const a = t.analysis || {};
    const s = a.sourcing || {};
    const pl = s.pl || {};
    const p = a.pricing || {};
    const m = a.margin || {};
    const br = a.bridge || {};

    // ---- KPI row: one per step, plus the reconciliation ----
    jpSetSigned('jp-kpi-sourcing', s.gain);
    jpSetText('jp-kpi-sourcing-sub',
        `${jpPct(s.gainPct == null ? null : Math.abs(s.gainPct))} ${(s.gain || 0) >= 0 ? 'below' : 'above'} outside cost · ${formatCurrency(s.outsideCost)}`);

    jpSetSigned('jp-kpi-saving', p.customerSaving);
    jpSetText('jp-kpi-saving-sub',
        `${jpPct(p.customerSavingPct == null ? null : Math.abs(p.customerSavingPct))} ${(p.customerSaving || 0) >= 0 ? 'below' : 'above'} market · ${formatCurrency(p.outsidePrice)}`);

    jpSetSigned('jp-kpi-profit', m.grossProfit);
    jpSetText('jp-kpi-margin', `${jpPct(m.grossMarginPct)} margin · cost ${formatCurrency(m.ourCost)}`);

    jpSetSigned('jp-kpi-advantage', br.advantage);
    jpSetText('jp-kpi-advantage-sub', `outside shop would earn ${formatCurrency(br.outsideProfit)}`);

    document.getElementById('jp-kpi-unpaid').innerHTML = `<span style="color:#dc2626;font-weight:700;">${formatCurrency(t.unpaidTech)}</span>`;
    jpSetText('jp-kpi-unpaid-count', `${t.unpaidCount || 0} jobs unpaid`);

    // ---- (1) Our cost vs outside cost, with the P&L compare ----
    jpSetMoney('jp1-outside-cost', s.outsideCost);
    jpSetMoney('jp1-our-cost', s.ourCost);
    jpSetText('jp1-our-cost-pct', jpShare(s.ourCost, s.outsideCost));
    jpSetText('jp1-gain-label', (s.gain || 0) < 0 ? 'Sourcing loss' : 'Sourcing gain');
    jpSetSigned('jp1-gain', s.gain);
    jpSetText('jp1-gain-pct', jpPct(s.gainPct));

    jpSetMoney('jp1-pl-rev-out', pl.revenue);
    jpSetMoney('jp1-pl-rev-our', pl.revenue);
    jpSetMoney('jp1-pl-cost-out', pl.outsideCost);
    jpSetMoney('jp1-pl-cost-our', pl.ourCost);
    jpSetSigned('jp1-pl-cost-diff', (Number(pl.outsideCost) || 0) - (Number(pl.ourCost) || 0));
    jpSetSigned('jp1-pl-gp-out', pl.outsideProfit);
    jpSetSigned('jp1-pl-gp-our', pl.ourProfit);
    jpSetSigned('jp1-pl-gp-diff', pl.profitDelta);
    jpSetText('jp1-pl-m-out', jpPct(pl.outsideMarginPct));
    jpSetText('jp1-pl-m-our', jpPct(pl.ourMarginPct));
    jpSetText('jp1-note', jpOutsideCostNote(t.outsideCostBasis));

    // ---- (2) Our price vs outside price ----
    jpSetMoney('jp2-outside-price', p.outsidePrice);
    jpSetMoney('jp2-our-price', p.ourPrice);
    jpSetText('jp2-our-price-pct', jpShare(p.ourPrice, p.outsidePrice));
    jpSetText('jp2-saving-label', (p.customerSaving || 0) < 0 ? 'Customer pays more' : 'Customer saves');
    jpSetSigned('jp2-saving', p.customerSaving);
    jpSetText('jp2-saving-pct', jpPct(p.customerSavingPct));
    const unpriced = (data.invoices || []).reduce((n, inv) => n + inv.lines.filter((l) => !l.priceMatched).length, 0);
    jpSetText('jp2-note', unpriced
        ? `${unpriced} line(s) have no market price benchmark and count as zero — the real market total is higher than shown.`
        : 'Every line in this period has a market price benchmark.');

    // ---- (3) Our cost vs our price ----
    jpSetMoney('jp3-our-price', m.ourPrice);
    jpSetMoney('jp3-our-cost', m.ourCost);
    jpSetText('jp3-our-cost-pct', jpShare(m.ourCost, m.ourPrice));
    jpSetText('jp3-gp-label', (m.grossProfit || 0) < 0 ? 'Gross loss' : 'Gross profit');
    jpSetSigned('jp3-gp', m.grossProfit);
    jpSetText('jp3-gp-pct', jpPct(m.grossMarginPct));
    jpSetText('jp3-markup', jpPct(m.markupPct));

    jpSetSigned('jpb-our-profit', br.ourProfit);
    jpSetSigned('jpb-outside-profit', br.outsideProfit);
    jpSetSigned('jpb-advantage', br.advantage);

    // Tax is collected for the state, not shop income — say so when older
    // invoices still carry it, otherwise "our price" looks short of "our bill".
    jpSetText('jp3-note', t.taxCollected
        ? `All three comparisons exclude SSCL/VAT. These jobs were invoiced ${formatCurrency(t.ourBill)} in total, of which ${formatCurrency(t.taxCollected)} is tax collected for the state.`
        : `All three comparisons are ex-tax. Total invoiced: ${formatCurrency(t.ourBill)}.`);

    // ---- Per job: the three comparisons side by side ----
    const tb = document.getElementById('job-profit-tbody');
    tb.innerHTML = '';
    const rows = data.invoices || [];
    if (!rows.length) { emptyRow('job-profit-tbody', 14, '📊', 'No jobs match', 'Adjust the filters and Generate again.'); jpRenderFooter(t); return; }

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
                <td class="num">${formatCurrency(inv.ourCost)}</td>
                <td class="num">${formatCurrency(inv.outsideCost)}</td>
                ${jpSignedCell(inv.sourcingGain)}
                <td class="num">${formatCurrency(inv.ourPrice)}</td>
                <td class="num">${formatCurrency(inv.outsidePrice)}</td>
                ${jpSignedCell(inv.customerSaving)}
                ${jpSignedCell(inv.profit)}
                <td class="num" style="color:${jpMarginColor(inv.margin)};font-weight:600;">${jpFmtPct(inv.margin)}</td>
                <td class="num">${formatCurrency(inv.techCharges)}</td>
                <td>${labour}</td>
                <td><button class="btn btn-text" onclick="toggleJobDetail(${inv.invoiceId})">View Details</button></td>
            </tr>
            <tr class="jp-detail-row" id="jp-detail-${inv.invoiceId}" style="display:none;">
                <td colspan="14" style="background:#fafafa;padding:0;">${jpDetailTable(inv)}</td>
            </tr>`;
    });

    jpRenderFooter(t);
}

function jpDetailTable(inv) {
    const dash = '<td class="num flat">—</td>';
    const rows = inv.lines.map((l, i) => {
        const tint = l.isTech ? 'background:#fff7ed;' : '';
        const est = l.outsideCostBasis === 'derived'
            ? '<span class="basis-tag" title="Estimated from the market retail price">est</span>' : '';
        return `<tr style="${tint}">
            <td class="num">${i + 1}</td>
            <td>${escAttr(l.description)}${l.isTech ? ' <span style="color:#c2410c;font-weight:700;" title="Technical / crimping labour">◆</span>' : ''}</td>
            <td>${escAttr(l.unit)}</td>
            <td class="num">${l.qty}</td>
            <td class="num">${formatCurrency(l.ourCost)}</td>
            <td class="num">${l.costMatched ? formatCurrency(l.outsideCost) + est : '<span class="flat">—</span>'}</td>
            ${l.costMatched ? jpSignedCell(l.sourcingGain) : dash}
            <td class="num">${formatCurrency(l.ourAmount)}</td>
            <td class="num">${l.priceMatched ? formatCurrency(l.outsideAmount) : '<span class="flat">—</span>'}</td>
            ${l.priceMatched ? jpSignedCell(l.customerSaving) : dash}
            ${jpSignedCell(l.grossProfit)}
        </tr>`;
    }).join('');
    return `<table class="table" style="margin:0;font-size:12px;">
        <thead><tr>
            <th class="num">#</th><th>Description</th><th>Unit</th><th class="num">Qty</th>
            <th class="num">Our Cost</th><th class="num">Outside Cost</th><th class="num">1 · Gain</th>
            <th class="num">Our Price</th><th class="num">Outside Price</th><th class="num">2 · Saving</th>
            <th class="num">3 · Profit</th>
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
        <div class="jp-foot-cell"><span class="k">Our Cost</span><span class="v">${formatCurrency(t.ourCost)}</span></div>
        <div class="jp-foot-cell"><span class="k">Outside Cost</span><span class="v">${formatCurrency(t.outsideCost)}</span></div>
        <div class="jp-foot-cell"><span class="k">1 · Sourcing Gain</span><span class="v" style="color:${jpProfitColor(t.sourcingGain)};">${formatCurrency(t.sourcingGain)}</span></div>
        <div class="jp-foot-cell"><span class="k">Our Price</span><span class="v">${formatCurrency(t.ourPrice)}</span></div>
        <div class="jp-foot-cell"><span class="k">Outside Price</span><span class="v">${formatCurrency(t.outsidePrice)}</span></div>
        <div class="jp-foot-cell"><span class="k">2 · Customer Saving</span><span class="v" style="color:${jpProfitColor(t.customerSaving)};">${formatCurrency(t.customerSaving)}</span></div>
        <div class="jp-foot-cell"><span class="k">3 · Gross Profit</span><span class="v" style="color:${jpProfitColor(t.grossProfit)};">${formatCurrency(t.grossProfit)}</span></div>
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
