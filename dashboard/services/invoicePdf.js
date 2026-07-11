'use strict';

/**
 * Server-side invoice → print-ready HTML for headless-Chromium PDF rendering.
 *
 * This produces a self-contained A4 document (inline CSS, logo embedded as a
 * data URI) so puppeteer can render a real PDF without loading the SPA or any
 * external asset. The tax breakdown is recomputed with the same billing engine
 * the app uses (SubTotal → SSCL → VAT → Discount → RoundOff) so the PDF total
 * always matches the stored/printed bill.
 */

const fs = require('fs');
const path = require('path');
const billing = require('./billing');
const money = require('../lib/money');

const BUSINESS = {
  name: 'Edward and Christie',
  tagline: 'Hydraulic Hose Repair',
  address: 'No. 64/9, Nawala Road, Nugegoda, Sri Lanka',
  email: 'edchrist@sltnet.lk · reply.enc@gmail.com',
};

// Read the logo once and cache it as a data URI (best-effort; omitted if absent).
let _logoData = null;
function logoDataUri() {
  if (_logoData !== null) return _logoData;
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'public', 'logo.png'));
    _logoData = `data:image/png;base64,${buf.toString('base64')}`;
  } catch (_) {
    _logoData = '';
  }
  return _logoData;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmt(v) { return money.formatLKR(v); }
function fmtDate(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
}

/**
 * Build the full HTML document for one invoice.
 * @param {object} invoice invoice header row (as returned by GET /api/invoices/:id)
 * @param {Array<object>} items InvoiceItems rows (ItemDescription, Qty, Rate, Unit)
 * @returns {string}
 */
function buildInvoiceHtml(invoice, items) {
  const rows = (items || []).map((it) => ({
    desc: it.ItemDescription || it.ProductName || '',
    unit: it.Unit || '',
    qty: money.num(it.Qty),
    rate: money.num(it.Rate),
  }));

  const totals = billing.computeTotals({
    items: rows.map((r) => ({ qty: r.qty, rate: r.rate })),
    ssclRate: money.num(invoice.SSCLRate),
    vatRate: money.num(invoice.VATRate),
    discount: money.num(invoice.Discount),
    roundToRupee: Math.abs(money.num(invoice.RoundOff)) > 0,
  });

  const itemRows = rows.map((r, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(r.desc)}</td>
      <td class="c">${r.qty}${r.unit ? ' ' + esc(r.unit) : ''}</td>
      <td class="r">${fmt(r.rate)}</td>
      <td class="r">${fmt(money.round2(r.qty * r.rate))}</td>
    </tr>`).join('');

  const taxRow = (label, val) => `<tr><td>${label}</td><td class="r">${fmt(val)}</td></tr>`;
  const status = esc(invoice.Status || '');
  const logo = logoDataUri();

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(invoice.InvoiceNo || 'Invoice')}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; margin: 0; padding: 28px 34px; font-size: 12px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1e3a8a; padding-bottom: 14px; }
  .brand img { max-height: 46px; display: block; margin-bottom: 4px; }
  .brand .name { font-size: 18px; font-weight: 700; color: #1e3a8a; }
  .brand .tag { font-size: 11px; color: #6b7280; letter-spacing: .5px; }
  .doc { text-align: right; }
  .doc .title { font-size: 20px; font-weight: 700; letter-spacing: 1px; color: #1e3a8a; }
  .doc .ref { font-size: 12px; margin-top: 4px; }
  .doc .status { display:inline-block; margin-top:6px; font-size:10px; text-transform:uppercase; letter-spacing:.5px; padding:2px 8px; border-radius:10px; background:#e0e7ff; color:#3730a3; }
  .parties { display: flex; gap: 24px; margin: 18px 0; }
  .parties .box { flex: 1; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; }
  .parties h4 { margin: 0 0 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #6b7280; }
  .parties .v { font-weight: 600; }
  .meta { font-size: 11px; color: #6b7280; margin-bottom: 10px; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.items th { background: #1e3a8a; color: #fff; font-weight: 600; text-align: left; padding: 8px 10px; font-size: 11px; }
  table.items td { padding: 7px 10px; border-bottom: 1px solid #eef2f7; }
  table.items td.c, table.items th.c { text-align: center; }
  table.items td.r, table.items th.r { text-align: right; }
  .totals { width: 300px; margin-left: auto; margin-top: 14px; }
  .totals table { width: 100%; border-collapse: collapse; }
  .totals td { padding: 5px 10px; }
  .totals td.r { text-align: right; }
  .totals tr.grand td { border-top: 2px solid #1e3a8a; font-size: 15px; font-weight: 700; color: #1e3a8a; padding-top: 8px; }
  .foot { margin-top: 40px; display: flex; justify-content: space-between; align-items: flex-end; }
  .foot .contacts { font-size: 10px; color: #6b7280; line-height: 1.5; }
  .sign { text-align: center; font-size: 11px; color: #6b7280; }
  .sign .line { width: 180px; border-top: 1px solid #9ca3af; margin-bottom: 4px; }
  .notes { margin-top: 16px; font-size: 11px; color: #4b5563; }
</style></head><body>
  <div class="head">
    <div class="brand">
      ${logo ? `<img src="${logo}" alt="logo">` : ''}
      <div class="name">${esc(BUSINESS.name)}</div>
      <div class="tag">${esc(BUSINESS.tagline)}</div>
    </div>
    <div class="doc">
      <div class="title">INVOICE</div>
      <div class="ref">Ref: <strong>${esc(invoice.InvoiceNo || '')}</strong></div>
      <div class="ref">Date: ${fmtDate(invoice.InvoiceDate)}</div>
      ${status ? `<div class="status">${status}</div>` : ''}
    </div>
  </div>

  <div class="parties">
    <div class="box"><h4>Billed To</h4><div class="v">${esc(invoice.BilledToName || 'Walk-in Customer')}</div><div>${esc(invoice.BilledToAddress || '')}</div></div>
    ${invoice.DeliveredToName ? `<div class="box"><h4>Delivered To</h4><div class="v">${esc(invoice.DeliveredToName)}</div><div>${esc(invoice.DeliveredToAddress || '')}</div></div>` : ''}
  </div>

  <table class="items">
    <thead><tr><th class="c">#</th><th>Description</th><th class="c">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
    <tbody>${itemRows || '<tr><td colspan="5" class="c">No items</td></tr>'}</tbody>
  </table>

  <div class="totals"><table>
    ${taxRow('Sub Total', totals.subTotal)}
    ${totals.ssclAmount ? taxRow(`SSCL (${totals.ssclRate}%)`, totals.ssclAmount) : ''}
    ${totals.vatAmount ? taxRow(`VAT (${totals.vatRate}%)`, totals.vatAmount) : ''}
    ${totals.discount ? taxRow('Discount', -totals.discount) : ''}
    ${totals.roundOff ? taxRow('Round Off', totals.roundOff) : ''}
    <tr class="grand"><td>Grand Total</td><td class="r">${fmt(totals.grandTotal)}</td></tr>
  </table></div>

  ${invoice.Notes ? `<div class="notes"><strong>Notes:</strong> ${esc(invoice.Notes)}</div>` : ''}

  <div class="foot">
    <div class="contacts">${esc(BUSINESS.address)}<br>${esc(BUSINESS.email)}</div>
    <div class="sign"><div class="line"></div>Authorised Signature</div>
  </div>
</body></html>`;
}

module.exports = { buildInvoiceHtml, BUSINESS };
