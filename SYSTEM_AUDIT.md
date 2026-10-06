# System Audit — Bottlenecks & Faults

**Scope:** the Node.js/Express + MS Access dashboard (`dashboard/`) that prints bills
and manages inventory/invoices. **Date:** 2026-07-11.

This audit was requested alongside making the **bill print perfect and accurate** and
confirming the **new prices are locked/final**. Both of those are now settled (see §1);
the rest is a prioritized list of everything else found.

## Bottom line

- **Bill print is now accurate** and **finalized prices are truly locked** — see §1.
- The **billing maths is trustworthy** (server-authoritative, decimal-safe rounding,
  correct SL tax order, divide-by-zero guarded). No money-calculation errors found.
- The real weaknesses are **operational and at scale**, not in the arithmetic:
  auth fail-open, non-atomic stock updates, and "process-per-query × unbounded loops ×
  no pagination" performance cliffs that bite as the invoice/stock history grows.

**Counts:** 2 fixed now · 3 high-severity open · 8 medium · ~10 low/operational.

---

## 1. Bill print & price-lock  ✅ addressed

| # | Severity | Status | Finding |
|---|---|---|---|
| 1.1 | High | **FIXED** | **Printed total could differ from the saved bill by a cent.** Viewing/printing an invoice recomputes totals in the browser, but the client `round2()` (public/app.js) was missing the `toPrecision(15)` floating-point snap that server `lib/money.js` uses. On half-cent ties (e.g. subtotal 1.40 → SSCL 0.035) the browser rounded **down** (0.03) while the server stored **up** (0.04) — 62 divergent cases per 200k subtotals. **Fixed:** ported the exact server rounding to the client; now **0 divergences over 2M cases**. |
| 1.2 | High | **FIXED** | **Locked invoices re-derived their auto-charge rates at print time.** `calcInvoiceTotals` re-computed the *Sundries cost* (material × 0.12) and *Technical charges* (material × 0.9) line rates on **every** run — including when opening a finalized invoice to print — unrounded, ignoring the stored rate (app.js:832–835). A reprint could show different Sundries/Technical amounts (and subtotal/total) than the bill actually issued. **Fixed:** these only re-derive while the invoice is editable, and are now rounded; locked invoices reprint their stored rates exactly. |
| 1.3 | — | **CONFIRMED OK** | **Prices are locked/final.** The server rejects any edit to a non-`Draft` invoice — `draft` (server.js:561) and `finalize` (server.js:628) both throw *"Invoice is {Status} and locked from editing."* Each invoice line stores its own `Rate`/`Amount`, so changing an inventory price never alters a past bill — only future bills. On the print view, the tax-rate/discount/round-off inputs are disabled for locked invoices (app.js:435–442), so the printed total is the stored total. |
| 1.4 | — | OK | Print layout is complete: logo, invoice ref (auto, non-editable), customer, line items, Sub Total → SSCL% → VAT% → Discount → Round Off → Total Due, notes, payment terms, signature. Money formats as `Rs. #,##0.00`. Excel exports already use the stored DB amounts (accurate). |

**Remaining print *display* hardening (not money-calc bugs, worth doing):**

- **[Medium] Robustness — render stored totals on view.** Even with 1.1 fixed, the print view *recomputes* totals rather than showing the saved `GrandTotal/SubTotal/SSCLAmount/VATAmount/RoundOff` the API already returns (server.js:467–485). It's now numerically identical, but any future change to client math would silently change historical reprints. Safer to render the stored fields for a loaded/locked invoice.
- **[Medium] Long "Billed-To" address clipped.** The address is a 3-row `<textarea>` with `resize:none` inside an `overflow:hidden` page (styles.css:481,137), so an address over 3 lines is truncated on the printed bill. Fix: auto-grow to content, or render as flowing text in print.
- **[Medium] Many-line invoices can't paginate.** `.page` is fixed-height + `overflow:hidden` and print CSS forbids page breaks; `onbeforeprint` shrinks via non-standard `zoom` from the on-screen height (app.js:1194–1206). Large invoices shrink to unreadable or clip page 2. Fix: a paginated print template.
- **[Low] Notes / Payment Terms / round-to-rupee flag aren't persisted.** Notes & terms are `contenteditable` defaults never saved or reloaded, so a reprint shows the *current* default text, not the original; round-to-rupee is inferred from `|RoundOff|>0` rather than a stored flag. Fix: persist them if they vary per bill.
- **[Low, policy] Discount is applied *after* VAT**, so the printed VAT is on the pre-discount base (billing.js:69–70). Correct if the discount is a post-tax/goodwill reduction; if it should reduce the taxable base, VAT is overstated. **Confirm the intended treatment.**
- **[Info]** No "amount in words" line on the bill — add if required for compliance (derive from the server grand total).

---

## 2. Security & authentication

| # | Severity | Finding & fix |
|---|---|---|
| 2.1 | **High** | **Auth fails OPEN.** `provisioningState()` (server.js:70–77) catches *any* error reading `Users` and returns `provisioned:false`, which makes `checkCredentials` accept the built-in `admin`/`admin123` (server.js:112). A transient DB lock/hiccup re-enables the default password even after a real one was set. **Fix:** on a query error, deny (treat as provisioned/unknown) — never fall back to the default. |
| 2.2 | **High** | **Default credential is discoverable.** `FALLBACK_PASSWORD='admin123'`, and the *unauthenticated* `GET /api/auth/status` returns `usingDefaultPassword:true` (server.js:176) — telling anyone exactly when `admin`/`admin123` works. Startup also prints the effective password to stdout (server.js:1704). **Fix:** don't expose that flag to anonymous callers, force a password change before serving data, never log the password. |
| 2.3 | Low | Username enumeration / non-constant-time compare (server.js:112); fully-open CORS (server.js:39); stateless 12h tokens with no revocation after a password change (lib/auth.js:72–105); login throttle is per-IP with no `trust proxy` (breaks behind a proxy). Hardening, not urgent for a single-PC localhost deployment. |

*Positive:* **SQL injection is well-defended** — strings go through `sql.q()`/`sql.esc()`
(correct single-quote doubling for the Access dialect), numbers through `sql.n()` (throws
on non-finite), dates through `sql.dbDate()`, and every `ORDER BY`/`LIKE` is server-built.
Only one escaping defect was found (§3.1), now fixed.

---

## 3. Data integrity & concurrency

| # | Severity | Status | Finding & fix |
|---|---|---|---|
| 3.1 | High | **FIXED** | **Cancel could corrupt stock.** The cancel movement note was `sql.esc(reason).slice(0,180)` — escaped *then* truncated, so a cut through an escaped `''` pair emits malformed SQL; the `INSERT` throws *after* the stock was already restored, and cancel has no rollback, so a retry **restores stock twice**. **Fixed:** truncate before escaping and wrap in `sql.q()`. (The underlying "cancel is non-atomic / no compensation" — §3.3 — remains.) |
| 3.2 | Medium | OPEN | **Inventory writes bypass the lock → lost updates.** `POST/PUT /api/inventory`, `DELETE`, and `/inventory/import` write `Inventory.Qty` **outside** `invoiceMutex` (server.js:318–357, 1342–1389), while finalize/cancel do a read-modify-write of the same column under the mutex. A concurrent inventory edit during a finalize silently discards one of the two changes. **Fix:** route every `Qty` write through the mutex, or use relative `Qty = Qty ± n` updates. |
| 3.3 | Medium | OPEN | **Finalize/cancel are not transactional.** Access via node-adodb has no transactions; finalize has best-effort in-memory compensation (server.js:654–700) but if compensation *itself* fails it only `console.error`s, leaving a half-deducted Finalized invoice; cancel has no compensation at all. **Fix:** track applied changes and compensate on every failure path; flip status first so a partial failure is detectable and non-repeatable. |
| 3.4 | Medium | OPEN | **Double-finalize duplicates a sale.** `POST /api/invoices/finalize` with no `invoiceId` always allocates a new number, inserts a new invoice, and deducts stock (server.js:593–652). A network retry/double-click creates two invoices and deducts stock twice. The client has a `savingInvoice` guard, but the server doesn't dedupe. **Fix:** require an idempotency key, or force the draft→finalize path. |
| 3.5 | Medium | OPEN | **Negative/unbounded quantities & prices accepted** on inventory edit/import (server.js:335–357, 1361–1378) — no `>= 0` check on `Qty`/`Price`/`Cost`. A `-100` qty or negative cost corrupts stock checks and P&L. **Fix:** validate `>= 0` on all inventory write paths including import rows. |

*Positive:* invoice numbering is race-free (allocation + insert under the mutex), payments
recompute `AmountPaid` from the authoritative `Payments` sum, cancel refuses when money is
recorded, and inventory delete is blocked when referenced by invoice items.

---

## 4. Performance & scalability bottlenecks

**Root amplifier:** node-adodb has **no connection pooling** — every query/execute spawns a
short-lived out-of-process Access worker on a single shared connection (server.js:33). So
every "N+1" below is "N+1 **process spawns**", and the single global `invoiceMutex`
serializes *all* invoice writes, so any request that loops over items blocks every other
write for its whole duration.

| # | Severity | Finding & fix |
|---|---|---|
| 4.1 | High | **No pagination anywhere.** `/api/invoices`, `/api/inventory`, `/api/movements` all `SELECT *` with no limit (server.js:298, 377, 1262), and the frontend fetches the **whole invoice list 3× per session** (history, export stats, comparison list). At thousands of invoices every load ships and re-renders the entire table. **Fix:** server-side paging (`TOP`/offset) + a count endpoint. |
| 4.2 | High | **N+1 process-spawn loops** on finalize (server.js:661–674, ~3 queries/item), cancel (734–746), and import (1353–1381, 2 queries/row, no transaction, partial-apply on failure). A large invoice or a 2,000-row import = thousands of sequential spawns, minutes long, holding the write lock. **Fix:** batch reads with `WHERE InventoryID IN (...)`, reuse the already-loaded `stockById`, validate/dedupe imports up front. |
| 4.3 | High | **Dashboard & P&L re-aggregate all history in JS** on every load (server.js:251–272, 1168–1237) — full scans of finalized invoices + pulling whole `Payments`/`Expenses`/`LabourPayments` tables into memory to bucket by month. **Fix:** push the month aggregation into SQL `GROUP BY`; add indexes on `Invoices.Status`, `FinalizedAt`, `InvoiceDate`, `InvoiceItems.InvoiceID`, `StockMovements.InventoryID`. |
| 4.4 | High | **Exports build the whole workbook in memory** (server.js:404–435, 1277–1340, 1539–1628) via `SELECT *`/large joins before `res.send`. At scale this can OOM and blocks the event loop. **Fix:** date-range filters / streaming / size caps. |
| 4.5 | Medium | **Uploads are unbounded and unfiltered** — `multer({ dest })` with no size/type limit, then `xlsx.readFile` parses the whole file (server.js:27, 1342). A large/garbage upload exhausts memory/disk. **Fix:** `limits:{fileSize:5MB}` + `fileFilter` to `.xlsx`, cap parsed rows. |
| 4.6 | Medium | **500s leak internals** — most handlers return raw `err.message` (Access/SQL text) to the client. **Fix:** log server-side, return a generic message + error id. |

---

## 5. Operational / miscellaneous

- **No backup mechanism** — the whole business is one `.accdb` file, no rotation/backup, no transactions across the multi-statement critical sections. **Recommend scheduled file-copy backups.**
- **No audit trail** beyond `StockMovements` — expense/labour/worker/payment deletes and reversals are hard deletes with no who/when log.
- **Windows-only & hard-coded config** — ACE.OLEDB provider, relative DB path resolved against cwd (server.js:32), `PORT` magic `9999`, and the frontend hard-codes `API_URL='http://localhost:9999/api'` (app.js:2) so any port change or remote access breaks the UI. **Fix:** env-driven config, absolute DB path from `__dirname`, relative `/api` base.
- **Dead code / no-op control** — the invoice-comparison **tier selector (Low/Mid/High) has no effect**: the endpoint hardcodes Mid and `readTier` is never called (server.js:1396, 1511). Either wire it up or remove the dropdown.
- **`xlsx@0.18.5`** has known high-severity CVEs (prototype-pollution / ReDoS) and parses uploaded files — **upgrade to a patched SheetJS build**.
- **Uncaught startup errors** — `app.listen` errors (e.g. `EADDRINUSE`) and `start()` have no `.catch`, so a port clash crashes with no message. Minor date/timezone off-by-one latent in `dbDate` (safe at UTC+5:30 today).

---

## Recommended order of work

1. **Done:** print-total rounding (1.1), cancel escaping (3.1).
2. **Do next (safety):** auth fail-open (2.1) + hide `usingDefaultPassword` / force password change (2.2); negative-qty validation (3.5); route inventory writes through the mutex (3.2).
3. **Before the data grows:** pagination (4.1) and month-aggregation-in-SQL + indexes (4.3); batch the finalize/cancel/import loops (4.2); upload limits (4.5).
4. **Operational:** scheduled `.accdb` backups; env-driven config; upgrade `xlsx`.

*None of the open items affect the correctness of a printed bill or a stored total — they
are about hardening, concurrency safety, and behaviour at scale.*
