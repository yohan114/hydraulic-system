const ADODB = require('node-adodb');
const connectionString = `Provider=Microsoft.ACE.OLEDB.12.0;Data Source=../HydraulicHoseRepair.accdb;Persist Security Info=False;`;
const connection = ADODB.open(connectionString, true);

connection.query('SELECT COUNT(*) AS c FROM Inventory')
  .then(data => console.log('Inventory Count:', data[0].c))
  .catch(err => console.error(err));
