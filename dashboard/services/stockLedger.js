'use strict';

/**
 * Stock ledger — the single place that mutates `Inventory.Qty` and writes a
 * `StockMovements` audit row (IN / OUT / ADJUST).
 *
 * Callers pass a signed `qtyChange` (negative = OUT/deduction, positive =
 * IN/restore). The helper reads the current quantity, applies the change,
 * updates the row and records the movement, returning `{ previousQty, newQty }`
 * (or null if the inventory item no longer exists). It runs inside whatever
 * mutex critical section the caller already holds.
 */

const connection = require('../db');
const money = require('../lib/money');
const sql = require('../lib/sql');

async function recordMovement({ inventoryId, invoiceId = null, type, qtyChange, notes = '' }) {
  const invRef = sql.n(inventoryId);
  const inv = await connection.query(`SELECT Qty FROM Inventory WHERE InventoryID = ${invRef}`);
  if (inv.length === 0) return null;
  const previousQty = money.num(inv[0].Qty);
  const change = money.round2(money.num(qtyChange));
  const newQty = money.round2(previousQty + change);
  await connection.execute(`UPDATE Inventory SET Qty = ${newQty}, UpdatedAt = Now() WHERE InventoryID = ${invRef}`);
  const invId = invoiceId == null ? 'NULL' : sql.n(invoiceId);
  await connection.execute(
    `INSERT INTO StockMovements (InventoryID, InvoiceID, MovementType, QtyChange, PreviousQty, NewQty, MovementDate, Notes)
     VALUES (${invRef}, ${invId}, ${sql.q(type)}, ${change}, ${previousQty}, ${newQty}, Now(), ${sql.q(notes)})`
  );
  return { previousQty, newQty };
}

module.exports = { recordMovement };
