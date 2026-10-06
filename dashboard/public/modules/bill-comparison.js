/* ===== BILL COMPARISON: Cost vs Our Bill vs Market Bill — split module (shared global scope) ===== */

// Filter state for the screen.
const bcState = { from: '', to: '', flag: 'all', search: '', threshold: 15 };

const BC_FLAG_META = {
    'below-cost': { label: 'Below Cost', color: '#ef4444' },
    'low-margin': { label: 'Low Margin', color: '#f59e0b' },
    'over-market': { label: 'Over Market', color: '#f97316' },
    ok: { label: 'OK', color: '#10b981' },
};

// Richer status (vs cost + the 80% market floor). Kept for internal reference.
const BC_STATUS_META = {
    'below-cost': { label: 'Below Cost', color: '#ef4444' },
    'at-cost-floor': { label: 'At Cost Floor', color: '#f59e0b' },
    'below-market-floor': { label: 'Below 80% Market', color: '#f97316' },
    healthy: { label: 'Healthy Margin', color: '#10b981' },
    'at-above-market': { label: 'At/Above Market', color: '#6366f1' },
    'no-market': { label: 'No Market Ref', color: '#94a3b8' },
};

// Which pricing rule set the default bill — shown in the "Rule Applied" column.
const BC_RULE_META = {
    marketMinus20: { label: 'Market −20%', color: '#10b981' },
    costFloor: { label: 'Cost Floor', color: '#f59e0b' },
    ferruleFloor: { label: 'Ferrule Floor', color: '#8b5cf6' },
    manual: { label: 'Manual', color: '#94a3b8' },
};

function bcFlagBadge(flag) {
    const m = BC_FLAG_META[flag] || BC_FLAG_META.ok;
    return `<span class="badge" style="background:${m.color}1a;color:${m.color};font-weight:600;">${m.label}</span>`;
}

function bcRuleBadge(rule, label) {
    const m = BC_RULE_META[rule] || { label: label || rule || '—', color: '#94a3b8' };
    return `<span class="badge" style="background:${m.color}1a;color:${m.color};font-weight:600;">${escAttr(m.label)}</span>`;
}
function bcColor(v) { return Number(v) >= 0 ? '#10b981' : '#ef4444'; }

async function loadBillComparison() {
    showSkeleton('bill-comparison-tbody', 12, 12);
    const params = new URLSearchParams({ flag: bcState.flag, lowMargin: String(bcState.threshold) });
    if (bcState.from) params.set('from', bcState.from);
    if (bcState.to) params.set('to', bcState.to);
    if (bcState.search) params.set('search', bcState.search);
    try {
        const res = await authFetch(`${API_URL}/reports/bill-comparison?${params.toString()}`);
        const data = await res.json();
        if (!res.ok) { toast(data.error || 'Could not load bill comparison', 'error'); return; }
        renderBillComparison(data);
    } catch (e) { console.error('Error loading bill comparison', e); }
}

function renderBillComparison(data) {
    const k = data.kpis || {};
    document.getElementById('bc-stat-ourbill').textContent = formatCurrency(k.ourBill);
    document.getElementById('bc-stat-cost').textContent = formatCurrency(k.cost);
    const profitEl = document.getElementById('bc-stat-profit');
    profitEl.innerHTML = `<span style="color:${bcColor(k.profit)}">${formatCurrency(k.profit)}</span>`;
    document.getElementById('bc-stat-margin').textContent = `${k.marginPercent == null ? 0 : k.marginPercent}% overall margin`;
    // Market gap: negative = we're under market (good for the customer).
    const gap = Number(k.marketGap) || 0;
    const gapEl = document.getElementById('bc-stat-marketgap');
    gapEl.innerHTML = `<span style="color:${gap <= 0 ? '#10b981' : '#f97316'}">${formatCurrency(Math.abs(gap))}</span>`;
    document.getElementById('bc-stat-marketgap-sub').textContent = gap <= 0 ? 'below market (we undercut)' : 'above market (we are pricier)';

    renderBillWarnings(k);
    renderBillCharts(data.charts || {});

    const tb = document.getElementById('bill-comparison-tbody');
    tb.innerHTML = '';
    const rows = data.rows || [];
    if (!rows.length) { emptyRow('bill-comparison-tbody', 12, '📊', 'No billed lines match', 'Adjust the filters, or finalize invoices to populate this report.'); return; }
    rows.forEach((r) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${escAttr(r.invoiceNo)}</strong><br><span style="font-size:11px;color:var(--text-muted)">${formatDate(r.invoiceDate)}</span></td>
                <td>${escAttr(r.customer) || 'Walk-in'}</td>
                <td>${escAttr(r.description)}</td>
                <td class="num">${r.qty}${r.unit ? ' ' + escAttr(r.unit) : ''}</td>
                <td class="num">${formatCurrency(r.unitCost)}</td>
                <td class="num">${formatCurrency(r.ourBillRate)}</td>
                <td class="num" style="color:#047857;">${r.suggestedBillRate ? formatCurrency(r.suggestedBillRate) : '<span style="color:var(--text-muted)">—</span>'}</td>
                <td class="num">${r.marketBillRate ? formatCurrency(r.marketBillRate) : '<span style="color:var(--text-muted)">—</span>'}</td>
                <td class="num" style="color:${bcColor(r.profit)};font-weight:600;">${formatCurrency(r.profit)}</td>
                <td class="num" style="color:${bcColor(r.marginPercent)};font-weight:600;">${r.marginPercent}%</td>
                <td class="num" style="color:${r.marketGap <= 0 ? '#10b981' : '#f97316'};">${formatCurrency(r.marketGap)}</td>
                <td>${bcRuleBadge(r.pricingRuleApplied, r.ruleLabel)}</td>
            </tr>`;
    });
}

function renderBillWarnings(k) {
    const host = document.getElementById('bc-warnings');
    if (!host) return;
    const chips = [];
    if (k.belowCost) chips.push(`<span class="bc-warn" style="background:#fef2f2;color:#b91c1c;">⚠ ${k.belowCost} line(s) billed BELOW COST</span>`);
    if (k.lowMargin) chips.push(`<span class="bc-warn" style="background:#fffbeb;color:#b45309;">⚠ ${k.lowMargin} line(s) LOW MARGIN</span>`);
    if (k.overMarket) chips.push(`<span class="bc-warn" style="background:#fff7ed;color:#c2410c;">⚠ ${k.overMarket} line(s) OVER MARKET</span>`);
    host.innerHTML = chips.length
        ? `<div class="bc-warn-row">${chips.join('')}</div>`
        : '<div class="bc-warn-row"><span class="bc-warn" style="background:#ecfdf5;color:#047857;">✓ All billed lines are at or above cost and competitive</span></div>';
}

function renderBillCharts(charts) {
    // Monthly grouped bars: Our Bill vs Market Bill vs Cost.
    const host = document.getElementById('bc-chart-months');
    const months = charts.months || [];
    if (host) {
        if (!months.length) { host.innerHTML = '<div style="color:var(--text-muted);padding:16px 0;">No monthly data.</div>'; }
        else {
            const max = Math.max(1, ...months.map((m) => Math.max(m.ourBill, m.marketBill, m.cost)));
            const barW = 22, innerGap = 5, groupGap = 40, chartH = 170, topPad = 12, labelH = 26;
            const groupW = barW * 3 + innerGap * 2;
            const width = Math.max(320, months.length * (groupW + groupGap) + groupGap);
            const y = (v) => topPad + chartH - (v / max) * chartH;
            const series = [
                { key: 'cost', color: '#f59e0b', label: 'Cost' },
                { key: 'ourBill', color: '#2563eb', label: 'Our Bill' },
                { key: 'marketBill', color: '#8b5cf6', label: 'Market Bill' },
            ];
            let bars = '';
            months.forEach((m, i) => {
                const gx = groupGap + i * (groupW + groupGap);
                series.forEach((s, j) => {
                    const x = gx + j * (barW + innerGap), yy = y(m[s.key]);
                    bars += `<rect x="${x}" y="${yy}" width="${barW}" height="${topPad + chartH - yy}" rx="3" fill="${s.color}"><title>${s.label}: ${formatCurrency(m[s.key])}</title></rect>`;
                });
                bars += `<text x="${gx + groupW / 2}" y="${topPad + chartH + 16}" text-anchor="middle" font-size="12" fill="var(--text-color,#333)">${m.month}</text>`;
            });
            const legend = series.map((s) => `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:14px;font-size:12px;"><span style="width:11px;height:11px;border-radius:3px;background:${s.color};display:inline-block;"></span>${s.label}</span>`).join('');
            host.innerHTML = `<div style="margin-bottom:8px;">${legend}</div><svg width="${width}" height="${chartH + topPad + labelH}" role="img" aria-label="Monthly cost vs our bill vs market bill">${bars}</svg>`;
        }
    }

    // Flag distribution: one horizontal bar per flag.
    const fhost = document.getElementById('bc-chart-flags');
    if (fhost) {
        const fc = charts.flagCounts || {};
        const order = ['below-cost', 'low-margin', 'over-market', 'ok'];
        const total = order.reduce((a, f) => a + (fc[f] || 0), 0) || 1;
        fhost.innerHTML = order.map((f) => {
            const meta = BC_FLAG_META[f];
            const n = fc[f] || 0;
            const pct = Math.round((n / total) * 100);
            return `<div style="margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span>${meta.label}</span><span style="color:var(--text-muted)">${n} · ${pct}%</span></div>
                <div style="background:var(--border-color,#e5e7eb);border-radius:6px;height:12px;overflow:hidden;"><div style="width:${pct}%;height:100%;background:${meta.color};"></div></div>
            </div>`;
        }).join('');
    }
}

// --- filter handlers ---
function bcApplyFilters() {
    bcState.from = document.getElementById('bc-from').value;
    bcState.to = document.getElementById('bc-to').value;
    bcState.flag = document.getElementById('bc-flag').value;
    const t = Number(document.getElementById('bc-threshold').value);
    bcState.threshold = isFinite(t) && t >= 0 ? t : 15;
    loadBillComparison();
}
const bcSearchDebounced = debounce(() => { bcState.search = document.getElementById('bc-search').value.trim(); loadBillComparison(); }, 300);

function exportBillComparison(format) {
    const params = new URLSearchParams({ flag: bcState.flag, lowMargin: String(bcState.threshold), format });
    if (bcState.from) params.set('from', bcState.from);
    if (bcState.to) params.set('to', bcState.to);
    if (bcState.search) params.set('search', bcState.search);
    downloadExport(`/reports/bill-comparison/export?${params.toString()}`, `Bill_Comparison.${format === 'csv' ? 'csv' : 'xlsx'}`);
}
