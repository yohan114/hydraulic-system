'use strict';

/**
 * Workshop Labour Bills Service
 *
 * Implements:
 *   - Auto-generation of labour bills based on 3 triggers (Amount >= 15000, Jobs >= 10, Days >= 15)
 *   - Multi-stage approval workflow:
 *       Workshop Certify -> OM Approve -> HO Accounts Approve -> Workshop Accounts Pay & Close
 *   - Rejections return bill to RETURNED with reason for workshop correction
 *   - Segregation of duties: self-approval prohibited across consecutive workflow stages
 *   - Tamper-proof hash-chained audit trail
 *   - Database-level immutability upon closure
 *   - AES-256-GCM sealed encryption of finalized bills
 *   - General Ledger integration: Dr 2200 (Accrued Labour) / Cr 1110 (Cash) or 1120 (Bank)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const connection = require('../db');
const money = require('../lib/money');
const ledgerSvc = require('./ledger');
const { ACC } = require('./glPosting');

const LABOUR_RE = /technical|crimp|weld|lathe/i;
const NON_LABOUR_RE = /fitting|rod|sundr/i;

function isLabourItem(desc) {
  const d = String(desc || '');
  return LABOUR_RE.test(d) && !NON_LABOUR_RE.test(d);
}

// Persisted encryption key for sealed labour bill archives (AES-256-GCM)
const KEY_FILE = path.join(__dirname, '..', '.labour-bill-key');

function loadOrCreateEncryptionKey() {
  if (process.env.LABOUR_BILL_SECRET) {
    return crypto.createHash('sha256').update(process.env.LABOUR_BILL_SECRET).digest();
  }
  try {
    if (fs.existsSync(KEY_FILE)) {
      const hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (hex && hex.length === 64) return Buffer.from(hex, 'hex');
    }
  } catch (_) {}
  const key = crypto.randomBytes(32);
  try { fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 }); } catch (_) {}
  return key;
}

const SEAL_KEY = loadOrCreateEncryptionKey();

function encryptSealedPayload(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SEAL_KEY, iv);
  const jsonStr = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(jsonStr, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const contentHash = crypto.createHash('sha256').update(jsonStr, 'utf8').digest('hex');
  return {
    sealedBlob: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    contentHash,
  };
}

function decryptSealedPayload(sealedBlob, ivHex, tagHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SEAL_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(sealedBlob, 'base64')), decipher.final()]);
  const jsonStr = decrypted.toString('utf8');
  return JSON.parse(jsonStr);
}

/** Compute deterministic SHA-256 hash of bill items */
function computeContentHash(items, totals) {
  const sorted = [...items].sort((a, b) => a.InvoiceID - b.InvoiceID);
  const canon = JSON.stringify({
    items: sorted.map((i) => ({
      invId: i.InvoiceID,
      invNo: i.InvoiceNo,
      tot: money.round2(i.LineTotal),
    })),
    total: money.round2(totals.totalAmount),
    count: totals.jobCount,
  });
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

/** Compute hash for chained approval log record */
function computeApprovalRecordHash(prevHash, seq, stage, action, actorId, at, signedHash, note) {
  const payload = `${prevHash}:${seq}:${stage}:${action}:${actorId}:${at}:${signedHash}:${note || ''}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Next bill number sequence, e.g. LB/2026/10/001 */
function nextBillNo(db) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `LB/${year}/${month}/`;
  const row = db.prepare('SELECT BillNo FROM LabourBills WHERE BillNo LIKE ? ORDER BY BillNo DESC LIMIT 1')
    .get(`${prefix}%`);
  let seq = 1;
  if (row) {
    const m = /(\d+)$/.exec(row.BillNo);
    if (m) seq = Number(m[1]) + 1;
  }
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

/**
 * Fetch all unbilled finalized labour items.
 * If opts.startDate is provided, only invoices with InvoiceDate >= opts.startDate are considered.
 */
function fetchUnbilledLabour(db, opts = {}) {
  const startDate = opts.startDate || null;
  let dateFilter = '';
  const params = [];
  if (startDate) {
    dateFilter = ' AND i.InvoiceDate >= ?';
    params.push(startDate);
  }

  const rows = db.prepare(`
    SELECT i.InvoiceID, i.InvoiceNo, i.InvoiceDate, i.BilledToName, i.IsInternal,
           ii.ItemDescription, ii.Qty, ii.Rate, ii.Amount
    FROM Invoices i
    JOIN InvoiceItems ii ON i.InvoiceID = ii.InvoiceID
    WHERE UPPER(i.Status) = 'FINALIZED'
      AND COALESCE(i.TechChargePaid, 0) = 0
      AND i.InvoiceID NOT IN (SELECT InvoiceID FROM LabourBillItems)
      ${dateFilter}
    ORDER BY i.InvoiceDate ASC, i.InvoiceID ASC
  `).all(...params);

  const invoicesMap = new Map();

  for (const r of rows) {
    if (!isLabourItem(r.ItemDescription)) continue;
    const invId = r.InvoiceID;
    if (!invoicesMap.has(invId)) {
      invoicesMap.set(invId, {
        InvoiceID: invId,
        InvoiceNo: r.InvoiceNo,
        InvoiceDate: String(r.InvoiceDate || '').slice(0, 10),
        Customer: r.BilledToName || 'Unknown',
        IsInternal: Boolean(r.IsInternal),
        Crimping: 0,
        Welding: 0,
        Lathe: 0,
        Technical: 0,
        LineTotal: 0,
      });
    }
    const inv = invoicesMap.get(invId);
    const amt = money.round2(r.Amount || (r.Qty * r.Rate));
    const desc = (r.ItemDescription || '').toLowerCase();

    if (desc.includes('crimp')) inv.Crimping = money.round2(inv.Crimping + amt);
    else if (desc.includes('weld')) inv.Welding = money.round2(inv.Welding + amt);
    else if (desc.includes('lathe')) inv.Lathe = money.round2(inv.Lathe + amt);
    else inv.Technical = money.round2(inv.Technical + amt);

    inv.LineTotal = money.round2(inv.LineTotal + amt);
  }

  const items = [...invoicesMap.values()].filter((i) => i.LineTotal > 0);
  const totalAmount = money.round2(items.reduce((sum, i) => sum + i.LineTotal, 0));
  const jobCount = items.length;

  let oldestDate = null;
  let daysSinceOldest = 0;
  if (items.length > 0) {
    oldestDate = items[0].InvoiceDate;
    if (oldestDate) {
      const now = new Date();
      const oldest = new Date(oldestDate);
      const diffTime = Math.max(0, now.getTime() - oldest.getTime());
      daysSinceOldest = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    }
  }

  return {
    items,
    totals: {
      totalAmount,
      jobCount,
      totalJobs: jobCount,
      oldestDate,
      daysSinceOldest,
      oldestDaysAge: daysSinceOldest,
    },
  };
}

/**
 * Check triggers and auto-generate Labour Bill if condition met
 */
async function evaluateTriggers(opts = {}) {
  const db = connection._db;
  const settings = db.prepare('SELECT * FROM LabourBillSettings WHERE SettingsID = 1').get() || {
    MinAmount: 15000, MinJobs: 10, MaxDays: 15, Enabled: 1, EffectiveDate: null,
  };

  if (!settings.Enabled && !opts.force) {
    return { triggered: false, reason: 'Labour bill automatic generation is disabled in settings.' };
  }

  const { items, totals } = fetchUnbilledLabour(db, { startDate: settings.EffectiveDate || null });
  if (items.length === 0) {
    return { triggered: false, reason: 'No unbilled workshop labour found.' };
  }

  const activeTriggers = [];
  if (totals.totalAmount >= settings.MinAmount) {
    activeTriggers.push(`Amount (Rs. ${totals.totalAmount.toLocaleString()} >= Rs. ${settings.MinAmount.toLocaleString()})`);
  }
  if (totals.jobCount >= settings.MinJobs) {
    activeTriggers.push(`Job Count (${totals.jobCount} >= ${settings.MinJobs} jobs)`);
  }
  if (totals.daysSinceOldest >= settings.MaxDays) {
    activeTriggers.push(`Aging (${totals.daysSinceOldest} days >= ${settings.MaxDays} days limit from ${totals.oldestDate})`);
  }

  if (activeTriggers.length === 0 && !opts.force) {
    return {
      triggered: false,
      current: totals,
      settings: { minAmount: settings.MinAmount, minJobs: settings.MinJobs, maxDays: settings.MaxDays },
      reason: `Thresholds not met: Rs. ${totals.totalAmount} / ${settings.MinAmount}, ${totals.jobCount} / ${settings.MinJobs} jobs, ${totals.daysSinceOldest} / ${settings.MaxDays} days.`,
    };
  }

  const triggerCodes = activeTriggers.map((t) => t.split(' ')[0].toUpperCase()).join(',') || 'MANUAL';
  const triggerReason = opts.force
    ? (opts.reason || 'Manually generated by authorized administrator.')
    : `Auto-generated: ${activeTriggers.join(' · ')}`;

  const billNo = nextBillNo(db);
  const periodFrom = items[0].InvoiceDate;
  const periodTo = items[items.length - 1].InvoiceDate;
  const contentHash = computeContentHash(items, totals);
  const actor = opts.actor || 'system';

  const genesisPrevHash = '0'.repeat(64);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const recordHash = computeApprovalRecordHash(
    genesisPrevHash, 1, 'SYSTEM', 'GENERATE', actor, now, contentHash, triggerReason
  );

  const billId = db.transaction(() => {
    const billInfo = db.prepare(`
      INSERT INTO LabourBills
      (BillNo, Status, TriggerCodes, TriggerReason, TotalAmount, JobCount,
       PeriodFrom, PeriodTo, ContentHash, CreatedAt, CreatedBy, UpdatedAt)
      VALUES (?, 'GENERATED', ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?, datetime('now','localtime'))
    `).run(billNo, triggerCodes, triggerReason, totals.totalAmount, totals.jobCount, periodFrom, periodTo, contentHash, actor);

    const newBillId = billInfo.lastInsertRowid;

    const insItem = db.prepare(`
      INSERT INTO LabourBillItems
      (BillID, InvoiceID, InvoiceNo, InvoiceDate, Customer, Crimping, Welding, Lathe, Technical, LineTotal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      insItem.run(
        newBillId, item.InvoiceID, item.InvoiceNo, item.InvoiceDate, item.Customer,
        item.Crimping, item.Welding, item.Lathe, item.Technical, item.LineTotal
      );
    }

    db.prepare(`
      INSERT INTO LabourBillApprovals
      (BillID, Seq, Stage, Action, ActorID, ActorRole, Note, StatusFrom, StatusTo, SignedHash, PrevHash, RecordHash, At)
      VALUES (?, 1, 'SYSTEM', 'GENERATE', ?, 'system', ?, 'NONE', 'GENERATED', ?, ?, ?, ?)
    `).run(newBillId, actor, triggerReason, contentHash, genesisPrevHash, recordHash, now);

    db.prepare('UPDATE LabourBillSettings SET LastCheckedAt = datetime(\'now\',\'localtime\') WHERE SettingsID = 1').run();

    return newBillId;
  })();

  return {
    triggered: true,
    billId,
    billNo,
    totalAmount: totals.totalAmount,
    jobCount: totals.jobCount,
    triggerReason,
  };
}

/**
 * Fetch bill details with items and approvals chain
 */
function getBillDetails(billId) {
  const db = connection._db;
  const bill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
  if (!bill) return null;

  const items = db.prepare('SELECT * FROM LabourBillItems WHERE BillID = ? ORDER BY InvoiceDate ASC, InvoiceID ASC').all(billId);
  const approvals = db.prepare('SELECT * FROM LabourBillApprovals WHERE BillID = ? ORDER BY Seq ASC').all(billId);

  const integrity = verifyBillIntegrity(billId);

  return {
    bill,
    items,
    approvals,
    integrity,
  };
}

/**
 * Verify hash-chain integrity of a bill and its approvals
 */
function verifyBillIntegrity(billId) {
  const db = connection._db;
  const bill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
  if (!bill) return { valid: false, error: 'Bill not found' };

  const items = db.prepare('SELECT * FROM LabourBillItems WHERE BillID = ? ORDER BY InvoiceDate ASC, InvoiceID ASC').all(billId);
  const approvals = db.prepare('SELECT * FROM LabourBillApprovals WHERE BillID = ? ORDER BY Seq ASC').all(billId);

  // 1. Verify content hash
  const currentContentHash = computeContentHash(items, { totalAmount: bill.TotalAmount, jobCount: bill.JobCount });
  if (currentContentHash !== bill.ContentHash) {
    return { valid: false, error: 'Content hash mismatch: bill items or totals have been modified outside system controls.' };
  }

  // 2. Verify hash chain on approvals
  let prev = '0'.repeat(64);
  for (const a of approvals) {
    if (a.PrevHash !== prev) {
      return { valid: false, error: `Chain broken at sequence ${a.Seq}: PrevHash does not match previous record.` };
    }
    const expected = computeApprovalRecordHash(
      a.PrevHash, a.Seq, a.Stage, a.Action, a.ActorID, a.At, a.SignedHash, a.Note
    );
    if (a.RecordHash !== expected) {
      return { valid: false, error: `Tampering detected at sequence ${a.Seq}: RecordHash invalid.` };
    }
    prev = a.RecordHash;
  }

  // 3. If closed, verify seal hash
  if (bill.Status === 'CLOSED' && bill.SealedBlob) {
    try {
      const payload = decryptSealedPayload(bill.SealedBlob, bill.SealIV, bill.SealTag);
      const jsonStr = JSON.stringify(payload);
      const actualHash = crypto.createHash('sha256').update(jsonStr, 'utf8').digest('hex');
      if (actualHash !== bill.SealHash) {
        return { valid: false, error: 'Sealed encrypted payload hash mismatch.' };
      }
    } catch (err) {
      return { valid: false, error: `Failed to decrypt sealed payload: ${err.message}` };
    }
  }

  return {
    valid: true,
    chainLength: approvals.length,
    lastRecordHash: prev,
    status: bill.Status,
  };
}

/**
 * Append an approval/action record to the bill chain
 */
function appendApproval(db, billId, stage, action, actorId, actorRole, note, statusFrom, statusTo, contentHash) {
  const last = db.prepare('SELECT Seq, RecordHash FROM LabourBillApprovals WHERE BillID = ? ORDER BY Seq DESC LIMIT 1').get(billId);
  const nextSeq = last ? last.Seq + 1 : 1;
  const prevHash = last ? last.RecordHash : '0'.repeat(64);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const recordHash = computeApprovalRecordHash(
    prevHash, nextSeq, stage, action, actorId, now, contentHash, note
  );

  db.prepare(`
    INSERT INTO LabourBillApprovals
    (BillID, Seq, Stage, Action, ActorID, ActorRole, Note, StatusFrom, StatusTo, SignedHash, PrevHash, RecordHash, At)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(billId, nextSeq, stage, action, actorId, actorRole, note || null, statusFrom, statusTo, contentHash, prevHash, recordHash, now);

  return { seq: nextSeq, recordHash };
}

/**
 * Remove a job from a draft labour bill (status GENERATED or RETURNED).
 * The removed invoice is returned to the unbilled pool and can be included in the next bill.
 */
async function removeJobFromBill(billId, itemIdOrInvoiceId, { actor, role, reason } = {}) {
  const db = connection._db;
  const bill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
  if (!bill) throw new Error('Labour bill not found');
  if (bill.Status !== 'GENERATED' && bill.Status !== 'RETURNED') {
    const err = new Error(`Cannot modify items of a bill in '${bill.Status}' status. Items can only be edited while GENERATED or RETURNED.`);
    err.code = 'BILL_ITEMS_LOCKED';
    err.httpStatus = 409;
    throw err;
  }

  const item = db.prepare(`
    SELECT * FROM LabourBillItems
    WHERE BillID = ? AND (BillItemID = ? OR InvoiceID = ?)
  `).get(billId, itemIdOrInvoiceId, itemIdOrInvoiceId);

  if (!item) {
    const err = new Error('Job item not found in this labour bill');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }

  const remainingCount = db.prepare('SELECT COUNT(*) AS c FROM LabourBillItems WHERE BillID = ?').get(billId).c;
  if (remainingCount <= 1) {
    const err = new Error('Cannot remove the only job in the bill. A labour bill must have at least one job. If this bill is not needed, return or discard it.');
    err.code = 'CANNOT_REMOVE_LAST_ITEM';
    err.httpStatus = 400;
    throw err;
  }

  return db.transaction(() => {
    // Delete item from bill (freeing it to return to unbilled pool)
    db.prepare('DELETE FROM LabourBillItems WHERE BillItemID = ?').run(item.BillItemID);

    // Recalculate remaining items and bill totals
    const newItems = db.prepare('SELECT * FROM LabourBillItems WHERE BillID = ? ORDER BY InvoiceDate ASC, InvoiceID ASC').all(billId);
    const newTotal = money.round2(newItems.reduce((sum, i) => sum + i.LineTotal, 0));
    const newCount = newItems.length;
    const newPeriodFrom = newItems[0].InvoiceDate;
    const newPeriodTo = newItems[newItems.length - 1].InvoiceDate;
    const newHash = computeContentHash(newItems, { totalAmount: newTotal, jobCount: newCount });

    db.prepare(`
      UPDATE LabourBills
      SET TotalAmount = ?, JobCount = ?, PeriodFrom = ?, PeriodTo = ?, ContentHash = ?, UpdatedAt = datetime('now','localtime')
      WHERE BillID = ?
    `).run(newTotal, newCount, newPeriodFrom, newPeriodTo, newHash, billId);

    const removalNote = `Removed job ${item.InvoiceNo} (Rs. ${item.LineTotal.toLocaleString()}) — deferred to next bill${reason ? ': ' + reason : ''}`;
    appendApproval(db, billId, 'WORKSHOP', 'REMOVE_JOB', actor || 'system', role || 'workshop_supervisor', removalNote, bill.Status, bill.Status, newHash);

    return {
      success: true,
      removedItem: item,
      bill: db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId),
      items: newItems,
      integrity: verifyBillIntegrity(billId),
    };
  })();
}

/**
 * Add an unbilled job to a draft labour bill (status GENERATED or RETURNED).
 */
async function addJobToBill(billId, invoiceId, { actor, role, reason } = {}) {
  const db = connection._db;
  const bill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
  if (!bill) throw new Error('Labour bill not found');
  if (bill.Status !== 'GENERATED' && bill.Status !== 'RETURNED') {
    const err = new Error(`Cannot modify items of a bill in '${bill.Status}' status. Items can only be edited while GENERATED or RETURNED.`);
    err.code = 'BILL_ITEMS_LOCKED';
    err.httpStatus = 409;
    throw err;
  }

  // Check if invoice already in this or another bill
  const existingItem = db.prepare('SELECT * FROM LabourBillItems WHERE InvoiceID = ?').get(invoiceId);
  if (existingItem) {
    const err = new Error(`Invoice is already included in Labour Bill ID ${existingItem.BillID}`);
    err.code = 'INVOICE_ALREADY_BILLED';
    err.httpStatus = 409;
    throw err;
  }

  // Fetch unbilled invoice
  const inv = db.prepare(`
    SELECT i.InvoiceID, i.InvoiceNo, i.InvoiceDate, i.BilledToName, i.Status, i.TechChargePaid
    FROM Invoices i
    WHERE i.InvoiceID = ?
  `).get(invoiceId);

  if (!inv) {
    const err = new Error('Invoice not found');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (String(inv.Status).toUpperCase() !== 'FINALIZED') {
    const err = new Error(`Invoice status is '${inv.Status}'. Only FINALIZED invoices can be added to a labour bill.`);
    err.code = 'INVOICE_NOT_FINALIZED';
    err.httpStatus = 400;
    throw err;
  }
  if (inv.TechChargePaid) {
    const err = new Error('Invoice labour charge is already marked paid.');
    err.code = 'ALREADY_PAID';
    err.httpStatus = 400;
    throw err;
  }

  // Calculate labour lines
  const lines = db.prepare('SELECT ItemDescription, Qty, Rate, Amount FROM InvoiceItems WHERE InvoiceID = ?').all(invoiceId);
  let crimp = 0, weld = 0, lathe = 0, tech = 0;
  for (const l of lines) {
    if (!isLabourItem(l.ItemDescription)) continue;
    const amt = money.round2(l.Amount || (l.Qty * l.Rate));
    const desc = (l.ItemDescription || '').toLowerCase();
    if (desc.includes('crimp')) crimp = money.round2(crimp + amt);
    else if (desc.includes('weld')) weld = money.round2(weld + amt);
    else if (desc.includes('lathe')) lathe = money.round2(lathe + amt);
    else tech = money.round2(tech + amt);
  }
  const lineTotal = money.round2(crimp + weld + lathe + tech);
  if (lineTotal <= 0) {
    const err = new Error('Invoice contains no workshop labour charges.');
    err.code = 'NO_LABOUR_CHARGES';
    err.httpStatus = 400;
    throw err;
  }

  return db.transaction(() => {
    db.prepare(`
      INSERT INTO LabourBillItems
      (BillID, InvoiceID, InvoiceNo, InvoiceDate, Customer, Crimping, Welding, Lathe, Technical, LineTotal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(billId, inv.InvoiceID, inv.InvoiceNo, String(inv.InvoiceDate || '').slice(0, 10), inv.BilledToName || 'Unknown', crimp, weld, lathe, tech, lineTotal);

    const newItems = db.prepare('SELECT * FROM LabourBillItems WHERE BillID = ? ORDER BY InvoiceDate ASC, InvoiceID ASC').all(billId);
    const newTotal = money.round2(newItems.reduce((sum, i) => sum + i.LineTotal, 0));
    const newCount = newItems.length;
    const newPeriodFrom = newItems[0].InvoiceDate;
    const newPeriodTo = newItems[newItems.length - 1].InvoiceDate;
    const newHash = computeContentHash(newItems, { totalAmount: newTotal, jobCount: newCount });

    db.prepare(`
      UPDATE LabourBills
      SET TotalAmount = ?, JobCount = ?, PeriodFrom = ?, PeriodTo = ?, ContentHash = ?, UpdatedAt = datetime('now','localtime')
      WHERE BillID = ?
    `).run(newTotal, newCount, newPeriodFrom, newPeriodTo, newHash, billId);

    const addNote = `Added job ${inv.InvoiceNo} (Rs. ${lineTotal.toLocaleString()})${reason ? ': ' + reason : ''}`;
    appendApproval(db, billId, 'WORKSHOP', 'ADD_JOB', actor || 'system', role || 'workshop_supervisor', addNote, bill.Status, bill.Status, newHash);

    return {
      success: true,
      addedItem: { InvoiceID: inv.InvoiceID, InvoiceNo: inv.InvoiceNo, LineTotal: lineTotal },
      bill: db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId),
      items: newItems,
      integrity: verifyBillIntegrity(billId),
    };
  })();
}

/**
 * Stage 1: Workshop Certify
 */
async function certifyBill(billId, { actor, role, note }) {
  const db = connection._db;
  const bill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
  if (!bill) throw new Error('Labour bill not found');
  if (bill.Status !== 'GENERATED' && bill.Status !== 'RETURNED') {
    throw new Error(`Bill cannot be certified from status '${bill.Status}'. Expected GENERATED or RETURNED.`);
  }

  return db.transaction(() => {
    db.prepare(`
      UPDATE LabourBills
      SET Status = 'CERTIFIED', UpdatedAt = datetime('now','localtime')
      WHERE BillID = ?
    `).run(billId);

    appendApproval(db, billId, 'WORKSHOP', 'CERTIFY', actor, role, note, bill.Status, 'CERTIFIED', bill.ContentHash);
    return getBillDetails(billId);
  })();
}

/**
 * Stage 2: Operations Manager Approve
 */
async function approveOmBill(billId, { actor, role, note }) {
  const db = connection._db;
  const bill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
  if (!bill) throw new Error('Labour bill not found');
  if (bill.Status !== 'CERTIFIED') {
    throw new Error(`Bill cannot be approved by OM from status '${bill.Status}'. Expected CERTIFIED.`);
  }

  // Segregation of duties: Check if actor was the one who certified
  const certifier = db.prepare("SELECT ActorID FROM LabourBillApprovals WHERE BillID = ? AND Action = 'CERTIFY' ORDER BY Seq DESC LIMIT 1").get(billId);
  if (certifier && certifier.ActorID === actor && role !== 'admin') {
    const err = new Error('Segregation of duties violation: You cannot approve a bill you certified.');
    err.code = 'SELF_APPROVAL_PROHIBITED';
    err.httpStatus = 403;
    throw err;
  }

  return db.transaction(() => {
    db.prepare(`
      UPDATE LabourBills
      SET Status = 'OM_APPROVED', UpdatedAt = datetime('now','localtime')
      WHERE BillID = ?
    `).run(billId);

    appendApproval(db, billId, 'OPERATIONS', 'APPROVE_OM', actor, role, note, 'CERTIFIED', 'OM_APPROVED', bill.ContentHash);
    return getBillDetails(billId);
  })();
}

/**
 * Stage 3: Head Office Accounts Approve
 */
async function approveHoBill(billId, { actor, role, note }) {
  const db = connection._db;
  const bill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
  if (!bill) throw new Error('Labour bill not found');
  if (bill.Status !== 'OM_APPROVED') {
    throw new Error(`Bill cannot be approved by HO from status '${bill.Status}'. Expected OM_APPROVED.`);
  }

  // Segregation of duties: Cannot be the same user who certified or OM-approved
  const prevActors = db.prepare("SELECT ActorID FROM LabourBillApprovals WHERE BillID = ? AND Action IN ('CERTIFY','APPROVE_OM')").all(billId);
  if (prevActors.some((a) => a.ActorID === actor) && role !== 'admin') {
    const err = new Error('Segregation of duties violation: You cannot grant final HO approval for a bill you certified or approved at OM stage.');
    err.code = 'SELF_APPROVAL_PROHIBITED';
    err.httpStatus = 403;
    throw err;
  }

  return db.transaction(() => {
    db.prepare(`
      UPDATE LabourBills
      SET Status = 'HO_APPROVED', UpdatedAt = datetime('now','localtime')
      WHERE BillID = ?
    `).run(billId);

    appendApproval(db, billId, 'HEAD_OFFICE', 'APPROVE_HO', actor, role, note, 'OM_APPROVED', 'HO_APPROVED', bill.ContentHash);
    return getBillDetails(billId);
  })();
}

/**
 * Reject bill (by OM or HO) -> RETURNED with mandatory note
 */
async function rejectBill(billId, { actor, role, reason }) {
  if (!reason || !reason.trim()) {
    throw new Error('A detailed reason is mandatory when rejecting or returning a labour bill.');
  }
  const db = connection._db;
  const bill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
  if (!bill) throw new Error('Labour bill not found');
  if (bill.Status !== 'CERTIFIED' && bill.Status !== 'OM_APPROVED') {
    throw new Error(`Bill cannot be rejected from status '${bill.Status}'.`);
  }

  return db.transaction(() => {
    db.prepare(`
      UPDATE LabourBills
      SET Status = 'RETURNED', UpdatedAt = datetime('now','localtime')
      WHERE BillID = ?
    `).run(billId);

    appendApproval(db, billId, role.toUpperCase(), 'REJECT', actor, role, reason.trim(), bill.Status, 'RETURNED', bill.ContentHash);
    return getBillDetails(billId);
  })();
}

/**
 * Stage 4: Workshop Accounts Pay & Close & Seal
 */
async function payAndCloseBill(billId, { actor, role, paymentDate, method, paymentRef, paidTo, notes }) {
  const db = connection._db;
  const bill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
  if (!bill) throw new Error('Labour bill not found');
  if (bill.Status !== 'HO_APPROVED') {
    throw new Error(`Bill cannot be paid from status '${bill.Status}'. Expected HO_APPROVED.`);
  }

  const payDate = String(paymentDate || new Date().toISOString()).slice(0, 10);
  const payMethod = method || 'Cash';
  const payRef = paymentRef || bill.BillNo;
  const payee = paidTo || 'Workshop Crew';

  return db.transaction(() => {
    // 1. Create LabourPayments record
    const payPeriod = payDate.slice(0, 7);
    const noteText = `LABOUR_BILL#${bill.BillNo} · Paid to ${payee} (${payRef})`;
    const lpInfo = db.prepare(`
      INSERT INTO LabourPayments
      (WorkerID, Amount, PayPeriod, PaymentDate, Method, Notes, CreatedAt)
      VALUES (NULL, ?, ?, ?, ?, ?, datetime('now','localtime'))
    `).run(bill.TotalAmount, payPeriod, payDate, payMethod, noteText);

    const labourPaymentId = lpInfo.lastInsertRowid;

    // 2. Post to General Ledger: Dr 2200 Accrued Labour, Cr Cash/Bank
    const cashAccount = /bank|transfer|cheque|card/i.test(payMethod) ? ACC.BANK : ACC.CASH;
    ledgerSvc.postEntry({
      date: payDate,
      memo: `Settlement of workshop labour bill ${bill.BillNo}`,
      sourceType: 'labour-bill',
      sourceID: billId,
      postedBy: actor,
      lines: [
        { accountCode: '2200', debit: bill.TotalAmount, memo: `Clearing accrued liability for ${bill.BillNo}` },
        { accountCode: cashAccount, credit: bill.TotalAmount, memo: `Payment via ${payMethod}` },
      ],
    });

    // 3. Update all invoices in the bill to TechChargePaid = 1
    const items = db.prepare('SELECT InvoiceID FROM LabourBillItems WHERE BillID = ?').all(billId);
    const invoiceIds = items.map((i) => i.InvoiceID);
    if (invoiceIds.length > 0) {
      db.prepare(`
        UPDATE Invoices
        SET TechChargePaid = 1
        WHERE InvoiceID IN (${invoiceIds.map(() => '?').join(',')})
      `).run(...invoiceIds);
    }

    // 4. Record payment & approval in chain before sealing
    appendApproval(
      db, billId, 'WORKSHOP_ACCOUNTS', 'PAY_AND_CLOSE', actor, role,
      `Paid ${money.round2(bill.TotalAmount)} via ${payMethod}. Ref: ${payRef}. Notes: ${notes || 'none'}`,
      'HO_APPROVED', 'CLOSED', bill.ContentHash
    );

    // 5. Seal & Encrypt the final archive payload
    const fullBill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
    const fullItems = db.prepare('SELECT * FROM LabourBillItems WHERE BillID = ?').all(billId);
    const fullApprovals = db.prepare('SELECT * FROM LabourBillApprovals WHERE BillID = ? ORDER BY Seq ASC').all(billId);

    const sealPayload = {
      bill: { ...fullBill, Status: 'CLOSED', PaidAt: payDate },
      items: fullItems,
      approvals: fullApprovals,
      payment: {
        labourPaymentId,
        paymentDate: payDate,
        method: payMethod,
        ref: payRef,
        paidTo: payee,
      },
      sealedAt: new Date().toISOString(),
      sealedBy: actor,
    };

    const encrypted = encryptSealedPayload(sealPayload);

    // 6. Update LabourBills to CLOSED with sealed cryptographic data
    db.prepare(`
      UPDATE LabourBills
      SET Status = 'CLOSED',
          PaidAt = ?,
          PaymentDate = ?,
          PaymentMethod = ?,
          PaymentRef = ?,
          PaidTo = ?,
          LabourPaymentID = ?,
          ClosedAt = datetime('now','localtime'),
          ClosedBy = ?,
          SealedBlob = ?,
          SealIV = ?,
          SealTag = ?,
          SealHash = ?,
          UpdatedAt = datetime('now','localtime')
      WHERE BillID = ?
    `).run(
      payDate, payDate, payMethod, payRef, payee, labourPaymentId, actor,
      encrypted.sealedBlob, encrypted.iv, encrypted.tag, encrypted.contentHash, billId
    );

    return getBillDetails(billId);
  })();
}

/**
 * Open and decrypt sealed bill payload with audit logging
 */
function openSealedBill(billId, { actor, role, ip }) {
  const db = connection._db;
  const bill = db.prepare('SELECT * FROM LabourBills WHERE BillID = ?').get(billId);
  if (!bill) throw new Error('Labour bill not found');
  if (bill.Status !== 'CLOSED' || !bill.SealedBlob) {
    throw new Error('This bill has not been sealed and closed yet.');
  }

  // Security audit log entry for opening sealed encrypted archive
  try {
    db.prepare(`
      INSERT INTO SecurityAuditLog
      (At, ActorID, ActorRole, Action, Resource, IPAddress, RowCount, Details)
      VALUES (datetime('now','localtime'), ?, ?, 'DECRYPT_SEALED_BILL', ?, ?, 1, ?)
    `).run(actor || 'unknown', role || 'unknown', `LabourBills:${bill.BillNo}`, ip || 'internal', `Decrypted sealed archive for closed bill ${bill.BillNo}`);
  } catch (_) {}

  const decrypted = decryptSealedPayload(bill.SealedBlob, bill.SealIV, bill.SealTag);
  return {
    billNo: bill.BillNo,
    sealHash: bill.SealHash,
    payload: decrypted,
    verified: true,
  };
}

/**
 * List bills with summary counts
 */
function listBills(query = {}) {
  const db = connection._db;
  let sql = `
    SELECT
      b.*,
      COALESCE(SUM(lbi.Crimping), 0) AS CrimpingTotal,
      COALESCE(SUM(lbi.Welding), 0) AS WeldingTotal,
      COALESCE(SUM(lbi.Lathe), 0) AS LatheTotal,
      COALESCE(SUM(lbi.Technical), 0) AS TechTotal
    FROM LabourBills b
    LEFT JOIN LabourBillItems lbi ON b.BillID = lbi.BillID
    WHERE 1=1
  `;
  const params = [];

  if (query.status && query.status !== 'all') {
    sql += ' AND b.Status = ?';
    params.push(query.status);
  }

  sql += ' GROUP BY b.BillID ORDER BY b.BillID DESC';
  const bills = db.prepare(sql).all(...params);

  const counts = db.prepare(`
    SELECT Status, COUNT(*) AS cnt FROM LabourBills GROUP BY Status
  `).all().reduce((acc, r) => {
    acc[r.Status] = r.cnt;
    return acc;
  }, {});

  const settings = getSettings();
  const unbilledActive = fetchUnbilledLabour(db, { startDate: settings?.EffectiveDate || null });
  const unbilledAll = fetchUnbilledLabour(db, { startDate: null });

  return {
    bills,
    counts: {
      generated: counts.GENERATED || 0,
      certified: counts.CERTIFIED || 0,
      omApproved: counts.OM_APPROVED || 0,
      hoApproved: counts.HO_APPROVED || 0,
      returned: counts.RETURNED || 0,
      closed: counts.CLOSED || 0,
      total: bills.length,
    },
    unbilled: unbilledActive.totals,
    unbilledAll: unbilledAll.totals,
    unbilledItems: unbilledAll.items,
    activeUnbilledItems: unbilledActive.items,
    effectiveDate: settings?.EffectiveDate || null,
  };
}

/**
 * Settings GET and PUT
 */
function getSettings() {
  const db = connection._db;
  return db.prepare('SELECT * FROM LabourBillSettings WHERE SettingsID = 1').get();
}

function updateSettings(patch, actor = 'admin') {
  const db = connection._db;
  const current = getSettings();
  const minAmount = patch.minAmount != null ? money.num(patch.minAmount) : current.MinAmount;
  const minJobs = patch.minJobs != null ? parseInt(patch.minJobs, 10) : current.MinJobs;
  const maxDays = patch.maxDays != null ? parseInt(patch.maxDays, 10) : current.MaxDays;
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : current.Enabled;
  const effectiveDate = patch.effectiveDate !== undefined ? patch.effectiveDate : current.EffectiveDate;

  db.prepare(`
    UPDATE LabourBillSettings
    SET MinAmount = ?, MinJobs = ?, MaxDays = ?, Enabled = ?, EffectiveDate = ?,
        UpdatedAt = datetime('now','localtime'), UpdatedBy = ?
    WHERE SettingsID = 1
  `).run(minAmount, minJobs, maxDays, enabled, effectiveDate, actor);

  return getSettings();
}

module.exports = {
  fetchUnbilledLabour,
  evaluateTriggers,
  getBillDetails,
  verifyBillIntegrity,
  removeJobFromBill,
  addJobToBill,
  certifyBill,
  approveOmBill,
  approveHoBill,
  rejectBill,
  payAndCloseBill,
  openSealedBill,
  listBills,
  getSettings,
  updateSettings,
};
