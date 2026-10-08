import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { apiRequest } from '../api/client';
import { Account, JournalEntry, TrialBalance, ProfitAndLoss, AccountLedgerResponse, AccountLedgerLine } from '../types/models';
import { formatLKR, formatDate } from '../utils/format';
import {
  BookOpen,
  Scale,
  FileSpreadsheet,
  Layers,
  CheckCircle2,
  AlertCircle,
  Loader2,
  X,
  Search,
  Download,
  ExternalLink,
  ArrowUpRight,
  ArrowDownLeft,
  Filter
} from 'lucide-react';

export const LedgerPage: React.FC = () => {
  // Tabs: 'accounts' | 'journals' | 'trial-balance' | 'pl'
  const [activeTab, setActiveTab] = useState<'accounts' | 'journals' | 'trial-balance' | 'pl'>('accounts');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [journals, setJournals] = useState<JournalEntry[]>([]);
  const [trialBalance, setTrialBalance] = useState<TrialBalance | null>(null);
  const [pl, setPl] = useState<ProfitAndLoss | null>(null);

  const [loading, setLoading] = useState<boolean>(true);

  // Account Ledger Modal State
  const [selectedAccountCode, setSelectedAccountCode] = useState<string | null>(null);
  const [ledgerData, setLedgerData] = useState<AccountLedgerResponse | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState<boolean>(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [ledgerSearch, setLedgerSearch] = useState<string>('');
  const [ledgerFilter, setLedgerFilter] = useState<'all' | 'debit' | 'credit'>('all');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (activeTab === 'accounts') {
        const res = await apiRequest<Account[]>('/accounts');
        setAccounts(Array.isArray(res) ? res : []);
      } else if (activeTab === 'journals') {
        const res = await apiRequest<JournalEntry[]>('/ledger/journals');
        setJournals(Array.isArray(res) ? res : []);
      } else if (activeTab === 'trial-balance') {
        const res = await apiRequest<TrialBalance>('/ledger/trial-balance');
        setTrialBalance(res || null);
      } else if (activeTab === 'pl') {
        const res = await apiRequest<ProfitAndLoss>('/ledger/pl');
        setPl(res || null);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Fetch individual account transactions when modal is opened
  const loadAccountLedger = useCallback(async (code: string, from?: string, to?: string) => {
    setLedgerLoading(true);
    setLedgerError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const query = params.toString() ? `?${params.toString()}` : '';
      const data = await apiRequest<AccountLedgerResponse>(`/ledger/account/${encodeURIComponent(code)}${query}`);
      setLedgerData(data);
    } catch (err: any) {
      setLedgerError(err.message || 'Failed to load account ledger transactions.');
    } finally {
      setLedgerLoading(false);
    }
  }, []);

  const openAccountLedger = (code: string) => {
    setSelectedAccountCode(code);
    setLedgerSearch('');
    setLedgerFilter('all');
    setFromDate('');
    setToDate('');
    loadAccountLedger(code);
  };

  const closeAccountLedger = () => {
    setSelectedAccountCode(null);
    setLedgerData(null);
    setLedgerError(null);
  };

  const handleDateFilterApply = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedAccountCode) {
      loadAccountLedger(selectedAccountCode, fromDate, toDate);
    }
  };

  const handleDateFilterReset = () => {
    setFromDate('');
    setToDate('');
    if (selectedAccountCode) {
      loadAccountLedger(selectedAccountCode);
    }
  };

  // Filter lines locally by search and debit/credit filter
  const filteredLines = useMemo(() => {
    if (!ledgerData || !ledgerData.lines) return [];
    return ledgerData.lines.filter((line: AccountLedgerLine) => {
      // Type filter
      if (ledgerFilter === 'debit' && line.debit <= 0) return false;
      if (ledgerFilter === 'credit' && line.credit <= 0) return false;

      // Text search
      if (ledgerSearch.trim()) {
        const query = ledgerSearch.toLowerCase();
        const entryNo = (line.entryNo || '').toLowerCase();
        const memo = (line.memo || '').toLowerCase();
        const sourceType = (line.sourceType || '').toLowerCase();
        const debitStr = String(line.debit);
        const creditStr = String(line.credit);
        return entryNo.includes(query) || memo.includes(query) || sourceType.includes(query) || debitStr.includes(query) || creditStr.includes(query);
      }
      return true;
    });
  }, [ledgerData, ledgerSearch, ledgerFilter]);

  // Aggregate stats for current ledger modal
  const ledgerStats = useMemo(() => {
    if (!ledgerData || !ledgerData.lines) return { totalDebits: 0, totalCredits: 0, debitCount: 0, creditCount: 0 };
    let totalDebits = 0;
    let totalCredits = 0;
    let debitCount = 0;
    let creditCount = 0;

    for (const l of ledgerData.lines) {
      if (l.debit > 0) {
        totalDebits += l.debit;
        debitCount++;
      }
      if (l.credit > 0) {
        totalCredits += l.credit;
        creditCount++;
      }
    }
    return {
      totalDebits: Math.round(totalDebits * 100) / 100,
      totalCredits: Math.round(totalCredits * 100) / 100,
      debitCount,
      creditCount,
    };
  }, [ledgerData]);

  // Export current modal transactions to CSV
  const exportLedgerCsv = () => {
    if (!ledgerData) return;
    const headers = ['Entry No', 'Date', 'Source Type', 'Memo / Details', 'Debit (LKR)', 'Credit (LKR)', 'Running Balance (LKR)'];
    const rows = filteredLines.map(l => [
      `"${l.entryNo}"`,
      `"${l.date}"`,
      `"${l.sourceType}"`,
      `"${(l.memo || '').replace(/"/g, '""')}"`,
      l.debit,
      l.credit,
      l.balance
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `ledger_${ledgerData.account.code}_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getSourceBadgeColor = (source: string) => {
    const s = (source || '').toLowerCase();
    if (s.includes('invoice')) return 'bg-blue-50 text-blue-700 border-blue-200';
    if (s.includes('payment')) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (s.includes('expense')) return 'bg-amber-50 text-amber-700 border-amber-200';
    if (s.includes('labour')) return 'bg-purple-50 text-purple-700 border-purple-200';
    if (s.includes('purchase')) return 'bg-indigo-50 text-indigo-700 border-indigo-200';
    if (s.includes('reversal')) return 'bg-rose-50 text-rose-700 border-rose-200';
    return 'bg-slate-100 text-slate-700 border-slate-200';
  };

  return (
    <div className="space-y-6">
      {/* Navigation Tabs */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-sm flex items-center gap-1.5 overflow-x-auto">
        {[
          { id: 'accounts', label: 'Chart of Accounts', icon: Layers },
          { id: 'journals', label: 'General Journal Entries', icon: BookOpen },
          { id: 'trial-balance', label: 'Trial Balance', icon: Scale },
          { id: 'pl', label: 'Profit & Loss Statement', icon: FileSpreadsheet },
        ].map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id as any)}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 whitespace-nowrap ${
                activeTab === t.id
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: CHART OF ACCOUNTS */}
      {activeTab === 'accounts' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-bold text-slate-800 text-sm">General Ledger Chart of Accounts</h3>
              <p className="text-xs text-slate-500 mt-0.5">Click any account code to view its complete audit trail & transaction history.</p>
            </div>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
              {accounts.length} Accounts Configured
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                <tr>
                  <th className="py-3.5 px-4">Code</th>
                  <th className="py-3.5 px-4">Account Name</th>
                  <th className="py-3.5 px-4">Type</th>
                  <th className="py-3.5 px-4 text-right">Debit (LKR)</th>
                  <th className="py-3.5 px-4 text-right">Credit (LKR)</th>
                  <th className="py-3.5 px-4 text-right">Net Balance (LKR)</th>
                  <th className="py-3.5 px-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                      Loading chart of accounts...
                    </td>
                  </tr>
                ) : accounts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      No accounts registered in ledger.
                    </td>
                  </tr>
                ) : (
                  accounts.map((acc) => (
                    <tr key={acc.AccountID} className="hover:bg-indigo-50/30 transition group">
                      <td className="py-3.5 px-4 font-mono font-bold">
                        <button
                          type="button"
                          onClick={() => openAccountLedger(acc.Code)}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold border border-indigo-200 hover:border-indigo-300 transition shadow-2xs group-hover:shadow-xs"
                          title={`Click to view all transactions for ${acc.Code} — ${acc.Name}`}
                        >
                          <span>{acc.Code}</span>
                          <ExternalLink className="w-3 h-3 text-indigo-500 opacity-70 group-hover:opacity-100" />
                        </button>
                      </td>
                      <td className="py-3.5 px-4 font-medium text-slate-800">{acc.Name}</td>
                      <td className="py-3.5 px-4">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                          {acc.Type}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right text-slate-600 font-mono">{formatLKR(acc.Debit)}</td>
                      <td className="py-3.5 px-4 text-right text-slate-600 font-mono">{formatLKR(acc.Credit)}</td>
                      <td className="py-3.5 px-4 text-right font-bold font-mono text-slate-900">{formatLKR(acc.Balance)}</td>
                      <td className="py-3.5 px-4 text-center">
                        <button
                          type="button"
                          onClick={() => openAccountLedger(acc.Code)}
                          className="px-3 py-1 text-xs font-semibold rounded-lg bg-white hover:bg-indigo-50 text-indigo-600 border border-slate-200 hover:border-indigo-300 transition shadow-2xs inline-flex items-center gap-1"
                        >
                          <BookOpen className="w-3 h-3 text-indigo-500" />
                          <span>View History</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: JOURNAL ENTRIES */}
      {activeTab === 'journals' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                <tr>
                  <th className="py-3.5 px-4">Journal #</th>
                  <th className="py-3.5 px-4">Date</th>
                  <th className="py-3.5 px-4">Source</th>
                  <th className="py-3.5 px-4">Reference</th>
                  <th className="py-3.5 px-4">Description</th>
                  <th className="py-3.5 px-4 text-right">Debit Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                      Loading journals...
                    </td>
                  </tr>
                ) : journals.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      No posted journals found.
                    </td>
                  </tr>
                ) : (
                  journals.map((j) => (
                    <tr key={j.JournalID} className="hover:bg-slate-50/60 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-slate-900">JNL-{j.JournalID}</td>
                      <td className="py-3.5 px-4 text-slate-500 text-xs">{formatDate(j.EntryDate)}</td>
                      <td className="py-3.5 px-4">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${getSourceBadgeColor(j.SourceType)}`}>
                          {j.SourceType}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs text-slate-700">{j.Reference || '—'}</td>
                      <td className="py-3.5 px-4 text-slate-600">{j.Description || '—'}</td>
                      <td className="py-3.5 px-4 text-right font-bold text-slate-900 font-mono">{formatLKR(j.Amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: TRIAL BALANCE */}
      {activeTab === 'trial-balance' && (
        <div className="space-y-4">
          {trialBalance && (
            <div className={`p-4 rounded-2xl border flex items-center justify-between ${
              trialBalance.totals.balanced
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}>
              <div className="flex items-center gap-2 font-bold text-sm">
                {trialBalance.totals.balanced ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-rose-600" />
                )}
                {trialBalance.totals.balanced
                  ? 'Double-Entry Invariant Verified: Debits Equal Credits'
                  : 'Ledger Imbalance Detected: Debits Do Not Equal Credits'}
              </div>
              <div className="text-sm font-semibold font-mono">
                Total: {formatLKR(trialBalance.totals.debit)}
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
            <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-bold text-slate-800 text-sm">Trial Balance Summary</h3>
                <p className="text-xs text-slate-500 mt-0.5">Click any account code to drill down into underlying ledger transactions.</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <tr>
                    <th className="py-3.5 px-4">Code</th>
                    <th className="py-3.5 px-4">Account Name</th>
                    <th className="py-3.5 px-4">Type</th>
                    <th className="py-3.5 px-4 text-right">Debit (LKR)</th>
                    <th className="py-3.5 px-4 text-right">Credit (LKR)</th>
                    <th className="py-3.5 px-4 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-slate-400">
                        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                        Generating trial balance...
                      </td>
                    </tr>
                  ) : !trialBalance || trialBalance.accounts.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-slate-400">
                        No balances recorded.
                      </td>
                    </tr>
                  ) : (
                    trialBalance.accounts.map((acc, idx) => (
                      <tr key={idx} className="hover:bg-indigo-50/30 transition group">
                        <td className="py-3.5 px-4 font-mono font-bold">
                          <button
                            type="button"
                            onClick={() => openAccountLedger(acc.code)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold border border-indigo-200 hover:border-indigo-300 transition shadow-2xs group-hover:shadow-xs"
                            title={`Click to view all transactions for ${acc.code} — ${acc.name}`}
                          >
                            <span>{acc.code}</span>
                            <ExternalLink className="w-3 h-3 text-indigo-500 opacity-70 group-hover:opacity-100" />
                          </button>
                        </td>
                        <td className="py-3.5 px-4 font-medium text-slate-800">{acc.name}</td>
                        <td className="py-3.5 px-4 text-slate-500 text-xs">{acc.type}</td>
                        <td className="py-3.5 px-4 text-right font-mono">{acc.debit > 0 ? formatLKR(acc.debit) : '—'}</td>
                        <td className="py-3.5 px-4 text-right font-mono">{acc.credit > 0 ? formatLKR(acc.credit) : '—'}</td>
                        <td className="py-3.5 px-4 text-center">
                          <button
                            type="button"
                            onClick={() => openAccountLedger(acc.code)}
                            className="px-3 py-1 text-xs font-semibold rounded-lg bg-white hover:bg-indigo-50 text-indigo-600 border border-slate-200 hover:border-indigo-300 transition shadow-2xs inline-flex items-center gap-1"
                          >
                            <BookOpen className="w-3 h-3 text-indigo-500" />
                            <span>View History</span>
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: PROFIT & LOSS */}
      {activeTab === 'pl' && (
        <div className="space-y-6">
          {pl && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <p className="text-xs font-semibold text-slate-500 uppercase">Operating Revenue</p>
                <p className="text-2xl font-bold text-slate-900 mt-2 font-mono">{formatLKR(pl.revenue)}</p>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <p className="text-xs font-semibold text-slate-500 uppercase">Cost of Goods Sold (COGS)</p>
                <p className="text-2xl font-bold text-slate-700 mt-2 font-mono">{formatLKR(pl.cogs)}</p>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <p className="text-xs font-semibold text-slate-500 uppercase">Gross Profit</p>
                <p className="text-2xl font-bold text-emerald-600 mt-2 font-mono">{formatLKR(pl.grossProfit)}</p>
              </div>

              <div className="bg-white rounded-2xl border border-emerald-200 p-5 shadow-sm bg-emerald-50/20">
                <p className="text-xs font-semibold text-emerald-700 uppercase">Net Operating Profit</p>
                <p className="text-2xl font-bold text-emerald-700 mt-2 font-mono">{formatLKR(pl.netProfit)}</p>
                <p className="text-xs text-emerald-600 mt-1">Margin: {pl.marginPct || 0}%</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* ACCOUNT TRANSACTIONS DRILL-DOWN MODAL                                     */}
      {/* ========================================================================= */}
      {selectedAccountCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-md">
                  <BookOpen className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-base font-extrabold text-indigo-700 px-2 py-0.5 rounded-lg bg-indigo-50 border border-indigo-200">
                      {selectedAccountCode}
                    </span>
                    <h2 className="text-lg font-bold text-slate-900">
                      {ledgerData?.account.name || 'Account Ledger'}
                    </h2>
                    {ledgerData?.account.type && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-200 text-slate-700 uppercase tracking-wide">
                        {ledgerData.account.type}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Complete double-entry journal lines, source references, and running balance.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Account quick switcher */}
                {accounts.length > 0 && (
                  <select
                    value={selectedAccountCode}
                    onChange={(e) => openAccountLedger(e.target.value)}
                    className="text-xs border border-slate-200 rounded-xl px-2.5 py-1.5 bg-white text-slate-700 font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {accounts.map((a) => (
                      <option key={a.Code} value={a.Code}>
                        {a.Code} — {a.Name}
                      </option>
                    ))}
                  </select>
                )}

                <button
                  type="button"
                  onClick={closeAccountLedger}
                  className="w-9 h-9 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center transition"
                  title="Close (Esc)"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {ledgerLoading ? (
                <div className="py-24 text-center text-slate-400">
                  <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mx-auto mb-3" />
                  <p className="font-semibold text-slate-700">Loading account transaction history...</p>
                  <p className="text-xs text-slate-400 mt-1">Retrieving verified journal records for {selectedAccountCode}</p>
                </div>
              ) : ledgerError ? (
                <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
                  <span className="text-sm font-semibold">{ledgerError}</span>
                </div>
              ) : ledgerData ? (
                <>
                  {/* Summary Metric Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
                    <div className="bg-slate-50/80 rounded-xl border border-slate-200/80 p-3.5">
                      <div className="flex items-center justify-between text-xs text-slate-500 font-semibold uppercase">
                        <span>Total Debits</span>
                        <ArrowUpRight className="w-4 h-4 text-emerald-600" />
                      </div>
                      <p className="text-xl font-bold text-slate-900 mt-1 font-mono">
                        {formatLKR(ledgerStats.totalDebits)}
                      </p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{ledgerStats.debitCount} debit postings</p>
                    </div>

                    <div className="bg-slate-50/80 rounded-xl border border-slate-200/80 p-3.5">
                      <div className="flex items-center justify-between text-xs text-slate-500 font-semibold uppercase">
                        <span>Total Credits</span>
                        <ArrowDownLeft className="w-4 h-4 text-rose-600" />
                      </div>
                      <p className="text-xl font-bold text-slate-900 mt-1 font-mono">
                        {formatLKR(ledgerStats.totalCredits)}
                      </p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{ledgerStats.creditCount} credit postings</p>
                    </div>

                    <div className="bg-indigo-50/50 rounded-xl border border-indigo-200/80 p-3.5">
                      <div className="flex items-center justify-between text-xs text-indigo-700 font-semibold uppercase">
                        <span>Closing Balance</span>
                        <Scale className="w-4 h-4 text-indigo-600" />
                      </div>
                      <p className="text-xl font-bold text-indigo-900 mt-1 font-mono">
                        {formatLKR(ledgerData.closing)}
                      </p>
                      <p className="text-[11px] text-indigo-700 mt-0.5">
                        {ledgerData.closing >= 0 ? 'Normal balance' : 'Overdrawn / Negative'}
                      </p>
                    </div>

                    <div className="bg-slate-50/80 rounded-xl border border-slate-200/80 p-3.5">
                      <div className="flex items-center justify-between text-xs text-slate-500 font-semibold uppercase">
                        <span>Transactions</span>
                        <Layers className="w-4 h-4 text-slate-600" />
                      </div>
                      <p className="text-xl font-bold text-slate-900 mt-1 font-mono">
                        {ledgerData.lines.length}
                      </p>
                      <p className="text-[11px] text-slate-500 mt-0.5">All time activity</p>
                    </div>
                  </div>

                  {/* Filter & Search Bar */}
                  <div className="bg-white rounded-xl border border-slate-200 p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-2xs">
                    <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[280px]">
                      {/* Search box */}
                      <div className="relative flex-1 min-w-[200px]">
                        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={ledgerSearch}
                          onChange={(e) => setLedgerSearch(e.target.value)}
                          placeholder="Search entry #, memo, source, or amount..."
                          className="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-slate-50/50"
                        />
                        {ledgerSearch && (
                          <button
                            type="button"
                            onClick={() => setLedgerSearch('')}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {/* Type Filter Buttons */}
                      <div className="flex items-center rounded-xl bg-slate-100 p-0.5 border border-slate-200 text-xs">
                        {(['all', 'debit', 'credit'] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setLedgerFilter(t)}
                            className={`px-3 py-1 rounded-lg font-semibold transition capitalize ${
                              ledgerFilter === t
                                ? 'bg-white text-indigo-700 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            {t === 'all' ? `All (${ledgerData.lines.length})` : t === 'debit' ? 'Debits' : 'Credits'}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Date Filter & Export */}
                    <div className="flex flex-wrap items-center gap-2">
                      <form onSubmit={handleDateFilterApply} className="flex items-center gap-1.5 text-xs">
                        <input
                          type="date"
                          value={fromDate}
                          onChange={(e) => setFromDate(e.target.value)}
                          className="border border-slate-200 rounded-lg px-2 py-1 bg-slate-50 text-slate-700 text-xs focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          title="From Date"
                        />
                        <span className="text-slate-400">to</span>
                        <input
                          type="date"
                          value={toDate}
                          onChange={(e) => setToDate(e.target.value)}
                          className="border border-slate-200 rounded-lg px-2 py-1 bg-slate-50 text-slate-700 text-xs focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                          title="To Date"
                        />
                        <button
                          type="submit"
                          className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold transition"
                        >
                          Apply
                        </button>
                        {(fromDate || toDate) && (
                          <button
                            type="button"
                            onClick={handleDateFilterReset}
                            className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold transition"
                            title="Reset date filter"
                          >
                            Reset
                          </button>
                        )}
                      </form>

                      <button
                        type="button"
                        onClick={exportLedgerCsv}
                        disabled={filteredLines.length === 0}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition shadow-2xs disabled:opacity-50"
                        title="Download CSV statement"
                      >
                        <Download className="w-3.5 h-3.5 text-slate-500" />
                        <span>Export CSV</span>
                      </button>
                    </div>
                  </div>

                  {/* Transactions Table */}
                  <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-2xs">
                    <div className="overflow-x-auto max-h-[50vh]">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50/90 sticky top-0 z-10 border-b border-slate-200 font-semibold text-slate-600 uppercase tracking-wider backdrop-blur-xs">
                          <tr>
                            <th className="py-3 px-3.5">Entry #</th>
                            <th className="py-3 px-3.5">Date</th>
                            <th className="py-3 px-3.5">Source</th>
                            <th className="py-3 px-3.5">Memo / Description</th>
                            <th className="py-3 px-3.5 text-right">Debit (LKR)</th>
                            <th className="py-3 px-3.5 text-right">Credit (LKR)</th>
                            <th className="py-3 px-3.5 text-right">Running Balance (LKR)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-slate-700">
                          {filteredLines.length === 0 ? (
                            <tr>
                              <td colSpan={7} className="py-12 text-center text-slate-400">
                                <Filter className="w-7 h-7 text-slate-300 mx-auto mb-2" />
                                <p className="font-semibold text-slate-600">No transactions match your search criteria.</p>
                                <p className="text-xs text-slate-400 mt-0.5">Try clearing your filters or choosing a wider date range.</p>
                              </td>
                            </tr>
                          ) : (
                            filteredLines.map((line, idx) => (
                              <tr key={idx} className="hover:bg-slate-50/80 transition">
                                <td className="py-2.5 px-3.5 font-mono font-bold text-slate-900 whitespace-nowrap">
                                  {line.entryNo}
                                </td>
                                <td className="py-2.5 px-3.5 text-slate-500 whitespace-nowrap">
                                  {formatDate(line.date)}
                                </td>
                                <td className="py-2.5 px-3.5 whitespace-nowrap">
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${getSourceBadgeColor(line.sourceType)}`}>
                                    {line.sourceType}
                                  </span>
                                </td>
                                <td className="py-2.5 px-3.5 text-slate-800 font-medium">
                                  {line.memo || '—'}
                                </td>
                                <td className="py-2.5 px-3.5 text-right font-mono font-semibold text-emerald-700 whitespace-nowrap">
                                  {line.debit > 0 ? formatLKR(line.debit) : '—'}
                                </td>
                                <td className="py-2.5 px-3.5 text-right font-mono font-semibold text-rose-700 whitespace-nowrap">
                                  {line.credit > 0 ? formatLKR(line.credit) : '—'}
                                </td>
                                <td className="py-2.5 px-3.5 text-right font-mono font-bold text-slate-900 whitespace-nowrap bg-slate-50/30">
                                  {formatLKR(line.balance)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : null}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/70 flex items-center justify-between text-xs text-slate-500">
              <div>
                Showing <span className="font-bold text-slate-800">{filteredLines.length}</span> of{' '}
                <span className="font-bold text-slate-800">{ledgerData?.lines.length ?? 0}</span> transactions
              </div>
              <button
                type="button"
                onClick={closeAccountLedger}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-bold transition shadow-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
