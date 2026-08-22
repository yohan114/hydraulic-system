'use strict';

/**
 * Job Profit Analysis → print-ready HTML for the puppeteer PDF.
 *
 * Mirrors the Excel export cell for cell: OUR COST | OUTSIDE COST | PROFIT
 * blocked per invoice, then SUMMARY, then the technical/crimping labour still
 * owed. Both are fed by services/jobProfitExport.js, so the printed sheet and
 * the spreadsheet always say the same thing.
 *
 * Self-contained (inline CSS) and rendered server-side so text and colours stay
 * crisp. The colour banding matches the shop's own spreadsheet: navy title,
 * blue OUR COST, orange OUTSIDE COST, green PROFIT.
 */

const money = require('../lib/money');

const C = {
  navy: '#1F3864', blue: '#2E75B6', blueSoft: '#DDEBF7', blueHead: '#BDD7EE',
  orange: '#C55A11', orangeSoft: '#FCE4D6', orangeHead: '#F8CBAD',
  green: '#375623', greenMid: '#548235', greenSoft: '#E2EFDA', greenHead: '#C6E0B4',
  red: '#C00000', redSoft: '#FCE4E4',
  line: '#BFBFBF', muted: '#7F7F7F', ink: '#1F1F1F',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Bare 2dp with thousands separators — "Rs." on every cell is noise at this density.
function n2(v) {
  const x = money.round2(v);
  return x.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct1(part, whole) {
  return whole > 0 ? `${(Math.round((part / whole) * 1000) / 10).toFixed(1)}%` : '—';
}

// One invoice: its line rows, with the block totals spanning them.
function block(b) {
  const n = Math.max(1, b.lines.length);
  const rows = b.lines.map((l, i) => {
    const first = i === 0;
    const span = ` rowspan="${n}"`;
    return `<tr${l.isSundry ? ' class="sundry"' : ''}>
      ${first ? `<td class="inv"${span}>${esc(b.invoiceNo)}</td>` : ''}
      <td class="desc">${esc(l.description)}</td>
      <td class="c">${esc(l.unit)}</td>
      <td class="r">${l.isSundry ? '' : l.qty}</td>
      <td class="r">${l.isSundry ? '' : n2(l.costRate)}</td>
      <td class="r cost">${n2(l.costAmount)}</td>
      ${first ? `<td class="r tot cost"${span}>${n2(b.ourCost)}</td>` : ''}
      ${first ? `<td class="c size"${span}>${esc(b.hoseSize)}</td>` : ''}
      <td class="r out">${l.outsideRate > 0 ? n2(l.outsideRate) : ''}</td>
      <td class="r out">${l.outsideRate > 0 ? l.qty : ''}</td>
      <td class="r out">${l.outsideRate > 0 ? n2(l.outsideAmount) : ''}</td>
      ${first ? `<td class="r tot out"${span}>${n2(b.outsideTotal)}</td>` : ''}
      ${first ? `<td class="r prof"${span}>${n2(b.invoiceTotal)}</td>` : ''}
      ${first ? `<td class="r prof strong"${span}>${n2(b.profit)}</td>` : ''}
      ${first ? `<td class="r prof strong"${span}>${pct1(b.profit, b.invoiceTotal)}</td>` : ''}
    </tr>`;
  }).join('');
  return rows + '<tr class="gap"><td colspan="15"></td></tr>';
}

/**
 * @param {{blocks:Array, unpaid:Array, totals:object}} model from buildExportModel
 * @param {{period?:string, generatedAt?:string}} [opts]
 */
function buildJobProfitHtml(model, opts = {}) {
  const { blocks, unpaid, totals } = model;
  const period = opts.period || 'All finalized invoices';
  const generated = opts.generatedAt || new Date().toISOString().slice(0, 10);
  const lab = model.labour || {};
  const range = model.range || {};
  const rangeText = range.from && range.to
    ? (range.from === range.to ? range.from : `${range.from}  to  ${range.to}`)
    : '—';

  const detail = blocks.map(block).join('');

  const summaryRows = blocks.map((b) => {
    const gain = money.round2(b.outsideTotal - b.ourCost);
    return `<tr>
      <td>${esc(b.invoiceNo)}</td>
      <td class="r cost">${n2(b.ourCost)}</td>
      <td class="r out">${n2(b.outsideTotal)}</td>
      <td class="r prof strong">${n2(gain)}</td>
      <td class="r prof strong">${pct1(gain, b.outsideTotal)}</td>
    </tr>`;
  }).join('');
  const totalGain = money.round2(totals.outsideTotal - totals.ourCost);

  const labourRows = unpaid.map((u) => `<tr class="${u.status === 'Unpaid' ? 'owed' : ''}">
      <td>${esc(u.invoiceNo)}</td>
      <td class="c">${esc(u.date)}</td>
      <td>${esc(u.customer)}</td>
      <td class="r">${n2(u.amount)}</td>
      <td class="c strong" style="color:${u.status === 'Unpaid' ? C.red : C.greenMid};">${esc(u.status)}</td>
    </tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Job Profit Analysis</title>
<style>
  * { box-sizing: border-box; }
  @page { size: A4 landscape; margin: 10mm 8mm; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: ${C.ink}; font-size: 9px; }

  .title { background: ${C.navy}; color: #fff; padding: 10px 14px; display: flex; justify-content: space-between; align-items: baseline; }
  .title .t { font-size: 15px; font-weight: 800; letter-spacing: .5px; }
  .title .m { font-size: 9px; opacity: .85; }

  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid ${C.line}; padding: 3px 5px; }
  td.r, th.r { text-align: right; }
  td.c, th.c { text-align: center; }
  .strong { font-weight: 700; }

  /* The three colour groups, as in the shop's own sheet. */
  th.g-cost { background: ${C.blue}; color: #fff; }
  th.g-out  { background: ${C.orange}; color: #fff; }
  th.g-prof { background: ${C.green}; color: #fff; }
  th.h-cost { background: ${C.blueHead}; }
  th.h-out  { background: ${C.orangeHead}; }
  th.h-prof { background: ${C.greenHead}; }
  th { font-size: 9px; font-weight: 700; text-align: left; }
  td.cost { background: ${C.blueSoft}; }
  td.out  { background: ${C.orangeSoft}; }
  td.prof { background: ${C.greenSoft}; }
  td.tot  { font-weight: 700; }
  td.inv  { font-weight: 700; background: #fff; vertical-align: top; width: 108px; }
  td.size { background: ${C.blueSoft}; font-weight: 600; }
  td.desc { max-width: 250px; }
  tr.sundry td { font-style: italic; color: ${C.muted}; }
  tr.sundry td.cost { color: ${C.ink}; }
  tr.gap td { border: 0; height: 5px; padding: 0; }
  tr { page-break-inside: avoid; }

  h3.sec { font-size: 12px; color: #fff; background: ${C.navy}; padding: 6px 10px; margin: 14px 0 0; letter-spacing: .5px; }
  .sum { width: 62%; }
  tr.total td { background: ${C.navy}; color: #fff; font-weight: 800; }
  tr.owed td { background: ${C.redSoft}; }
  tr.grand td { background: ${C.red}; color: #fff; font-weight: 800; font-size: 11px; }
</style></head><body>

  <div class="title">
    <div class="t">JOB PROFIT ANALYSIS</div>
    <div class="m">Edward and Christie · Hydraulic Hose Repair &nbsp;|&nbsp; Period: ${esc(period)} &nbsp;|&nbsp; ${totals.count} job(s) &nbsp;|&nbsp; Generated ${esc(generated)}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="g-cost" colspan="8">OUR COST</th>
        <th class="g-out" colspan="4">OUTSIDE COST</th>
        <th class="g-prof" colspan="3">PROFIT</th>
      </tr>
      <tr>
        <th class="h-cost">Invoice Number</th><th class="h-cost">Description</th><th class="h-cost c">Unit</th>
        <th class="h-cost r">Qty</th><th class="h-cost r">Rate</th><th class="h-cost r">Amount</th>
        <th class="h-cost r">Total Our Cost</th><th class="h-cost c">Hose Size</th>
        <th class="h-out r">Rate (Outside)</th><th class="h-out r">Qty (Outside)</th>
        <th class="h-out r">Outside Cost</th><th class="h-out r">Total Outside Cost</th>
        <th class="h-prof r">Invoice Total</th><th class="h-prof r">Profit</th><th class="h-prof r">Margin %</th>
      </tr>
    </thead>
    <tbody>${detail || '<tr><td colspan="15" class="c" style="color:#888;">No jobs in this period</td></tr>'}</tbody>
  </table>

  <h3 class="sec">SUMMARY</h3>
  <table class="sum">
    <thead><tr>
      <th class="h-cost">Invoice Number</th><th class="h-cost r">Our Actual Cost</th>
      <th class="h-out r">Outside Cost</th><th class="h-prof r">Profit</th><th class="h-prof r">Margin %</th>
    </tr></thead>
    <tbody>
      ${summaryRows}
      <tr class="total">
        <td>TOTAL</td><td class="r">${n2(totals.ourCost)}</td><td class="r">${n2(totals.outsideTotal)}</td>
        <td class="r">${n2(totalGain)}</td><td class="r">${pct1(totalGain, totals.outsideTotal)}</td>
      </tr>
      <tr>
        <td>Total Material Cost</td><td class="r cost">${n2(totals.materialCost)}</td>
        <td colspan="3" style="color:${C.muted};">parts only — excludes crimping, welding and sundry</td>
      </tr>
      <tr>
        <td>Total Sundry (Electricity)</td><td class="r cost">${n2(totals.sundry)}</td>
        <td colspan="3" style="color:${C.muted};">10% of each job's other costs — already inside Our Actual Cost</td>
      </tr>
    </tbody>
  </table>

  <h3 class="sec">TECHNICAL / CRIMPING LABOUR</h3>
  <table class="sum">
    <thead><tr>
      <th class="h-cost">Invoice Number</th><th class="h-cost c">Date</th><th class="h-cost">Customer</th>
      <th class="h-cost r">Technical Charge</th><th class="h-cost c">Status</th>
    </tr></thead>
    <tbody>
      ${labourRows || '<tr><td colspan="5" class="c" style="color:#888;">No technical or crimping labour on these jobs</td></tr>'}
      <tr class="total"><td colspan="3">TOTAL BILLED</td><td class="r">${n2(totals.techCharges)}</td><td></td></tr>
      <tr class="grand"><td colspan="3">TOTAL UNPAID</td><td class="r">${n2(totals.unpaidTech)}</td><td class="c">${totals.unpaidCount} job(s)</td></tr>
    </tbody>
  </table>

  <h3 class="sec">REPORT DETAILS</h3>
  <table class="sum">
    <tbody>
      <tr><td>Date range (jobs in this report)</td><td class="r strong" colspan="2">${esc(rangeText)}</td></tr>
      <tr><td>Filter applied</td><td class="r" colspan="2">${esc(period)}</td></tr>
      <tr><td>Invoices / jobs</td><td class="r strong" colspan="2">${totals.count}</td></tr>
      <tr><td>Jobs with technical / crimping labour</td><td class="r strong" colspan="2">${lab.jobs || 0}</td></tr>
      <tr><td>&nbsp;&nbsp;&nbsp;— labour paid</td><td class="r">${lab.paidCount || 0} job(s)</td><td class="r">${n2(lab.paidAmount)}</td></tr>
      <tr class="owed"><td>&nbsp;&nbsp;&nbsp;— labour UNPAID</td><td class="r strong">${lab.unpaidCount || 0} job(s)</td><td class="r strong">${n2(lab.unpaidAmount)}</td></tr>
      <tr class="total"><td>Total labour billed</td><td></td><td class="r">${n2(lab.billed)}</td></tr>
      <tr><td>Sundry (Electricity) rate</td><td class="r" colspan="2">10% of each job's other costs</td></tr>
      <tr><td>Figures</td><td class="r" colspan="2">Exclude SSCL/VAT</td></tr>
    </tbody>
  </table>

</body></html>`;
}

module.exports = { buildJobProfitHtml };
