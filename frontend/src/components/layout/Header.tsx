import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { RoleBadge } from '../common/Badge';
import { ShieldCheck, Monitor, LogOut } from 'lucide-react';

interface HeaderProps {
  title: string;
  onOpenSessions: () => void;
}

export const Header: React.FC<HeaderProps> = ({ title, onOpenSessions }) => {
  const { username, role, sessions, logout } = useAuth();

  return (
    <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between shadow-sm flex-shrink-0">
      <div>
        <h2 className="text-lg font-bold text-slate-800 tracking-tight">{title}</h2>
      </div>

      <div className="flex items-center gap-4">
        {/* Active Terminal Indicator Button */}
        <button
          onClick={onOpenSessions}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 transition text-xs font-medium text-slate-700"
          title="Click to view logged-in devices"
        >
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <Monitor className="w-3.5 h-3.5 text-slate-500" />
          <span>{sessions.length} {sessions.length === 1 ? 'Terminal' : 'Terminals'} Active</span>
        </button>

        {/* Security / Health Badge */}
        <div className="hidden sm:flex items-center gap-1.5 text-xs font-medium text-slate-500 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          <span>HttpOnly Security ON</span>
        </div>

        {/* User Badge */}
        <div className="flex items-center gap-2 pl-2 border-l border-slate-200">
          <span className="text-xs font-medium text-slate-700">{username}</span>
          <RoleBadge role={role} />
        </div>

        {/* Logout */}
        <button
          onClick={logout}
          className="text-xs font-medium text-slate-500 hover:text-red-600 transition flex items-center gap-1 p-1.5 rounded-lg hover:bg-slate-50"
        >
          <LogOut className="w-4 h-4" />
          <span className="hidden md:inline">Sign Out</span>
        </button>
      </div>
    </header>
  );
};
