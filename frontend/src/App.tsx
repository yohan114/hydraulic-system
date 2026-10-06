import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LoginPage } from './components/auth/LoginPage';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { DashboardPage } from './pages/DashboardPage';
import { SessionsModal } from './components/auth/SessionsModal';
import { Loader2, ArrowLeft } from 'lucide-react';

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
          {currentSection === 'dashboard' ? (
            <DashboardPage onNavigate={setCurrentSection} />
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm text-center max-w-xl mx-auto mt-12">
              <h3 className="text-lg font-bold text-slate-800">
                {sectionTitles[currentSection]}
              </h3>
              <p className="text-sm text-slate-500 mt-2">
                This module is currently being migrated in Phase 3 to dedicated TypeScript components.
              </p>
              <div className="mt-6 flex justify-center gap-3">
                <button
                  onClick={() => setCurrentSection('dashboard')}
                  className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition"
                >
                  <ArrowLeft className="w-3.5 h-3.5" /> Back to Dashboard
                </button>
                <a
                  href={`/#${currentSection}`}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm transition"
                >
                  Open in Classic View
                </a>
              </div>
            </div>
          )}
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
