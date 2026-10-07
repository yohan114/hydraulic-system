import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { apiRequest } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatLKR, formatDate } from '../utils/format';
import { RoleBadge } from '../components/common/Badge';
import {
  FileCheck,
  CheckCircle2,
  Clock,
  Lock,
  ShieldCheck,
  ShieldAlert,
  ArrowRight,
  RotateCcw,
  RefreshCw,
  Search,
  DollarSign,
  Briefcase,
  Calendar,
  Sliders,
  Eye,
  Check,
  X,
  CreditCard,
  Info,
  Loader2,
  LockKeyhole,
  MinusCircle,
  Printer,
  Download,
  FileText,
  TrendingUp
} from 'lucide-react';

interface LabourBillItem {
  BillItemID: number;
  BillID: number;
  InvoiceID: number;
  InvoiceNo: string;
  InvoiceDate: string;
  CustomerID?: number;
  CustomerName?: string;
  Customer?: string;
  VehicleNo?: string;
  Crimping: number;
  Welding: number;
  Lathe: number;
  Technical: number;
  LineTotal: number;
}

interface LabourBillApproval {
  ApprovalID: number;
  BillID: number;
  Seq: number;
  Stage: string;
  Action: string;
  ActorID: string;
  ActorRole: string;
  At: string;
  Note?: string;
  PrevHash?: string;
  RecordHash: string;
}

interface LabourBill {
  BillID: number;
  BillNo: string;
  Status: string;
  PeriodFrom: string;
  PeriodTo: string;
  JobCount: number;
  TotalAmount: number;
  CrimpingTotal: number;
  WeldingTotal: number;
  LatheTotal: number;
  TechTotal: number;
  TriggerReason?: string;
  ContentHash: string;
  CurrentHash?: string;
  IsSealed?: number;
  SealedBlob?: string;
  PaidDate?: string;
  PaymentDate?: string;
  PaymentMethod?: string;
  PaymentRef?: string;
  PaidTo?: string;
  LabourPaymentID?: number;
  CreatedAt: string;
  CreatedBy: string;
  ClosedAt?: string;
  ClosedBy?: string;
}

interface BillDetailsResponse {
  bill: LabourBill;
  items: LabourBillItem[];
  approvals: LabourBillApproval[];
  integrity: {
    valid: boolean;
    billContentValid: boolean;
    approvalChainValid: boolean;
    sealValid: boolean;
    checks: string[];
    errors?: string[];
  };
  profitSummary?: {
    ourCost: number;
    materialCost: number;
    sundry: number;
    outsideTotal: number;
    profit: number;
    marginPct: number;
    itemProfits?: Record<string, {
      ourCost: number;
      outsideTotal: number;
      profit: number;
      marginPct: number;
      hoseSize?: string;
    }>;
  };
}

interface Settings {
  MinAmount: number;
  MinJobs: number;
  MaxDays: number;
  Enabled: number;
  EffectiveDate?: string | null;
}

interface UnbilledData {
  totalAmount: number;
  totalJobs: number;
  oldestDate: string | null;
  newestDate: string | null;
  oldestDaysAge: number;
  crimping: number;
  welding: number;
  lathe: number;
  tech: number;
}

interface UnbilledInvoiceItem {
  InvoiceID: number;
  InvoiceNo: string;
  InvoiceDate: string;
  Customer: string;
  IsInternal?: boolean;
  Crimping: number;
  Welding: number;
  Lathe: number;
  Technical: number;
  LineTotal: number;
}

export const LabourBillsPage: React.FC = () => {
  const { role, isAdmin } = useAuth();

  const [bills, setBills] = useState<LabourBill[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [unbilled, setUnbilled] = useState<UnbilledData | null>(null);
  const [unbilledAllTotals, setUnbilledAllTotals] = useState<UnbilledData | null>(null);
  const [unbilledItems, setUnbilledItems] = useState<UnbilledInvoiceItem[]>([]);
  const [unbilledFilter, setUnbilledFilter] = useState<'all' | 'preserved' | 'eligible'>('all');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<'my_actions' | 'in_progress' | 'ready_to_pay' | 'closed' | 'all' | 'unbilled'>('my_actions');
  const [search, setSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Detail Modal State
  const [selectedBillId, setSelectedBillId] = useState<number | null>(null);
  const [billDetails, setBillDetails] = useState<BillDetailsResponse | null>(null);
  const [loadingDetails, setLoadingDetails] = useState<boolean>(false);

  // Action Inputs
  const [actionNote, setActionNote] = useState<string>('');
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [rejectModalOpen, setRejectModalOpen] = useState<boolean>(false);
  const [rejectReason, setRejectReason] = useState<string>('');

  // Payout Form
  const [payDate, setPayDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [payMethod, setPayMethod] = useState<string>('Cash');
  const [payRef, setPayRef] = useState<string>('');
  const [payTo, setPayTo] = useState<string>('Workshop Technicians');
  const [payNotes, setPayNotes] = useState<string>('');

  // Settings Modal State
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [settingsMinAmount, setSettingsMinAmount] = useState<number>(15000);
  const [settingsMinJobs, setSettingsMinJobs] = useState<number>(10);
  const [settingsMaxDays, setSettingsMaxDays] = useState<number>(15);
  const [settingsEnabled, setSettingsEnabled] = useState<boolean>(true);
  const [settingsEffectiveDate, setSettingsEffectiveDate] = useState<string>('2026-10-06');
  const [savingSettings, setSavingSettings] = useState<boolean>(false);

  // Sealed Archive Modal State
  const [isSealedModalOpen, setIsSealedModalOpen] = useState<boolean>(false);
  const [sealedData, setSealedData] = useState<any | null>(null);
  const [loadingSealed, setLoadingSealed] = useState<boolean>(false);

  // Manual Selection & Creation State
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<number[]>([]);
  const [creatingSelected, setCreatingSelected] = useState<boolean>(false);

  // Multi-Section PDF Export Modal State
  const [isPdfModalOpen, setIsPdfModalOpen] = useState<boolean>(false);
  const [pdfSections, setPdfSections] = useState<{
    voucher: boolean;
    labourItems: boolean;
    jobProfit: boolean;
    approvals: boolean;
    integrity: boolean;
  }>({
    voucher: true,
    labourItems: true,
    jobProfit: true,
    approvals: true,
    integrity: true,
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [billsRes, settingsRes, unbilledRes] = await Promise.all([
        apiRequest<{
          bills: LabourBill[];
          counts: Record<string, number>;
          unbilled: UnbilledData;
          unbilledAll?: UnbilledData;
          unbilledItems?: UnbilledInvoiceItem[];
        }>('/labour-bills'),
        apiRequest<Settings>('/labour-bills/settings'),
        apiRequest<{
          items: UnbilledInvoiceItem[];
          totals: UnbilledData;
          allTotals: UnbilledData;
          allItems: UnbilledInvoiceItem[];
        }>('/labour-bills/unbilled').catch(() => null),
      ]);

      setBills(billsRes.bills || []);
      setCounts(billsRes.counts || {});
      setUnbilled(billsRes.unbilled || null);
      setUnbilledAllTotals(unbilledRes?.allTotals || billsRes.unbilledAll || null);
      setUnbilledItems(unbilledRes?.allItems || unbilledRes?.items || billsRes.unbilledItems || []);
      setSettings(settingsRes);
      if (settingsRes) {
        setSettingsMinAmount(settingsRes.MinAmount);
        setSettingsMinJobs(settingsRes.MinJobs);
        setSettingsMaxDays(settingsRes.MaxDays);
        setSettingsEnabled(Boolean(settingsRes.Enabled));
        if (settingsRes.EffectiveDate) setSettingsEffectiveDate(settingsRes.EffectiveDate);
      }
    } catch (err) {
      console.error('Failed to load labour bills:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const loadBillDetails = async (id: number) => {
    setSelectedBillId(id);
    setLoadingDetails(true);
    setActionNote('');
    try {
      const res = await apiRequest<BillDetailsResponse>(`/labour-bills/${id}`);
      setBillDetails(res);
    } catch (err: any) {
      alert(err.message || 'Failed to load bill details');
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleTriggerCheck = async () => {
    setActionLoading(true);
    try {
      const res = await apiRequest('/labour-bills/check-now', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res.created) {
        alert(`Success! Generated automated Labour Bill ${res.billNo} for ${res.jobCount} jobs (${formatLKR(res.totalAmount)}).`);
        await loadData();
        if (res.billId) loadBillDetails(res.billId);
      } else {
        alert(`Condition Check: No bill generated yet. ${res.reason || 'Thresholds not yet reached.'}`);
        await loadData();
      }
    } catch (err: any) {
      alert(err.message || 'Error triggering automated bill check');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    try {
      const res = await apiRequest<{ success: boolean; settings: Settings }>('/labour-bills/settings', {
        method: 'PUT',
        body: JSON.stringify({
          minAmount: settingsMinAmount,
          minJobs: settingsMinJobs,
          maxDays: settingsMaxDays,
          enabled: settingsEnabled,
          effectiveDate: settingsEffectiveDate || null,
        }),
      });
      setSettings(res.settings);
      setIsSettingsOpen(false);
      alert('Labour bill auto-trigger thresholds updated successfully!');
      await loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  // Job Modification Handler (Remove / Defer to next bill)
  const handleRemoveJob = async (billItemId: number, invoiceNo: string, lineTotal: number) => {
    if (!selectedBillId) return;
    const reason = window.prompt(
      `Remove job ${invoiceNo} (${formatLKR(lineTotal)}) from this bill?\n\nThis job will be returned to the unbilled pool and deferred to the next bill.\n\nEnter optional reason:`,
      'Deferred to next bill'
    );
    if (reason === null) return;

    setActionLoading(true);
    try {
      const res = await apiRequest<{ success: boolean; bill: LabourBill; items: LabourBillItem[] }>(
        `/labour-bills/${selectedBillId}/items/${billItemId}`,
        {
          method: 'DELETE',
          body: JSON.stringify({ reason }),
        }
      );
      if (res.success) {
        alert(`Job ${invoiceNo} removed and deferred to the next bill. Bill totals updated.`);
        await loadBillDetails(selectedBillId);
        await loadData();
      }
    } catch (err: any) {
      alert(err.message || 'Failed to remove job');
    } finally {
      setActionLoading(false);
    }
  };

  // Create Bill from Selected Invoices
  const handleCreateFromSelected = async () => {
    if (selectedInvoiceIds.length === 0) return;
    const note = window.prompt(
      `Create a new Labour Bill from the ${selectedInvoiceIds.length} selected job(s)?\n\nEnter optional creation note / trigger reason:`,
      'Selected workshop jobs batch'
    );
    if (note === null) return;

    setCreatingSelected(true);
    try {
      const res = await apiRequest<{
        success: boolean;
        billId: number;
        billNo: string;
        jobCount: number;
        totalAmount: number;
      }>('/labour-bills/create-selected', {
        method: 'POST',
        body: JSON.stringify({
          invoiceIds: selectedInvoiceIds,
          reason: note.trim() || 'Selected workshop jobs batch',
        }),
      });
      alert(`Success! Created Labour Bill ${res.billNo} for ${res.jobCount} jobs (${formatLKR(res.totalAmount)}).`);
      setSelectedInvoiceIds([]);
      await loadData();
      if (res.billId) {
        await loadBillDetails(res.billId);
      }
    } catch (err: any) {
      alert(err.message || 'Failed to create labour bill from selected jobs');
    } finally {
      setCreatingSelected(false);
    }
  };

  // Download PDF Handler with selected sections
  const handleDownloadPdf = (billId: number) => {
    const activeKeys = Object.entries(pdfSections)
      .filter(([_, enabled]) => enabled)
      .map(([key]) => key);
    if (activeKeys.length === 0) {
      alert('Please select at least one section to include in the PDF report.');
      return;
    }
    const url = `/api/labour-bills/${billId}/pdf?sections=${encodeURIComponent(activeKeys.join(','))}`;
    window.open(url, '_blank');
    setIsPdfModalOpen(false);
  };

  // Workflow Handlers
  const handleCertify = async () => {
    if (!selectedBillId) return;
    setActionLoading(true);
    try {
      await apiRequest(`/labour-bills/${selectedBillId}/certify`, {
        method: 'POST',
        body: JSON.stringify({ note: actionNote.trim() }),
      });
      alert('Bill successfully certified and forwarded to Operations Manager.');
      await loadData();
      await loadBillDetails(selectedBillId);
    } catch (err: any) {
      alert(err.message || 'Failed to certify bill');
    } finally {
      setActionLoading(false);
    }
  };

  const handleApproveOM = async () => {
    if (!selectedBillId) return;
    setActionLoading(true);
    try {
      await apiRequest(`/labour-bills/${selectedBillId}/approve-om`, {
        method: 'POST',
        body: JSON.stringify({ note: actionNote.trim() }),
      });
      alert('Bill successfully approved by Operations Manager and forwarded to Head Office Accounts.');
      await loadData();
      await loadBillDetails(selectedBillId);
    } catch (err: any) {
      alert(err.message || 'Failed to approve bill');
    } finally {
      setActionLoading(false);
    }
  };

  const handleApproveHO = async () => {
    if (!selectedBillId) return;
    setActionLoading(true);
    try {
      await apiRequest(`/labour-bills/${selectedBillId}/approve-ho`, {
        method: 'POST',
        body: JSON.stringify({ note: actionNote.trim() }),
      });
      alert('Bill successfully certified & approved by Head Office. Returned to Workshop Accounts for payout.');
      await loadData();
      await loadBillDetails(selectedBillId);
    } catch (err: any) {
      alert(err.message || 'Failed to approve bill');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!selectedBillId) return;
    if (!rejectReason.trim()) {
      alert('Please enter a rejection / return note explaining the reason.');
      return;
    }
    setActionLoading(true);
    try {
      await apiRequest(`/labour-bills/${selectedBillId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      alert('Bill has been returned to Workshop for review with your notes.');
      setRejectModalOpen(false);
      setRejectReason('');
      await loadData();
      await loadBillDetails(selectedBillId);
    } catch (err: any) {
      alert(err.message || 'Failed to return bill');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePayAndClose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBillId) return;
    setActionLoading(true);
    try {
      await apiRequest(`/labour-bills/${selectedBillId}/pay`, {
        method: 'POST',
        body: JSON.stringify({
          paymentDate: payDate,
          method: payMethod,
          paymentRef: payRef.trim(),
          paidTo: payTo.trim(),
          notes: payNotes.trim(),
        }),
      });
      alert('Labour bill successfully paid, locked, sealed with AES-256 encryption, and General Ledger updated!');
      await loadData();
      await loadBillDetails(selectedBillId);
    } catch (err: any) {
      alert(err.message || 'Failed to record payment');
    } finally {
      setActionLoading(false);
    }
  };

  const handleOpenSealedArchive = async (id: number) => {
    setLoadingSealed(true);
    setIsSealedModalOpen(true);
    try {
      const res = await apiRequest(`/labour-bills/${id}/sealed`);
      setSealedData(res);
    } catch (err: any) {
      alert(err.message || 'Failed to decrypt sealed bill archive');
      setIsSealedModalOpen(false);
    } finally {
      setLoadingSealed(false);
    }
  };

  // Determine if a bill is awaiting action by the current user
  const isAwaitingMyAction = useCallback(
    (b: LabourBill) => {
      if (isAdmin) {
        return b.Status !== 'CLOSED';
      }
      if (role === 'workshop_supervisor') {
        return b.Status === 'GENERATED' || b.Status === 'RETURNED';
      }
      if (role === 'operations_manager') {
        return b.Status === 'CERTIFIED';
      }
      if (role === 'ho_accounts') {
        return b.Status === 'OM_APPROVED';
      }
      if (role === 'workshop_accounts') {
        return b.Status === 'HO_APPROVED';
      }
      return false;
    },
    [isAdmin, role]
  );

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'GENERATED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <Clock className="w-3 h-3 text-amber-500" /> Pending WS Certify
          </span>
        );
      case 'CERTIFIED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
            <Check className="w-3 h-3 text-blue-500" /> WS Certified (Pending OM)
          </span>
        );
      case 'OM_APPROVED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-200">
            <CheckCircle2 className="w-3 h-3 text-purple-500" /> OM Approved (Pending HO)
          </span>
        );
      case 'HO_APPROVED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-teal-50 text-teal-700 border border-teal-200">
            <CreditCard className="w-3 h-3 text-teal-600" /> HO Approved (Ready to Pay)
          </span>
        );
      case 'RETURNED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200">
            <RotateCcw className="w-3 h-3 text-rose-600" /> Returned to Workshop
          </span>
        );
      case 'CLOSED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            <Lock className="w-3 h-3 text-emerald-600" /> Paid & Sealed
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
            {status}
          </span>
        );
    }
  };

  // Filtered bills
  const filteredBills = useMemo(() => {
    return bills.filter((b) => {
      // Tab filter
      if (activeTab === 'my_actions' && !isAwaitingMyAction(b)) return false;
      if (activeTab === 'in_progress' && (b.Status === 'CLOSED' || b.Status === 'HO_APPROVED')) return false;
      if (activeTab === 'ready_to_pay' && b.Status !== 'HO_APPROVED') return false;
      if (activeTab === 'closed' && b.Status !== 'CLOSED') return false;

      // Status dropdown filter
      if (statusFilter !== 'all' && b.Status !== statusFilter) return false;

      // Text search
      if (search.trim()) {
        const q = search.toLowerCase();
        const no = (b.BillNo || '').toLowerCase();
        const date = (b.CreatedAt || '').toLowerCase();
        if (!no.includes(q) && !date.includes(q)) return false;
      }
      return true;
    });
  }, [bills, activeTab, isAwaitingMyAction, statusFilter, search]);

  // Filtered unbilled items
  const filteredUnbilled = useMemo(() => {
    return unbilledItems.filter((i) => {
      const isHistorical = Boolean(settings?.EffectiveDate && i.InvoiceDate < settings.EffectiveDate);
      if (unbilledFilter === 'preserved' && !isHistorical) return false;
      if (unbilledFilter === 'eligible' && isHistorical) return false;

      if (search.trim()) {
        const q = search.toLowerCase();
        const no = (i.InvoiceNo || '').toLowerCase();
        const cust = (i.Customer || '').toLowerCase();
        if (!no.includes(q) && !cust.includes(q)) return false;
      }
      return true;
    });
  }, [unbilledItems, unbilledFilter, settings?.EffectiveDate, search]);

  const myActionCount = useMemo(() => {
    return bills.filter(isAwaitingMyAction).length;
  }, [bills, isAwaitingMyAction]);

  // Trigger metrics
  const minAmt = settings?.MinAmount ?? 15000;
  const minJ = settings?.MinJobs ?? 10;
  const maxD = settings?.MaxDays ?? 15;

  const currentAmt = unbilled?.totalAmount ?? 0;
  const currentJobs = unbilled?.totalJobs ?? 0;
  const currentDays = unbilled?.oldestDaysAge ?? 0;

  const amtPct = Math.min(100, Math.round((currentAmt / minAmt) * 100));
  const jobPct = Math.min(100, Math.round((currentJobs / minJ) * 100));
  const dayPct = Math.min(100, Math.round((currentDays / maxD) * 100));

  const conditionMet = currentAmt >= minAmt || currentJobs >= minJ || currentDays >= maxD;

  return (
    <div className="space-y-6">
      {/* 1. Header & Live Automatic Trigger Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 rounded-3xl p-6 md:p-8 text-white shadow-xl border border-slate-800">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="p-2 rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                <FileCheck className="w-6 h-6" />
              </span>
              <div>
                <h1 className="text-xl md:text-2xl font-bold tracking-tight text-white flex items-center gap-3">
                  Automated Labour Bills & Workflow
                  <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-indigo-500/30 text-indigo-300 border border-indigo-400/30">
                    Auto-Creation Engine Active
                  </span>
                </h1>
                <p className="text-xs md:text-sm text-slate-300 mt-1">
                  Autonomous 3-condition triggers, segregation of duties certification, multi-tier approvals & AES-256-GCM tamper-proof sealed records.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {(isAdmin || role === 'manager') && (
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center gap-2 transition"
              >
                <Sliders className="w-4 h-4 text-indigo-400" />
                Configure Thresholds
              </button>
            )}

            <button
              onClick={handleTriggerCheck}
              disabled={actionLoading}
              className={`px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2 transition shadow-lg ${
                conditionMet
                  ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20 animate-pulse'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/30'
              }`}
            >
              <RefreshCw className={`w-4 h-4 ${actionLoading ? 'animate-spin' : ''}`} />
              {conditionMet ? 'Generate Automated Bill Now' : 'Check Trigger Conditions'}
            </button>
          </div>
        </div>

        {/* 3 Automatic Triggers Visual Meter */}
        <div className="mt-6 pt-6 border-t border-slate-800/80 grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Condition 1: Total Labour >= Rs. 15,000 */}
          <div className="p-4 rounded-2xl bg-slate-800/60 border border-slate-700/60 backdrop-blur-sm">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5 text-indigo-400" />
                Condition 1: Accrued Labour
              </span>
              <span className={`font-bold ${currentAmt >= minAmt ? 'text-emerald-400' : 'text-slate-400'}`}>
                {currentAmt >= minAmt ? 'Trigger Met ✓' : `${amtPct}%`}
              </span>
            </div>
            <div className="w-full bg-slate-700/60 h-2 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  currentAmt >= minAmt ? 'bg-emerald-400' : 'bg-indigo-500'
                }`}
                style={{ width: `${amtPct}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
              <span className="font-mono">{formatLKR(currentAmt)}</span>
              <span>Target: {formatLKR(minAmt)}</span>
            </div>
          </div>

          {/* Condition 2: Total Jobs >= 10 */}
          <div className="p-4 rounded-2xl bg-slate-800/60 border border-slate-700/60 backdrop-blur-sm">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                <Briefcase className="w-3.5 h-3.5 text-indigo-400" />
                Condition 2: Job Volume
              </span>
              <span className={`font-bold ${currentJobs >= minJ ? 'text-emerald-400' : 'text-slate-400'}`}>
                {currentJobs >= minJ ? 'Trigger Met ✓' : `${jobPct}%`}
              </span>
            </div>
            <div className="w-full bg-slate-700/60 h-2 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  currentJobs >= minJ ? 'bg-emerald-400' : 'bg-indigo-500'
                }`}
                style={{ width: `${jobPct}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
              <span className="font-mono">{currentJobs} unbilled jobs</span>
              <span>Target: {minJ} jobs</span>
            </div>
          </div>

          {/* Condition 3: Calendar Age >= 15 Days */}
          <div className="p-4 rounded-2xl bg-slate-800/60 border border-slate-700/60 backdrop-blur-sm">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-indigo-400" />
                Condition 3: Age from Oldest Job
              </span>
              <span className={`font-bold ${currentDays >= maxD ? 'text-emerald-400' : 'text-slate-400'}`}>
                {currentDays >= maxD ? 'Trigger Met ✓' : `${dayPct}%`}
              </span>
            </div>
            <div className="w-full bg-slate-700/60 h-2 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  currentDays >= maxD ? 'bg-emerald-400' : 'bg-indigo-500'
                }`}
                style={{ width: `${dayPct}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
              <span className="font-mono">{currentDays} days elapsed</span>
              <span>Target: {maxD} days max</span>
            </div>
          </div>
        </div>
      </div>

      {/* 2. Key Metrics Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Unbilled Accrual */}
        <div
          onClick={() => setActiveTab('unbilled')}
          className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm cursor-pointer hover:border-amber-400 hover:shadow-md transition group select-none"
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider group-hover:text-amber-600 transition">
              Unbilled Accrual Pool
            </p>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1 group-hover:bg-amber-100 transition">
              <Eye className="w-3 h-3 text-amber-600" /> View {unbilledItems.length || 0} Invoices
            </span>
          </div>
          <p className="text-2xl font-bold text-slate-900 mt-2 group-hover:text-amber-600 transition">
            {formatLKR(unbilledAllTotals?.totalAmount ?? (unbilledItems.length ? unbilledItems.reduce((s, i) => s + i.LineTotal, 0) : currentAmt))}
          </p>
          <p className="text-xs text-slate-500 mt-1 flex items-center justify-between">
            <span>{unbilledItems.length || currentJobs} unpaid jobs waiting</span>
            {settings?.EffectiveDate && (
              <span className="text-[10px] text-amber-600 font-medium">Cutoff: {formatDate(settings.EffectiveDate)}</span>
            )}
          </p>
        </div>

        {/* In Review Workflow */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Bills In Review Workflow</p>
          <p className="text-2xl font-bold text-indigo-600 mt-2">
            {(counts.GENERATED || 0) + (counts.CERTIFIED || 0) + (counts.OM_APPROVED || 0) + (counts.RETURNED || 0)}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Certify & approval stages across workshop & HO
          </p>
        </div>

        {/* Ready for Settlement */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Approved Ready For Payout</p>
          <p className="text-2xl font-bold text-teal-600 mt-2">
            {counts.HO_APPROVED || 0}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Certified by HO, waiting for workshop disbursement
          </p>
        </div>

        {/* Sealed & Closed Archive */}
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Closed & Sealed Archive</p>
          <p className="text-2xl font-bold text-emerald-600 mt-2">
            {counts.CLOSED || 0}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Encrypted with AES-256-GCM & GL posted
          </p>
        </div>
      </div>

      {/* 3. Navigation Filter Tabs & Search Bar */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Filter Tabs */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setActiveTab('my_actions')}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'my_actions'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
            }`}
          >
            <span>My Action Queue</span>
            {myActionCount > 0 && (
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-extrabold ${
                activeTab === 'my_actions' ? 'bg-white text-indigo-600' : 'bg-indigo-600 text-white'
              }`}>
                {myActionCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('in_progress')}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition ${
              activeTab === 'in_progress'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
            }`}
          >
            In Review
          </button>

          <button
            onClick={() => setActiveTab('ready_to_pay')}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition ${
              activeTab === 'ready_to_pay'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
            }`}
          >
            Ready to Settle ({counts.HO_APPROVED || 0})
          </button>

          <button
            onClick={() => setActiveTab('closed')}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition ${
              activeTab === 'closed'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
            }`}
          >
            Sealed Archive ({counts.CLOSED || 0})
          </button>

          <button
            onClick={() => setActiveTab('all')}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition ${
              activeTab === 'all'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
            }`}
          >
            All Bills ({bills.length})
          </button>

          <div className="h-5 w-px bg-slate-200 mx-1 hidden sm:block" />

          {/* Unpaid Labour Invoices List Tab */}
          <button
            onClick={() => setActiveTab('unbilled')}
            className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'unbilled'
                ? 'bg-amber-600 text-white shadow-md shadow-amber-600/20'
                : 'bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200'
            }`}
          >
            <Clock className="w-3.5 h-3.5 text-amber-500" />
            <span>Unpaid Labour Invoices</span>
            <span className={`px-1.5 py-0.2 rounded-full text-[10px] font-extrabold ${
              activeTab === 'unbilled' ? 'bg-white text-amber-800' : 'bg-amber-200 text-amber-950'
            }`}>
              {unbilledItems.length}
            </span>
          </button>
        </div>

        {/* Search & Status Filter */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 md:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder={activeTab === 'unbilled' ? "Search invoice # or customer..." : "Search bill # or date..."}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-hidden focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
            />
          </div>

          {activeTab === 'unbilled' ? (
            <select
              value={unbilledFilter}
              onChange={(e: any) => setUnbilledFilter(e.target.value)}
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 focus:outline-hidden focus:ring-2 focus:ring-amber-500/20"
            >
              <option value="all">All Unpaid ({unbilledItems.length})</option>
              <option value="preserved">Preserved Historical (Aug 20–Oct 5)</option>
              <option value="eligible">Eligible for Auto-Bill</option>
            </select>
          ) : (
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500/20"
            >
              <option value="all">All Statuses</option>
              <option value="GENERATED">Generated (Pending Supervisor)</option>
              <option value="CERTIFIED">Certified (Pending OM)</option>
              <option value="OM_APPROVED">OM Approved (Pending HO)</option>
              <option value="HO_APPROVED">HO Approved (Pending Payout)</option>
              <option value="RETURNED">Returned to Workshop</option>
              <option value="CLOSED">Closed & Sealed</option>
            </select>
          )}
        </div>
      </div>

      {/* 4. Main Section: Either Unpaid Labour Invoices Registry OR Generated Bills Table */}
      {activeTab === 'unbilled' ? (
        <div className="space-y-4">
          {/* Informational Callout Banner */}
          <div className="bg-amber-50/90 border border-amber-200 rounded-2xl p-4 flex items-start gap-3 shadow-xs">
            <Info className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-amber-950 leading-relaxed">
              <span className="font-bold">Unpaid Workshop Labour Registry ({unbilledItems.length} jobs · {formatLKR(unbilledAllTotals?.totalAmount ?? (unbilledItems.reduce((s, i) => s + i.LineTotal, 0)))}):</span>{' '}
              These finalized customer and internal jobs carry unpaid technician labour charges. Historical jobs from 20 Aug 2026 to 05 Oct 2026 are preserved with labour strictly unpaid and protected from automated lump-sum billing (Cutoff date: {settings?.EffectiveDate ? formatDate(settings.EffectiveDate) : 'None'}). Select any jobs using the checkboxes below to generate a custom Labour Bill voucher.
            </div>
          </div>

          {/* Selection Action Toolbar when items are selected */}
          {selectedInvoiceIds.length > 0 && (
            <div className="bg-gradient-to-r from-indigo-950 via-slate-900 to-indigo-950 text-white rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xl border border-indigo-700/50 animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="flex items-center gap-3">
                <span className="px-3 py-1.5 rounded-xl bg-indigo-500/30 text-indigo-300 font-bold text-xs border border-indigo-400/30">
                  {selectedInvoiceIds.length} Job{selectedInvoiceIds.length > 1 ? 's' : ''} Selected
                </span>
                <div>
                  <div className="text-[11px] text-slate-300">Selected Labour Total:</div>
                  <div className="text-base font-bold font-mono text-emerald-400">
                    {formatLKR(
                      unbilledItems
                        .filter((i) => selectedInvoiceIds.includes(i.InvoiceID))
                        .reduce((s, i) => s + i.LineTotal, 0)
                    )}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedInvoiceIds([])}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                >
                  Clear Selection
                </button>
                {(isAdmin || role === 'workshop_supervisor' || role === 'manager') && (
                  <button
                    type="button"
                    onClick={handleCreateFromSelected}
                    disabled={creatingSelected}
                    className="px-4 py-2 rounded-xl text-xs font-bold bg-indigo-500 hover:bg-indigo-600 text-white shadow-md shadow-indigo-500/30 flex items-center gap-2 transition disabled:opacity-50"
                  >
                    {creatingSelected ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Generating Bill...
                      </>
                    ) : (
                      <>
                        <FileCheck className="w-4 h-4" />
                        Create Labour Bill ({selectedInvoiceIds.length} Selected)
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-slate-200/80 overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50/80 border-b border-slate-200 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  <tr>
                    <th className="py-3.5 px-3 text-center w-10">
                      <input
                        type="checkbox"
                        checked={
                          filteredUnbilled.length > 0 &&
                          filteredUnbilled.every((i) => selectedInvoiceIds.includes(i.InvoiceID))
                        }
                        onChange={(e) => {
                          if (e.target.checked) {
                            const allFilteredIds = filteredUnbilled.map((i) => i.InvoiceID);
                            setSelectedInvoiceIds((prev) => Array.from(new Set([...prev, ...allFilteredIds])));
                          } else {
                            const currentFilteredIds = new Set(filteredUnbilled.map((i) => i.InvoiceID));
                            setSelectedInvoiceIds((prev) => prev.filter((id) => !currentFilteredIds.has(id)));
                          }
                        }}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                        title="Select or deselect all visible jobs"
                      />
                    </th>
                    <th className="py-3.5 px-4">Invoice No</th>
                    <th className="py-3.5 px-4">Invoice Date</th>
                    <th className="py-3.5 px-4">Customer / Unit</th>
                    <th className="py-3.5 px-4 text-right">Crimping</th>
                    <th className="py-3.5 px-4 text-right">Welding</th>
                    <th className="py-3.5 px-4 text-right">Lathe</th>
                    <th className="py-3.5 px-4 text-right">Technical</th>
                    <th className="py-3.5 px-4 text-right">Total Labour</th>
                    <th className="py-3.5 px-4 text-center">Labour Status</th>
                    <th className="py-3.5 px-4 text-center">Billing Classification</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {loading ? (
                    <tr>
                      <td colSpan={11} className="py-12 text-center text-slate-500">
                        <Loader2 className="w-6 h-6 text-amber-500 animate-spin mx-auto mb-2" />
                        Loading unpaid labour invoices...
                      </td>
                    </tr>
                  ) : filteredUnbilled.length === 0 ? (
                    <tr>
                      <td colSpan={11} className="py-12 text-center text-slate-500">
                        <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                        No unpaid labour invoices found for the selected filter.
                      </td>
                    </tr>
                  ) : (
                    filteredUnbilled.map((item) => {
                      const isHistorical = Boolean(settings?.EffectiveDate && item.InvoiceDate < settings.EffectiveDate);
                      const isSelected = selectedInvoiceIds.includes(item.InvoiceID);
                      return (
                        <tr
                          key={item.InvoiceID}
                          className={`hover:bg-slate-50/70 transition cursor-pointer ${
                            isSelected ? 'bg-indigo-50/50 font-medium' : ''
                          }`}
                          onClick={() => {
                            if (isSelected) {
                              setSelectedInvoiceIds((prev) => prev.filter((id) => id !== item.InvoiceID));
                            } else {
                              setSelectedInvoiceIds((prev) => [...prev, item.InvoiceID]);
                            }
                          }}
                        >
                          <td className="py-3.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedInvoiceIds((prev) => [...prev, item.InvoiceID]);
                                } else {
                                  setSelectedInvoiceIds((prev) => prev.filter((id) => id !== item.InvoiceID));
                                }
                              }}
                              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                            />
                          </td>
                          <td className="py-3.5 px-4 whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-slate-900 font-mono">{item.InvoiceNo}</span>
                              {item.IsInternal && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-100 text-sky-800">
                                  INTERNAL
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3.5 px-4 whitespace-nowrap text-xs text-slate-500">
                            {formatDate(item.InvoiceDate)}
                          </td>
                          <td className="py-3.5 px-4 whitespace-nowrap text-xs text-slate-800 font-medium max-w-xs truncate">
                            {item.Customer}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap font-mono text-xs text-slate-600">
                            {formatLKR(item.Crimping)}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap font-mono text-xs text-slate-600">
                            {formatLKR(item.Welding)}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap font-mono text-xs text-slate-600">
                            {formatLKR(item.Lathe)}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap font-mono text-xs text-slate-600">
                            {formatLKR(item.Technical)}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap font-mono text-sm font-bold text-slate-900">
                            {formatLKR(item.LineTotal)}
                          </td>
                          <td className="py-3.5 px-4 text-center whitespace-nowrap">
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                              <Clock className="w-3 h-3 text-amber-500" /> Labour Unpaid
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-center whitespace-nowrap">
                            {isHistorical ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200" title="Protected from auto-billing per user instruction">
                                Preserved (Aug 20 – Oct 5)
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                                Active Auto-Bill Pool
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* 4. Bills Table */
        <div className="bg-white rounded-2xl border border-slate-200/80 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/80 border-b border-slate-200 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                <tr>
                  <th className="py-3.5 px-4">Bill No</th>
                  <th className="py-3.5 px-4">Generated Date</th>
                  <th className="py-3.5 px-4 text-center">Jobs</th>
                  <th className="py-3.5 px-4 text-right">Crimping</th>
                  <th className="py-3.5 px-4 text-right">Welding / Lathe</th>
                  <th className="py-3.5 px-4 text-right">Total Amount</th>
                  <th className="py-3.5 px-4 text-center">Workflow Status</th>
                  <th className="py-3.5 px-4 text-center">Integrity</th>
                  <th className="py-3.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {loading ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-slate-500">
                      <Loader2 className="w-6 h-6 text-indigo-500 animate-spin mx-auto mb-2" />
                      Loading labour bills...
                    </td>
                  </tr>
                ) : filteredBills.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-slate-500">
                      <FileCheck className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                      No labour bills found in this view.
                    </td>
                  </tr>
                ) : (
                  filteredBills.map((b) => {
                    const needsMyAction = isAwaitingMyAction(b);
                    return (
                      <tr
                        key={b.BillID}
                        className={`hover:bg-slate-50/70 transition cursor-pointer ${
                          needsMyAction ? 'bg-amber-50/30 font-medium' : ''
                        }`}
                        onClick={() => loadBillDetails(b.BillID)}
                      >
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900 font-mono">{b.BillNo}</span>
                            {needsMyAction && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500 text-slate-950 uppercase tracking-wider">
                                Action Required
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            Period: {formatDate(b.PeriodFrom)} – {formatDate(b.PeriodTo)}
                          </div>
                        </td>

                        <td className="py-3.5 px-4 whitespace-nowrap text-xs text-slate-500">
                          {formatDate(b.CreatedAt)}
                          <div className="text-[11px] text-slate-400">By: {b.CreatedBy}</div>
                        </td>

                        <td className="py-3.5 px-4 text-center whitespace-nowrap font-semibold text-slate-800">
                          {b.JobCount}
                        </td>

                        <td className="py-3.5 px-4 text-right whitespace-nowrap font-mono text-xs text-slate-600">
                          {formatLKR(b.CrimpingTotal)}
                        </td>

                        <td className="py-3.5 px-4 text-right whitespace-nowrap font-mono text-xs text-slate-600">
                          {formatLKR((b.WeldingTotal || 0) + (b.LatheTotal || 0))}
                        </td>

                        <td className="py-3.5 px-4 text-right whitespace-nowrap font-mono text-sm font-bold text-slate-900">
                          {formatLKR(b.TotalAmount)}
                        </td>

                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          {getStatusBadge(b.Status)}
                        </td>

                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${
                              b.SealedBlob || b.IsSealed
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                            }`}
                            title={`Content Hash: ${b.ContentHash?.slice(0, 16)}...`}
                          >
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                            {b.SealedBlob || b.IsSealed ? 'Sealed & Safe' : 'Chain Intact'}
                          </span>
                        </td>

                        <td className="py-3.5 px-4 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                loadBillDetails(b.BillID).then(() => {
                                  setIsPdfModalOpen(true);
                                });
                              }}
                              className="p-1.5 rounded-xl border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-slate-600 hover:text-indigo-600 transition"
                              title="Export PDF with Job Profit Analysis"
                            >
                              <Printer className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                loadBillDetails(b.BillID);
                              }}
                              className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition ${
                                needsMyAction
                                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs'
                                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                              }`}
                            >
                              <span>{needsMyAction ? 'Process' : 'View'}</span>
                              <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 5. Comprehensive Bill Details & Approval Modal */}
      {selectedBillId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
          {loadingDetails || !billDetails ? (
            <div className="bg-white rounded-3xl p-8 max-w-sm w-full text-center shadow-2xl border border-slate-200">
              <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mx-auto mb-3" />
              <p className="text-sm font-semibold text-slate-800">Loading bill audit chain...</p>
              <p className="text-xs text-slate-400 mt-1">Verifying SHA-256 integrity</p>
            </div>
          ) : (
            <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 max-w-4xl w-full max-h-[92vh] flex flex-col animate-in fade-in zoom-in-95 duration-150 my-6">
              {/* Modal Header */}
              <div className="p-6 border-b border-slate-200 flex items-start justify-between bg-slate-50/60 rounded-t-3xl">
              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  <h2 className="text-xl font-bold text-slate-900 font-mono">
                    {billDetails.bill.BillNo}
                  </h2>
                  {getStatusBadge(billDetails.bill.Status)}
                  {billDetails.integrity.valid ? (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> Cryptographically Verified
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200">
                      <ShieldAlert className="w-3.5 h-3.5 text-rose-600" /> Integrity Warning
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500">
                  Covering period {formatDate(billDetails.bill.PeriodFrom)} – {formatDate(billDetails.bill.PeriodTo)} • Created on {formatDate(billDetails.bill.CreatedAt)} by {billDetails.bill.CreatedBy}
                </p>
                {billDetails.bill.TriggerReason && (
                  <p className="text-xs text-indigo-600 font-medium">
                    Trigger: {billDetails.bill.TriggerReason}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsPdfModalOpen(true)}
                  className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center gap-2 transition shadow-sm"
                  title="Generate multi-section Labour Bill PDF with Job Profit Analysis"
                >
                  <Printer className="w-4 h-4" />
                  <span>Export PDF (with Job Profit)</span>
                </button>
                <button
                  onClick={() => {
                    setSelectedBillId(null);
                    setBillDetails(null);
                  }}
                  className="p-2 hover:bg-slate-200/60 rounded-xl text-slate-500 hover:text-slate-700 transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Scrollable Body */}
            <div className="p-6 overflow-y-auto space-y-6 flex-1">
              {/* Charge Breakdown Cards */}
              {(() => {
                const crimpingSum = billDetails.items.reduce((s, i) => s + (i.Crimping || 0), 0);
                const weldingSum = billDetails.items.reduce((s, i) => s + (i.Welding || 0), 0);
                const latheSum = billDetails.items.reduce((s, i) => s + (i.Lathe || 0), 0);
                return (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                        <p className="text-[11px] font-semibold text-slate-500 uppercase">Crimping Charges</p>
                        <p className="text-lg font-bold text-slate-900 font-mono mt-1">
                          {formatLKR(crimpingSum)}
                        </p>
                      </div>
                      <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                        <p className="text-[11px] font-semibold text-slate-500 uppercase">Welding Charges</p>
                        <p className="text-lg font-bold text-slate-900 font-mono mt-1">
                          {formatLKR(weldingSum)}
                        </p>
                      </div>
                      <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                        <p className="text-[11px] font-semibold text-slate-500 uppercase">Lathe Work Charges</p>
                        <p className="text-lg font-bold text-slate-900 font-mono mt-1">
                          {formatLKR(latheSum)}
                        </p>
                      </div>
                      <div className="p-3.5 rounded-xl bg-indigo-50 border border-indigo-200">
                        <p className="text-[11px] font-bold text-indigo-700 uppercase">Grand Labour Total</p>
                        <p className="text-lg font-extrabold text-indigo-950 font-mono mt-1">
                          {formatLKR(billDetails.bill.TotalAmount)}
                        </p>
                      </div>
                    </div>

                    {/* Job Profit & Sourcing Comparison KPI Cards */}
                    {billDetails.profitSummary && (
                      <div className="pt-1">
                        <div className="flex items-center justify-between text-xs font-semibold text-slate-700 mb-2">
                          <span className="flex items-center gap-1.5 text-blue-900">
                            <TrendingUp className="w-4 h-4 text-blue-600" />
                            Job Profit Sourcing Benchmark ({billDetails.items.length} Jobs Analyzed)
                          </span>
                          <span className="text-[11px] text-slate-500 font-normal">
                            Landed Materials & Overhead vs. Outside Replacement
                          </span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <div className="p-3.5 rounded-xl bg-blue-50/70 border border-blue-200/80">
                            <p className="text-[11px] font-bold text-blue-800 uppercase tracking-wide">Our Total Cost</p>
                            <p className="text-lg font-bold text-blue-950 font-mono mt-1">
                              {formatLKR(billDetails.profitSummary.ourCost)}
                            </p>
                            <p className="text-[10px] text-blue-600/80 mt-1">
                              Parts: {formatLKR(billDetails.profitSummary.materialCost)} · Sundry: {formatLKR(billDetails.profitSummary.sundry)}
                            </p>
                          </div>

                          <div className="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200/80">
                            <p className="text-[11px] font-bold text-amber-800 uppercase tracking-wide">Outside Total Cost</p>
                            <p className="text-lg font-bold text-amber-950 font-mono mt-1">
                              {formatLKR(billDetails.profitSummary.outsideTotal)}
                            </p>
                            <p className="text-[10px] text-amber-600/80 mt-1">
                              Market benchmark cost
                            </p>
                          </div>

                          <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200/80">
                            <p className="text-[11px] font-bold text-emerald-800 uppercase tracking-wide">Sourcing Profit</p>
                            <p className="text-lg font-bold text-emerald-950 font-mono mt-1">
                              {formatLKR(billDetails.profitSummary.profit)}
                            </p>
                            <p className="text-[10px] text-emerald-600/80 mt-1">
                              Net fabrication savings
                            </p>
                          </div>

                          <div className="p-3.5 rounded-xl bg-emerald-100/60 border border-emerald-300">
                            <p className="text-[11px] font-extrabold text-emerald-900 uppercase tracking-wide">Gross Margin %</p>
                            <p className="text-lg font-extrabold text-emerald-950 font-mono mt-1">
                              {billDetails.profitSummary.marginPct}%
                            </p>
                            <p className="text-[10px] text-emerald-700/80 mt-1">
                              Cost advantage vs market
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Itemized Invoices Table */}
              {(() => {
                const canModifyItems = (isAdmin || role === 'workshop_supervisor') &&
                  (billDetails.bill.Status === 'GENERATED' || billDetails.bill.Status === 'RETURNED');
                const hasProfitData = !!billDetails.profitSummary;
                return (
                  <div className="rounded-2xl border border-slate-200 overflow-hidden">
                    <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-semibold text-slate-700">
                      <div className="flex items-center gap-2">
                        <span>Itemized Invoices & Sourcing Analysis ({billDetails.items.length} jobs)</span>
                        {canModifyItems && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700 border border-amber-200 font-normal">
                            Draft Mode: You can remove jobs to defer them to next bill
                          </span>
                        )}
                      </div>
                      <span className="text-slate-500 font-normal">
                        {canModifyItems ? 'Editable Draft' : 'Locked in Labour Bill'}
                      </span>
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-100/80 text-slate-600 font-semibold uppercase tracking-wider sticky top-0 z-10 border-b border-slate-200">
                          <tr>
                            <th className="py-2.5 px-3">Invoice No</th>
                            <th className="py-2.5 px-3">Date</th>
                            <th className="py-2.5 px-3">Customer / Machine</th>
                            <th className="py-2.5 px-3 text-right">Crimping</th>
                            <th className="py-2.5 px-3 text-right">Welding / Lathe</th>
                            <th className="py-2.5 px-3 text-right">Labour Total</th>
                            {hasProfitData && (
                              <>
                                <th className="py-2.5 px-3 text-right bg-blue-50/50 text-blue-900">Our Landed Cost</th>
                                <th className="py-2.5 px-3 text-right bg-amber-50/50 text-amber-900">Outside Cost</th>
                                <th className="py-2.5 px-3 text-right bg-emerald-50/50 text-emerald-900">Profit (Margin)</th>
                              </>
                            )}
                            {canModifyItems && (
                              <th className="py-2.5 px-3 text-center">Action</th>
                            )}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-mono">
                          {billDetails.items.map((item) => {
                            const prof = billDetails.profitSummary?.itemProfits?.[item.InvoiceNo];
                            return (
                              <tr key={item.BillItemID} className="hover:bg-slate-50/50">
                                <td className="py-2 px-3 font-bold text-slate-900 font-sans">
                                  <span>{item.InvoiceNo}</span>
                                  {prof?.hoseSize && (
                                    <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 font-mono">
                                      {prof.hoseSize}
                                    </span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-slate-500 font-sans">{formatDate(item.InvoiceDate)}</td>
                                <td className="py-2 px-3 text-slate-700 font-sans truncate max-w-[150px]">
                                  {item.Customer || item.CustomerName || '—'} {item.VehicleNo ? `(${item.VehicleNo})` : ''}
                                </td>
                                <td className="py-2 px-3 text-right text-slate-600">{formatLKR(item.Crimping)}</td>
                                <td className="py-2 px-3 text-right text-slate-600">{formatLKR((item.Welding || 0) + (item.Lathe || 0))}</td>
                                <td className="py-2 px-3 text-right font-bold text-slate-900 font-sans">{formatLKR(item.LineTotal)}</td>
                                {hasProfitData && (
                                  <>
                                    <td className="py-2 px-3 text-right text-blue-950 bg-blue-50/30">
                                      {prof ? formatLKR(prof.ourCost) : '—'}
                                    </td>
                                    <td className="py-2 px-3 text-right text-amber-950 bg-amber-50/30">
                                      {prof ? formatLKR(prof.outsideTotal) : '—'}
                                    </td>
                                    <td className="py-2 px-3 text-right font-bold text-emerald-700 bg-emerald-50/30 font-sans">
                                      {prof ? `${formatLKR(prof.profit)} (${prof.marginPct}%)` : '—'}
                                    </td>
                                  </>
                                )}
                                {canModifyItems && (
                                  <td className="py-2 px-3 text-center">
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveJob(item.BillItemID, item.InvoiceNo, item.LineTotal)}
                                      disabled={actionLoading || billDetails.items.length <= 1}
                                      className="px-2 py-1 rounded-lg text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 transition inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                                      title={billDetails.items.length <= 1 ? "Cannot remove only job" : "Remove job and defer to next bill"}
                                    >
                                      <MinusCircle className="w-3.5 h-3.5 text-rose-500" />
                                      <span>Remove (Defer)</span>
                                    </button>
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-bold text-slate-900">
                          <tr>
                            <td colSpan={3} className="py-2.5 px-3 uppercase text-[11px] font-sans">
                              Total ({billDetails.items.length} Jobs)
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono">{formatLKR(billDetails.bill.CrimpingTotal || 0)}</td>
                            <td className="py-2.5 px-3 text-right font-mono">{formatLKR((billDetails.bill.WeldingTotal || 0) + (billDetails.bill.LatheTotal || 0))}</td>
                            <td className="py-2.5 px-3 text-right font-mono text-indigo-700">{formatLKR(billDetails.bill.TotalAmount)}</td>
                            {hasProfitData && (
                              <>
                                <td className="py-2.5 px-3 text-right font-mono text-blue-900 bg-blue-50/60">
                                  {formatLKR(billDetails.profitSummary?.ourCost || 0)}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono text-amber-900 bg-amber-50/60">
                                  {formatLKR(billDetails.profitSummary?.outsideTotal || 0)}
                                </td>
                                <td className="py-2.5 px-3 text-right font-mono text-emerald-800 bg-emerald-50/60">
                                  {formatLKR(billDetails.profitSummary?.profit || 0)} ({billDetails.profitSummary?.marginPct}%)
                                </td>
                              </>
                            )}
                            {canModifyItems && <td></td>}
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {/* Immutable Cryptographic Audit & Approval Trail */}
              <div className="rounded-2xl border border-slate-200 p-4 space-y-3 bg-slate-50/40">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span className="flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    Cryptographic Audit & Approval Chain
                  </span>
                  <span className="text-[11px] text-slate-500 font-mono">
                    SHA-256 Hash Chain ({billDetails.approvals.length} signatures)
                  </span>
                </div>

                <div className="space-y-2.5">
                  {billDetails.approvals.map((appr) => (
                    <div
                      key={appr.ApprovalID}
                      className="p-3 rounded-xl bg-white border border-slate-200/80 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700 uppercase">
                            Stage {appr.Seq}: {appr.Action}
                          </span>
                          <span className="font-semibold text-slate-900">{appr.ActorID}</span>
                          <RoleBadge role={appr.ActorRole} />
                        </div>
                        {appr.Note && (
                          <p className="text-slate-600 italic mt-1 font-sans pl-2 border-l-2 border-indigo-400">
                            "{appr.Note}"
                          </p>
                        )}
                      </div>

                      <div className="text-right sm:text-right text-[11px] text-slate-400 font-mono">
                        <div>{formatDate(appr.At)}</div>
                        <div className="text-[10px] text-slate-400 truncate max-w-[220px]" title={appr.RecordHash}>
                          Hash: {appr.RecordHash.slice(0, 18)}...
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Sealed Bill Archive Banner if Closed */}
              {billDetails.bill.Status === 'CLOSED' && (
                <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div className="space-y-1">
                    <p className="font-bold text-emerald-900 flex items-center gap-1.5">
                      <Lock className="w-4 h-4 text-emerald-600" />
                      Bill Paid & Sealed with AES-256-GCM Encryption
                    </p>
                    <p className="text-emerald-700">
                      Disbursed on {formatDate(billDetails.bill.PaidDate)} via {billDetails.bill.PaymentMethod} to {billDetails.bill.PaidTo}. Invoices sealed and marked paid in General Ledger.
                    </p>
                  </div>

                  <button
                    onClick={() => handleOpenSealedArchive(billDetails.bill.BillID)}
                    className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold flex items-center gap-1.5 transition whitespace-nowrap shadow-xs"
                  >
                    <Eye className="w-4 h-4" />
                    Inspect Decrypted Archive
                  </button>
                </div>
              )}

              {/* Executive Read-Only Notification */}
              {(role === 'dgm' || role === 'chairman' || role === 'viewer') && (
                <div className="p-3.5 rounded-xl bg-slate-100 border border-slate-200 text-xs text-slate-600 flex items-center gap-2">
                  <Info className="w-4 h-4 text-slate-500 shrink-0" />
                  <span>
                    Executive View-Only Access: As {role.toUpperCase()}, you have real-time visibility into all stages and notes. Modifying workflow actions are segregated to operational roles.
                  </span>
                </div>
              )}
            </div>

            {/* Modal Interactive Action Footer */}
            {billDetails.bill.Status !== 'CLOSED' && (
              <div className="p-5 border-t border-slate-200 bg-slate-50/80 rounded-b-3xl">
                {/* 1. Workshop Supervisor Certification Stage */}
                {(billDetails.bill.Status === 'GENERATED' || billDetails.bill.Status === 'RETURNED') && (
                  <div className="space-y-3">
                    <label className="block text-xs font-semibold text-slate-700">
                      Supervisor Certification Notes (Optional)
                    </label>
                    <textarea
                      rows={2}
                      placeholder="Add certification notes before submitting to Operations Manager..."
                      value={actionNote}
                      onChange={(e) => setActionNote(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500/20"
                    />
                    <div className="flex items-center justify-end gap-3">
                      {(role === 'workshop_supervisor' || isAdmin) ? (
                        <button
                          onClick={handleCertify}
                          disabled={actionLoading}
                          className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center gap-1.5 transition shadow-sm"
                        >
                          <Check className="w-4 h-4" />
                          {actionLoading ? 'Certifying...' : 'Certify & Submit to Operations Manager'}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-500 italic">
                          Awaiting certification by Workshop Supervisor.
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* 2. Operations Manager Approval Stage */}
                {billDetails.bill.Status === 'CERTIFIED' && (
                  <div className="space-y-3">
                    <label className="block text-xs font-semibold text-slate-700">
                      Operations Manager Approval Comments / Reason
                    </label>
                    <textarea
                      rows={2}
                      placeholder="Add OM comments..."
                      value={actionNote}
                      onChange={(e) => setActionNote(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500/20"
                    />
                    <div className="flex items-center justify-end gap-3">
                      {(role === 'operations_manager' || isAdmin) ? (
                        <>
                          <button
                            onClick={() => setRejectModalOpen(true)}
                            disabled={actionLoading}
                            className="px-3.5 py-2 rounded-xl border border-rose-300 text-rose-700 hover:bg-rose-50 text-xs font-semibold flex items-center gap-1.5 transition"
                          >
                            <RotateCcw className="w-4 h-4" />
                            Return to Workshop
                          </button>
                          <button
                            onClick={handleApproveOM}
                            disabled={actionLoading}
                            className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold flex items-center gap-1.5 transition shadow-sm"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            {actionLoading ? 'Approving...' : 'Approve & Submit to Head Office'}
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-slate-500 italic">
                          Awaiting approval by Operations Manager.
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* 3. Head Office Accounts Final Approval Stage */}
                {billDetails.bill.Status === 'OM_APPROVED' && (
                  <div className="space-y-3">
                    <label className="block text-xs font-semibold text-slate-700">
                      Head Office Accounts Certification Notes
                    </label>
                    <textarea
                      rows={2}
                      placeholder="Add HO accounts review notes..."
                      value={actionNote}
                      onChange={(e) => setActionNote(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500/20"
                    />
                    <div className="flex items-center justify-end gap-3">
                      {(role === 'ho_accounts' || isAdmin) ? (
                        <>
                          <button
                            onClick={() => setRejectModalOpen(true)}
                            disabled={actionLoading}
                            className="px-3.5 py-2 rounded-xl border border-rose-300 text-rose-700 hover:bg-rose-50 text-xs font-semibold flex items-center gap-1.5 transition"
                          >
                            <RotateCcw className="w-4 h-4" />
                            Return Bill
                          </button>
                          <button
                            onClick={handleApproveHO}
                            disabled={actionLoading}
                            className="px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold flex items-center gap-1.5 transition shadow-sm"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            {actionLoading ? 'Approving...' : 'Certify & Authorize Payout'}
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-slate-500 italic">
                          Awaiting authorization by Head Office Accounts.
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* 4. Workshop Accounts Settlement & Cryptographic Sealing Stage */}
                {billDetails.bill.Status === 'HO_APPROVED' && (
                  <form onSubmit={handlePayAndClose} className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
                      <div>
                        <label className="block font-semibold text-slate-600 mb-1">Disbursement Date</label>
                        <input
                          type="date"
                          value={payDate}
                          onChange={(e) => setPayDate(e.target.value)}
                          className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-xl"
                          required
                        />
                      </div>
                      <div>
                        <label className="block font-semibold text-slate-600 mb-1">Payment Method</label>
                        <select
                          value={payMethod}
                          onChange={(e) => setPayMethod(e.target.value)}
                          className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-xl"
                        >
                          <option value="Cash">Cash (Petty Cash)</option>
                          <option value="Bank Transfer">Bank Transfer</option>
                          <option value="Cheque">Cheque</option>
                        </select>
                      </div>
                      <div>
                        <label className="block font-semibold text-slate-600 mb-1">Reference / Cheque #</label>
                        <input
                          type="text"
                          placeholder="Ref / Chq #"
                          value={payRef}
                          onChange={(e) => setPayRef(e.target.value)}
                          className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-xl"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold text-slate-600 mb-1">Disbursed To</label>
                        <input
                          type="text"
                          value={payTo}
                          onChange={(e) => setPayTo(e.target.value)}
                          className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-xl"
                          required
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block font-semibold text-slate-600 mb-1 text-xs">Payment & Settlement Remarks</label>
                      <input
                        type="text"
                        placeholder="Add disbursement remarks or cheque details..."
                        value={payNotes}
                        onChange={(e) => setPayNotes(e.target.value)}
                        className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs"
                      />
                    </div>

                    <div className="flex items-center justify-between pt-2">
                      <span className="text-xs text-slate-500">
                        Disburses {formatLKR(billDetails.bill.TotalAmount)} & seals cryptographic archive.
                      </span>

                      {(role === 'workshop_accounts' || isAdmin) ? (
                        <button
                          type="submit"
                          disabled={actionLoading}
                          className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-2 transition shadow-md shadow-emerald-600/20"
                        >
                          <Lock className="w-4 h-4" />
                          {actionLoading ? 'Sealing...' : 'Disburse Payment & Seal Bill (AES-256)'}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-500 italic">
                          Awaiting disbursement by Workshop Accounts.
                        </span>
                      )}
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    )}

      {/* 6. Return / Rejection Modal */}
      {rejectModalOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 max-w-md w-full space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <RotateCcw className="w-5 h-5 text-rose-600" />
              Return Bill for Correction
            </h3>
            <p className="text-xs text-slate-500">
              Please enter the specific reason for returning this bill. The workshop supervisor will be required to review and re-certify.
            </p>
            <textarea
              rows={3}
              placeholder="Explain required changes or discrepancies..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-rose-500/20"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRejectModalOpen(false)}
                className="px-3.5 py-1.5 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReject}
                disabled={actionLoading}
                className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold transition"
              >
                {actionLoading ? 'Returning...' : 'Confirm Return'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. Threshold Settings Modal */}
      {isSettingsOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-6 max-w-md w-full space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Sliders className="w-5 h-5 text-indigo-600" />
                Automatic Trigger Conditions
              </h3>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveSettings} className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Condition 1: Total Labour Amount Threshold (Rs.)
                </label>
                <input
                  type="number"
                  value={settingsMinAmount}
                  onChange={(e) => setSettingsMinAmount(Number(e.target.value))}
                  min={1000}
                  step={500}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl"
                  required
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Default: Rs. 15,000. Triggers automatically when unbilled pool reaches this sum.
                </p>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Condition 2: Job Count Threshold
                </label>
                <input
                  type="number"
                  value={settingsMinJobs}
                  onChange={(e) => setSettingsMinJobs(Number(e.target.value))}
                  min={1}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl"
                  required
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Default: 10 jobs. Triggers automatically when 10 completed jobs accumulate.
                </p>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Condition 3: Calendar Days Count from Oldest Job
                </label>
                <input
                  type="number"
                  value={settingsMaxDays}
                  onChange={(e) => setSettingsMaxDays(Number(e.target.value))}
                  min={1}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl"
                  required
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Default: 15 calendar days. Triggers automatically after 15 days even if amount/jobs are below thresholds.
                </p>
              </div>

              <div className="pt-2">
                <label className="flex items-center gap-2 font-semibold text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settingsEnabled}
                    onChange={(e) => setSettingsEnabled(e.target.checked)}
                    className="rounded text-indigo-600"
                  />
                  Enable Automated Trigger Background Engine
                </label>
              </div>

              <div className="border-t border-slate-200 pt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(false)}
                  className="px-3.5 py-1.5 border border-slate-200 rounded-xl font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSettings}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold transition"
                >
                  {savingSettings ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 8. Decrypted Sealed Bill Archive Inspection Modal */}
      {isSealedModalOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 max-w-2xl w-full p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150 my-6">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <LockKeyhole className="w-5 h-5 text-emerald-600" />
                Decrypted Sealed Archive: {sealedData?.billNo}
              </h3>
              <button
                onClick={() => setIsSealedModalOpen(false)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {loadingSealed ? (
              <div className="py-12 text-center text-slate-500 text-xs">
                <Loader2 className="w-6 h-6 text-emerald-600 animate-spin mx-auto mb-2" />
                Decrypting AES-256-GCM cipher archive & verifying SHA-256 seal hash...
              </div>
            ) : sealedData ? (
              <div className="space-y-4 text-xs">
                <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 flex items-center justify-between">
                  <span className="font-semibold flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-emerald-600" />
                    Cryptographic Signature Verified
                  </span>
                  <span className="font-mono text-[11px] truncate max-w-[200px]" title={sealedData.sealHash}>
                    Seal: {sealedData.sealHash.slice(0, 16)}...
                  </span>
                </div>

                <div className="bg-slate-900 text-slate-100 p-4 rounded-2xl font-mono text-[11px] max-h-80 overflow-y-auto">
                  <pre>{JSON.stringify(sealedData.payload, null, 2)}</pre>
                </div>

                <p className="text-[11px] text-slate-400">
                  Note: An entry has been recorded in the SecurityAuditLog documenting this archive decryption.
                </p>

                <div className="flex justify-end pt-2">
                  <button
                    onClick={() => setIsSealedModalOpen(false)}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-semibold"
                  >
                    Close Inspection
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* 9. PDF Report Export with Job Profit Analysis Modal */}
      {isPdfModalOpen && selectedBillId && billDetails && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 max-w-xl w-full p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150 my-6">
            <div className="flex items-start justify-between border-b border-slate-200 pb-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100">
                  <Printer className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    Export Labour Bill & Job Profit Analysis PDF
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono">
                    {billDetails.bill.BillNo} • {billDetails.items.length} Jobs • {formatLKR(billDetails.bill.TotalAmount)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsPdfModalOpen(false)}
                className="p-1.5 hover:bg-slate-100 rounded-xl text-slate-400 hover:text-slate-600 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Quick Section Presets */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-600">Quick Selection Presets:</label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setPdfSections({
                      voucher: true,
                      labourItems: true,
                      jobProfit: true,
                      approvals: true,
                      integrity: true,
                    })
                  }
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 transition"
                >
                  All 5 Sections (Recommended)
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setPdfSections({
                      voucher: true,
                      labourItems: true,
                      jobProfit: false,
                      approvals: true,
                      integrity: true,
                    })
                  }
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition"
                >
                  Standard Voucher (No Profit)
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setPdfSections({
                      voucher: true,
                      labourItems: false,
                      jobProfit: true,
                      approvals: true,
                      integrity: false,
                    })
                  }
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 transition"
                >
                  Executive Profit Summary
                </button>
              </div>
            </div>

            {/* Interactive Section Checkboxes */}
            <div className="space-y-2.5">
              <label className="text-xs font-semibold text-slate-700">Customize Included PDF Sections:</label>

              {/* Section 1: Voucher */}
              <label className={`flex items-start gap-3 p-3 rounded-2xl border transition cursor-pointer ${
                pdfSections.voucher ? 'bg-indigo-50/40 border-indigo-200' : 'bg-slate-50 border-slate-200'
              }`}>
                <input
                  type="checkbox"
                  checked={pdfSections.voucher}
                  onChange={(e) => setPdfSections((prev) => ({ ...prev, voucher: e.target.checked }))}
                  className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <div className="text-xs">
                  <div className="font-bold text-slate-900 flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-indigo-600" />
                    Section 1: Labour Bill Voucher & Summary
                  </div>
                  <div className="text-slate-500 text-[11px] mt-0.5">
                    Includes bill metadata, period dates, total amount, settlement payee, and workshop certification sign-offs.
                  </div>
                </div>
              </label>

              {/* Section 2: Labour Items */}
              <label className={`flex items-start gap-3 p-3 rounded-2xl border transition cursor-pointer ${
                pdfSections.labourItems ? 'bg-indigo-50/40 border-indigo-200' : 'bg-slate-50 border-slate-200'
              }`}>
                <input
                  type="checkbox"
                  checked={pdfSections.labourItems}
                  onChange={(e) => setPdfSections((prev) => ({ ...prev, labourItems: e.target.checked }))}
                  className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <div className="text-xs">
                  <div className="font-bold text-slate-900 flex items-center gap-1.5">
                    <Briefcase className="w-3.5 h-3.5 text-indigo-600" />
                    Section 2: Itemized Labour Charges Breakdown
                  </div>
                  <div className="text-slate-500 text-[11px] mt-0.5">
                    Complete tabular breakdown of Crimping, Welding, Lathe Work, and Technical Charges for every job.
                  </div>
                </div>
              </label>

              {/* Section 3: Job Profit Analysis */}
              <label className={`flex items-start gap-3 p-3 rounded-2xl border transition cursor-pointer ${
                pdfSections.jobProfit ? 'bg-indigo-50/40 border-indigo-200' : 'bg-slate-50 border-slate-200'
              }`}>
                <input
                  type="checkbox"
                  checked={pdfSections.jobProfit}
                  onChange={(e) => setPdfSections((prev) => ({ ...prev, jobProfit: e.target.checked }))}
                  className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <div className="text-xs">
                  <div className="font-bold text-slate-900 flex items-center gap-1.5">
                    <TrendingUp className="w-3.5 h-3.5 text-indigo-600" />
                    Section 3: Job Profit Analysis (Cost vs Market Benchmark)
                  </div>
                  <div className="text-slate-500 text-[11px] mt-0.5">
                    Compares Landed Material Costs vs Outside Benchmark Market Rates to calculate internal workshop profit margin %.
                  </div>
                </div>
              </label>

              {/* Section 4: Approvals */}
              <label className={`flex items-start gap-3 p-3 rounded-2xl border transition cursor-pointer ${
                pdfSections.approvals ? 'bg-indigo-50/40 border-indigo-200' : 'bg-slate-50 border-slate-200'
              }`}>
                <input
                  type="checkbox"
                  checked={pdfSections.approvals}
                  onChange={(e) => setPdfSections((prev) => ({ ...prev, approvals: e.target.checked }))}
                  className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <div className="text-xs">
                  <div className="font-bold text-slate-900 flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-indigo-600" />
                    Section 4: Multi-Stage Certification & Approval Signatures Chain
                  </div>
                  <div className="text-slate-500 text-[11px] mt-0.5">
                    Full audit trail for Workshop Supervisor, Operations Manager, and Head Office Accounts with actor notes.
                  </div>
                </div>
              </label>

              {/* Section 5: Integrity */}
              <label className={`flex items-start gap-3 p-3 rounded-2xl border transition cursor-pointer ${
                pdfSections.integrity ? 'bg-indigo-50/40 border-indigo-200' : 'bg-slate-50 border-slate-200'
              }`}>
                <input
                  type="checkbox"
                  checked={pdfSections.integrity}
                  onChange={(e) => setPdfSections((prev) => ({ ...prev, integrity: e.target.checked }))}
                  className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <div className="text-xs">
                  <div className="font-bold text-slate-900 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-indigo-600" />
                    Section 5: Cryptographic Content Hash & Security Seal
                  </div>
                  <div className="text-slate-500 text-[11px] mt-0.5">
                    Verifiable SHA-256 Content Hash and AES-256 seal status to ensure audit tamper resistance.
                  </div>
                </div>
              </label>
            </div>

            {/* Modal Footer */}
            <div className="border-t border-slate-200 pt-4 flex items-center justify-between">
              <span className="text-[11px] text-slate-400">
                Generated via executive Puppeteer PDF engine
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsPdfModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleDownloadPdf(billDetails.bill.BillID)}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition shadow-md shadow-indigo-600/20"
                >
                  <Download className="w-4 h-4" />
                  <span>Download PDF Report</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
