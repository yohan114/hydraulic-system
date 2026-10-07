export type UserRole =
  | 'admin'
  | 'manager'
  | 'cashier'
  | 'viewer'
  | 'workshop_supervisor'
  | 'operations_manager'
  | 'ho_accounts'
  | 'dgm'
  | 'chairman'
  | 'workshop_accounts';

export interface UserSession {
  sessionId: string;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

export interface AuthStatusResponse {
  authEnabled: boolean;
  authenticated: boolean;
  username: string | null;
  role: UserRole | null;
  usingDefaultPassword?: boolean;
}

export interface LoginResponse {
  token: string;
  username: string;
  role: UserRole;
  sessionId: string;
  expiresIn: number;
}
