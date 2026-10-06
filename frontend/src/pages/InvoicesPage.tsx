import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Invoice, InvoiceLineItem, Customer, InventoryItem } from '../types/models';
import { formatLKR, formatDate, round2 } from '../utils/format';
import {
  FileText,
  Plus,
  Search,
  Download,
  Printer,
  RefreshCw,
  Eye,
  Trash2,
  AlertCircle,
  CheckCircle2,
  Clock,
  Ban,
  Wrench,
  Percent,
  X,
  Loader2,
  DollarSign
} from 'lucide-react';

export const InvoicesPage: React.FC = () => {
  const { isManager, isAdmin, canWrite } = useAuth();

  // List state
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [error, setError] = useState<string | null>(null);

  // View modal state
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [compareData, setCompareData] = useState<any | null>(null);

  // Create / Edit modal state
  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false);
  const [createSubmitting, setCreateSubmitting] = useState<boolean>(false);
  const [nextInvoiceNo, setNextInvoiceNo] = useState<string>('AUTO');

  // Form fields
  const [invoiceDate, setInvoiceDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [billedToName, setBilledToName] = useState<string>('');
  const [billedToAddress, setBilledToAddress] = useState<string>('');
  const [deliveredToName, setDeliveredToName] = useState<string>('');
  const [deliveredToAddress, setDeliveredToAddress] = useState<string>('');
  const [poNo, setPoNo] = useState<string>('');
  const [poDate, setPoDate] = useState<string>('');
  const [deliveryDate, setDeliveryDate] = useState<string>('');
  const [discount, setDiscount] = useState<number>(0);
  const [roundToRupee, setRoundToRupee] = useState<boolean>(false);
  const [editingDraftId, setEditingDraftId] = useState<number | null>(null);

  // Line items
  const [items, setItems] = useState<InvoiceLineItem[]>([]);

  // Customer dropdown
  const [customers, setCustomers] = useState<Customer[]>([]);

  // Product search dropdown in line items
  const [itemSearchQuery, setItemSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<InventoryItem[]>([]);
  const [isSearchingItems, setIsSearchingItems] = useState<boolean>(false);

  // Cancel prompt
  const [cancelPromptId, setCancelPromptId] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState<string>('');

  // Load Invoices
  const loadInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<Invoice[]>('/invoices');
      setInvoices(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message || 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load Customers for selection
  const loadCustomers = useCallback(async () => {
    try {
      const data = await apiRequest<Customer[]>('/customers?active=1');
      setCustomers(Array.isArray(data) ? data : []);
    } catch (_) {}
  }, []);

  useEffect(() => {
    loadInvoices();
    loadCustomers();
  }, [loadInvoices, loadCustomers]);

  // Fetch next invoice number when date changes in create mode
  const fetchNextNo = useCallback(async (date: string) => {
    try {
      const res = await apiRequest<{ nextInvoiceNo: string }>(`/invoices/next-no?date=${encodeURIComponent(date)}`);
      setNextInvoiceNo(res.nextInvoiceNo || 'AUTO');
    } catch {
      setNextInvoiceNo('AUTO');
    }
  }, []);

  useEffect(() => {
    if (isCreateOpen && !editingDraftId) {
      fetchNextNo(invoiceDate);
    }
  }, [isCreateOpen, invoiceDate, editingDraftId, fetchNextNo]);

  // Inventory search debounced
  useEffect(() => {
    if (!itemSearchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setIsSearchingItems(true);
      try {
        const results = await apiRequest<InventoryItem[]>(`/inventory/search?q=${encodeURIComponent(itemSearchQuery)}`);
        setSearchResults(Array.isArray(results) ? results : []);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearchingItems(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [itemSearchQuery]);

  // Open Create Modal
  const openNewInvoice = () => {
    setEditingDraftId(null);
    setInvoiceDate(new Date().toISOString().slice(0, 10));
    setBilledToName('');
    setBilledToAddress('');
    setDeliveredToName('');
    setDeliveredToAddress('');
    setPoNo('');
    setPoDate('');
    setDeliveryDate('');
    setDiscount(0);
    setRoundToRupee(false);
    setItems([]);
    setItemSearchQuery('');
    setSearchResults([]);
    setIsCreateOpen(true);
  };

  // Add Item from Inventory Picker
  const handleSelectProduct = (product: InventoryItem) => {
    const rate = product.SuggestedBill && product.SuggestedBill > 0 ? product.SuggestedBill : product.Price || 0;
    const newItem: InvoiceLineItem = {
      id: Date.now() + Math.random(),
      inventoryId: product.InventoryID,
      description: `${product.ProductName}${product.SpecificationCode ? ' - ' + product.SpecificationCode : ''}`,
      unit: product.Unit || 'pcs',
      length: product.Length || 0,
      qty: 1,
      rate: round2(rate),
      cost: product.Cost || 0,
      marketMid: product.MarketPrice || product.MarketMid || rate,
      pricingSource: product.PricingRuleApplied || 'inventory',
    };
    setItems((prev) => [...prev, newItem]);
    setItemSearchQuery('');
    setSearchResults([]);
  };

  // Add quick workshop lines
  const handleAddCrimping = () => {
    const newItem: InvoiceLineItem = {
      id: Date.now() + Math.random(),
      inventoryId: null,
      description: 'Crimping charge — standard hose assembly',
      unit: 'end',
      qty: 2,
      rate: 450,
      cost: 0,
      marketMid: 450,
      pricingSource: 'workshop-crimping',
    };
    setItems((prev) => [...prev, newItem]);
  };

  const handleAddWelding = () => {
    const newItem: InvoiceLineItem = {
      id: Date.now() + Math.random(),
      inventoryId: null,
      description: 'Welding Extra labour',
      unit: 'job',
      qty: 1,
      rate: 750,
      cost: 0,
      marketMid: 750,
      pricingSource: 'workshop-welding',
    };
    setItems((prev) => [...prev, newItem]);
  };

  const handleAddLathe = () => {
    const newItem: InvoiceLineItem = {
      id: Date.now() + Math.random(),
      inventoryId: null,
      description: 'Lathe machining & turning charge',
      unit: 'job',
      qty: 1,
      rate: 1200,
      cost: 0,
      marketMid: 1200,
      pricingSource: 'workshop-lathe',
    };
    setItems((prev) => [...prev, newItem]);
  };

  const handleAddCustomLine = () => {
    const newItem: InvoiceLineItem = {
      id: Date.now() + Math.random(),
      inventoryId: null,
      description: 'Workshop Service / Labour',
      unit: 'job',
      qty: 1,
      rate: 500,
      cost: 0,
      marketMid: 500,
      pricingSource: 'manual',
    };
    setItems((prev) => [...prev, newItem]);
  };

  const handleUpdateItem = (id: number | undefined, field: keyof InvoiceLineItem, val: any) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, [field]: val } : it))
    );
  };

  const handleRemoveItem = (id: number | undefined) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  };

  // Totals
  const subTotal = useMemo(() => {
    return round2(items.reduce((acc, it) => acc + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0));
  }, [items]);

  const grandTotal = useMemo(() => {
    let tot = subTotal - (Number(discount) || 0);
    if (tot < 0) tot = 0;
    if (roundToRupee) tot = Math.round(tot);
    return round2(tot);
  }, [subTotal, discount, roundToRupee]);

  // Save as Draft
  const handleSaveDraft = async () => {
    if (items.length === 0) {
      alert('Please add at least one line item.');
      return;
    }
    setCreateSubmitting(true);
    try {
      const payload = {
        invoiceId: editingDraftId,
        invoiceDate,
        billedToName: billedToName.trim() || 'Counter Customer',
        billedToAddress,
        deliveredToName,
        deliveredToAddress,
        poNo,
        poDate: poDate || null,
        deliveryDate: deliveryDate || null,
        discount: Number(discount) || 0,
        roundToRupee,
        items,
      };
      await apiRequest('/invoices/draft', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setIsCreateOpen(false);
      await loadInvoices();
    } catch (err: any) {
      alert(err.message || 'Error saving draft');
    } finally {
      setCreateSubmitting(false);
    }
  };

  // Finalize Invoice (deducts stock)
  const handleFinalize = async () => {
    if (items.length === 0) {
      alert('Please add at least one line item.');
      return;
    }
    if (!billedToName.trim()) {
      alert('Billed To Customer Name is required to finalize an invoice.');
      return;
    }
    if (!window.confirm(`Finalize this invoice for ${billedToName}?\nGrand Total: ${formatLKR(grandTotal)}\n\nWARNING: Stock will be deducted immediately.`)) {
      return;
    }
    setCreateSubmitting(true);
    try {
      const payload = {
        invoiceId: editingDraftId,
        invoiceDate,
        billedToName: billedToName.trim(),
        billedToAddress,
        deliveredToName,
        deliveredToAddress,
        poNo,
        poDate: poDate || null,
        deliveryDate: deliveryDate || null,
        discount: Number(discount) || 0,
        roundToRupee,
        items,
      };
      await apiRequest('/invoices/finalize', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setIsCreateOpen(false);
      await loadInvoices();
    } catch (err: any) {
      alert(err.message || 'Error finalizing invoice');
    } finally {
      setCreateSubmitting(false);
    }
  };

  // View Invoice Details
  const handleViewInvoice = async (invoiceId: number) => {
    setCompareData(null);
    try {
      const inv = await apiRequest<Invoice>(`/invoices/${invoiceId}`);
      setSelectedInvoice(inv);
      if (isManager || isAdmin) {
        try {
          const comp = await apiRequest(`/invoices/${invoiceId}/compare`);
          setCompareData(comp);
        } catch (_) {}
      }
    } catch (err: any) {
      alert(err.message || 'Could not fetch invoice details');
    }
  };

  // Cancel invoice
  const handleCancelInvoice = async () => {
    if (!cancelPromptId) return;
    if (!cancelReason.trim()) {
      alert('Please state a reason for cancelling this invoice.');
      return;
    }
    try {
      await apiRequest(`/invoices/${cancelPromptId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: cancelReason.trim() }),
      });
      setCancelPromptId(null);
      setCancelReason('');
      setSelectedInvoice(null);
      await loadInvoices();
    } catch (err: any) {
      alert(err.message || 'Failed to cancel invoice');
    }
  };

  // Filtered invoices
  const filteredInvoices = useMemo(() => {
    return invoices.filter((inv) => {
      const matchesSearch =
        !search.trim() ||
        inv.InvoiceNo.toLowerCase().includes(search.toLowerCase()) ||
        inv.BilledToName.toLowerCase().includes(search.toLowerCase());

      const matchesStatus =
        statusFilter === 'All' ||
        (statusFilter === 'Paid' && inv.PaymentStatus === 'Paid') ||
        (statusFilter === 'Unpaid' && (inv.PaymentStatus === 'Unpaid' || inv.PaymentStatus === 'Partial')) ||
        inv.Status.toLowerCase() === statusFilter.toLowerCase();

      return matchesSearch && matchesStatus;
    });
  }, [invoices, search, statusFilter]);

  // Statistics
  const stats = useMemo(() => {
    let totalVal = 0;
    let unpaidBal = 0;
    let drafts = 0;
    invoices.forEach((i) => {
      if (i.Status === 'Draft') drafts++;
      if (i.Status === 'Finalized') {
        totalVal += i.GrandTotal || 0;
        unpaidBal += i.Balance || 0;
      }
    });
    return {
      count: invoices.length,
      totalVal: round2(totalVal),
      unpaidBal: round2(unpaidBal),
      drafts,
    };
  }, [invoices]);

  const getStatusBadge = (inv: Invoice) => {
    if (inv.Status === 'Draft') {
      return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200"><Clock className="w-3 h-3" /> Draft</span>;
    }
    if (inv.Status === 'Cancelled') {
      return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200"><Ban className="w-3 h-3" /> Cancelled</span>;
    }
    if (inv.Status === 'Revised') {
      return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-200"><RefreshCw className="w-3 h-3" /> Revised</span>;
    }
    if (inv.PaymentStatus === 'Paid') {
      return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"><CheckCircle2 className="w-3 h-3" /> Paid</span>;
    }
    if (inv.PaymentStatus === 'Partial') {
      return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-orange-50 text-orange-700 border border-orange-200"><Percent className="w-3 h-3" /> Partial</span>;
    }
    return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200"><FileText className="w-3 h-3" /> Finalized</span>;
  };

  return (
    <div className="space-y-6">
      {/* Top Banner Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Invoices</p>
          <p className="text-2xl font-bold text-slate-800 mt-2">{stats.count}</p>
          <p className="text-xs text-slate-400 mt-1">Recorded in system</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Finalized Sales</p>
          <p className="text-2xl font-bold text-emerald-600 mt-2">{formatLKR(stats.totalVal)}</p>
          <p className="text-xs text-slate-400 mt-1">Completed billings</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Unpaid Receivables</p>
          <p className="text-2xl font-bold text-amber-600 mt-2">{formatLKR(stats.unpaidBal)}</p>
          <p className="text-xs text-slate-400 mt-1">Outstanding customer balance</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Open Drafts</p>
          <p className="text-2xl font-bold text-indigo-600 mt-2">{stats.drafts}</p>
          <p className="text-xs text-slate-400 mt-1">Ready to review & finalize</p>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl text-xs flex items-center gap-2 font-medium">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Action Bar */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-sm flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="flex flex-1 w-full md:w-auto items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by Invoice # or Customer name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition"
            />
          </div>

          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs font-semibold">
            {['All', 'Draft', 'Finalized', 'Paid', 'Unpaid', 'Cancelled'].map((tab) => (
              <button
                key={tab}
                onClick={() => setStatusFilter(tab)}
                className={`px-3 py-1.5 rounded-lg transition ${
                  statusFilter === tab
                    ? 'bg-white text-indigo-600 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2.5 w-full md:w-auto justify-end">
          <button
            onClick={loadInvoices}
            title="Refresh Invoices"
            className="p-2 border border-slate-200 hover:bg-slate-50 rounded-xl text-slate-600 transition"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {canWrite && (
            <button
              onClick={openNewInvoice}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold shadow-sm transition"
            >
              <Plus className="w-4 h-4" /> New Invoice
            </button>
          )}
        </div>
      </div>

      {/* Invoices Table */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
              <tr>
                <th className="py-3.5 px-4">Invoice No</th>
                <th className="py-3.5 px-4">Date</th>
                <th className="py-3.5 px-4">Billed Customer</th>
                <th className="py-3.5 px-4 text-right">Grand Total</th>
                <th className="py-3.5 px-4 text-right">Balance</th>
                <th className="py-3.5 px-4 text-center">Status</th>
                <th className="py-3.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                    Loading invoices...
                  </td>
                </tr>
              ) : filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <FileText className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                    No invoices match your search criteria.
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((inv) => (
                  <tr key={inv.InvoiceID} className="hover:bg-slate-50/60 transition">
                    <td className="py-3.5 px-4 font-bold text-slate-800">
                      {inv.InvoiceNo}
                      {inv.IsInternal === 1 && (
                        <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200">
                          INTERNAL
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-slate-500 whitespace-nowrap">
                      {formatDate(inv.InvoiceDate)}
                    </td>
                    <td className="py-3.5 px-4 font-medium text-slate-800">
                      {inv.BilledToName}
                    </td>
                    <td className="py-3.5 px-4 text-right font-semibold text-slate-900 whitespace-nowrap">
                      {formatLKR(inv.GrandTotal)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-medium whitespace-nowrap">
                      {inv.Status === 'Finalized' && inv.Balance > 0 ? (
                        <span className="text-amber-600">{formatLKR(inv.Balance)}</span>
                      ) : inv.Status === 'Draft' ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <span className="text-emerald-600">Settled</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-center whitespace-nowrap">
                      {getStatusBadge(inv)}
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleViewInvoice(inv.InvoiceID)}
                          title="View Details"
                          className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-600 transition"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <a
                          href={`/api/invoices/${inv.InvoiceID}/pdf`}
                          target="_blank"
                          rel="noreferrer"
                          title="Download PDF"
                          className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-600 transition"
                        >
                          <Download className="w-4 h-4" />
                        </a>
                        <a
                          href={`/api/invoices/${inv.InvoiceID}/html`}
                          target="_blank"
                          rel="noreferrer"
                          title="Print Invoice"
                          className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-600 transition"
                        >
                          <Printer className="w-4 h-4" />
                        </a>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CREATE / EDIT INVOICE MODAL */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800">
                    {editingDraftId ? 'Edit Draft Invoice' : 'Create New Invoice'}
                  </h3>
                  <p className="text-xs text-slate-500">
                    Invoice No: <span className="font-mono font-semibold text-indigo-600">{nextInvoiceNo}</span>
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsCreateOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Scrollable Body */}
            <div className="p-6 overflow-y-auto space-y-6 flex-1 text-sm">
              {/* Header Info Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Invoice Date</label>
                  <input
                    type="date"
                    value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Billed To (Customer Name) *</label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="e.g. D.K. Silva or pick below"
                      value={billedToName}
                      onChange={(e) => setBilledToName(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      list="customers-list"
                    />
                    <datalist id="customers-list">
                      {customers.map((c) => (
                        <option key={c.CustomerID} value={c.Name} />
                      ))}
                    </datalist>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Customer Address</label>
                  <input
                    type="text"
                    placeholder="Billing street address"
                    value={billedToAddress}
                    onChange={(e) => setBilledToAddress(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">PO Number (Optional)</label>
                  <input
                    type="text"
                    placeholder="PO-..."
                    value={poNo}
                    onChange={(e) => setPoNo(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">PO Date</label>
                  <input
                    type="date"
                    value={poDate}
                    onChange={(e) => setPoDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Delivery Date</label>
                  <input
                    type="date"
                    value={deliveryDate}
                    onChange={(e) => setDeliveryDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Product Search & Quick Add */}
              <div className="bg-slate-50/70 border border-slate-200 rounded-2xl p-4 space-y-3">
                <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
                  <div className="relative flex-1 w-full">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search stock catalog to add hose, fitting, ferrule..."
                      value={itemSearchQuery}
                      onChange={(e) => setItemSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                    {isSearchingItems && (
                      <Loader2 className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-indigo-500 animate-spin" />
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
                    <button
                      type="button"
                      onClick={handleAddCrimping}
                      className="px-2.5 py-1.5 bg-white border border-slate-200 hover:border-indigo-300 rounded-lg text-xs font-semibold text-slate-700 hover:text-indigo-600 flex items-center gap-1 transition"
                    >
                      <Wrench className="w-3.5 h-3.5 text-indigo-500" /> + Crimping
                    </button>
                    <button
                      type="button"
                      onClick={handleAddWelding}
                      className="px-2.5 py-1.5 bg-white border border-slate-200 hover:border-indigo-300 rounded-lg text-xs font-semibold text-slate-700 hover:text-indigo-600 flex items-center gap-1 transition"
                    >
                      + Welding Extra
                    </button>
                    <button
                      type="button"
                      onClick={handleAddLathe}
                      className="px-2.5 py-1.5 bg-white border border-slate-200 hover:border-indigo-300 rounded-lg text-xs font-semibold text-slate-700 hover:text-indigo-600 flex items-center gap-1 transition"
                    >
                      + Lathe Charge
                    </button>
                    <button
                      type="button"
                      onClick={handleAddCustomLine}
                      className="px-2.5 py-1.5 bg-white border border-slate-200 hover:border-indigo-300 rounded-lg text-xs font-semibold text-slate-700 hover:text-indigo-600 flex items-center gap-1 transition"
                    >
                      + Custom Line
                    </button>
                  </div>
                </div>

                {/* Search Dropdown Results */}
                {searchResults.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-xl shadow-lg max-h-56 overflow-y-auto divide-y divide-slate-100">
                    {searchResults.map((prod) => (
                      <div
                        key={prod.InventoryID}
                        onClick={() => handleSelectProduct(prod)}
                        className="p-3 hover:bg-indigo-50/50 cursor-pointer flex items-center justify-between text-xs transition"
                      >
                        <div>
                          <p className="font-bold text-slate-800">{prod.ProductName}</p>
                          <p className="text-slate-500">
                            Spec: <span className="font-mono">{prod.SpecificationCode || '—'}</span> | Size: {prod.Size || '—'} | In Stock: <span className={prod.Qty <= 5 ? 'text-red-600 font-bold' : 'text-emerald-600 font-bold'}>{prod.Qty} {prod.Unit}</span>
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-indigo-600 text-sm">
                            {formatLKR(prod.SuggestedBill && prod.SuggestedBill > 0 ? prod.SuggestedBill : prod.Price)}
                          </p>
                          <span className="text-[10px] text-slate-400">Click to add</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Line Items Table */}
              <div className="border border-slate-200 rounded-2xl overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                    <tr>
                      <th className="py-2.5 px-3">Description</th>
                      <th className="py-2.5 px-3 w-20">Unit</th>
                      <th className="py-2.5 px-3 w-24 text-right">Qty</th>
                      <th className="py-2.5 px-3 w-32 text-right">Unit Rate (LKR)</th>
                      <th className="py-2.5 px-3 w-32 text-right">Amount (LKR)</th>
                      <th className="py-2.5 px-2 w-10 text-center"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-400">
                          No items added yet. Search products or click quick service buttons above.
                        </td>
                      </tr>
                    ) : (
                      items.map((it) => {
                        const lineAmt = round2((Number(it.qty) || 0) * (Number(it.rate) || 0));
                        return (
                          <tr key={it.id} className="hover:bg-slate-50/50">
                            <td className="py-2 px-3">
                              <input
                                type="text"
                                value={it.description}
                                onChange={(e) => handleUpdateItem(it.id, 'description', e.target.value)}
                                className="w-full px-2 py-1 bg-transparent border border-slate-200 rounded-lg text-xs"
                              />
                            </td>
                            <td className="py-2 px-3">
                              <input
                                type="text"
                                value={it.unit}
                                onChange={(e) => handleUpdateItem(it.id, 'unit', e.target.value)}
                                className="w-full px-2 py-1 bg-transparent border border-slate-200 rounded-lg text-xs"
                              />
                            </td>
                            <td className="py-2 px-3 text-right">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={it.qty}
                                onChange={(e) => handleUpdateItem(it.id, 'qty', parseFloat(e.target.value) || 0)}
                                className="w-full px-2 py-1 text-right bg-transparent border border-slate-200 rounded-lg text-xs font-semibold"
                              />
                            </td>
                            <td className="py-2 px-3 text-right">
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={it.rate}
                                onChange={(e) => handleUpdateItem(it.id, 'rate', parseFloat(e.target.value) || 0)}
                                className="w-full px-2 py-1 text-right bg-transparent border border-slate-200 rounded-lg text-xs font-semibold"
                              />
                            </td>
                            <td className="py-2 px-3 text-right font-bold text-slate-800">
                              {formatLKR(lineAmt)}
                            </td>
                            <td className="py-2 px-2 text-center">
                              <button
                                type="button"
                                onClick={() => handleRemoveItem(it.id)}
                                className="p-1 text-rose-500 hover:bg-rose-50 rounded"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Totals Summary */}
              <div className="bg-slate-50/80 rounded-2xl p-4 border border-slate-200 flex flex-col sm:flex-row justify-between items-end gap-4">
                <div className="space-y-2 w-full sm:w-auto">
                  <div className="flex items-center gap-3">
                    <label className="text-xs font-semibold text-slate-600">Special Discount (LKR):</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={discount}
                      onChange={(e) => setDiscount(parseFloat(e.target.value) || 0)}
                      className="w-32 px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs text-right font-semibold"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={roundToRupee}
                      onChange={(e) => setRoundToRupee(e.target.checked)}
                      className="rounded text-indigo-600"
                    />
                    Round total to nearest Rupee
                  </label>
                </div>

                <div className="text-right space-y-1 w-full sm:w-auto">
                  <p className="text-xs text-slate-500">
                    SubTotal: <span className="font-semibold text-slate-700">{formatLKR(subTotal)}</span>
                  </p>
                  {discount > 0 && (
                    <p className="text-xs text-rose-600">
                      Discount: -{formatLKR(discount)}
                    </p>
                  )}
                  <p className="text-lg font-bold text-slate-900 border-t border-slate-200 pt-1 mt-1">
                    Grand Total: <span className="text-indigo-600">{formatLKR(grandTotal)}</span>
                  </p>
                </div>
              </div>
            </div>

            {/* Modal Footer Actions */}
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setIsCreateOpen(false)}
                className="px-4 py-2 border border-slate-200 hover:bg-slate-100 rounded-xl text-xs font-semibold text-slate-600 transition"
              >
                Cancel
              </button>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={createSubmitting}
                  onClick={handleSaveDraft}
                  className="px-4 py-2 border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-xl text-xs font-semibold transition flex items-center gap-1.5"
                >
                  <Clock className="w-3.5 h-3.5" /> Save as Draft
                </button>

                <button
                  type="button"
                  disabled={createSubmitting}
                  onClick={handleFinalize}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-sm transition flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" /> Finalize Invoice
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* VIEW INVOICE MODAL */}
      {selectedInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                  <FileText className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800">
                    Invoice {selectedInvoice.InvoiceNo}
                  </h3>
                  <p className="text-xs text-slate-500">
                    Billed on {formatDate(selectedInvoice.InvoiceDate)} to {selectedInvoice.BilledToName}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedInvoice(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable details */}
            <div className="p-6 overflow-y-auto space-y-6 flex-1 text-sm">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-slate-50 p-4 rounded-2xl border border-slate-200">
                <div>
                  <p className="text-xs text-slate-400">Grand Total</p>
                  <p className="text-base font-bold text-slate-800 mt-0.5">{formatLKR(selectedInvoice.GrandTotal)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Amount Paid</p>
                  <p className="text-base font-bold text-emerald-600 mt-0.5">{formatLKR(selectedInvoice.AmountPaid || 0)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Balance</p>
                  <p className="text-base font-bold text-amber-600 mt-0.5">{formatLKR(selectedInvoice.Balance || 0)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Status</p>
                  <div className="mt-1">{getStatusBadge(selectedInvoice)}</div>
                </div>
              </div>

              {/* Items breakdown */}
              <div>
                <h4 className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-2">Itemized Breakdown</h4>
                <div className="border border-slate-200 rounded-2xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                      <tr>
                        <th className="py-2.5 px-3">Description</th>
                        <th className="py-2.5 px-3 w-16">Unit</th>
                        <th className="py-2.5 px-3 w-20 text-right">Qty</th>
                        <th className="py-2.5 px-3 w-24 text-right">Rate</th>
                        <th className="py-2.5 px-3 w-28 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedInvoice.items && selectedInvoice.items.length > 0 ? (
                        selectedInvoice.items.map((it) => (
                          <tr key={it.InvoiceItemID}>
                            <td className="py-2.5 px-3 font-medium text-slate-800">{it.ItemDescription}</td>
                            <td className="py-2.5 px-3 text-slate-500">{it.Unit}</td>
                            <td className="py-2.5 px-3 text-right">{it.Qty}</td>
                            <td className="py-2.5 px-3 text-right">{formatLKR(it.Rate)}</td>
                            <td className="py-2.5 px-3 text-right font-bold text-slate-900">{formatLKR(it.Amount)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="py-4 text-center text-slate-400">No items available.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Manager & Admin Profit / Price Analysis view */}
              {(isManager || isAdmin) && compareData && compareData.profit && (
                <div className="bg-emerald-50/60 border border-emerald-200 rounded-2xl p-4 space-y-2">
                  <h4 className="text-xs font-bold text-emerald-800 uppercase tracking-wider flex items-center gap-1.5">
                    <DollarSign className="w-4 h-4 text-emerald-600" /> Job Profit & Pricing Intelligence
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs pt-1">
                    <div>
                      <p className="text-slate-500">Material Cost</p>
                      <p className="font-bold text-slate-800">{formatLKR(compareData.profit.ourCost)}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">Net Revenue</p>
                      <p className="font-bold text-slate-800">{formatLKR(compareData.profit.revenue)}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">Gross Profit</p>
                      <p className="font-bold text-emerald-600">{formatLKR(compareData.profit.grossProfit)}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">Gross Margin</p>
                      <p className="font-bold text-emerald-600">{compareData.profit.grossMarginPct}%</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* View Modal Footer */}
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between">
              <div>
                {selectedInvoice.Status === 'Draft' && (
                  <button
                    onClick={() => {
                      setCancelPromptId(selectedInvoice.InvoiceID);
                      setCancelReason('');
                    }}
                    className="px-3 py-1.5 border border-rose-200 text-rose-600 hover:bg-rose-50 rounded-xl text-xs font-semibold transition"
                  >
                    Cancel Draft
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2.5">
                <a
                  href={`/api/invoices/${selectedInvoice.InvoiceID}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3.5 py-1.5 border border-slate-200 hover:bg-slate-100 rounded-xl text-xs font-semibold text-slate-700 flex items-center gap-1.5 transition"
                >
                  <Download className="w-3.5 h-3.5" /> PDF
                </a>
                <a
                  href={`/api/invoices/${selectedInvoice.InvoiceID}/html`}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3.5 py-1.5 border border-slate-200 hover:bg-slate-100 rounded-xl text-xs font-semibold text-slate-700 flex items-center gap-1.5 transition"
                >
                  <Printer className="w-3.5 h-3.5" /> Print
                </a>
                <button
                  onClick={() => setSelectedInvoice(null)}
                  className="px-4 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-semibold transition"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CANCEL PROMPT MODAL */}
      {cancelPromptId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 max-w-md w-full space-y-4">
            <h4 className="text-base font-bold text-slate-800">Confirm Invoice Cancellation</h4>
            <p className="text-xs text-slate-500">
              Please specify the audit reason for cancelling this invoice:
            </p>
            <input
              type="text"
              placeholder="e.g. Customer cancelled order / duplicate entry"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setCancelPromptId(null)}
                className="px-3 py-1.5 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Back
              </button>
              <button
                onClick={handleCancelInvoice}
                className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-semibold shadow-sm"
              >
                Confirm Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
