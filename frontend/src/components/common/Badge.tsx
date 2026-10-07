import React from 'react';
import { UserRole } from '../../types/auth';

interface RoleBadgeProps {
  role: UserRole | string | null;
  className?: string;
}

export const RoleBadge: React.FC<RoleBadgeProps> = ({ role, className = '' }) => {
  const normalized = (role || 'viewer').toLowerCase();

  const styles: Record<string, string> = {
    admin: 'bg-indigo-50 text-indigo-700 border-indigo-200 ring-indigo-500/10',
    manager: 'bg-emerald-50 text-emerald-700 border-emerald-200 ring-emerald-500/10',
    cashier: 'bg-amber-50 text-amber-700 border-amber-200 ring-amber-500/10',
    viewer: 'bg-slate-50 text-slate-700 border-slate-200 ring-slate-500/10',
    workshop_supervisor: 'bg-blue-50 text-blue-700 border-blue-200 ring-blue-500/10',
    operations_manager: 'bg-purple-50 text-purple-700 border-purple-200 ring-purple-500/10',
    ho_accounts: 'bg-teal-50 text-teal-700 border-teal-200 ring-teal-500/10',
    dgm: 'bg-rose-50 text-rose-700 border-rose-200 ring-rose-500/10',
    chairman: 'bg-amber-100 text-amber-900 border-amber-300 ring-amber-500/10 font-bold',
    workshop_accounts: 'bg-cyan-50 text-cyan-700 border-cyan-200 ring-cyan-500/10',
  };

  const labels: Record<string, string> = {
    admin: 'Admin',
    manager: 'Manager',
    cashier: 'Cashier',
    viewer: 'Viewer',
    workshop_supervisor: 'Workshop Supervisor',
    operations_manager: 'Operations Manager',
    ho_accounts: 'HO Accounts',
    dgm: 'DGM',
    chairman: 'Chairman',
    workshop_accounts: 'Workshop Accounts',
  };

  const style = styles[normalized] || styles.viewer;
  const label = labels[normalized] || normalized;

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border tracking-wider ${style} ${className}`}
    >
      {label}
    </span>
  );
};
