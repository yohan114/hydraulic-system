$connectionString = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=D:\hy 1\HydraulicHoseRepair.accdb;"
$conn = New-Object System.Data.OleDb.OleDbConnection($connectionString)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "ALTER TABLE Inventory ADD COLUMN Price DOUBLE"
$cmd.ExecuteNonQuery()
$conn.Close()
Write-Host "Success"
