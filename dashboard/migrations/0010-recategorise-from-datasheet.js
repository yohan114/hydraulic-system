'use strict';

/**
 * Re-file every stock item under the category the SUPPLIER gives it.
 *
 * Migration 0004 derived Inventory.Category by pattern-matching product names,
 * because nothing better was wired in at the time. That was a guess, and it was
 * wrong in two ways:
 *
 *   - it left 10 items uncategorised (Rs 229,838, 94% of it the spiral ferrules,
 *     which are named "Spiral 00400-xx" and so matched no rule);
 *   - it invented a "Fitting" category and put all eight `10011N-xx` weld
 *     fittings in it, when the shipment datasheet classifies them as Unions.
 *
 * The datasheet (data/shipment-HS25E1112W1.json) is the authoritative source —
 * it is how the supplier itself classifies each part — so it wins over the
 * guess. It uses four categories: Hose, Ferrule, Union, Flange. "Fitting"
 * therefore disappears.
 *
 * Two items are not in the datasheet at all — the metric inserts
 * 20011-22-04ST / -06ST. The owner placed them under Ferrule, as part of the
 * crimped assembly; that decision is recorded here rather than inferred.
 *
 * Category is descriptive only: nothing prices, values or posts off it, so this
 * moves no money. Stock value is unchanged.
 */

const OVERRIDES = {
  '20011-22-04': 'Ferrule',
  '20011-22-06': 'Ferrule',
};

module.exports = {
  name: 'recategorise inventory from the shipment datasheet',

  up(db) {
    let datasheet;
    try {
      datasheet = require('../data/shipment-HS25E1112W1.json');
    } catch (e) {
      // No datasheet on this install — leave categories exactly as they are
      // rather than clearing them.
      return;
    }

    const byUid = new Map((datasheet.items || []).map((i) => [String(i.uniqueId), i.category]));
    const rows = db.prepare('SELECT InventoryID, UniqueID, Category FROM Inventory').all();
    const upd = db.prepare("UPDATE Inventory SET Category = ?, UpdatedAt = datetime('now','localtime') WHERE InventoryID = ?");

    for (const r of rows) {
      const uid = String(r.UniqueID || '');
      const category = byUid.get(uid) || OVERRIDES[uid] || null;
      // Only touch a row when we have an authoritative answer AND it differs.
      if (category && category !== r.Category) upd.run(category, r.InventoryID);
    }
  },

  down(db) {
    // The pre-migration categories were themselves a guess, so there is nothing
    // truer to restore. Clearing them puts the field back to "unknown", which is
    // honest; re-running 0004's heuristic would only reinstate the error.
    db.exec('UPDATE Inventory SET Category = NULL');
  },
};
