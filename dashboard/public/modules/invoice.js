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

    // Auto-update Sundries cost and Technical charges — ONLY while the invoice is
    // editable. A finalized/locked invoice must reprint the exact rates that were
    // billed; re-deriving them here (from the currently loaded material lines,
    // unrounded) would make a reprint disagree with the stored bill.
    if (isInvoiceEditable) {
        const sundriesItem = invoiceItems.find((it) => it.desc === 'Sundries cost');
        if (sundriesItem) sundriesItem.rate = round2(materialCost * 0.12);
        const techItem = invoiceItems.find((it) => it.desc === 'Technical charges');
        if (techItem) techItem.rate = round2(materialCost * 0.9);
    }

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

