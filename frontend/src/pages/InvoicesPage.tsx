import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Invoice, InvoiceLineItem, Customer, Machine, InventoryItem } from '../types/models';
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
  DollarSign,
  Flame,
  Cog,
  Settings2,
  AlertTriangle,
  Truck,
  Building2,
  Edit2,
} from 'lucide-react';

interface CrimpingRateRow {
  size: string;
  internalCostPerEnd: number;
  market2Wire: number | null;
  market4Wire: number | null;
}

interface WeldingRateRow {
  size: string;
  assembly2Wire: number | null;
  weldingExtra2Wire: number | null;
  assembly4Wire: number | null;
  weldingExtra4Wire: number | null;
}

interface WeldingRatesData {
  mode: string;
  rows: WeldingRateRow[];
}

const LATHE_PRESETS = [
  { label: 'Lathe Charge', desc: 'Lathe Charge', rate: 250, unit: 'Nos' },
  { label: 'Bushing Machining', desc: 'Bushing Machining & Turning', rate: 850, unit: 'pcs' },
  { label: 'Thread Repair', desc: 'Hydraulic Thread Repair / Re-threading', rate: 650, unit: 'job' },
  { label: 'Pin Fabrication', desc: 'Hardened Pin Machining & Turning', rate: 1200, unit: 'pcs' },
  { label: 'Cylinder Rod Polish', desc: 'Hydraulic Cylinder Rod Polishing', rate: 1500, unit: 'job' },
  { label: 'Flange Facing', desc: 'Flange Surface Facing & Turning', rate: 950, unit: 'job' },
];

const TECH_PRESETS = [
  { label: 'Standard Technical Fee', desc: 'Technical charges', rate: 1500, unit: 'Nos' },
  { label: 'Site Diagnostics', desc: 'Site Hydraulic Diagnostics & Inspection', rate: 2500, unit: 'job' },
  { label: 'Hose System Installation', desc: 'Hose Line Installation & System Proof Testing', rate: 2000, unit: 'job' },
  { label: 'Emergency Breakdown', desc: 'Emergency Machine Breakdown Labour', rate: 3500, unit: 'job' },
];

const FALLBACK_SIZES = ['1/4', '5/16', '3/8', '1/2', '5/8', '3/4', '1', '1-1/4'];

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
  const [isInternal, setIsInternal] = useState<boolean>(false);

  // Line items
  const [items, setItems] = useState<InvoiceLineItem[]>([]);

  // Customer & Machine dropdowns
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);

  // Product search dropdown in line items
  const [itemSearchQuery, setItemSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<InventoryItem[]>([]);
  const [isSearchingItems, setIsSearchingItems] = useState<boolean>(false);

  // Cancel prompt
  const [cancelPromptId, setCancelPromptId] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState<string>('');

  // Workshop Services & Labour Modal state
  const [isWorkshopModalOpen, setIsWorkshopModalOpen] = useState<boolean>(false);
  const [workshopTab, setWorkshopTab] = useState<'crimping' | 'welding' | 'lathe' | 'tech'>('crimping');
  const [crimpingRates, setCrimpingRates] = useState<CrimpingRateRow[]>([]);
  const [weldingRates, setWeldingRates] = useState<WeldingRatesData | null>(null);
  const [isLoadingWorkshopRates, setIsLoadingWorkshopRates] = useState<boolean>(false);

  // Tab 1: Crimping state
  const [crimpSize, setCrimpSize] = useState<string>('1/2');
  const [crimpWire, setCrimpWire] = useState<'2-wire' | '4-wire'>('2-wire');
  const [crimpEnds, setCrimpEnds] = useState<number>(2);
  const [crimpBilledRate, setCrimpBilledRate] = useState<number | ''>('');
  const [crimpCustomBilled, setCrimpCustomBilled] = useState<boolean>(false);

  // Tab 2: Welding Extra state
  const [weldSize, setWeldSize] = useState<string>('1/2');
  const [weldWire, setWeldWire] = useState<'2-wire' | '4-wire'>('2-wire');
  const [weldEnds, setWeldEnds] = useState<number>(1);
  const [weldBilledRate, setWeldBilledRate] = useState<number | ''>('');
  const [weldCustomBilled, setWeldCustomBilled] = useState<boolean>(false);

  // Tab 3: Lathe Machining & Turning state
  const [latheDesc, setLatheDesc] = useState<string>('Lathe Charge');
  const [latheUnit, setLatheUnit] = useState<string>('Nos');
  const [latheQty, setLatheQty] = useState<number>(1);
  const [latheRate, setLatheRate] = useState<number>(250);

  // Tab 4: Technical Service state
  const [techDesc, setTechDesc] = useState<string>('Technical charges');
  const [techUnit, setTechUnit] = useState<string>('Nos');
  const [techQty, setTechQty] = useState<number>(1);
  const [techRate, setTechRate] = useState<number>(1500);

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

  // Load Machines for internal fleet selection
  const loadMachines = useCallback(async () => {
    try {
      const data = await apiRequest<Machine[]>('/machines');
      setMachines(Array.isArray(data) ? data : []);
    } catch (_) {}
  }, []);

  useEffect(() => {
    loadInvoices();
    loadCustomers();
    loadMachines();
  }, [loadInvoices, loadCustomers, loadMachines]);

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
    setIsInternal(false);
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

  // Edit an existing Draft invoice
  const handleEditDraft = (draft: Invoice) => {
    setEditingDraftId(draft.InvoiceID);
    setInvoiceDate(String(draft.InvoiceDate || '').slice(0, 10));
    setBilledToName(draft.BilledToName || '');
    setBilledToAddress(draft.BilledToAddress || '');
    setDeliveredToName(draft.DeliveredToName || '');
    setDeliveredToAddress(draft.DeliveredToAddress || '');
    setPoNo(draft.PONo || '');
    setPoDate(draft.PODate ? String(draft.PODate).slice(0, 10) : '');
    setDeliveryDate(draft.DeliveryDate ? String(draft.DeliveryDate).slice(0, 10) : '');
    setDiscount(draft.Discount || 0);
    setRoundToRupee(Boolean(draft.RoundOff));
    setIsInternal(Boolean(draft.IsInternal));
    setNextInvoiceNo(draft.InvoiceNo);
    const draftItems: InvoiceLineItem[] = (draft.items || []).map((it: any) => ({
      id: Date.now() + Math.random(),
      inventoryId: it.InventoryID || null,
      description: it.ItemDescription || '',
      unit: it.Unit || 'pcs',
      length: it.Length || 0,
      qty: it.Qty || 1,
      rate: it.Rate || 0,
      cost: it.UnitCostAtBilling || 0,
      marketMid: it.MarketRate || it.Rate || 0,
      pricingSource: 'manual',
    }));
    setItems(draftItems);
    setSelectedInvoice(null);
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

  // Load workshop rates from backend pricing engine
  const loadWorkshopRates = useCallback(async () => {
    setIsLoadingWorkshopRates(true);
    try {
      const [crimpRes, weldRes] = await Promise.all([
        apiRequest<CrimpingRateRow[]>('/pricing/crimping').catch(() => []),
        apiRequest<WeldingRatesData>('/pricing/welding-extra').catch(() => null),
      ]);
      if (Array.isArray(crimpRes) && crimpRes.length > 0) {
        setCrimpingRates(crimpRes);
      }
      if (weldRes && Array.isArray(weldRes.rows) && weldRes.rows.length > 0) {
        setWeldingRates(weldRes);
      }
    } catch (err) {
      console.error('Failed to load workshop rates', err);
    } finally {
      setIsLoadingWorkshopRates(false);
    }
  }, []);

  const handleOpenWorkshopModal = (tab: 'crimping' | 'welding' | 'lathe' | 'tech' = 'crimping') => {
    setWorkshopTab(tab);
    if (tab === 'lathe') {
      setLatheDesc('Lathe Charge');
      setLatheRate(250);
      setLatheUnit('Nos');
      setLatheQty(1);
    }
    setIsWorkshopModalOpen(true);
    if (crimpingRates.length === 0 || !weldingRates) {
      loadWorkshopRates();
    }
  };

  // Active crimping calculations
  const activeCrimpingRow = useMemo(() => {
    return crimpingRates.find((r) => r.size === crimpSize) || null;
  }, [crimpingRates, crimpSize]);

  const crimpMarketPerEnd = useMemo(() => {
    if (!activeCrimpingRow) return null;
    return crimpWire === '4-wire' ? activeCrimpingRow.market4Wire : activeCrimpingRow.market2Wire;
  }, [activeCrimpingRow, crimpWire]);

  useEffect(() => {
    if (!crimpCustomBilled) {
      if (crimpMarketPerEnd != null) {
        setCrimpBilledRate(crimpMarketPerEnd);
      } else {
        setCrimpBilledRate('');
      }
    }
  }, [crimpMarketPerEnd, crimpCustomBilled]);

  // Active welding calculations
  const activeWeldingRow = useMemo(() => {
    return weldingRates?.rows?.find((r) => r.size === weldSize) || null;
  }, [weldingRates, weldSize]);

  const weldRatesForActive = useMemo(() => {
    if (!activeWeldingRow) return { assembly: null, extra: null };
    if (weldWire === '4-wire') {
      return { assembly: activeWeldingRow.assembly4Wire, extra: activeWeldingRow.weldingExtra4Wire };
    }
    return { assembly: activeWeldingRow.assembly2Wire, extra: activeWeldingRow.weldingExtra2Wire };
  }, [activeWeldingRow, weldWire]);

  useEffect(() => {
    if (!weldCustomBilled) {
      if (weldRatesForActive.extra != null) {
        setWeldBilledRate(weldRatesForActive.extra);
      } else {
        setWeldBilledRate('');
      }
    }
  }, [weldRatesForActive, weldCustomBilled]);

  const availableCrimpSizes = useMemo(() => {
    return crimpingRates.length > 0 ? crimpingRates.map((r) => r.size) : FALLBACK_SIZES;
  }, [crimpingRates]);

  const availableWeldSizes = useMemo(() => {
    return weldingRates && weldingRates.rows.length > 0 ? weldingRates.rows.map((r) => r.size) : FALLBACK_SIZES;
  }, [weldingRates]);

  // Add services to line items
  const handleAddCrimpingService = () => {
    const ends = Math.max(1, parseInt(String(crimpEnds), 10) || 1);
    const internalCost = activeCrimpingRow ? Number(activeCrimpingRow.internalCostPerEnd) || 0 : 0;
    const billed = crimpBilledRate !== '' ? Number(crimpBilledRate) : (crimpMarketPerEnd ?? 0);

    if (!(billed > 0)) {
      alert('Please enter a valid billed rate per end.');
      return;
    }

    const newItem: InvoiceLineItem = {
      id: Date.now() + Math.random(),
      inventoryId: null,
      description: `Crimping charge — ${crimpSize}" (${crimpWire}, ${ends} end${ends === 1 ? '' : 's'})`,
      unit: 'end',
      qty: ends,
      rate: round2(billed),
      cost: round2(internalCost),
      marketMid: crimpMarketPerEnd != null ? round2(crimpMarketPerEnd) : round2(billed),
      pricingSource: 'crimping-charges',
    };

    setItems((prev) => [...prev, newItem]);
    setIsWorkshopModalOpen(false);
  };

  const handleAddWeldingService = () => {
    const ends = Math.max(1, parseInt(String(weldEnds), 10) || 1);
    const perEnd = weldingRates?.mode === 'per-end';
    const extraRate = weldRatesForActive.extra;
    const billed = weldBilledRate !== '' ? Number(weldBilledRate) : (extraRate ?? 0);

    if (!(billed > 0)) {
      alert('Please enter a valid welding extra rate.');
      return;
    }

    const qty = perEnd ? ends : 1;
    const newItem: InvoiceLineItem = {
      id: Date.now() + Math.random(),
      inventoryId: null,
      description: `Welding Extra — ${weldWire} ${weldSize}"${perEnd ? '' : ` (${ends} end${ends === 1 ? '' : 's'})`}`,
      unit: perEnd ? 'end' : 'job',
      qty,
      rate: round2(billed),
      cost: 0,
      marketMid: extraRate != null ? round2(extraRate) : round2(billed),
      pricingSource: 'welding-extra',
    };

    setItems((prev) => [...prev, newItem]);
    setIsWorkshopModalOpen(false);
  };

  const handleAddLatheService = () => {
    const qty = Math.max(0.1, parseFloat(String(latheQty)) || 1);
    const rate = Math.max(0, parseFloat(String(latheRate)) || 0);

    if (rate <= 0) {
      alert('Please enter a valid rate for lathe work.');
      return;
    }

    const newItem: InvoiceLineItem = {
      id: Date.now() + Math.random(),
      inventoryId: null,
      description: (latheDesc || 'Lathe Charge').trim(),
      unit: latheUnit || 'job',
      qty,
      rate: round2(rate),
      cost: 0,
      marketMid: round2(rate),
      pricingSource: 'lathe-charges',
    };

    setItems((prev) => [...prev, newItem]);
    setIsWorkshopModalOpen(false);
  };

  const handleAddTechnicalService = () => {
    const qty = Math.max(0.1, parseFloat(String(techQty)) || 1);
    const rate = Math.max(0, parseFloat(String(techRate)) || 0);

    if (rate <= 0) {
      alert('Please enter a valid technical service rate.');
      return;
    }

    const newItem: InvoiceLineItem = {
      id: Date.now() + Math.random(),
      inventoryId: null,
      description: (techDesc || 'Technical charges').trim(),
      unit: techUnit || 'Nos',
      qty,
      rate: round2(rate),
      cost: 0,
      marketMid: round2(rate),
      pricingSource: 'standard-charges',
    };

    setItems((prev) => [...prev, newItem]);
    setIsWorkshopModalOpen(false);
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
        isInternal,
        billedToName: billedToName.trim() || (isInternal ? 'Internal / Own Fleet' : 'Counter Customer'),
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
    const finalBilledName = billedToName.trim() || (isInternal ? 'Internal / Own Fleet' : '');
    if (!finalBilledName) {
      alert('Billed To Customer Name is required to finalize an invoice.');
      return;
    }
    const typeLabel = isInternal ? 'INTERNAL FLEET (Expense GL 6900)' : 'COMMERCIAL (Receivable GL 1200)';
    if (!window.confirm(`Finalize this ${typeLabel} invoice for ${finalBilledName}?\nGrand Total: ${formatLKR(grandTotal)}\n\nWARNING: Stock will be deducted immediately.`)) {
      return;
    }
    setCreateSubmitting(true);
    try {
      const payload = {
        invoiceId: editingDraftId,
        invoiceDate,
        isInternal,
        billedToName: finalBilledName,
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
                        {inv.Status === 'Draft' && (
                          <button
                            onClick={async () => {
                              try {
                                const fullDraft = await apiRequest<Invoice>(`/invoices/${inv.InvoiceID}`);
                                handleEditDraft(fullDraft);
                              } catch (err: any) {
                                alert(err.message || 'Could not load draft');
                              }
                            }}
                            title="Edit Draft Invoice"
                            className="p-1.5 hover:bg-amber-50 text-amber-600 rounded-lg transition"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                        )}
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
              {/* Invoice Type / Classification Selector */}
              <div
                className={`p-4 rounded-2xl border transition-all ${
                  isInternal
                    ? 'bg-blue-50/70 border-blue-200 ring-1 ring-blue-300'
                    : 'bg-slate-50/80 border-slate-200'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                        Invoice Classification / Bill Type
                      </label>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider border ${
                          isInternal
                            ? 'bg-blue-100 text-blue-800 border-blue-300'
                            : 'bg-indigo-100 text-indigo-800 border-indigo-300'
                        }`}
                      >
                        {isInternal ? 'Internal Fleet Job (Expense GL 6900)' : 'Commercial Customer (Receivable GL 1200)'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      {isInternal
                        ? 'Internal Work: Company-owned fleet, machinery, or workshop tools. No client receivable created. Workshop labour charges are tracked in the Labour Bills Workflow.'
                        : 'Commercial Bill: Standard external customer invoice. Posts to Trade Debtors (GL 1200) and tracks unpaid customer balance.'}
                    </p>
                  </div>

                  <div className="inline-flex p-1 bg-white border border-slate-200 rounded-xl shadow-xs shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setIsInternal(false);
                        if (billedToName === 'Internal / Own Fleet') setBilledToName('');
                      }}
                      className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                        !isInternal
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <Building2 className="w-3.5 h-3.5" /> Commercial (External)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsInternal(true);
                        if (!billedToName.trim()) setBilledToName('Internal / Own Fleet');
                      }}
                      className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                        isInternal
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <Truck className="w-3.5 h-3.5" /> Company Fleet (Internal)
                    </button>
                  </div>
                </div>

                {/* Quick Machine / Plant Chips when Internal is active */}
                {isInternal && (
                  <div className="mt-3 pt-3 border-t border-blue-100 flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-bold text-blue-900 mr-1">Quick Select Plant:</span>
                    <button
                      type="button"
                      onClick={() => setBilledToName('Internal / Own Fleet')}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition border ${
                        billedToName === 'Internal / Own Fleet'
                          ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                          : 'bg-white text-blue-700 border-blue-200 hover:bg-blue-100/60'
                      }`}
                    >
                      Own Fleet (General)
                    </button>
                    {machines.map((m) => (
                      <button
                        key={m.MachineID}
                        type="button"
                        onClick={() => setBilledToName(m.Name)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition border ${
                          billedToName === m.Name
                            ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                            : 'bg-white text-blue-700 border-blue-200 hover:bg-blue-100/60'
                        }`}
                      >
                        {m.Name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

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
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    {isInternal ? 'Internal Machine / Vehicle / Unit *' : 'Billed To (Customer Name) *'}
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder={
                        isInternal
                          ? 'e.g. HEX-18, 48-8072, or Internal / Own Fleet'
                          : 'e.g. D.K. Silva or pick below'
                      }
                      value={billedToName}
                      onChange={(e) => setBilledToName(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      list="customers-list"
                    />
                    <datalist id="customers-list">
                      {isInternal
                        ? machines.map((m) => <option key={m.MachineID} value={m.Name} />)
                        : customers
                            .filter((c) => c.Kind !== 'internal')
                            .map((c) => <option key={c.CustomerID} value={c.Name} />)}
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
                      onClick={() => handleOpenWorkshopModal('crimping')}
                      className="px-3 py-1.5 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white rounded-xl text-xs font-semibold shadow-sm transition flex items-center gap-1.5"
                      title="Open unified workshop labour and services calculation modal"
                    >
                      <Wrench className="w-3.5 h-3.5" /> + Workshop Services
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenWorkshopModal('crimping')}
                      className="px-2.5 py-1.5 bg-white border border-slate-200 hover:border-indigo-300 rounded-lg text-xs font-semibold text-slate-700 hover:text-indigo-600 flex items-center gap-1 transition"
                    >
                      <Wrench className="w-3.5 h-3.5 text-indigo-500" /> Crimping
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenWorkshopModal('welding')}
                      className="px-2.5 py-1.5 bg-white border border-slate-200 hover:border-orange-300 rounded-lg text-xs font-semibold text-slate-700 hover:text-orange-600 flex items-center gap-1 transition"
                    >
                      <Flame className="w-3.5 h-3.5 text-orange-500" /> Welding
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenWorkshopModal('lathe')}
                      className="px-2.5 py-1.5 bg-white border border-slate-200 hover:border-cyan-300 rounded-lg text-xs font-semibold text-slate-700 hover:text-cyan-600 flex items-center gap-1 transition"
                    >
                      <Cog className="w-3.5 h-3.5 text-cyan-600" /> Lathe
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenWorkshopModal('tech')}
                      className="px-2.5 py-1.5 bg-white border border-slate-200 hover:border-emerald-300 rounded-lg text-xs font-semibold text-slate-700 hover:text-emerald-600 flex items-center gap-1 transition"
                    >
                      <Settings2 className="w-3.5 h-3.5 text-emerald-600" /> Technical
                    </button>
                    <button
                      type="button"
                      onClick={handleAddCustomLine}
                      className="px-2.5 py-1.5 bg-white border border-slate-200 hover:border-slate-300 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-800 flex items-center gap-1 transition"
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
                              {it.pricingSource === 'crimping-charges' && (
                                <div className="flex items-center gap-1.5 mt-1 text-[10px]">
                                  <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-semibold border border-indigo-200 flex items-center gap-1">
                                    <Wrench className="w-2.5 h-2.5" /> Crimping ({it.qty} ends)
                                  </span>
                                  {it.cost ? (
                                    <span className="text-slate-400">Cost: {formatLKR(it.cost)}/end</span>
                                  ) : null}
                                </div>
                              )}
                              {it.pricingSource === 'welding-extra' && (
                                <div className="flex items-center gap-1.5 mt-1 text-[10px]">
                                  <span className="px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 font-semibold border border-orange-200 flex items-center gap-1">
                                    <Flame className="w-2.5 h-2.5" /> Welding Extra
                                  </span>
                                </div>
                              )}
                              {it.pricingSource === 'lathe-charges' && (
                                <div className="flex items-center gap-1.5 mt-1 text-[10px]">
                                  <span className="px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 font-semibold border border-cyan-200 flex items-center gap-1">
                                    <Cog className="w-2.5 h-2.5" /> Lathe Work
                                  </span>
                                </div>
                              )}
                              {it.pricingSource === 'standard-charges' && (
                                <div className="flex items-center gap-1.5 mt-1 text-[10px]">
                                  <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold border border-emerald-200 flex items-center gap-1">
                                    <Settings2 className="w-2.5 h-2.5" /> Technical Service
                                  </span>
                                </div>
                              )}
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

      {/* WORKSHOP SERVICES & LABOUR MODAL */}
      {isWorkshopModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto animate-in fade-in duration-150">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden my-auto animate-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-2xl border border-indigo-100">
                  <Wrench className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800">
                    Workshop Services & Labour Charges
                  </h3>
                  <p className="text-xs text-slate-500">
                    Real-time calculation & rate cards for crimping, welding, lathe & technical services
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsWorkshopModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Navigation Tabs */}
            <div className="px-6 pt-3 pb-2 border-b border-slate-100 bg-slate-50/30 flex items-center gap-2 overflow-x-auto">
              <button
                type="button"
                onClick={() => setWorkshopTab('crimping')}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition ${
                  workshopTab === 'crimping'
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                }`}
              >
                <Wrench className="w-3.5 h-3.5" /> Crimping Charge
              </button>

              <button
                type="button"
                onClick={() => setWorkshopTab('welding')}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition ${
                  workshopTab === 'welding'
                    ? 'bg-orange-600 text-white shadow-sm'
                    : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                }`}
              >
                <Flame className="w-3.5 h-3.5" /> Welding Extra
              </button>

              <button
                type="button"
                onClick={() => {
                  setWorkshopTab('lathe');
                  if (latheDesc === 'Lathe Charge' && (latheRate === 500 || !latheRate)) {
                    setLatheRate(250);
                    setLatheUnit('Nos');
                  }
                }}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition ${
                  workshopTab === 'lathe'
                    ? 'bg-cyan-600 text-white shadow-sm'
                    : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                }`}
              >
                <Cog className="w-3.5 h-3.5" /> Lathe Work & Turning
              </button>

              <button
                type="button"
                onClick={() => setWorkshopTab('tech')}
                className={`px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition ${
                  workshopTab === 'tech'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                }`}
              >
                <Settings2 className="w-3.5 h-3.5" /> Technical Service
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-5 flex-1 text-xs">
              {isLoadingWorkshopRates && (
                <div className="flex items-center justify-center p-3 text-indigo-600 bg-indigo-50/60 rounded-xl gap-2 font-medium">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading workshop pricing rate cards...
                </div>
              )}

              {/* TAB 1: CRIMPING */}
              {workshopTab === 'crimping' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Hose Size */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1.5">
                        Hose Inner Diameter (Size)
                      </label>
                      <select
                        value={crimpSize}
                        onChange={(e) => {
                          setCrimpSize(e.target.value);
                          setCrimpCustomBilled(false);
                        }}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      >
                        {availableCrimpSizes.map((sz) => (
                          <option key={sz} value={sz}>
                            {sz}&quot; Hose Assembly
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Wire Type */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1.5">
                        Wire Type Specification
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setCrimpWire('2-wire');
                            setCrimpCustomBilled(false);
                          }}
                          className={`py-2 px-3 rounded-xl font-semibold text-center border transition ${
                            crimpWire === '2-wire'
                              ? 'bg-indigo-50 border-indigo-500 text-indigo-700 ring-1 ring-indigo-500'
                              : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          2-Wire (Standard)
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCrimpWire('4-wire');
                            setCrimpCustomBilled(false);
                          }}
                          className={`py-2 px-3 rounded-xl font-semibold text-center border transition ${
                            crimpWire === '4-wire'
                              ? 'bg-indigo-50 border-indigo-500 text-indigo-700 ring-1 ring-indigo-500'
                              : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          4-Wire (Heavy Duty)
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Number of Ends */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1.5">
                      Number of Crimped Ends
                    </label>
                    <div className="flex items-center gap-2">
                      {[1, 2, 4].map((cnt) => (
                        <button
                          key={cnt}
                          type="button"
                          onClick={() => setCrimpEnds(cnt)}
                          className={`px-3 py-1.5 rounded-xl border font-semibold transition ${
                            crimpEnds === cnt
                              ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                              : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          {cnt} {cnt === 1 ? 'End' : 'Ends'} {cnt === 2 ? '(Standard Assembly)' : ''}
                        </button>
                      ))}
                      <div className="flex items-center gap-1.5 ml-auto">
                        <span className="text-slate-500 font-medium">Custom:</span>
                        <input
                          type="number"
                          min="1"
                          max="50"
                          value={crimpEnds}
                          onChange={(e) => setCrimpEnds(Math.max(1, parseInt(e.target.value, 10) || 1))}
                          className="w-16 px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-center focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Pricing Breakdown Card */}
                  <div className="bg-slate-50/80 rounded-2xl p-4 border border-slate-200 space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                      <div className="bg-white p-2.5 rounded-xl border border-slate-200">
                        <span className="text-[11px] text-slate-500 block">Internal Cost / End</span>
                        <strong className="text-sm text-slate-800 font-mono">
                          {formatLKR(activeCrimpingRow?.internalCostPerEnd || 0)}
                        </strong>
                      </div>

                      <div className="bg-white p-2.5 rounded-xl border border-slate-200">
                        <span className="text-[11px] text-slate-500 block">Shop Market Rate</span>
                        <strong className="text-sm text-indigo-600 font-mono">
                          {crimpMarketPerEnd != null ? formatLKR(crimpMarketPerEnd) : 'No Rate'}
                        </strong>
                      </div>

                      <div className="bg-white p-2.5 rounded-xl border border-slate-200">
                        <span className="text-[11px] text-slate-500 block">Crimped Ends</span>
                        <strong className="text-sm text-slate-800 font-mono">{crimpEnds}</strong>
                      </div>

                      <div className="bg-indigo-50 p-2.5 rounded-xl border border-indigo-200">
                        <span className="text-[11px] text-indigo-700 block font-semibold">Total Bill</span>
                        <strong className="text-sm text-indigo-700 font-mono font-bold">
                          {formatLKR((Number(crimpBilledRate) || 0) * crimpEnds)}
                        </strong>
                      </div>
                    </div>

                    {/* Billed Rate Input */}
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2 border-t border-slate-200">
                      <div className="w-full sm:w-auto">
                        <label className="font-semibold text-slate-700 block">
                          Billed Rate per End (LKR)
                        </label>
                        <span className="text-[11px] text-slate-400">
                          Defaults to market rate ({crimpWire}). Can be customized below.
                        </span>
                      </div>
                      <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                        <input
                          type="number"
                          step="1"
                          min="0"
                          value={crimpBilledRate}
                          onChange={(e) => {
                            setCrimpBilledRate(e.target.value === '' ? '' : parseFloat(e.target.value) || 0);
                            setCrimpCustomBilled(true);
                          }}
                          className="w-32 px-3 py-1.5 bg-white border border-slate-300 rounded-xl text-right font-mono font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                        />
                        {crimpCustomBilled && (
                          <button
                            type="button"
                            onClick={() => {
                              setCrimpCustomBilled(false);
                              if (crimpMarketPerEnd != null) setCrimpBilledRate(crimpMarketPerEnd);
                            }}
                            className="px-2 py-1 text-[11px] text-indigo-600 hover:bg-indigo-50 rounded-lg"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Warnings / Alerts */}
                    {crimpMarketPerEnd == null && (
                      <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        <span>No standard {crimpWire} shop rate defined for {crimpSize}&quot; — please specify billed rate manually.</span>
                      </div>
                    )}
                    {activeCrimpingRow && Number(crimpBilledRate) < Number(activeCrimpingRow.internalCostPerEnd) && (
                      <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                        <span>Warning: Billed rate ({formatLKR(Number(crimpBilledRate) || 0)}) is below internal cost ({formatLKR(activeCrimpingRow.internalCostPerEnd)})!</span>
                      </div>
                    )}
                  </div>

                  {/* Add Button */}
                  <div className="pt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={handleAddCrimpingService}
                      className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-semibold shadow-md transition flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" /> Add Crimping Charge ({formatLKR((Number(crimpBilledRate) || 0) * crimpEnds)})
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 2: WELDING EXTRA */}
              {workshopTab === 'welding' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Size */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1.5">
                        Hose Inner Diameter (Size)
                      </label>
                      <select
                        value={weldSize}
                        onChange={(e) => {
                          setWeldSize(e.target.value);
                          setWeldCustomBilled(false);
                        }}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
                      >
                        {availableWeldSizes.map((sz) => (
                          <option key={sz} value={sz}>
                            {sz}&quot; Hose Assembly
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Wire Type */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1.5">
                        Wire Type Specification
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setWeldWire('2-wire');
                            setWeldCustomBilled(false);
                          }}
                          className={`py-2 px-3 rounded-xl font-semibold text-center border transition ${
                            weldWire === '2-wire'
                              ? 'bg-orange-50 border-orange-500 text-orange-700 ring-1 ring-orange-500'
                              : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          2-Wire
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setWeldWire('4-wire');
                            setWeldCustomBilled(false);
                          }}
                          className={`py-2 px-3 rounded-xl font-semibold text-center border transition ${
                            weldWire === '4-wire'
                              ? 'bg-orange-50 border-orange-500 text-orange-700 ring-1 ring-orange-500'
                              : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          4-Wire
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Welded Ends */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1.5">
                      Welded Ends
                    </label>
                    <div className="flex items-center gap-2">
                      {[1, 2].map((cnt) => (
                        <button
                          key={cnt}
                          type="button"
                          onClick={() => setWeldEnds(cnt)}
                          className={`px-3 py-1.5 rounded-xl border font-semibold transition ${
                            weldEnds === cnt
                              ? 'bg-orange-600 text-white border-orange-600 shadow-sm'
                              : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          {cnt} {cnt === 1 ? 'End' : 'Ends'}
                        </button>
                      ))}
                      <div className="flex items-center gap-1.5 ml-auto">
                        <span className="text-slate-500 font-medium">Custom:</span>
                        <input
                          type="number"
                          min="1"
                          max="20"
                          value={weldEnds}
                          onChange={(e) => setWeldEnds(Math.max(1, parseInt(e.target.value, 10) || 1))}
                          className="w-16 px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-center focus:outline-none focus:ring-2 focus:ring-orange-500/20"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Pricing Breakdown Card */}
                  <div className="bg-slate-50/80 rounded-2xl p-4 border border-slate-200 space-y-3">
                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                      <span>Rate Mode:</span>
                      <span className="font-semibold px-2 py-0.5 rounded bg-orange-100 text-orange-800">
                        {weldingRates?.mode === 'per-end' ? 'Billed Per End' : 'Flat Charge Per Job'}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-center">
                      <div className="bg-white p-2.5 rounded-xl border border-slate-200">
                        <span className="text-[11px] text-slate-500 block">Assembly Ref Rate</span>
                        <strong className="text-sm text-slate-800 font-mono">
                          {weldRatesForActive.assembly != null ? formatLKR(weldRatesForActive.assembly) : '—'}
                        </strong>
                      </div>

                      <div className="bg-white p-2.5 rounded-xl border border-slate-200">
                        <span className="text-[11px] text-slate-500 block">Standard Extra</span>
                        <strong className="text-sm text-orange-600 font-mono">
                          {weldRatesForActive.extra != null ? formatLKR(weldRatesForActive.extra) : '—'}
                        </strong>
                      </div>

                      <div className="bg-orange-50 p-2.5 rounded-xl border border-orange-200">
                        <span className="text-[11px] text-orange-700 block font-semibold">Total Welding Extra</span>
                        <strong className="text-sm text-orange-700 font-mono font-bold">
                          {formatLKR(
                            weldingRates?.mode === 'per-end'
                              ? (Number(weldBilledRate) || 0) * weldEnds
                              : Number(weldBilledRate) || 0
                          )}
                        </strong>
                      </div>
                    </div>

                    {/* Billed Rate Input */}
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2 border-t border-slate-200">
                      <div className="w-full sm:w-auto">
                        <label className="font-semibold text-slate-700 block">
                          Billed Welding Extra Rate (LKR)
                        </label>
                        <span className="text-[11px] text-slate-400">
                          Defaults to standard rate. Can be adjusted as needed.
                        </span>
                      </div>
                      <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                        <input
                          type="number"
                          step="1"
                          min="0"
                          value={weldBilledRate}
                          onChange={(e) => {
                            setWeldBilledRate(e.target.value === '' ? '' : parseFloat(e.target.value) || 0);
                            setWeldCustomBilled(true);
                          }}
                          className="w-32 px-3 py-1.5 bg-white border border-slate-300 rounded-xl text-right font-mono font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
                        />
                        {weldCustomBilled && (
                          <button
                            type="button"
                            onClick={() => {
                              setWeldCustomBilled(false);
                              if (weldRatesForActive.extra != null) setWeldBilledRate(weldRatesForActive.extra);
                            }}
                            className="px-2 py-1 text-[11px] text-orange-600 hover:bg-orange-50 rounded-lg"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </div>

                    {weldRatesForActive.extra == null && (
                      <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        <span>No standard {weldWire} welding-extra rate for {weldSize}&quot; — please specify billed rate manually.</span>
                      </div>
                    )}
                  </div>

                  {/* Add Button */}
                  <div className="pt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={handleAddWeldingService}
                      className="px-5 py-2.5 bg-orange-600 hover:bg-orange-700 text-white rounded-xl font-semibold shadow-md transition flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" /> Add Welding Extra ({formatLKR(
                        weldingRates?.mode === 'per-end'
                          ? (Number(weldBilledRate) || 0) * weldEnds
                          : Number(weldBilledRate) || 0
                      )})
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 3: LATHE WORK & TURNING */}
              {workshopTab === 'lathe' && (
                <div className="space-y-4">
                  {/* Preset Pills */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1.5">
                      Quick Service Presets
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {LATHE_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => {
                            setLatheDesc(preset.desc);
                            setLatheRate(preset.rate);
                            setLatheUnit(preset.unit);
                          }}
                          className={`px-2.5 py-1.5 rounded-xl border font-medium text-[11px] transition ${
                            latheDesc === preset.desc
                              ? 'bg-cyan-50 border-cyan-500 text-cyan-800 font-semibold ring-1 ring-cyan-500'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {preset.label} ({formatLKR(preset.rate)})
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Description Input */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1.5">
                      Service Description on Invoice
                    </label>
                    <input
                      type="text"
                      value={latheDesc}
                      onChange={(e) => setLatheDesc(e.target.value)}
                      placeholder="e.g. Lathe machining & turning charge"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {/* Unit */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1.5">
                        Billing Unit
                      </label>
                      <select
                        value={latheUnit}
                        onChange={(e) => setLatheUnit(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                      >
                        <option value="Nos">Nos (Items / Standard)</option>
                        <option value="job">job (Fixed Job)</option>
                        <option value="hrs">hrs (Hourly)</option>
                        <option value="pcs">pcs (Pieces)</option>
                      </select>
                    </div>

                    {/* Qty */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1.5">
                        Quantity / Hours
                      </label>
                      <input
                        type="number"
                        step="0.5"
                        min="0.5"
                        value={latheQty}
                        onChange={(e) => setLatheQty(Math.max(0.1, parseFloat(e.target.value) || 1))}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-right focus:outline-none focus:ring-2 focus:ring-cyan-500/20"
                      />
                    </div>

                    {/* Rate */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1.5">
                        Rate per Unit (LKR)
                      </label>
                      <input
                        type="number"
                        step="10"
                        min="0"
                        value={latheRate}
                        onChange={(e) => setLatheRate(Math.max(0, parseFloat(e.target.value) || 0))}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-right focus:outline-none focus:ring-2 focus:ring-cyan-500/20 font-mono"
                      />
                    </div>
                  </div>

                  {/* Summary Card */}
                  <div className="bg-cyan-50/70 border border-cyan-200 rounded-2xl p-4 flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-cyan-900">{latheDesc || 'Lathe Charge'}</p>
                      <p className="text-[11px] text-cyan-700">
                        {latheQty} {latheUnit} × {formatLKR(latheRate)}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] uppercase font-bold text-cyan-700 tracking-wider block">Total Lathe Charge</span>
                      <strong className="text-base text-cyan-900 font-mono font-bold">
                        {formatLKR(round2(latheQty * latheRate))}
                      </strong>
                    </div>
                  </div>

                  {/* Add Button */}
                  <div className="pt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={handleAddLatheService}
                      className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-700 text-white rounded-xl font-semibold shadow-md transition flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" /> Add Lathe Charge ({formatLKR(round2(latheQty * latheRate))})
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 4: TECHNICAL SERVICE */}
              {workshopTab === 'tech' && (
                <div className="space-y-4">
                  {/* Preset Pills */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1.5">
                      Quick Service Presets
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {TECH_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => {
                            setTechDesc(preset.desc);
                            setTechRate(preset.rate);
                            setTechUnit(preset.unit);
                          }}
                          className={`px-2.5 py-1.5 rounded-xl border font-medium text-[11px] transition ${
                            techDesc === preset.desc
                              ? 'bg-emerald-50 border-emerald-500 text-emerald-800 font-semibold ring-1 ring-emerald-500'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {preset.label} ({formatLKR(preset.rate)})
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Description Input */}
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1.5">
                      Service Description on Invoice
                    </label>
                    <input
                      type="text"
                      value={techDesc}
                      onChange={(e) => setTechDesc(e.target.value)}
                      placeholder="e.g. Technical charges"
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {/* Unit */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1.5">
                        Billing Unit
                      </label>
                      <select
                        value={techUnit}
                        onChange={(e) => setTechUnit(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      >
                        <option value="Nos">Nos (Service Charge)</option>
                        <option value="job">job (Fixed Job)</option>
                        <option value="hrs">hrs (Hourly)</option>
                        <option value="day">day (Daily Rate)</option>
                      </select>
                    </div>

                    {/* Qty */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1.5">
                        Quantity / Units
                      </label>
                      <input
                        type="number"
                        step="1"
                        min="1"
                        value={techQty}
                        onChange={(e) => setTechQty(Math.max(0.1, parseFloat(e.target.value) || 1))}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-right focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                      />
                    </div>

                    {/* Rate */}
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1.5">
                        Rate per Unit (LKR)
                      </label>
                      <input
                        type="number"
                        step="50"
                        min="0"
                        value={techRate}
                        onChange={(e) => setTechRate(Math.max(0, parseFloat(e.target.value) || 0))}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-semibold text-right focus:outline-none focus:ring-2 focus:ring-emerald-500/20 font-mono"
                      />
                    </div>
                  </div>

                  {/* Summary Card */}
                  <div className="bg-emerald-50/70 border border-emerald-200 rounded-2xl p-4 flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-emerald-900">{techDesc || 'Technical charges'}</p>
                      <p className="text-[11px] text-emerald-700">
                        {techQty} {techUnit} × {formatLKR(techRate)}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] uppercase font-bold text-emerald-700 tracking-wider block">Total Service Charge</span>
                      <strong className="text-base text-emerald-900 font-mono font-bold">
                        {formatLKR(round2(techQty * techRate))}
                      </strong>
                    </div>
                  </div>

                  {/* Add Button */}
                  <div className="pt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={handleAddTechnicalService}
                      className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-semibold shadow-md transition flex items-center gap-2"
                    >
                      <Plus className="w-4 h-4" /> Add Technical Service ({formatLKR(round2(techQty * techRate))})
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between">
              <span className="text-[11px] text-slate-400">
                Labour line items snapshot zero inventory stock deduct and feed into Job Profit calculations.
              </span>
              <button
                type="button"
                onClick={() => setIsWorkshopModalOpen(false)}
                className="px-4 py-2 border border-slate-200 hover:bg-slate-100 rounded-xl text-xs font-semibold text-slate-600 transition"
              >
                Close
              </button>
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
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-slate-800">
                      Invoice {selectedInvoice.InvoiceNo}
                    </h3>
                    {selectedInvoice.IsInternal === 1 ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700 border border-blue-200 uppercase tracking-wider">
                        Internal Fleet
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-700 border border-indigo-200 uppercase tracking-wider">
                        Commercial
                      </span>
                    )}
                  </div>
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
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setCancelPromptId(selectedInvoice.InvoiceID);
                        setCancelReason('');
                      }}
                      className="px-3 py-1.5 border border-rose-200 text-rose-600 hover:bg-rose-50 rounded-xl text-xs font-semibold transition"
                    >
                      Cancel Draft
                    </button>
                    <button
                      onClick={() => handleEditDraft(selectedInvoice)}
                      className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold transition flex items-center gap-1.5 shadow-sm"
                    >
                      <Edit2 className="w-3.5 h-3.5" /> Edit Draft
                    </button>
                  </div>
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
