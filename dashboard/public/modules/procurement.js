/* ===== PROCUREMENT: orders, receipts, supplier bills and what we owe ===== */

let procTab = 'orders';
let procSuppliers = [];
let procItems = [];
let grnDraftLines = [];
let grnDraftCosts = [];

function procShowTab(tab) {
    procTab = tab;
    ['orders', 'receipts', 'bills', 'payables'].forEach((t) => {
        document.getElementById(`proc-pane-${t}`).style.display = t === tab ? '' : 'none';
        const btn = document.getElementById(`proc-tab-${t}`);
        btn.classList.toggle('btn-primary', t === tab);
        btn.classList.toggle('btn-secondary', t !== tab);
    });
    loadProcurement();
}

async function loadProcurement() {
    try {
        if (!procSuppliers.length) {
            const [s, i] = await Promise.all([authFetch(`${API_URL}/suppliers`), authFetch(`${API_URL}/inventory`)]);
            procSuppliers = await s.json();
            procItems = await i.json();
        }
        if (procTab === 'orders') renderPurchaseOrders(await (await authFetch(`${API_URL}/purchase-orders`)).json());
        else if (procTab === 'receipts') renderGoodsReceipts(await (await authFetch(`${API_URL}/goods-receipts`)).json());
        else if (procTab === 'bills') renderPurchaseBills(await (await authFetch(`${API_URL}/purchase-bills`)).json());
        else renderPayables(await (await authFetch(`${API_URL}/payables/ageing`)).json());
    } catch (e) { console.error('Error loading procurement', e); }
}

const PROC_STATUS = {
    open: 'badge-draft', received: 'badge-finalized', cancelled: 'badge-cancelled',
    posted: 'badge-draft', paid: 'badge-paid',
};

function renderPurchaseOrders(rows) {
    const tb = document.getElementById('proc-orders-tbody');
    tb.innerHTML = '';
    if (!rows.length) { emptyRow('proc-orders-tbody', 7, '📦', 'No purchase orders yet', 'Raise one to start tracking what is on the way.'); return; }
    rows.forEach((p) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${escAttr(p.PONo)}</strong></td>
                <td>${formatDate(p.OrderDate)}</td>
                <td>${escAttr(p.SupplierName) || '<span class="flat">—</span>'}</td>
                <td class="num">${p.Lines}</td>
                <td class="num">${formatCurrency(p.Total)}</td>
                <td><span class="badge ${PROC_STATUS[p.Status] || 'badge-ok'}">${escAttr(p.Status)}</span></td>
                <td>
                    ${p.Status === 'open' ? `<button class="btn btn-text" onclick="openReceiveModal(${p.POID})">Receive</button>` : ''}
                    <button class="btn btn-text" onclick="viewPurchaseOrder(${p.POID})">View</button>
                </td>
            </tr>`;
    });
}

function renderGoodsReceipts(rows) {
    const tb = document.getElementById('proc-receipts-tbody');
    tb.innerHTML = '';
    if (!rows.length) { emptyRow('proc-receipts-tbody', 7, '🚚', 'Nothing received yet', 'Receive against a purchase order, or record a direct receipt.'); return; }
    rows.forEach((g) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${escAttr(g.GRNNo)}</strong></td>
                <td>${formatDate(g.ReceiptDate)}</td>
                <td>${escAttr(g.SupplierName) || '<span class="flat">—</span>'}</td>
                <td>${escAttr(g.PONo) || '<span class="flat">direct</span>'}</td>
                <td class="num">${formatCurrency(g.GoodsValue)}</td>
                <td class="num">${g.LandedCost ? formatCurrency(g.LandedCost) : '<span class="flat">—</span>'}</td>
                <td><button class="btn btn-text" onclick="viewGoodsReceipt(${g.GRNID})">View</button></td>
            </tr>`;
    });
}

function renderPurchaseBills(rows) {
    const tb = document.getElementById('proc-bills-tbody');
    tb.innerHTML = '';
    if (!rows.length) { emptyRow('proc-bills-tbody', 8, '🧾', 'No supplier bills yet', ''); return; }
    rows.forEach((b) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${escAttr(b.BillNo)}</strong>${b.SupplierBillNo ? `<br><span style="font-size:11px;color:var(--text-muted);">${escAttr(b.SupplierBillNo)}</span>` : ''}</td>
                <td>${formatDate(b.BillDate)}</td>
                <td>${escAttr(b.SupplierName) || '<span class="flat">—</span>'}</td>
                <td>${escAttr(b.GRNNo) || '<span class="flat">—</span>'}</td>
                <td class="num">${formatCurrency(b.Total)}</td>
                <td class="num">${formatCurrency(b.AmountPaid)}</td>
                <td class="num ${b.Outstanding > 0 ? 'neg' : 'flat'}">${formatCurrency(b.Outstanding)}</td>
                <td>${b.Outstanding > 0 ? `<button class="btn btn-text" onclick="openSupplierPayModal(${b.BillID}, ${b.Outstanding}, ${b.SupplierID || 'null'})">Pay</button>` : '<span class="badge badge-paid">paid</span>'}</td>
            </tr>`;
    });
}

function renderPayables(d) {
    const b = d.buckets;
    document.getElementById('proc-ageing').innerHTML = `
        <div class="jp-foot-cell"><span class="k">Not yet due</span><span class="v">${formatCurrency(b.current)}</span></div>
        <div class="jp-foot-cell"><span class="k">1–30 days</span><span class="v">${formatCurrency(b.d30)}</span></div>
        <div class="jp-foot-cell"><span class="k">31–60 days</span><span class="v">${formatCurrency(b.d60)}</span></div>
        <div class="jp-foot-cell"><span class="k">61–90 days</span><span class="v">${formatCurrency(b.d90)}</span></div>
        <div class="jp-foot-cell"><span class="k">Over 90 days</span><span class="v neg">${formatCurrency(b.older)}</span></div>
        <div class="jp-foot-cell jp-unpaid"><span class="k">Total owed to suppliers</span><span class="v">${formatCurrency(b.total)}</span></div>`;

    const tb = document.getElementById('proc-payables-tbody');
    tb.innerHTML = '';
    if (!d.bills.length) { emptyRow('proc-payables-tbody', 6, '✅', 'Nothing outstanding', 'Every supplier bill is settled.'); return; }
    d.bills.forEach((x) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${escAttr(x.BillNo)}</strong></td>
                <td>${escAttr(x.SupplierName) || '<span class="flat">—</span>'}</td>
                <td>${formatDate(x.BillDate)}</td>
                <td>${x.DueDate ? formatDate(x.DueDate) : '<span class="flat">—</span>'}</td>
                <td class="num">${formatCurrency(x.Total)}</td>
                <td class="num neg">${formatCurrency(x.Outstanding)}</td>
            </tr>`;
    });
}

// ---- purchase order entry ----

function openPoModal() {
    document.getElementById('po-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('po-supplier').innerHTML = '<option value="">— none —</option>' +
        procSuppliers.map((s) => `<option value="${s.SupplierID}">${escAttr(s.Name)}</option>`).join('');
    document.getElementById('po-lines').innerHTML = '';
    addPoLine();
    openModal('poModal');
}

function itemOptions(selected) {
    return '<option value="">— free text —</option>' + procItems
        .map((i) => `<option value="${i.InventoryID}"${String(selected) === String(i.InventoryID) ? ' selected' : ''}>${escAttr(i.ProductName)}</option>`)
        .join('');
}

function addPoLine() {
    const div = document.createElement('div');
    div.className = 'form-group row po-line';
    div.innerHTML = `
        <div class="col" style="flex:2;"><select class="form-control po-item">${itemOptions()}</select></div>
        <div class="col"><input type="text" class="form-control po-desc" placeholder="Description"></div>
        <div class="col" style="max-width:110px;"><input type="number" class="form-control po-qty" step="0.01" placeholder="Qty"></div>
        <div class="col" style="max-width:130px;"><input type="number" class="form-control po-price" step="0.01" placeholder="Unit price"></div>
        <div class="col" style="max-width:44px;"><button type="button" class="btn btn-text" style="color:var(--danger)" onclick="this.closest('.po-line').remove()">✕</button></div>`;
    document.getElementById('po-lines').appendChild(div);
}

async function submitPurchaseOrder(event) {
    event.preventDefault();
    const items = [...document.querySelectorAll('#po-lines .po-line')].map((row) => ({
        inventoryId: row.querySelector('.po-item').value || null,
        description: row.querySelector('.po-desc').value.trim(),
        qty: Number(row.querySelector('.po-qty').value) || 0,
        unitPrice: Number(row.querySelector('.po-price').value) || 0,
    })).filter((i) => i.qty > 0);
    if (!items.length) return toast('Add at least one line with a quantity', 'error');

    try {
        const res = await authFetch(`${API_URL}/purchase-orders`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                supplierId: document.getElementById('po-supplier').value || null,
                orderDate: document.getElementById('po-date').value,
                expectedDate: document.getElementById('po-expected').value || null,
                notes: document.getElementById('po-notes').value.trim(),
                items,
            }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not save the order', 'error');
        closeModal('poModal');
        toast(`Purchase order ${d.poNo} raised`, 'success');
        procShowTab('orders');
    } catch (e) { toast(String(e), 'error'); }
}

// ---- goods receipt ----

async function openReceiveModal(poId) {
    try {
        const res = await authFetch(`${API_URL}/purchase-orders/${poId}`);
        const po = await res.json();
        if (!res.ok) return toast(po.error || 'Could not load the order', 'error');

        document.getElementById('grn-po-id').value = poId;
        document.getElementById('grn-supplier-id').value = po.SupplierID || '';
        document.getElementById('grn-date').value = new Date().toISOString().slice(0, 10);
        document.getElementById('grn-title-ref').textContent = `${po.PONo}${po.SupplierName ? ' — ' + po.SupplierName : ''}`;

        grnDraftLines = po.items
            .filter((i) => i.Qty > i.ReceivedQty)
            .map((i) => ({
                poItemId: i.POItemID, inventoryId: i.InventoryID,
                description: i.Description || i.ProductName || '',
                qty: Math.round((i.Qty - i.ReceivedQty) * 100) / 100, unitPrice: i.UnitPrice,
            }));
        grnDraftCosts = [];
        renderGrnDraft();
        openModal('grnModal');
    } catch (e) { toast(String(e), 'error'); }
}

function renderGrnDraft() {
    document.getElementById('grn-lines').innerHTML = grnDraftLines.map((l, idx) => `
        <div class="form-group row grn-line">
            <div class="col" style="flex:2;"><input type="text" class="form-control" value="${escAttr(l.description)}" readonly></div>
            <div class="col" style="max-width:120px;"><input type="number" class="form-control grn-qty" data-i="${idx}" step="0.01" value="${l.qty}"></div>
            <div class="col" style="max-width:140px;"><input type="number" class="form-control grn-price" data-i="${idx}" step="0.01" value="${l.unitPrice}"></div>
        </div>`).join('') || '<p class="analysis-note">Everything on this order has already been received.</p>';

    document.getElementById('grn-costs').innerHTML = grnDraftCosts.map((c, idx) => `
        <div class="form-group row grn-cost">
            <div class="col"><input type="text" class="form-control grn-cost-type" data-i="${idx}" value="${escAttr(c.costType)}"></div>
            <div class="col" style="max-width:140px;"><input type="number" class="form-control grn-cost-amt" data-i="${idx}" step="0.01" value="${c.amount}"></div>
            <div class="col" style="max-width:150px;">
                <select class="form-control grn-cost-alloc" data-i="${idx}">
                    <option value="value"${c.allocation === 'value' ? ' selected' : ''}>by value</option>
                    <option value="qty"${c.allocation === 'qty' ? ' selected' : ''}>by quantity</option>
                </select>
            </div>
            <div class="col" style="max-width:44px;"><button type="button" class="btn btn-text" style="color:var(--danger)" onclick="removeGrnCost(${idx})">✕</button></div>
        </div>`).join('');
    updateGrnPreview();
}

function addGrnCost() { grnDraftCosts.push({ costType: 'Freight', amount: 0, allocation: 'value' }); renderGrnDraft(); }
function removeGrnCost(i) { grnDraftCosts.splice(i, 1); renderGrnDraft(); }

function readGrnDraft() {
    document.querySelectorAll('.grn-qty').forEach((el) => { grnDraftLines[el.dataset.i].qty = Number(el.value) || 0; });
    document.querySelectorAll('.grn-price').forEach((el) => { grnDraftLines[el.dataset.i].unitPrice = Number(el.value) || 0; });
    document.querySelectorAll('.grn-cost-type').forEach((el) => { grnDraftCosts[el.dataset.i].costType = el.value; });
    document.querySelectorAll('.grn-cost-amt').forEach((el) => { grnDraftCosts[el.dataset.i].amount = Number(el.value) || 0; });
    document.querySelectorAll('.grn-cost-alloc').forEach((el) => { grnDraftCosts[el.dataset.i].allocation = el.value; });
}

// Show what the goods will actually be valued at before anything is committed.
function updateGrnPreview() {
    readGrnDraft();
    const goods = grnDraftLines.reduce((a, l) => a + l.qty * l.unitPrice, 0);
    const extra = grnDraftCosts.reduce((a, c) => a + c.amount, 0);
    const uplift = goods > 0 ? ((extra / goods) * 100).toFixed(1) : '0.0';
    document.getElementById('grn-preview').innerHTML =
        `Goods <strong>${formatCurrency(goods)}</strong> + freight/duty <strong>${formatCurrency(extra)}</strong>
         = landed <strong>${formatCurrency(goods + extra)}</strong> <span class="step-hint">(${uplift}% uplift on cost)</span>`;
}

async function submitGoodsReceipt(event) {
    event.preventDefault();
    readGrnDraft();
    const items = grnDraftLines.filter((l) => l.qty > 0);
    if (!items.length) return toast('Nothing to receive', 'error');
    try {
        const res = await authFetch(`${API_URL}/goods-receipts`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                poId: document.getElementById('grn-po-id').value || null,
                supplierId: document.getElementById('grn-supplier-id').value || null,
                receiptDate: document.getElementById('grn-date').value,
                notes: document.getElementById('grn-notes').value.trim(),
                items,
                landedCosts: grnDraftCosts.filter((c) => c.amount > 0),
            }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not post the receipt', 'error');
        closeModal('grnModal');
        toast(`Received as ${d.grnNo} — stock valued at ${formatCurrency(d.allocation.totalLanded)}`, 'success');
        procShowTab('receipts');
    } catch (e) { toast(String(e), 'error'); }
}

// ---- bill from a receipt ----

async function viewGoodsReceipt(grnId) {
    try {
        const res = await authFetch(`${API_URL}/goods-receipts/${grnId}`);
        const g = await res.json();
        if (!res.ok) return toast(g.error || 'Could not load the receipt', 'error');
        const goods = g.items.reduce((a, i) => a + i.Qty * i.UnitPrice, 0);
        const extra = g.landedCosts.reduce((a, c) => a + c.Amount, 0);

        document.getElementById('glDetailTitle').textContent = `${g.GRNNo} — ${g.SupplierName || 'direct receipt'}`;
        document.getElementById('glDetailBody').innerHTML = `
            <p class="analysis-note">Received ${formatDate(g.ReceiptDate)}${g.PONo ? ` against ${escAttr(g.PONo)}` : ''}</p>
            <table class="table">
                <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Landed unit cost</th><th class="num">Value</th></tr></thead>
                <tbody>${g.items.map((i) => `
                    <tr>
                        <td>${escAttr(i.Description || i.ProductName || '')}</td>
                        <td class="num">${i.Qty}</td>
                        <td class="num">${formatCurrency(i.UnitPrice)}</td>
                        <td class="num pos">${formatCurrency(i.LandedUnitCost)}</td>
                        <td class="num">${formatCurrency(i.Qty * i.LandedUnitCost)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
            ${g.landedCosts.length ? `
                <div class="analysis-sub">Landed costs spread over the receipt</div>
                <table class="table"><tbody>${g.landedCosts.map((c) => `
                    <tr><td>${escAttr(c.CostType)} <span class="step-hint">by ${escAttr(c.Allocation)}</span></td>
                        <td class="num">${formatCurrency(c.Amount)}</td></tr>`).join('')}
                    <tr class="analysis-total"><td><strong>Goods ${formatCurrency(goods)} + costs ${formatCurrency(extra)}</strong></td>
                        <td class="num"><strong>${formatCurrency(goods + extra)}</strong></td></tr>
                </tbody></table>` : ''}
            <div class="modal-actions">
                <button class="btn btn-primary admin-only" onclick="billFromReceipt(${grnId})">Enter the supplier's invoice</button>
            </div>`;
        openModal('glDetailModal');
    } catch (e) { toast(String(e), 'error'); }
}

async function billFromReceipt(grnId) {
    try {
        const g = await (await authFetch(`${API_URL}/goods-receipts/${grnId}`)).json();
        const res = await authFetch(`${API_URL}/purchase-bills`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                supplierId: g.SupplierID, grnId, billDate: new Date().toISOString().slice(0, 10),
                supplierBillNo: prompt("Supplier's invoice number (optional)") || null,
                items: g.items.map((i) => ({
                    grnItemId: i.GRNItemID, inventoryId: i.InventoryID,
                    description: i.Description, qty: i.Qty, unitPrice: i.UnitPrice,
                })),
            }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not record the bill', 'error');
        closeModal('glDetailModal');
        toast(`Bill ${d.billNo} recorded${d.variance ? ` (price variance ${formatCurrency(d.variance)})` : ''}`, 'success');
        procShowTab('bills');
    } catch (e) { toast(String(e), 'error'); }
}

async function viewPurchaseOrder(poId) {
    try {
        const po = await (await authFetch(`${API_URL}/purchase-orders/${poId}`)).json();
        document.getElementById('glDetailTitle').textContent = `${po.PONo} — ${po.SupplierName || 'no supplier'}`;
        document.getElementById('glDetailBody').innerHTML = `
            <p class="analysis-note">Ordered ${formatDate(po.OrderDate)}${po.ExpectedDate ? ` · expected ${formatDate(po.ExpectedDate)}` : ''} · ${escAttr(po.Status)}</p>
            <table class="table">
                <thead><tr><th>Item</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Billed</th><th>Match</th></tr></thead>
                <tbody>${po.match.map((m) => `
                    <tr>
                        <td>${escAttr(m.Description)}</td>
                        <td class="num">${m.Qty}</td>
                        <td class="num">${m.ReceivedQty}</td>
                        <td class="num">${m.BilledQty}</td>
                        <td><span class="badge ${m.match.matched ? 'badge-finalized' : 'badge-draft'}">${escAttr(m.match.status)}</span></td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
        openModal('glDetailModal');
    } catch (e) { toast(String(e), 'error'); }
}

// ---- supplier payment ----

function openSupplierPayModal(billId, outstanding, supplierId) {
    document.getElementById('sp-bill-id').value = billId;
    document.getElementById('sp-supplier-id').value = supplierId || '';
    document.getElementById('sp-amount').value = outstanding;
    document.getElementById('sp-date').value = new Date().toISOString().slice(0, 10);
    document.getElementById('sp-outstanding').textContent = formatCurrency(outstanding);
    openModal('supplierPayModal');
}

async function submitSupplierPayment(event) {
    event.preventDefault();
    try {
        const res = await authFetch(`${API_URL}/supplier-payments`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                billId: document.getElementById('sp-bill-id').value,
                supplierId: document.getElementById('sp-supplier-id').value || null,
                amount: Number(document.getElementById('sp-amount').value) || 0,
                paymentDate: document.getElementById('sp-date').value,
                method: document.getElementById('sp-method').value,
                notes: document.getElementById('sp-notes').value.trim(),
            }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not record the payment', 'error');
        closeModal('supplierPayModal');
        toast('Supplier payment recorded', 'success');
        procShowTab('bills');
    } catch (e) { toast(String(e), 'error'); }
}
