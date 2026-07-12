'use strict';

/**
 * Job Profit Analysis → colourful, print-ready HTML for the puppeteer PDF.
 * Self-contained (inline CSS, inline SVG chart). Rendered server-side so text
 * and colours stay crisp (unlike an html2canvas raster).
 */

const money = require('../lib/money');

const C = {
  navy: '#0f172a', blue: '#2563eb', amber: '#f59e0b', purple: '#8b5cf6',
  green: '#10b981', red: '#dc2626', grey: '#f1f5f9', line: '#e5e7eb', muted: '#64748b',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmt(v) { return money.formatLKR(v); }
function d10(v) { return v ? String(v).slice(0, 10) : ''; }
function marginColor(m) { return m >= 20 ? C.green : (m >= 0 ? C.amber : C.red); }

function kpiCard(bg, label, value, sub) {
  return `<div style="flex:1;background:${bg};color:#fff;border-radius:10px;padding:12px 14px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;opacity:.9;">${esc(label)}</div>
    <div style="font-size:17px;font-weight:800;margin-top:4px;">${esc(value)}</div>
    ${sub ? `<div style="font-size:10px;opacity:.9;margin-top:2px;">${esc(sub)}</div>` : ''}
  </div>`;
}

// Grouped vertical bars per invoice: material cost / our bill / outside cost.
function barChart(invoices) {
  if (!invoices.length) return '';
  const max = Math.max(1, ...invoices.map((i) => Math.max(i.materialCost, i.ourBill, i.outsideCost)));
  const barW = 12, gap = 3, groupGap = 20, chartH = 130, top = 8, labelH = 26;
  const groupW = barW * 3 + gap * 2;
  const width = Math.max(320, invoices.length * (groupW + groupGap) + groupGap);
  const y = (v) => top + chartH - (v / max) * chartH;
  const series = [['materialCost', C.blue], ['ourBill', C.green], ['outsideCost', C.purple]];
  let bars = '';
  invoices.forEach((inv, i) => {
    const gx = groupGap + i * (groupW + groupGap);
    series.forEach(([k, color], j) => {
      const x = gx + j * (barW + gap), yy = y(inv[k]);
      bars += `<rect x="${x}" y="${yy}" width="${barW}" height="${top + chartH - yy}" rx="2" fill="${color}"></rect>`;
    });
    const short = String(inv.invoiceNo).split('/').slice(-2).join('/');
    bars += `<text x="${gx + groupW / 2}" y="${top + chartH + 14}" text-anchor="middle" font-size="9" fill="${C.muted}">${esc(short)}</text>`;
  });
  const legend = [['Material Cost', C.blue], ['Our Bill', C.green], ['Outside Cost', C.purple]]
    .map(([l, c]) => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:16px;font-size:11px;"><span style="width:11px;height:11px;border-radius:2px;background:${c};display:inline-block;"></span>${l}</span>`).join('');
  return `<div style="margin:6px 0 4px;">${legend}</div>
    <div style="overflow-x:auto;"><svg width="${width}" height="${chartH + top + labelH}">${bars}</svg></div>`;
}

function invoiceBlock(inv) {
  const detailRows = inv.lines.map((l, i) => {
    const tint = l.isTech ? `background:#fff7ed;` : '';
    const diffColor = l.diff >= 0 ? C.green : C.red;
    return `<tr style="${tint}">
      <td class="c">${i + 1}</td>
      <td>${esc(l.description)}${l.isTech ? ' <span style="color:#c2410c;font-weight:700;">◆</span>' : ''}</td>
      <td class="c">${l.qty}</td>
      <td class="r">${fmt(l.ourCostRate)}</td>
      <td class="r">${fmt(l.ourBilledRate)}</td>
      <td class="r">${fmt(l.outsideRate)}</td>
      <td class="r">${fmt(l.ourAmount)}</td>
      <td class="r">${fmt(l.outsideAmount)}</td>
      <td class="r" style="color:${diffColor};font-weight:700;">${fmt(l.diff)}</td>
    </tr>`;
  }).join('');
  return `<div style="margin:6px 0 12px 14px;border-left:3px solid ${C.line};padding-left:10px;">
    <table class="detail">
      <thead><tr><th class="c">#</th><th>Description</th><th class="c">Qty</th><th class="r">Our Cost Rate</th><th class="r">Our Billed Rate</th><th class="r">Outside Rate</th><th class="r">Our Amount</th><th class="r">Outside Amount</th><th class="r">Diff</th></tr></thead>
      <tbody>${detailRows}</tbody>
    </table>
  </div>`;
}

/**
 * @param {{invoices:Array, totals:object}} data
 * @param {{period?:string, generatedAt?:string}} [opts]
 */
function buildJobProfitHtml(data, opts = {}) {
  const { invoices, totals } = data;
  const period = opts.period || 'All finalized invoices';
  let generated = opts.generatedAt;
  if (!generated) { const dt = new Date(); generated = dt.toISOString().slice(0, 10); }

  const summaryRows = invoices.map((inv, idx) => {
    const alt = idx % 2 ? `background:${C.grey};` : '';
    const pColor = inv.profit >= 0 ? C.green : C.red;
    const labour = inv.techPaid
      ? `<span style="background:#dcfce7;color:#166534;padding:2px 7px;border-radius:9px;font-weight:700;">✓ Paid</span>`
      : `<span style="background:#fee2e2;color:#991b1b;padding:2px 7px;border-radius:9px;font-weight:700;">⚠ Unpaid</span>`;
    return `<tr style="${alt}">
      <td><strong>${esc(inv.invoiceNo)}</strong></td>
      <td>${esc(inv.customer || 'Walk-in')}</td>
      <td class="r">${fmt(inv.ourBill)}</td>
      <td class="r">${fmt(inv.materialCost)}</td>
      <td class="r">${fmt(inv.outsideCost)}</td>
      <td class="r" style="color:${pColor};font-weight:700;">${fmt(inv.profit)}</td>
      <td class="r" style="color:${marginColor(inv.margin)};font-weight:700;">${inv.margin}%</td>
      <td class="r">${fmt(inv.techCharges)}</td>
      <td class="c">${labour}</td>
    </tr>`;
  }).join('');

  const details = invoices.map((inv) => `
    <div style="page-break-inside:avoid;margin-top:10px;">
      <div style="font-size:12px;font-weight:700;color:${C.navy};">${esc(inv.invoiceNo)} — ${esc(inv.customer || 'Walk-in')} <span style="color:${C.muted};font-weight:400;">(${d10(inv.invoiceDate)})</span></div>
      ${invoiceBlock(inv)}
    </div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Job Profit Analysis</title>
<style>
  * { box-sizing: border-box; }
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; font-size: 11px; }
  .wrap { padding: 0 0 24px; }
  .header { background: ${C.navy}; color: #fff; padding: 20px 28px; display: flex; justify-content: space-between; align-items: center; }
  .header .brand { font-size: 20px; font-weight: 800; }
  .header .brand span { color: ${C.blue}; }
  .header .tag { font-size: 10px; letter-spacing: 3px; text-transform: uppercase; opacity: .8; margin-top: 2px; }
  .header .title { font-size: 18px; font-weight: 800; letter-spacing: .5px; text-align: right; }
  .header .meta { font-size: 10px; opacity: .85; text-align: right; margin-top: 4px; }
  .body { padding: 16px 28px; }
  .kpis { display: flex; gap: 10px; margin-bottom: 16px; }
  .card { background: #fff; border: 1px solid ${C.line}; border-radius: 8px; }
  .card .h { padding: 9px 14px; font-size: 12px; font-weight: 700; color: ${C.navy}; border-bottom: 1px solid ${C.line}; }
  table.summary { width: 100%; border-collapse: collapse; }
  table.summary th { background: ${C.navy}; color: #fff; padding: 7px 9px; font-size: 10px; text-align: left; }
  table.summary td { padding: 6px 9px; border-bottom: 1px solid ${C.line}; font-size: 11px; }
  table.summary td.r, table.summary th.r { text-align: right; }
  table.summary td.c, table.summary th.c { text-align: center; }
  table.detail { width: 100%; border-collapse: collapse; margin: 2px 0; }
  table.detail th { background: ${C.grey}; color: ${C.navy}; padding: 4px 7px; font-size: 9px; text-align: left; border-bottom: 1px solid ${C.line}; }
  table.detail td { padding: 3px 7px; font-size: 10px; border-bottom: 1px solid #f3f4f6; }
  table.detail td.r, table.detail th.r { text-align: right; }
  table.detail td.c, table.detail th.c { text-align: center; }
  .footer { background: ${C.navy}; color: #fff; padding: 14px 28px; display: flex; justify-content: space-between; gap: 16px; margin-top: 18px; }
  .footer .cell .k { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; opacity: .8; }
  .footer .cell .v { font-size: 15px; font-weight: 800; margin-top: 2px; }
  .unpaid-box { margin: 16px 28px 0; background: #fff; border: 2px solid ${C.red}; border-radius: 10px; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
  .unpaid-box .k { font-size: 13px; font-weight: 800; color: ${C.red}; text-transform: uppercase; letter-spacing: .5px; }
  .unpaid-box .v { font-size: 26px; font-weight: 800; color: ${C.red}; }
  h3.sec { font-size: 13px; color: ${C.navy}; margin: 18px 0 6px; border-bottom: 2px solid ${C.navy}; padding-bottom: 4px; }
</style></head><body>
  <div class="wrap">
    <div class="header">
      <div>
        <div class="brand">Edward and <span>Christie</span></div>
        <div class="tag">Hydraulic Hose Repair</div>
      </div>
      <div>
        <div class="title">JOB PROFIT ANALYSIS REPORT</div>
        <div class="meta">Period: ${esc(period)}</div>
        <div class="meta">Generated: ${esc(generated)}</div>
      </div>
    </div>

    <div class="body">
      <div class="kpis">
        ${kpiCard(C.blue, 'Our Total Bill', fmt(totals.ourBill))}
        ${kpiCard(C.amber, 'Our Material Cost', fmt(totals.materialCost))}
        ${kpiCard(C.purple, 'Outside Market Cost', fmt(totals.outsideCost))}
        ${kpiCard(C.green, 'Gross Profit', fmt(totals.grossProfit), `${totals.margin}% margin`)}
        ${kpiCard(C.red, 'Unpaid Technical Charges', fmt(totals.unpaidTech), `${totals.unpaidCount} job(s) unpaid`)}
      </div>

      <h3 class="sec">Cost vs Bill vs Market — per job</h3>
      ${barChart(invoices)}

      <h3 class="sec">Per-Invoice Summary</h3>
      <table class="summary">
        <thead><tr><th>Invoice #</th><th>Customer</th><th class="r">Our Bill</th><th class="r">Material Cost</th><th class="r">Outside Cost</th><th class="r">Profit/Loss</th><th class="r">Margin %</th><th class="r">Tech Charges</th><th class="c">Labour</th></tr></thead>
        <tbody>${summaryRows || '<tr><td colspan="9" style="text-align:center;color:#888;">No invoices in this period</td></tr>'}</tbody>
      </table>

      <h3 class="sec">Itemised Detail <span style="font-weight:400;color:${C.muted};font-size:10px;">(◆ = technical / crimping labour, highlighted)</span></h3>
      ${details}
    </div>

    <div class="unpaid-box">
      <div class="k">Total Unpaid Technical Charges</div>
      <div class="v">${fmt(totals.unpaidTech)}</div>
    </div>

    <div class="footer">
      <div class="cell"><div class="k">Total Our Bill</div><div class="v">${fmt(totals.ourBill)}</div></div>
      <div class="cell"><div class="k">Total Outside Cost</div><div class="v">${fmt(totals.outsideCost)}</div></div>
      <div class="cell"><div class="k">Total Profit</div><div class="v">${fmt(totals.profit)}</div></div>
      <div class="cell"><div class="k">Overall Margin</div><div class="v">${totals.margin}%</div></div>
    </div>
  </div>
</body></html>`;
}

module.exports = { buildJobProfitHtml };
