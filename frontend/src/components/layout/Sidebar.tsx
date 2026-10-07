import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { RoleBadge } from '../common/Badge';
import {
  LayoutDashboard,
  Receipt,
  Package,
  Wrench,
  TrendingUp,
  ShoppingCart,
  BookOpen,
  Users,
  LogOut,
  Laptop,
  FileCheck,
} from 'lucide-react';

interface SidebarProps {
  currentSection: string;
  onNavigate: (section: string) => void;
  onOpenSessions: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ currentSection, onNavigate, onOpenSessions }) => {
  const { username, role, logout, isAdmin, sessions } = useAuth();

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'invoices', label: 'Invoices & Billing', icon: Receipt },
    { id: 'jobs', label: 'Workshop Jobs', icon: Wrench },
    { id: 'inventory', label: 'Stock & Inventory', icon: Package },
    { id: 'job-profit', label: 'Job Profit Analysis', icon: TrendingUp },
    { id: 'labour-bills', label: 'Labour Bills Workflow', icon: FileCheck },
    { id: 'procurement', label: 'Procurement & Orders', icon: ShoppingCart },
    { id: 'ledger', label: 'Accounting & Ledger', icon: BookOpen },
    { id: 'users', label: 'Users & Roles', icon: Users },
  ];

  const allowedItems = navItems.filter((item) => {
    // Executive / Admin sees all navigation tabs
    if (isAdmin || role === 'dgm' || role === 'chairman') return true;
    if (item.id === 'dashboard' || item.id === 'invoices' || item.id === 'inventory' || item.id === 'labour-bills') return true;
    if (item.id === 'jobs') return role === 'cashier' || role === 'manager' || role === 'workshop_supervisor' || role === 'operations_manager';
    if (item.id === 'job-profit') return role === 'manager' || role === 'workshop_supervisor' || role === 'operations_manager' || role === 'ho_accounts' || role === 'workshop_accounts';
    if (item.id === 'procurement') return role === 'manager' || role === 'operations_manager';
    if (item.id === 'ledger') return role === 'ho_accounts' || role === 'workshop_accounts';
    if (item.id === 'users') return false;
    return false;
  });

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col h-full text-slate-300 select-none">
      {/* Brand Header */}
      <div className="h-16 px-6 flex items-center gap-3 border-b border-slate-800 bg-slate-900/50">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 to-blue-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
          <Wrench className="w-5 h-5" />
        </div>
        <div>
          <h1 className="font-bold text-white text-sm tracking-tight leading-tight">Hydraulic System</h1>
          <span className="text-xs text-slate-400 font-medium">Smart Billing & ERP</span>
        </div>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-slate-300">
          Navigation
        </div>
        {allowedItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentSection === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                isActive
                  ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30 font-semibold'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-slate-300'}`} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Connected Terminals Status */}
      <div className="p-3 mx-3 mb-2 rounded-xl bg-slate-800/40 border border-slate-800 text-xs">
        <button
          onClick={onOpenSessions}
          className="w-full flex items-center justify-between text-slate-300 hover:text-white transition group"
        >
          <div className="flex items-center gap-2">
            <Laptop className="w-4 h-4 text-emerald-400" />
            <span className="font-medium text-xs">Terminals Online</span>
          </div>
          <span className="px-2 py-0.5 rounded-full bg-slate-700 text-slate-200 text-[10px] font-semibold group-hover:bg-slate-600">
            {sessions.length || 1}
          </span>
        </button>
      </div>

      {/* Footer User Info */}
      <div className="p-3 border-t border-slate-800 bg-slate-900/60">
        <div className="flex items-center justify-between p-2 rounded-xl hover:bg-slate-800/50 transition">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-xs uppercase flex-shrink-0">
              {username?.charAt(0) || 'U'}
            </div>
            <div className="truncate">
              <div className="text-xs font-semibold text-white truncate">{username || 'User'}</div>
              <RoleBadge role={role} className="mt-0.5" />
            </div>
          </div>
          <button
            onClick={logout}
            title="Log Out"
            className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-950/30 transition flex-shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
};
