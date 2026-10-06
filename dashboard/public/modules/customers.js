/* ===== CUSTOMERS & MACHINES: the master data behind every job ===== */

let allCustomers = [];
let allMachines = [];

async function loadCustomersMasters() {
    showSkeleton('customers-tbody', 7, 4);
    try {
        const [cRes, mRes] = await Promise.all([
            authFetch(`${API_URL}/customers`),
            authFetch(`${API_URL}/machines`),
        ]);
        const customers = await cRes.json();
        const machines = await mRes.json();
        if (!cRes.ok) return toast(customers.error || 'Could not load customers', 'error');
        if (!mRes.ok) return toast(machines.error || 'Could not load machines', 'error');
        allCustomers = customers;
        allMachines = machines;
        renderCustomers();
        renderMachines();
    } catch (e) { console.error('Error loading masters', e); }
}

function custKindBadge(kind) {
    return kind === 'internal'
        ? '<span class="badge" style="background:#fef3c7;color:#b45309;">Internal</span>'
        : '<span class="badge" style="background:#dcfce7;color:#166534;">External</span>';
}

function renderCustomers() {
    const tb = document.getElementById('customers-tbody');
    tb.innerHTML = '';
    if (!allCustomers.length) {
        emptyRow('customers-tbody', 7, '👥', 'No customers yet', 'Add one, or run the migration to import them from invoice history.');
    } else {
        allCustomers.forEach((c) => {
            tb.innerHTML += `
                <tr${c.Active ? '' : ' style="opacity:.5;"'}>
                    <td><strong>${escAttr(c.Name)}</strong>${c.Active ? '' : ' <span class="badge badge-cancelled">Inactive</span>'}
                        ${c.Notes ? `<br><span style="font-size:11px;color:var(--text-muted);">${escAttr(c.Notes)}</span>` : ''}</td>
                    <td>${custKindBadge(c.Kind)}</td>
                    <td>${escAttr(c.Phone) || '<span class="flat">—</span>'}</td>
                    <td class="num">${c.Jobs || 0}</td>
                    <td class="num">${c.MachineCount || 0}</td>
                    <td class="num">${c.CreditLimit ? formatCurrency(c.CreditLimit) : '<span class="flat">—</span>'}</td>
                    <td>
                        <button class="btn btn-text" onclick="openCustomerModal(${c.CustomerID})">Edit</button>
                        <button class="btn btn-text" style="color:var(--danger)" onclick="deleteCustomer(${c.CustomerID})">Del</button>
                    </td>
                </tr>`;
        });
    }
    const ext = allCustomers.filter((c) => c.Kind === 'external' && c.Active).length;
    document.getElementById('cust-stat-external').textContent = ext;
    document.getElementById('cust-stat-machines').textContent = allMachines.length;
    const internalJobs = allCustomers.filter((c) => c.Kind === 'internal').reduce((a, c) => a + (c.Jobs || 0), 0);
    document.getElementById('cust-stat-internal-jobs').textContent = internalJobs;
    const extJobs = allCustomers.filter((c) => c.Kind === 'external').reduce((a, c) => a + (c.Jobs || 0), 0);
    document.getElementById('cust-stat-external-jobs').textContent = extJobs;
}

function renderMachines() {
    const tb = document.getElementById('machines-tbody');
    tb.innerHTML = '';
    if (!allMachines.length) {
        emptyRow('machines-tbody', 5, '🔧', 'No machines yet', 'Add the plant and equipment you service.');
        return;
    }
    let lastKind = null;
    allMachines.forEach((m) => {
        if (m.Kind !== lastKind) {
            lastKind = m.Kind;
            tb.innerHTML += `<tr><td colspan="5" style="background:var(--secondary);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);">${escAttr(m.Kind)}</td></tr>`;
        }
        tb.innerHTML += `
            <tr${m.Active ? '' : ' style="opacity:.5;"'}>
                <td><strong>${escAttr(m.Name)}</strong></td>
                <td>${escAttr(m.CustomerName) || '<span class="flat">—</span>'}</td>
                <td class="num">${m.Jobs || 0}</td>
                <td>${escAttr(m.Code) || '<span class="flat">—</span>'}</td>
                <td>
                    <button class="btn btn-text" onclick="openMachineModal(${m.MachineID})">Edit</button>
                    <button class="btn btn-text" style="color:var(--danger)" onclick="deleteMachine(${m.MachineID})">Del</button>
                </td>
            </tr>`;
    });
}

// ---- customer modal ----

function openCustomerModal(id) {
    const c = id ? allCustomers.find((x) => x.CustomerID === id) : null;
    document.getElementById('customerModalTitle').textContent = c ? 'Edit Customer' : 'Add Customer';
    document.getElementById('cust-id').value = c ? c.CustomerID : '';
    document.getElementById('cust-name').value = c ? c.Name : '';
    document.getElementById('cust-kind').value = c ? c.Kind : 'external';
    document.getElementById('cust-phone').value = (c && c.Phone) || '';
    document.getElementById('cust-email').value = (c && c.Email) || '';
    document.getElementById('cust-address').value = (c && c.Address) || '';
    document.getElementById('cust-tin').value = (c && c.TIN) || '';
    document.getElementById('cust-credit').value = (c && c.CreditLimit) || 0;
    document.getElementById('cust-terms').value = (c && c.PaymentTermsDays) || 0;
    openModal('customerModal');
}

async function submitCustomer(event) {
    event.preventDefault();
    const id = document.getElementById('cust-id').value;
    const payload = {
        name: document.getElementById('cust-name').value.trim(),
        kind: document.getElementById('cust-kind').value,
        phone: document.getElementById('cust-phone').value.trim(),
        email: document.getElementById('cust-email').value.trim(),
        address: document.getElementById('cust-address').value.trim(),
        tin: document.getElementById('cust-tin').value.trim(),
        creditLimit: Number(document.getElementById('cust-credit').value) || 0,
        paymentTermsDays: Number(document.getElementById('cust-terms').value) || 0,
    };
    try {
        const res = await authFetch(`${API_URL}/customers${id ? '/' + id : ''}`, {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) return toast(data.error || 'Could not save customer', 'error');
        closeModal('customerModal');
        toast(id ? 'Customer updated' : 'Customer added', 'success');
        loadCustomersMasters();
    } catch (e) { toast(String(e), 'error'); }
}

async function deleteCustomer(id) {
    const c = allCustomers.find((x) => x.CustomerID === id);
    if (!c) return;
    const msg = c.Jobs
        ? `${c.Name} has ${c.Jobs} invoice(s), so it will be deactivated rather than deleted. Continue?`
        : `Delete ${c.Name}?`;
    if (!confirm(msg)) return;
    try {
        const res = await authFetch(`${API_URL}/customers/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) return toast(data.error || 'Could not remove customer', 'error');
        toast(data.deactivated ? 'Customer deactivated' : 'Customer deleted', 'success');
        loadCustomersMasters();
    } catch (e) { toast(String(e), 'error'); }
}

// ---- machine modal ----

function openMachineModal(id) {
    const m = id ? allMachines.find((x) => x.MachineID === id) : null;
    document.getElementById('machineModalTitle').textContent = m ? 'Edit Machine' : 'Add Machine';
    document.getElementById('mach-id').value = m ? m.MachineID : '';
    document.getElementById('mach-name').value = m ? m.Name : '';
    document.getElementById('mach-code').value = (m && m.Code) || '';
    document.getElementById('mach-kind').value = m ? m.Kind : 'registration';
    document.getElementById('mach-notes').value = (m && m.Notes) || '';

    const sel = document.getElementById('mach-customer');
    sel.innerHTML = '<option value="">— none —</option>' + allCustomers
        .map((c) => `<option value="${c.CustomerID}">${escAttr(c.Name)}</option>`).join('');
    sel.value = m && m.CustomerID ? String(m.CustomerID) : '';
    openModal('machineModal');
}

async function submitMachine(event) {
    event.preventDefault();
    const id = document.getElementById('mach-id').value;
    const customerId = document.getElementById('mach-customer').value;
    const payload = {
        name: document.getElementById('mach-name').value.trim(),
        code: document.getElementById('mach-code').value.trim(),
        kind: document.getElementById('mach-kind').value,
        customerId: customerId ? Number(customerId) : null,
        notes: document.getElementById('mach-notes').value.trim(),
    };
    try {
        const res = await authFetch(`${API_URL}/machines${id ? '/' + id : ''}`, {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) return toast(data.error || 'Could not save machine', 'error');
        closeModal('machineModal');
        toast(id ? 'Machine updated' : 'Machine added', 'success');
        loadCustomersMasters();
    } catch (e) { toast(String(e), 'error'); }
}

async function deleteMachine(id) {
    const m = allMachines.find((x) => x.MachineID === id);
    if (!m) return;
    const msg = m.Jobs
        ? `${m.Name} has ${m.Jobs} job(s), so it will be deactivated rather than deleted. Continue?`
        : `Delete ${m.Name}?`;
    if (!confirm(msg)) return;
    try {
        const res = await authFetch(`${API_URL}/machines/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) return toast(data.error || 'Could not remove machine', 'error');
        toast(data.deactivated ? 'Machine deactivated' : 'Machine deleted', 'success');
        loadCustomersMasters();
    } catch (e) { toast(String(e), 'error'); }
}
