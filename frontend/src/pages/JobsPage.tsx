import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  JobCard,
  Customer,
  Machine,
  Worker,
  InventoryItem,
  Quotation,
  LabourOwedSummary
} from '../types/models';
import { formatLKR, formatDate } from '../utils/format';
import {
  Wrench,
  Plus,
  Search,
  Clock,
  CheckCircle2,
  AlertTriangle,
  FileText,
  DollarSign,
  User,
  Trash2,
  X,
  Loader2,
  ShieldCheck
} from 'lucide-react';

export const JobsPage: React.FC = () => {
  const { isManager, isAdmin, canWrite } = useAuth();

  // Active Tab: 'jobs' | 'quotes' | 'labour'
  const [activeTab, setActiveTab] = useState<'jobs' | 'quotes' | 'labour'>('jobs');

  // Jobs state
  const [jobs, setJobs] = useState<JobCard[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Masters
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);

  // Quotations state
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [quotesLoading, setQuotesLoading] = useState<boolean>(false);

  // Labour Owed state
  const [labourOwed, setLabourOwed] = useState<LabourOwedSummary | null>(null);
  const [labourLoading, setLabourLoading] = useState<boolean>(false);

  // Job Modal state
  const [selectedJob, setSelectedJob] = useState<JobCard | null>(null);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [modalSubmitting, setModalSubmitting] = useState<boolean>(false);

  // Form Fields
  const [jobId, setJobId] = useState<number | null>(null);
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [machineId, setMachineId] = useState<number | ''>('');
  const [description, setDescription] = useState<string>('');
  const [hoseSpec, setHoseSpec] = useState<string>('');
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal');
  const [status, setStatus] = useState<JobCard['Status']>('open');
  const [receivedAt, setReceivedAt] = useState<string>(new Date().toISOString().slice(0, 10));
  const [promisedAt, setPromisedAt] = useState<string>('');

  // Job Items
  const [jobItems, setJobItems] = useState<Array<{
    inventoryId: number | null;
    description: string;
    unit: string;
    qty: number;
    rate: number;
  }>>([]);

  // Labour Entry form within modal
  const [labourWorkerId, setLabourWorkerId] = useState<number | ''>('');
  const [labourWorkType, setLabourWorkType] = useState<string>('Crimping');
  const [labourUnits, setLabourUnits] = useState<number>(2);
  const [labourRate, setLabourRate] = useState<number>(150);
  const [isAddingLabour, setIsAddingLabour] = useState<boolean>(false);

  // Load masters once
  useEffect(() => {
    const loadMasters = async () => {
      try {
        const [c, m, w, inv] = await Promise.all([
          apiRequest<Customer[]>('/customers'),
          apiRequest<Machine[]>('/machines'),
          apiRequest<Worker[]>('/workers'),
          apiRequest<InventoryItem[]>('/inventory'),
        ]);
        setCustomers(Array.isArray(c) ? c : []);
        setMachines(Array.isArray(m) ? m : []);
        setWorkers(Array.isArray(w) ? w : []);
        setInventoryItems(Array.isArray(inv) ? inv : []);
      } catch (e) {
        console.error('Failed to load workshop masters', e);
      }
    };
    loadMasters();
  }, []);

  // Load Jobs
  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<JobCard[]>('/jobs');
      setJobs(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load Quotations
  const loadQuotes = useCallback(async () => {
    setQuotesLoading(true);
    try {
      const data = await apiRequest<Quotation[]>('/quotations');
      setQuotations(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setQuotesLoading(false);
    }
  }, []);

  // Load Labour Owed
  const loadLabour = useCallback(async () => {
    setLabourLoading(true);
    try {
      const data = await apiRequest<LabourOwedSummary>('/labour/owed');
      setLabourOwed(data || null);
    } catch (e) {
      console.error(e);
    } finally {
      setLabourLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'jobs') loadJobs();
    if (activeTab === 'quotes') loadQuotes();
    if (activeTab === 'labour') loadLabour();
  }, [activeTab, loadJobs, loadQuotes, loadLabour]);

  // Open Create Job Modal
  const handleOpenNewJob = () => {
    setJobId(null);
    setSelectedJob(null);
    setCustomerId('');
    setMachineId('');
    setDescription('');
    setHoseSpec('');
    setPriority('normal');
    setStatus('open');
    setReceivedAt(new Date().toISOString().slice(0, 10));
    setPromisedAt('');
    setJobItems([
      { inventoryId: null, description: '', unit: 'pcs', qty: 1, rate: 0 },
    ]);
    setIsModalOpen(true);
  };

  // Open Existing Job Modal
  const handleOpenJob = async (id: number) => {
    try {
      const j = await apiRequest<JobCard>(`/jobs/${id}`);
      setSelectedJob(j);
      setJobId(j.JobID);
      setCustomerId(j.CustomerID || '');
      setMachineId(j.MachineID || '');
      setDescription(j.Description || '');
      setHoseSpec(j.HoseSpec || '');
      setPriority(j.Priority || 'normal');
      setStatus(j.Status);
      setReceivedAt(String(j.ReceivedAt || '').slice(0, 10));
      setPromisedAt(j.PromisedAt ? String(j.PromisedAt).slice(0, 10) : '');

      if (j.items && j.items.length > 0) {
        setJobItems(
          j.items.map((i) => ({
            inventoryId: i.InventoryID || null,
            description: i.Description,
            unit: i.Unit,
            qty: i.Qty,
            rate: i.Rate,
          }))
        );
      } else {
        setJobItems([{ inventoryId: null, description: '', unit: 'pcs', qty: 1, rate: 0 }]);
      }

      setIsModalOpen(true);
    } catch (err: any) {
      alert(err.message || 'Could not load job details');
    }
  };

  // Add Item Line
  const handleAddJobLine = () => {
    setJobItems((prev) => [
      ...prev,
      { inventoryId: null, description: '', unit: 'pcs', qty: 1, rate: 0 },
    ]);
  };

  const handleUpdateJobLine = (idx: number, field: string, val: any) => {
    setJobItems((prev) => {
      const next = [...prev];
      if (field === 'inventoryId') {
        const invId = val ? Number(val) : null;
        const item = inventoryItems.find((x) => x.InventoryID === invId);
        next[idx] = {
          ...next[idx],
          inventoryId: invId,
          description: item ? `${item.ProductName} ${item.SpecificationCode || ''}` : next[idx].description,
          unit: item ? item.Unit : next[idx].unit,
          rate: item ? (item.Price || 0) : next[idx].rate,
        };
      } else {
        next[idx] = { ...next[idx], [field]: val };
      }
      return next;
    });
  };

  const handleRemoveJobLine = (idx: number) => {
    setJobItems((prev) => prev.filter((_, i) => i !== idx));
  };

  // Submit Job Card (Save / Update)
  const handleSubmitJob = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalSubmitting(true);
    try {
      const payload: any = {
        customerId: customerId || null,
        machineId: machineId || null,
        description: description.trim(),
        hoseSpec: hoseSpec.trim(),
        priority,
        receivedAt,
        promisedAt: promisedAt || null,
        items: jobItems
          .filter((i) => (Number(i.qty) || 0) > 0)
          .map((i) => ({
            inventoryId: i.inventoryId || null,
            description: i.description.trim(),
            unit: i.unit.trim() || 'pcs',
            qty: Number(i.qty) || 0,
            rate: Number(i.rate) || 0,
          })),
      };

      if (jobId) {
        payload.status = status;
        await apiRequest(`/jobs/${jobId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        alert('Job updated successfully');
      } else {
        const res = await apiRequest('/jobs', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        alert(`Job ${res.jobNo} opened successfully`);
        setIsModalOpen(false);
      }
      await loadJobs();
      if (jobId) {
        handleOpenJob(jobId);
      }
    } catch (err: any) {
      alert(err.message || 'Error saving job card');
    } finally {
      setModalSubmitting(false);
    }
  };

  // Add Technician Labour to Job
  const handleAddLabour = async () => {
    if (!jobId) {
      alert('Save the job card before recording technician labour.');
      return;
    }
    if (!(labourUnits > 0 && labourRate > 0)) {
      alert('Please specify units and rate.');
      return;
    }
    setIsAddingLabour(true);
    try {
      await apiRequest(`/jobs/${jobId}/labour`, {
        method: 'POST',
        body: JSON.stringify({
          workerId: labourWorkerId || null,
          workType: labourWorkType,
          units: labourUnits,
          rate: labourRate,
          unitLabel: 'end',
        }),
      });
      // Refresh job
      await handleOpenJob(jobId);
      setLabourUnits(2);
    } catch (err: any) {
      alert(err.message || 'Could not record labour');
    } finally {
      setIsAddingLabour(false);
    }
  };

  // Invoice Job Card directly
  const handleInvoiceJob = async () => {
    if (!jobId) return;
    try {
      const p = await apiRequest(`/jobs/${jobId}/invoice-payload`);
      if (!window.confirm(`Invoice Job ${p.jobNo} for ${p.billedToName}?\nGrand Total will be finalized and inventory deducted immediately.`)) {
        return;
      }
      const invRes = await apiRequest('/invoices/finalize', {
        method: 'POST',
        body: JSON.stringify({
          billedToName: p.billedToName,
          billedToAddress: p.billedToAddress,
          items: p.items,
          discount: 0,
        }),
      });
      await apiRequest(`/jobs/${jobId}/invoiced`, {
        method: 'POST',
        body: JSON.stringify({ invoiceId: invRes.invoiceId }),
      });
      alert(`Job invoiced successfully as ${invRes.invoiceNo}!`);
      setIsModalOpen(false);
      await loadJobs();
    } catch (err: any) {
      alert(err.message || 'Error invoicing job');
    }
  };

  // Quotation convert to job
  const handleConvertQuote = async (quoteId: number) => {
    if (!window.confirm('Convert this quotation into an active workshop Job Card?')) return;
    try {
      const res = await apiRequest(`/quotations/${quoteId}/convert`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      alert(`Job ${res.jobNo} started from quotation!`);
      setActiveTab('jobs');
      await loadJobs();
    } catch (err: any) {
      alert(err.message || 'Error starting job');
    }
  };

  // Technician Labour Payout
  const handlePayLabour = async (workerId: number | null, ids: number[], amount: number, workerName: string) => {
    if (!window.confirm(`Pay ${formatLKR(amount)} in cash to ${workerName}? This settles the accrued technician liability.`)) {
      return;
    }
    try {
      await apiRequest('/labour/pay', {
        method: 'POST',
        body: JSON.stringify({
          workerId,
          jobLabourIds: ids,
          paymentDate: new Date().toISOString().slice(0, 10),
          method: 'Cash',
        }),
      });
      alert(`Paid ${formatLKR(amount)} to ${workerName}!`);
      await loadLabour();
    } catch (err: any) {
      alert(err.message || 'Error recording payout');
    }
  };

  // Stats calculation
  const stats = useMemo(() => {
    const open = jobs.filter((j) => !['invoiced', 'cancelled'].includes(j.Status));
    const urgent = open.filter((j) => j.Priority === 'urgent');
    const completed = jobs.filter((j) => j.Status === 'completed');
    return {
      openCount: open.length,
      urgentCount: urgent.length,
      completedCount: completed.length,
    };
  }, [jobs]);

  // Filtered jobs
  const filteredJobs = useMemo(() => {
    return jobs.filter((j) => {
      const matchesSearch =
        !search.trim() ||
        j.JobNo.toLowerCase().includes(search.toLowerCase()) ||
        (j.CustomerName && j.CustomerName.toLowerCase().includes(search.toLowerCase())) ||
        (j.MachineName && j.MachineName.toLowerCase().includes(search.toLowerCase())) ||
        (j.Description && j.Description.toLowerCase().includes(search.toLowerCase()));

      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'open' && !['invoiced', 'cancelled'].includes(j.Status)) ||
        j.Status.toLowerCase() === statusFilter.toLowerCase();

      return matchesSearch && matchesStatus;
    });
  }, [jobs, search, statusFilter]);

  const getJobStatusBadge = (status: string) => {
    switch (status) {
      case 'invoiced':
        return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"><CheckCircle2 className="w-3 h-3" /> Invoiced</span>;
      case 'completed':
        return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200"><ShieldCheck className="w-3 h-3" /> Ready</span>;
      case 'in-progress':
        return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200"><Wrench className="w-3 h-3" /> In Progress</span>;
      case 'waiting-parts':
        return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-200"><Clock className="w-3 h-3" /> Waiting Parts</span>;
      case 'cancelled':
        return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200">Cancelled</span>;
      default:
        return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">Open</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Active Workshop Jobs</p>
          <p className="text-2xl font-bold text-slate-800 mt-2">{stats.openCount}</p>
          <p className="text-xs text-slate-400 mt-1">Hoses currently in progress</p>
        </div>

        <div className="bg-white rounded-2xl border border-rose-200/80 p-5 shadow-sm bg-rose-50/20">
          <p className="text-xs font-semibold text-rose-600 uppercase tracking-wider flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-rose-500" /> Urgent Jobs
          </p>
          <p className="text-2xl font-bold text-rose-700 mt-2">{stats.urgentCount}</p>
          <p className="text-xs text-rose-500 mt-1">High-priority customer turnarounds</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Completed / Ready to Bill</p>
          <p className="text-2xl font-bold text-emerald-600 mt-2">{stats.completedCount}</p>
          <p className="text-xs text-slate-400 mt-1">Ready for pickup & invoicing</p>
        </div>
      </div>

      {/* Workshop Navigation Tabs */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2 bg-slate-100 p-1.5 rounded-2xl w-full sm:w-auto">
          <button
            onClick={() => setActiveTab('jobs')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'jobs'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Wrench className="w-3.5 h-3.5" /> Job Cards
          </button>
          <button
            onClick={() => setActiveTab('quotes')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'quotes'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileText className="w-3.5 h-3.5" /> Quotations
          </button>
          <button
            onClick={() => setActiveTab('labour')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'labour'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <DollarSign className="w-3.5 h-3.5" /> Technician Payouts
          </button>
        </div>

        {activeTab === 'jobs' && canWrite && (
          <button
            onClick={handleOpenNewJob}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold shadow-sm transition w-full sm:w-auto justify-center"
          >
            <Plus className="w-4 h-4" /> New Job Card
          </button>
        )}
      </div>

      {/* TAB 1: JOB CARDS */}
      {activeTab === 'jobs' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-sm flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="relative flex-1 max-w-md w-full">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search jobs by #, customer, vehicle, description..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>

            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs font-semibold overflow-x-auto w-full md:w-auto">
              {[
                { id: 'all', label: 'All Jobs' },
                { id: 'open', label: 'Active Open' },
                { id: 'in-progress', label: 'In Progress' },
                { id: 'completed', label: 'Ready' },
                { id: 'invoiced', label: 'Invoiced' },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setStatusFilter(t.id)}
                  className={`px-3 py-1.5 rounded-lg whitespace-nowrap transition ${
                    statusFilter === t.id
                      ? 'bg-white text-indigo-600 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <tr>
                    <th className="py-3.5 px-4">Job No</th>
                    <th className="py-3.5 px-4">Received</th>
                    <th className="py-3.5 px-4">Customer / Machine</th>
                    <th className="py-3.5 px-4">Description</th>
                    <th className="py-3.5 px-4 text-right">Items Total</th>
                    <th className="py-3.5 px-4 text-right">Labour</th>
                    <th className="py-3.5 px-4 text-center">Status</th>
                    <th className="py-3.5 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {loading ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-400">
                        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                        Loading job cards...
                      </td>
                    </tr>
                  ) : filteredJobs.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-400">
                        <Wrench className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                        No job cards found.
                      </td>
                    </tr>
                  ) : (
                    filteredJobs.map((j) => (
                      <tr
                        key={j.JobID}
                        className={`hover:bg-slate-50/60 transition ${
                          j.Priority === 'urgent' && j.Status !== 'invoiced'
                            ? 'bg-rose-50/30'
                            : ''
                        }`}
                      >
                        <td className="py-3.5 px-4 font-bold text-slate-900">
                          {j.JobNo}
                          {j.Priority === 'urgent' && (
                            <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 border border-rose-200">
                              URGENT
                            </span>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-slate-500 whitespace-nowrap">
                          {formatDate(j.ReceivedAt)}
                        </td>
                        <td className="py-3.5 px-4 font-medium text-slate-800">
                          {j.MachineName || j.CustomerName || '—'}
                        </td>
                        <td className="py-3.5 px-4 text-slate-600 max-w-xs truncate">
                          {j.Description || '—'}
                        </td>
                        <td className="py-3.5 px-4 text-right font-semibold text-slate-900">
                          {formatLKR(j.Total)}
                        </td>
                        <td className="py-3.5 px-4 text-right text-slate-600">
                          {j.LabourCost ? formatLKR(j.LabourCost) : '—'}
                        </td>
                        <td className="py-3.5 px-4 text-center whitespace-nowrap">
                          {getJobStatusBadge(j.Status)}
                          {j.InvoiceNo && (
                            <p className="text-[10px] font-mono font-medium text-indigo-600 mt-0.5">
                              {j.InvoiceNo}
                            </p>
                          )}
                        </td>
                        <td className="py-3.5 px-4 text-right whitespace-nowrap">
                          <button
                            onClick={() => handleOpenJob(j.JobID)}
                            className="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold transition"
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: QUOTATIONS */}
      {activeTab === 'quotes' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                <tr>
                  <th className="py-3.5 px-4">Quote No</th>
                  <th className="py-3.5 px-4">Date</th>
                  <th className="py-3.5 px-4">Customer / Machine</th>
                  <th className="py-3.5 px-4 text-center">Lines</th>
                  <th className="py-3.5 px-4 text-right">Estimate Total</th>
                  <th className="py-3.5 px-4 text-center">Status</th>
                  <th className="py-3.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {quotesLoading ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                      Loading quotations...
                    </td>
                  </tr>
                ) : quotations.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      <FileText className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                      No quotations recorded yet.
                    </td>
                  </tr>
                ) : (
                  quotations.map((q) => (
                    <tr key={q.QuoteID} className="hover:bg-slate-50/60 transition">
                      <td className="py-3.5 px-4 font-bold text-slate-800">{q.QuoteNo}</td>
                      <td className="py-3.5 px-4 text-slate-500">{formatDate(q.QuoteDate)}</td>
                      <td className="py-3.5 px-4 font-medium text-slate-800">
                        {q.MachineName || q.CustomerName || '—'}
                      </td>
                      <td className="py-3.5 px-4 text-center">{q.Lines}</td>
                      <td className="py-3.5 px-4 text-right font-semibold text-slate-900">
                        {formatLKR(q.Total)}
                      </td>
                      <td className="py-3.5 px-4 text-center">
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                          {q.Status}
                        </span>
                        {q.JobNo && (
                          <p className="text-[10px] text-indigo-600 font-medium mt-0.5">
                            Job: {q.JobNo}
                          </p>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        {!q.JobNo && canWrite && (
                          <button
                            onClick={() => handleConvertQuote(q.QuoteID)}
                            className="px-3 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-semibold transition"
                          >
                            Start Job Card
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: TECHNICIAN LABOUR PAYOUTS */}
      {activeTab === 'labour' && (
        <div className="space-y-6">
          {labourOwed && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Unpaid Pieces of Work</p>
                <p className="text-2xl font-bold text-slate-800 mt-2">{labourOwed.count}</p>
                <p className="text-xs text-slate-400 mt-1">Crimping & machining tasks awaiting cash payout</p>
              </div>

              <div className="bg-white rounded-2xl border border-amber-200 p-5 shadow-sm bg-amber-50/20">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider flex items-center gap-1.5">
                  <DollarSign className="w-4 h-4 text-amber-600" /> Total Owed to Technicians
                </p>
                <p className="text-2xl font-bold text-amber-700 mt-2">{formatLKR(labourOwed.total)}</p>
                <p className="text-xs text-amber-600 mt-1">Accrued technician liabilities</p>
              </div>
            </div>
          )}

          {labourLoading ? (
            <div className="py-12 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">
              <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
              Loading technician payout roster...
            </div>
          ) : !labourOwed || labourOwed.workers.length === 0 ? (
            <div className="py-12 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">
              <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
              All technician work has been paid! No accrued labour balance remaining.
            </div>
          ) : (
            labourOwed.workers.map((w, idx) => (
              <div key={idx} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                      <User className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-base font-bold text-slate-800">{w.workerName}</h4>
                      <p className="text-xs text-slate-500">
                        Outstanding Labour: <span className="font-bold text-emerald-600">{formatLKR(w.amount)}</span>
                      </p>
                    </div>
                  </div>

                  {(isAdmin || isManager) && (
                    <button
                      onClick={() => handlePayLabour(w.workerId, w.items.map((i) => i.JobLabourID), w.amount, w.workerName)}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-sm transition flex items-center gap-1.5"
                    >
                      <DollarSign className="w-4 h-4" /> Pay {w.workerName} {formatLKR(w.amount)}
                    </button>
                  )}
                </div>

                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                      <tr>
                        <th className="py-2.5 px-3">Job No</th>
                        <th className="py-2.5 px-3">Work Type</th>
                        <th className="py-2.5 px-3 text-right">Units</th>
                        <th className="py-2.5 px-3 text-right">Rate</th>
                        <th className="py-2.5 px-3 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {w.items.map((i) => (
                        <tr key={i.JobLabourID} className="hover:bg-slate-50/50">
                          <td className="py-2.5 px-3 font-semibold text-slate-800">{i.JobNo}</td>
                          <td className="py-2.5 px-3 text-slate-600">{i.WorkType}</td>
                          <td className="py-2.5 px-3 text-right">{i.Units} {i.UnitLabel}</td>
                          <td className="py-2.5 px-3 text-right">{formatLKR(i.Rate)}</td>
                          <td className="py-2.5 px-3 text-right font-bold text-slate-900">{formatLKR(i.Amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* JOB CARD EDIT / CREATE MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                  <Wrench className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800">
                    {selectedJob ? `Job Card ${selectedJob.JobNo}` : 'New Workshop Job Card'}
                  </h3>
                  {selectedJob?.InvoiceNo && (
                    <p className="text-xs text-indigo-600 font-medium">
                      Invoiced as {selectedJob.InvoiceNo}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Body */}
            <form onSubmit={handleSubmitJob} className="flex-1 overflow-y-auto p-6 space-y-6 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Customer</label>
                  <select
                    value={customerId}
                    onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  >
                    <option value="">— Select Customer —</option>
                    {customers.map((c) => (
                      <option key={c.CustomerID} value={c.CustomerID}>
                        {c.Name} {c.Kind === 'internal' ? '(Internal)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Vehicle / Machine</label>
                  <select
                    value={machineId}
                    onChange={(e) => setMachineId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  >
                    <option value="">— Select Machine / Vehicle —</option>
                    {machines.map((m) => (
                      <option key={m.MachineID} value={m.MachineID}>
                        {m.Name} {m.Code ? `(${m.Code})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Priority</label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as any)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  >
                    <option value="normal">Normal Priority</option>
                    <option value="urgent">Urgent / Rush Turnaround</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Received Date</label>
                  <input
                    type="date"
                    value={receivedAt}
                    onChange={(e) => setReceivedAt(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Promised Date</label>
                  <input
                    type="date"
                    value={promisedAt}
                    onChange={(e) => setPromisedAt(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                {jobId && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Job Status</label>
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value as any)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    >
                      <option value="open">Open</option>
                      <option value="in-progress">In Progress</option>
                      <option value="waiting-parts">Waiting Parts</option>
                      <option value="completed">Completed / Ready</option>
                      <option value="invoiced" disabled>Invoiced</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Description / Problem</label>
                  <textarea
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g. Boom cylinder return line burst, oil leak"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Hose Specification Code</label>
                  <textarea
                    rows={2}
                    value={hoseSpec}
                    onChange={(e) => setHoseSpec(e.target.value)}
                    placeholder="e.g. 2-wire 1/2' 3000 PSI 1.8m Female BSP straight to 90 deg"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Items & Materials */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Materials & Hoses</h4>
                  <button
                    type="button"
                    onClick={handleAddJobLine}
                    className="px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-semibold transition flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Part / Line
                  </button>
                </div>

                <div className="border border-slate-200 rounded-2xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                      <tr>
                        <th className="py-2 px-3 w-56">Catalog Item</th>
                        <th className="py-2 px-3">Description</th>
                        <th className="py-2 px-3 w-20">Unit</th>
                        <th className="py-2 px-3 w-20 text-right">Qty</th>
                        <th className="py-2 px-3 w-28 text-right">Rate</th>
                        <th className="py-2 px-2 w-10 text-center"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {jobItems.map((line, idx) => (
                        <tr key={idx} className="hover:bg-slate-50/50">
                          <td className="py-2 px-3">
                            <select
                              value={line.inventoryId || ''}
                              onChange={(e) => handleUpdateJobLine(idx, 'inventoryId', e.target.value)}
                              className="w-full px-2 py-1 bg-transparent border border-slate-200 rounded-lg text-xs"
                            >
                              <option value="">— Custom Line —</option>
                              {inventoryItems.map((inv) => (
                                <option key={inv.InventoryID} value={inv.InventoryID}>
                                  {inv.ProductName} ({inv.SpecificationCode || '—'})
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="text"
                              value={line.description}
                              onChange={(e) => handleUpdateJobLine(idx, 'description', e.target.value)}
                              placeholder="Line description"
                              className="w-full px-2 py-1 bg-transparent border border-slate-200 rounded-lg text-xs"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="text"
                              value={line.unit}
                              onChange={(e) => handleUpdateJobLine(idx, 'unit', e.target.value)}
                              className="w-full px-2 py-1 bg-transparent border border-slate-200 rounded-lg text-xs"
                            />
                          </td>
                          <td className="py-2 px-3 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={line.qty}
                              onChange={(e) => handleUpdateJobLine(idx, 'qty', parseFloat(e.target.value) || 0)}
                              className="w-full px-2 py-1 text-right bg-transparent border border-slate-200 rounded-lg text-xs font-semibold"
                            />
                          </td>
                          <td className="py-2 px-3 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={line.rate}
                              onChange={(e) => handleUpdateJobLine(idx, 'rate', parseFloat(e.target.value) || 0)}
                              className="w-full px-2 py-1 text-right bg-transparent border border-slate-200 rounded-lg text-xs font-semibold"
                            />
                          </td>
                          <td className="py-2 px-2 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveJobLine(idx)}
                              className="p-1 text-rose-500 hover:bg-rose-50 rounded"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Technician Labour Panel for Existing Job */}
              {selectedJob && (
                <div className="bg-slate-50/70 border border-slate-200 rounded-2xl p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                      <User className="w-4 h-4 text-indigo-500" /> Technician Labour Recorded
                    </h4>
                  </div>

                  {selectedJob.labour && selectedJob.labour.length > 0 ? (
                    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                          <tr>
                            <th className="py-2 px-3">Technician</th>
                            <th className="py-2 px-3">Work Type</th>
                            <th className="py-2 px-3 text-right">Units</th>
                            <th className="py-2 px-3 text-right">Amount</th>
                            <th className="py-2 px-3 text-center">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {selectedJob.labour.map((l) => (
                            <tr key={l.JobLabourID}>
                              <td className="py-2 px-3 font-semibold text-slate-800">{l.WorkerName || 'Unassigned'}</td>
                              <td className="py-2 px-3 text-slate-600">{l.WorkType}</td>
                              <td className="py-2 px-3 text-right">{l.Units} {l.UnitLabel}</td>
                              <td className="py-2 px-3 text-right font-bold text-slate-800">{formatLKR(l.Amount)}</td>
                              <td className="py-2 px-3 text-center">
                                {l.LabourPaymentID ? (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Paid</span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">Accrued</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">No technician work recorded on this job yet.</p>
                  )}

                  {/* Add Labour Form */}
                  <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-3">
                    <select
                      value={labourWorkerId}
                      onChange={(e) => setLabourWorkerId(e.target.value ? Number(e.target.value) : '')}
                      className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs"
                    >
                      <option value="">— Select Technician —</option>
                      {workers.map((w) => (
                        <option key={w.WorkerID} value={w.WorkerID}>{w.Name}</option>
                      ))}
                    </select>

                    <select
                      value={labourWorkType}
                      onChange={(e) => setLabourWorkType(e.target.value)}
                      className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs"
                    >
                      <option value="Crimping">Crimping</option>
                      <option value="Welding">Welding</option>
                      <option value="Fitting">Fitting / Assembly</option>
                      <option value="Lathe">Lathe Machining</option>
                    </select>

                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-slate-500">Units:</span>
                      <input
                        type="number"
                        min="1"
                        value={labourUnits}
                        onChange={(e) => setLabourUnits(parseInt(e.target.value, 10) || 1)}
                        className="w-16 px-2 py-1 border border-slate-200 rounded-lg text-xs text-right"
                      />
                    </div>

                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-slate-500">Rate:</span>
                      <input
                        type="number"
                        min="0"
                        value={labourRate}
                        onChange={(e) => setLabourRate(parseFloat(e.target.value) || 0)}
                        className="w-20 px-2 py-1 border border-slate-200 rounded-lg text-xs text-right"
                      />
                    </div>

                    <button
                      type="button"
                      disabled={isAddingLabour}
                      onClick={handleAddLabour}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold transition"
                    >
                      + Accrue Labour
                    </button>
                  </div>
                </div>
              )}

              {/* Modal Footer Actions */}
              <div className="border-t border-slate-200 pt-4 flex items-center justify-between">
                <div>
                  {selectedJob && !selectedJob.InvoiceID && canWrite && (
                    <button
                      type="button"
                      onClick={handleInvoiceJob}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-sm transition flex items-center gap-1.5"
                    >
                      <FileText className="w-3.5 h-3.5" /> Convert to Finalized Invoice
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 border border-slate-200 hover:bg-slate-100 rounded-xl text-xs font-semibold text-slate-600 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={modalSubmitting}
                    className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-sm transition"
                  >
                    {jobId ? 'Save Changes' : 'Open Job Card'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
