/* ===== INVOICE: create, finalize, history, payments, print — split from app.js; loaded as an ordered classic script (shared global scope) ===== */
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
    currentLoadedInvoice = null;
    billType = 'inside'; // every new invoice starts as the full internal copy
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

// Modal select inventory — the query hits the server /inventory/search endpoint,
// so it is debounced to fire one request after the user stops typing rather than
// one per keystroke (the picker never loads the full inventory into a dropdown).
const debouncedModalSearch = debounce(() => searchModalInventory(), 250);

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
    // Fixed labour/service fee; guarded so a second click never duplicates it.
    // (Crimping is size-based — added via the "+ Add Crimping" picker instead.)
    if (!invoiceItems.find((it) => it.desc === 'Technical charges')) {
        invoiceItems.push({ id: nextItemId++, inventoryId: null, desc: 'Technical charges', unit: 'Nos', length: 0, qty: 1, rate: 1500, cost: 0, maxQty: null });
    }
    renderInvoiceItems();
}

// ----------------------------------------------------
// Crimping charge — priced from the Rate Card by hose size × number of ends.
// ----------------------------------------------------
let crimpingRates = [];

async function loadCrimpingRates() {
    if (crimpingRates.length) return crimpingRates;
    try {
        const res = await authFetch(`${API_URL}/ratecard/crimping`);
        const data = await res.json();
        if (Array.isArray(data)) crimpingRates = data;
    } catch (e) { console.error('Error loading crimping rates', e); }
    return crimpingRates;
}

async function openCrimpingModal() {
    await loadCrimpingRates();
    const sel = document.getElementById('crimp-size');
    if (!crimpingRates.length) {
        toast('No crimping rates found in the Rate Card. Add them under Rate Card first.', 'error');
        return;
    }
    // The Rate Card price is the full crimping charge for the hose (both ends),
    // so it is shown as a flat rate — NOT multiplied per end.
    sel.innerHTML = crimpingRates.map((r) => {
        const size = String(r.label).replace(/\s*\(per end\)\s*/i, '').replace(/^Crimp\s*/i, '');
        return `<option value="${r.rateId}">${escAttr(size)} — ${formatCurrency(r.ourPrice)}</option>`;
    }).join('');
    document.getElementById('crimp-qty').value = 1;
    updateCrimpingPreview();
    openModal('crimpingModal');
}

function selectedCrimp() {
    const id = Number(document.getElementById('crimp-size').value);
    return crimpingRates.find((r) => r.rateId === id) || null;
}

function crimpQty() {
    return Math.max(1, parseInt(document.getElementById('crimp-qty').value, 10) || 1);
}

function updateCrimpingPreview() {
    const r = selectedCrimp();
    const qty = crimpQty();
    const el = document.getElementById('crimp-preview');
    if (!r) { el.textContent = ''; return; }
    const total = round2(r.ourPrice * qty);
    el.innerHTML = qty === 1
        ? `<strong>${formatCurrency(total)}</strong> (covers both ends)`
        : `${formatCurrency(r.ourPrice)} &times; ${qty} hoses = <strong>${formatCurrency(total)}</strong>`;
}

function addCrimpingLine(e) {
    if (e) e.preventDefault();
    const r = selectedCrimp();
    if (!r) return;
    const qty = crimpQty();
    // Strip the "(per end)" suffix from the rate-card label for a clean line description.
    const size = String(r.label).replace(/\s*\(per end\)\s*/i, '').replace(/^Crimp\s*/i, '');
    invoiceItems.push({
        id: nextItemId++,
        inventoryId: null,
        desc: `Crimping charge — ${size}`,
        unit: 'Nos',           // charged per hose (both ends), not per end
        length: 0,
        qty,
        rate: r.ourPrice,      // full both-ends rate from the Rate Card
        cost: r.ourCost || 0,  // drives the margin hint
        maxQty: null,
    });
    closeModal('crimpingModal');
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

// Simplified, customer-facing description for the OUTSIDE bill. Display-only —
// it NEVER mutates item.desc, so the full description (with part numbers / spec
// codes) is always what gets saved to the database.
function getOutsideDesc(item) {
    const d = String(item.desc || '');
    const dl = d.toLowerCase();
    const unit = String(item.unit || '').toLowerCase();
    if (dl.includes('crimping')) return d;                       // already customer-friendly
    if (dl.includes('technical charge')) return 'Service charge';
    if (unit === 'm' || unit === 'ft') return 'Hydraulic hose supply & fitting';
    if (dl.includes('bsp straight') || d.includes('22611')) return 'Union fitting (BSP Straight)';
    if (dl.includes('bsp 90') || d.includes('22692') || dl.includes('elbow')) return 'Elbow fitting (BSP 90°)';
    if (dl.includes('ferrule') || d.includes('00210') || dl.includes('2sn')) return 'Ferrule fitting';
    if (dl.includes('flange')) return 'Flange fitting';
    if (dl.includes('union')) return 'Union fitting';
    const i = d.indexOf(' - ');
    return (i >= 0 ? d.slice(0, i) : d).trim();
}

function setBillType(type) {
    billType = type === 'outside' ? 'outside' : 'inside';
    renderInvoiceItems();
}

// Reflect billType in the toolbar toggle, the items-table column visibility, and
// the printed copy badge. Display-only; nothing here is persisted.
function applyBillTypeUI() {
    const outside = billType === 'outside';
    const insideBtn = document.getElementById('billTypeInside');
    const outsideBtn = document.getElementById('billTypeOutside');
    if (insideBtn) insideBtn.classList.toggle('active', !outside);
    if (outsideBtn) outsideBtn.classList.toggle('active', outside);
    const table = document.getElementById('itemsTable');
    if (table) table.classList.toggle('outside-bill', outside);
    const badge = document.getElementById('copyBadge');
    if (badge) {
        badge.textContent = outside ? 'OUTSIDE BILL — Customer Copy' : 'INTERNAL BILL — Company Copy';
        badge.classList.toggle('outside', outside);
    }
}

function renderInvoiceItems() {
    const tbody = document.getElementById('invItemsBody');
    tbody.innerHTML = '';
    const editable = isInvoiceEditable;
    const outside = billType === 'outside';

    invoiceItems.forEach((it, idx) => {
        const amount = round2((it.qty || 0) * (it.rate || 0));
        // Outside bill: simplified description as STATIC text (never editable, so
        // it.desc — the full internal description — is preserved and saved).
        const descCell = outside
            ? `<td><span class="cell left">${escAttr(getOutsideDesc(it))}</span></td>`
            : `<td><input class="cell left" type="text" value="${escAttr(it.desc)}" oninput="updateInvoiceItem(${it.id}, 'desc', this.value)" ${editable ? '' : 'disabled'}></td>`;
        tbody.innerHTML += `
            <tr class="item-row">
                <td class="idx">${String(idx + 1).padStart(2, '0')}</td>
                ${descCell}
                <td class="col-unit"><input class="cell center" type="text" value="${escAttr(it.unit)}" oninput="updateInvoiceItem(${it.id}, 'unit', this.value)" ${editable ? '' : 'disabled'}></td>
                <td class="col-length"><input class="cell" type="number" value="${it.length}" min="0" step="0.01" oninput="updateInvoiceItem(${it.id}, 'length', this.value)" ${editable ? '' : 'disabled'}></td>
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

    applyBillTypeUI();
    calcInvoiceTotals();
}

// Remove any historical SSCL/VAT rows previously injected for a legacy invoice.
function clearHistoricalTaxRows() {
    document.querySelectorAll('tr[data-historical-tax]').forEach((r) => r.remove());
}

// Inject the stored SSCL/VAT rows (right after Sub Total) for a legacy tax
// invoice, so its printed totals still reconcile. New invoices carry no tax, so
// nothing is injected for them.
function renderHistoricalTaxRows(inv) {
    clearHistoricalTaxRows();
    const subRow = document.getElementById('invSubTotal').closest('tr');
    if (!subRow) return;
    const sscl = round2(Number(inv.SSCLAmount) || 0);
    const vat = round2(Number(inv.VATAmount) || 0);
    const mk = (label, rate, amount) => {
        const tr = document.createElement('tr');
        tr.setAttribute('data-historical-tax', '1');
        tr.innerHTML = `<td>${label} ${rate}%</td><td>${formatCurrency(amount)}</td>`;
        return tr;
    };
    let after = subRow;
    if (vat > 0) { const r = mk('VAT', Number(inv.VATRate) || 0, vat); after.after(r); }
    if (sscl > 0) { const r = mk('SSCL', Number(inv.SSCLRate) || 0, sscl); subRow.after(r); }
}

// Display a locked/saved invoice's totals EXACTLY as stored (immutable). Legacy
// invoices keep their SSCL/VAT; invoices billed after tax removal simply have
// zero tax and show none.
function renderStoredTotals(inv) {
    const subTotal = round2(Number(inv.SubTotal) || 0);
    const discount = round2(Number(inv.Discount) || 0);
    const roundOff = round2(Number(inv.RoundOff) || 0);
    const grand = round2(Number(inv.GrandTotal) || 0);

    document.getElementById('invSubTotal').textContent = formatCurrency(subTotal);
    renderHistoricalTaxRows(inv);
    document.getElementById('invDiscountVal').textContent = (discount > 0 ? '- ' : '') + formatCurrency(discount);
    const roRow = document.getElementById('invRoundOffRow');
    if (Math.abs(roundOff) > 0) { roRow.style.display = ''; document.getElementById('invRoundOff').textContent = formatCurrency(roundOff); }
    else { roRow.style.display = 'none'; }
    document.getElementById('invGrandTotal').textContent = formatCurrency(grand);
    return { subTotal, discount, roundOff, grand };
}

// Totals for the invoice form. Invoices are NO LONGER TAXED:
//   Grand Total = Sub Total − Discount (± Round Off)
// A locked invoice being viewed instead shows its stored totals verbatim (so the
// 11 legacy tax invoices reprint correctly).
function calcInvoiceTotals() {
    // Pass: sum line amounts (and refresh row amounts + margin hints).
    let subTotal = 0;
    const rows = document.querySelectorAll('#invItemsBody .item-row');
    invoiceItems.forEach((it, idx) => {
        const amt = round2((it.qty || 0) * (it.rate || 0));
        subTotal += amt;
        const row = rows[idx];
        if (!row) return;
        const rowAmtTd = row.querySelector('.row-amount');
        if (rowAmtTd) rowAmtTd.textContent = amt.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const hint = row.querySelector('.margin-hint');
        if (hint && isInvoiceEditable) {
            const tmp = document.createElement('div');
            tmp.innerHTML = marginHintHtml(it);
            const fresh = tmp.firstElementChild;
            if (fresh) { hint.className = fresh.className; hint.textContent = fresh.textContent; }
        }
    });
    subTotal = round2(subTotal);

    // Viewing a saved (locked) invoice -> show exactly what was stored.
    if (!isInvoiceEditable && currentLoadedInvoice) {
        return renderStoredTotals(currentLoadedInvoice);
    }

    // Editable / new invoice -> tax-free.
    clearHistoricalTaxRows();
    const discountInput = parseFloat(document.getElementById('invDiscount').value) || 0;
    const roundToRupee = document.getElementById('invRoundToRupee').checked;
    const discount = round2(Math.min(Math.max(discountInput, 0), subTotal));
    let grand = round2(subTotal - discount);
    let roundOff = 0;
    if (roundToRupee) {
        const g = Math.round(grand);
        roundOff = round2(g - grand);
        grand = g;
    }

    document.getElementById('invSubTotal').textContent = formatCurrency(subTotal);
    document.getElementById('invDiscountVal').textContent = (discount > 0 ? '- ' : '') + formatCurrency(discount);
    const roRow = document.getElementById('invRoundOffRow');
    if (roundToRupee) { roRow.style.display = ''; document.getElementById('invRoundOff').textContent = formatCurrency(roundOff); }
    else { roRow.style.display = 'none'; }
    document.getElementById('invGrandTotal').textContent = formatCurrency(grand);

    return { subTotal, discount, roundOff, roundToRupee, grand };
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
        // No tax: SSCL/VAT are no longer billed. The server forces both rates to 0.
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

// Server-side paginated history so thousands of invoices stay fast.
let historyPage = 1;
const HISTORY_PAGE_SIZE = 25;
let historySearch = '';
let historyStatus = 'All';
let historyTotalPages = 1;

async function loadHistory(opts = {}) {
    if (!opts.background) showSkeleton('history-tbody', 8);
    const params = new URLSearchParams({
        page: String(historyPage),
        pageSize: String(HISTORY_PAGE_SIZE),
        status: historyStatus,
    });
    if (historySearch) params.set('search', historySearch);
    try {
        const res = await authFetch(`${API_URL}/invoices?${params.toString()}`);
        const data = await res.json();
        if (opts.background) return; // just warming the connection/cache
        const rows = data.invoices || [];
        historyPage = data.page || 1;
        historyTotalPages = data.totalPages || 1;
        renderHistory(rows);
        updateHistoryPager(data.total || 0);
    } catch (e) { console.error('Error loading history', e); }
}

function updateHistoryPager(total) {
    const info = document.getElementById('history-page-info');
    if (info) {
        const start = total === 0 ? 0 : (historyPage - 1) * HISTORY_PAGE_SIZE + 1;
        const end = Math.min(historyPage * HISTORY_PAGE_SIZE, total);
        info.textContent = total === 0 ? 'No invoices' : `Showing ${start}–${end} of ${total} · page ${historyPage} of ${historyTotalPages}`;
    }
    const prev = document.getElementById('history-prev');
    const next = document.getElementById('history-next');
    if (prev) prev.disabled = historyPage <= 1;
    if (next) next.disabled = historyPage >= historyTotalPages;
}

function historyPrev() { if (historyPage > 1) { historyPage--; loadHistory(); } }
function historyNext() { if (historyPage < historyTotalPages) { historyPage++; loadHistory(); } }
function onHistoryFilter() {
    historyStatus = document.getElementById('historyStatus').value;
    historyPage = 1;
    loadHistory();
}
const onHistorySearch = debounce(() => {
    historySearch = document.getElementById('historySearch').value.trim();
    historyPage = 1;
    loadHistory();
}, 300);

async function viewInvoice(id) {
    try {
        const res = await authFetch(`${API_URL}/invoices/${id}`);
        const inv = await res.json();
        if (inv.error) return toast(inv.error, 'error');

        currentInvoiceId = inv.InvoiceID;
        currentLoadedInvoice = inv; // so locked invoices render their stored totals (incl. legacy tax)
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

// Download a server-rendered PDF of the current invoice (headless Chromium).
// Only available for a saved invoice; falls back to the Print button with a
// clear message if the server has no PDF engine installed.
async function downloadInvoicePdf() {
    if (!currentInvoiceId) { toast('Save the invoice first, then download its PDF.', 'info'); return; }
    const btn = document.getElementById('btnDownloadPdf');
    const original = btn ? btn.innerHTML : '';
    try {
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line"></i> Generating...'; }
        // Pass the current bill-type so the PDF matches the on-screen view.
        const res = await authFetch(`${API_URL}/invoices/${currentInvoiceId}/pdf?billType=${billType}`);
        if (!res.ok) {
            let msg = 'Could not generate PDF.';
            try { const e = await res.json(); if (e.error) msg = e.error; } catch (_) {}
            toast(msg + (res.status === 501 ? ' You can still use Print.' : ''), 'error');
            return;
        }
        const blob = await res.blob();
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename="?([^"]+)"?/.exec(cd);
        const filename = (m && m[1]) || 'invoice.pdf';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        toast('PDF downloaded', 'success');
    } catch (err) {
        toast('Could not generate PDF. You can use Print instead.', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
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

