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
  Search
} from 'lucide-react';

export const JobProfitPage: React.FC = () => {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  const loadProfitData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);

      const res = await apiRequest(`/job-profit?${params.toString()}`);
      setData(res || null);
    } catch (err) {
      console.error('Failed to load job profit analysis', err);
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

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
      return (
        inv.InvoiceNo.toLowerCase().includes(q) ||
        (inv.BilledToName && inv.BilledToName.toLowerCase().includes(q))
      );
    });
  }, [data, search]);

  const totals = data?.totals || {
    ourCost: 0,
    ourBill: 0,
    profit: 0,
    marginPct: 0,
    outsideCost: 0,
    savings: 0,
  };

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Net Billed Revenue</p>
          <p className="text-2xl font-bold text-slate-900 mt-2">{formatLKR(totals.ourBill)}</p>
          <p className="text-xs text-slate-400 mt-1">Ex-tax sales value</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Landed Materials Cost</p>
          <p className="text-2xl font-bold text-slate-700 mt-2">{formatLKR(totals.ourCost)}</p>
          <p className="text-xs text-slate-400 mt-1">Stock COGS consumed</p>
        </div>

        <div className="bg-white rounded-2xl border border-emerald-200 p-5 shadow-sm bg-emerald-50/20">
          <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wider flex items-center gap-1.5">
            <DollarSign className="w-4 h-4 text-emerald-600" /> Gross Profit
          </p>
          <p className="text-2xl font-bold text-emerald-700 mt-2">{formatLKR(totals.profit)}</p>
          <p className="text-xs text-emerald-600 mt-1">Overall Gross Margin: <span className="font-bold">{totals.marginPct}%</span></p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Client Savings vs Market</p>
          <p className="text-2xl font-bold text-indigo-600 mt-2">{formatLKR(totals.savings)}</p>
          <p className="text-xs text-slate-400 mt-1">Competitive pricing advantage</p>
        </div>
      </div>

      {/* Date & Filter Toolbar */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
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
        </div>

        <div className="flex items-center gap-2.5 w-full md:w-auto justify-end">
          <div className="relative flex-1 md:w-64">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Filter by invoice or client..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
            />
          </div>

          <a
            href={`/api/job-profit/pdf?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`}
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

      {/* Profit Analysis Table */}
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
                <th className="py-3.5 px-4 text-right">Outside Market</th>
                <th className="py-3.5 px-4 text-center">Tech Labour</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                    Calculating margin intelligence and market comparisons...
                  </td>
                </tr>
              ) : invoices.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    <TrendingUp className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                    No finalized invoices match the selected date window.
                  </td>
                </tr>
              ) : (
                invoices.map((row: any) => {
                  const margin = row.MarginPercent || 0;
                  const isHealthy = margin >= 40;
                  const isLow = margin < 25;
                  const techPaid = !!row.TechChargePaid;
                  return (
                    <tr key={row.InvoiceID} className="hover:bg-slate-50/60 transition">
                      <td className="py-3.5 px-4 font-bold text-slate-900">
                        {row.InvoiceNo}
                        {row.IsInternal === 1 && (
                          <span className="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200">
                            INT
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-slate-500 whitespace-nowrap text-xs">
                        {formatDate(row.InvoiceDate)}
                      </td>
                      <td className="py-3.5 px-4 font-medium text-slate-800">
                        {row.BilledToName}
                      </td>
                      <td className="py-3.5 px-4 text-right text-slate-600 whitespace-nowrap">
                        {formatLKR(row.OurCost)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-semibold text-slate-900 whitespace-nowrap">
                        {formatLKR(row.OurBill)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-bold whitespace-nowrap">
                        <span className={row.Profit < 0 ? 'text-rose-600' : 'text-emerald-600'}>
                          {formatLKR(row.Profit)}
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
                          {margin}%
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right text-slate-500 whitespace-nowrap text-xs">
                        {formatLKR(row.OutsideCost)}
                      </td>
                      <td className="py-3.5 px-4 text-center whitespace-nowrap">
                        <button
                          onClick={() => handleToggleLabourPaid(row.InvoiceNo, techPaid)}
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-semibold transition ${
                            techPaid
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                              : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100'
                          }`}
                          title="Click to toggle technician charge settlement"
                        >
                          {techPaid ? (
                            <>
                              <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Settled
                            </>
                          ) : (
                            <>
                              <Clock className="w-3 h-3 text-amber-600" /> Accrued
                            </>
                          )}
                        </button>
                      </td>
                    </tr>
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
