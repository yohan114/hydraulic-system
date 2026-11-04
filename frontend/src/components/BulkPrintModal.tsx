import React, { useState } from 'react';
import { Invoice } from '../types/models';
import { formatLKR, formatDate, round2 } from '../utils/format';
import {
  Printer,
  X,
  ExternalLink,
  Layers,
  Loader2,
  FileText,
  Building2,
  Phone,
  Mail,
  MapPin,
} from 'lucide-react';

interface BulkPrintModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedIds: number[];
  invoices: Invoice[];
  loading: boolean;
  documentView: 'CUSTOMER' | 'COMPANY_DETAILED';
  onDocumentViewChange: (view: 'CUSTOMER' | 'COMPANY_DETAILED') => void;
}

function getCustomerDesc(desc?: string, unit?: string): string {
  const d = String(desc || '');
  const dl = d.toLowerCase();
  const u = String(unit || '').toLowerCase();
  if (dl.includes('crimping')) return d;
  if (dl.includes('welding')) return 'Welding charge';
  if (dl.includes('lathe')) return d;
  if (dl.includes('technical charge')) return 'Service charge';
  if (u === 'm' || u === 'ft') return 'Hydraulic hose supply & fitting';
  if (dl.includes('bsp straight') || d.includes('22611')) return 'Union fitting (BSP Straight)';
  if (dl.includes('bsp 90') || d.includes('22692') || dl.includes('elbow')) return 'Elbow fitting (BSP 90°)';
  if (dl.includes('ferrule') || d.includes('00210') || dl.includes('2sn')) return 'Ferrule fitting';
  if (dl.includes('flange')) return 'Flange fitting';
  if (dl.includes('union')) return 'Union fitting';
  const i = d.indexOf(' - ');
  return (i >= 0 ? d.slice(0, i) : d).trim();
}

export const BulkPrintModal: React.FC<BulkPrintModalProps> = ({
  isOpen,
  onClose,
  selectedIds,
  invoices,
  loading,
  documentView,
  onDocumentViewChange,
}) => {
  const [activeJumpIndex, setActiveJumpIndex] = useState<number>(0);

  if (!isOpen) return null;

  const totalSum = invoices.reduce((acc, inv) => acc + (inv.GrandTotal || 0), 0);
  const isDetailed = documentView === 'COMPANY_DETAILED';

  const handlePrint = () => {
    window.print();
  };

  const handleOpenPrintTab = () => {
    const idsStr = selectedIds.join(',');
    const url = `/api/invoices/bulk-html?ids=${encodeURIComponent(idsStr)}&view=${encodeURIComponent(documentView)}`;
    window.open(url, '_blank');
  };

  const scrollToInvoice = (idx: number) => {
    setActiveJumpIndex(idx);
    const el = document.getElementById(`bulk-invoice-sheet-${idx}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-900/80 backdrop-blur-sm overflow-hidden">
      {/* Dynamic Print-Only Styles for Bulk Invoices */}
      <style>{`
        @media print {
          @page {
            size: A4;
            margin: 8mm 10mm;
          }
          body * {
            visibility: hidden !important;
          }
          #bulk-print-modal-area, #bulk-print-modal-area * {
            visibility: visible !important;
          }
          #bulk-print-modal-area {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            background: white !important;
          }
          .bulk-invoice-sheet {
            page-break-after: always !important;
            break-after: page !important;
            margin: 0 !important;
            padding: 20px 0 !important;
            box-shadow: none !important;
            border: none !important;
            min-height: 270mm !important;
          }
          .bulk-invoice-sheet:last-child {
            page-break-after: auto !important;
            break-after: auto !important;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>

      <div className="bg-slate-100 rounded-2xl shadow-2xl border border-slate-300 w-full max-w-5xl max-h-[96vh] flex flex-col overflow-hidden">
        {/* Header / Action Bar (hidden when printing) */}
        <div className="no-print px-5 py-3.5 bg-slate-900 text-white border-b border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600 rounded-xl text-white">
              <Printer className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">
                  Bulk Print Finalized Invoices
                </h3>
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-indigo-500/30 text-indigo-300 border border-indigo-400/30">
                  {invoices.length} Selected
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Total Billing: <strong className="text-emerald-400 font-semibold">{formatLKR(totalSum)}</strong> &bull; Sequentially formatted for multi-page printing
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto justify-end">
            {/* Document View Switcher */}
            <div className="flex items-center bg-slate-800 p-1 rounded-xl text-xs font-semibold">
              <button
                type="button"
                onClick={() => onDocumentViewChange('CUSTOMER')}
                className={`px-3 py-1.5 rounded-lg transition ${
                  documentView === 'CUSTOMER'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Customer Copy
              </button>
              <button
                type="button"
                onClick={() => onDocumentViewChange('COMPANY_DETAILED')}
                className={`px-3 py-1.5 rounded-lg transition ${
                  documentView === 'COMPANY_DETAILED'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Company Detailed Copy
              </button>
            </div>

            <button
              type="button"
              onClick={handlePrint}
              disabled={loading || invoices.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold shadow-md transition cursor-pointer"
            >
              <Printer className="w-4 h-4" /> Print All ({invoices.length})
            </button>

            <button
              type="button"
              onClick={handleOpenPrintTab}
              disabled={loading || invoices.length === 0}
              title="Open full print document in separate tab"
              className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 hover:text-white rounded-xl text-xs font-semibold border border-slate-700 transition cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open Tab
            </button>

            <button
              type="button"
              onClick={onClose}
              title="Close modal"
              className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Quick jump navigation toolbar (hidden when printing) */}
        {!loading && invoices.length > 1 && (
          <div className="no-print px-5 py-2 bg-slate-800/90 text-slate-300 border-b border-slate-700/80 flex items-center gap-2 overflow-x-auto text-xs shrink-0">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1 shrink-0">
              <Layers className="w-3 h-3 text-indigo-400" /> Jump To:
            </span>
            <div className="flex items-center gap-1.5">
              {invoices.map((inv, idx) => (
                <button
                  key={inv.InvoiceID}
                  type="button"
                  onClick={() => scrollToInvoice(idx)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-mono font-semibold transition shrink-0 ${
                    activeJumpIndex === idx
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'bg-slate-700/60 hover:bg-slate-700 text-slate-300'
                  }`}
                >
                  #{idx + 1}: {inv.InvoiceNo}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Scrollable Printable Container */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-6 bg-slate-200/70">
          {loading ? (
            <div className="py-24 text-center text-slate-500">
              <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mx-auto mb-3" />
              <p className="font-semibold text-slate-700 text-sm">
                Loading {selectedIds.length} invoice details for bulk print...
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Fetching customer line items, tax computations, and general ledger metadata.
              </p>
            </div>
          ) : invoices.length === 0 ? (
            <div className="py-24 text-center text-slate-500">
              <FileText className="w-12 h-12 text-slate-400 mx-auto mb-3" />
              <p className="font-bold text-slate-700 text-base">No invoices selected</p>
              <p className="text-xs text-slate-400 mt-1">Please select one or more finalized invoices to print.</p>
            </div>
          ) : (
            <div id="bulk-print-modal-area" className="space-y-8 max-w-4xl mx-auto">
              {invoices.map((inv, index) => {
                const isInternal = Boolean(inv.IsInternal);
                const copyBadge = isInternal
                  ? 'INTERNAL SERVICE / COST STATEMENT — Own Fleet'
                  : isDetailed
                  ? 'COMPANY DETAILED COPY — Internal Review'
                  : 'OUTSIDE BILL — Customer Copy';

                const lineItems = inv.items || [];
                const calcItemsCost = lineItems.reduce((acc, it: any) => {
                  const qty = Number(it.Qty) || 0;
                  const unitCost = Number(it.UnitCostAtBilling != null ? it.UnitCostAtBilling : it.Cost) || 0;
                  return acc + qty * unitCost;
                }, 0);

                return (
                  <div
                    key={inv.InvoiceID}
                    id={`bulk-invoice-sheet-${index}`}
                    className="bulk-invoice-sheet bg-white rounded-xl shadow-lg border border-slate-300 p-6 sm:p-8 relative transition"
                  >
                    {/* Visual Page Break Header for Screen Preview */}
                    <div className="no-print mb-4 pb-2 border-b border-slate-200 flex items-center justify-between text-xs text-slate-500">
                      <span className="font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                        <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 font-bold inline-flex items-center justify-center text-[11px]">
                          {index + 1}
                        </span>
                        Invoice {index + 1} of {invoices.length} &bull; Ref: <strong className="text-slate-900">{inv.InvoiceNo}</strong>
                      </span>
                      <span className="text-slate-400 font-mono text-[11px]">
                        Printed sequentially with automatic page breaks
                      </span>
                    </div>

                    {/* Invoice Header */}
                    <div className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <Building2 className="w-6 h-6 text-indigo-600 shrink-0" />
                          <h1 className="text-xl font-black text-slate-900 tracking-tight">
                            Edward and Christie
                          </h1>
                        </div>
                        <div className="inline-block mt-1.5 bg-slate-900 text-white text-[10px] font-bold uppercase tracking-widest px-2.5 py-0.5 rounded">
                          &bull; HYDRAULIC HOSE REPAIR
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="text-2xl font-black tracking-wide text-slate-900">
                          IN<span className="text-blue-600">V</span>OICE
                        </div>
                        <p className="text-xs font-semibold text-slate-800 mt-0.5">
                          Ref: <strong className="font-mono text-sm">{inv.InvoiceNo}</strong>
                        </p>
                        <p className="text-xs text-slate-600">
                          Date: <span className="font-medium">{formatDate(inv.InvoiceDate)}</span>
                        </p>
                        <div
                          className={`inline-block mt-1 px-2.5 py-0.5 rounded text-[9px] font-bold tracking-wider uppercase ${
                            documentView === 'CUSTOMER'
                              ? 'bg-blue-600 text-white'
                              : 'bg-slate-900 text-white'
                          }`}
                        >
                          {copyBadge}
                        </div>
                      </div>
                    </div>

                    {/* Parties Section */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 my-5 text-xs">
                      <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                          Billed To
                        </h4>
                        <p className="font-bold text-slate-900 text-sm">{inv.BilledToName || 'Walk-in Customer'}</p>
                        {inv.BilledToAddress && (
                          <p className="text-slate-600 mt-0.5 whitespace-pre-line">{inv.BilledToAddress}</p>
                        )}
                        {inv.PONo && (
                          <p className="text-slate-500 mt-1 font-mono text-[11px]">PO No: {inv.PONo}</p>
                        )}
                      </div>

                      {inv.DeliveredToName ? (
                        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                          <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                            Delivered To
                          </h4>
                          <p className="font-bold text-slate-900 text-sm">{inv.DeliveredToName}</p>
                          {inv.DeliveredToAddress && (
                            <p className="text-slate-600 mt-0.5 whitespace-pre-line">{inv.DeliveredToAddress}</p>
                          )}
                          {inv.DeliveryDate && (
                            <p className="text-slate-500 mt-1 text-[11px]">Delivery Date: {formatDate(inv.DeliveryDate)}</p>
                          )}
                        </div>
                      ) : (
                        <div className="bg-slate-50/50 border border-dashed border-slate-200 rounded-xl p-3 flex flex-col justify-center">
                          <span className="text-[11px] text-slate-400 font-medium">Counter delivery / Workshop collection</span>
                        </div>
                      )}
                    </div>

                    {/* Line Items Table */}
                    <div className="border border-slate-200 rounded-xl overflow-hidden my-4">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-900 text-white font-semibold text-[11px]">
                          <tr>
                            <th className="py-2 px-3 text-center w-10">#</th>
                            <th className="py-2 px-3">Description</th>
                            <th className="py-2 px-3 text-center w-24">Qty</th>
                            <th className="py-2 px-3 text-right w-28">Rate (LKR)</th>
                            {isDetailed && (
                              <>
                                <th className="py-2 px-3 text-right w-24">Unit Cost</th>
                                <th className="py-2 px-3 text-right w-24">Line Cost</th>
                              </>
                            )}
                            <th className="py-2 px-3 text-right w-28">Amount (LKR)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-slate-800">
                          {lineItems.length === 0 ? (
                            <tr>
                              <td
                                colSpan={isDetailed ? 7 : 5}
                                className="py-6 text-center text-slate-400"
                              >
                                No line items recorded
                              </td>
                            </tr>
                          ) : (
                            lineItems.map((item: any, i: number) => {
                              const desc =
                                documentView === 'CUSTOMER'
                                  ? getCustomerDesc(item.ItemDescription || item.ProductName, item.Unit)
                                  : item.ItemDescription || item.ProductName || 'Hydraulic Service';
                              const qty = Number(item.Qty) || 0;
                              const rate = Number(item.Rate) || 0;
                              const unitCost = Number(item.UnitCostAtBilling != null ? item.UnitCostAtBilling : item.Cost) || 0;
                              const lineCost = round2(qty * unitCost);
                              const lineAmt = round2(item.Amount != null ? Number(item.Amount) : qty * rate);

                              return (
                                <tr key={item.InvoiceItemID || i} className="hover:bg-slate-50/50">
                                  <td className="py-2 px-3 text-center text-slate-400 font-mono text-[11px]">
                                    {i + 1}
                                  </td>
                                  <td className="py-2 px-3 font-medium text-slate-900">
                                    {desc}
                                  </td>
                                  <td className="py-2 px-3 text-center whitespace-nowrap">
                                    {qty} {item.Unit ? <span className="text-slate-500 text-[11px]">{item.Unit}</span> : ''}
                                  </td>
                                  <td className="py-2 px-3 text-right font-mono font-medium">
                                    {formatLKR(rate)}
                                  </td>
                                  {isDetailed && (
                                    <>
                                      <td className="py-2 px-3 text-right font-mono text-slate-500">
                                        {formatLKR(unitCost)}
                                      </td>
                                      <td className="py-2 px-3 text-right font-mono text-slate-500">
                                        {formatLKR(lineCost)}
                                      </td>
                                    </>
                                  )}
                                  <td className="py-2 px-3 text-right font-mono font-bold text-slate-900">
                                    {formatLKR(lineAmt)}
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>

                    {/* Totals Section */}
                    <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mt-4">
                      <div className="flex-1 text-xs text-slate-500">
                        {inv.Notes ? (
                          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
                            <strong className="text-slate-700 block mb-0.5">Notes:</strong>
                            <p className="whitespace-pre-line">{inv.Notes}</p>
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-400 italic">
                            Warranty: 30 days against fabrication workmanship defects.
                          </div>
                        )}
                      </div>

                      <div className="w-full sm:w-72 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs">
                        <div className="space-y-1.5">
                          <div className="flex justify-between text-slate-600">
                            <span>Sub Total:</span>
                            <span className="font-mono font-semibold text-slate-800">{formatLKR(inv.SubTotal)}</span>
                          </div>
                          {Boolean(inv.Discount) && (
                            <div className="flex justify-between text-emerald-600">
                              <span>Discount:</span>
                              <span className="font-mono font-semibold">-{formatLKR(inv.Discount)}</span>
                            </div>
                          )}
                          {Boolean(inv.RoundOff) && (
                            <div className="flex justify-between text-slate-500">
                              <span>Round Off:</span>
                              <span className="font-mono">{formatLKR(inv.RoundOff)}</span>
                            </div>
                          )}
                          <div className="pt-2 border-t-2 border-slate-900 flex justify-between items-center text-sm font-bold text-slate-900">
                            <span>Total Due (LKR):</span>
                            <span className="font-mono text-base font-extrabold text-indigo-700">
                              {formatLKR(inv.GrandTotal)}
                            </span>
                          </div>
                          {isDetailed && (
                            <div className="pt-2 border-t border-slate-200 space-y-1 text-[11px]">
                              <div className="flex justify-between text-slate-500">
                                <span>Total Landed Cost:</span>
                                <span className="font-mono">{formatLKR(calcItemsCost)}</span>
                              </div>
                              <div className="flex justify-between text-emerald-700 font-semibold">
                                <span>Gross Margin:</span>
                                <span className="font-mono">{formatLKR(inv.GrandTotal - calcItemsCost)}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* System Signature Block */}
                    <div className="mt-8 pt-4 border-t border-slate-100 flex items-center justify-between text-xs">
                      <div className="text-[11px] text-slate-400">
                        Generated by AI Studio Hydraulic ERP &bull; Verified Entry
                      </div>
                      <div className="text-center w-52">
                        <div className="border-b border-dashed border-slate-400 h-8 mb-1 flex items-end justify-center">
                          <span className="text-[10px] font-semibold text-indigo-700 tracking-wide font-mono">
                            SYSTEM GENERATED
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-500 font-medium">Authorized Signatory</span>
                      </div>
                    </div>

                    {/* Official Company Footer */}
                    <div className="mt-6 pt-3 border-t-2 border-slate-900 bg-slate-900 text-white rounded-lg p-3 flex flex-wrap items-center justify-between gap-3 text-[10px]">
                      <div>
                        <strong className="text-white text-xs block">Edward and Christie</strong>
                        <span className="text-slate-400">Hydraulic Hose Repair Workshop</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-300">
                        <Phone className="w-3 h-3 text-blue-400" />
                        <span>+94-11 2812990, 2812991</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-300">
                        <Mail className="w-3 h-3 text-blue-400" />
                        <span>edchrist@sltnet.lk</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-300">
                        <MapPin className="w-3 h-3 text-blue-400" />
                        <span>No. 64/9, Nawala Rd, Nugegoda</span>
                      </div>
                      <div className="text-right font-mono">
                        <span className="text-blue-400 font-bold block">VAT REG</span>
                        <span className="text-slate-200">174042756-7000</span>
                      </div>
                    </div>

                    {/* Screen Page Break Separator between invoices */}
                    {index < invoices.length - 1 && (
                      <div className="no-print my-8 flex items-center gap-3 text-slate-400 font-mono text-xs">
                        <div className="h-px bg-slate-300 flex-1 border-dashed border-b" />
                        <span className="px-3 py-1 bg-white border border-slate-300 rounded-full text-[11px] font-semibold text-slate-500 shadow-2xs">
                          PAGE BREAK &mdash; NEXT INVOICE #{index + 2}
                        </span>
                        <div className="h-px bg-slate-300 flex-1 border-dashed border-b" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Bottom Footer (hidden when printing) */}
        <div className="no-print px-6 py-3.5 bg-white border-t border-slate-200 flex items-center justify-between shrink-0">
          <div className="text-xs text-slate-500 font-medium">
            Ready to print <strong>{invoices.length}</strong> finalized invoice{invoices.length === 1 ? '' : 's'}. Total billing: <strong className="text-slate-800">{formatLKR(totalSum)}</strong>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-slate-200 hover:bg-slate-50 rounded-xl text-xs font-semibold text-slate-700 transition cursor-pointer"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={loading || invoices.length === 0}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold shadow-sm transition flex items-center gap-1.5 cursor-pointer"
            >
              <Printer className="w-4 h-4" /> Print Invoices
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
