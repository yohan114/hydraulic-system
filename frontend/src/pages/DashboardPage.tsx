import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api/client';
import {
  Receipt,
  Wrench,
  Package,
  TrendingUp,
  ShieldCheck,
  Clock,
  ArrowRight,
  AlertTriangle,
  FileText,
} from 'lucide-react';

interface DashboardStats {
  totalInvoices: number;
  totalJobs: number;
  lowStockCount: number;
  totalStockItems: number;
}

interface DashboardPageProps {
  onNavigate: (section: string) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
  const { username, isManager } = useAuth();
  const [stats, setStats] = useState<DashboardStats>({
    totalInvoices: 0,
    totalJobs: 0,
    lowStockCount: 0,
    totalStockItems: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
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
        setLoading(false);
      }
    };

    fetchStats();
  }, []);

  return (
    <div className="space-y-6">
      {/* Welcome Hero Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 rounded-2xl p-6 sm:p-8 text-white shadow-lg relative overflow-hidden border border-slate-800">
        <div className="relative z-10 max-w-2xl">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-400/30 mb-3">
            <ShieldCheck className="w-3.5 h-3.5" /> High-Security Production ERP
          </span>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
            Welcome back, {username || 'Operator'}
          </h1>
          <p className="text-slate-300 text-sm mt-2 leading-relaxed">
            Hydraulic Hose Repair Smart Billing & Production Accounting terminal. All mutations are secured via double-entry ledger postings and HttpOnly authenticated sessions.
          </p>

          <div className="flex flex-wrap gap-3 mt-6">
            <button
              onClick={() => onNavigate('invoices')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-md shadow-indigo-600/30 transition"
            >
              <Receipt className="w-4 h-4" /> New Invoice
            </button>
            <button
              onClick={() => onNavigate('jobs')}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700 transition"
            >
              <Wrench className="w-4 h-4" /> Open Job Cards
            </button>
          </div>
        </div>

        {/* Decorative background circle */}
        <div className="absolute -right-12 -bottom-12 w-64 h-64 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />
      </div>

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
              {loading ? '...' : stats.totalInvoices}
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
              {loading ? '...' : stats.totalJobs}
            </div>
            <p className="text-xs text-slate-500 mt-1">Crimp & repair job cards</p>
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
              {loading ? '...' : stats.totalStockItems}
            </div>
            <p className="text-xs text-slate-500 mt-1">Hoses, fittings, ferrules & adaptors</p>
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
              {loading ? '...' : stats.lowStockCount}
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
                  Customer Billing & Invoicing
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
                  Workshop Hose Repairs & Lathe Work
                </span>
                <span className="text-xs text-slate-500">
                  Assign technicians (Binara, Malinga) and convert completed jobs to invoices
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
                  Stock Movements & Inventory
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
              <ShieldCheck className="w-4 h-4 text-emerald-600" /> Platform Security & Protection
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
                <span className="font-medium text-slate-700">Nightly Backups:</span>
                <span className="font-semibold text-blue-700 bg-blue-100/60 px-2 py-0.5 rounded">
                  Scheduled Daily (23:30)
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
    </div>
  );
};
