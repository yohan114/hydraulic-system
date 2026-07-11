# Create the database next to this script (the repo root), which is exactly
# where the dashboard server/migrate expect it (../HydraulicHoseRepair.accdb
# relative to dashboard/). Falls back to the current directory if $PSScriptRoot
# is unavailable (older PowerShell / dot-sourcing).
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$dbPath = Join-Path $scriptDir "HydraulicHoseRepair.accdb"
if (Test-Path $dbPath) {
    Remove-Item $dbPath -Force
}

Write-Host "Creating database..."
$catalog = New-Object -ComObject ADOX.Catalog
try {
    $catalog.Create("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath")
} catch {
    Write-Host "ACE.OLEDB.12.0 failed, trying 16.0..."
    $catalog.Create("Provider=Microsoft.ACE.OLEDB.16.0;Data Source=$dbPath")
}

Write-Host "Connecting to database..."
$conn = New-Object -ComObject ADODB.Connection
try {
    $conn.Open("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$dbPath")
} catch {
    $conn.Open("Provider=Microsoft.ACE.OLEDB.16.0;Data Source=$dbPath")
}

Write-Host "Creating tables..."

$conn.Execute("CREATE TABLE Inventory (
    [InventoryID] AUTOINCREMENT PRIMARY KEY,
    [UniqueID] VARCHAR(255) UNIQUE NOT NULL,
    [ProductName] VARCHAR(255) NOT NULL,
    [SpecificationCode] VARCHAR(255) NOT NULL,
    [Size] VARCHAR(255),
    [Description] MEMO,
    [Length] DOUBLE NOT NULL,
    [Qty] DOUBLE NOT NULL,
    [Unit] VARCHAR(50) NOT NULL,
    [Price] DOUBLE,
    [Cost] DOUBLE,
    [CreatedAt] DATETIME,
    [UpdatedAt] DATETIME
)")

$conn.Execute("CREATE TABLE Invoices (
    [InvoiceID] AUTOINCREMENT PRIMARY KEY,
    [InvoiceNo] VARCHAR(255) UNIQUE NOT NULL,
    [InvoiceDate] DATETIME,
    [PONo] VARCHAR(255),
    [PODate] DATETIME,
    [DeliveryDate] DATETIME,
    [BilledToName] VARCHAR(255),
    [BilledToAddress] MEMO,
    [DeliveredToName] VARCHAR(255),
    [DeliveredToAddress] MEMO,
    [SubTotal] CURRENCY,
    [SSCLRate] DOUBLE,
    [SSCLAmount] CURRENCY,
    [VATRate] DOUBLE,
    [VATAmount] CURRENCY,
    [Discount] CURRENCY,
    [RoundOff] CURRENCY,
    [GrandTotal] CURRENCY,
    [Status] VARCHAR(50),
    [AmountPaid] CURRENCY,
    [PaymentStatus] VARCHAR(20),
    [CancelledAt] DATETIME,
    [CancelReason] MEMO,
    [CreatedAt] DATETIME,
    [FinalizedAt] DATETIME
)")

$conn.Execute("CREATE TABLE InvoiceItems (
    [InvoiceItemID] AUTOINCREMENT PRIMARY KEY,
    [InvoiceID] INT,
    [InventoryID] INT,
    [ItemDescription] MEMO,
    [Unit] VARCHAR(50),
    [Length] DOUBLE,
    [Qty] DOUBLE,
    [Rate] CURRENCY,
    [Amount] CURRENCY,
    FOREIGN KEY ([InvoiceID]) REFERENCES Invoices([InvoiceID]),
    FOREIGN KEY ([InventoryID]) REFERENCES Inventory([InventoryID])
)")

$conn.Execute("CREATE TABLE StockMovements (
    [MovementID] AUTOINCREMENT PRIMARY KEY,
    [InventoryID] INT,
    [InvoiceID] INT,
    [MovementType] VARCHAR(50),
    [QtyChange] DOUBLE,
    [PreviousQty] DOUBLE,
    [NewQty] DOUBLE,
    [MovementDate] DATETIME,
    [Notes] MEMO,
    FOREIGN KEY ([InventoryID]) REFERENCES Inventory([InventoryID])
)")

$conn.Execute("CREATE TABLE Payments (
    [PaymentID] AUTOINCREMENT PRIMARY KEY,
    [InvoiceID] INT,
    [Amount] CURRENCY,
    [PaymentDate] DATETIME,
    [Method] VARCHAR(50),
    [Notes] MEMO,
    [CreatedAt] DATETIME,
    FOREIGN KEY ([InvoiceID]) REFERENCES Invoices([InvoiceID])
)")

$conn.Execute("CREATE TABLE Users (
    [UserID] AUTOINCREMENT PRIMARY KEY,
    [Username] VARCHAR(100) UNIQUE NOT NULL,
    [PasswordHash] VARCHAR(255) NOT NULL,
    [Role] VARCHAR(50),
    [CreatedAt] DATETIME,
    [UpdatedAt] DATETIME
)")

$conn.Execute("CREATE TABLE RateCard (
    [RateID] AUTOINCREMENT PRIMARY KEY,
    [Category] VARCHAR(20),
    [Spec] VARCHAR(20),
    [SizeCode] VARCHAR(20),
    [SizeInch] DOUBLE,
    [Label] VARCHAR(100),
    [Unit] VARCHAR(10),
    [OurCost] CURRENCY,
    [OurPrice] CURRENCY,
    [OutsideLow] CURRENCY,
    [OutsideMid] CURRENCY,
    [OutsideHigh] CURRENCY,
    [OutsidePrice] CURRENCY,
    [UpdatedAt] DATETIME
)")

$conn.Execute("CREATE TABLE Workers (
    [WorkerID] AUTOINCREMENT PRIMARY KEY,
    [Name] VARCHAR(150) NOT NULL,
    [Role] VARCHAR(100),
    [Active] INTEGER,
    [CreatedAt] DATETIME
)")

$conn.Execute("CREATE TABLE LabourPayments (
    [LabourPaymentID] AUTOINCREMENT PRIMARY KEY,
    [WorkerID] INT,
    [Amount] CURRENCY,
    [PayPeriod] VARCHAR(7),
    [PaymentDate] DATETIME,
    [Method] VARCHAR(50),
    [Notes] MEMO,
    [CreatedAt] DATETIME
)")

$conn.Execute("CREATE TABLE Expenses (
    [ExpenseID] AUTOINCREMENT PRIMARY KEY,
    [Category] VARCHAR(50),
    [Amount] CURRENCY,
    [ExpenseDate] DATETIME,
    [Method] VARCHAR(50),
    [Notes] MEMO,
    [CreatedAt] DATETIME
)")

$conn.Close()
Write-Host "Database created successfully at $dbPath"
