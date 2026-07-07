// Base API URL
const API_URL = 'http://localhost:9999/api';

// State
let invoiceItems = [];
let nextItemId = 1;
let isInvoiceEditable = true;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    loadDashboard();
    
    // Set default dates
    const today = new Date().toISOString().split('T')[0];
    const invDateInput = document.getElementById('invDate');
    if (invDateInput) {
        invDateInput.value = today;
        invDateInput.addEventListener('change', fetchNextInvoiceNo);
    }

    // Auto-generate unique ID
    const nameInput = document.getElementById('prod-name');
    const sizeInput = document.getElementById('prod-size');
    if (nameInput) nameInput.addEventListener('input', generateUniqueId);
    if (sizeInput) sizeInput.addEventListener('input', generateUniqueId);
});

function generateUniqueId() {
    const isEdit = document.getElementById('prod-id').value;
    if (isEdit) return; // Don't auto-generate if editing existing
    
    const name = document.getElementById('prod-name').value.trim().toUpperCase();
    const size = document.getElementById('prod-size').value.trim().toUpperCase();
    
    let uniqueId = name.replace(/[^A-Z0-9]/g, '-');
    if (size) {
        uniqueId += '-' + size.replace(/[^A-Z0-9]/g, '-');
    }
    uniqueId = uniqueId.replace(/-+/g, '-').replace(/^-|-$/g, '');
    
    document.getElementById('prod-unique').value = uniqueId;
}

// Navigation
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const target = e.currentTarget.dataset.target;
            showSection(target);
            
            navItems.forEach(nav => nav.classList.remove('active'));
            e.currentTarget.classList.add('active');
        });
    });
}

function showSection(sectionId) {
    document.querySelectorAll('.page-section').forEach(sec => sec.classList.remove('active'));
    document.getElementById(sectionId).classList.add('active');
    
    const titles = {
        'dashboard': 'Dashboard',
        'inventory': 'Inventory Management',
        'new-invoice': 'Invoice Document',
        'history': 'Invoice History',
        'transactions': 'Stock Movements',
        'export-invoices': 'Export Invoices',
        'cost-analysis': 'Cost Analysis',
        'invoice-comparison': 'Invoice Comparison'
    };
    document.getElementById('page-title').textContent = titles[sectionId];
    
    // Load section data
    if (sectionId === 'dashboard') loadDashboard();
    else if (sectionId === 'inventory') loadInventory();
    else if (sectionId === 'history') loadHistory();
    else if (sectionId === 'transactions') loadTransactions();
    else if (sectionId === 'export-invoices') loadExportStats();
    else if (sectionId === 'cost-analysis') loadCostAnalysis();
    else if (sectionId === 'invoice-comparison') loadInvoiceComparisonList();
}

// Helpers
const formatCurrency = (num) => 'Rs. ' + parseFloat(num || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatDate = (dateString) => dateString ? new Date(dateString).toLocaleDateString() : '';

function setInvoiceEditable(editable) {
    isInvoiceEditable = editable;
    
    // 1. refInvoice
    const refInvoice = document.getElementById('refInvoice');
    if (refInvoice) refInvoice.contentEditable = editable ? "true" : "false";

    // 2. Date input
    const invDate = document.getElementById('invDate');
    if (invDate) invDate.disabled = !editable;

    // 3. Client details
    const billedToName = document.getElementById('billedToName');
    if (billedToName) billedToName.disabled = !editable;
    const billedToAddress = document.getElementById('billedToAddress');
    if (billedToAddress) billedToAddress.disabled = !editable;

    // 4. Tax rates inputs
    const invSsclRate = document.getElementById('invSsclRate');
    if (invSsclRate) invSsclRate.disabled = !editable;
    const invVatRate = document.getElementById('invVatRate');
    if (invVatRate) invVatRate.disabled = !editable;

    // 5. Notes & Payment terms
    const invNotes = document.getElementById('invNotes');
    if (invNotes) invNotes.contentEditable = editable ? "true" : "false";
    const invPaymentTerms = document.getElementById('invPaymentTerms');
    if (invPaymentTerms) invPaymentTerms.contentEditable = editable ? "true" : "false";
}

// ----------------------------------------------------
// Dashboard
// ----------------------------------------------------
async function loadDashboard() {
    try {
        const res = await fetch(`${API_URL}/dashboard`);
        const data = await res.json();
        
        document.getElementById('stat-products').textContent = data.stats.totalInventory;
        document.getElementById('stat-qty').textContent = data.stats.totalQty;
        document.getElementById('stat-low-stock').textContent = data.stats.lowStock;
        
        const invTbody = document.getElementById('recent-invoices-tbody');
        invTbody.innerHTML = '';
        data.recentInvoices.forEach(inv => {
            invTbody.innerHTML += `
                <tr>
                    <td>${inv.InvoiceNo}</td>
                    <td>${formatDate(inv.FinalizedAt)}</td>
                    <td>${inv.BilledToName}</td>
                    <td>${formatCurrency(inv.GrandTotal)}</td>
                </tr>
            `;
        });
        
        const movTbody = document.getElementById('recent-movements-tbody');
        movTbody.innerHTML = '';
        data.movements.forEach(m => {
            const isOut = m.MovementType === 'OUT';
            movTbody.innerHTML += `
                <tr>
                    <td>${formatDate(m.MovementDate)}</td>
                    <td>${m.ProductName}</td>
                    <td><span class="badge ${isOut ? 'badge-low' : 'badge-finalized'}">${m.MovementType}</span></td>
                    <td>${m.QtyChange}</td>
                    <td>${m.NewQty}</td>
                </tr>
            `;
        });
        
    } catch (e) {
        console.error('Error loading dashboard', e);
    }
}

// ----------------------------------------------------
// Inventory
// ----------------------------------------------------
let allInventory = [];

async function loadInventory() {
    try {
        const res = await fetch(`${API_URL}/inventory`);
        allInventory = await res.json();
        renderInventory(allInventory);
    } catch (e) {
        console.error('Error loading inventory', e);
    }
}

function renderInventory(items) {
    const tbody = document.getElementById('inventory-tbody');
    tbody.innerHTML = '';
    items.forEach(item => {
        tbody.innerHTML += `
            <tr>
                <td>${item.UniqueID}</td>
                <td><strong>${item.ProductName}</strong></td>
                <td>${item.SpecificationCode}</td>
                <td>${item.Size || '-'}</td>
                <td>${item.Length}</td>
                <td><span class="badge ${item.Qty <= 5 ? 'badge-low' : 'badge-ok'}">${item.Qty}</span></td>
                <td>${item.Unit}</td>
                <td>${formatCurrency(item.Price || 0)}</td>
                <td>
                    <button class="btn btn-text" onclick="editProduct(${item.InventoryID})">Edit</button>
                    <button class="btn btn-text text-danger" style="color:red" onclick="deleteProduct(${item.InventoryID})">Del</button>
                </td>
            </tr>
        `;
    });
}

function searchInventory() {
    const q = document.getElementById('inventorySearch').value.toLowerCase();
    const filtered = allInventory.filter(i => 
        i.UniqueID.toLowerCase().includes(q) || 
        i.ProductName.toLowerCase().includes(q) || 
        i.SpecificationCode.toLowerCase().includes(q)
    );
    renderInventory(filtered);
}

function editProduct(id) {
    const p = allInventory.find(i => i.InventoryID === id);
    if (!p) return;
    document.getElementById('prod-id').value = p.InventoryID;
    document.getElementById('prod-unique').value = p.UniqueID;
    document.getElementById('prod-unique').disabled = true; // Can't edit unique ID
    document.getElementById('prod-name').value = p.ProductName;
    document.getElementById('prod-spec').value = p.SpecificationCode;
    document.getElementById('prod-size').value = p.Size || '';
    document.getElementById('prod-desc').value = p.Description || '';
    document.getElementById('prod-length').value = p.Length;
    document.getElementById('prod-qty').value = p.Qty;
    document.getElementById('prod-unit').value = p.Unit;
    document.getElementById('prod-price').value = p.Price || 0;
    
    document.getElementById('addProductTitle').textContent = 'Edit Product';
    openModal('addProductModal');
}

async function submitAddProduct(e) {
    e.preventDefault();
    const id = document.getElementById('prod-id').value;
    const payload = {
        uniqueId: document.getElementById('prod-unique').value,
        productName: document.getElementById('prod-name').value,
        specificationCode: document.getElementById('prod-spec').value,
        size: document.getElementById('prod-size').value,
        description: document.getElementById('prod-desc').value,
        length: document.getElementById('prod-length').value,
        qty: document.getElementById('prod-qty').value,
        unit: document.getElementById('prod-unit').value,
        price: document.getElementById('prod-price').value
    };
    
    const url = id ? `${API_URL}/inventory/${id}` : `${API_URL}/inventory`;
    const method = id ? 'PUT' : 'POST';
    
    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.error) alert(data.error);
        else {
            closeModal('addProductModal');
            loadInventory();
            e.target.reset();
            document.getElementById('prod-id').value = '';
            document.getElementById('prod-unique').disabled = false;
        }
    } catch(err) { alert(err); }
}

async function deleteProduct(id) {
    if (!confirm('Are you sure you want to delete this product?')) return;
    try {
        const res = await fetch(`${API_URL}/inventory/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.error) alert(data.error);
        else loadInventory();
    } catch(err) { alert(err); }
}

// ----------------------------------------------------
// Modals
// ----------------------------------------------------
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ----------------------------------------------------
// New Invoice
// ----------------------------------------------------
function getNextRef() {
    return 'AUTO';
}

function commitRef() {
    // Backend handles the REF numbering now, no need to store in localStorage
}

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
        const res = await fetch(`${API_URL}/invoices/next-no?date=${encodeURIComponent(dateVal)}`);
        const data = await res.json();
        if (data.nextInvoiceNo) {
            refElem.textContent = data.nextInvoiceNo;
        } else {
            refElem.textContent = 'AUTO';
        }
    } catch (e) {
        console.error('Error fetching next invoice number:', e);
        refElem.textContent = 'AUTO';
    }
}

async function startNewInvoice() {
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
    
    invoiceItems = [];
    renderInvoiceItems();
    
    // Ensure all buttons are visible
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
        const res = await fetch(`${API_URL}/inventory/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        const tbody = document.getElementById('modal-inventory-tbody');
        tbody.innerHTML = '';
        data.forEach(item => {
            const escapedName = item.ProductName.replace(/'/g, "\\'");
            const escapedSpec = item.SpecificationCode.replace(/'/g, "\\'");
            const escapedUnit = item.Unit.replace(/'/g, "\\'");
            tbody.innerHTML += `
                <tr>
                    <td>${item.UniqueID}</td>
                    <td>${item.ProductName}</td>
                    <td>${item.SpecificationCode}</td>
                    <td>${item.Qty}</td>
                    <td>${formatCurrency(item.Price || 0)}</td>
                    <td><button class="btn btn-primary" onclick="addInventoryItemToInvoice(${item.InventoryID}, '${escapedName} - ${escapedSpec}', '${escapedUnit}', ${item.Length}, ${item.Qty}, ${item.Price || 0})">Add</button></td>
                </tr>
            `;
        });
    } catch(e) {}
}

function addInventoryItemToInvoice(invId, desc, unit, length, maxQty, price) {
    invoiceItems.push({
        id: nextItemId++,
        inventoryId: invId,
        desc: desc,
        unit: unit,
        length: length,
        qty: 1,
        rate: price,
        maxQty: maxQty
    });
    closeModal('selectInventoryModal');
    renderInvoiceItems();
}

function addCustomRow() {
    invoiceItems.push({
        id: nextItemId++,
        inventoryId: null,
        desc: '',
        unit: 'Nos',
        length: 0,
        qty: 1,
        rate: 0,
        maxQty: null
    });
    renderInvoiceItems();
}

function addStandardCharges() {
    if (!invoiceItems.find(it => it.desc === 'Technical charges')) {
        invoiceItems.push({
            id: nextItemId++,
            inventoryId: null,
            desc: 'Technical charges',
            unit: 'Nos',
            length: 0,
            qty: 1,
            rate: 1500,
            maxQty: null
        });
    }
    
    if (!invoiceItems.find(it => it.desc === 'Sundries cost')) {
        invoiceItems.push({
            id: nextItemId++,
            inventoryId: null,
            desc: 'Sundries cost',
            unit: 'Nos',
            length: 0,
            qty: 1,
            rate: 0,
            maxQty: null
        });
    }
    
    renderInvoiceItems();
}

function removeInvoiceItem(id) {
    invoiceItems = invoiceItems.filter(i => i.id !== id);
    renderInvoiceItems();
}

function updateInvoiceItem(id, field, value) {
    const it = invoiceItems.find(i => i.id === id);
    if (!it) return;
    if (field === 'qty' || field === 'rate' || field === 'length') value = parseFloat(value) || 0;
    it[field] = value;
    if (field === 'qty' || field === 'rate') calcInvoiceTotals();
}

function renderInvoiceItems() {
    const tbody = document.getElementById('invItemsBody');
    tbody.innerHTML = '';
    const editable = isInvoiceEditable;
    
    invoiceItems.forEach((it, idx) => {
        const amount = (it.qty || 0) * (it.rate || 0);
        tbody.innerHTML += `
            <tr class="item-row">
                <td class="idx">${String(idx + 1).padStart(2, '0')}</td>
                <td><input class="cell left" type="text" value="${it.desc}" oninput="updateInvoiceItem(${it.id}, 'desc', this.value)" ${editable ? '' : 'disabled'}></td>
                <td><input class="cell center" type="text" value="${it.unit}" oninput="updateInvoiceItem(${it.id}, 'unit', this.value)" ${editable ? '' : 'disabled'}></td>
                <td><input class="cell" type="number" value="${it.length}" min="0" step="0.01" oninput="updateInvoiceItem(${it.id}, 'length', this.value)" ${editable ? '' : 'disabled'}></td>
                <td>
                    <input class="cell" type="number" value="${it.qty}" min="0" step="0.01" oninput="updateInvoiceItem(${it.id}, 'qty', this.value)" ${editable ? '' : 'disabled'}>
                    ${it.maxQty !== null && editable ? `<div style="font-size:10px; color:gray">Max: ${it.maxQty}</div>` : ''}
                </td>
                <td><input class="cell" type="number" value="${it.rate}" min="0" step="0.01" oninput="updateInvoiceItem(${it.id}, 'rate', this.value)" ${editable ? '' : 'disabled'}></td>
                <td class="num row-amount">${amount.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td class="row-actions no-print">${editable ? `<button type="button" onclick="removeInvoiceItem(${it.id})" title="Delete">×</button>` : ''}</td>
            </tr>
        `;
    });
    
    const rowActionsElements = document.querySelectorAll('.row-actions');
    rowActionsElements.forEach(el => el.style.display = editable ? '' : 'none');
    
    calcInvoiceTotals();
}

function calcInvoiceTotals() {
    let subTotal = 0;
    let materialCost = 0;
    
    // Pass 1: Find material cost
    invoiceItems.forEach(it => {
        if (it.desc !== 'Sundries cost' && it.desc !== 'Technical charges') {
            materialCost += (it.qty || 0) * (it.rate || 0);
        }
    });

    // Auto-update Sundries cost and Technical charges
    const sundriesItem = invoiceItems.find(it => it.desc === 'Sundries cost');
    if (sundriesItem) {
        sundriesItem.rate = materialCost * 0.12;
    }
    
    const techItem = invoiceItems.find(it => it.desc === 'Technical charges');
    if (techItem) {
        techItem.rate = materialCost * 0.90;
    }

    // Pass 2: Calculate subTotal and update UI
    invoiceItems.forEach((it, idx) => {
        const amt = (it.qty || 0) * (it.rate || 0);
        subTotal += amt;
        const rowAmtTd = document.querySelectorAll('#invItemsBody .row-amount')[idx];
        if (rowAmtTd) rowAmtTd.textContent = amt.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        
        // Update the rate input field in case it was auto-calculated
        if (it.desc === 'Sundries cost' || it.desc === 'Technical charges') {
            const rateInput = document.querySelectorAll('#invItemsBody .item-row')[idx]?.querySelector('input[oninput*="rate"]');
            if (rateInput) rateInput.value = it.rate.toFixed(2);
        }
    });
    
    const ssclRate = parseFloat(document.getElementById('invSsclRate').value) || 0;
    const vatRate = parseFloat(document.getElementById('invVatRate').value) || 0;
    
    // Update print texts
    document.getElementById('invSsclRateText').textContent = ssclRate;
    document.getElementById('invVatRateText').textContent = vatRate;
    
    const ssclAmt = subTotal * (ssclRate / 100);
    const preVat = subTotal + ssclAmt;
    const vatAmt = preVat * (vatRate / 100);
    const grand = preVat + vatAmt;
    
    document.getElementById('invSubTotal').textContent = formatCurrency(subTotal);
    document.getElementById('invSscl').textContent = formatCurrency(ssclAmt);
    document.getElementById('invVat').textContent = formatCurrency(vatAmt);
    document.getElementById('invGrandTotal').textContent = formatCurrency(grand);
    
    return { subTotal, ssclRate, ssclAmt, vatRate, vatAmt, grand };
}

async function saveInvoice(status) {
    if (invoiceItems.length === 0) return alert('Add at least one item');
    
    const totals = calcInvoiceTotals();
    const payload = {
        invoiceNo: document.getElementById('refInvoice').textContent.trim(),
        invoiceDate: document.getElementById('invDate').value,
        poNo: document.getElementById('invPoNo') ? document.getElementById('invPoNo').value : '',
        poDate: document.getElementById('invPoDate') ? document.getElementById('invPoDate').value : '',
        deliveryDate: document.getElementById('invDeliveryDate') ? document.getElementById('invDeliveryDate').value : '',
        billedToName: document.getElementById('billedToName') ? document.getElementById('billedToName').value : '',
        billedToAddress: document.getElementById('billedToAddress') ? document.getElementById('billedToAddress').value : '',
        deliveredToName: document.getElementById('deliveredToName') ? document.getElementById('deliveredToName').value : '',
        deliveredToAddress: document.getElementById('deliveredToAddress') ? document.getElementById('deliveredToAddress').value : '',
        subTotal: totals.subTotal,
        ssclRate: totals.ssclRate,
        ssclAmount: totals.ssclAmt,
        vatRate: totals.vatRate,
        vatAmount: totals.vatAmt,
        grandTotal: totals.grand,
        items: invoiceItems.map(i => ({
            inventoryId: i.inventoryId,
            description: i.desc,
            unit: i.unit,
            length: i.length,
            qty: i.qty,
            rate: i.rate,
            amount: i.qty * i.rate
        }))
    };
    
    const endpoint = status === 'Draft' ? 'draft' : 'finalize';
    
    if (status === 'Finalized') {
        if (!confirm('Finalizing will deduct inventory stock permanently. Proceed?')) return;
        commitRef();
    }
    
    try {
        const res = await fetch(`${API_URL}/invoices/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.error) alert(data.error);
        else {
            if (data.invoiceNo) {
                document.getElementById('refInvoice').textContent = data.invoiceNo;
            }
            alert(`Invoice saved as ${status} (${data.invoiceNo})`);
            if (status === 'Draft') commitRef(); // Also commit ref if saved as draft so it's not reused
            loadDashboard();
            showSection('history');
        }
    } catch(err) { alert(err); }
}

// ----------------------------------------------------
// History
// ----------------------------------------------------
async function loadHistory() {
    try {
        const res = await fetch(`${API_URL}/invoices`);
        const data = await res.json();
        const tbody = document.getElementById('history-tbody');
        tbody.innerHTML = '';
        data.forEach(inv => {
            const isDraft = inv.Status === 'Draft';
            tbody.innerHTML += `
                <tr>
                    <td>${inv.InvoiceNo}</td>
                    <td>${formatDate(inv.InvoiceDate)}</td>
                    <td>${inv.BilledToName}</td>
                    <td>${formatCurrency(inv.GrandTotal)}</td>
                    <td><span class="badge ${isDraft ? 'badge-draft' : 'badge-finalized'}">${inv.Status}</span></td>
                    <td>
                        <button class="btn btn-secondary btn-text" onclick="viewInvoice(${inv.InvoiceID})">View</button>
                    </td>
                </tr>
            `;
        });
    } catch (e) {}
}

async function viewInvoice(id) {
    try {
        const res = await fetch(`${API_URL}/invoices/${id}`);
        const inv = await res.json();
        if (inv.error) return alert(inv.error);
        
        // Populate view
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
        
        invoiceItems = inv.items.map((it, idx) => ({
            id: idx + 1,
            inventoryId: it.InventoryID,
            desc: it.ItemDescription,
            unit: it.Unit,
            length: it.Length,
            qty: it.Qty,
            rate: it.Rate,
            maxQty: null
        }));
        
        setInvoiceEditable(inv.Status !== 'Finalized');
        
        renderInvoiceItems();
        
        if (inv.Status === 'Finalized') {
            document.getElementById('invoice-save-actions').style.display = 'flex'; // Keep wrapper visible for print button
            document.getElementById('btnSaveDraft').style.display = 'none';
            document.getElementById('btnFinalize').style.display = 'none';
            document.getElementById('addItemBtnContainer').style.display = 'none';
        } else {
            // Draft
            document.getElementById('invoice-save-actions').style.display = 'flex';
            document.getElementById('btnSaveDraft').style.display = 'inline-flex';
            document.getElementById('btnFinalize').style.display = 'inline-flex';
            document.getElementById('addItemBtnContainer').style.display = 'flex';
        }
        
        // Switch section
        showSection('new-invoice');
        document.getElementById('invoice-view-title').textContent = `Viewing Invoice: ${inv.InvoiceNo} (${inv.Status})`;
        
    } catch(e) { alert('Error loading invoice'); }
}

// ----------------------------------------------------
// Auto-scale Print
// ----------------------------------------------------
window.onbeforeprint = function() {
    const page = document.querySelector('.page');
    if (!page) return;
    
    page.style.height = 'auto';
    page.style.maxHeight = 'none';
    page.style.overflow = 'visible';
    
    const trueHeight = page.offsetHeight;
    const targetHeight = 1118; // Approx 296mm at 96dpi
    
    if (trueHeight > targetHeight) {
        // We use a slight buffer to be safe
        const scale = (targetHeight - 10) / trueHeight;
        page.style.zoom = scale;
    }
    
    // Do NOT set strict heights during print so the browser can map the zoomed content correctly
};

window.onafterprint = function() {
    const page = document.querySelector('.page');
    if (!page) return;
    page.style.height = '';
    page.style.maxHeight = '';
    page.style.overflow = '';
    page.style.zoom = '';
};

// ----------------------------------------------------
// Transactions
// ----------------------------------------------------
async function loadTransactions() {
    try {
        const res = await fetch(`${API_URL}/movements`);
        const data = await res.json();
        const tbody = document.getElementById('transactions-tbody');
        tbody.innerHTML = '';
        data.forEach(m => {
            const isOut = m.MovementType === 'OUT';
            tbody.innerHTML += `
                <tr>
                    <td>${formatDate(m.MovementDate)}</td>
                    <td>${m.InvoiceNo || '-'}</td>
                    <td><strong>${m.UniqueID || '-'}</strong></td>
                    <td>${m.SpecificationCode || '-'}</td>
                    <td>${m.ProductName}</td>
                    <td><span class="badge ${isOut ? 'badge-low' : 'badge-finalized'}">${m.MovementType}</span></td>
                    <td><strong style="color:${isOut ? 'red':'green'}">${m.QtyChange}</strong></td>
                    <td>${m.NewQty}</td>
                    <td>${m.Notes || ''}</td>
                </tr>
            `;
        });
    } catch (e) {}
}

// ----------------------------------------------------
// Import & Export
// ----------------------------------------------------
function exportInventory() {
    window.location.href = `${API_URL}/inventory/export`;
}

function exportAllInvoices() {
    window.location.href = `${API_URL}/invoices/export`;
}

async function loadExportStats() {
    try {
        const res = await fetch(`${API_URL}/invoices`);
        const data = await res.json();
        document.getElementById('export-count').textContent = data.length;
    } catch (e) {
        document.getElementById('export-count').textContent = '0';
    }
}

function exportCostComparison() {
    window.location.href = `${API_URL}/costs/export`;
}

async function loadCostAnalysis() {
    try {
        const res = await fetch(`${API_URL}/costs/compare`);
        const data = await res.json();
        
        const tbody = document.getElementById('cost-analysis-tbody');
        tbody.innerHTML = '';
        
        let totalMatched = 0;
        let sumSavingsPct = 0;
        let maxSavingsPct = 0;
        
        data.forEach(row => {
            const formattedOurMeter = row.matched ? formatCurrency(row.ourPriceMeter) : 'N/A';
            const formattedOurFoot = row.matched ? formatCurrency(row.ourPriceFoot) : 'N/A';
            const formattedDiff = row.matched ? formatCurrency(row.diffFoot) : 'N/A';
            const formattedSavingsPct = row.matched ? row.savingsPct.toFixed(1) + '%' : 'N/A';
            const badgeClass = row.matched ? 'badge-finalized' : 'badge-low';
            const badgeText = row.matched ? 'Matched' : 'Not Matched';
            
            if (row.matched) {
                totalMatched++;
                sumSavingsPct += row.savingsPct;
                if (row.savingsPct > maxSavingsPct) {
                    maxSavingsPct = row.savingsPct;
                }
            }
            
            tbody.innerHTML += `
                <tr>
                    <td><strong>${row.name}</strong></td>
                    <td class="num">${formattedOurMeter}</td>
                    <td class="num">${formattedOurFoot}</td>
                    <td class="num">${formatCurrency(row.outsideCost)}</td>
                    <td class="num" style="color: ${row.matched && row.diffFoot >= 0 ? 'green' : 'red'}; font-weight: 600;">
                        ${formattedDiff}
                    </td>
                    <td class="num" style="color: ${row.matched && row.savingsPct >= 0 ? 'green' : 'red'}; font-weight: 600;">
                        ${formattedSavingsPct}
                    </td>
                    <td><span class="badge ${badgeClass}">${badgeText}</span></td>
                </tr>
            `;
        });
        
        // Update dashboard statistics
        const avgSavingsPct = totalMatched > 0 ? (sumSavingsPct / totalMatched) : 0;
        document.getElementById('cost-stat-count').textContent = `${totalMatched} / ${data.length}`;
        document.getElementById('cost-stat-avg').textContent = `${avgSavingsPct.toFixed(1)}%`;
        document.getElementById('cost-stat-max').textContent = `${maxSavingsPct.toFixed(1)}%`;
        
    } catch (e) {
        console.error('Error loading cost analysis', e);
    }
}

function exportInvoiceComparison(invoiceId) {
    window.location.href = `${API_URL}/invoices/${invoiceId}/compare-export`;
}

async function loadInvoiceComparisonList() {
    try {
        const res = await fetch(`${API_URL}/invoices`);
        const data = await res.json();
        
        // Hide details panel and show placeholder initially
        document.getElementById('compare-details-placeholder').style.display = 'flex';
        document.getElementById('compare-details-panel').style.display = 'none';
        
        const tbody = document.getElementById('compare-invoices-list-tbody');
        tbody.innerHTML = '';
        
        // Filter only finalized invoices for comparison
        const finalizedInvoices = data.filter(inv => inv.Status === 'Finalized');
        
        if (finalizedInvoices.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:gray;padding:20px;">No finalized invoices found</td></tr>';
            return;
        }
        
        finalizedInvoices.forEach(inv => {
            tbody.innerHTML += `
                <tr>
                    <td><strong>${inv.InvoiceNo}</strong><br><span style="font-size:11px;color:gray;">${formatDate(inv.InvoiceDate)}</span></td>
                    <td>${inv.BilledToName || 'Walk-in'}</td>
                    <td>
                        <button class="btn btn-secondary btn-text" onclick="compareInvoice(${inv.InvoiceID})">Compare</button>
                    </td>
                </tr>
            `;
        });
    } catch (e) {
        console.error('Error loading comparison list', e);
    }
}

async function compareInvoice(id) {
    try {
        const res = await fetch(`${API_URL}/invoices/${id}/compare`);
        const data = await res.json();
        if (data.error) return alert(data.error);
        
        // Hide placeholder and show details panel
        document.getElementById('compare-details-placeholder').style.display = 'none';
        document.getElementById('compare-details-panel').style.display = 'flex';
        
        // Header
        document.getElementById('compare-inv-no').textContent = `Invoice: ${data.invoiceNo}`;
        document.getElementById('compare-inv-meta').textContent = `Customer: ${data.billedToName || 'Walk-in'} | Date: ${formatDate(data.invoiceDate)}`;
        
        // Export button setup
        const exportBtn = document.getElementById('btnExportSingleCompare');
        exportBtn.setAttribute('onclick', `exportInvoiceComparison(${id})`);
        
        // KPI metrics
        document.getElementById('compare-stat-our').textContent = formatCurrency(data.taxes.ourGrandTotal);
        document.getElementById('compare-stat-outside').textContent = formatCurrency(data.taxes.outsideGrandTotal);
        document.getElementById('compare-stat-savings').textContent = formatCurrency(data.taxes.netSavings);
        
        // Tax summary table
        document.getElementById('compare-tax-sub-our').textContent = formatCurrency(data.taxes.ourSubtotal);
        document.getElementById('compare-tax-sub-out').textContent = formatCurrency(data.taxes.outsideSubtotal);
        document.getElementById('compare-tax-sub-save').textContent = formatCurrency(data.taxes.outsideSubtotal - data.taxes.ourSubtotal);
        
        document.getElementById('compare-tax-sscl-our').textContent = formatCurrency(data.taxes.ourSscl);
        document.getElementById('compare-tax-sscl-out').textContent = formatCurrency(data.taxes.outsideSscl);
        document.getElementById('compare-tax-sscl-save').textContent = formatCurrency(data.taxes.outsideSscl - data.taxes.ourSscl);
        
        document.getElementById('compare-tax-vat-our').textContent = formatCurrency(data.taxes.ourVat);
        document.getElementById('compare-tax-vat-out').textContent = formatCurrency(data.taxes.outsideVat);
        document.getElementById('compare-tax-vat-save').textContent = formatCurrency(data.taxes.outsideVat - data.taxes.ourVat);
        
        document.getElementById('compare-tax-grand-our').textContent = formatCurrency(data.taxes.ourGrandTotal);
        document.getElementById('compare-tax-grand-out').textContent = formatCurrency(data.taxes.outsideGrandTotal);
        document.getElementById('compare-tax-grand-save').textContent = formatCurrency(data.taxes.netSavings);
        
        // Itemized comparison details
        const itemsTbody = document.getElementById('compare-items-tbody');
        itemsTbody.innerHTML = '';
        
        data.items.forEach(it => {
            const formattedOurRate = formatCurrency(it.ourRate);
            const formattedOurAmt = formatCurrency(it.ourAmount);
            const formattedOutRate = formatCurrency(it.outsideRate);
            const formattedOutAmt = formatCurrency(it.outsideAmount);
            const savings = it.outsideAmount - it.ourAmount;
            const formattedSavings = formatCurrency(savings);
            
            itemsTbody.innerHTML += `
                <tr>
                    <td><strong>${it.description}</strong></td>
                    <td class="num">${it.qty} ${it.unit}</td>
                    <td class="num">${formattedOurRate}</td>
                    <td class="num">${formattedOurAmt}</td>
                    <td class="num">${it.outsideQty} ${it.outsideUnit}</td>
                    <td class="num">${formattedOutRate}</td>
                    <td class="num">${formattedOutAmt}</td>
                    <td class="num" style="color: ${savings >= 0 ? 'green' : 'red'}; font-weight: 600;">
                        ${formattedSavings}
                    </td>
                </tr>
            `;
        });
        
    } catch (e) {
        console.error('Error fetching invoice comparison', e);
        alert('Error fetching invoice comparison details');
    }
}

async function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    const btn = document.querySelector(`button[onclick="document.getElementById('importFile').click()"]`);
    try {
        if(btn) {
            btn.innerHTML = '<i class="ri-loader-4-line"></i> Importing...';
            btn.disabled = true;
        }

        const res = await fetch(`${API_URL}/inventory/import`, {
            method: 'POST',
            body: formData
        });

        if (res.ok) {
            const data = await res.json();
            alert(`Import successful! Added/Updated ${data.processed} items.`);
            loadInventory();
            loadDashboard();
        } else {
            const err = await res.text();
            alert(`Import failed: ${err}`);
        }
    } catch (e) {
        alert('Error during import.');
        console.error(e);
    } finally {
        if(btn) {
            btn.innerHTML = '<i class="ri-upload-2-line"></i> Import';
            btn.disabled = false;
        }
        event.target.value = '';
    }
}

function exportStockMovements() {
    window.location.href = `${API_URL}/movements/export`;
}
