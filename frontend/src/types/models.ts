// Domain models for Hydraulic ERP

export interface Customer {
  CustomerID: number;
  Name: string;
  Kind: 'internal' | 'external';
  Address?: string;
  Phone?: string;
  Active: number;
  Jobs?: number;
  MachineCount?: number;
}

export interface Machine {
  MachineID: number;
  CustomerID?: number;
  Name: string;
  Code?: string;
  Kind?: string;
  Active?: number;
}

export interface InventoryItem {
  InventoryID: number;
  UniqueID: string;
  ProductName: string;
  SpecificationCode: string;
  Size?: string;
  Description?: string;
  Length?: number;
  Qty: number;
  Unit: string;
  Price: number;
  Cost?: number;
  MarketMid?: number;
  SupplierID?: number | null;
  SupplierName?: string;
  ReorderLevel?: number;
  LastPurchasePrice?: number;
  LastPurchaseDate?: string;
  MarketPrice?: number;
  MarketSource?: string;
  SuggestedBill?: number;
  SuggestedFloored?: boolean;
  PricingRuleApplied?: string;
}

export interface InvoiceLineItem {
  id?: number;
  inventoryId?: number | null;
  description: string;
  unit: string;
  length?: number;
  qty: number;
  rate: number;
  amount?: number;
  cost?: number;
  marketMid?: number;
  pricingSource?: string;
}

export interface Invoice {
  InvoiceID: number;
  InvoiceNo: string;
  InvoiceDate: string;
  BilledToName: string;
  BilledToAddress?: string;
  DeliveredToName?: string;
  DeliveredToAddress?: string;
  PONo?: string;
  PODate?: string;
  DeliveryDate?: string;
  SubTotal: number;
  Discount: number;
  RoundOff: number;
  GrandTotal: number;
  AmountPaid: number;
  Balance: number;
  Status: 'Draft' | 'Finalized' | 'Paid' | 'Cancelled' | 'Revised';
  PaymentStatus: string;
  PaymentStatusDerived?: string;
  IsInternal: number;
  CustomerID?: number | null;
  MachineID?: number | null;
  SiteID?: string;
  CreatedAt?: string;
  FinalizedAt?: string;
  CancelledAt?: string;
  CancelReason?: string;
  RevisedAt?: string;
  RevisionReason?: string;
  SupersededBy?: number;
  items?: Array<{
    InvoiceItemID: number;
    InvoiceID: number;
    InventoryID?: number | null;
    ItemDescription: string;
    Unit: string;
    Length?: number;
    Qty: number;
    Rate: number;
    Amount: number;
    ProductName?: string;
    SpecificationCode?: string;
    Cost?: number;
    UnitCostAtBilling?: number;
    OurBillRate?: number;
    MarketBillRate?: number;
    ProfitAmount?: number;
    MarginPercent?: number;
  }>;
}

export interface JobCard {
  JobID: number;
  JobNo: string;
  ReceivedAt: string;
  PromisedAt?: string | null;
  CustomerID?: number | null;
  CustomerName?: string | null;
  MachineID?: number | null;
  MachineName?: string | null;
  Description?: string;
  HoseSpec?: string;
  Priority: 'normal' | 'urgent';
  Status: 'open' | 'in-progress' | 'waiting-parts' | 'completed' | 'invoiced' | 'cancelled';
  Total: number;
  LabourCost: number;
  InvoiceID?: number | null;
  InvoiceNo?: string | null;
  WorkerName?: string | null;
  Lines?: number;
  items?: Array<{
    JobItemID: number;
    JobID: number;
    InventoryID?: number | null;
    ProductName?: string;
    Description: string;
    Unit: string;
    Qty: number;
    Rate: number;
    Amount: number;
  }>;
  labour?: Array<{
    JobLabourID: number;
    JobID: number;
    WorkerID?: number | null;
    WorkerName?: string;
    WorkType: string;
    Units: number;
    UnitLabel: string;
    Rate: number;
    Amount: number;
    LabourPaymentID?: number | null;
  }>;
}

export interface Quotation {
  QuoteID: number;
  QuoteNo: string;
  QuoteDate: string;
  CustomerID?: number | null;
  CustomerName?: string | null;
  MachineID?: number | null;
  MachineName?: string | null;
  Lines: number;
  Total: number;
  Status: 'draft' | 'accepted' | 'rejected';
  JobNo?: string | null;
}

export interface Worker {
  WorkerID: number;
  Name: string;
  Role?: string;
  Active?: number;
}

export interface Supplier {
  SupplierID: number;
  Name: string;
  ContactPerson?: string | null;
  Phone?: string | null;
  Email?: string | null;
  ItemCount?: number;
}

export interface LabourOwedSummary {
  count: number;
  total: number;
  workers: Array<{
    workerId: number | null;
    workerName: string;
    amount: number;
    items: Array<{
      JobLabourID: number;
      JobNo: string;
      WorkType: string;
      Units: number;
      UnitLabel: string;
      Rate: number;
      Amount: number;
    }>;
  }>;
}

export interface PurchaseOrder {
  POID: number;
  PONo: string;
  OrderDate: string;
  SupplierID: number;
  SupplierName: string;
  Total: number;
  Lines: number;
  OrderedQty: number;
  ReceivedQty: number;
  Status: 'open' | 'received' | 'cancelled';
  items?: Array<{
    POItemID: number;
    POID: number;
    InventoryID: number;
    ProductName: string;
    Unit: string;
    Qty: number;
    UnitPrice: number;
    Amount: number;
    ReceivedQty: number;
  }>;
}

export interface GoodsReceipt {
  GRNID: number;
  GRNNo: string;
  ReceiptDate: string;
  SupplierID: number;
  SupplierName: string;
  POID?: number;
  PONo?: string;
  GoodsValue: number;
  LandedCost: number;
  Lines: number;
  items?: Array<{
    GRNItemID: number;
    InventoryID: number;
    ProductName: string;
    Unit: string;
    Qty: number;
    UnitPrice: number;
  }>;
}

export interface PurchaseBill {
  BillID: number;
  BillNo: string;
  BillDate: string;
  SupplierID: number;
  SupplierName: string;
  GRNID?: number;
  GRNNo?: string;
  Total: number;
  AmountPaid: number;
  Outstanding: number;
  Status?: string;
}

export interface Account {
  AccountID: number;
  Code: string;
  Name: string;
  Type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';
  Debit: number;
  Credit: number;
  Balance: number;
}

export interface AccountLedgerLine {
  entryNo: string;
  date: string;
  memo: string;
  entryMemo?: string | null;
  lineMemo?: string | null;
  sourceType: string;
  sourceId?: string | number | null;
  debit: number;
  credit: number;
  balance: number;
}

export interface AccountLedgerResponse {
  account: {
    code: string;
    name: string;
    type: string;
  };
  lines: AccountLedgerLine[];
  closing: number;
}

export interface JournalEntry {
  JournalID: number;
  EntryDate: string;
  Reference?: string;
  SourceType: string;
  Description?: string;
  Amount: number;
  Lines: number;
}

export interface TrialBalance {
  accounts: Array<{
    code: string;
    name: string;
    type: string;
    debit: number;
    credit: number;
  }>;
  totals: {
    debit: number;
    credit: number;
    balanced: boolean;
  };
}

export interface ProfitAndLoss {
  revenue: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  marginPct?: number;
  balanced?: boolean;
}

export interface BalanceSheet {
  asAt?: string;
  assets: number;
  liabilities: number;
  equity: number;
  netProfit: number;
}

export interface UserAccount {
  UserID: number;
  Username: string;
  Role: import('./auth').UserRole;
  IsActive: boolean;
  AuthVersion: number;
  CreatedAt: string;
  UpdatedAt: string;
}

