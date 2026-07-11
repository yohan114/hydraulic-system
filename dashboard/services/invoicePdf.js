'use strict';

/**
 * Server-side invoice → print-ready HTML for headless-Chromium PDF rendering.
 *
 * Self-contained A4 document (inline CSS, logo + signature embedded as data
 * URIs) styled to match the app's printed bill: dark header strip, full dark
 * footer (brand / phone / email / location + VAT REG) and an e-signature block.
 * The tax breakdown is recomputed with the billing engine so the total always
 * matches the stored bill (legacy tax invoices keep their SSCL/VAT).
 *
 * Supports two views (display only — nothing is read from or written to the DB
 * differently): `inside` (full internal copy, default) and `outside` (simplified
 * customer copy — part numbers/spec codes replaced with friendly descriptions).
 */

const fs = require('fs');
const path = require('path');
const billing = require('./billing');
const money = require('../lib/money');

const INK = '#0f172a';
const ACCENT = '#2563eb';

const BUSINESS = {
  name: 'Edward and Christie',
  tagline: 'HYDRAULIC HOSE REPAIR',
  address: 'No. 64/9, Nawala Road,<br>Nugegoda, Sri Lanka',
  phone: '+94-11 2812990, 2812991<br>Fax: +94-11 2812441',
  email: 'edchrist@sltnet.lk<br>reply.enc@gmail.com',
  vat: '174042756-7000',
};

// Read an asset once and cache it as a data URI (best-effort; '' if absent).
const _assets = {};
function assetDataUri(file) {
  if (_assets[file] !== undefined) return _assets[file];
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'public', file));
    _assets[file] = `data:image/png;base64,${buf.toString('base64')}`;
  } catch (_) {
    _assets[file] = '';
  }
  return _assets[file];
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

// Simplified customer-facing description for the Outside bill (mirrors the
// frontend getOutsideDesc). Display-only — the stored ItemDescription is intact.
function outsideDesc(desc, unit) {
  const d = String(desc || '');
  const dl = d.toLowerCase();
  const u = String(unit || '').toLowerCase();
  if (dl.includes('crimping')) return d;
  if (dl.includes('technical charge')) return 'Service charge';
  if (u === 'm' || u === 'ft') return 'Hydraulic hose supply & fitting';
  if (dl.includes('bsp straight') || d.includes('22611')) return 'Union fitting (BSP Straight)';
  if (dl.includes('bsp 90') || d.includes('22692') || dl.includes('elbow')) return 'Elbow fitting (BSP 90°)';
  if (dl.includes('ferrule') || d.includes('00210') || dl.includes('2sn')) return 'Ferrule fitting';
  if (dl.includes('flange')) return 'Flange fitting';
  if (dl.includes('union')) return 'Union fitting';
  const i = d.indexOf(' - ');
  return (i >= 0 ? d.slice(0, i) : d).trim();
}

/**
 * Build the full HTML document for one invoice.
 * @param {object} invoice invoice header row (as returned by GET /api/invoices/:id)
 * @param {Array<object>} items InvoiceItems rows (ItemDescription, Qty, Rate, Unit)
 * @param {object} [opts]
 * @param {'inside'|'outside'} [opts.billType='inside']
 * @returns {string}
 */
function buildInvoiceHtml(invoice, items, opts = {}) {
  const outside = opts.billType === 'outside';
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

  const itemRows = rows.map((r, i) => {
    const desc = outside ? outsideDesc(r.desc, r.unit) : r.desc;
    const qtyCell = outside ? `${r.qty}` : `${r.qty}${r.unit ? ' ' + esc(r.unit) : ''}`;
    return `
    <tr>
      <td class="c">${i + 1}</td>
      <td>${esc(desc)}</td>
      <td class="c">${qtyCell}</td>
      <td class="r">${fmt(r.rate)}</td>
      <td class="r">${fmt(money.round2(r.qty * r.rate))}</td>
    </tr>`;
  }).join('');

  const taxRow = (label, val) => `<tr><td>${label}</td><td class="r">${fmt(val)}</td></tr>`;
  const logo = assetDataUri('logo.png');
  const sign = assetDataUri('signature.png');
  const copyBadge = outside ? 'OUTSIDE BILL — Customer Copy' : 'INTERNAL BILL — Company Copy';

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(invoice.InvoiceNo || 'Invoice')}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; margin: 0; padding: 0; font-size: 12px; }
  .wrap { padding: 26px 32px 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid ${INK}; padding-bottom: 12px; }
  .brand img { max-height: 44px; display: block; margin-bottom: 6px; }
  .brand .name { font-size: 18px; font-weight: 700; color: ${INK}; }
  .brand .strip { display: inline-block; margin-top: 6px; background: ${INK}; color: #fff; font-size: 11px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; padding: 4px 12px; }
  .brand .strip .dot { color: ${ACCENT}; }
  .doc { text-align: right; }
  .doc .title { font-size: 22px; font-weight: 800; letter-spacing: 1px; color: ${INK}; }
  .doc .title span { color: ${ACCENT}; }
  .doc .ref { font-size: 12px; margin-top: 4px; }
  .doc .copy { display:inline-block; margin-top:8px; font-size:9px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; padding:3px 9px; border-radius:3px; background:${INK}; color:#fff; }
  .doc .copy.outside { background:${ACCENT}; }
  .parties { display: flex; gap: 24px; margin: 18px 0; }
  .parties .box { flex: 1; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; }
  .parties h4 { margin: 0 0 4px; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #6b7280; }
  .parties .v { font-weight: 600; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.items th { background: ${INK}; color: #fff; font-weight: 600; text-align: left; padding: 8px 10px; font-size: 11px; }
  table.items td { padding: 7px 10px; border-bottom: 1px solid #eef2f7; }
  table.items td.c, table.items th.c { text-align: center; }
  table.items td.r, table.items th.r { text-align: right; }
  .totals { width: 300px; margin-left: auto; margin-top: 14px; }
  .totals table { width: 100%; border-collapse: collapse; }
  .totals td { padding: 5px 10px; }
  .totals td.r { text-align: right; }
  .totals tr.grand td { border-top: 2px solid ${INK}; font-size: 15px; font-weight: 700; color: ${INK}; padding-top: 8px; }
  .notes { margin-top: 16px; font-size: 11px; color: #4b5563; }
  .sign { margin: 28px 0 18px; display: flex; justify-content: flex-end; }
  .sign .box { text-align: center; }
  .sign img { max-height: 56px; display: block; margin: 0 auto 4px; }
  .sign .line { border-top: 1px dashed #94a3b8; width: 210px; margin: 0 auto 6px; }
  .sign .label { font-size: 11px; color: #64748b; font-weight: 500; }
  .footer { background: ${INK}; color: #fff; border-top: 3px solid ${ACCENT}; padding: 12px 32px; display: flex; align-items: center; gap: 18px; font-size: 10px; }
  .footer .brandmini { font-weight: 700; font-size: 14px; white-space: nowrap; }
  .footer .brandmini span { color: ${ACCENT}; }
  .footer .col { display: flex; gap: 7px; align-items: flex-start; line-height: 1.4; flex: 1; }
  .footer .ic { width: 15px; height: 15px; border-radius: 50%; background: ${ACCENT}; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 8px; color: #fff; margin-top: 1px; }
  .footer .vat { text-align: right; letter-spacing: 1.5px; font-size: 9px; white-space: nowrap; }
  .footer .vat .k { color: ${ACCENT}; display: block; margin-bottom: 2px; }
</style></head><body>
  <div class="wrap">
    <div class="head">
      <div class="brand">
        ${logo ? `<img src="${logo}" alt="logo">` : ''}
        <div class="name">${esc(BUSINESS.name)}</div>
        <div class="strip"><span class="dot">·</span> ${esc(BUSINESS.tagline)}</div>
      </div>
      <div class="doc">
        <div class="title">IN<span>V</span>OICE</div>
        <div class="ref">Ref: <strong>${esc(invoice.InvoiceNo || '')}</strong></div>
        <div class="ref">Date: ${fmtDate(invoice.InvoiceDate)}</div>
        <div class="copy${outside ? ' outside' : ''}">${copyBadge}</div>
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
      <tr class="grand"><td>Total Due</td><td class="r">${fmt(totals.grandTotal)}</td></tr>
    </table></div>

    ${invoice.Notes ? `<div class="notes"><strong>Notes:</strong> ${esc(invoice.Notes)}</div>` : ''}

    <div class="sign">
      <div class="box">
        ${sign ? `<img src="${sign}" alt="signature">` : ''}
        <div class="line"></div>
        <div class="label">System Generated Invoice</div>
      </div>
    </div>
  </div>

  <div class="footer">
    <div class="brandmini">Edward and <span>Christie</span></div>
    <div class="col"><div class="ic">✆</div><div>${BUSINESS.phone}</div></div>
    <div class="col"><div class="ic">✉</div><div>${BUSINESS.email}</div></div>
    <div class="col"><div class="ic">◎</div><div>${BUSINESS.address}</div></div>
    <div class="vat"><span class="k">VAT REG</span>${esc(BUSINESS.vat)}</div>
  </div>
</body></html>`;
}

module.exports = { buildInvoiceHtml, BUSINESS, outsideDesc };
