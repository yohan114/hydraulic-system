/* ===== WORKSHOP: quotations, job cards and technician labour ===== */

let wsTab = 'jobs';
let wsCustomers = [];
let wsMachines = [];
let wsWorkers = [];
let wsItems = [];

function wsShowTab(tab) {
    wsTab = tab;
    ['jobs', 'quotes', 'labour'].forEach((t) => {
        document.getElementById(`ws-pane-${t}`).style.display = t === tab ? '' : 'none';
        const btn = document.getElementById(`ws-tab-${t}`);
        btn.classList.toggle('btn-primary', t === tab);
        btn.classList.toggle('btn-secondary', t !== tab);
    });
    loadWorkshop();
}

async function loadWorkshop() {
    try {
        if (!wsCustomers.length) {
            const [c, m, w, i] = await Promise.all([
                authFetch(`${API_URL}/customers`), authFetch(`${API_URL}/machines`),
                authFetch(`${API_URL}/workers`), authFetch(`${API_URL}/inventory`),
            ]);
            wsCustomers = await c.json(); wsMachines = await m.json();
            wsWorkers = await w.json(); wsItems = await i.json();
        }
        if (wsTab === 'jobs') renderJobs(await (await authFetch(`${API_URL}/jobs`)).json());
        else if (wsTab === 'quotes') renderQuotes(await (await authFetch(`${API_URL}/quotations`)).json());
        else renderLabourOwed(await (await authFetch(`${API_URL}/labour/owed`)).json());
    } catch (e) { console.error('Error loading workshop', e); }
}

const JOB_BADGE = {
    open: 'badge-draft', 'in-progress': 'badge-partial', 'waiting-parts': 'badge-low',
    completed: 'badge-finalized', invoiced: 'badge-paid', cancelled: 'badge-cancelled',
};

function renderJobs(rows) {
    const tb = document.getElementById('ws-jobs-tbody');
    tb.innerHTML = '';
    const open = rows.filter((j) => !['invoiced', 'cancelled'].includes(j.Status));
    document.getElementById('ws-stat-open').textContent = open.length;
    document.getElementById('ws-stat-urgent').textContent = open.filter((j) => j.Priority === 'urgent').length;
    document.getElementById('ws-stat-completed').textContent = rows.filter((j) => j.Status === 'completed').length;

    if (!rows.length) { emptyRow('ws-jobs-tbody', 8, '🔧', 'No job cards yet', 'Open one when a machine comes in.'); return; }
    rows.forEach((j) => {
        tb.innerHTML += `
            <tr${j.Priority === 'urgent' && j.Status !== 'invoiced' ? ' style="background:rgba(220,38,38,.06);"' : ''}>
                <td><strong>${escAttr(j.JobNo)}</strong>${j.Priority === 'urgent' ? ' <span class="badge badge-low">urgent</span>' : ''}</td>
                <td>${formatDate(j.ReceivedAt)}</td>
                <td>${escAttr(j.MachineName) || escAttr(j.CustomerName) || '<span class="flat">—</span>'}</td>
                <td>${escAttr(j.Description) || ''}</td>
                <td class="num">${formatCurrency(j.Total)}</td>
                <td class="num">${j.LabourCost ? formatCurrency(j.LabourCost) : '<span class="flat">—</span>'}</td>
                <td><span class="badge ${JOB_BADGE[j.Status] || 'badge-ok'}">${escAttr(j.Status)}</span>
                    ${j.InvoiceNo ? `<br><span style="font-size:11px;color:var(--text-muted);">${escAttr(j.InvoiceNo)}</span>` : ''}</td>
                <td><button class="btn btn-text" onclick="openJob(${j.JobID})">Open</button></td>
            </tr>`;
    });
}

function renderQuotes(rows) {
    const tb = document.getElementById('ws-quotes-tbody');
    tb.innerHTML = '';
    if (!rows.length) { emptyRow('ws-quotes-tbody', 7, '📝', 'No quotations yet', 'Quote a job before the work starts.'); return; }
    rows.forEach((q) => {
        tb.innerHTML += `
            <tr>
                <td><strong>${escAttr(q.QuoteNo)}</strong></td>
                <td>${formatDate(q.QuoteDate)}</td>
                <td>${escAttr(q.MachineName) || escAttr(q.CustomerName) || '<span class="flat">—</span>'}</td>
                <td class="num">${q.Lines}</td>
                <td class="num">${formatCurrency(q.Total)}</td>
                <td><span class="badge ${q.Status === 'accepted' ? 'badge-finalized' : 'badge-draft'}">${escAttr(q.Status)}</span>
                    ${q.JobNo ? `<br><span style="font-size:11px;color:var(--text-muted);">${escAttr(q.JobNo)}</span>` : ''}</td>
                <td>${q.JobNo ? '' : `<button class="btn btn-text" onclick="convertQuote(${q.QuoteID})">Start job</button>`}</td>
            </tr>`;
    });
}

function renderLabourOwed(d) {
    document.getElementById('ws-labour-total').innerHTML = `
        <div class="jp-foot-cell"><span class="k">Pieces of work unpaid</span><span class="v">${d.count}</span></div>
        <div class="jp-foot-cell jp-unpaid"><span class="k">Owed to technicians</span><span class="v">${formatCurrency(d.total)}</span></div>`;

    const wrap = document.getElementById('ws-labour-body');
    if (!d.workers.length) {
        wrap.innerHTML = '<p class="analysis-note" style="padding:20px;">Nothing outstanding — every piece of technician work has been paid.</p>';
        return;
    }
    wrap.innerHTML = d.workers.map((w) => `
        <div class="analysis-sub">${escAttr(w.workerName)} — ${formatCurrency(w.amount)}</div>
        <table class="table">
            <thead><tr><th>Job</th><th>Work</th><th class="num">Units</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
            <tbody>${w.items.map((i) => `
                <tr>
                    <td>${escAttr(i.JobNo)}</td>
                    <td>${escAttr(i.WorkType)}</td>
                    <td class="num">${i.Units} ${escAttr(i.UnitLabel)}</td>
                    <td class="num">${formatCurrency(i.Rate)}</td>
                    <td class="num">${formatCurrency(i.Amount)}</td>
                </tr>`).join('')}
            </tbody>
        </table>
        <div style="padding:0 0 16px;">
            <button class="btn btn-primary admin-only" onclick='payLabour(${JSON.stringify(w.items.map((i) => i.JobLabourID))}, ${w.workerId || 'null'}, ${w.amount})'>
                Pay ${escAttr(w.workerName)} ${formatCurrency(w.amount)}
            </button>
        </div>`).join('');
}

async function payLabour(ids, workerId, amount) {
    if (!confirm(`Pay ${formatCurrency(amount)} to the technician? This clears the accrued liability.`)) return;
    try {
        const res = await authFetch(`${API_URL}/labour/pay`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workerId, jobLabourIds: ids, paymentDate: new Date().toISOString().slice(0, 10), method: 'Cash' }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not record the payment', 'error');
        toast(`Paid ${formatCurrency(d.amount)}`, 'success');
        loadWorkshop();
    } catch (e) { toast(String(e), 'error'); }
}

async function convertQuote(quoteId) {
    try {
        const res = await authFetch(`${API_URL}/quotations/${quoteId}/convert`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not start the job', 'error');
        toast(`Job ${d.jobNo} opened`, 'success');
        wsShowTab('jobs');
    } catch (e) { toast(String(e), 'error'); }
}

// ---- job card entry ----

function wsSelect(list, idKey, nameKey, selected) {
    return '<option value="">— none —</option>' + list
        .map((x) => `<option value="${x[idKey]}"${String(selected) === String(x[idKey]) ? ' selected' : ''}>${escAttr(x[nameKey])}</option>`)
        .join('');
}

function openJobModal() {
    document.getElementById('job-id').value = '';
    document.getElementById('jobModalTitle').textContent = 'New Job Card';
    document.getElementById('job-received').value = new Date().toISOString().slice(0, 10);
    document.getElementById('job-promised').value = '';
    document.getElementById('job-desc').value = '';
    document.getElementById('job-spec').value = '';
    document.getElementById('job-priority').value = 'normal';
    document.getElementById('job-status-row').style.display = 'none';
    document.getElementById('job-customer').innerHTML = wsSelect(wsCustomers, 'CustomerID', 'Name');
    document.getElementById('job-machine').innerHTML = wsSelect(wsMachines, 'MachineID', 'Name');
    document.getElementById('job-lines').innerHTML = '';
    addJobLine();
    document.getElementById('job-labour-panel').style.display = 'none';
    openModal('jobModal');
}

function addJobLine(line = {}) {
    const div = document.createElement('div');
    div.className = 'form-group row job-line';
    div.innerHTML = `
        <div class="col" style="flex:2;"><select class="form-control job-item">${wsSelect(wsItems, 'InventoryID', 'ProductName', line.InventoryID)}</select></div>
        <div class="col"><input type="text" class="form-control job-desc-line" placeholder="Description" value="${escAttr(line.Description || '')}"></div>
        <div class="col" style="max-width:90px;"><input type="text" class="form-control job-unit" placeholder="Unit" value="${escAttr(line.Unit || '')}"></div>
        <div class="col" style="max-width:100px;"><input type="number" class="form-control job-qty" step="0.01" placeholder="Qty" value="${line.Qty != null ? line.Qty : ''}"></div>
        <div class="col" style="max-width:120px;"><input type="number" class="form-control job-rate" step="0.01" placeholder="Rate" value="${line.Rate != null ? line.Rate : ''}"></div>
        <div class="col" style="max-width:44px;"><button type="button" class="btn btn-text" style="color:var(--danger)" onclick="this.closest('.job-line').remove()">✕</button></div>`;
    document.getElementById('job-lines').appendChild(div);
}

function readJobLines() {
    return [...document.querySelectorAll('#job-lines .job-line')].map((row) => ({
        inventoryId: row.querySelector('.job-item').value || null,
        description: row.querySelector('.job-desc-line').value.trim(),
        unit: row.querySelector('.job-unit').value.trim(),
        qty: Number(row.querySelector('.job-qty').value) || 0,
        rate: Number(row.querySelector('.job-rate').value) || 0,
    })).filter((i) => i.qty > 0);
}

async function openJob(jobId) {
    try {
        const res = await authFetch(`${API_URL}/jobs/${jobId}`);
        const j = await res.json();
        if (!res.ok) return toast(j.error || 'Could not load the job', 'error');

        document.getElementById('job-id').value = jobId;
        document.getElementById('jobModalTitle').textContent = `${j.JobNo}${j.InvoiceNo ? ` — invoiced as ${j.InvoiceNo}` : ''}`;
        document.getElementById('job-received').value = String(j.ReceivedAt || '').slice(0, 10);
        document.getElementById('job-promised').value = String(j.PromisedAt || '').slice(0, 10);
        document.getElementById('job-desc').value = j.Description || '';
        document.getElementById('job-spec').value = j.HoseSpec || '';
        document.getElementById('job-priority').value = j.Priority || 'normal';
        document.getElementById('job-status-row').style.display = '';
        document.getElementById('job-status').value = j.Status;
        document.getElementById('job-customer').innerHTML = wsSelect(wsCustomers, 'CustomerID', 'Name', j.CustomerID);
        document.getElementById('job-machine').innerHTML = wsSelect(wsMachines, 'MachineID', 'Name', j.MachineID);

        document.getElementById('job-lines').innerHTML = '';
        (j.items.length ? j.items : [{}]).forEach(addJobLine);

        // Labour panel: what has been recorded, and a row to add more.
        const panel = document.getElementById('job-labour-panel');
        panel.style.display = '';
        document.getElementById('job-labour-list').innerHTML = j.labour.length
            ? `<table class="table"><thead><tr><th>Worker</th><th>Work</th><th class="num">Units</th><th class="num">Amount</th><th>Status</th></tr></thead>
               <tbody>${j.labour.map((l) => `
                 <tr><td>${escAttr(l.WorkerName) || '<span class="flat">unassigned</span>'}</td>
                     <td>${escAttr(l.WorkType)}</td>
                     <td class="num">${l.Units} ${escAttr(l.UnitLabel)}</td>
                     <td class="num">${formatCurrency(l.Amount)}</td>
                     <td>${l.LabourPaymentID ? '<span class="badge badge-paid">paid</span>' : '<span class="badge badge-unpaid">accrued</span>'}</td>
                 </tr>`).join('')}</tbody></table>`
            : '<p class="analysis-note">No technician work recorded yet.</p>';
        document.getElementById('job-worker').innerHTML = wsSelect(wsWorkers, 'WorkerID', 'Name');

        document.getElementById('job-invoice-btn').style.display = j.InvoiceID ? 'none' : '';
        openModal('jobModal');
    } catch (e) { toast(String(e), 'error'); }
}

async function submitJob(event) {
    event.preventDefault();
    const id = document.getElementById('job-id').value;
    const payload = {
        customerId: document.getElementById('job-customer').value || null,
        machineId: document.getElementById('job-machine').value || null,
        description: document.getElementById('job-desc').value.trim(),
        hoseSpec: document.getElementById('job-spec').value.trim(),
        priority: document.getElementById('job-priority').value,
        receivedAt: document.getElementById('job-received').value,
        promisedAt: document.getElementById('job-promised').value || null,
        items: readJobLines(),
    };
    if (id) payload.status = document.getElementById('job-status').value;

    try {
        const res = await authFetch(`${API_URL}/jobs${id ? '/' + id : ''}`, {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not save the job', 'error');
        toast(id ? 'Job updated' : `Job ${d.jobNo} opened`, 'success');
        if (!id) closeModal('jobModal'); else openJob(id);
        loadWorkshop();
    } catch (e) { toast(String(e), 'error'); }
}

async function addLabourToJob() {
    const jobId = document.getElementById('job-id').value;
    if (!jobId) return toast('Save the job card first', 'error');
    const units = Number(document.getElementById('job-labour-units').value) || 0;
    const rate = Number(document.getElementById('job-labour-rate').value) || 0;
    if (!(units > 0 && rate > 0)) return toast('Enter units and a rate', 'error');

    try {
        const res = await authFetch(`${API_URL}/jobs/${jobId}/labour`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                workerId: document.getElementById('job-worker').value || null,
                workType: document.getElementById('job-labour-type').value,
                units, rate, unitLabel: 'end',
            }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not record the labour', 'error');
        toast(`Accrued ${formatCurrency(d.amount)} to the technician`, 'success');
        document.getElementById('job-labour-units').value = '';
        openJob(jobId);
    } catch (e) { toast(String(e), 'error'); }
}

/** Build the invoice from the job, post it through the normal billing path. */
async function invoiceJob() {
    const jobId = document.getElementById('job-id').value;
    if (!jobId) return;
    try {
        const payloadRes = await authFetch(`${API_URL}/jobs/${jobId}/invoice-payload`);
        const p = await payloadRes.json();
        if (!payloadRes.ok) return toast(p.error || 'Could not prepare the invoice', 'error');
        if (!confirm(`Invoice ${p.jobNo} to ${p.billedToName}? Stock will be deducted.`)) return;

        const res = await authFetch(`${API_URL}/invoices/finalize`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                billedToName: p.billedToName, billedToAddress: p.billedToAddress,
                items: p.items, discount: 0,
            }),
        });
        const d = await res.json();
        if (!res.ok) return toast(d.error || 'Could not create the invoice', 'error');

        await authFetch(`${API_URL}/jobs/${jobId}/invoiced`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: d.invoiceId }),
        });
        closeModal('jobModal');
        toast(`Invoiced as ${d.invoiceNo}`, 'success');
        loadWorkshop();
    } catch (e) { toast(String(e), 'error'); }
}
