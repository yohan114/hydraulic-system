import React from 'react';
import { useAuth } from '../../context/AuthContext';
import { Laptop, Smartphone, Monitor, ShieldAlert, LogOut, CheckCircle, X } from 'lucide-react';

interface SessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SessionsModal: React.FC<SessionsModalProps> = ({ isOpen, onClose }) => {
  const { sessions, revokeSession, revokeOthers } = useAuth();

  if (!isOpen) return null;

  const getDeviceIcon = (ua: string) => {
    const lower = ua.toLowerCase();
    if (lower.includes('mobile') || lower.includes('android') || lower.includes('iphone')) {
      return <Smartphone className="w-5 h-5 text-indigo-500" />;
    }
    if (lower.includes('macintosh') || lower.includes('windows') || lower.includes('linux')) {
      return <Laptop className="w-5 h-5 text-indigo-500" />;
    }
    return <Monitor className="w-5 h-5 text-indigo-500" />;
  };

  const otherSessionsCount = sessions.filter((s) => !s.isCurrent).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-lg w-full overflow-hidden flex flex-col max-h-[85vh]">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-800">Active Logged-in Devices</h3>
              <p className="text-xs text-slate-500">Computers and terminals connected to this account</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-3.5 flex-1">
          {sessions.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm">No active sessions found.</div>
          ) : (
            sessions.map((session) => (
              <div
                key={session.sessionId}
                className={`p-4 rounded-xl border transition-all ${
                  session.isCurrent
                    ? 'border-indigo-200 bg-indigo-50/30 ring-1 ring-indigo-500/10'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start space-x-3">
                    <div className="p-2 bg-slate-100 rounded-lg mt-0.5">
                      {getDeviceIcon(session.userAgent)}
                    </div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-medium text-sm text-slate-800">
                          {session.isCurrent ? 'Current Terminal' : 'Other Connected Device'}
                        </span>
                        {session.isCurrent && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
                            <CheckCircle className="w-3 h-3" /> Active Now
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 font-mono mt-0.5">
                        IP: {session.ipAddress}
                      </p>
                      <p className="text-xs text-slate-400 truncate max-w-xs mt-1" title={session.userAgent}>
                        {session.userAgent || 'Standard Web Browser'}
                      </p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Last Active: {session.lastSeenAt || session.createdAt}
                      </p>
                    </div>
                  </div>

                  {!session.isCurrent && (
                    <button
                      onClick={() => revokeSession(session.sessionId)}
                      className="text-xs text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 px-2.5 py-1.5 rounded-lg transition font-medium"
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-200 rounded-lg transition"
          >
            Close
          </button>

          {otherSessionsCount > 0 && (
            <button
              onClick={revokeOthers}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-sm transition"
            >
              <LogOut className="w-3.5 h-3.5" /> Log Out All Other Devices
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
