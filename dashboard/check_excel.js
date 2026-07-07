const xlsx = require('xlsx');

const workbook = xlsx.readFile('D:\\hy 1\\Hydraulic Items.xlsx');
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

for (let i = 3; i < 25; i++) {
    console.log(data[i]);
}
