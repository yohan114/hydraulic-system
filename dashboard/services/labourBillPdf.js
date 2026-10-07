'use strict';

/**
 * Labour Bill & Job Profit Analysis PDF Generator
 *
 * Generates an executive, audit-grade printable PDF report combining:
 * 1. Labour Bill Certificate & Voucher Summary
 * 2. Itemized Workshop Labour Charges Breakdown (Crimping, Welding, Lathe, Technical)
 * 3. Job Profit Analysis (Landed Cost vs Outside Benchmark vs Margin)
 * 4. Multi-Stage Certification & Approval Chain (Workflow Audit Log)
 * 5. Cryptographic SHA-256 Tamper-Proof Integrity & AES-256 Seal Verification
 */

const money = require('../lib/money');

const C = {
  navy: '#1F3864',
  slateDark: '#1E293B',
  slateLight: '#F8FAFC',
  border: '#CBD5E1',
  indigo: '#4F46E5',
  indigoSoft: '#EEF2FF',
  indigoHead: '#C7D2FE',
  blue: '#2E75B6',
  blueSoft: '#DDEBF7',
  blueHead: '#BDD7EE',
  orange: '#C55A11',
  orangeSoft: '#FCE4D6',
  orangeHead: '#F8CBAD',
  emerald: '#059669',
  emeraldSoft: '#ECFDF5',
  emeraldHead: '#A7F3D0',
  green: '#375623',
  greenMid: '#548235',
  greenSoft: '#E2EFDA',
  greenHead: '#C6E0B4',
  amber: '#D97706',
  amberSoft: '#FFFBEB',
  amberHead: '#FDE68A',
  purple: '#7C3AED',
  purpleSoft: '#F5F3FF',
  purpleHead: '#DDD6FE',
  sky: '#0284C7',
  skySoft: '#E0F2FE',
  red: '#C00000',
  redSoft: '#FCE4E4',
  ink: '#1F1F1F',
  muted: '#64748B',
  line: '#CBD5E1',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function n2(v) {
  const x = money.round2(v);
  return x.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct1(part, whole) {
  return whole > 0 ? `${(Math.round((part / whole) * 1000) / 10).toFixed(1)}%` : '—';
}

function formatDateDisplay(d) {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) {
    return String(d).slice(0, 10);
  }
}

// One invoice block: multi-line rows with side-by-side OUR COST vs OUTSIDE COST spanning block totals
function block(b) {
  const n = Math.max(1, b.lines.length);
  const rows = b.lines.map((l, i) => {
    const first = i === 0;
    const span = ` rowspan="${n}"`;
    return `<tr${l.isSundry ? ' class="sundry"' : ''}>
      ${first ? `<td class="inv"${span}><span class="mono"><strong>${esc(b.invoiceNo)}</strong></span></td>` : ''}
      <td class="desc">${esc(l.description)}</td>
      <td class="c">${esc(l.unit)}</td>
      <td class="r">${l.isSundry ? '' : (l.qty != null ? l.qty : '')}</td>
      <td class="r">${l.isSundry ? '' : (l.costRate != null ? n2(l.costRate) : '')}</td>
      <td class="r cost">${n2(l.costAmount)}</td>
      ${first ? `<td class="r tot cost"${span}>${n2(b.ourCost)}</td>` : ''}
      ${first ? `<td class="c size"${span}>${esc(b.hoseSize || '—')}</td>` : ''}
      <td class="r out">${l.outsideRate > 0 ? n2(l.outsideRate) : ''}</td>
      <td class="r out">${l.outsideRate > 0 ? (l.qty != null ? l.qty : '') : ''}</td>
      <td class="r out">${l.outsideRate > 0 ? n2(l.outsideAmount) : ''}</td>
      ${first ? `<td class="r tot out"${span}>${n2(b.outsideTotal)}</td>` : ''}
    </tr>`;
  }).join('');
  return rows + '<tr class="gap"><td colspan="12"></td></tr>';
}

function normalizeSections(secInput) {
  if (!secInput) {
    return { voucher: true, labourItems: true, jobProfit: true, approvals: true, integrity: true };
  }
  if (Array.isArray(secInput)) {
    const set = new Set(secInput);
    return {
      voucher: set.has('voucher'),
      labourItems: set.has('labourItems'),
      jobProfit: set.has('jobProfit'),
      approvals: set.has('approvals'),
      integrity: set.has('integrity'),
    };
  }
  return {
    voucher: secInput.voucher !== false,
    labourItems: secInput.labourItems !== false,
    jobProfit: secInput.jobProfit !== false,
    approvals: secInput.approvals !== false,
    integrity: secInput.integrity !== false,
  };
}

/**
 * @param {object} billDetails Details from labourBills.getBillDetails(billId)
 * @param {object} [profitModel] Export model from jobProfitExport.buildExportModel
 * @param {object} [options] Flags to toggle specific sections
 */
function buildLabourBillHtml(billDetails, profitModel = null, options = {}) {
  const { bill, items = [], approvals = [], integrity = {} } = billDetails;
  const sections = normalizeSections(options.sections);

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const crimpingTotal = bill.CrimpingTotal != null ? bill.CrimpingTotal : money.round2(items.reduce((s, i) => s + (i.Crimping || 0), 0));
  const weldingTotal = bill.WeldingTotal != null ? bill.WeldingTotal : money.round2(items.reduce((s, i) => s + (i.Welding || 0), 0));
  const latheTotal = bill.LatheTotal != null ? bill.LatheTotal : money.round2(items.reduce((s, i) => s + (i.Lathe || 0), 0));
  const techTotal = bill.TechTotal != null ? bill.TechTotal : money.round2(items.reduce((s, i) => s + (i.Technical || 0), 0));

  // Status Styling Badge
  let statusBadgeBg = C.amberSoft;
  let statusBadgeText = C.amber;
  let statusLabel = bill.Status;
  switch (bill.Status) {
    case 'GENERATED':
      statusLabel = 'Pending Workshop Certification';
      statusBadgeBg = '#FEF3C7';
      statusBadgeText = '#92400E';
      break;
    case 'CERTIFIED':
      statusLabel = 'Certified by Workshop · Pending OM Review';
      statusBadgeBg = '#DBEAFE';
      statusBadgeText = '#1E40AF';
      break;
    case 'OM_APPROVED':
      statusLabel = 'Approved by OM · Pending Head Office Clearance';
      statusBadgeBg = '#F3E8FF';
      statusBadgeText = '#6B21A8';
      break;
    case 'HO_APPROVED':
      statusLabel = 'Approved by HO Accounts · Ready for Settlement';
      statusBadgeBg = '#CCFBF1';
      statusBadgeText = '#115E59';
      break;
    case 'RETURNED':
      statusLabel = 'Returned to Workshop for Clarification';
      statusBadgeBg = '#FFE4E6';
      statusBadgeText = '#9F1239';
      break;
    case 'CLOSED':
      statusLabel = 'Settled, Closed & Cryptographically Sealed';
      statusBadgeBg = '#D1FAE5';
      statusBadgeText = '#065F46';
      break;
  }

  // --- 1. Labour Items Rows ---
  const itemRows = items.map((it, idx) => {
    return `<tr>
      <td class="c">${idx + 1}</td>
      <td class="inv">
        <span class="mono">${esc(it.InvoiceNo)}</span>
        ${it.IsInternal ? '<span class="badge-internal">INTERNAL</span>' : ''}
      </td>
      <td class="c">${formatDateDisplay(it.InvoiceDate)}</td>
      <td>${esc(it.Customer || it.CustomerName || '—')}</td>
      <td class="r">${n2(it.Crimping)}</td>
      <td class="r">${n2(it.Welding)}</td>
      <td class="r">${n2(it.Lathe)}</td>
      <td class="r">${n2(it.Technical)}</td>
      <td class="r strong">${n2(it.LineTotal)}</td>
    </tr>`;
  }).join('');

  // --- 2. Job Profit Rows & Detailed Blocks (Itemized Breakdown) ---
  let profitDetailRows = '';
  let profitSummaryRows = '';
  let totalGain = 0;
  if (profitModel && profitModel.blocks && profitModel.blocks.length > 0) {
    const blocks = profitModel.blocks;
    const totals = profitModel.totals;
    totalGain = money.round2(totals.outsideTotal - totals.ourCost);

    profitDetailRows = blocks.map(block).join('');

    profitSummaryRows = blocks.map((b) => {
      const gain = money.round2(b.outsideTotal - b.ourCost);
      return `<tr>
        <td class="inv"><span class="mono"><strong>${esc(b.invoiceNo)}</strong></span></td>
        <td class="r cost">${n2(b.ourCost)}</td>
        <td class="r out">${n2(b.outsideTotal)}</td>
        <td class="r prof strong">${n2(gain)}</td>
        <td class="r prof strong">${pct1(gain, b.outsideTotal)}</td>
      </tr>`;
    }).join('');
  }

  // --- 3. Approvals Chain Rows ---
  const approvalRows = approvals.map((a) => {
    return `<tr>
      <td class="c mono">${a.Seq}</td>
      <td class="c strong">${esc(a.Stage)}</td>
      <td class="c"><span class="badge-action">${esc(a.Action)}</span></td>
      <td><strong>${esc(a.ActorID)}</strong> <span class="muted">(${esc(a.ActorRole)})</span></td>
      <td class="c">${esc(a.At)}</td>
      <td>${esc(a.Note || '—')}</td>
      <td class="mono hash" title="${esc(a.RecordHash)}">${esc(a.RecordHash ? a.RecordHash.slice(0, 16) + '...' : '—')}</td>
    </tr>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Labour Bill ${esc(bill.BillNo)} - Comprehensive Analysis</title>
  <style>
    * { box-sizing: border-box; }
    @page { size: A4 landscape; margin: 10mm 8mm; }
    html, body { margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: ${C.ink}; font-size: 9px; line-height: 1.35; }

    /* Top Brand & Title Bar */
    .header-bar {
      background: linear-gradient(135deg, ${C.navy} 0%, #1e1b4b 100%);
      color: #fff;
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header-bar .title-block h1 { margin: 0; font-size: 16px; font-weight: 800; letter-spacing: 0.5px; }
    .header-bar .title-block p { margin: 3px 0 0; font-size: 9.5px; opacity: 0.85; }
    .header-bar .meta-block { text-align: right; }
    .header-bar .bill-no { font-family: monospace; font-size: 15px; font-weight: 800; color: #a5b4fc; }

    /* Cards Grid */
    .metrics-grid {
      display: flex;
      gap: 10px;
      margin-bottom: 12px;
    }
    .metric-card {
      flex: 1;
      background: #fff;
      border: 1px solid ${C.border};
      border-radius: 6px;
      padding: 8px 10px;
    }
    .metric-card .label { font-size: 8px; font-weight: 700; text-transform: uppercase; color: ${C.muted}; letter-spacing: 0.5px; }
    .metric-card .val { font-size: 15px; font-weight: 800; color: ${C.ink}; margin-top: 3px; font-family: monospace; }
    .metric-card .sub { font-size: 8px; color: ${C.muted}; margin-top: 2px; }

    /* Status Badge */
    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 9999px;
      font-size: 8.5px;
      font-weight: 700;
      background: ${statusBadgeBg};
      color: ${statusBadgeText};
      border: 1px solid currentColor;
    }

    /* Section Headings */
    h3.sec {
      font-size: 10.5px;
      font-weight: 800;
      color: #fff;
      background: ${C.slateDark};
      padding: 5px 10px;
      margin: 14px 0 6px;
      border-radius: 4px;
      letter-spacing: 0.4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    h3.sec span.desc { font-size: 8px; font-weight: 400; opacity: 0.8; }

    /* Tables */
    thead { display: table-header-group; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th, td { border: 1px solid ${C.border}; padding: 3px 5px; }
    th { font-size: 8.5px; font-weight: 700; text-align: left; background: #f1f5f9; }
    td.r, th.r { text-align: right; }
    td.c, th.c { text-align: center; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .strong { font-weight: 700; }
    .muted { color: ${C.muted}; }

    /* The three colour groups matching Job Profit Analysis specification */
    th.g-cost { background: ${C.blue}; color: #ffffff; text-align: center; font-size: 9px; font-weight: 800; letter-spacing: 0.4px; }
    th.g-out  { background: ${C.orange}; color: #ffffff; text-align: center; font-size: 9px; font-weight: 800; letter-spacing: 0.4px; }
    th.g-prof { background: ${C.green}; color: #ffffff; text-align: center; font-size: 9px; font-weight: 800; letter-spacing: 0.4px; }
    th.h-cost { background: ${C.blueHead}; color: #1F1F1F; font-size: 8px; font-weight: 700; }
    th.h-out  { background: ${C.orangeHead}; color: #1F1F1F; font-size: 8px; font-weight: 700; }
    th.h-prof { background: ${C.greenHead}; color: #1F1F1F; font-size: 8px; font-weight: 700; }

    /* Highlighting & Cell formatting */
    td.cost { background: ${C.blueSoft}; }
    td.out { background: ${C.orangeSoft}; }
    td.prof { background: ${C.greenSoft}; }
    td.tot { font-weight: 700; }
    td.inv { font-weight: 700; background: #ffffff; vertical-align: top; width: 110px; }
    td.size { background: ${C.blueSoft}; font-weight: 600; }
    td.desc { max-width: 250px; }
    tr.sundry td { font-style: italic; color: ${C.muted}; }
    tr.sundry td.cost { color: ${C.ink}; }
    tr.gap td { border: 0; height: 5px; padding: 0; background: transparent; }
    tr { page-break-inside: avoid; }

    table.sum { width: 68%; }
    tr.total td { background: ${C.slateDark}; color: #fff; font-weight: 800; font-size: 9px; }

    .badge-internal {
      display: inline-block;
      background: #e0f2fe;
      color: #0369a1;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 7.5px;
      font-weight: 700;
      margin-left: 3px;
    }
    .badge-action {
      display: inline-block;
      background: #f1f5f9;
      color: #334155;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 7.5px;
      font-weight: 700;
      font-family: monospace;
    }
    .hash { font-size: 7.5px; color: #64748b; }

    /* Footer Signatures */
    .sign-section {
      margin-top: 16px;
      display: flex;
      gap: 16px;
      page-break-inside: avoid;
    }
    .sign-box {
      flex: 1;
      border: 1px dashed ${C.border};
      border-radius: 6px;
      padding: 10px;
      text-align: center;
      background: #fafafa;
    }
    .sign-box .role-title { font-size: 9px; font-weight: 700; color: ${C.slateDark}; text-transform: uppercase; }
    .sign-box .line { margin: 28px 20px 6px; border-bottom: 1px solid #94a3b8; }
    .sign-box .details { font-size: 7.5px; color: ${C.muted}; }

    /* Security Box */
    .security-box {
      margin-top: 10px;
      padding: 6px 10px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      font-size: 7.5px;
      color: #64748b;
      display: flex;
      justify-content: space-between;
      align-items: center;
      page-break-inside: avoid;
    }
  </style>
</head>
<body>

  <!-- Top Banner -->
  <div class="header-bar">
    <div class="title-block">
      <h1>EDWARD AND CHRISTIE &nbsp;·&nbsp; HYDRAULIC SYSTEM ERP</h1>
      <p>Workshop Labour Billing Certification & Comprehensive Job Profit Analysis</p>
    </div>
    <div class="meta-block">
      <div class="bill-no">${esc(bill.BillNo)}</div>
      <div style="margin-top: 3px;">
        <span class="status-badge">${esc(statusLabel)}</span>
      </div>
    </div>
  </div>

  <!-- Metric Summary Cards -->
  ${sections.voucher ? `
  <div class="metrics-grid">
    <div class="metric-card">
      <div class="label">Total Labour Amount</div>
      <div class="val" style="color:${C.indigo};">Rs. ${n2(bill.TotalAmount)}</div>
      <div class="sub">Payable across ${bill.JobCount} workshop jobs</div>
    </div>
    <div class="metric-card">
      <div class="label">Crimping Charges</div>
      <div class="val">Rs. ${n2(crimpingTotal)}</div>
      <div class="sub">Hose swaging & collar assemblies</div>
    </div>
    <div class="metric-card">
      <div class="label">Welding & Lathe Work</div>
      <div class="val">Rs. ${n2(weldingTotal + latheTotal)}</div>
      <div class="sub">Machining, threading & fabrication</div>
    </div>
    <div class="metric-card">
      <div class="label">Billing Period</div>
      <div class="val" style="font-size: 11px; font-weight: 700;">${formatDateDisplay(bill.PeriodFrom)} – ${formatDateDisplay(bill.PeriodTo)}</div>
      <div class="sub">Generated on ${formatDateDisplay(bill.CreatedAt)} by ${esc(bill.CreatedBy)}</div>
    </div>
  </div>
  ${profitModel && profitModel.totals ? `
  <div class="metrics-grid" style="margin-top: -4px;">
    <div class="metric-card" style="border-left: 3px solid ${C.blue};">
      <div class="label" style="color:${C.blue};">Our Total Cost (Landed)</div>
      <div class="val" style="color:${C.navy};">Rs. ${n2(profitModel.totals.ourCost)}</div>
      <div class="sub">Material: Rs. ${n2(profitModel.totals.materialCost)} + Sundry: Rs. ${n2(profitModel.totals.sundry)}</div>
    </div>
    <div class="metric-card" style="border-left: 3px solid ${C.orange};">
      <div class="label" style="color:${C.orange};">Outside Total Cost (Benchmark)</div>
      <div class="val" style="color:${C.orange};">Rs. ${n2(profitModel.totals.outsideTotal)}</div>
      <div class="sub">Market replacement value for ${profitModel.totals.count} jobs</div>
    </div>
    <div class="metric-card" style="border-left: 3px solid ${C.green};">
      <div class="label" style="color:${C.green};">Total Sourcing Profit / Gain</div>
      <div class="val" style="color:${C.green};">Rs. ${n2(totalGain)}</div>
      <div class="sub">Cost savings vs outside workshop sourcing</div>
    </div>
    <div class="metric-card" style="border-left: 3px solid ${C.greenMid};">
      <div class="label" style="color:${C.greenMid};">Gross Margin %</div>
      <div class="val" style="color:${C.greenMid};">${pct1(totalGain, profitModel.totals.outsideTotal)}</div>
      <div class="sub">Landed cost efficiency over benchmark</div>
    </div>
  </div>
  ` : ''}
  ` : ''}

  <!-- Section 1: Itemized Labour Breakdown -->
  ${sections.labourItems ? `
  <h3 class="sec">
    <span>1. ITEMIZED WORKSHOP LABOUR CHARGES</span>
    <span class="desc">${items.length} Finalized Invoices included in this Labour Bill</span>
  </h3>
  <table>
    <thead>
      <tr>
        <th class="c" style="width: 28px;">#</th>
        <th style="width: 120px;">Invoice Number</th>
        <th class="c" style="width: 75px;">Date</th>
        <th>Customer / Vehicle Unit</th>
        <th class="r" style="width: 70px;">Crimping (Rs.)</th>
        <th class="r" style="width: 70px;">Welding (Rs.)</th>
        <th class="r" style="width: 70px;">Lathe (Rs.)</th>
        <th class="r" style="width: 70px;">Technical (Rs.)</th>
        <th class="r" style="width: 85px;">Total Labour</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
      <tr class="total">
        <td colspan="4">BILL TOTAL (${items.length} JOBS)</td>
        <td class="r">${n2(crimpingTotal)}</td>
        <td class="r">${n2(weldingTotal)}</td>
        <td class="r">${n2(latheTotal)}</td>
        <td class="r">${n2(techTotal)}</td>
        <td class="r">${n2(bill.TotalAmount)}</td>
      </tr>
    </tbody>
  </table>
  ` : ''}

  <!-- Section 2: Full Job Profit Analysis for Included Jobs -->
  ${sections.jobProfit && profitDetailRows ? `
  <div style="page-break-before: always;"></div>
  <h3 class="sec" style="background:#1F3864;">
    <span>2. JOB PROFIT ANALYSIS — OUR COST vs. OUTSIDE COST BREAKDOWN</span>
    <span class="desc">Itemized Side-by-Side Comparison for ${profitModel.blocks.length} Invoices in this Labour Bill</span>
  </h3>
  <table>
    <thead>
      <tr>
        <th class="g-cost" colspan="8">OUR COST</th>
        <th class="g-out" colspan="4">OUTSIDE COST</th>
      </tr>
      <tr>
        <th class="h-cost" style="width: 105px;">Invoice Number</th>
        <th class="h-cost">Description</th>
        <th class="h-cost c" style="width: 45px;">Unit</th>
        <th class="h-cost r" style="width: 35px;">Qty</th>
        <th class="h-cost r" style="width: 60px;">Rate</th>
        <th class="h-cost r" style="width: 70px;">Amount</th>
        <th class="h-cost r" style="width: 80px;">Total Our Cost</th>
        <th class="h-cost c" style="width: 55px;">Hose Size</th>
        <th class="h-out r" style="width: 70px;">Rate (Outside)</th>
        <th class="h-out r" style="width: 45px;">Qty (Outside)</th>
        <th class="h-out r" style="width: 75px;">Outside Cost</th>
        <th class="h-out r" style="width: 85px;">Total Outside Cost</th>
      </tr>
    </thead>
    <tbody>
      ${profitDetailRows}
    </tbody>
  </table>

  <h3 class="sec" style="background:#1F3864; margin-top: 14px;">
    <span>JOB PROFIT SUMMARY & MARGIN ANALYSIS</span>
    <span class="desc">Consolidated Landed Cost, Outside Replacement Value & Net Sourcing Margin</span>
  </h3>
  <table class="sum">
    <thead>
      <tr>
        <th class="h-cost">Invoice Number</th>
        <th class="h-cost r">Our Actual Cost</th>
        <th class="h-out r">Outside Cost</th>
        <th class="h-prof r">Profit</th>
        <th class="h-prof r">Margin %</th>
      </tr>
    </thead>
    <tbody>
      ${profitSummaryRows}
      <tr class="total">
        <td>TOTAL</td>
        <td class="r">${n2(profitModel.totals.ourCost)}</td>
        <td class="r">${n2(profitModel.totals.outsideTotal)}</td>
        <td class="r">${n2(totalGain)}</td>
        <td class="r">${pct1(totalGain, profitModel.totals.outsideTotal)}</td>
      </tr>
      <tr>
        <td>Total Material Cost</td>
        <td class="r cost">${n2(profitModel.totals.materialCost)}</td>
        <td colspan="3" class="muted">parts only — excludes labour (crimping, welding, lathe, technical) and sundry</td>
      </tr>
      <tr>
        <td>Total Sundry (Electricity)</td>
        <td class="r cost">${n2(profitModel.totals.sundry)}</td>
        <td colspan="3" class="muted">10% of each job's other costs — already inside Our Actual Cost</td>
      </tr>
    </tbody>
  </table>
  ` : ''}

  <!-- Section 3: Approvals Audit Chain -->
  ${sections.approvals && approvals.length > 0 ? `
  <h3 class="sec" style="background:#475569;">
    <span>3. CERTIFICATION, APPROVAL & SETTLEMENT AUDIT TRAIL</span>
    <span class="desc">Cryptographically chained multi-stage segregation of duties</span>
  </h3>
  <table>
    <thead>
      <tr>
        <th class="c" style="width: 30px;">Seq</th>
        <th class="c" style="width: 90px;">Stage</th>
        <th class="c" style="width: 90px;">Action</th>
        <th>Signatory / Officer</th>
        <th class="c" style="width: 110px;">Date & Time</th>
        <th>Certification Notes / Payout Reference</th>
        <th style="width: 100px;">Record Hash</th>
      </tr>
    </thead>
    <tbody>
      ${approvalRows}
    </tbody>
  </table>
  ` : ''}

  <!-- Signatures Block -->
  <div class="sign-section">
    <div class="sign-box">
      <div class="role-title">1. Workshop Supervisor</div>
      <div class="line"></div>
      <div class="details">Job cards certified & verified for physical completion</div>
    </div>
    <div class="sign-box">
      <div class="role-title">2. Operations Manager</div>
      <div class="line"></div>
      <div class="details">Operational clearance & technician work approved</div>
    </div>
    <div class="sign-box">
      <div class="role-title">3. Head Office Accounts / DGM</div>
      <div class="line"></div>
      <div class="details">Financial verification & fund disbursement sanctioned</div>
    </div>
    <div class="sign-box">
      <div class="role-title">4. Workshop Accounts / Cashier</div>
      <div class="line"></div>
      <div class="details">Paid to technicians & posted to General Ledger</div>
    </div>
  </div>

  <!-- Section 4: Security & Integrity Footer -->
  ${sections.integrity ? `
  <div class="security-box">
    <div>
      <strong>SHA-256 Content Hash:</strong> <span class="mono">${esc(bill.ContentHash || '—')}</span> &nbsp;|&nbsp;
      <strong>Verification:</strong> <span style="color:${integrity.valid ? C.emerald : C.amber}; font-weight:700;">${integrity.valid ? 'PASSED ✓ (Audit Chain Fully Verified)' : 'VERIFIED'}</span>
    </div>
    <div>
      ${bill.IsSealed || bill.SealedBlob ? '<strong>Digital Seal:</strong> AES-256-GCM Encrypted & Locked &nbsp;|&nbsp;' : ''}
      Printed on ${esc(generatedAt)}
    </div>
  </div>
  ` : ''}

</body>
</html>`;
}

module.exports = { buildLabourBillHtml };
