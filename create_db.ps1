$dbPath = "d:\hydraulic 1\hydraulic repair\HydraulicHoseRepair.accdb"
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
    [GrandTotal] CURRENCY,
    [Status] VARCHAR(50),
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

$conn.Close()
Write-Host "Database created successfully at $dbPath"
