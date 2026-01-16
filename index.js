const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const NodeCache = require('node-cache');
const path = require('path');
require('dotenv').config();

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); 

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- КОНФИГУРАЦИЯ ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_PRODUCTS = "Товары";
const SHEET_CARTS = "Корзины";
const SHEET_CLIENTS = "Клиенты";

// --- АВТОРИЗАЦИЯ ---
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// --- ХЕЛПЕРЫ ---
async function getSheetData(range) {
    try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
        return response.data.values || [];
    } catch (e) { return []; }
}

async function updateRow(range, values) {
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range, valueInputOption: 'USER_ENTERED', resource: { values: [values] },
    });
}

// Удаляем старый appendRow, будем использовать умный расчет строк

// --- СОРТИРОВКА ЛИСТОВ ---
async function sortSheetsByDate() {
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const allSheets = meta.data.sheets;
        const otherSheets = [];
        const dateSheets = [];

        allSheets.forEach(sheet => {
            const title = sheet.properties.title;
            if (/^\d{2}\.\d{2}\.\d{4}$/.test(title)) {
                dateSheets.push(sheet);
            } else {
                otherSheets.push(sheet);
            }
        });

        dateSheets.sort((a, b) => {
            const dateA = parseDate(a.properties.title);
            const dateB = parseDate(b.properties.title);
            return dateA - dateB;
        });

        const sortedSheets = [...otherSheets, ...dateSheets];
        const requests = [];
        sortedSheets.forEach((sheet, index) => {
            if (sheet.properties.index !== index) {
                requests.push({
                    updateSheetProperties: {
                        properties: { sheetId: sheet.properties.sheetId, index: index },
                        fields: "index"
                    }
                });
            }
        });

        if (requests.length > 0) {
            await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests } });
        }
    } catch (e) { console.error("Ошибка сортировки:", e.message); }
}

function parseDate(str) {
    const parts = str.split('.');
    return new Date(parts[2], parts[1] - 1, parts[0]);
}

// --- СВОДКА ДНЯ ---
async function updateDailySummary(sheetName) {
    try {
        const rows = await getSheetData(`${sheetName}!G2:G`);
        const totals = {};
        rows.forEach(row => {
            if (!row[0]) return;
            const lines = row[0].split('\n');
            lines.forEach(line => {
                const match = line.match(/(.+) x (\d+)$/);
                if (match) {
                    const name = match[1].trim();
                    const qty = parseInt(match[2], 10);
                    if (!totals[name]) totals[name] = 0;
                    totals[name] += qty;
                }
            });
        });
        const summaryData = [['📦 ИТОГО НА ДЕНЬ', 'КОЛ-ВО']];
        for (const [name, qty] of Object.entries(totals)) summaryData.push([name, qty]);
        
        await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!N1:O100` });
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!N1`, valueInputOption: 'USER_ENTERED', resource: { values: summaryData }
        });
    } catch (e) { console.error("Ошибка сводки:", e); }
}

// --- УПРАВЛЕНИЕ ЛИСТАМИ (ДНИ) ---
async function ensureDailySheet(sheetName) {
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetExists = meta.data.sheets.some(s => s.properties.title === sheetName);

        if (!sheetExists) {
            console.log(`🎨 Создаем лист: ${sheetName}`);
            const createRes = await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
            });
            const newSheetId = createRes.data.replies[0].addSheet.properties.sheetId;

            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: {
                    requests: [
                        { repeatCell: { range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat" } },
                        { updateSheetProperties: { properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
                        { repeatCell: { range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 11 }, cell: { userEnteredFormat: { horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat" } },
                        { repeatCell: { range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 6, endColumnIndex: 7 }, cell: { userEnteredFormat: { horizontalAlignment: "LEFT", verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat" } },
                        { repeatCell: { range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 9, endColumnIndex: 10 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP", horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat" } },
                        
                        // Ширина колонок
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 100 }, fields: "pixelSize" } }, 
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 130 }, fields: "pixelSize" } }, 
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 120 }, fields: "pixelSize" } }, 
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 }, properties: { pixelSize: 140 }, fields: "pixelSize" } }, 
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 200 }, fields: "pixelSize" } }, 
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 }, properties: { pixelSize: 110 }, fields: "pixelSize" } }, 
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 6, endIndex: 7 }, properties: { pixelSize: 300 }, fields: "pixelSize" } }, 
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 7, endIndex: 8 }, properties: { pixelSize: 90 }, fields: "pixelSize" } },  
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 8, endIndex: 9 }, properties: { pixelSize: 80 }, fields: "pixelSize" } },  
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 10 }, properties: { pixelSize: 200 }, fields: "pixelSize" } }, 
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 10, endIndex: 11 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } },
                        
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 13, endIndex: 14 }, properties: { pixelSize: 200 }, fields: "pixelSize" } }, 
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 14, endIndex: 15 }, properties: { pixelSize: 80 }, fields: "pixelSize" } }   
                    ]
                }
            });

            const headers = ["Заказ", "Оформлен", "Имя", "Телефон", "Адрес", "Тип доставки", "Товары", "Сумма", "Статус", "Комментарий", "User ID"];
            await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [headers] } });
        }
    } catch (e) { console.error("Daily Sheet Error:", e.message); }
}

async function ensureCartsSheet() {
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetExists = meta.data.sheets.some(s => s.properties.title === SHEET_CARTS);
        if (!sheetExists) {
            await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [{ addSheet: { properties: { title: SHEET_CARTS } } }] } });
            await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_CARTS}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [["User ID", "Корзина", "Дата"]] } });
        }
    } catch (e) { console.error(e); }
}

// --- УПРАВЛЕНИЕ БАЗОЙ КЛИЕНТОВ (ОБЪЕДИНЕНИЕ) ---
async function ensureClientsSheet() {
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetExists = meta.data.sheets.some(s => s.properties.title === SHEET_CLIENTS);

        if (!sheetExists) {
            const createRes = await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests: [{ addSheet: { properties: { title: SHEET_CLIENTS } } }] }
            });
            const newSheetId = createRes.data.replies[0].addSheet.properties.sheetId;

            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: {
                    requests: [
                        { repeatCell: { range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat" } },
                        { updateSheetProperties: { properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
                        // Перенос строк включен для Имени (1) и Телефона (3), чтобы объединять
                        { repeatCell: { range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP" } }, fields: "userEnteredFormat" } },
                        { repeatCell: { range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 3, endColumnIndex: 4 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP" } }, fields: "userEnteredFormat" } },
                        
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 50 }, fields: "pixelSize" } },
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 150 }, fields: "pixelSize" } },
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 250 }, fields: "pixelSize" } },
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 }, properties: { pixelSize: 150 }, fields: "pixelSize" } },
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 300 }, fields: "pixelSize" } },
                    ]
                }
            });

            const headers = ["№", "Имя", "Адрес", "Номер телефона", "Последний заказ"];
            await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_CLIENTS}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [headers] } });
        }
    } catch (e) { console.error("Client DB Error:", e.message); }
}

async function updateCustomerDatabase(customerData) {
    try {
        await ensureClientsSheet();
        const rows = await getSheetData(`${SHEET_CLIENTS}!A2:E`);
        const phoneToFind = customerData.phone.replace(/\D/g, ''); 
        const addressToFind = customerData.address.trim().toLowerCase();

        let foundIndex = -1;
        let foundByAddress = false;

        // 1. Сначала ищем по Телефону
        for (let i = 0; i < rows.length; i++) {
            const cellVal = rows[i][3] || "";
            // В ячейке может быть несколько телефонов через \n, ищем во всех
            const phonesInCell = cellVal.toString().split('\n');
            
            for (let p of phonesInCell) {
                if (p.replace(/\D/g, '') === phoneToFind && phoneToFind.length > 5) {
                    foundIndex = i;
                    break;
                }
            }
            if (foundIndex !== -1) break;
        }

        // 2. Если по телефону не нашли, ищем по Адресу (для объединения)
        if (foundIndex === -1) {
            for (let i = 0; i < rows.length; i++) {
                const cellAddr = (rows[i][2] || "").trim().toLowerCase();
                if (cellAddr === addressToFind && addressToFind.length > 3) {
                    foundIndex = i;
                    foundByAddress = true;
                    break;
                }
            }
        }

        const formattedPhone = `="${customerData.phone}"`; 
        
        if (foundIndex !== -1) {
            // --- ОБНОВЛЕНИЕ ---
            const sheetRow = foundIndex + 2;
            const currentName = rows[foundIndex][1] || "";
            const currentPhone = rows[foundIndex][3] || "";
            
            let newNameVal = currentName;
            let newPhoneVal = currentPhone;

            // Если нашли по Адресу (значит телефон новый), добавляем данные через перенос строки
            if (foundByAddress) {
                if (!currentName.includes(customerData.name)) {
                    newNameVal = currentName + "\n" + customerData.name;
                }
                if (!currentPhone.includes(customerData.phone)) {
                    // Телефоны храним как формулы, сложно клеить формулы.
                    // При объединении придется сохранять как текст, иначе формула сломается.
                    // Берем старое значение (убираем =" и ") и добавляем новое
                    const cleanOld = currentPhone.replace(/^="/, '').replace(/"$/, '');
                    newPhoneVal = cleanOld + "\n" + customerData.phone;
                }
            } else {
                // Нашли по телефону - обновляем имя если изменилось
                if (customerData.name.length > currentName.length) {
                    newNameVal = customerData.name;
                }
                newPhoneVal = formattedPhone; // Обновляем формат если надо
            }

            const updateRange = `${SHEET_CLIENTS}!B${sheetRow}:E${sheetRow}`;
            await updateRow(updateRange, [newNameVal, customerData.address, newPhoneVal, customerData.items]);
            console.log(`🔄 Клиент обновлен (row ${sheetRow})`);

        } else {
            // --- СОЗДАНИЕ ---
            const nextId = rows.length + 1;
            // Используем values.update по координатам, чтобы не было смещений
            const newRowIndex = rows.length + 2;
            
            const newRow = [
                nextId,              
                customerData.name,   
                customerData.address,
                formattedPhone,      
                customerData.items   
            ];
            await updateRow(`${SHEET_CLIENTS}!A${newRowIndex}`, newRow);
            console.log(`✅ Новый клиент добавлен`);
        }
    } catch (e) { console.error("Client Update Logic Error:", e); }
}

function calculateOrderTotals(cart, products) {
    let totalItemsAmount = 0;
    let totalQty = 0;
    cart.forEach(item => {
        const product = products.find(p => p.id === item.id);
        if (product) {
            totalItemsAmount += product.price * item.qty;
            totalQty += item.qty;
        }
    });
    return { totalItemsAmount, deliveryCost: 0, finalTotal: totalItemsAmount, totalQty };
}

// --- API ROUTES ---

app.get('/api/get_products', async (req, res) => {
    try {
        const cached = cache.get("products");
        if (cached) return res.json(cached);

        const rows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
        const products = rows
            .filter(row => row[7] === 'TRUE' || row[7] === 'Да' || row[7] === true)
            .map((row, index) => ({
                id: row[0], category: row[1], name: row[2],
                price: parseFloat(row[3]) || 0, description: row[4], imageUrl: row[5],
                stock: parseInt(row[6]) || 0, rowIndex: index + 2
            }));

        const response = { status: 'success', products };
        cache.set("products", response);
        res.json(response);
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.get('/api/get_cart', async (req, res) => {
    try {
        await ensureCartsSheet();
        const userId = req.query.userId;
        const cartRows = await getSheetData(SHEET_CARTS);
        const userRow = cartRows.find(row => row[0] == userId);
        const cart = userRow ? JSON.parse(userRow[1]) : [];
        const prodRows = await getSheetData(`${SHEET_PRODUCTS}!A2:D`);
        const products = prodRows.map(r => ({ id: r[0], price: parseFloat(r[3]) || 0 }));
        res.json({ status: 'success', cart, totals: calculateOrderTotals(cart, products) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/action', async (req, res) => {
    const { action, userId, ...data } = req.body;
    try {
        if (action === 'add_to_cart') {
            await ensureCartsSheet();
            const cartRows = await getSheetData(SHEET_CARTS);
            let rowIndex = -1;
            let currentCart = [];
            for (let i = 0; i < cartRows.length; i++) {
                if (cartRows[i][0] == userId) {
                    rowIndex = i + 1; // +1 т.к. массив с 0
                    // Учтем шапку (строка 1), значит данные начинаются с строки 2
                    // Но массив rows включает шапку только если range A1. 
                    // getSheetData читает весь лист по умолчанию или range.
                    // Если мы читали весь лист, то i=0 это первая строка данных (если без шапки).
                    // Моя функция getSheetData читает range. Если range "Корзины", то читает все.
                    // Обычно надежнее искать по ID.
                    currentCart = JSON.parse(cartRows[i][1] || '[]');
                    break;
                }
            }
            // Перестраховка индекса
            const sheetRowIndex = rowIndex === -1 ? cartRows.length + 1 : rowIndex + 1; // +1 для учета смещения в Sheets

            const idx = currentCart.findIndex(it => it.id === data.itemId);
            if (idx !== -1) {
                currentCart[idx].qty += data.quantity;
                if (currentCart[idx].qty <= 0) currentCart.splice(idx, 1);
            } else if (data.quantity > 0) {
                currentCart.push({ id: data.itemId, qty: data.quantity });
            }
            const now = new Date().toISOString();
            
            if (rowIndex !== -1) {
                await updateRow(`${SHEET_CARTS}!B${sheetRowIndex}:C${sheetRowIndex}`, [JSON.stringify(currentCart), now]);
            } else {
                // Если новая запись, пишем в следующую пустую строку
                const nextRow = cartRows.length + 1; 
                await updateRow(`${SHEET_CARTS}!A${nextRow}`, [userId, JSON.stringify(currentCart), now]);
            }
            
            const allP = await getSheetData(`${SHEET_PRODUCTS}!A2:D`);
            const productsSimple = allP.map(r => ({ id: r[0], price: parseFloat(r[3]) || 0 }));
            res.json({ status: 'success', newCart: currentCart, newTotals: calculateOrderTotals(currentCart, productsSimple) });
        }
        else if (action === 'place_order') {
            await ensureCartsSheet();
            const cartRows = await getSheetData(SHEET_CARTS);
            const userRow = cartRows.find(r => r[0] == userId);
            if (!userRow) throw new Error("Cart empty");
            const cart = JSON.parse(userRow[1]);
            if (!cart.length) throw new Error("Cart empty");

            const prodRows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
            const products = prodRows.map((row, i) => ({
                id: row[0], name: row[2], price: parseFloat(row[3]), stock: parseInt(row[6]), rowIndex: i + 2
            }));

            let itemsList = [];
            let totalSum = 0;
            for (const item of cart) {
                const p = products.find(x => x.id === item.id);
                if (!p) throw new Error("Product not found");
                if (p.stock > 0 && item.qty > p.stock) throw new Error(`Stock low: ${p.name}`);
                itemsList.push(`${p.name} x ${item.qty}`);
                totalSum += p.price * item.qty;
                if (p.stock > 0) {
                    await updateRow(`${SHEET_PRODUCTS}!G${p.rowIndex}`, [p.stock - item.qty]);
                }
            }

            // --- ДАТА И ЛИСТ ---
            let datePartForId = "";
            let targetSheetName = "";

            if (data.orderDetails.deliveryRaw && data.orderDetails.deliveryRaw.includes('-')) {
                const parts = data.orderDetails.deliveryRaw.split('-'); 
                datePartForId = `${parts[2]}.${parts[1]}`;
                targetSheetName = `${parts[2]}.${parts[1]}.${parts[0]}`;
            } else {
                const now = new Date();
                const d = String(now.getDate()).padStart(2, '0');
                const m = String(now.getMonth() + 1).padStart(2, '0');
                const y = now.getFullYear();
                datePartForId = `${d}.${m}`;
                targetSheetName = `${d}.${m}.${y}`;
            }

            await ensureDailySheet(targetSheetName);

            // 🔥 ВАЖНО: Читаем текущие данные, чтобы понять, в какую СТРОКУ писать (избегаем смещения вправо)
            const existingRows = await getSheetData(`${targetSheetName}!A:A`);
            const nextRowIndex = existingRows.length + 1; // Если есть 1 строка (шапка), пишем во 2-ю
            
            // Номер заказа
            const orderCount = existingRows.length; // 1 (шапка) -> заказ 001
            const nextNum = String(orderCount === 0 ? 1 : orderCount).padStart(3, '0');
            
            const typeLetter = (data.orderDetails.deliveryType === 'Самовывоз') ? 'С' : 'Д';
            const orderId = `${typeLetter}-${datePartForId}-${nextNum}`;

            const totals = calculateOrderTotals(cart, products);
            
            const dateOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' };
            const nowTime = new Date().toLocaleString("ru-RU", dateOptions);
            const formattedPhone = `="${data.orderDetails.phone}"`;
            const productsString = itemsList.join('\n');

            const orderData = [
                orderId, 
                nowTime, 
                data.orderDetails.name, 
                formattedPhone, 
                data.orderDetails.address,
                data.orderDetails.deliveryType,
                productsString, 
                totals.finalTotal + ' ₽', 
                'Новый',
                data.orderDetails.comment,
                userId 
            ];

            // 1. Записываем заказ СТРОГО в колонку A следующей строки
            await updateRow(`${targetSheetName}!A${nextRowIndex}`, orderData);
            
            // 2. Обновляем сводку
            await updateDailySummary(targetSheetName);
            await sortSheetsByDate();

            await updateCustomerDatabase({
                name: data.orderDetails.name,
                phone: data.orderDetails.phone,
                address: data.orderDetails.address,
                items: productsString
            });

            // Очистка
            const rowIndex = cartRows.findIndex(r => r[0] == userId) + 1;
            // Тут +1 может быть мало если массив не с 1 строки. 
            // Надежнее найти пользователя и его индекс в массиве rows
            // cartRows[0] это строка 1? getSheetData читает как есть.
            // Если лист "Корзины", и мы не указываем диапазон, он читает все usedRange.
            // Допустим, user на 5 месте в массиве (индекс 4). В таблице это строка 5 (если с 1 начать).
            // Плюс шапка? В getSheetData мы читаем ВЕСЬ лист.
            // Если userRow найден, берем индекс.
            const userSheetRow = cartRows.indexOf(userRow) + 1;
            await updateRow(`${SHEET_CARTS}!B${userSheetRow}`, ["[]"]);
            
            cache.del("products");

            res.json({ status: 'success', orderId, message: `Заказ ${orderId} оформлен!` });
        }
    } catch (e) {
        console.error("SERVER ERROR:", e);
        res.status(500).json({ status: 'error', message: "Error: " + e.message });
    }
});

app.get('/ping', (req, res) => res.send('pong'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
