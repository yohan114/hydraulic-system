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
  };

  const style = styles[normalized] || styles.viewer;

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border uppercase tracking-wider ${style} ${className}`}
    >
      {normalized}
    </span>
  );
};
