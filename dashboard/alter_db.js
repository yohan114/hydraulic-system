const ADODB = require('node-adodb');
const connection = ADODB.open(`Provider=Microsoft.ACE.OLEDB.12.0;Data Source=../HydraulicHoseRepair.accdb;Persist Security Info=False;`);

async function alter() {
    try {
        await connection.execute('ALTER TABLE Inventory ADD COLUMN Price DOUBLE');
        console.log('Success');
    } catch(err) {
        console.error('Error:', err.message);
    }
}
alter();
