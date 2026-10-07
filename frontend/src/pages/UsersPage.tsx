import React, { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { UserAccount } from '../types/models';
import { UserRole } from '../types/auth';
import { formatDate } from '../utils/format';
import { RoleBadge } from '../components/common/Badge';
import {
  Users,
  Plus,
  ShieldAlert,
  Edit2,
  Trash2,
  X,
  Loader2
} from 'lucide-react';

export const UsersPage: React.FC = () => {
  const { username: currentUsername, isAdmin } = useAuth();

  const [users, setUsers] = useState<UserAccount[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Add / Edit User Modal
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [editUserId, setEditUserId] = useState<number | null>(null);

  // Form Fields
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [role, setRole] = useState<UserRole>('cashier');
  const [isActive, setIsActive] = useState<boolean>(true);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<UserAccount[]>('/users');
      setUsers(Array.isArray(res) ? res : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleOpenAdd = () => {
    setEditUserId(null);
    setUsername('');
    setPassword('');
    setRole('cashier');
    setIsActive(true);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (user: UserAccount) => {
    setEditUserId(user.UserID);
    setUsername(user.Username);
    setPassword(''); // leave blank to keep unchanged
    setRole(user.Role);
    setIsActive(user.IsActive);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (editUserId) {
        const payload: any = { role, isActive };
        if (password.trim()) payload.newPassword = password.trim();
        await apiRequest(`/users/${editUserId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        alert('User updated successfully.');
      } else {
        if (!password.trim() || password.length < 4) {
          alert('Password must be at least 4 characters.');
          setSubmitting(false);
          return;
        }
        await apiRequest('/users', {
          method: 'POST',
          body: JSON.stringify({
            username: username.trim(),
            password: password.trim(),
            role,
          }),
        });
        alert('Staff user created.');
      }
      setIsModalOpen(false);
      await loadUsers();
    } catch (err: any) {
      alert(err.message || 'Error saving user');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevokeSessions = async (userId: number, uName: string) => {
    if (!window.confirm(`Revoke all active terminals and sessions for ${uName}? Their logged-in cookies will become invalid immediately.`)) {
      return;
    }
    try {
      await apiRequest(`/users/${userId}/revoke-sessions`, { method: 'POST' });
      alert(`All active sessions for ${uName} revoked.`);
      await loadUsers();
    } catch (err: any) {
      alert(err.message || 'Could not revoke sessions');
    }
  };

  const handleDeleteUser = async (userId: number, uName: string) => {
    if (!window.confirm(`Permanently delete account ${uName}?`)) return;
    try {
      await apiRequest(`/users/${userId}`, { method: 'DELETE' });
      alert('User deleted.');
      await loadUsers();
    } catch (err: any) {
      alert(err.message || 'Could not delete user');
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-2xl">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-800">Staff User Administration & Security</h2>
            <p className="text-xs text-slate-500">Manage operator permissions, roles, and terminal session security.</p>
          </div>
        </div>

        {isAdmin && (
          <button
            onClick={handleOpenAdd}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold shadow-sm transition"
          >
            <Plus className="w-4 h-4" /> Add Staff User
          </button>
        )}
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th className="py-3.5 px-4">Operator Username</th>
                <th className="py-3.5 px-4">Assigned Role</th>
                <th className="py-3.5 px-4 text-center">Status</th>
                <th className="py-3.5 px-4 text-center">Auth Version</th>
                <th className="py-3.5 px-4">Created Date</th>
                <th className="py-3.5 px-4 text-right">Security Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400">
                    <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                    Loading staff directory...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400">
                    No staff user accounts found.
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.UserID} className="hover:bg-slate-50/60 transition">
                    <td className="py-3.5 px-4 font-bold text-slate-900">
                      {u.Username}
                      {u.Username === currentUsername && (
                        <span className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                          YOU
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <RoleBadge role={u.Role} />
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                        u.IsActive
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-rose-50 text-rose-700 border border-rose-200'
                      }`}>
                        {u.IsActive ? 'Active' : 'Disabled'}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 text-center font-mono text-xs text-slate-500">
                      v{u.AuthVersion}
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 text-xs">
                      {formatDate(u.CreatedAt)}
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleRevokeSessions(u.UserID, u.Username)}
                          title="Revoke All Active Sessions for User"
                          className="px-2.5 py-1 text-amber-700 hover:bg-amber-50 border border-amber-200 rounded-lg text-xs font-semibold flex items-center gap-1 transition"
                        >
                          <ShieldAlert className="w-3.5 h-3.5" /> Revoke Sessions
                        </button>

                        <button
                          onClick={() => handleOpenEdit(u)}
                          title="Edit User Role / Password"
                          className="p-1.5 hover:bg-slate-100 text-slate-600 rounded-lg transition"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>

                        {u.Username !== currentUsername && (
                          <button
                            onClick={() => handleDeleteUser(u.UserID, u.Username)}
                            title="Delete Account"
                            className="p-1.5 hover:bg-rose-50 text-rose-500 rounded-lg transition"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CREATE / EDIT USER MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-6 max-w-md w-full space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-800">
                {editUserId ? `Edit Operator: ${username}` : 'Register Staff Account'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="p-1 text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4 text-sm">
              {!editUserId && (
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Username *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. malinga_workshop"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  {editUserId ? 'New Password (Leave blank to keep current)' : 'Password *'}
                </label>
                <input
                  type="password"
                  placeholder={editUserId ? '••••••••' : 'Enter strong password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Role & Permissions *</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm"
                >
                  <option value="cashier">Cashier (Billing & Job Cards - Wholesale Costs Masked)</option>
                  <option value="manager">Manager (Billing, Inventory, Job Profit & Procurement)</option>
                  <option value="workshop_supervisor">Workshop Supervisor (Certify Labour Bills)</option>
                  <option value="operations_manager">Operations Manager (Approve Labour Bills)</option>
                  <option value="ho_accounts">Head Office Accounts (Certify & Final Approve Labour Bills)</option>
                  <option value="workshop_accounts">Workshop Accounts (Disburse Labour Payout & Seal)</option>
                  <option value="dgm">Deputy General Manager / DGM (Executive View-Only)</option>
                  <option value="chairman">Chairman (Executive View-Only)</option>
                  <option value="admin">Admin (Full Access & User Administration)</option>
                  <option value="viewer">Viewer (Read-only)</option>
                </select>
              </div>

              {editUserId && (
                <div className="pt-2">
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={(e) => setIsActive(e.target.checked)}
                      className="rounded text-indigo-600"
                    />
                    Account is Active (Uncheck to suspend login)
                  </label>
                </div>
              )}

              <div className="border-t border-slate-200 pt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-sm"
                >
                  {editUserId ? 'Save Changes' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
