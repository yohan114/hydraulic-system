import React, { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { PurchaseOrder, GoodsReceipt, PurchaseBill, Supplier, InventoryItem } from '../types/models';
import { formatLKR, formatDate } from '../utils/format';
import {
  ShoppingCart,
  Plus,
  Truck,
  FileCheck,
  Clock,
  Trash2,
  X,
  Loader2
} from 'lucide-react';

export const ProcurementPage: React.FC = () => {
  const { canWrite } = useAuth();

  // Active Tab: 'orders' | 'receipts' | 'bills' | 'ageing'
  const [activeTab, setActiveTab] = useState<'orders' | 'receipts' | 'bills' | 'ageing'>('orders');

  // Lists
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [receipts, setReceipts] = useState<GoodsReceipt[]>([]);
  const [bills, setBills] = useState<PurchaseBill[]>([]);
  const [ageing, setAgeing] = useState<any | null>(null);

  const [loading, setLoading] = useState<boolean>(true);

  // Masters
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);

  // Create PO Modal
  const [isNewPoOpen, setIsNewPoOpen] = useState<boolean>(false);
  const [submittingPo, setSubmittingPo] = useState<boolean>(false);
  const [poSupplierId, setPoSupplierId] = useState<number | ''>('');
  const [poOrderDate, setPoOrderDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [poLines, setPoLines] = useState<Array<{ inventoryId: number; qty: number; unitPrice: number }>>([]);

  // Pay Bill Modal
  const [payingBill, setPayingBill] = useState<PurchaseBill | null>(null);
  const [paymentAmount, setPaymentAmount] = useState<number>(0);
  const [submittingPayment, setSubmittingPayment] = useState<boolean>(false);

  // Load Masters
  useEffect(() => {
    const loadMasters = async () => {
      try {
        const [s, inv] = await Promise.all([
          apiRequest<Supplier[]>('/suppliers'),
          apiRequest<InventoryItem[]>('/inventory'),
        ]);
        setSuppliers(Array.isArray(s) ? s : []);
        setInventoryItems(Array.isArray(inv) ? inv : []);
      } catch (e) {
        console.error(e);
      }
    };
    loadMasters();
  }, []);

  // Load Tab Data
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (activeTab === 'orders') {
        const res = await apiRequest<PurchaseOrder[]>('/purchase-orders');
        setOrders(Array.isArray(res) ? res : []);
      } else if (activeTab === 'receipts') {
        const res = await apiRequest<GoodsReceipt[]>('/goods-receipts');
        setReceipts(Array.isArray(res) ? res : []);
      } else if (activeTab === 'bills') {
        const res = await apiRequest<PurchaseBill[]>('/purchase-bills');
        setBills(Array.isArray(res) ? res : []);
      } else if (activeTab === 'ageing') {
        const res = await apiRequest('/payables/ageing');
        setAgeing(res || null);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Open New PO
  const handleOpenNewPo = () => {
    setPoSupplierId('');
    setPoOrderDate(new Date().toISOString().slice(0, 10));
    setPoLines([{ inventoryId: inventoryItems[0]?.InventoryID || 1, qty: 10, unitPrice: 0 }]);
    setIsNewPoOpen(true);
  };

  const handleAddPoLine = () => {
    setPoLines((prev) => [
      ...prev,
      { inventoryId: inventoryItems[0]?.InventoryID || 1, qty: 10, unitPrice: 0 },
    ]);
  };

  const handleUpdatePoLine = (idx: number, field: string, val: any) => {
    setPoLines((prev) => {
      const next = [...prev];
      (next[idx] as any)[field] = val;
      return next;
    });
  };

  const handleRemovePoLine = (idx: number) => {
    setPoLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmitPo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!poSupplierId) {
      alert('Please select a supplier.');
      return;
    }
    if (poLines.length === 0) {
      alert('Please add at least one line.');
      return;
    }
    setSubmittingPo(true);
    try {
      await apiRequest('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: Number(poSupplierId),
          orderDate: poOrderDate,
          items: poLines.map((l) => ({
            inventoryId: Number(l.inventoryId),
            qty: Number(l.qty) || 1,
            unitPrice: Number(l.unitPrice) || 0,
          })),
        }),
      });
      alert('Purchase order created successfully!');
      setIsNewPoOpen(false);
      await loadData();
    } catch (err: any) {
      alert(err.message || 'Error creating purchase order');
    } finally {
      setSubmittingPo(false);
    }
  };

  // Pay Bill
  const handleOpenPay = (bill: PurchaseBill) => {
    setPayingBill(bill);
    setPaymentAmount(bill.Outstanding);
  };

  const handleSubmitPayment = async () => {
    if (!payingBill || paymentAmount <= 0) return;
    setSubmittingPayment(true);
    try {
      await apiRequest('/supplier-payments', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: payingBill.SupplierID,
          billId: payingBill.BillID,
          amount: paymentAmount,
          paymentDate: new Date().toISOString().slice(0, 10),
          method: 'Bank',
        }),
      });
      alert(`Recorded payment of ${formatLKR(paymentAmount)}!`);
      setPayingBill(null);
      await loadData();
    } catch (err: any) {
      alert(err.message || 'Payment recording failed');
    } finally {
      setSubmittingPayment(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Tab Switcher & Action Bar */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-1.5 bg-slate-100 p-1.5 rounded-2xl w-full sm:w-auto overflow-x-auto">
          {[
            { id: 'orders', label: 'Purchase Orders', icon: ShoppingCart },
            { id: 'receipts', label: 'Goods Receipts (GRN)', icon: Truck },
            { id: 'bills', label: 'Supplier Bills', icon: FileCheck },
            { id: 'ageing', label: 'Payables Ageing', icon: Clock },
          ].map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id as any)}
                className={`px-3.5 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 whitespace-nowrap ${
                  activeTab === t.id
                    ? 'bg-white text-indigo-600 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            );
          })}
        </div>

        {activeTab === 'orders' && canWrite && (
          <button
            onClick={handleOpenNewPo}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold shadow-sm transition w-full sm:w-auto justify-center"
          >
            <Plus className="w-4 h-4" /> Issue Purchase Order
          </button>
        )}
      </div>

      {/* TAB 1: PURCHASE ORDERS */}
      {activeTab === 'orders' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                <tr>
                  <th className="py-3.5 px-4">PO Number</th>
                  <th className="py-3.5 px-4">Date</th>
                  <th className="py-3.5 px-4">Supplier</th>
                  <th className="py-3.5 px-4 text-center">Lines</th>
                  <th className="py-3.5 px-4 text-right">Order Value</th>
                  <th className="py-3.5 px-4 text-center">Receiving Status</th>
                  <th className="py-3.5 px-4 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                      Loading purchase orders...
                    </td>
                  </tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      <ShoppingCart className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                      No purchase orders recorded yet.
                    </td>
                  </tr>
                ) : (
                  orders.map((po) => {
                    const receivedPct = po.OrderedQty > 0 ? Math.round((po.ReceivedQty / po.OrderedQty) * 100) : 0;
                    return (
                      <tr key={po.POID} className="hover:bg-slate-50/60 transition">
                        <td className="py-3.5 px-4 font-bold text-slate-900">{po.PONo}</td>
                        <td className="py-3.5 px-4 text-slate-500 text-xs">{formatDate(po.OrderDate)}</td>
                        <td className="py-3.5 px-4 font-medium text-slate-800">{po.SupplierName}</td>
                        <td className="py-3.5 px-4 text-center">{po.Lines}</td>
                        <td className="py-3.5 px-4 text-right font-bold text-slate-900">{formatLKR(po.Total)}</td>
                        <td className="py-3.5 px-4 text-center">
                          <span className="text-xs font-semibold text-slate-600">
                            {receivedPct}% received
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                            po.Status === 'received'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                          }`}>
                            {po.Status}
                          </span>
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

      {/* TAB 2: GOODS RECEIPTS (GRN) */}
      {activeTab === 'receipts' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                <tr>
                  <th className="py-3.5 px-4">GRN No</th>
                  <th className="py-3.5 px-4">Receipt Date</th>
                  <th className="py-3.5 px-4">Supplier</th>
                  <th className="py-3.5 px-4">Linked PO</th>
                  <th className="py-3.5 px-4 text-right">Goods Value</th>
                  <th className="py-3.5 px-4 text-right">Landed Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                      Loading goods receipts...
                    </td>
                  </tr>
                ) : receipts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      <Truck className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                      No goods receipt notes (GRN) found.
                    </td>
                  </tr>
                ) : (
                  receipts.map((grn) => (
                    <tr key={grn.GRNID} className="hover:bg-slate-50/60 transition">
                      <td className="py-3.5 px-4 font-bold text-slate-900">{grn.GRNNo}</td>
                      <td className="py-3.5 px-4 text-slate-500 text-xs">{formatDate(grn.ReceiptDate)}</td>
                      <td className="py-3.5 px-4 font-medium text-slate-800">{grn.SupplierName}</td>
                      <td className="py-3.5 px-4 font-mono text-xs text-indigo-600">{grn.PONo || '—'}</td>
                      <td className="py-3.5 px-4 text-right font-bold text-slate-900">{formatLKR(grn.GoodsValue)}</td>
                      <td className="py-3.5 px-4 text-right text-slate-600">{formatLKR(grn.LandedCost)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: SUPPLIER BILLS */}
      {activeTab === 'bills' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                <tr>
                  <th className="py-3.5 px-4">Bill No</th>
                  <th className="py-3.5 px-4">Bill Date</th>
                  <th className="py-3.5 px-4">Supplier</th>
                  <th className="py-3.5 px-4 text-right">Bill Total</th>
                  <th className="py-3.5 px-4 text-right">Paid</th>
                  <th className="py-3.5 px-4 text-right">Outstanding</th>
                  <th className="py-3.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                      Loading supplier bills...
                    </td>
                  </tr>
                ) : bills.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-slate-400">
                      <FileCheck className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                      No supplier invoices / bills recorded.
                    </td>
                  </tr>
                ) : (
                  bills.map((b) => (
                    <tr key={b.BillID} className="hover:bg-slate-50/60 transition">
                      <td className="py-3.5 px-4 font-bold text-slate-900">{b.BillNo}</td>
                      <td className="py-3.5 px-4 text-slate-500 text-xs">{formatDate(b.BillDate)}</td>
                      <td className="py-3.5 px-4 font-medium text-slate-800">{b.SupplierName}</td>
                      <td className="py-3.5 px-4 text-right font-semibold text-slate-900">{formatLKR(b.Total)}</td>
                      <td className="py-3.5 px-4 text-right text-emerald-600 font-medium">{formatLKR(b.AmountPaid)}</td>
                      <td className="py-3.5 px-4 text-right font-bold text-amber-600">{formatLKR(b.Outstanding)}</td>
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        {b.Outstanding > 0 && canWrite && (
                          <button
                            onClick={() => handleOpenPay(b)}
                            className="px-3 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg text-xs font-semibold transition"
                          >
                            Pay Bill
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

      {/* TAB 4: PAYABLES AGEING */}
      {activeTab === 'ageing' && (
        <div className="space-y-6">
          {ageing && (
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <p className="text-xs font-semibold text-slate-500 uppercase">Current (0-30 Days)</p>
                <p className="text-2xl font-bold text-slate-800 mt-2">{formatLKR(ageing.current || 0)}</p>
              </div>
              <div className="bg-white rounded-2xl border border-amber-200 p-5 shadow-sm bg-amber-50/20">
                <p className="text-xs font-semibold text-amber-700 uppercase">31 - 60 Days</p>
                <p className="text-2xl font-bold text-amber-700 mt-2">{formatLKR(ageing.thirtyTo60 || 0)}</p>
              </div>
              <div className="bg-white rounded-2xl border border-orange-200 p-5 shadow-sm bg-orange-50/20">
                <p className="text-xs font-semibold text-orange-700 uppercase">61 - 90 Days</p>
                <p className="text-2xl font-bold text-orange-700 mt-2">{formatLKR(ageing.sixtyTo90 || 0)}</p>
              </div>
              <div className="bg-white rounded-2xl border border-rose-200 p-5 shadow-sm bg-rose-50/20">
                <p className="text-xs font-semibold text-rose-700 uppercase">Over 90 Days</p>
                <p className="text-2xl font-bold text-rose-700 mt-2">{formatLKR(ageing.over90 || 0)}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* NEW PO MODAL */}
      {isNewPoOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
              <h3 className="text-base font-bold text-slate-800">New Purchase Order</h3>
              <button onClick={() => setIsNewPoOpen(false)} className="p-1.5 text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitPo} className="p-6 overflow-y-auto space-y-4 flex-1 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Supplier *</label>
                  <select
                    required
                    value={poSupplierId}
                    onChange={(e) => setPoSupplierId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm"
                  >
                    <option value="">— Select Supplier —</option>
                    {suppliers.map((s) => (
                      <option key={s.SupplierID} value={s.SupplierID}>{s.Name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Order Date</label>
                  <input
                    type="date"
                    value={poOrderDate}
                    onChange={(e) => setPoOrderDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-700 uppercase">Items to Order</h4>
                  <button
                    type="button"
                    onClick={handleAddPoLine}
                    className="px-2.5 py-1 bg-indigo-50 text-indigo-700 rounded-lg text-xs font-semibold"
                  >
                    + Add Line
                  </button>
                </div>

                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 font-semibold text-slate-600">
                      <tr>
                        <th className="py-2 px-3">Catalog Item</th>
                        <th className="py-2 px-3 w-24 text-right">Qty</th>
                        <th className="py-2 px-3 w-28 text-right">Unit Price</th>
                        <th className="py-2 px-2 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {poLines.map((line, idx) => (
                        <tr key={idx}>
                          <td className="py-2 px-3">
                            <select
                              value={line.inventoryId}
                              onChange={(e) => handleUpdatePoLine(idx, 'inventoryId', Number(e.target.value))}
                              className="w-full px-2 py-1 bg-transparent border border-slate-200 rounded-lg text-xs"
                            >
                              {inventoryItems.map((inv) => (
                                <option key={inv.InventoryID} value={inv.InventoryID}>{inv.ProductName}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-3 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={line.qty}
                              onChange={(e) => handleUpdatePoLine(idx, 'qty', parseFloat(e.target.value) || 0)}
                              className="w-full px-2 py-1 text-right border border-slate-200 rounded-lg text-xs"
                            />
                          </td>
                          <td className="py-2 px-3 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={line.unitPrice}
                              onChange={(e) => handleUpdatePoLine(idx, 'unitPrice', parseFloat(e.target.value) || 0)}
                              className="w-full px-2 py-1 text-right border border-slate-200 rounded-lg text-xs"
                            />
                          </td>
                          <td className="py-2 px-2 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemovePoLine(idx)}
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

              <div className="border-t border-slate-200 pt-4 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsNewPoOpen(false)}
                  className="px-4 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingPo}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-sm"
                >
                  Issue Purchase Order
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PAY SUPPLIER BILL MODAL */}
      {payingBill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-6 max-w-md w-full space-y-4">
            <h4 className="text-base font-bold text-slate-800">Settle Supplier Bill {payingBill.BillNo}</h4>
            <p className="text-xs text-slate-500">Payable to {payingBill.SupplierName}</p>

            <div className="space-y-3 text-xs">
              <div className="flex justify-between p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500">Outstanding:</span>
                <span className="font-bold text-amber-600">{formatLKR(payingBill.Outstanding)}</span>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Payment Amount (LKR):</label>
                <input
                  type="number"
                  step="0.01"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setPayingBill(null)}
                className="px-3 py-1.5 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submittingPayment}
                onClick={handleSubmitPayment}
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-sm"
              >
                Record Payment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
