# System Audit & Comprehensive Bug Fix Plan: External/Internal Billing, Ledger Reconciliation & RBAC Alignment

1-2 concise sentences: This plan delivers a robust correction for external customer sales ledger journal postings, implements an administrative bill reclassification workflow (Internal ↔ External) with automated journal reversal and reposting, and repairs role-based permissions and dashboard duties across all 9 organization roles.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural decisions were confirmed based on the initial assessment and user requirements:
> - **External Billing Flow**: Customer sales invoices (AR, Revenue, Sales Taxes, and COGS/Inventory movements) must reliably post to the General Ledger with exact reconciliation to `GrandTotal`, accounting for line discounts and round-offs.
> - **Reclassification Workflow**: Admins can reclassify finalized bills between Internal (fleet/cost-recovery) and External (commercial AR/revenue). This automatically reverses the prior journal entry and immediately posts a fresh journal under the new classification without data loss.
> - **Role Duties & Dashboards**: Comprehensive permission repair across Manager, Cashier, Workshop Supervisor, Operations Manager, HO Accounts, Workshop Accounts, DGM, and Chairman to ensure each duty can be executed without 403 errors or missing navigation sections.

- **Confirmed Decision 1**: Journal entries for reclassified bills will use double-entry reversal (`reversalOf` link) followed by a clean re-posting, maintaining an immutable financial audit trail.
- **Confirmed Decision 2**: Active journal duplicate detection in `services/ledger.js` will ignore previously reversed journals (`JournalID NOT IN (SELECT ReversalOf FROM JournalEntries WHERE ReversalOf IS NOT NULL)`), enabling clean re-posting after reversal.
- **Confirmed Decision 3**: The sidebar and page-level permission gates will be synchronized with backend `endpointAuthorization.js` so staff can access their assigned operational modules.

---

## 1. Overview & Core Concept

- **What It Does**:
  1. **Ledger Integrity**: Fixes the revenue and accounts receivable ledger posting mechanism in `glPosting.js` so external commercial sales invoices accurately post to General Ledger accounts (`1200 AR`, `4100 Parts Sales`, `4200 Technical Sales`, `2300 Taxes`, `5100 COGS`, and `1300 Inventory`), including edge cases where customer records are unlinked or invoice discounts apply.
  2. **Admin Reclassification Feature**: Adds a dedicated backend endpoint (`POST /api/invoices/:id/reclassify`) and frontend modal allowing authorized administrators to switch an invoice between Internal (own fleet R&M) and External (commercial customer). When triggered, it verifies period status, updates `IsInternal` and `PaymentStatus`, reverses the old journal, posts the new journal, and logs a business audit record.
  3. **Role Duties & RBAC Dashboard Synchronization**: Re-aligns user permissions across all roles in both `endpointAuthorization.js` and frontend React navigation (`Sidebar.tsx`, `Header.tsx`, and page views), ensuring supervisors can manage job cards and labour, cashiers can handle daily invoices and payments, accountants have full ledger access, and executives (DGM/Chairman) have dedicated executive analytics dashboards.

- **Target Audience / Persona**:
  - **Workshop Admin & Managers**: Need complete operational authority to correct mistakes, adjust stock, and reclassify misallocated fleet vs customer bills.
  - **Cashiers & Billing Clerks**: Need smooth invoice creation, receipt issuance, and cash collection without permission blockades.
  - **Supervisors & Engineers**: Need unhindered job card progress tracking, technician allocation, and labour bill certification.
  - **Head Office & Workshop Accountants**: Require reconcilable general ledger views, profit/loss statements, and labour approval workflows.
  - **Executive Leadership (DGM / Chairman)**: Need executive dashboard visibility over company financial health and operational throughput.

---

## 2. User Experience & Visual Design

Following the **SaaS & Dashboard Guidelines** and **Universal Frontend Design Constitution**:
- **Design Tokens**: Standard neutral canvas (clean slate `#0F172A` / `#FFFFFF`), single-elevation surface panels with hairline borders (`border border-slate-200 dark:border-slate-800`), tabular numerals (`font-mono tabular-nums`), zero pill clutter, and strict top-bar contracts.
- **Admin Reclassification Modal**:
  - Accessible via an "Edit Classification" or "Reclassify Bill" action in `InvoicesPage.tsx` (rendered only for Admin).
  - Clean modal dialog displaying:
    - Current classification: `Commercial (External)` vs `Internal Fleet`.
    - Destination classification with explanatory accounting note:
      - *Switching to Commercial*: Generates Accounts Receivable (`1200`), Sales Revenue (`4100`/`4200`), and reverses Internal Expense (`6900`).
      - *Switching to Internal*: Reverses Accounts Receivable and Sales, moves parts cost to Internal Repairs & Maintenance (`6900`), and sets balance to Not Applicable.
    - Reason input field for mandatory audit logging.
    - Primary confirmation button with loading spinner state and success toast.
- **Role-Aware Dashboard & Sidebar**:
  - `Sidebar.tsx` navigation updated with clean single-line links reflecting the user's role duties:
    - **Manager**: Dashboard, Invoices & Billing, Workshop Jobs, Stock & Inventory, Job Profit, Labour Bills, Procurement, Accounting & Ledger.
    - **Cashier**: Dashboard, Invoices & Billing, Workshop Jobs, Stock & Inventory, Payments & Receipts.
    - **Workshop Supervisor / Operations Manager**: Dashboard, Workshop Jobs, Job Profit, Labour Bills, Stock View.
    - **HO Accounts / Workshop Accounts**: Dashboard, Accounting & Ledger, Invoices, Labour Bills Approval & Payment, Reports.
    - **DGM / Chairman**: Executive Dashboard, Job Profit Analysis, Financial Ledger, Invoices, Workshop Overview (Read-Only).

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Handling Reclassification of Journal Entries**
  - *Chosen Approach*: Immutable journal reversal + reposting. The original journal entry is reversed with an opposite debit/credit entry linked via `ReversalOf = originalJournalId`. Then, a new journal is posted representing the updated classification.
  - *Why*: In standard enterprise double-entry bookkeeping, journals must never be silently deleted or mutated. Reversal leaves a transparent audit record for accountants.
  - *Alternatives Considered*: Direct modification of journal lines (violates accounting invariants and auditability).

- **Decision 2: Duplicate Journal Detection Fix**
  - *Chosen Approach*: Update `services/ledger.js` so that `isPosted` and `postEntry` ignore journals that have already been reversed (`JournalID NOT IN (SELECT ReversalOf FROM JournalEntries WHERE ReversalOf IS NOT NULL)`).
  - *Why*: Currently, `isPosted` only checks `ReversalOf IS NULL` on the row itself; because the original row's `ReversalOf` remains NULL, the system incorrectly believed the invoice was permanently posted even after reversal.

- **Decision 3: Grand Total vs Subtotal Discount Accounting**
  - *Chosen Approach*: Ensure `glPosting.postInvoice` includes discount lines (`Debit 5900/Discount Allowed` or adjusts revenue lines) so `Debit AR` exactly equals `GrandTotal`, guaranteeing that customer payment allocations perfectly match the ledger balance.

---

## 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AI Studio Frontend SPA                          │
│                                                                        │
│   ┌───────────────┐  ┌──────────────────┐  ┌───────────────────────┐   │
│   │  InvoicesPage │  │    LedgerPage    │  │     DashboardPage     │   │
│   │  - Reclassify │  │  - Journals      │  │  - Role KPI Cards     │   │
│   │    Modal (Adm)│  │  - Trial Balance │  │  - Active Job Alert   │   │
│   └───────┬───────┘  └────────┬─────────┘  └───────────┬───────────┘   │
└───────────┼───────────────────┼────────────────────────┼───────────────┘
            │                   │                        │
            ▼                   ▼                        ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Express API Backend (Port 3000)                    │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │  endpointAuthorization.js (Role permissions & Route gates)     │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │                                    │
│   ┌───────────────────────────────▼────────────────────────────────┐   │
│   │  POST /api/invoices/:id/reclassify                             │   │
│   │    1. Assert Admin role & open accounting period               │   │
│   │    2. glPosting.reverseInvoice(id, { reason })                 │   │
│   │    3. UPDATE Invoices SET IsInternal = ?, PaymentStatus = ?    │   │
│   │    4. glPosting.postInvoice(id, { allowClosedPeriod: false })  │   │
│   │    5. recordBusinessAudit(db, { action: 'reclassify_invoice'}) │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │                                    │
│   ┌───────────────────────────────▼────────────────────────────────┐   │
│   │  glPosting.js & services/ledger.js                             │   │
│   │    - Accurate AR calculation matching GrandTotal               │   │
│   │    - Support unlinked external customers                       │   │
│   │    - Active journal check excluding reversed entries           │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
└───────────────────────────────────┼────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                      SQLite Database (hydraulic.db)                    │
│   Invoices │ JournalEntries │ JournalLines │ Accounts │ BusinessAudit │
└────────────────────────────────────────────────────────────────────────┘
```

### Execution Phases & Action Items

1. **Phase 1: Backend Ledger Posting & Duplicate Detection Repair**
   - In `dashboard/services/ledger.js`: Fix `isPosted` and duplicate check in `postEntry` so reversed journals do not block re-posting.
   - In `dashboard/services/glPosting.js`: Ensure external invoice posting matches `GrandTotal` accurately (including discount/round-off handling) and handles null `CustomerID` gracefully by posting AR to general external trade debtor ledger.
   - Backfill/post any unposted historical finalized invoices.

2. **Phase 2: Administrative Reclassification Endpoint**
   - Implement `POST /api/invoices/:id/reclassify` in `dashboard/routes/invoices.js`.
   - Register endpoint in `dashboard/lib/endpointAuthorization.js` under `admin` only.
   - Implement transaction logic:
     - Check permissions & period status.
     - Reverse prior journal entry (if exists).
     - Update invoice `IsInternal`, `PaymentStatus` (`'Unpaid'` for external, `'Not Applicable'` for internal).
     - Repost fresh journal entry via `glPosting.postInvoice`.
     - Insert record into `BusinessAuditLog`.

3. **Phase 3: Role & Permission (RBAC) Alignment**
   - Update `ROLE_PERMISSIONS` in `dashboard/lib/endpointAuthorization.js`:
     - `manager`: Grant full operational access including `journal.read`, `inventory.adjust`, `procurement.manage`, and all invoice/labour operations.
     - `cashier`: Ensure invoice creation, receipting, job viewing, and stock viewing are fully permitted.
     - `workshop_supervisor` & `operations_manager`: Enable job card management, labour bill inspection/certification, and parts requisition.
     - `ho_accounts` & `workshop_accounts`: Enable full accounting, receipting, ledger auditing, and labour bill approvals/payments.
     - `dgm` & `chairman`: Ensure complete read-only dashboard access across all metrics.
   - Update `Sidebar.tsx` navigation items so all roles see their required modules.
   - Update `DashboardPage.tsx` to display role-tailored operational KPIs.

4. **Phase 4: Frontend Reclassification UI & Workflow**
   - In `frontend/src/pages/InvoicesPage.tsx`:
     - Add a "Reclassify" button in the Invoice details view / action menu for Admins.
     - Create an interactive modal with confirmation, destination explanation, and reason input.
     - Add status badge indicating `Internal Fleet` vs `Commercial Customer`.
   - In `frontend/src/pages/LedgerPage.tsx`:
     - Verify journal entries reflect both the original, the reversal, and the re-posted entries clearly with source links.

5. **Phase 5: Verification & End-to-End Testing**
   - Verify all tests with `compile_applet`.
   - Test login and dashboard navigation across `admin`, `manager`, `cashier`, `workshop_supervisor`, `ho_accounts`, and `dgm`.
   - Test invoice reclassification on a sample invoice and verify corresponding entries in `JournalEntries` and `JournalLines`.
