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
const SHEET_CLIENTS = "Клиенты"; // Новая вкладка для базы

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

async function appendRow(range, values) {
    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range, valueInputOption: 'USER_ENTERED', resource: { values: [values] },
    });
}

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

            // Настройка стилей дня
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
    } catch (e) { console.error("Ошибка листа дня:", e.message); }
}

// 🔥 УПРАВЛЕНИЕ ЛИСТОМ "КЛИЕНТЫ" 🔥
async function ensureClientsSheet() {
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetExists = meta.data.sheets.some(s => s.properties.title === SHEET_CLIENTS);

        if (!sheetExists) {
            console.log(`👥 Создаем базу клиентов`);
            const createRes = await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests: [{ addSheet: { properties: { title: SHEET_CLIENTS } } }] }
            });
            const newSheetId = createRes.data.replies[0].addSheet.properties.sheetId;

            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: {
                    requests: [
                        { // Шапка: Жирный + Центр
                            repeatCell: {
                                range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
                                cell: { userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: "CENTER" } },
                                fields: "userEnteredFormat"
                            }
                        },
                        { // Закрепить
                            updateSheetProperties: {
                                properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } },
                                fields: "gridProperties.frozenRowCount"
                            }
                        },
                        // Ширина колонок: №(50), Имя(150), Адрес(250), Телефон(150), Заказ(300)
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 50 }, fields: "pixelSize" } },
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 150 }, fields: "pixelSize" } },
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 250 }, fields: "pixelSize" } },
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 }, properties: { pixelSize: 150 }, fields: "pixelSize" } },
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 300 }, fields: "pixelSize" } },
                    ]
                }
            });

            // Заголовки (как на скрине)
            const headers = ["№", "Имя", "Адрес", "Номер телефона", "Последний заказ"];
            await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_CLIENTS}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [headers] } });
        }
    } catch (e) { console.error("Ошибка базы клиентов:", e.message); }
}

// 🔥 ОБНОВЛЕНИЕ БАЗЫ КЛИЕНТОВ 🔥
async function updateCustomerDatabase(customerData) {
    try {
        await ensureClientsSheet();
        
        // Читаем всю базу клиентов
        const rows = await getSheetData(`${SHEET_CLIENTS}!A2:E`);
        const phoneToFind = customerData.phone; // Чистый телефон ("+7999...")

        let foundIndex = -1;

        // Ищем клиента по телефону
        // Колонка D (index 3) - это Телефон
        for (let i = 0; i < rows.length; i++) {
            // В ячейке может быть формула ="..." или просто текст. Сравниваем содержимое.
            const cellVal = rows[i][3] || "";
            // Если в базе "+7 (999)..." а у нас "+7999...", приводим к общему виду для сравнения (удаляем пробелы и скобки)
            const dbPhoneClean = cellVal.replace(/\D/g, '');
            const inputPhoneClean = phoneToFind.replace(/\D/g, '');

            if (dbPhoneClean === inputPhoneClean && dbPhoneClean.length > 5) {
                foundIndex = i;
                break;
            }
        }

        const formattedPhone = `="${customerData.phone}"`; // Формула для сохранения
        
        if (foundIndex !== -1) {
            // --- КЛИЕНТ НАЙДЕН -> ОБНОВЛЯЕМ ---
            // Обновляем: Имя (B), Адрес (C), Заказ (E)
            // Строка в таблице = foundIndex + 2 (т.к. начинали с A2)
            const sheetRow = foundIndex + 2;
            
            // Если имя изменилось - обновим. Если адрес изменился - обновим.
            // Но самое главное - обновить ПОСЛЕДНИЙ ЗАКАЗ.
            
            // Пишем: Имя, Адрес, Телефон (на всякий случай), Заказ
            const updateRange = `${SHEET_CLIENTS}!B${sheetRow}:E${sheetRow}`;
            await updateRow(updateRange, [customerData.name, customerData.address, formattedPhone, customerData.items]);
            console.log(`🔄 Клиент обновлен: ${customerData.name}`);

        } else {
            // --- НОВЫЙ КЛИЕНТ -> СОЗДАЕМ ---
            // Номер по порядку = количество существующих строк + 1
            const nextId = rows.length + 1;
            
            const newRow = [
                nextId,              // №
                customerData.name,   // Имя
                customerData.address,// Адрес
                formattedPhone,      // Телефон
                customerData.items   // Заказ
            ];
            await appendRow(SHEET_CLIENTS, newRow);
            console.log(`✅ Новый клиент добавлен: ${customerData.name}`);
        }

    } catch (e) {
        console.error("Ошибка обновления клиентов:", e);
    }
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
            const cartRows = await getSheetData(SHEET_CARTS);
            let rowIndex = -1;
            let currentCart = [];
            for (let i = 0; i < cartRows.length; i++) {
                if (cartRows[i][0] == userId) {
                    rowIndex = i + 1;
                    currentCart = JSON.parse(cartRows[i][1] || '[]');
                    break;
                }
            }
            const idx = currentCart.findIndex(it => it.id === data.itemId);
            if (idx !== -1) {
                currentCart[idx].qty += data.quantity;
                if (currentCart[idx].qty <= 0) currentCart.splice(idx, 1);
            } else if (data.quantity > 0) {
                currentCart.push({ id: data.itemId, qty: data.quantity });
            }
            const now = new Date().toISOString();
            if (rowIndex !== -1) {
                await updateRow(`${SHEET_CARTS}!B${rowIndex}:C${rowIndex}`, [JSON.stringify(currentCart), now]);
            } else {
                await appendRow(SHEET_CARTS, [userId, JSON.stringify(currentCart), now]);
            }
            const allP = await getSheetData(`${SHEET_PRODUCTS}!A2:D`);
            const productsSimple = allP.map(r => ({ id: r[0], price: parseFloat(r[3]) || 0 }));
            res.json({ status: 'success', newCart: currentCart, newTotals: calculateOrderTotals(currentCart, productsSimple) });
        }
        else if (action === 'place_order') {
            const cartRows = await getSheetData(SHEET_CARTS);
            const userRow = cartRows.find(r => r[0] == userId);
            if (!userRow) throw new Error("Корзина пуста");
            const cart = JSON.parse(userRow[1]);
            if (!cart.length) throw new Error("Корзина пуста");

            const prodRows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
            const products = prodRows.map((row, i) => ({
                id: row[0], name: row[2], price: parseFloat(row[3]), stock: parseInt(row[6]), rowIndex: i + 2
            }));

            let itemsList = [];
            let totalSum = 0;
            for (const item of cart) {
                const p = products.find(x => x.id === item.id);
                if (!p) throw new Error("Товар не найден");
                if (p.stock > 0 && item.qty > p.stock) throw new Error(`Мало товара: ${p.name}`);
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

            const existingRows = await getSheetData(`${targetSheetName}!A:A`);
            const count = existingRows ? existingRows.length : 0;
            const nextNum = String(count === 0 ? 1 : count).padStart(3, '0');
            const typeLetter = (data.orderDetails.deliveryType === 'Самовывоз') ? 'С' : 'Д';
            const orderId = `${typeLetter}-${datePartForId}-${nextNum}`;

            const totals = calculateOrderTotals(cart, products);
            
            // Формат даты без секунд
            const dateOptions = { 
                year: 'numeric', month: 'numeric', day: 'numeric', 
                hour: '2-digit', minute: '2-digit' 
            };
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

            // 1. Записываем заказ в таблицу дня
            await appendRow(targetSheetName, orderData);
            
            // 2. Обновляем сводку дня (справа)
            await updateDailySummary(targetSheetName);
            
            // 3. Сортируем листы
            await sortSheetsByDate();

            // 4. 🔥 ОБНОВЛЯЕМ БАЗУ КЛИЕНТОВ 🔥
            await updateCustomerDatabase({
                name: data.orderDetails.name,
                phone: data.orderDetails.phone,
                address: data.orderDetails.address,
                items: productsString
            });

            // Очистка корзины
            const rowIndex = cartRows.findIndex(r => r[0] == userId) + 1;
            await updateRow(`${SHEET_CARTS}!B${rowIndex}`, ["[]"]);
            cache.del("products");

            res.json({ status: 'success', orderId, message: `Заказ ${orderId} оформлен!` });
        }
    } catch (e) {
        console.error("SERVER ERROR:", e);
        res.status(500).json({ status: 'error', message: "Ошибка сервера: " + e.message });
    }
});

app.get('/ping', (req, res) => res.send('pong'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
