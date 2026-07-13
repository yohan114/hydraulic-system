/* ===== PRICING MASTER: admin import + preview of the shipment-datasheet pricing (shared global scope) ===== */

let pricingPreviewRows = [];

async function loadPricingMaster() {
    try {
        const [statusRes, previewRes] = await Promise.all([
            authFetch(`${API_URL}/pricing/status`),
            authFetch(`${API_URL}/pricing/preview`),
        ]);
        const status = await statusRes.json();
        const preview = await previewRes.json();
        renderPricingStatus(status);
        pricingPreviewRows = (preview && preview.rows) || [];
        renderPricingPreview();
    } catch (e) { console.error('Error loading pricing master', e); }
}

function renderPricingStatus(s) {
    const counts = (s && s.counts) || {};
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('pm-count-hose', counts.hose || 0);
    setText('pm-count-fittings', counts.fittings || 0);
    setText('pm-count-crimping', counts.crimping || 0);

    const inv = (s && s.inventory) || {};
    setText('pm-inv-matched', inv.matched || 0);
    setText('pm-inv-unmatched', `${inv.unmatched || 0} unmatched`);

    const meta = (s && s.meta) || {};
    setText('pm-source', meta.source || 'EC_Shipment_HS25E1112W1_Datasheet.xlsx');
    setText('pm-imported', meta.importedAt ? formatDate(meta.importedAt) : 'never');
    setText('pm-invoice', meta.invoice || '—');

    const note = document.getElementById('pm-unmatched-note');
    if (note) {
        const items = inv.unmatchedItems || [];
        if (items.length) {
            note.style.display = '';
            note.innerHTML = `<strong style="color:#b45309;">⚠ ${inv.unmatched} inventory item(s) had no pricing-master match</strong> — they keep their existing cost/market. `
                + items.slice(0, 12).map((u) => `<span class="badge" style="background:#fef3c7;color:#92400e;">${escAttr(u.spec || u.name || ('#' + u.id))}</span>`).join(' ');
        } else {
            note.style.display = '';
            note.innerHTML = `<span style="color:#047857;">✓ Every inventory item matched the pricing master.</span>`;
        }
    }
}

function renderPricingPreview() {
    const tb = document.getElementById('pricing-preview-tbody');
    if (!tb) return;
    const q = (document.getElementById('pm-search').value || '').toLowerCase();
    const rows = pricingPreviewRows.filter((r) =>
        !q || String(r.label).toLowerCase().includes(q) || String(r.key).toLowerCase().includes(q));
    tb.innerHTML = '';
    if (!rows.length) { emptyRow('pricing-preview-tbody', 8, '🏷️', 'No pricing rows', 'Import the datasheet to populate the pricing master.'); return; }
    const groupColor = { Hose: '#2563eb', Fitting: '#8b5cf6', Crimping: '#10b981' };
    rows.forEach((r) => {
        const gc = groupColor[r.group] || '#64748b';
        tb.innerHTML += `
            <tr>
                <td><span class="badge" style="background:${gc}1a;color:${gc};font-weight:600;">${escAttr(r.group)}</span></td>
                <td>${escAttr(r.label)}</td>
                <td>${escAttr(r.size)}${r.unit === 'm' || r.group === 'Hose' ? '"' : ''}</td>
                <td>${escAttr(r.unit)}</td>
                <td class="num">${formatCurrency(r.ourCost)}</td>
                <td class="num">${formatCurrency(r.marketMid)}</td>
                <td class="num" style="color:#047857;font-weight:600;">${formatCurrency(r.suggested)}${r.floored ? ' <span style="color:#c2410c;font-size:10px;">(cost)</span>' : ''}</td>
                <td class="num" style="color:${r.marginPct >= 20 ? '#10b981' : (r.marginPct >= 0 ? '#f59e0b' : '#ef4444')};font-weight:600;">${r.marginPct}%</td>
            </tr>`;
    });
}

async function importPricingMaster(bundled) {
    const btn = document.getElementById('pm-import-btn');
    const fileInput = document.getElementById('pm-file');
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!bundled && !file) {
        toast('Choose an .xlsx file, or use “Re-import bundled”.', 'info');
        return;
    }
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ri-loader-4-line"></i> Importing…'; }
    try {
        let res;
        if (bundled || !file) {
            res = await authFetch(`${API_URL}/pricing/import`, { method: 'POST' });
        } else {
            const fd = new FormData();
            fd.append('file', file);
            res = await authFetch(`${API_URL}/pricing/import`, { method: 'POST', body: fd });
        }
        const data = await res.json();
        if (!res.ok || data.error) { toast(data.error || 'Import failed', 'error'); return; }
        toast(`Imported — ${data.counts.hose} hose, ${data.counts.fittings} fittings, ${data.counts.crimping} crimping. ${data.inventory.matched}/${data.inventory.total} inventory synced.`, 'success');
        if (fileInput) fileInput.value = '';
        invalidateCache('inventory', 'dashboard');
        loadPricingMaster();
    } catch (err) {
        toast(err.message || String(err), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
}
