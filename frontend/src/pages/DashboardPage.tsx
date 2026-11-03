import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api/client';
import { formatLKR, formatDate, formatDateTime } from '../utils/format';
import {
  LayoutDashboard,
  Receipt,
  Wrench,
  Package,
  TrendingUp,
  ShieldCheck,
  Clock,
  ArrowRight,
  AlertTriangle,
  FileText,
  CheckCircle2,
  Ban,
  RefreshCw,
  Loader2,
  X,
  FileCheck,
} from 'lucide-react';

interface DashboardStats {
  totalInvoices: number;
  totalJobs: number;
  lowStockCount: number;
  totalStockItems: number;
}

interface PendingReclassification {
  InvoiceID: number;
  InvoiceNo: string;
  InvoiceDate: string;
  BilledToName: string;
  BilledToAddress?: string;
  DeliveredToName?: string;
  GrandTotal: number;
  SubTotal?: number;
  Status: string;
  IsInternal: number;
  CustomerID?: number | null;
  CreatedAt?: string;
  ApprovalID?: number;
  RequestedBy?: string;
  RequestedAt?: string;
  RequestReason?: string;
  ExpiresAt?: string;
}

interface DashboardPageProps {
  onNavigate: (section: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
  const { username, role, isManager, isAdmin, isCashier } = useAuth();
  const [activeTab, setActiveTab] = useState<'overview' | 'reclassifications'>('overview');

  const [stats, setStats] = useState<DashboardStats>({
    totalInvoices: 0,
    totalJobs: 0,
    lowStockCount: 0,
    totalStockItems: 0,
  });
  const [loadingStats, setLoadingStats] = useState(true);

  // Pending Reclassifications state
  const [pendingReclassifications, setPendingReclassifications] = useState<PendingReclassification[]>([]);
  const [loadingApprovals, setLoadingApprovals] = useState(false);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);

  // Approval Action Modal state
  const [selectedActionItem, setSelectedActionItem] = useState<PendingReclassification | null>(null);
  const [actionType, setActionType] = useState<'approve' | 'reject'>('approve');
  const [actionReason, setActionReason] = useState<string>('');
  const [actionSubmitting, setActionSubmitting] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch dashboard stats
  const fetchStats = useCallback(async () => {
    try {
      const [invoices, jobs, inventory] = await Promise.allSettled([
        apiRequest('/invoices'),
        apiRequest('/jobs'),
        apiRequest('/inventory'),
      ]);

      const invCount = invoices.status === 'fulfilled' && Array.isArray(invoices.value) ? invoices.value.length : 0;
      const jobCount = jobs.status === 'fulfilled' && Array.isArray(jobs.value) ? jobs.value.length : 0;
      const stockItems = inventory.status === 'fulfilled' && Array.isArray(inventory.value) ? inventory.value : [];
      const lowStock = stockItems.filter((i: any) => (i.Qty || 0) <= (i.MinQty || 5)).length;

      setStats({
        totalInvoices: invCount,
        totalJobs: jobCount,
        lowStockCount: lowStock,
        totalStockItems: stockItems.length,
      });
    } catch (err) {
      console.error('Failed to load dashboard statistics:', err);
    } finally {
      setLoadingStats(false);
    }
  }, []);

  // Fetch pending 'Internal to External' revisions
  const fetchPendingReclassifications = useCallback(async () => {
    setLoadingApprovals(true);
    setApprovalsError(null);
    try {
      const data = await apiRequest<PendingReclassification[]>('/invoices/pending-reclassifications');
      setPendingReclassifications(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.error('Failed to load pending reclassifications:', err);
      setApprovalsError(err.message || 'Failed to fetch pending revisions');
    } finally {
      setLoadingApprovals(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    fetchPendingReclassifications();
  }, [fetchStats, fetchPendingReclassifications]);

  // Execute Manager Approval or Rejection
  const handleExecuteApproval = async () => {
    if (!selectedActionItem) return;
    setActionSubmitting(true);
    setActionError(null);
    try {
      const endpoint = actionType === 'approve'
        ? `/invoices/${selectedActionItem.InvoiceID}/authorize-reclassification`
        : `/invoices/${selectedActionItem.InvoiceID}/reclassify/reject`;

      const res = await apiRequest<{ message?: string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ reason: actionReason.trim() }),
      });

      alert(res.message || (actionType === 'approve' ? 'Reclassification successfully authorized and committed to General Ledger.' : 'Reclassification request rejected.'));
      setSelectedActionItem(null);
      setActionReason('');
      await Promise.all([fetchPendingReclassifications(), fetchStats()]);
    } catch (err: any) {
      setActionError(err.message || 'Operation failed');
    } finally {
      setActionSubmitting(false);
    }
  };

  const roleTitle = (role || 'User').replace(/_/g, ' ').toUpperCase();

  return (
    <div className="space-y-6">
      {/* Top Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-xs transition ${
            activeTab === 'overview'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          <LayoutDashboard className="w-4 h-4" /> Operations Overview
        </button>

        <button
          onClick={() => {
            setActiveTab('reclassifications');
            fetchPendingReclassifications();
          }}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-xs transition relative ${
            activeTab === 'reclassifications'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-white text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-slate-50'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>Internal &rarr; External Revision Approvals</span>
          {pendingReclassifications.length > 0 && (
            <span
              className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                activeTab === 'reclassifications'
                  ? 'bg-amber-400 text-slate-900'
                  : 'bg-amber-500 text-white'
              }`}
            >
              {pendingReclassifications.length}
            </span>
          )}
        </button>
      </div>

      {activeTab === 'overview' && (
        <>
          {/* Welcome Hero Banner */}
          <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 rounded-2xl p-6 sm:p-8 text-white shadow-lg relative overflow-hidden border border-slate-800">
            <div className="relative z-10 max-w-2xl">
              <div className="flex items-center gap-2 mb-3">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-400/30">
                  <ShieldCheck className="w-3.5 h-3.5" /> High-Security Production ERP
                </span>
                <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-amber-400/20 text-amber-300 border border-amber-400/30">
                  {roleTitle}
                </span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                Welcome back, {username || 'Operator'}
              </h1>
              <p className="text-slate-300 text-sm mt-2 leading-relaxed">
                Hydraulic Hose Repair Smart Billing &amp; Production Accounting terminal. All mutations are secured via double-entry ledger postings and HttpOnly authenticated sessions.
              </p>

              <div className="flex flex-wrap gap-3 mt-6">
                {(isAdmin || isManager || isCashier) && (
                  <button
                    onClick={() => onNavigate('invoices')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-md shadow-indigo-600/30 transition"
                  >
                    <Receipt className="w-4 h-4" /> Billing &amp; Invoices
                  </button>
                )}
                <button
                  onClick={() => onNavigate('jobs')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700 transition"
                >
                  <Wrench className="w-4 h-4" /> Workshop Job Cards
                </button>
                {(isAdmin || isManager || role === 'ho_accounts' || role === 'workshop_accounts' || role === 'dgm' || role === 'chairman') && (
                  <button
                    onClick={() => onNavigate('ledger')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold shadow-md shadow-emerald-700/20 transition"
                  >
                    <TrendingUp className="w-4 h-4" /> General Ledger
                  </button>
                )}
                <button
                  onClick={() => onNavigate('labour-bills')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700 transition"
                >
                  <FileText className="w-4 h-4" /> Labour Bills
                </button>
              </div>
            </div>

            {/* Decorative background circle */}
            <div className="absolute -right-12 -bottom-12 w-64 h-64 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />
          </div>

          {/* Pending Revision Attention Banner for Managers */}
          {pendingReclassifications.length > 0 && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-amber-900 shadow-xs">
              <div className="flex items-center gap-2.5 font-medium">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
                <div>
                  <p className="font-bold text-amber-900">
                    {pendingReclassifications.length} 'Internal to External' invoice revision{pendingReclassifications.length === 1 ? '' : 's'} awaiting Manager authorization
                  </p>
                  <p className="text-amber-700 text-[11px] mt-0.5">
                    Original internal expense entries are held intact in the General Ledger until reviewed.
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setActiveTab('reclassifications');
                  fetchPendingReclassifications();
                }}
                className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-semibold text-xs shadow-xs transition flex items-center gap-1.5 shrink-0"
              >
                <ShieldCheck className="w-3.5 h-3.5" /> Review Approvals Tab
              </button>
            </div>
          )}

          {/* KPI Stats Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {/* Total Invoices */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Invoices Filed</span>
                <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl">
                  <Receipt className="w-5 h-5" />
                </div>
              </div>
              <div className="mt-3">
                <div className="text-2xl font-bold text-slate-800">
                  {loadingStats ? '...' : stats.totalInvoices}
                </div>
                <p className="text-xs text-slate-500 mt-1 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" /> Total billing records in ledger
                </p>
              </div>
            </div>

            {/* Active Workshop Jobs */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Workshop Jobs</span>
                <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl">
                  <Wrench className="w-5 h-5" />
                </div>
              </div>
              <div className="mt-3">
                <div className="text-2xl font-bold text-slate-800">
                  {loadingStats ? '...' : stats.totalJobs}
                </div>
                <p className="text-xs text-slate-500 mt-1">Crimp &amp; repair job cards</p>
              </div>
            </div>

            {/* Inventory Items Tracked */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Stock SKUs</span>
                <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-xl">
                  <Package className="w-5 h-5" />
                </div>
              </div>
              <div className="mt-3">
                <div className="text-2xl font-bold text-slate-800">
                  {loadingStats ? '...' : stats.totalStockItems}
                </div>
                <p className="text-xs text-slate-500 mt-1">Hoses, fittings, ferrules &amp; adaptors</p>
              </div>
            </div>

            {/* Low Stock Reorder Alerts */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Low Stock Alerts</span>
                <div className={`p-2.5 rounded-xl ${stats.lowStockCount > 0 ? 'bg-amber-50 text-amber-600' : 'bg-slate-50 text-slate-600'}`}>
                  <AlertTriangle className="w-5 h-5" />
                </div>
              </div>
              <div className="mt-3">
                <div className={`text-2xl font-bold ${stats.lowStockCount > 0 ? 'text-amber-600' : 'text-slate-800'}`}>
                  {loadingStats ? '...' : stats.lowStockCount}
                </div>
                <p className="text-xs text-slate-500 mt-1">Items below minimum reorder level</p>
              </div>
            </div>
          </div>

          {/* Quick Access Operational Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-4 flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-600" /> Operational Workflows
              </h3>
              <div className="space-y-3">
                <button
                  onClick={() => onNavigate('invoices')}
                  className="w-full flex items-center justify-between p-3.5 rounded-xl border border-slate-100 hover:border-indigo-200 hover:bg-indigo-50/30 transition group text-left"
                >
                  <div>
                    <span className="font-semibold text-sm text-slate-800 block group-hover:text-indigo-600">
                      Customer Billing &amp; Invoicing
                    </span>
                    <span className="text-xs text-slate-500">
                      Create invoices with automatic 80% market pricing and ferrule floor
                    </span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 transition" />
                </button>

                <button
                  onClick={() => onNavigate('jobs')}
                  className="w-full flex items-center justify-between p-3.5 rounded-xl border border-slate-100 hover:border-indigo-200 hover:bg-indigo-50/30 transition group text-left"
                >
                  <div>
                    <span className="font-semibold text-sm text-slate-800 block group-hover:text-indigo-600">
                      Workshop Hose Repairs &amp; Lathe Work
                    </span>
                    <span className="text-xs text-slate-500">
                      Assign technicians and convert completed jobs to invoices
                    </span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 transition" />
                </button>

                <button
                  onClick={() => onNavigate('inventory')}
                  className="w-full flex items-center justify-between p-3.5 rounded-xl border border-slate-100 hover:border-indigo-200 hover:bg-indigo-50/30 transition group text-left"
                >
                  <div>
                    <span className="font-semibold text-sm text-slate-800 block group-hover:text-indigo-600">
                      Stock Movements &amp; Inventory
                    </span>
                    <span className="text-xs text-slate-500">
                      Track quantities, record purchases, and inspect supplier shipment records
                    </span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 transition" />
                </button>
              </div>
            </div>

            {/* Security & System Status */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex flex-col justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" /> Platform Security &amp; Protection
                </h3>
                <ul className="space-y-3 text-xs text-slate-600">
                  <li className="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="font-medium text-slate-700">Authentication Protocol:</span>
                    <span className="font-semibold text-emerald-700 bg-emerald-100/60 px-2 py-0.5 rounded">
                      HttpOnly Secure Cookies
                    </span>
                  </li>
                  <li className="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="font-medium text-slate-700">Database Engine:</span>
                    <span className="font-semibold text-indigo-700 bg-indigo-100/60 px-2 py-0.5 rounded">
                      SQLite WAL (Concurrent Readers)
                    </span>
                  </li>
                  <li className="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="font-medium text-slate-700">Reversal Audit Trail:</span>
                    <span className="font-semibold text-blue-700 bg-blue-100/60 px-2 py-0.5 rounded">
                      audit_reversal_log (T31 Immutable)
                    </span>
                  </li>
                  <li className="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                    <span className="font-medium text-slate-700">Intrusion Prevention:</span>
                    <span className="font-semibold text-emerald-700 bg-emerald-100/60 px-2 py-0.5 rounded">
                      Fail2ban (24h Auto-Ban on 5 Failures)
                    </span>
                  </li>
                </ul>
              </div>

              {isManager && (
                <button
                  onClick={() => onNavigate('job-profit')}
                  className="mt-6 w-full py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center justify-center gap-2 transition"
                >
                  <TrendingUp className="w-4 h-4 text-emerald-400" /> View Job Profit Analysis
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* APPROVAL DASHBOARD TAB: Pending 'Internal to External' Invoice Revisions */}
      {activeTab === 'reclassifications' && (
        <div className="space-y-6">
          {/* Header Card */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center border border-amber-200">
                  <ShieldCheck className="w-5 h-5 text-amber-600" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    Pending 'Internal to External' Invoice Revisions
                  </h2>
                  <p className="text-xs text-slate-500">
                    Manager Authorization Queue for converting internal fleet repairs into external commercial billing
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                onClick={fetchPendingReclassifications}
                disabled={loadingApprovals}
                className="flex items-center gap-1.5 px-3.5 py-2 border border-slate-200 hover:bg-slate-50 rounded-xl text-xs font-semibold text-slate-700 transition"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingApprovals ? 'animate-spin' : ''}`} /> Refresh Queue
              </button>
            </div>
          </div>

          {/* Accounting Guardrail Explanatory Banner */}
          <div className="p-4 bg-indigo-50/70 border border-indigo-200/80 rounded-2xl text-xs text-indigo-900 space-y-1.5 shadow-xs">
            <div className="flex items-center gap-2 font-bold text-indigo-950">
              <FileCheck className="w-4 h-4 text-indigo-600 shrink-0" />
              <span>Automated Double-Entry Reversal &amp; Audit Guardrail (T31)</span>
            </div>
            <p className="leading-relaxed text-indigo-800">
              In accordance with Sri Lankan financial control requirements, invoices pending revision remain in <span className="font-semibold">'Pending Approval'</span> and do not impact Accounts Receivable (GL 1200) or Commercial Revenue. When a Manager clicks <strong>'Approve'</strong>, the system executes an automated T31 journal reversal, records metadata (original entry date, user, and reason) into the hidden <span className="font-mono font-semibold">audit_reversal_log</span> table, and commits the commercial sales posting to the General Ledger.
            </p>
          </div>

          {approvalsError && (
            <div className="p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl text-xs flex items-center gap-2 font-medium">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {approvalsError}
            </div>
          )}

          {/* Pending Approvals Table */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <tr>
                    <th className="py-3.5 px-4">Invoice No</th>
                    <th className="py-3.5 px-4">Date</th>
                    <th className="py-3.5 px-4">Billed Customer</th>
                    <th className="py-3.5 px-4 text-right">Invoice Amount</th>
                    <th className="py-3.5 px-4">Revision Justification</th>
                    <th className="py-3.5 px-4">Requested By</th>
                    <th className="py-3.5 px-4 text-right">Manager Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {loadingApprovals ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-slate-400">
                        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                        Loading revision approval requests...
                      </td>
                    </tr>
                  ) : pendingReclassifications.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-16 text-center">
                        <div className="max-w-md mx-auto space-y-2">
                          <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto border border-emerald-200">
                            <CheckCircle2 className="w-6 h-6" />
                          </div>
                          <p className="text-base font-bold text-slate-800">
                            No Pending Revisions Awaiting Approval
                          </p>
                          <p className="text-xs text-slate-500">
                            All internal fleet repairs and commercial customer billings are reconciled. When an invoice classification revision is requested, it will appear here for Manager review.
                          </p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    pendingReclassifications.map((item) => (
                      <tr key={item.InvoiceID} className="hover:bg-slate-50/60 transition">
                        <td className="py-4 px-4 font-bold text-slate-900 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <span>{item.InvoiceNo}</span>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">
                              INTERNAL &rarr; EXTERNAL
                            </span>
                          </div>
                        </td>
                        <td className="py-4 px-4 text-slate-600 whitespace-nowrap text-xs">
                          {formatDate(item.InvoiceDate)}
                        </td>
                        <td className="py-4 px-4 font-medium text-slate-800">
                          <div>
                            <p className="font-semibold text-slate-900">{item.BilledToName}</p>
                            {item.BilledToAddress && (
                              <p className="text-xs text-slate-400 truncate max-w-xs">{item.BilledToAddress}</p>
                            )}
                          </div>
                        </td>
                        <td className="py-4 px-4 text-right font-bold text-slate-900 whitespace-nowrap">
                          {formatLKR(item.GrandTotal)}
                        </td>
                        <td className="py-4 px-4 text-xs text-slate-600 max-w-xs">
                          <div className="p-2 rounded-lg bg-slate-50 border border-slate-200/80">
                            <span className="font-medium text-slate-800">
                              {item.RequestReason || 'Conversion from internal fleet repair to commercial customer invoice requested.'}
                            </span>
                          </div>
                        </td>
                        <td className="py-4 px-4 text-xs text-slate-500 whitespace-nowrap">
                          <div>
                            <span className="font-semibold text-slate-700">{item.RequestedBy || 'Operator'}</span>
                            {item.RequestedAt && (
                              <span className="block text-[11px] text-slate-400">{formatDateTime(item.RequestedAt)}</span>
                            )}
                          </div>
                        </td>
                        <td className="py-4 px-4 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-2">
                            {/* Reject Action Button */}
                            <button
                              onClick={() => {
                                setSelectedActionItem(item);
                                setActionType('reject');
                                setActionReason('');
                                setActionError(null);
                              }}
                              disabled={!(isManager || isAdmin)}
                              title={isManager || isAdmin ? 'Reject Reclassification' : 'Manager role required'}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50 rounded-xl text-xs font-semibold transition"
                            >
                              <Ban className="w-3.5 h-3.5" /> Reject
                            </button>

                            {/* Approve Action Button */}
                            <button
                              onClick={() => {
                                setSelectedActionItem(item);
                                setActionType('approve');
                                setActionReason('');
                                setActionError(null);
                              }}
                              disabled={!(isManager || isAdmin)}
                              title={isManager || isAdmin ? 'Approve Reclassification (Post to GL)' : 'Manager role required'}
                              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-sm transition"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                            </button>
                          </div>
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

      {/* ACTION CONFIRMATION MODAL: APPROVE / REJECT */}
      {selectedActionItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 max-w-md w-full space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center ${
                    actionType === 'approve' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'
                  }`}
                >
                  {actionType === 'approve' ? <ShieldCheck className="w-5 h-5" /> : <Ban className="w-5 h-5" />}
                </div>
                <div>
                  <h4 className="text-base font-bold text-slate-800">
                    {actionType === 'approve' ? 'Authorize Invoice Revision' : 'Reject Invoice Revision'}
                  </h4>
                  <p className="text-xs text-slate-500">
                    Invoice {selectedActionItem.InvoiceNo} &bull; {formatLKR(selectedActionItem.GrandTotal)}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedActionItem(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Customer:</span>
                <span className="font-semibold text-slate-800">{selectedActionItem.BilledToName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Original Date:</span>
                <span className="font-semibold text-slate-800">{formatDate(selectedActionItem.InvoiceDate)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Requested Revision:</span>
                <span className="font-bold text-amber-700">Internal Fleet &rarr; Commercial Customer</span>
              </div>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed">
              {actionType === 'approve' ? (
                <>
                  By authorizing, the system will execute an automated <strong>T31 double-entry reversal</strong> of the internal fleet maintenance journal, log metadata to <span className="font-mono font-semibold">audit_reversal_log</span>, and post this invoice as an external commercial receivable (<span className="font-mono font-semibold">1200 AR</span>) with sales revenue (<span className="font-mono font-semibold">4100/4200 Sales</span>) in the General Ledger.
                </>
              ) : (
                <>
                  Rejecting this request will keep the invoice as an <strong>Internal Fleet</strong> repair and return its status to <strong>Finalized</strong>. No changes will be made to the General Ledger.
                </>
              )}
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">
                Decision Notes / Reason <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <input
                type="text"
                placeholder={
                  actionType === 'approve'
                    ? 'e.g. Authorized after customer purchase order validation'
                    : 'e.g. Rejected, internal vehicle repair confirmed'
                }
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>

            {actionError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{actionError}</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={actionSubmitting}
                onClick={() => setSelectedActionItem(null)}
                className="px-3.5 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionSubmitting}
                onClick={handleExecuteApproval}
                className={`px-4 py-2 text-white rounded-xl text-xs font-semibold shadow-sm flex items-center gap-1.5 transition ${
                  actionType === 'approve'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : 'bg-rose-600 hover:bg-rose-700'
                } disabled:opacity-50`}
              >
                {actionSubmitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Processing...
                  </>
                ) : actionType === 'approve' ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Authorize &amp; Post to GL
                  </>
                ) : (
                  <>
                    <Ban className="w-3.5 h-3.5" />
                    Confirm Rejection
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
