import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { UserRole, UserSession, AuthStatusResponse, LoginResponse } from '../types/auth';
import { apiRequest } from '../api/client';

interface AuthContextType {
  username: string | null;
  role: UserRole | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  sessions: UserSession[];
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  revokeSession: (sessionId: string) => Promise<void>;
  revokeOthers: () => Promise<void>;
  isAdmin: boolean;
  isManager: boolean;
  isCashier: boolean;
  canWrite: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [username, setUsername] = useState<string | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [sessions, setSessions] = useState<UserSession[]>([]);

  const checkAuthStatus = useCallback(async () => {
    try {
      const res = await apiRequest<AuthStatusResponse>('/auth/status');
      if (res.authenticated && res.username) {
        setUsername(res.username);
        setRole(res.role || 'viewer');
        setIsAuthenticated(true);
      } else {
        setUsername(null);
        setRole(null);
        setIsAuthenticated(false);
      }
    } catch {
      setIsAuthenticated(false);
      setUsername(null);
      setRole(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const data = await apiRequest<UserSession[]>('/auth/sessions');
      setSessions(Array.isArray(data) ? data : []);
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  useEffect(() => {
    if (isAuthenticated) {
      refreshSessions();
    }
  }, [isAuthenticated, refreshSessions]);

  const login = async (user: string, pass: string) => {
    const res = await apiRequest<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: user, password: pass }),
    });
    setUsername(res.username);
    setRole(res.role);
    setIsAuthenticated(true);
    await refreshSessions();
  };

  const logout = async () => {
    try {
      await apiRequest('/auth/logout', { method: 'POST' });
    } catch (_) {}
    setUsername(null);
    setRole(null);
    setIsAuthenticated(false);
    setSessions([]);
  };

  const revokeSession = async (sessionId: string) => {
    await apiRequest(`/auth/sessions/${sessionId}/revoke`, { method: 'POST' });
    await refreshSessions();
  };

  const revokeOthers = async () => {
    await apiRequest('/auth/sessions/revoke-others', { method: 'POST' });
    await refreshSessions();
  };

  const isAdmin = role === 'admin';
  const isManager = role === 'admin' || role === 'manager';
  const isCashier = role === 'cashier';
  const canWrite = role !== 'viewer';

  return (
    <AuthContext.Provider
      value={{
        username,
        role,
        isAuthenticated,
        isLoading,
        sessions,
        login,
        logout,
        refreshSessions,
        revokeSession,
        revokeOthers,
        isAdmin,
        isManager,
        isCashier,
        canWrite,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
