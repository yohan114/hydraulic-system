/* ===== ACCOUNTING: trial balance, P&L, balance sheet and the journals ===== */

let glTab = 'trial';
let glData = {};

function glRange() {
    const from = document.getElementById('gl-from').value;
    const to = document.getElementById('gl-to').value;
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p.toString();
}

function glShowTab(tab) {
    glTab = tab;
    ['trial', 'pl', 'bs', 'journals'].forEach((t) => {
        document.getElementById(`gl-pane-${t}`).style.display = t === tab ? '' : 'none';
        document.getElementById(`gl-tab-${t}`).classList.toggle('btn-primary', t === tab);
        document.getElementById(`gl-tab-${t}`).classList.toggle('btn-secondary', t !== tab);
    });
    loadLedger();
}

async function loadLedger() {
    const qs = glRange();
    try {
        if (glTab === 'trial') {
            const res = await authFetch(`${API_URL}/ledger/trial-balance?${qs}`);
            const d = await res.json();
            if (!res.ok) return toast(d.error || 'Could not load the trial balance', 'error');
            glData.trial = d;
            renderTrialBalance(d);
        } else if (glTab === 'pl') {
            const [plRes, monthlyRes] = await Promise.all([
                authFetch(`${API_URL}/ledger/pl?${qs}`),
                authFetch(`${API_URL}/ledger/pl/monthly?${qs}`),
            ]);
            renderGlPL(await plRes.json(), await monthlyRes.json());
        } else if (glTab === 'bs') {
            const to = document.getElementById('gl-to').value;
            const res = await authFetch(`${API_URL}/ledger/balance-sheet${to ? `?asAt=${to}` : ''}`);
            renderBalanceSheet(await res.json());
        } else {
            const res = await authFetch(`${API_URL}/ledger/journals?${qs}&limit=200`);
            renderJournals(await res.json());
        }
    } catch (e) { console.error('Error loading ledger', e); }
}

// A credit-balance account shows its figure in the credit column, and vice versa.
function renderTrialBalance(d) {
    const tb = document.getElementById('gl-trial-tbody');
    tb.innerHTML = '';
    if (!d.accounts.length) {
        emptyRow('gl-trial-tbody', 5, '📒', 'Nothing posted yet', 'Finalize an invoice and it will appear here.');
    } else {
        d.accounts.forEach((a) => {
            tb.innerHTML += `
                <tr>
                    <td><a href="#" onclick="glOpenAccount('${escAttr(a.code)}');return false;"><strong>${escAttr(a.code)}</strong></a></td>
                    <td>${escAttr(a.name)}</td>
                    <td><span class="badge badge-ok">${escAttr(String(a.type).replace(/_/g, ' '))}</span></td>
                    <td class="num">${a.debitBalance ? formatCurrency(a.debitBalance) : '<span class="flat">—</span>'}</td>
                    <td class="num">${a.creditBalance ? formatCurrency(a.creditBalance) : '<span class="flat">—</span>'}</td>
                </tr>`;
        });
    }
    const t = d.totals;
    document.getElementById('gl-trial-tfoot').innerHTML = `
        <tr class="analysis-total">
            <td colspan="3"><strong>TOTALS</strong> ${t.balanced
                ? '<span class="badge badge-finalized">balanced</span>'
                : '<span class="badge badge-low">OUT OF BALANCE</span>'}</td>
            <td class="num">${formatCurrency(t.debit)}</td>
            <td class="num">${formatCurrency(t.credit)}</td>
        </tr>`;
}

function glLineRows(rows) {
    return rows.map((a) => `
        <tr>
            <td><a href="#" onclick="glOpenAccount('${escAttr(a.code)}');return false;">${escAttr(a.code)}</a> ${escAttr(a.name)}</td>
            <td class="num">${formatCurrency(Math.abs(a.balance))}</td>
        </tr>`).join('');
}

// Month-by-month, derived from the journals rather than re-scanned from the
// operational tables the way the retired Profit & Loss screen did.
function glMonthlyTable(m) {
    if (!m || !m.months || !m.months.length) return '';
    const money2 = (v) => formatCurrency(v);
    const signed = (v) => `<td class="num ${v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat'}">${money2(v)}</td>`;
    return `
        <div class="analysis-sub">Month by month</div>
        <div class="table-responsive"><table class="table">
            <thead><tr>
                <th>Month</th><th class="num">Revenue</th><th class="num">Cost of sales</th><th class="num">Gross</th>
                <th class="num">Expenses</th><th class="num">Net</th><th class="num">Margin</th>
                <th class="num">Cash in</th><th class="num">Cash out</th><th class="num">Cash net</th>
            </tr></thead>
            <tbody>${m.months.map((x) => `
                <tr>
                    <td><strong>${escAttr(x.period)}</strong></td>
                    <td class="num">${money2(x.revenue)}</td>
                    <td class="num">${money2(x.cogs)}</td>
                    ${signed(x.grossProfit)}
                    <td class="num">${money2(x.expenses)}</td>
                    ${signed(x.netProfit)}
                    <td class="num">${x.marginPct == null ? '—' : x.marginPct + '%'}</td>
                    <td class="num">${money2(x.cashIn)}</td>
                    <td class="num">${money2(x.cashOut)}</td>
                    ${signed(x.cashNet)}
                </tr>`).join('')}
            </tbody>
            <tfoot><tr class="analysis-total">
                <td><strong>TOTAL</strong></td>
                <td class="num">${money2(m.totals.revenue)}</td>
                <td class="num">${money2(m.totals.cogs)}</td>
                ${signed(m.totals.grossProfit)}
                <td class="num">${money2(m.totals.expenses)}</td>
                ${signed(m.totals.netProfit)}
                <td class="num">${m.totals.marginPct == null ? '—' : m.totals.marginPct + '%'}</td>
                <td class="num">${money2(m.totals.cashIn)}</td>
                <td class="num">${money2(m.totals.cashOut)}</td>
                ${signed(m.totals.cashNet)}
            </tr></tfoot>
        </table></div>`;
}

function renderGlPL(d, monthly) {
    document.getElementById('gl-pl-body').innerHTML = `
        <div class="analysis-sub">Income</div>
        <table class="table"><tbody>${glLineRows(d.income) || '<tr><td class="flat">No income posted</td><td></td></tr>'}
            <tr class="analysis-total"><td><strong>Revenue</strong></td><td class="num">${formatCurrency(d.revenue)}</td></tr>
        </tbody></table>

        <div class="analysis-sub">Cost of sales</div>
        <table class="table"><tbody>${glLineRows(d.costOfSales) || '<tr><td class="flat">None</td><td></td></tr>'}
            <tr class="analysis-total"><td><strong>Gross profit</strong> <span class="step-hint">${d.grossMarginPct == null ? '' : d.grossMarginPct + '% margin'}</span></td>
                <td class="num ${d.grossProfit >= 0 ? 'pos' : 'neg'}">${formatCurrency(d.grossProfit)}</td></tr>
        </tbody></table>

        <div class="analysis-sub">Expenses</div>
        <table class="table"><tbody>${glLineRows(d.expenses) || '<tr><td class="flat">None</td><td></td></tr>'}
            <tr class="analysis-total"><td><strong>Total expenses</strong></td><td class="num">${formatCurrency(d.expensesTotal)}</td></tr>
        </tbody></table>

        <table class="table" style="margin-top:8px;"><tbody>
            <tr class="analysis-total" style="font-size:15px;">
                <td><strong>NET ${d.netProfit >= 0 ? 'PROFIT' : 'LOSS'}</strong></td>
                <td class="num ${d.netProfit >= 0 ? 'pos' : 'neg'}"><strong>${formatCurrency(d.netProfit)}</strong></td>
            </tr>
        </tbody></table>

        ${glMonthlyTable(monthly)}`;
}

function renderBalanceSheet(d) {
    document.getElementById('gl-bs-body').innerHTML = `
        <div class="analysis-sub">Assets</div>
        <table class="table"><tbody>${glLineRows(d.assets)}
            <tr class="analysis-total"><td><strong>Total assets</strong></td><td class="num">${formatCurrency(d.totalAssets)}</td></tr>
        </tbody></table>

        <div class="analysis-sub">Liabilities</div>
        <table class="table"><tbody>${glLineRows(d.liabilities) || '<tr><td class="flat">None</td><td></td></tr>'}
            <tr class="analysis-total"><td><strong>Total liabilities</strong></td><td class="num">${formatCurrency(d.totalLiabilities)}</td></tr>
        </tbody></table>

        <div class="analysis-sub">Equity</div>
        <table class="table"><tbody>${glLineRows(d.equity)}
            <tr><td>Profit / (loss) for the period</td><td class="num ${d.profitForPeriod >= 0 ? 'pos' : 'neg'}">${formatCurrency(d.profitForPeriod)}</td></tr>
            <tr class="analysis-total"><td><strong>Total equity</strong></td><td class="num">${formatCurrency(d.totalEquity)}</td></tr>
        </tbody></table>

        <table class="table" style="margin-top:8px;"><tbody>
            <tr class="analysis-total">
                <td><strong>Liabilities + equity</strong> ${d.balanced
                    ? '<span class="badge badge-finalized">balances</span>'
                    : `<span class="badge badge-low">off by ${formatCurrency(d.difference)}</span>`}</td>
                <td class="num"><strong>${formatCurrency(d.totalLiabilitiesAndEquity)}</strong></td>
            </tr>
        </tbody></table>`;
}

function renderJournals(rows) {
    const tb = document.getElementById('gl-journals-tbody');
    tb.innerHTML = '';
    if (!rows.length) { emptyRow('gl-journals-tbody', 6, '📗', 'No journals in this range', ''); return; }
    rows.forEach((j) => {
        tb.innerHTML += `
            <tr${j.ReversalOf ? ' style="opacity:.65;"' : ''}>
                <td><a href="#" onclick="glOpenJournal(${j.JournalID});return false;"><strong>${escAttr(j.EntryNo)}</strong></a></td>
                <td>${formatDate(j.EntryDate)}</td>
                <td>${escAttr(j.Memo) || ''}${j.ReversalOf ? ' <span class="badge badge-cancelled">reversal</span>' : ''}</td>
                <td>${escAttr(j.SourceType) || '<span class="flat">—</span>'}</td>
                <td class="num">${j.Lines}</td>
                <td class="num">${formatCurrency(j.Amount)}</td>
            </tr>`;
    });
}

async function glOpenAccount(code) {
    try {
        const res = await authFetch(`${API_URL}/ledger/account/${encodeURIComponent(code)}?${glRange()}`);
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not load the account', 'error');
        document.getElementById('glDetailTitle').textContent = `${d.account.code} — ${d.account.name}`;
        document.getElementById('glDetailBody').innerHTML = `
            <div class="table-responsive"><table class="table">
                <thead><tr><th>Entry</th><th>Date</th><th>Memo</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
                <tbody>${d.lines.map((l) => `
                    <tr>
                        <td>${escAttr(l.entryNo)}</td>
                        <td>${formatDate(l.date)}</td>
                        <td>${escAttr(l.memo) || ''}</td>
                        <td class="num">${l.debit ? formatCurrency(l.debit) : ''}</td>
                        <td class="num">${l.credit ? formatCurrency(l.credit) : ''}</td>
                        <td class="num">${formatCurrency(l.balance)}</td>
                    </tr>`).join('')}
                </tbody>
                <tfoot><tr class="analysis-total"><td colspan="5"><strong>Closing balance</strong></td>
                    <td class="num"><strong>${formatCurrency(d.closing)}</strong></td></tr></tfoot>
            </table></div>`;
        openModal('glDetailModal');
    } catch (e) { toast(String(e), 'error'); }
}

async function glOpenJournal(id) {
    try {
        const res = await authFetch(`${API_URL}/ledger/journals/${id}`);
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not load the journal', 'error');
        document.getElementById('glDetailTitle').textContent = `${d.EntryNo} — ${d.Memo || ''}`;
        document.getElementById('glDetailBody').innerHTML = `
            <p class="analysis-note">Posted ${formatDate(d.EntryDate)} · period ${escAttr(d.Period)}${d.PostedBy ? ' · by ' + escAttr(d.PostedBy) : ''}${d.SourceType ? ' · from ' + escAttr(d.SourceType) : ''}</p>
            <table class="table">
                <thead><tr><th>Account</th><th>Memo</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
                <tbody>${d.lines.map((l) => `
                    <tr>
                        <td>${escAttr(l.Code)} ${escAttr(l.Name)}</td>
                        <td>${escAttr(l.Memo) || escAttr(l.CustomerName) || ''}</td>
                        <td class="num">${l.Debit ? formatCurrency(l.Debit) : ''}</td>
                        <td class="num">${l.Credit ? formatCurrency(l.Credit) : ''}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
            ${d.ReversalOf ? '<p class="analysis-note">This entry reverses an earlier journal.</p>' : `
              <div class="modal-actions"><button class="btn btn-secondary admin-only" onclick="glReverse(${d.JournalID})">Reverse this journal</button></div>`}`;
        openModal('glDetailModal');
    } catch (e) { toast(String(e), 'error'); }
}

async function glReverse(id) {
    if (!confirm('Post a reversing entry for this journal? The original stays on the books.')) return;
    try {
        const res = await authFetch(`${API_URL}/ledger/journals/${id}/reverse`, { method: 'POST' });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not reverse', 'error');
        toast(`Reversed as ${d.entryNo}`, 'success');
        closeModal('glDetailModal');
        loadLedger();
    } catch (e) { toast(String(e), 'error'); }
}
