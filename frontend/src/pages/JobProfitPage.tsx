import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { formatLKR, formatDate } from '../utils/format';
import {
  TrendingUp,
  Download,
  Calendar,
  CheckCircle2,
  Clock,
  DollarSign,
  Loader2,
  RefreshCw,
  Search,
  ChevronDown,
  ChevronUp,
  Percent,
  Layers,
  Sparkles,
  Lock
} from 'lucide-react';

export const JobProfitPage: React.FC = () => {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unpaid' | 'paid'>('all');
  const [search, setSearch] = useState<string>('');
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<number | string | null>(null);

  const loadProfitData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      if (statusFilter !== 'all') params.set('status', statusFilter);

      const res = await apiRequest(`/job-profit?${params.toString()}`);
      setData(res || null);
    } catch (err) {
      console.error('Failed to load job profit analysis', err);
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, statusFilter]);

  useEffect(() => {
    loadProfitData();
  }, [loadProfitData]);

  // Quick month filter
  const handleSetThisMonth = () => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    setFromDate(first);
    setToDate(last);
  };

  const handleClearDates = () => {
    setFromDate('');
    setToDate('');
  };

  // Toggle labour paid status
  const handleToggleLabourPaid = async (invNo: string, currentPaid: boolean) => {
    try {
      await apiRequest('/job-profit/mark-paid', {
        method: 'POST',
        body: JSON.stringify({
          invoiceNumbers: [invNo],
          paid: !currentPaid,
        }),
      });
      await loadProfitData();
    } catch (err: any) {
      alert(err.message || 'Error updating technician payment');
    }
  };

  const invoices = useMemo(() => {
    if (!data || !Array.isArray(data.invoices)) return [];
    return data.invoices.filter((inv: any) => {
      const q = search.toLowerCase().trim();
      if (!q) return true;
      const invNo = String(inv.invoiceNo || inv.InvoiceNo || '').toLowerCase();
      const customer = String(inv.customer || inv.BilledToName || '').toLowerCase();
      return invNo.includes(q) || customer.includes(q);
    });
  }, [data, search]);

  const totals = useMemo(() => {
    const t = data?.totals || {};
    // Calculate fallback totals from invoices array if t is missing or search is active
    let calcFromInvoices: any = null;
    if (invoices.length > 0 && (!data?.totals || search.trim())) {
      const calc = invoices.reduce((acc: any, inv: any) => {
        const cost = Number(inv.ourCost ?? inv.OurCost ?? 0);
        const bill = Number(inv.ourBill ?? inv.ourPrice ?? inv.OurBill ?? 0);
        const prof = Number(inv.profit ?? inv.Profit ?? (bill - cost));
        const saving = Number(inv.customerSaving ?? (Number(inv.outsidePrice ?? inv.outsideCost ?? 0) - bill));
        const tech = Number(inv.techCharges ?? 0);
        const unpaid = inv.techPaid ? 0 : tech;
        return {
          ourBill: acc.ourBill + bill,
          ourCost: acc.ourCost + cost,
          profit: acc.profit + prof,
          customerSaving: acc.customerSaving + Math.max(0, saving),
          techCharges: acc.techCharges + tech,
          unpaidTech: acc.unpaidTech + unpaid,
        };
      }, { ourBill: 0, ourCost: 0, profit: 0, customerSaving: 0, techCharges: 0, unpaidTech: 0 });

      const margin = calc.ourBill > 0 ? (calc.profit / calc.ourBill) * 100 : 0;
      calcFromInvoices = {
        ...calc,
        margin,
        sourcingGain: Number(t.sourcingGain ?? 0),
        count: invoices.length,
        unpaidCount: invoices.filter((i: any) => !i.techPaid && Number(i.techCharges || 0) > 0).length,
      };
    }

    const src = (search.trim() && calcFromInvoices) ? calcFromInvoices : t;

    const ourBill = Number(src.ourBill ?? src.ourPrice ?? calcFromInvoices?.ourBill ?? 0);
    const ourCost = Number(src.ourCost ?? src.materialCost ?? calcFromInvoices?.ourCost ?? 0);
    const profit = Number(src.profit ?? src.grossProfit ?? calcFromInvoices?.profit ?? 0);
    const margin = src.margin != null ? Number(src.margin) : (src.grossMarginPct != null ? Number(src.grossMarginPct) : (calcFromInvoices?.margin ?? 0));
    const customerSaving = Number(src.customerSaving ?? src.savings ?? calcFromInvoices?.customerSaving ?? 0);
    const sourcingGain = Number(src.sourcingGain ?? calcFromInvoices?.sourcingGain ?? 0);
    const techCharges = Number(src.techCharges ?? calcFromInvoices?.techCharges ?? 0);
    const unpaidTech = Number(src.unpaidTech ?? calcFromInvoices?.unpaidTech ?? 0);
    const count = Number(src.count ?? invoices.length);
    const unpaidCount = Number(src.unpaidCount ?? calcFromInvoices?.unpaidCount ?? 0);

    return {
      ourBill,
      ourCost,
      profit,
      margin,
      customerSaving,
      sourcingGain,
      techCharges,
      unpaidTech,
      count,
      unpaidCount,
    };
  }, [data, invoices, search]);

  return (
    <div className="space-y-6">
      {/* KPI Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Net Billed Revenue */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Net Billed Revenue</p>
          <p className="text-2xl font-bold text-slate-900 mt-2">{formatLKR(totals.ourBill)}</p>
          <p className="text-xs text-slate-400 mt-1">Ex-tax sales value ({totals.count} jobs)</p>
        </div>

        {/* Landed Materials Cost */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Landed Materials Cost</p>
          <p className="text-2xl font-bold text-slate-700 mt-2">{formatLKR(totals.ourCost)}</p>
          <p className="text-xs text-slate-400 mt-1">Direct stock COGS consumed</p>
        </div>

        {/* Gross Profit & Margin */}
        <div className="bg-white rounded-2xl border border-emerald-200 p-5 shadow-sm bg-emerald-50/25">
          <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wider flex items-center gap-1.5">
            <DollarSign className="w-4 h-4 text-emerald-600" /> Gross Profit
          </p>
          <p className="text-2xl font-bold text-emerald-700 mt-2">{formatLKR(totals.profit)}</p>
          <p className="text-xs text-emerald-600 mt-1 flex items-center gap-1">
            <Percent className="w-3.5 h-3.5" /> Overall Gross Margin: <span className="font-bold">{totals.margin.toFixed(1)}%</span>
          </p>
        </div>

        {/* Client Savings vs Outside Market */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-indigo-500" /> Client Market Savings
          </p>
          <p className="text-2xl font-bold text-indigo-600 mt-2">{formatLKR(totals.customerSaving)}</p>
          <p className="text-xs text-slate-400 mt-1">Competitive pricing advantage</p>
        </div>

        {/* Technician Labour Pool */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-amber-500" /> Tech Labour Accrual
          </p>
          <p className="text-2xl font-bold text-slate-900 mt-2">{formatLKR(totals.techCharges)}</p>
          <p className="text-xs text-amber-600 mt-1 font-medium">
            {totals.unpaidTech > 0 ? `${formatLKR(totals.unpaidTech)} pending payout` : 'All labour settled'}
          </p>
        </div>
      </div>

      {/* Date & Filter Toolbar */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
          {/* Date range picker */}
          <div className="flex items-center gap-1.5 text-xs text-slate-600 bg-slate-50 px-3 py-1.5 border border-slate-200 rounded-xl">
            <Calendar className="w-3.5 h-3.5 text-slate-400" />
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-transparent border-0 p-0 text-xs focus:ring-0"
              title="From Date"
            />
            <span className="text-slate-400">to</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-transparent border-0 p-0 text-xs focus:ring-0"
              title="To Date"
            />
          </div>

          <button
            onClick={handleSetThisMonth}
            className="px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700 transition"
          >
            This Month
          </button>
          <button
            onClick={handleClearDates}
            className="px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-500 transition"
          >
            All Dates
          </button>

          {/* Labour status filter pills */}
          <div className="flex items-center bg-slate-100 p-0.5 rounded-xl border border-slate-200 text-xs font-medium ml-1">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-2.5 py-1 rounded-lg transition ${
                statusFilter === 'all' ? 'bg-white shadow-xs text-slate-900 font-semibold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All Jobs
            </button>
            <button
              onClick={() => setStatusFilter('unpaid')}
              className={`px-2.5 py-1 rounded-lg transition ${
                statusFilter === 'unpaid' ? 'bg-white shadow-xs text-amber-700 font-semibold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Unpaid Labour ({totals.unpaidCount})
            </button>
            <button
              onClick={() => setStatusFilter('paid')}
              className={`px-2.5 py-1 rounded-lg transition ${
                statusFilter === 'paid' ? 'bg-white shadow-xs text-emerald-700 font-semibold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Paid Labour
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2.5 w-full md:w-auto justify-end">
          <div className="relative flex-1 md:w-64">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by invoice # or client..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
            />
          </div>

          <a
            href={`/api/job-profit/pdf?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}&status=${encodeURIComponent(statusFilter)}`}
            target="_blank"
            rel="noreferrer"
            className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-sm transition flex items-center gap-1.5 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" /> PDF Summary
          </a>

          <button
            onClick={loadProfitData}
            title="Refresh Analysis"
            className="p-1.5 border border-slate-200 hover:bg-slate-50 rounded-xl text-slate-600 transition"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Profit Analysis Data Table */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th className="py-3.5 px-4">Invoice</th>
                <th className="py-3.5 px-4">Date</th>
                <th className="py-3.5 px-4">Customer</th>
                <th className="py-3.5 px-4 text-right">Landed Cost</th>
                <th className="py-3.5 px-4 text-right">Billed (Our Price)</th>
                <th className="py-3.5 px-4 text-right">Job Profit</th>
                <th className="py-3.5 px-4 text-center">Margin %</th>
                <th className="py-3.5 px-4 text-right">Outside Benchmark</th>
                <th className="py-3.5 px-4 text-center">Tech Labour</th>
                <th className="py-3.5 px-4 text-center">Lines</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                    Calculating margin intelligence and market comparisons...
                  </td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-12 text-center text-slate-400">
                    <TrendingUp className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                    No finalized invoices match the selected date window or filter.
                  </td>
                </tr>
              ) : (
                invoices.map((row: any) => {
                  const invId = row.invoiceId ?? row.InvoiceID;
                  const invNo = String(row.invoiceNo ?? row.InvoiceNo ?? '—');
                  const invDate = row.invoiceDate ?? row.InvoiceDate;
                  const customer = String(row.customer ?? row.BilledToName ?? 'Walk-in');
                  const ourCost = Number(row.ourCost ?? row.OurCost ?? 0);
                  const ourBill = Number(row.ourBill ?? row.ourPrice ?? row.OurBill ?? 0);
                  const profit = Number(row.profit ?? row.Profit ?? 0);
                  const margin = Number(row.margin ?? row.MarginPercent ?? 0);
                  const outsidePrice = Number(row.outsidePrice ?? row.outsideCost ?? 0);
                  const techCharges = Number(row.techCharges ?? 0);
                  const techPaid = !!(row.techPaid ?? row.TechChargePaid);
                  const lines = Array.isArray(row.lines) ? row.lines : [];

                  const isInternal =
                    row.isInternal === 1 ||
                    row.IsInternal === 1 ||
                    customer.startsWith('VR-') ||
                    customer.startsWith('HEX-') ||
                    customer.startsWith('SL -');

                  const isHealthy = margin >= 40;
                  const isLow = margin < 25;
                  const isExpanded = expandedInvoiceId === invId;

                  return (
                    <React.Fragment key={invId || invNo}>
                      <tr className={`hover:bg-slate-50/60 transition ${isExpanded ? 'bg-slate-50/80' : ''}`}>
                        <td className="py-3.5 px-4 font-bold text-slate-900 whitespace-nowrap">
                          {invNo}
                          {isInternal && (
                            <span className="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200">
                              INT
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-slate-500 whitespace-nowrap text-xs">
                          {formatDate(invDate)}
                        </td>
                        <td className="py-3.5 px-4 font-medium text-slate-800">
                          {customer}
                        </td>
                        <td className="py-3.5 px-4 text-right text-slate-600 whitespace-nowrap font-mono text-xs">
                          {formatLKR(ourCost)}
                        </td>
                        <td className="py-3.5 px-4 text-right font-semibold text-slate-900 whitespace-nowrap font-mono text-xs">
                          {formatLKR(ourBill)}
                        </td>
                        <td className="py-3.5 px-4 text-right font-bold whitespace-nowrap font-mono text-xs">
                          <span className={profit < 0 ? 'text-rose-600' : 'text-emerald-600'}>
                            {formatLKR(profit)}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${
                              isHealthy
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : isLow
                                ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                : 'bg-amber-50 text-amber-700 border border-amber-200'
                            }`}
                          >
                            {margin.toFixed(1)}%
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right text-slate-500 whitespace-nowrap font-mono text-xs">
                          {formatLKR(outsidePrice)}
                        </td>
                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          {techCharges > 0 ? (
                            row.labourBill ? (
                              <span
                                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-semibold ${
                                  row.labourBill.status === 'CLOSED'
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                    : 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                                }`}
                                title={`Managed by Labour Bill ${row.labourBill.billNo} (${row.labourBill.status})`}
                              >
                                <Lock className="w-3 h-3" />
                                {row.labourBill.billNo}
                              </span>
                            ) : (
                              <button
                                onClick={() => handleToggleLabourPaid(invNo, techPaid)}
                                className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-semibold transition ${
                                  techPaid
                                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                                    : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100'
                                }`}
                                title="Click to toggle technician labour settlement"
                              >
                                {techPaid ? (
                                  <>
                                    <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Settled
                                  </>
                                ) : (
                                  <>
                                    <Clock className="w-3 h-3 text-amber-600" /> {formatLKR(techCharges)} Accrued
                                  </>
                                )}
                              </button>
                            )
                          ) : (
                            <span className="text-slate-400 text-xs">—</span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          {lines.length > 0 && (
                            <button
                              onClick={() => setExpandedInvoiceId(isExpanded ? null : invId)}
                              className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-medium px-2 py-1 rounded-lg hover:bg-indigo-50 transition"
                            >
                              {lines.length} {lines.length === 1 ? 'item' : 'items'}
                              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </td>
                      </tr>

                      {/* Expandable itemized lines breakdown */}
                      {isExpanded && lines.length > 0 && (
                        <tr className="bg-slate-50/70 border-b border-slate-200">
                          <td colSpan={10} className="px-6 py-4">
                            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xs">
                              <div className="px-4 py-2.5 bg-slate-100/60 border-b border-slate-200 flex items-center justify-between text-xs font-semibold text-slate-700">
                                <span>Itemised Line Details for {invNo}</span>
                                <span className="text-slate-500">{lines.length} components consumed</span>
                              </div>
                              <table className="w-full text-xs text-left">
                                <thead className="bg-slate-50 border-b border-slate-100 text-slate-500 font-semibold uppercase tracking-wider">
                                  <tr>
                                    <th className="py-2 px-3">Description</th>
                                    <th className="py-2 px-3 text-center">Unit</th>
                                    <th className="py-2 px-3 text-right">Qty</th>
                                    <th className="py-2 px-3 text-right">Our Cost</th>
                                    <th className="py-2 px-3 text-right">Billed Rate</th>
                                    <th className="py-2 px-3 text-right">Our Total</th>
                                    <th className="py-2 px-3 text-right">Outside Rate</th>
                                    <th className="py-2 px-3 text-right">Line Profit</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 font-mono">
                                  {lines.map((l: any, idx: number) => {
                                    const lProfit = Number(l.grossProfit ?? (l.ourAmount - l.ourCost));
                                    return (
                                      <tr key={idx} className="hover:bg-slate-50/50">
                                        <td className="py-2 px-3 font-sans font-medium text-slate-800">
                                          {l.description}
                                          {l.isTech && (
                                            <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 font-sans">
                                              Labour
                                            </span>
                                          )}
                                        </td>
                                        <td className="py-2 px-3 text-center text-slate-500 font-sans">{l.unit || 'Nos'}</td>
                                        <td className="py-2 px-3 text-right text-slate-700">{l.qty}</td>
                                        <td className="py-2 px-3 text-right text-slate-600">{formatLKR(l.ourCostRate)}</td>
                                        <td className="py-2 px-3 text-right text-slate-900 font-semibold">{formatLKR(l.ourBilledRate)}</td>
                                        <td className="py-2 px-3 text-right text-slate-900 font-semibold">{formatLKR(l.ourAmount)}</td>
                                        <td className="py-2 px-3 text-right text-slate-500">{formatLKR(l.outsideRate)}</td>
                                        <td className="py-2 px-3 text-right font-bold">
                                          <span className={lProfit < 0 ? 'text-rose-600' : 'text-emerald-600'}>
                                            {formatLKR(lProfit)}
                                          </span>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
