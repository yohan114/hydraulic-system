const ADODB = require('node-adodb');
const xlsx = require('xlsx');

const connectionString = `Provider=Microsoft.ACE.OLEDB.12.0;Data Source=../HydraulicHoseRepair.accdb;Persist Security Info=False;`;
const connection = ADODB.open(connectionString, true);

function generateUniqueId(name, spec, size) {
    let uniqueId = name.toUpperCase().replace(/[^A-Z0-9]/g, '-');
    if (spec) uniqueId += '-' + String(spec).toUpperCase().replace(/[^A-Z0-9]/g, '-');
    if (size) uniqueId += '-' + String(size).toUpperCase().replace(/[^A-Z0-9]/g, '-');
    return uniqueId.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function run() {
    console.log('Clearing database tables...');
    try {
        await connection.execute('DELETE FROM StockMovements');
        await connection.execute('DELETE FROM InvoiceItems');
        await connection.execute('DELETE FROM Invoices');
        await connection.execute('DELETE FROM Inventory');
        console.log('Database cleared.');
    } catch (e) {
        console.error('Error clearing database:', e);
    }

    console.log('Reading Excel file...');
    const workbook = xlsx.readFile('D:\\hy 1\\Hydraulic Items.xlsx');
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    const itemsMap = new Map();
    let lastProductName = '';
    let lastName = '';

    for (let i = 3; i < data.length; i++) {
        const row = data[i];
        if (!row || row.length === 0) continue;
        
        const no = row[0];
        if (!no) continue;
        
        let nameRaw = row[1];
        let productNameRaw = row[2];

        // Name inheritance
        if (nameRaw) {
            lastName = String(nameRaw).trim();
        } else {
            nameRaw = lastName; // Actually, for fittings, Name is empty in Excel. 
            // Wait, if it's empty, is it still "Rubber pipe"? No, they are fittings!
            // Let's just use empty if it's not a pipe. But wait, if they are fittings, maybe we don't need 'Name'.
        }
        
        // Let's be smart: If Name is 'Rubber pipe', we keep it. If it's a fitting, Name is empty.
        // Actually, let's just look at the raw row.
        const originalName = row[1] ? String(row[1]).trim() : '';
        const originalProduct = row[2] ? String(row[2]).trim() : '';

        let finalName = originalName;
        let finalProduct = originalProduct;

        // Inheritance logic for Rubber pipe
        if (originalName === 'Rubber pipe') {
            lastName = 'Rubber pipe';
        }
        if (originalProduct) {
            lastProductName = originalProduct;
        }

        if (!originalName && !originalProduct) {
            finalName = lastName;
            finalProduct = lastProductName;
        } else if (!originalProduct && originalName === 'Rubber pipe') {
            finalProduct = lastProductName;
        } else if (!originalName && originalProduct) {
            finalName = '';
            finalProduct = originalProduct;
        }

        const fullProductName = [finalName, finalProduct].filter(Boolean).join(' ');

        const spec = row[3] || '';
        const size = row[4] || '';
        const desc = row[5] || '';
        const length = row[6] || 0;
        
        // QTY logic: Number column (8) if exists, else Pcs column (7)
        let qty = 0;
        if (row[8]) {
            qty = parseFloat(row[8]);
        } else if (row[7]) {
            qty = parseFloat(row[7]);
        }

        const unit = row[9] || 'Nos';
        const price = row[10] || 0;

        // Use finalProduct to generate uniqueId if finalName is empty
        const uniqueIdBasis = finalName ? finalName : finalProduct;
        let uniqueId = generateUniqueId(uniqueIdBasis, spec ? finalProduct : '', size);
        // Wait, for fittings like '22611D-20-20', the uniqueIdBasis is '22611D-20-20'.
        // generateUniqueId('22611D-20-20', '', '') -> '22611D-20-20'
        if (!finalName) {
            uniqueId = generateUniqueId(finalProduct, '', '');
        } else {
            uniqueId = generateUniqueId(fullProductName, size, '');
        }

        if (itemsMap.has(uniqueId)) {
            const existing = itemsMap.get(uniqueId);
            existing.qty += qty;
        } else {
            itemsMap.set(uniqueId, {
                uniqueId,
                productName: fullProductName,
                specificationCode: String(spec),
                size: String(size),
                description: String(desc),
                length: parseFloat(length) || 0,
                qty: qty,
                unit: String(unit).trim(),
                price: parseFloat(price) || 0
            });
        }
    }

    console.log(`Parsed ${itemsMap.size} unique items. Inserting into DB...`);

    let inserted = 0;
    for (const [uid, item] of itemsMap.entries()) {
        try {
            const sql = `INSERT INTO Inventory (UniqueID, ProductName, SpecificationCode, [Size], Description, [Length], Qty, Unit, Price, CreatedAt, UpdatedAt) 
            VALUES ('${item.uniqueId.replace(/'/g, "''")}', '${item.productName.replace(/'/g, "''")}', '${item.specificationCode.replace(/'/g, "''")}', '${item.size.replace(/'/g, "''")}', '${item.description.replace(/'/g, "''")}', ${item.length}, ${item.qty}, '${item.unit.replace(/'/g, "''")}', ${item.price}, Now(), Now())`;
            await connection.execute(sql);
            inserted++;
        } catch (e) {
            console.error(`Failed to insert ${uid}:`, e.message);
        }
    }

    console.log(`Successfully inserted ${inserted} items.`);
}

run();
