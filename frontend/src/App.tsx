import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginPage } from './components/auth/LoginPage';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { DashboardPage } from './pages/DashboardPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { JobsPage } from './pages/JobsPage';
import { InventoryPage } from './pages/InventoryPage';
import { JobProfitPage } from './pages/JobProfitPage';
import { ProcurementPage } from './pages/ProcurementPage';
import { LedgerPage } from './pages/LedgerPage';
import { UsersPage } from './pages/UsersPage';
import { LabourBillsPage } from './pages/LabourBillsPage';
import { SessionsModal } from './components/auth/SessionsModal';
import { Loader2 } from 'lucide-react';

const VALID_SECTIONS = [
  'dashboard',
  'invoices',
  'jobs',
  'inventory',
  'job-profit',
  'labour-bills',
  'procurement',
  'ledger',
  'users',
];

function getSectionFromUrl(): string {
  // Check pathname first (e.g. /jobs -> jobs)
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (VALID_SECTIONS.includes(path)) return path;

  // Check hash fallback (e.g. #/jobs or #jobs -> jobs)
  const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  if (VALID_SECTIONS.includes(hash)) return hash;

  return 'dashboard';
}

const sectionTitles: Record<string, string> = {
  dashboard: 'Dashboard Overview',
  invoices: 'Invoices & Customer Billing',
  jobs: 'Workshop Job Cards',
  inventory: 'Stock & Inventory Management',
  'job-profit': 'Job Profit Analysis',
  procurement: 'Procurement & Purchase Orders',
  ledger: 'General Ledger & Financial Accounting',
  users: 'Staff User & Role Administration',
  'labour-bills': 'Automated Labour Bills & Workflow',
};

const MainLayout: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();
  const [currentSection, setCurrentSection] = useState<string>(getSectionFromUrl);
  const [isSessionsOpen, setIsSessionsOpen] = useState(false);

  // Synchronize browser history and URL pathname
  const navigateTo = React.useCallback((section: string, replace = false) => {
    const target = VALID_SECTIONS.includes(section) ? section : 'dashboard';
    setCurrentSection(target);
    const newPath = target === 'dashboard' ? '/' : `/${target}`;
    if (window.location.pathname !== newPath) {
      if (replace) {
        window.history.replaceState({ section: target }, '', newPath);
      } else {
        window.history.pushState({ section: target }, '', newPath);
      }
    }
  }, []);

  // Handle browser Back / Forward buttons
  React.useEffect(() => {
    const handlePopState = () => {
      setCurrentSection(getSectionFromUrl());
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Update document title dynamically
  React.useEffect(() => {
    const title = sectionTitles[currentSection] || 'System Management';
    document.title = `${title} · Hydraulic System ERP`;
  }, [currentSection]);

  // Sync initial URL on mount if non-dashboard
  React.useEffect(() => {
    const initial = getSectionFromUrl();
    const initialPath = initial === 'dashboard' ? '/' : `/${initial}`;
    if (window.location.pathname !== initialPath && window.location.pathname !== '/') {
      window.history.replaceState({ section: initial }, '', initialPath);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-slate-900 text-white">
        <Loader2 className="w-10 h-10 text-indigo-500 animate-spin mb-4" />
        <p className="text-sm text-slate-400 font-medium tracking-wide">
          Securing terminal connection...
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  const renderContent = () => {
    switch (currentSection) {
      case 'dashboard':
        return <DashboardPage onNavigate={navigateTo} />;
      case 'invoices':
        return <InvoicesPage />;
      case 'jobs':
        return <JobsPage />;
      case 'inventory':
        return <InventoryPage />;
      case 'job-profit':
        return <JobProfitPage />;
      case 'labour-bills':
        return <LabourBillsPage />;
      case 'procurement':
        return <ProcurementPage />;
      case 'ledger':
        return <LedgerPage />;
      case 'users':
        return <UsersPage />;
      default:
        return <DashboardPage onNavigate={navigateTo} />;
    }
  };

  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden font-sans">
      {/* Left Sidebar */}
      <Sidebar
        currentSection={currentSection}
        onNavigate={navigateTo}
        onOpenSessions={() => setIsSessionsOpen(true)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header
          title={sectionTitles[currentSection] || 'System Management'}
          onOpenSessions={() => setIsSessionsOpen(true)}
        />

        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          {renderContent()}
        </main>
      </div>

      {/* Active Terminals & Sessions Security Modal */}
      <SessionsModal
        isOpen={isSessionsOpen}
        onClose={() => setIsSessionsOpen(false)}
      />
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <AuthProvider>
      <MainLayout />
    </AuthProvider>
  );
};

export default App;
