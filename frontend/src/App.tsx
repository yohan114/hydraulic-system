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
import { SessionsModal } from './components/auth/SessionsModal';
import { Loader2 } from 'lucide-react';

const MainLayout: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();
  const [currentSection, setCurrentSection] = useState('dashboard');
  const [isSessionsOpen, setIsSessionsOpen] = useState(false);

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

  const sectionTitles: Record<string, string> = {
    dashboard: 'Dashboard Overview',
    invoices: 'Invoices & Customer Billing',
    jobs: 'Workshop Job Cards',
    inventory: 'Stock & Inventory Management',
    'job-profit': 'Job Profit Analysis',
    procurement: 'Procurement & Purchase Orders',
    ledger: 'General Ledger & Financial Accounting',
    users: 'Staff User & Role Administration',
  };

  const renderContent = () => {
    switch (currentSection) {
      case 'dashboard':
        return <DashboardPage onNavigate={setCurrentSection} />;
      case 'invoices':
        return <InvoicesPage />;
      case 'jobs':
        return <JobsPage />;
      case 'inventory':
        return <InventoryPage />;
      case 'job-profit':
        return <JobProfitPage />;
      case 'procurement':
        return <ProcurementPage />;
      case 'ledger':
        return <LedgerPage />;
      case 'users':
        return <UsersPage />;
      default:
        return <DashboardPage onNavigate={setCurrentSection} />;
    }
  };

  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden font-sans">
      {/* Left Sidebar */}
      <Sidebar
        currentSection={currentSection}
        onNavigate={setCurrentSection}
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
