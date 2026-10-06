import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { InventoryItem, Supplier } from '../types/models';
import { formatLKR, round2 } from '../utils/format';
import {
  Package,
  Plus,
  Search,
  RefreshCw,
  AlertTriangle,
  TrendingDown,
  Edit2,
  Trash2,
  ShoppingCart,
  Truck,
  X,
  Loader2,
  Lock
} from 'lucide-react';

export const InventoryPage: React.FC = () => {
  const { isManager, isAdmin, canWrite } = useAuth();

  // Active Tab: 'stock' | 'suppliers'
  const [activeTab, setActiveTab] = useState<'stock' | 'suppliers'>('stock');

  // Stock state
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [search, setSearch] = useState<string>('');
  const [lowStockOnly, setLowStockOnly] = useState<boolean>(false);

  // Suppliers state
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [suppliersLoading, setSuppliersLoading] = useState<boolean>(false);

  // Add / Edit Product Modal
  const [isProductModalOpen, setIsProductModalOpen] = useState<boolean>(false);
  const [submittingProduct, setSubmittingProduct] = useState<boolean>(false);
  const [editProductId, setEditProductId] = useState<number | null>(null);

  // Form Fields
  const [uniqueId, setUniqueId] = useState<string>('');
  const [productName, setProductName] = useState<string>('');
  const [specificationCode, setSpecificationCode] = useState<string>('');
  const [size, setSize] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [length, setLength] = useState<number>(0);
  const [qty, setQty] = useState<number>(0);
  const [unit, setUnit] = useState<string>('pcs');
  const [price, setPrice] = useState<number>(0);
  const [cost, setCost] = useState<number>(0);
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [reorderLevel, setReorderLevel] = useState<number>(5);

  // Purchase / Restock Modal
  const [purchaseItem, setPurchaseItem] = useState<InventoryItem | null>(null);
  const [purchaseQty, setPurchaseQty] = useState<number>(10);
  const [purchaseCost, setPurchaseCost] = useState<number>(0);
  const [purchaseSubmitting, setPurchaseSubmitting] = useState<boolean>(false);

  // Load Inventory
  const loadInventory = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<InventoryItem[]>('/inventory');
      setInventory(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load Suppliers
  const loadSuppliers = useCallback(async () => {
    setSuppliersLoading(true);
    try {
      const data = await apiRequest<Supplier[]>('/suppliers');
      setSuppliers(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
    } finally {
      setSuppliersLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInventory();
    loadSuppliers();
  }, [loadInventory, loadSuppliers]);

  // Open Create Product Modal
  const handleOpenAddProduct = () => {
    setEditProductId(null);
    setUniqueId(`SKU-${Date.now().toString().slice(-6)}`);
    setProductName('');
    setSpecificationCode('');
    setSize('');
    setDescription('');
    setLength(0);
    setQty(0);
    setUnit('pcs');
    setPrice(0);
    setCost(0);
    setSupplierId('');
    setReorderLevel(5);
    setIsProductModalOpen(true);
  };

  // Open Edit Product Modal
  const handleOpenEditProduct = (item: InventoryItem) => {
    setEditProductId(item.InventoryID);
    setUniqueId(item.UniqueID);
    setProductName(item.ProductName);
    setSpecificationCode(item.SpecificationCode || '');
    setSize(item.Size || '');
    setDescription(item.Description || '');
    setLength(item.Length || 0);
    setQty(item.Qty);
    setUnit(item.Unit || 'pcs');
    setPrice(item.Price || 0);
    setCost(item.Cost || 0);
    setSupplierId(item.SupplierID || '');
    setReorderLevel(item.ReorderLevel ?? 5);
    setIsProductModalOpen(true);
  };

  // Submit Product Form
  const handleSubmitProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productName.trim()) {
      alert('Product Name is required.');
      return;
    }
    setSubmittingProduct(true);
    try {
      const payload: any = {
        uniqueId: uniqueId.trim(),
        productName: productName.trim(),
        specificationCode: specificationCode.trim(),
        size: size.trim(),
        description: description.trim(),
        length: Number(length) || 0,
        qty: Number(qty) || 0,
        unit: unit.trim() || 'pcs',
        price: Number(price) || 0,
        supplierId: supplierId || null,
        reorderLevel: Number(reorderLevel) || 5,
      };

      if (isAdmin) {
        payload.cost = Number(cost) || 0;
      }

      if (editProductId) {
        await apiRequest(`/inventory/${editProductId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        alert('Product updated successfully.');
      } else {
        await apiRequest('/inventory', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        alert('Product registered successfully.');
      }

      setIsProductModalOpen(false);
      await loadInventory();
    } catch (err: any) {
      alert(err.message || 'Error saving product');
    } finally {
      setSubmittingProduct(false);
    }
  };

  // Delete Product (Admin only)
  const handleDeleteProduct = async (id: number, name: string) => {
    if (!window.confirm(`Permanently remove ${name} from inventory? This requires admin authorization.`)) return;
    try {
      await apiRequest(`/inventory/${id}`, { method: 'DELETE' });
      alert('Product deleted.');
      await loadInventory();
    } catch (err: any) {
      alert(err.message || 'Could not delete product');
    }
  };

  // Open Restock Modal
  const handleOpenRestock = (item: InventoryItem) => {
    setPurchaseItem(item);
    setPurchaseQty(10);
    setPurchaseCost(item.Cost || 0);
  };

  // Submit Restock / Quick Purchase
  const handleSubmitRestock = async () => {
    if (!purchaseItem || purchaseQty <= 0) return;
    setPurchaseSubmitting(true);
    try {
      // In this system, restock updates the Qty directly via PUT or purchase inflow
      const newQty = purchaseItem.Qty + purchaseQty;
      await apiRequest(`/inventory/${purchaseItem.InventoryID}`, {
        method: 'PUT',
        body: JSON.stringify({
          productName: purchaseItem.ProductName,
          specificationCode: purchaseItem.SpecificationCode,
          size: purchaseItem.Size,
          description: purchaseItem.Description,
          length: purchaseItem.Length,
          qty: newQty,
          unit: purchaseItem.Unit,
          price: purchaseItem.Price,
          cost: purchaseCost > 0 ? purchaseCost : purchaseItem.Cost,
          supplierId: purchaseItem.SupplierID,
          reorderLevel: purchaseItem.ReorderLevel,
        }),
      });
      alert(`Restocked ${purchaseQty} ${purchaseItem.Unit} for ${purchaseItem.ProductName}! New Stock: ${newQty}`);
      setPurchaseItem(null);
      await loadInventory();
    } catch (err: any) {
      alert(err.message || 'Error recording restock');
    } finally {
      setPurchaseSubmitting(false);
    }
  };

  // Statistics
  const stats = useMemo(() => {
    let lowCount = 0;
    let outCount = 0;
    inventory.forEach((i) => {
      const reorder = i.ReorderLevel ?? 5;
      if (i.Qty <= 0) outCount++;
      else if (i.Qty <= reorder) lowCount++;
    });
    return {
      total: inventory.length,
      low: lowCount,
      out: outCount,
      suppliersCount: suppliers.length,
    };
  }, [inventory, suppliers]);

  // Filtered inventory
  const filteredInventory = useMemo(() => {
    return inventory.filter((item) => {
      const q = search.toLowerCase().trim();
      const matchesSearch =
        !q ||
        item.UniqueID.toLowerCase().includes(q) ||
        item.ProductName.toLowerCase().includes(q) ||
        (item.SpecificationCode && item.SpecificationCode.toLowerCase().includes(q)) ||
        (item.SupplierName && item.SupplierName.toLowerCase().includes(q));

      const reorder = item.ReorderLevel ?? 5;
      const matchesLowStock = !lowStockOnly || item.Qty <= reorder;

      return matchesSearch && matchesLowStock;
    });
  }, [inventory, search, lowStockOnly]);

  return (
    <div className="space-y-6">
      {/* Top Banner Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Catalog SKUs</p>
          <p className="text-2xl font-bold text-slate-800 mt-2">{stats.total}</p>
          <p className="text-xs text-slate-400 mt-1">Active inventory lines</p>
        </div>

        <div className={`rounded-2xl border p-5 shadow-sm ${stats.low > 0 ? 'bg-amber-50/40 border-amber-200' : 'bg-white border-slate-200/80'}`}>
          <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-amber-500" /> Low Stock Reorder
          </p>
          <p className="text-2xl font-bold text-amber-700 mt-2">{stats.low}</p>
          <p className="text-xs text-amber-600 mt-1">Below minimum buffer</p>
        </div>

        <div className={`rounded-2xl border p-5 shadow-sm ${stats.out > 0 ? 'bg-rose-50/40 border-rose-200' : 'bg-white border-slate-200/80'}`}>
          <p className="text-xs font-semibold text-rose-700 uppercase tracking-wider flex items-center gap-1.5">
            <TrendingDown className="w-4 h-4 text-rose-500" /> Out of Stock
          </p>
          <p className="text-2xl font-bold text-rose-700 mt-2">{stats.out}</p>
          <p className="text-xs text-rose-600 mt-1">Zero quantity on shelf</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Suppliers Linked</p>
          <p className="text-2xl font-bold text-indigo-600 mt-2">{stats.suppliersCount}</p>
          <p className="text-xs text-slate-400 mt-1">Registered vendors</p>
        </div>
      </div>

      {/* Tabs & Action Bar */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2 bg-slate-100 p-1.5 rounded-2xl w-full sm:w-auto">
          <button
            onClick={() => setActiveTab('stock')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'stock'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Package className="w-3.5 h-3.5" /> Stock Inventory
          </button>
          <button
            onClick={() => setActiveTab('suppliers')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'suppliers'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Truck className="w-3.5 h-3.5" /> Suppliers Master
          </button>
        </div>

        {activeTab === 'stock' && canWrite && (
          <button
            onClick={handleOpenAddProduct}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold shadow-sm transition w-full sm:w-auto justify-center"
          >
            <Plus className="w-4 h-4" /> Add Product SKU
          </button>
        )}
      </div>

      {/* TAB 1: STOCK INVENTORY */}
      {activeTab === 'stock' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-sm flex flex-col sm:flex-row gap-4 items-center justify-between">
            <div className="relative flex-1 max-w-md w-full">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search SKU, product name, specification, supplier..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>

            <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
              <button
                onClick={() => setLowStockOnly(!lowStockOnly)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition flex items-center gap-1.5 ${
                  lowStockOnly
                    ? 'bg-amber-500 text-white border-amber-600 shadow-sm'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5" /> Low Stock Only
              </button>

              <button
                onClick={loadInventory}
                title="Refresh Inventory"
                className="p-2 border border-slate-200 hover:bg-slate-50 rounded-xl text-slate-600 transition"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <tr>
                    <th className="py-3.5 px-4">SKU / Code</th>
                    <th className="py-3.5 px-4">Product Name & Spec</th>
                    <th className="py-3.5 px-4">Size</th>
                    <th className="py-3.5 px-4 text-center">In Stock</th>
                    <th className="py-3.5 px-4 text-right">Selling Rate</th>
                    <th className="py-3.5 px-4 text-right">Landed Cost</th>
                    <th className="py-3.5 px-4">Supplier</th>
                    <th className="py-3.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  {loading ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-400">
                        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                        Loading stock catalog...
                      </td>
                    </tr>
                  ) : filteredInventory.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-12 text-center text-slate-400">
                        <Package className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                        No inventory products match your filter.
                      </td>
                    </tr>
                  ) : (
                    filteredInventory.map((item) => {
                      const reorder = item.ReorderLevel ?? 5;
                      const isLow = item.Qty <= reorder;
                      const isZero = item.Qty <= 0;
                      return (
                        <tr key={item.InventoryID} className="hover:bg-slate-50/60 transition">
                          <td className="py-3.5 px-4 font-mono font-semibold text-slate-800 text-xs">
                            {item.UniqueID}
                          </td>
                          <td className="py-3.5 px-4">
                            <p className="font-bold text-slate-900">{item.ProductName}</p>
                            {item.SpecificationCode && (
                              <p className="text-xs text-slate-500 font-mono">
                                {item.SpecificationCode}
                              </p>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-slate-600 whitespace-nowrap">
                            {item.Size || '—'}
                          </td>
                          <td className="py-3.5 px-4 text-center whitespace-nowrap">
                            <span
                              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${
                                isZero
                                  ? 'bg-rose-100 text-rose-700 border border-rose-200'
                                  : isLow
                                  ? 'bg-amber-100 text-amber-700 border border-amber-200'
                                  : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              }`}
                            >
                              {item.Qty} {item.Unit}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-right font-bold text-slate-900 whitespace-nowrap">
                            {formatLKR(item.Price)}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            {isManager || isAdmin ? (
                              <span className="font-semibold text-slate-600">
                                {formatLKR(item.Cost || 0)}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs text-slate-400" title="Wholesale cost masked for Cashier">
                                <Lock className="w-3 h-3" /> Masked
                              </span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-slate-600 text-xs">
                            {item.SupplierName || '—'}
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5">
                              {canWrite && (
                                <button
                                  onClick={() => handleOpenRestock(item)}
                                  title="Quick Restock"
                                  className="p-1.5 hover:bg-emerald-50 text-emerald-600 rounded-lg transition"
                                >
                                  <ShoppingCart className="w-4 h-4" />
                                </button>
                              )}
                              {canWrite && (
                                <button
                                  onClick={() => handleOpenEditProduct(item)}
                                  title="Edit Product"
                                  className="p-1.5 hover:bg-slate-100 text-slate-600 rounded-lg transition"
                                >
                                  <Edit2 className="w-4 h-4" />
                                </button>
                              )}
                              {isAdmin && (
                                <button
                                  onClick={() => handleDeleteProduct(item.InventoryID, item.ProductName)}
                                  title="Delete Product"
                                  className="p-1.5 hover:bg-rose-50 text-rose-500 rounded-lg transition"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
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
        </div>
      )}

      {/* TAB 2: SUPPLIERS MASTER */}
      {activeTab === 'suppliers' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50/75 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                <tr>
                  <th className="py-3.5 px-4">Supplier Name</th>
                  <th className="py-3.5 px-4">Contact Person</th>
                  <th className="py-3.5 px-4">Phone</th>
                  <th className="py-3.5 px-4">Email</th>
                  <th className="py-3.5 px-4 text-center">Catalog Products</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {suppliersLoading ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-slate-400">
                      <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                      Loading suppliers...
                    </td>
                  </tr>
                ) : suppliers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-slate-400">
                      <Truck className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                      No suppliers registered yet.
                    </td>
                  </tr>
                ) : (
                  suppliers.map((s) => (
                    <tr key={s.SupplierID} className="hover:bg-slate-50/60 transition">
                      <td className="py-3.5 px-4 font-bold text-slate-800">{s.Name}</td>
                      <td className="py-3.5 px-4 text-slate-600">{s.ContactPerson || '—'}</td>
                      <td className="py-3.5 px-4 text-slate-600">{s.Phone || '—'}</td>
                      <td className="py-3.5 px-4 text-slate-600">{s.Email || '—'}</td>
                      <td className="py-3.5 px-4 text-center">
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                          {s.ItemCount || 0} items
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ADD / EDIT PRODUCT MODAL */}
      {isProductModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-50 text-indigo-600 rounded-xl">
                  <Package className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-800">
                    {editProductId ? 'Edit Product SKU' : 'Register New Inventory Product'}
                  </h3>
                  <p className="text-xs text-slate-500 font-mono">
                    SKU Code: {uniqueId}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsProductModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Scrollable Form */}
            <form onSubmit={handleSubmitProduct} className="flex-1 overflow-y-auto p-6 space-y-4 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Unique SKU / ID *</label>
                  <input
                    type="text"
                    required
                    disabled={!!editProductId}
                    value={uniqueId}
                    onChange={(e) => setUniqueId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 disabled:opacity-60"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Product Name *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 2-Wire Hydraulic Hose R2AT"
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Specification Code</label>
                  <input
                    type="text"
                    placeholder="e.g. 1/2-R2AT-BSP"
                    value={specificationCode}
                    onChange={(e) => setSpecificationCode(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Size</label>
                  <input
                    type="text"
                    placeholder="e.g. 1/2 inch"
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Stock Quantity</label>
                  <input
                    type="number"
                    step="0.01"
                    value={qty}
                    onChange={(e) => setQty(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Measurement Unit</label>
                  <input
                    type="text"
                    placeholder="e.g. m, pcs, end"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Selling Bill Price (LKR) *</label>
                  <input
                    type="number"
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                {isAdmin && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Landed Wholesale Cost (LKR)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={cost}
                      onChange={(e) => setCost(parseFloat(e.target.value) || 0)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Supplier</label>
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  >
                    <option value="">— None / Local Stock —</option>
                    {suppliers.map((s) => (
                      <option key={s.SupplierID} value={s.SupplierID}>{s.Name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Low Stock Warning Level</label>
                  <input
                    type="number"
                    value={reorderLevel}
                    onChange={(e) => setReorderLevel(parseInt(e.target.value, 10) || 5)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Description / Notes</label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Additional product details, applications, rating..."
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                />
              </div>

              {/* Actions */}
              <div className="border-t border-slate-200 pt-4 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsProductModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 hover:bg-slate-100 rounded-xl text-xs font-semibold text-slate-600 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingProduct}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-sm transition"
                >
                  {editProductId ? 'Update Product' : 'Register Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* QUICK RESTOCK MODAL */}
      {purchaseItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-6 max-w-md w-full space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
                <ShoppingCart className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-base font-bold text-slate-800">Quick Stock Inflow</h4>
                <p className="text-xs text-slate-500">{purchaseItem.ProductName}</p>
              </div>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex justify-between p-3 bg-slate-50 rounded-xl border border-slate-200">
                <span className="text-slate-500">Current Stock:</span>
                <span className="font-bold text-slate-800">{purchaseItem.Qty} {purchaseItem.Unit}</span>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Quantity Received:</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={purchaseQty}
                  onChange={(e) => setPurchaseQty(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                />
              </div>

              {isAdmin && (
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Batch Landed Unit Cost (LKR):</label>
                  <input
                    type="number"
                    step="0.01"
                    value={purchaseCost}
                    onChange={(e) => setPurchaseCost(parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                  />
                </div>
              )}

              <p className="text-[11px] text-slate-500">
                New on-hand total will be <span className="font-bold text-emerald-600">{round2(purchaseItem.Qty + purchaseQty)} {purchaseItem.Unit}</span>.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setPurchaseItem(null)}
                className="px-3 py-1.5 border border-slate-200 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={purchaseSubmitting}
                onClick={handleSubmitRestock}
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-sm transition"
              >
                Confirm Restock
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
