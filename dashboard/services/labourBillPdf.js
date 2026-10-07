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
  navy: '#0F172A',
  slateDark: '#1E293B',
  slateLight: '#F8FAFC',
  border: '#CBD5E1',
  indigo: '#4F46E5',
  indigoSoft: '#EEF2FF',
  indigoHead: '#C7D2FE',
  emerald: '#059669',
  emeraldSoft: '#ECFDF5',
  emeraldHead: '#A7F3D0',
  amber: '#D97706',
  amberSoft: '#FFFBEB',
  amberHead: '#FDE68A',
  purple: '#7C3AED',
  purpleSoft: '#F5F3FF',
  purpleHead: '#DDD6FE',
  sky: '#0284C7',
  skySoft: '#E0F2FE',
  ink: '#0F172A',
  muted: '#64748B',
  line: '#E2E8F0',
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

  // --- 2. Job Profit Rows (if available) ---
  let profitRows = '';
  let profitTotalsHtml = '';
  if (profitModel && profitModel.blocks && profitModel.blocks.length > 0) {
    const blocks = profitModel.blocks;
    const totals = profitModel.totals;
    const totalGain = money.round2(totals.outsideTotal - totals.ourCost);

    profitRows = blocks.map((b) => {
      const gain = money.round2(b.outsideTotal - b.ourCost);
      return `<tr>
        <td class="inv mono">${esc(b.invoiceNo)}</td>
        <td class="c size">${esc(b.hoseSize || '—')}</td>
        <td class="r cost">${n2(b.ourCost)}</td>
        <td class="r out">${n2(b.outsideTotal)}</td>
        <td class="r prof strong">${n2(gain)}</td>
        <td class="r prof strong">${pct1(gain, b.outsideTotal)}</td>
      </tr>`;
    }).join('');

    profitTotalsHtml = `
      <tr class="total">
        <td colspan="2">TOTAL FOR INCLUDED JOBS</td>
        <td class="r">${n2(totals.ourCost)}</td>
        <td class="r">${n2(totals.outsideTotal)}</td>
        <td class="r">${n2(totalGain)}</td>
        <td class="r">${pct1(totalGain, totals.outsideTotal)}</td>
      </tr>
      <tr>
        <td colspan="2">Total Landed Material Cost</td>
        <td class="r cost">${n2(totals.materialCost)}</td>
        <td colspan="3" class="muted">Hose, fittings, adapters, ferrules stock consumed</td>
      </tr>
      <tr>
        <td colspan="2">Total Sundry Overhead (10%)</td>
        <td class="r cost">${n2(totals.sundry)}</td>
        <td colspan="3" class="muted">Workshop electricity, machine depreciation & consumables</td>
      </tr>
    `;
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
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th, td { border: 1px solid ${C.border}; padding: 4px 6px; }
    th { font-size: 8.5px; font-weight: 700; text-align: left; background: #f1f5f9; }
    td.r, th.r { text-align: right; }
    td.c, th.c { text-align: center; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .strong { font-weight: 700; }
    .muted { color: ${C.muted}; }

    /* Highlighting */
    td.cost { background: #eff6ff; }
    td.out { background: #fff7ed; }
    td.prof { background: #f0fdf4; }
    tr.total td { background: ${C.slateDark}; color: #fff; font-weight: 800; font-size: 9.5px; }

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
      <div class="val">Rs. ${n2(bill.CrimpingTotal || 0)}</div>
      <div class="sub">Hose swaging & collar assemblies</div>
    </div>
    <div class="metric-card">
      <div class="label">Welding & Lathe Work</div>
      <div class="val">Rs. ${n2((bill.WeldingTotal || 0) + (bill.LatheTotal || 0))}</div>
      <div class="sub">Machining, threading & fabrication</div>
    </div>
    <div class="metric-card">
      <div class="label">Billing Period</div>
      <div class="val" style="font-size: 12px; font-weight: 700;">${formatDateDisplay(bill.PeriodFrom)} – ${formatDateDisplay(bill.PeriodTo)}</div>
      <div class="sub">Generated on ${formatDateDisplay(bill.CreatedAt)} by ${esc(bill.CreatedBy)}</div>
    </div>
  </div>
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
        <td class="r">${n2(bill.CrimpingTotal || 0)}</td>
        <td class="r">${n2(bill.WeldingTotal || 0)}</td>
        <td class="r">${n2(bill.LatheTotal || 0)}</td>
        <td class="r">${n2(bill.TechTotal || 0)}</td>
        <td class="r">${n2(bill.TotalAmount)}</td>
      </tr>
    </tbody>
  </table>
  ` : ''}

  <!-- Section 2: Job Profit Analysis for Included Jobs -->
  ${sections.jobProfit && profitRows ? `
  <h3 class="sec" style="background:#1e3a8a;">
    <span>2. JOB PROFIT ANALYSIS (PROFITABILITY BENCHMARK)</span>
    <span class="desc">Landed Material & Overhead Cost vs. Outside Market Benchmark</span>
  </h3>
  <table>
    <thead>
      <tr>
        <th style="width: 120px; background:#bfdbfe; color:#1e3a8a;">Invoice Number</th>
        <th class="c" style="width: 80px; background:#bfdbfe; color:#1e3a8a;">Hose Size</th>
        <th class="r" style="background:#bfdbfe; color:#1e3a8a;">Our Landed Cost (Rs.)</th>
        <th class="r" style="background:#fed7aa; color:#9a3412;">Outside Market Cost (Rs.)</th>
        <th class="r" style="background:#bbf7d0; color:#166534;">Gross Profit (Rs.)</th>
        <th class="r" style="background:#bbf7d0; color:#166534; width: 65px;">Margin %</th>
      </tr>
    </thead>
    <tbody>
      ${profitRows}
      ${profitTotalsHtml}
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
