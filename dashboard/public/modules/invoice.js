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

/**
 * The invoice being revised, or null in every other mode.
 *
 * Anything that resets the editor MUST clear this, or the next fresh invoice
 * would silently post as a revision of whatever was last opened.
 */
let revising = null;

/** Leave revise mode and put the Finalize button's own label back. */
function clearRevising() {
    revising = null;
    const btn = document.getElementById('btnFinalize');
    if (btn) btn.innerHTML = '<i class="ri-check-double-line"></i> Finalize Invoice (Deducts Stock)';
}

async function startNewInvoice() {
    currentInvoiceId = null;
    currentLoadedInvoice = null;
    clearRevising();
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
            // Show the SUGGESTED 80% bill (what the row will default to).
            const suggested = item.SuggestedBill != null ? item.SuggestedBill : (item.Price || 0);
            tbody.innerHTML += `
                <tr>
                    <td>${escAttr(item.UniqueID)}</td>
                    <td>${escAttr(item.ProductName)}</td>
                    <td>${escAttr(item.SpecificationCode)}</td>
                    <td>${item.Qty}</td>
                    <td>${formatCurrency(suggested)}${item.SuggestedFloored ? ' <span style="color:#c2410c;font-size:10px;">(cost)</span>' : ''}</td>
                    <td><button class="btn btn-primary" onclick="addInventoryFromModal(${item.InventoryID})">Add</button></td>
                </tr>
            `;
        });
    } catch (e) {}
}

function addInventoryFromModal(invId) {
    const item = modalSearchResults.find((i) => i.InventoryID === invId);
    if (!item) return;
    // Default the billed rate to the SUGGESTED 80%-of-market-mid figure (floored at
    // cost). The operator can still edit it before saving. Carry cost + market so
    // the rate cell can show the three-way comparison badges.
    const suggested = item.SuggestedBill != null ? item.SuggestedBill : (item.Price || 0);
    // Market price is the resolved priority-1 value (outside benchmark first, then
    // the datasheet mid). Fall back to MarketMid for older responses.
    const market = item.MarketPrice != null ? item.MarketPrice : (item.MarketMid || 0);
    invoiceItems.push({
        id: nextItemId++,
        inventoryId: item.InventoryID,
        desc: `${item.ProductName} - ${item.SpecificationCode}`,
        unit: item.Unit,
        length: item.Length,
        qty: 1,
        rate: suggested,
        cost: item.Cost || 0,
        marketMid: market,
        suggested,
        source: item.MarketSource || 'inventory',
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
// Crimping charge — priced PER END by hose size + WIRE TYPE (2-wire vs 4-wire).
// Internal cost/end is common; the shop market/end differs by wire type. Billed
// defaults to the market/end for the chosen wire type; never below internal cost.
// (Scoped to crimping only — no other pricing section is affected.)
// ----------------------------------------------------
let crimpingRates = [];

async function loadCrimpingRates() {
    if (crimpingRates.length) return crimpingRates;
    try {
        const res = await authFetch(`${API_URL}/pricing/crimping`);
        const data = await res.json();
        if (Array.isArray(data)) crimpingRates = data;
    } catch (e) { console.error('Error loading crimping rates', e); }
    return crimpingRates;
}

async function openCrimpingModal() {
    await loadCrimpingRates();
    const sel = document.getElementById('crimp-size');
    if (!crimpingRates.length) {
        toast('No crimping rates found. Import the pricing master under Pricing Master first.', 'error');
        return;
    }
    sel.innerHTML = crimpingRates.map((r) => `<option value="${escAttr(r.size)}">${escAttr(r.size)}"</option>`).join('');
    document.getElementById('crimp-wire').value = '2-wire';
    document.getElementById('crimp-ends').value = 2;
    document.getElementById('crimp-billed').value = '';   // cleared -> auto-filled from market
    updateCrimpingPreview();
    openModal('crimpingModal');
}

function selectedCrimp() {
    const size = document.getElementById('crimp-size').value;
    return crimpingRates.find((r) => r.size === size) || null;
}

function crimpWire() { return document.getElementById('crimp-wire').value === '4-wire' ? '4-wire' : '2-wire'; }
function crimpEnds() { return Math.max(1, parseInt(document.getElementById('crimp-ends').value, 10) || 1); }

// Market/end for the selected size + wire type (null when the workbook does not
// define a 4-wire rate for that size).
function crimpMarketPerEnd(r, wire) {
    if (!r) return null;
    const v = wire === '4-wire' ? r.market4Wire : r.market2Wire;
    return v == null ? null : Number(v);
}

// Re-render the crimping preview + totals. `fromBilled` = the user edited the
// billed field, so we keep their value instead of re-filling from market.
function updateCrimpingPreview(fromBilled) {
    const r = selectedCrimp();
    const el = document.getElementById('crimp-preview');
    const billedInput = document.getElementById('crimp-billed');
    if (!r) { el.textContent = ''; return; }
    const wire = crimpWire();
    const ends = crimpEnds();
    const internal = Number(r.internalCostPerEnd) || 0;
    const market = crimpMarketPerEnd(r, wire);

    // Auto-fill billed with market when the user hasn't just typed in it.
    if (!fromBilled) billedInput.value = market != null ? market : '';
    let billed = parseFloat(billedInput.value);
    if (!(billed >= 0)) billed = market != null ? market : 0;

    const total = round2(billed * ends);
    let warn = '';
    if (market == null) {
        warn = `<div style="color:#c2410c;font-weight:600;margin-top:6px;">⚠ No ${wire} shop rate for ${escAttr(r.size)}" — enter the billed rate manually.</div>`;
    } else if (billed < internal) {
        warn = `<div style="color:#dc2626;font-weight:600;margin-top:6px;">⚠ Billed ${formatCurrency(billed)}/end is below internal cost ${formatCurrency(internal)}/end.</div>`;
    }
    el.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;">
            <span style="color:var(--text-muted);">Internal cost/end</span><strong class="num" style="text-align:right;">${formatCurrency(internal)}</strong>
            <span style="color:var(--text-muted);">Market/end (${wire})</span><strong class="num" style="text-align:right;">${market != null ? formatCurrency(market) : '—'}</strong>
            <span style="color:var(--text-muted);">Bill/end</span><strong class="num" style="text-align:right;color:#047857;">${formatCurrency(billed)}</strong>
            <span style="color:var(--text-muted);">Ends</span><strong class="num" style="text-align:right;">${ends}</strong>
        </div>
        <div style="border-top:1px solid var(--border-color,#e5e7eb);margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;">
            <span style="font-weight:600;">Total bill</span><strong class="num" style="font-size:16px;">${formatCurrency(total)}</strong>
        </div>${warn}`;
}

function addCrimpingLine(e) {
    if (e) e.preventDefault();
    const r = selectedCrimp();
    if (!r) return;
    const wire = crimpWire();
    const ends = crimpEnds();
    const internal = Number(r.internalCostPerEnd) || 0;
    const market = crimpMarketPerEnd(r, wire);
    let billed = parseFloat(document.getElementById('crimp-billed').value);
    if (!(billed >= 0)) billed = market != null ? market : 0;
    if (!(billed > 0)) { toast('Enter a billed rate per end.', 'error'); return; }

    invoiceItems.push({
        id: nextItemId++,
        inventoryId: null,
        desc: `Crimping charge — ${r.size}" (${wire}, ${ends} end${ends === 1 ? '' : 's'})`,
        unit: 'end',
        length: 0,
        qty: ends,                                   // billed per end
        rate: round2(billed),                        // shop market/end by default (or manual)
        cost: round2(internal),                      // internal cost per end
        marketMid: market != null ? round2(market) : round2(billed), // wire-type market/end
        suggested: market != null ? round2(market) : round2(billed),
        source: 'crimping-charges',
        maxQty: null,
    });
    closeModal('crimpingModal');
    renderInvoiceItems();
}

// ----------------------------------------------------
// Welding Extra — optional per-hose welding labour, by size + wire type. Added as
// its OWN clearly-labelled line ("Welding Extra — 2-wire 1/2\""); never merged
// into crimping or technical charges. (Scoped to welding-extra only.)
// ----------------------------------------------------
let weldingRates = null; // { mode, rows: [{size, assembly2Wire, weldingExtra2Wire, assembly4Wire, weldingExtra4Wire}] }

async function loadWeldingRates() {
    if (weldingRates) return weldingRates;
    try {
        const res = await authFetch(`${API_URL}/pricing/welding-extra`);
        const data = await res.json();
        if (data && Array.isArray(data.rows)) weldingRates = data;
    } catch (e) { console.error('Error loading welding-extra rates', e); }
    return weldingRates;
}

async function openWeldingModal() {
    await loadWeldingRates();
    const sel = document.getElementById('weld-size');
    if (!weldingRates || !weldingRates.rows.length) {
        toast('No welding-extra rates found.', 'error');
        return;
    }
    sel.innerHTML = weldingRates.rows.map((r) => `<option value="${escAttr(r.size)}">${escAttr(r.size)}"</option>`).join('');
    document.getElementById('weld-wire').value = '2-wire';
    document.getElementById('weld-ends').value = 1;
    updateWeldingPreview();
    openModal('weldingModal');
}

function selectedWeld() {
    const size = document.getElementById('weld-size').value;
    return weldingRates ? weldingRates.rows.find((r) => r.size === size) || null : null;
}
function weldWire() { return document.getElementById('weld-wire').value === '4-wire' ? '4-wire' : '2-wire'; }
function weldEnds() { return Math.max(1, parseInt(document.getElementById('weld-ends').value, 10) || 1); }

function weldRatesFor(r, wire) {
    if (!r) return { assembly: null, extra: null };
    if (wire === '4-wire') return { assembly: r.assembly4Wire, extra: r.weldingExtra4Wire };
    return { assembly: r.assembly2Wire, extra: r.weldingExtra2Wire };
}

function updateWeldingPreview() {
    const r = selectedWeld();
    const el = document.getElementById('weld-preview');
    if (!r) { el.textContent = ''; return; }
    const wire = weldWire();
    const ends = weldEnds();
    const { assembly, extra } = weldRatesFor(r, wire);
    const perEnd = (weldingRates && weldingRates.mode) === 'per-end';
    const total = extra == null ? 0 : round2(perEnd ? extra * ends : extra);
    let warn = '';
    if (extra == null) {
        warn = `<div style="color:#c2410c;font-weight:600;margin-top:6px;">⚠ No ${wire} welding-extra rate for ${escAttr(r.size)}".</div>`;
    }
    el.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;">
            <span style="color:var(--text-muted);">Assembly (ref)</span><strong class="num" style="text-align:right;">${assembly != null ? formatCurrency(assembly) : '—'}</strong>
            <span style="color:var(--text-muted);">Welding extra/${perEnd ? 'end' : 'job'} (${wire})</span><strong class="num" style="text-align:right;">${extra != null ? formatCurrency(extra) : '—'}</strong>
            <span style="color:var(--text-muted);">Welded ends</span><strong class="num" style="text-align:right;">${ends}</strong>
        </div>
        <div style="border-top:1px solid var(--border-color,#e5e7eb);margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;">
            <span style="font-weight:600;">Welding extra total</span><strong class="num" style="font-size:16px;color:#047857;">${formatCurrency(total)}</strong>
        </div>${warn}`;
}

function addWeldingLine(e) {
    if (e) e.preventDefault();
    const r = selectedWeld();
    if (!r) return;
    const wire = weldWire();
    const ends = weldEnds();
    const { extra } = weldRatesFor(r, wire);
    if (extra == null) { toast(`No ${wire} welding-extra rate for ${r.size}".`, 'error'); return; }
    const perEnd = (weldingRates && weldingRates.mode) === 'per-end';
    // flat-per-job -> one line at the extra rate; per-end -> qty = welded ends.
    const qty = perEnd ? ends : 1;
    const rate = round2(extra);
    invoiceItems.push({
        id: nextItemId++,
        inventoryId: null,
        desc: `Welding Extra — ${wire} ${r.size}"${perEnd ? '' : ` (${ends} end${ends === 1 ? '' : 's'})`}`,
        unit: perEnd ? 'end' : 'job',
        length: 0,
        qty,
        rate,
        cost: 0,                 // labour charge — no material cost in the sheet
        marketMid: rate,         // benchmark = the shop welding-extra rate
        suggested: rate,
        source: 'welding-extra', // own category — kept separate from technical/crimping
        maxQty: null,
    });
    closeModal('weldingModal');
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

// Comparison badges shown under a rate cell: Our Cost (amber), Market Mid (blue),
// Suggested 80% (green) + a red warning when the billed rate is below cost. Gives
// the operator the full 3-way picture (cost / market / suggested) while editing.
function marginHintHtml(it) {
    const cost = Number(it.cost) || 0;
    const rate = Number(it.rate) || 0;
    const market = Number(it.marketMid) || 0;
    const suggested = Number(it.suggested) || 0;
    if (cost <= 0 && market <= 0) return '<div class="margin-hint muted"></div>'; // nothing to compare

    const badges = [];
    const mktTitle = it.source === 'outside-benchmark' ? 'Market — outside-company benchmark' : 'Market benchmark';
    if (cost > 0) badges.push(`<span class="pbadge pbadge-cost" title="Our landed cost">Cost ${formatCurrency(cost)}</span>`);
    if (market > 0) badges.push(`<span class="pbadge pbadge-market" title="${mktTitle}">Mkt ${formatCurrency(market)}${it.source === 'outside-benchmark' ? '*' : ''}</span>`);
    if (suggested > 0) badges.push(`<span class="pbadge pbadge-suggested" title="Suggested = 80% of market, floored at cost (ferrules cost x 1.25)">80% ${formatCurrency(suggested)}</span>`);

    let warn = '';
    if (cost > 0 && rate < cost) {
        warn = `<div class="margin-hint warn">⚠ below cost — losing ${formatCurrency(cost - rate)}/unit</div>`;
    } else if (suggested > 0 && rate < suggested - 0.5) {
        warn = `<div class="margin-hint" style="color:#b45309;">↓ under the 80% floor</div>`;
    } else if (rate > 0 && cost > 0) {
        const pct = round2(((rate - cost) / rate) * 100);
        warn = `<div class="margin-hint ok">▲ ${pct}% margin</div>`;
    }
    return `<div class="pbadges">${badges.join('')}</div>${warn}`;
}

// Simplified, customer-facing description for the OUTSIDE bill. Display-only —
// it NEVER mutates item.desc, so the full description (with part numbers / spec
// codes) is always what gets saved to the database.
function getOutsideDesc(item) {
    const d = String(item.desc || '');
    const dl = d.toLowerCase();
    const unit = String(item.unit || '').toLowerCase();
    if (dl.includes('crimping')) return d;                       // already customer-friendly
    if (dl.includes('welding')) return 'Welding charge';
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
                    <div class="rate-hint-wrap">${editable ? marginHintHtml(it) : ''}</div>
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
        const wrap = row.querySelector('.rate-hint-wrap');
        if (wrap && isInvoiceEditable) {
            // Re-render the whole hint block (badges + warning) so it stays in sync
            // as the rate is edited. marginHintHtml returns multiple elements, so we
            // replace the container's contents rather than a single node.
            wrap.innerHTML = marginHintHtml(it);
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

    // In revise mode the same button issues a revision instead. It cannot reuse
    // the path below: that sends the ORIGINAL's invoiceId, which /finalize
    // rejects because the invoice is no longer a draft.
    if (revising) return openReviseModal();

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
            // Manual lines (crimping / technical) carry their own cost + market mid
            // so the server can snapshot their profitability. Ignored for stock
            // items (the server snapshots those from Inventory).
            cost: i.cost,
            marketMid: i.marketMid,
            pricingSource: i.source,
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
    if (status === 'Revised') return 'badge-revised';
    return 'badge-ok';
}

function renderHistory(data) {
    const tbody = document.getElementById('history-tbody');
    tbody.innerHTML = '';
    if (!data.length) { emptyRow('history-tbody', 8, '🧾', 'No invoices yet', 'Create your first invoice from “New Invoice”.'); return; }
    data.forEach((inv) => {
        const isFinalized = inv.Status === 'Finalized';
        const isCancelled = inv.Status === 'Cancelled';
        const isRevised = inv.Status === 'Revised';
        const balance = Number(inv.Balance) || 0;
        const paid = Number(inv.AmountPaid) || 0;
        const payBadge = isFinalized
            ? `<span class="badge ${paymentBadgeClass(inv.PaymentStatus)}">${inv.PaymentStatus}</span>`
            : '<span style="color:var(--text-muted)">—</span>';
        const safeNo = escAttr(inv.InvoiceNo).replace(/'/g, "\\'");

        let actions = `<button class="btn btn-secondary btn-text" onclick="viewInvoice(${inv.InvoiceID})">View</button>`;
        // The modal opens whenever there is money to see, not only money to
        // take — otherwise a fully paid invoice has no route to its payments,
        // and voiding one would be unreachable.
        if (isFinalized && (balance > 0 || paid > 0)) {
            actions += ` <button class="btn btn-text" style="color:var(--success)" onclick="openPaymentModal(${inv.InvoiceID}, '${safeNo}')">${balance > 0 ? 'Payment' : 'Payments'}</button>`;
        }
        if (isFinalized) {
            actions += ` <button class="btn btn-text" style="color:#b45309" onclick="reviseInvoice(${inv.InvoiceID}, '${safeNo}')">Revise</button>`;
        }
        // A superseded invoice has already had its stock and ledger reversed —
        // cancelling it again would be a second restoration.
        if (!isCancelled && !isRevised) {
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

async function viewInvoice(id, opts = {}) {
    try {
        const res = await authFetch(`${API_URL}/invoices/${id}`);
        const inv = await res.json();
        if (inv.error) return toast(inv.error, 'error');

        if (opts.revise) {
            revising = {
                id: inv.InvoiceID,
                invoiceNo: inv.InvoiceNo,
                grandTotal: Number(inv.GrandTotal) || 0,
                amountPaid: Number(inv.AmountPaid) || 0,
                // A revision bills on the same basis as the invoice it replaces.
                // New invoices are untaxed, but a handful of May-2026 ones still
                // carry SSCL/VAT and the server preserves their rates.
                ssclRate: Number(inv.SSCLRate) || 0,
                vatRate: Number(inv.VATRate) || 0,
            };
        } else {
            clearRevising();
        }

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
            cost: (it.UnitCostAtBilling != null ? it.UnitCostAtBilling : it.Cost) || 0,
            marketMid: it.MarketBillRate || 0,
            suggested: it.SuggestedBillRate || 0,
            source: it.PricingSource || (it.InventoryID ? 'inventory' : 'manual'),
            maxQty: null,
        }));

        // Anything that is not a draft is a posted fact. Written as "not Draft"
        // rather than a list of locked statuses so a future status is locked by
        // default instead of accidentally editable.
        const locked = inv.Status !== 'Draft' && !revising;
        setInvoiceEditable(!locked);
        renderInvoiceItems();

        document.getElementById('invoice-save-actions').style.display = 'flex';
        const btnDraft = document.getElementById('btnSaveDraft');
        const btnFinal = document.getElementById('btnFinalize');
        if (revising) {
            btnDraft.style.display = 'none';
            btnFinal.style.display = 'inline-flex';
            btnFinal.innerHTML = '<i class="ri-file-copy-2-line"></i> Review revision';
            document.getElementById('addItemBtnContainer').style.display = 'flex';
        } else if (locked) {
            btnDraft.style.display = 'none';
            btnFinal.style.display = 'none';
            document.getElementById('addItemBtnContainer').style.display = 'none';
        } else {
            btnDraft.style.display = 'inline-flex';
            btnFinal.style.display = 'inline-flex';
            document.getElementById('addItemBtnContainer').style.display = 'flex';
        }

        showSection('new-invoice');
        const title = document.getElementById('invoice-view-title');
        if (revising) {
            title.textContent = `Revising ${inv.InvoiceNo} — correct the lines, then Review revision`;
        } else if (inv.Status === 'Revised') {
            const by = await supersededByNo(inv);
            title.textContent = `Viewing Invoice: ${inv.InvoiceNo} (Revised${by ? ` — replaced by ${by}` : ''})`;
        } else {
            title.textContent = `Viewing Invoice: ${inv.InvoiceNo} (${inv.Status})`;
        }
    } catch (e) { toast('Error loading invoice', 'error'); }
}

/** The number of the invoice that replaced this one, for the view title. */
async function supersededByNo(inv) {
    if (!inv.SupersededBy) return null;
    try {
        const res = await authFetch(`${API_URL}/invoices/${inv.SupersededBy}`);
        const data = await res.json();
        return data && data.InvoiceNo ? data.InvoiceNo : null;
    } catch (_) { return null; }
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

        // A settled invoice still needs its payment history reachable — that is
        // the only route to voiding one recorded in error. Show the list, hide
        // the entry form.
        const settled = !(data.balance > 0);
        document.getElementById('pay-modal-title').textContent = settled ? 'Payments' : 'Record Payment';
        document.getElementById('pay-entry').style.display = settled ? 'none' : '';
        document.getElementById('pay-actions').style.display = settled ? 'none' : '';

        const hist = document.getElementById('pay-history');
        if (data.payments && data.payments.length) {
            hist.innerHTML = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Payments recorded</div>' +
                data.payments.map((p) => {
                    const voided = !!p.VoidedAt;
                    const strike = voided ? ' style="text-decoration:line-through"' : '';
                    // type="button" matters: this markup lives inside the
                    // payment form, so a default-type button would submit it.
                    const action = voided
                        ? `<span class="badge badge-cancelled" title="${escAttr(p.VoidReason || '')}">Voided</span>`
                        : `<button type="button" class="btn btn-text" style="color:var(--danger)" onclick="voidPayment(${p.PaymentID})">Void</button>`;
                    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;padding:4px 0;border-bottom:1px solid var(--border-color);${voided ? 'opacity:.55;' : ''}">
                        <span${strike}>${formatDate(p.PaymentDate)} · ${escAttr(p.Method || '')}</span>
                        <strong${strike}>${formatCurrency(p.Amount)}</strong>
                        ${action}
                    </div>`;
                }).join('');
        } else {
            hist.innerHTML = '';
        }
        openModal('paymentModal');
    } catch (e) { toast(e.message || String(e), 'error'); }
}

/**
 * Void a payment recorded in error. The row is kept and struck through; the
 * money comes back off the invoice and its ledger entry is reversed.
 */
async function voidPayment(paymentId) {
    const reason = await promptDialog({
        title: 'Void this payment?',
        message: 'The payment stays on the record, struck through, and its ledger entry is reversed. Why is it being voided?',
        confirmText: 'Void payment',
        danger: true,
        placeholder: 'e.g. recorded against the wrong invoice',
    });
    if (reason === null) return;
    if (!String(reason).trim()) return toast('A reason is required', 'error');
    try {
        const res = await authFetch(`${API_URL}/payments/${paymentId}/void`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
        });
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Could not void the payment', 'error'); return; }
        toast(`Voided — balance is now ${formatCurrency(data.balance)}`, 'success');
        invalidateCache('invoices', 'dashboard');
        // Re-open against the same invoice so the list, the balance and the
        // entry form all reflect the void.
        await openPaymentModal(data.invoiceId, document.getElementById('pay-invoice-no').textContent);
        loadHistory();
        loadDashboard();
    } catch (err) { toast(err.message || String(err), 'error'); }
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

// ----------------------------------------------------
// Revising a posted invoice
//
// A finalized invoice is never edited. Revise opens it in the editor so the
// operator can correct the lines, then supersedes it: the original is reversed
// out in full and a replacement is issued as INV/..../003-R1.
// ----------------------------------------------------

/** Open a finalized invoice in revise mode. */
async function reviseInvoice(id, invoiceNo) {
    await viewInvoice(id, { revise: true });
    if (revising) {
        toast(`Correcting ${invoiceNo}. Change the lines, then press Review revision.`, 'info');
    }
}

/**
 * The number the replacement will be given.
 *
 * Only the newest invoice in a chain can be revised, so incrementing this one's
 * own suffix always lands on the right answer: -R1 becomes -R2, never -R1-R1.
 * The server is authoritative; this is the label on the confirmation.
 */
function nextRevisionLabel(invoiceNo) {
    const m = /^(.*?)-R(\d+)$/.exec(String(invoiceNo || ''));
    return m ? `${m[1]}-R${Number(m[2]) + 1}` : `${invoiceNo}-R1`;
}

/**
 * What the corrected bill will come to.
 *
 * The editor's own total is tax-free, because new invoices are. A revision of a
 * legacy SSCL/VAT invoice keeps that invoice's rates, so the preview has to add
 * them back or it would promise a lower figure than the server will produce.
 */
function revisedGrandTotal(totals) {
    if (!revising || (!revising.ssclRate && !revising.vatRate)) return totals.grand;
    const sscl = totals.subTotal * (revising.ssclRate / 100);
    const preVat = totals.subTotal + sscl;
    const grand = preVat + preVat * (revising.vatRate / 100) - totals.discount;
    return totals.roundToRupee ? Math.round(grand) : Math.round(grand * 100) / 100;
}

/** Summarise what is about to happen, and collect the reason. */
function openReviseModal() {
    if (!revising) return;
    const totals = calcInvoiceTotals();
    document.getElementById('revise-invoice-no').textContent = revising.invoiceNo;
    document.getElementById('revise-new-no').textContent = nextRevisionLabel(revising.invoiceNo);
    document.getElementById('revise-old-total').textContent = formatCurrency(revising.grandTotal);
    document.getElementById('revise-new-total').textContent = formatCurrency(revisedGrandTotal(totals));
    document.getElementById('revise-reason').value = '';

    // The carry-forward choice only means anything when money has been taken.
    const carryRow = document.getElementById('revise-carry-row');
    const carry = document.getElementById('revise-carry');
    carry.checked = true;
    if (revising.amountPaid > 0) {
        carryRow.style.display = '';
        document.getElementById('revise-paid').textContent = formatCurrency(revising.amountPaid);
    } else {
        carryRow.style.display = 'none';
    }
    openModal('reviseModal');
}

let submittingRevision = false;
async function submitRevision(e) {
    e.preventDefault();
    if (submittingRevision || !revising) return;
    const reason = document.getElementById('revise-reason').value.trim();
    if (!reason) return toast('Say why the invoice is being revised', 'error');

    const totals = calcInvoiceTotals();
    const payload = {
        reason,
        carryPayments: document.getElementById('revise-carry').checked,
        invoiceDate: document.getElementById('invDate').value,
        billedToName: document.getElementById('billedToName') ? document.getElementById('billedToName').value : '',
        billedToAddress: document.getElementById('billedToAddress') ? document.getElementById('billedToAddress').value : '',
        deliveredToName: document.getElementById('deliveredToName') ? document.getElementById('deliveredToName').value : '',
        deliveredToAddress: document.getElementById('deliveredToAddress') ? document.getElementById('deliveredToAddress').value : '',
        discount: totals.discount,
        roundToRupee: totals.roundToRupee,
        items: invoiceItems.map((i) => ({
            inventoryId: i.inventoryId,
            description: i.desc,
            unit: i.unit,
            length: i.length,
            qty: i.qty,
            rate: i.rate,
            cost: i.cost,
            marketMid: i.marketMid,
            pricingSource: i.source,
        })),
    };

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submittingRevision = true;
    if (submitBtn) submitBtn.disabled = true;
    try {
        const res = await authFetch(`${API_URL}/invoices/${revising.id}/revise`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Revision failed', 'error'); return; }

        closeModal('reviseModal');
        clearRevising();
        invalidateCache('dashboard', 'invoices', 'inventory');

        let msg = `${data.originalInvoiceNo} replaced by ${data.invoiceNo}`;
        if (data.difference > 0) msg += ` — ${formatCurrency(data.difference)} more`;
        else if (data.difference < 0) msg += ` — ${formatCurrency(-data.difference)} less`;
        toast(msg, 'success');

        // The invoice can be correct while the ledger was not updated. Never let
        // that pass as a clean success — it is invisible everywhere else.
        if (data.ledgerErrors && data.ledgerErrors.length) {
            toast(`The invoice was revised but the books were NOT updated: ${data.ledgerErrors.join(' ')}`, 'error');
        }
        if (data.refundDue > 0) {
            toast(`${formatCurrency(data.refundDue)} was taken that the corrected bill does not cover — refund it.`, 'error');
        } else if (data.balance > 0) {
            toast(`${formatCurrency(data.balance)} still owed on ${data.invoiceNo}`, 'info');
        }
        loadDashboard();
        showSection('history');
        loadHistory();
    } catch (err) {
        toast(err.message || String(err), 'error');
    } finally {
        submittingRevision = false;
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

