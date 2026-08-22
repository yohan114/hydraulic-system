'use strict';

/**
 * Period controls: depreciation, stock takes, receivables ageing and year-end
 * close. The things an accountant does that nobody thinks about until an audit.
 *
 *   Depreciation   Dr Depreciation            Cr Accumulated Depreciation
 *   Stock shortage Dr Stock Adjustments       Cr Inventory
 *   Stock overage  Dr Inventory               Cr Stock Adjustments
 *   Year-end close Dr each income account     Cr each expense account
 *                  … the net to Retained Earnings
 *
 * Each of these can be run at most once for a given period or document, because
 * the failure mode is not "it errors" — it is "the books quietly double".
 */

const connection = require('../db');
const money = require('../lib/money');
const ledger = require('../lib/ledger');
const assets = require('../lib/assets');
const costing = require('../lib/costing');
const ledgerSvc = require('./ledger');
const { ACC } = require('./glPosting');

const PLANT = '1510';
const ACCUM_DEP = '1590';
const DEPRECIATION = '6400';
const STOCK_ADJUST = '5900';
const RETAINED = '3200';

class ControlError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ControlError';
    this.httpStatus = status;
  }
}

// ------------------------------------------------------------ fixed assets

function listAssets() {
  return connection._db.prepare(`
    SELECT a.*, s.Name AS SupplierName,
           ROUND(a.Cost - a.Accumulated, 2) AS NetBookValue,
           (SELECT MAX(Period) FROM DepreciationEntries d WHERE d.AssetID = a.AssetID) AS LastPeriod
    FROM FixedAssets a LEFT JOIN Suppliers s ON s.SupplierID = a.SupplierID
    ORDER BY a.Status, a.Name`).all();
}

/**
 * Register an asset. Posts its cost into Plant & Machinery unless it is being
 * brought in as an opening balance already owned.
 */
function createAsset(a) {
  const db = connection._db;
  const name = String(a.name || '').trim();
  if (!name) throw new ControlError('Asset name is required');
  const cost = money.round2(a.cost);
  if (!(cost > 0)) throw new ControlError('Asset cost must be greater than zero');
  const inService = String(a.inServiceFrom || a.purchaseDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inService)) throw new ControlError('A valid in-service date is required');

  // The POSTING date can differ from the in-service date: a machine bought in
  // January and carried into books that open in May belongs on the ledger at the
  // opening date, with the months already depreciated brought forward. Dating it
  // at acquisition instead would make a balance sheet as at February show
  // depreciation that had not happened yet.
  //
  // Validated BEFORE the row is written — otherwise a bad date leaves an asset
  // that never reached the ledger but still depreciates.
  const postingDate = String(a.postingDate || inService).slice(0, 10);
  if (a.postingDate && !/^\d{4}-\d{2}-\d{2}$/.test(postingDate)) {
    throw new ControlError('Posting date must be YYYY-MM-DD');
  }

  const assetId = db.prepare(`INSERT INTO FixedAssets
    (Code, Name, Category, SupplierID, PurchaseDate, InServiceFrom, Cost, Residual, LifeMonths,
     Method, Accumulated, Status, Notes, CreatedAt, UpdatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'straight-line', ?, 'active', ?, datetime('now','localtime'), datetime('now','localtime'))`)
    .run(a.code || null, name, a.category || null, a.supplierId || null,
      a.purchaseDate || inService, inService, cost, money.round2(a.residual),
      Math.floor(money.num(a.lifeMonths)), money.round2(a.accumulated), a.notes || null)
    .lastInsertRowid;

  // An asset already owned before the books opened is brought in against
  // opening equity; a new purchase is paid for.
  let posting = null;
  if (a.postCost !== false) {
    const contra = a.opening ? ACC.OPENING_EQUITY : (a.paidFrom === 'bank' ? ACC.BANK : ACC.AP);
    posting = ledgerSvc.postEntry({
      date: postingDate,
      memo: `Fixed asset — ${name}`,
      sourceType: 'asset', sourceID: assetId,
      postedBy: a.postedBy,
      allowClosedPeriod: !!a.opening,
      lines: [
        { accountCode: PLANT, debit: cost, memo: name },
        { accountCode: contra, credit: cost, supplierId: a.supplierId || null },
      ],
    });
    // Depreciation already taken before the books opened, if any.
    const accumulated = money.round2(a.accumulated);
    if (accumulated > 0) {
      ledgerSvc.postEntry({
        date: postingDate,
        memo: `Accumulated depreciation brought forward — ${name}`,
        sourceType: 'asset-opening-dep', sourceID: assetId,
        postedBy: a.postedBy, allowClosedPeriod: true,
        lines: [
          { accountCode: ACC.OPENING_EQUITY, debit: accumulated },
          { accountCode: ACCUM_DEP, credit: accumulated, memo: name },
        ],
      });
    }
  }

  return { assetId, posting };
}

/**
 * Charge depreciation for a period across every active asset.
 * Safe to re-run: an asset already charged for that period is skipped.
 *
 * @param {string} period `YYYY-MM`
 */
function runDepreciation(period, opts = {}) {
  const db = connection._db;
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw new ControlError('Period must be YYYY-MM');

  const rows = db.prepare(`
    SELECT a.* FROM FixedAssets a
    WHERE a.Status = 'active'
      AND NOT EXISTS (SELECT 1 FROM DepreciationEntries d WHERE d.AssetID = a.AssetID AND d.Period = ?)`).all(period);

  const run = assets.runPeriod(rows.map((r) => ({
    assetId: r.AssetID, name: r.Name, cost: r.Cost, residual: r.Residual,
    lifeMonths: r.LifeMonths, inServiceFrom: r.InServiceFrom, accumulated: r.Accumulated,
  })), period);

  if (!run.total) return { period, total: 0, charged: [], skipped: run.skipped, posting: null };

  // Last day of the period, which is when a monthly charge belongs.
  const [y, m] = period.split('-').map(Number);
  const date = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  const posting = ledgerSvc.postEntry({
    date,
    memo: `Depreciation for ${period}`,
    sourceType: 'depreciation', sourceID: period,
    postedBy: opts.postedBy,
    allowClosedPeriod: opts.allowClosedPeriod,
    lines: [
      { accountCode: DEPRECIATION, debit: run.total, memo: `${run.lines.length} asset(s)` },
      { accountCode: ACCUM_DEP, credit: run.total },
    ],
  });

  db.transaction(() => {
    const ins = db.prepare(`INSERT INTO DepreciationEntries
      (AssetID, Period, Charge, AccumulatedAfter, JournalID, CreatedAt)
      VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))`);
    const upd = db.prepare("UPDATE FixedAssets SET Accumulated = ?, UpdatedAt = datetime('now','localtime') WHERE AssetID = ?");
    for (const l of run.lines) {
      ins.run(l.assetId, period, l.charge, l.accumulatedAfter, posting.journalId);
      upd.run(l.accumulatedAfter, l.assetId);
    }
  })();

  return { period, total: run.total, charged: run.lines, skipped: run.skipped, posting };
}

// -------------------------------------------------------------- stock take

function stockValuation() {
  const items = connection._db.prepare(`
    SELECT InventoryID, UniqueID, ProductName, Category, Unit, Qty, COALESCE(Cost, 0) AS Cost
    FROM Inventory ORDER BY Category, ProductName`).all();
  const valued = assets.stockValue(items.map((i) => ({
    inventoryId: i.InventoryID, uniqueId: i.UniqueID, name: i.ProductName,
    category: i.Category, unit: i.Unit, qty: i.Qty, cost: i.Cost,
  })));

  // The ledger's view of stock, so a divergence is visible rather than assumed.
  const ledgerStock = money.round2(connection._db.prepare(`
    SELECT COALESCE(SUM(l.Debit), 0) - COALESCE(SUM(l.Credit), 0) AS v
    FROM JournalLines l JOIN Accounts a ON a.AccountID = l.AccountID WHERE a.Code = ?`)
    .get(ACC.STOCK).v);

  return {
    ...valued,
    items,
    ledgerStock,
    difference: money.round2(valued.total - ledgerStock),
    reconciled: money.round2(valued.total - ledgerStock) === 0,
  };
}

/** Open a count sheet with the current system quantities frozen onto it. */
function openStockTake(p = {}) {
  const db = connection._db;
  const takeDate = String(p.takeDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const year = new Date().getFullYear();
  const last = db.prepare("SELECT TakeNo FROM StockTakes WHERE TakeNo LIKE ? ORDER BY TakeNo DESC LIMIT 1").get(`ST/${year}/%`);
  const seq = last ? Number(/(\d+)$/.exec(last.TakeNo)[1]) + 1 : 1;
  const takeNo = `ST/${year}/${String(seq).padStart(4, '0')}`;

  return db.transaction(() => {
    const takeId = db.prepare(`INSERT INTO StockTakes (TakeNo, TakeDate, Status, CountedBy, Notes, CreatedAt)
      VALUES (?, ?, 'draft', ?, ?, datetime('now','localtime'))`)
      .run(takeNo, takeDate, p.countedBy || null, p.notes || null).lastInsertRowid;

    const where = p.category ? 'WHERE Category = ?' : '';
    const items = db.prepare(`SELECT InventoryID, Qty, COALESCE(Cost,0) AS Cost FROM Inventory ${where}`)
      .all(...(p.category ? [p.category] : []));
    const ins = db.prepare(`INSERT INTO StockTakeItems (StockTakeID, InventoryID, SystemQty, CountedQty, Cost)
      VALUES (?, ?, ?, ?, ?)`);
    // Counted defaults to the system figure, so an untouched line is "agrees".
    for (const i of items) ins.run(takeId, i.InventoryID, i.Qty, i.Qty, i.Cost);
    return { takeId, takeNo, lines: items.length };
  })();
}

function setStockTakeCounts(takeId, counts) {
  const db = connection._db;
  const take = db.prepare('SELECT * FROM StockTakes WHERE StockTakeID = ?').get(takeId);
  if (!take) throw new ControlError(`Stock take ${takeId} not found`, 404);
  if (take.Status === 'posted') throw new ControlError('That stock take has already been posted');

  const upd = db.prepare('UPDATE StockTakeItems SET CountedQty = ?, Notes = ? WHERE StockTakeItemID = ? AND StockTakeID = ?');
  db.transaction(() => {
    for (const c of counts || []) upd.run(money.num(c.countedQty), c.notes || null, c.stockTakeItemId, takeId);
  })();
}

function stockTakeDetail(takeId) {
  const db = connection._db;
  const take = db.prepare('SELECT * FROM StockTakes WHERE StockTakeID = ?').get(takeId);
  if (!take) throw new ControlError(`Stock take ${takeId} not found`, 404);
  const rows = db.prepare(`
    SELECT t.*, i.ProductName, i.UniqueID, i.Unit, i.Category
    FROM StockTakeItems t JOIN Inventory i ON i.InventoryID = t.InventoryID
    WHERE t.StockTakeID = ? ORDER BY i.Category, i.ProductName`).all(takeId);

  const variance = assets.stockTakeVariance(rows.map((r) => ({
    stockTakeItemId: r.StockTakeItemID, inventoryId: r.InventoryID,
    name: r.ProductName, uniqueId: r.UniqueID, unit: r.Unit, category: r.Category,
    systemQty: r.SystemQty, countedQty: r.CountedQty, cost: r.Cost, notes: r.Notes,
  })));
  return { ...take, ...variance };
}

/**
 * Post a count: adjust the stock to what was actually there and put the
 * difference through Stock Adjustments. Lines that agree are left alone.
 */
function postStockTake(takeId, opts = {}) {
  const db = connection._db;
  const detail = stockTakeDetail(takeId);
  if (detail.Status === 'posted') throw new ControlError('That stock take has already been posted');

  const changed = detail.lines.filter((l) => l.qtyDiff !== 0);
  if (!changed.length) {
    db.prepare("UPDATE StockTakes SET Status = 'posted', PostedAt = datetime('now','localtime') WHERE StockTakeID = ?").run(takeId);
    return { takeId, adjusted: 0, totalVariance: 0, posting: null };
  }

  const takeDate = String(detail.TakeDate).slice(0, 10);
  const net = detail.totalVariance;
  const lines = net >= 0
    ? [{ accountCode: ACC.STOCK, debit: net, memo: `Stock take ${detail.TakeNo}` },
      { accountCode: STOCK_ADJUST, credit: net }]
    : [{ accountCode: STOCK_ADJUST, debit: -net, memo: `Stock take ${detail.TakeNo}` },
      { accountCode: ACC.STOCK, credit: -net }];

  const posting = net === 0 ? null : ledgerSvc.postEntry({
    date: takeDate,
    memo: `Stock take ${detail.TakeNo} — ${changed.length} line(s) adjusted`,
    sourceType: 'stock-take', sourceID: takeId,
    postedBy: opts.postedBy,
    allowClosedPeriod: opts.allowClosedPeriod,
    lines,
  });

  db.transaction(() => {
    const updInv = db.prepare("UPDATE Inventory SET Qty = ?, UpdatedAt = datetime('now','localtime') WHERE InventoryID = ?");
    const move = db.prepare(`INSERT INTO StockMovements
      (InventoryID, InvoiceID, MovementType, QtyChange, PreviousQty, NewQty, MovementDate, Notes)
      VALUES (?, NULL, 'ADJUST', ?, ?, ?, ?, ?)`);
    for (const l of changed) {
      updInv.run(l.countedQty, l.inventoryId);
      move.run(l.inventoryId, l.qtyDiff, l.systemQty, l.countedQty, takeDate, `Stock take ${detail.TakeNo}`);
    }
    db.prepare("UPDATE StockTakes SET Status = 'posted', PostedAt = datetime('now','localtime'), JournalID = ? WHERE StockTakeID = ?")
      .run(posting ? posting.journalId : null, takeId);
  })();

  return { takeId, adjusted: changed.length, totalVariance: net, shortages: detail.shortages, overages: detail.overages, posting };
}

// ---------------------------------------------------------- ageing & close

/** What customers owe, bucketed by age. */
function receivablesAgeing(asAt) {
  const ref = String(asAt || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const rows = connection._db.prepare(`
    SELECT i.InvoiceID, i.InvoiceNo, i.InvoiceDate, i.GrandTotal, i.AmountPaid,
           c.Name AS CustomerName, c.CustomerID, c.PaymentTermsDays
    FROM Invoices i LEFT JOIN Customers c ON c.CustomerID = i.CustomerID
    WHERE i.Status = 'Finalized' AND i.IsInternal = 0
      AND ROUND(i.GrandTotal - COALESCE(i.AmountPaid, 0), 2) > 0
    ORDER BY i.InvoiceDate`).all();

  const invoices = rows.map((r) => {
    const due = new Date(`${String(r.InvoiceDate).slice(0, 10)}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + (r.PaymentTermsDays || 0));
    return {
      ...r,
      Outstanding: money.round2(r.GrandTotal - money.num(r.AmountPaid)),
      Due: due.toISOString().slice(0, 10),
    };
  });

  return {
    asAt: ref,
    invoices,
    buckets: costing.ageing(invoices.map((i) => ({ date: i.Due, amount: i.Outstanding })), ref),
  };
}

/**
 * Year-end close: sweep every income, cost and expense account to zero and put
 * the net into Retained Earnings. Balance-sheet accounts carry forward.
 *
 * @param {string} throughDate `YYYY-MM-DD` — the last day of the year
 */
function closeYear(throughDate, opts = {}) {
  const date = String(throughDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ControlError('A valid closing date is required');

  const tb = ledger.trialBalance(ledgerSvc.accountTotals({ to: date }));
  const pl = ledger.profitAndLoss(tb.accounts);
  const movers = [...pl.income, ...pl.costOfSales, ...pl.expenses].filter((a) => a.balance !== 0);
  if (!movers.length) throw new ControlError('There is nothing to close for that period');

  // Reverse each account's own balance, then let Retained Earnings take the net.
  const lines = movers.map((a) => (ledger.isDebitPositive(a.type)
    ? { accountCode: a.code, credit: Math.abs(a.balance), memo: 'Year-end close' }
    : { accountCode: a.code, debit: Math.abs(a.balance), memo: 'Year-end close' }));

  const net = pl.netProfit;
  if (net > 0) lines.push({ accountCode: RETAINED, credit: net, memo: 'Profit for the year' });
  else if (net < 0) lines.push({ accountCode: RETAINED, debit: -net, memo: 'Loss for the year' });

  const posting = ledgerSvc.postEntry({
    date,
    memo: `Year-end close through ${date}`,
    sourceType: 'year-end', sourceID: date,
    postedBy: opts.postedBy,
    allowClosedPeriod: true,
    lines,
  });

  return { throughDate: date, netProfit: net, accountsClosed: movers.length, posting };
}

module.exports = {
  ControlError, PLANT, ACCUM_DEP, DEPRECIATION, STOCK_ADJUST, RETAINED,
  listAssets, createAsset, runDepreciation,
  stockValuation, openStockTake, setStockTakeCounts, stockTakeDetail, postStockTake,
  receivablesAgeing, closeYear,
};
