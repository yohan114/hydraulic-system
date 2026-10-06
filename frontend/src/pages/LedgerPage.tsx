import React, { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { Account, JournalEntry, TrialBalance, ProfitAndLoss } from '../types/models';
import { formatLKR, formatDate } from '../utils/format';
import {
  BookOpen,
  Scale,
  FileSpreadsheet,
  Layers,
  CheckCircle2,
  AlertCircle,
  Loader2
} from 'lucide-react';

export const LedgerPage: React.FC = () => {
  // Tabs: 'accounts' | 'journals' | 'trial-balance' | 'pl'
  const [activeTab, setActiveTab] = useState<'accounts' | 'journals' | 'trial-balance' | 'pl'>('accounts');

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [journals, setJournals] = useState<JournalEntry[]>([]);
  const [trialBalance, setTrialBalance] = useState<TrialBalance | null>(null);
  const [pl, setPl] = useState<ProfitAndLoss | null>(null);

  const [loading, setLoading] = useState<boolean>(true);

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
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                      Loading chart of accounts...
                    </td>
                  </tr>
                ) : accounts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      No accounts registered in ledger.
                    </td>
                  </tr>
                ) : (
                  accounts.map((acc) => (
                    <tr key={acc.AccountID} className="hover:bg-slate-50/60 transition">
                      <td className="py-3.5 px-4 font-mono font-bold text-slate-900">{acc.Code}</td>
                      <td className="py-3.5 px-4 font-medium text-slate-800">{acc.Name}</td>
                      <td className="py-3.5 px-4">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                          {acc.Type}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right text-slate-600">{formatLKR(acc.Debit)}</td>
                      <td className="py-3.5 px-4 text-right text-slate-600">{formatLKR(acc.Credit)}</td>
                      <td className="py-3.5 px-4 text-right font-bold text-slate-900">{formatLKR(acc.Balance)}</td>
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
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                          {j.SourceType}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 font-mono text-xs text-slate-700">{j.Reference || '—'}</td>
                      <td className="py-3.5 px-4 text-slate-600">{j.Description || '—'}</td>
                      <td className="py-3.5 px-4 text-right font-bold text-slate-900">{formatLKR(j.Amount)}</td>
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
              <div className="text-sm font-semibold">
                Total: {formatLKR(trialBalance.totals.debit)}
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <tr>
                    <th className="py-3.5 px-4">Code</th>
                    <th className="py-3.5 px-4">Account Name</th>
                    <th className="py-3.5 px-4">Type</th>
                    <th className="py-3.5 px-4 text-right">Debit (LKR)</th>
                    <th className="py-3.5 px-4 text-right">Credit (LKR)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-slate-400">
                        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                        Generating trial balance...
                      </td>
                    </tr>
                  ) : !trialBalance || trialBalance.accounts.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-slate-400">
                        No balances recorded.
                      </td>
                    </tr>
                  ) : (
                    trialBalance.accounts.map((acc, idx) => (
                      <tr key={idx} className="hover:bg-slate-50/60 transition">
                        <td className="py-3.5 px-4 font-mono font-bold text-slate-900">{acc.code}</td>
                        <td className="py-3.5 px-4 font-medium text-slate-800">{acc.name}</td>
                        <td className="py-3.5 px-4 text-slate-500 text-xs">{acc.type}</td>
                        <td className="py-3.5 px-4 text-right font-mono">{acc.debit > 0 ? formatLKR(acc.debit) : '—'}</td>
                        <td className="py-3.5 px-4 text-right font-mono">{acc.credit > 0 ? formatLKR(acc.credit) : '—'}</td>
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
                <p className="text-2xl font-bold text-slate-900 mt-2">{formatLKR(pl.revenue)}</p>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <p className="text-xs font-semibold text-slate-500 uppercase">Cost of Goods Sold (COGS)</p>
                <p className="text-2xl font-bold text-slate-700 mt-2">{formatLKR(pl.cogs)}</p>
              </div>

              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <p className="text-xs font-semibold text-slate-500 uppercase">Gross Profit</p>
                <p className="text-2xl font-bold text-emerald-600 mt-2">{formatLKR(pl.grossProfit)}</p>
              </div>

              <div className="bg-white rounded-2xl border border-emerald-200 p-5 shadow-sm bg-emerald-50/20">
                <p className="text-xs font-semibold text-emerald-700 uppercase">Net Operating Profit</p>
                <p className="text-2xl font-bold text-emerald-700 mt-2">{formatLKR(pl.netProfit)}</p>
                <p className="text-xs text-emerald-600 mt-1">Margin: {pl.marginPct || 0}%</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
