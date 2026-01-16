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

// 🔥 ПОДСЧЕТ ИТОГОВ НА ДЕНЬ (Справа от таблицы) 🔥
async function updateDailySummary(sheetName) {
    try {
        // Читаем товары из колонки G
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
        for (const [name, qty] of Object.entries(totals)) {
            summaryData.push([name, qty]);
        }

        // Пишем в колонки M и N (начинаем с 13-й колонки, так как таблица занимает A-K)
        // A=0 ... K=10, L=11 (пустая), M=12, N=13
        // Давайте писать в N и O (13 и 14), чтобы был отступ
        await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!N1:O100` });
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!N1`, valueInputOption: 'USER_ENTERED', resource: { values: summaryData }
        });
    } catch (e) { console.error("Ошибка сводки:", e); }
}

// 🔥 СОЗДАНИЕ И НАСТРОЙКА ЛИСТА ПОД НОВЫЙ ДИЗАЙН 🔥
async function ensureDailySheet(sheetName) {
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetExists = meta.data.sheets.some(s => s.properties.title === sheetName);

        if (!sheetExists) {
            console.log(`🎨 Создаем лист: ${sheetName}`);
            
            // 1. Создаем лист
            const createRes = await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
            });
            const newSheetId = createRes.data.replies[0].addSheet.properties.sheetId;

            // 2. Настраиваем стили
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: {
                    requests: [
                        // --- 1. ШАПКА ---
                        { // Жирный шрифт + Центр + Фон
                            repeatCell: {
                                range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 },
                                cell: { 
                                    userEnteredFormat: { 
                                        textFormat: { bold: true }, 
                                        horizontalAlignment: "CENTER",
                                        verticalAlignment: "MIDDLE"
                                    } 
                                },
                                fields: "userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment)"
                            }
                        },
                        { // Закрепить 1 строку
                            updateSheetProperties: {
                                properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } },
                                fields: "gridProperties.frozenRowCount"
                            }
                        },

                        // --- 2. ОСНОВНОЕ ТЕЛО ТАБЛИЦЫ (A2:K1000) ---
                        // По умолчанию: Центр + Середина для ВСЕХ
                        {
                            repeatCell: {
                                range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 11 },
                                cell: { userEnteredFormat: { horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE" } },
                                fields: "userEnteredFormat(horizontalAlignment,verticalAlignment)"
                            }
                        },
                        
                        // --- 3. ИСКЛЮЧЕНИЯ ---
                        // Колонка G (Товары) - Выравнивание ВЛЕВО
                        {
                            repeatCell: {
                                range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 6, endColumnIndex: 7 },
                                cell: { userEnteredFormat: { horizontalAlignment: "LEFT", verticalAlignment: "MIDDLE" } },
                                fields: "userEnteredFormat(horizontalAlignment,verticalAlignment)"
                            }
                        },
                        // Колонка J (Комментарий) - Перенос текста
                        {
                            repeatCell: {
                                range: { sheetId: newSheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 9, endColumnIndex: 10 },
                                cell: { userEnteredFormat: { wrapStrategy: "WRAP", horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE" } },
                                fields: "userEnteredFormat(wrapStrategy,horizontalAlignment,verticalAlignment)"
                            }
                        },

                        // --- 4. ШИРИНА КОЛОНОК ---
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 100 }, fields: "pixelSize" } }, // A: Заказ
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 130 }, fields: "pixelSize" } }, // B: Оформлен
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, properties: { pixelSize: 120 }, fields: "pixelSize" } }, // C: Имя
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 3, endIndex: 4 }, properties: { pixelSize: 140 }, fields: "pixelSize" } }, // D: Телефон
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 4, endIndex: 5 }, properties: { pixelSize: 200 }, fields: "pixelSize" } }, // E: Адрес
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 5, endIndex: 6 }, properties: { pixelSize: 110 }, fields: "pixelSize" } }, // F: Тип дост
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 6, endIndex: 7 }, properties: { pixelSize: 300 }, fields: "pixelSize" } }, // G: Товары
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 7, endIndex: 8 }, properties: { pixelSize: 90 }, fields: "pixelSize" } },  // H: Сумма
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 8, endIndex: 9 }, properties: { pixelSize: 80 }, fields: "pixelSize" } },  // I: Статус
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 9, endIndex: 10 }, properties: { pixelSize: 200 }, fields: "pixelSize" } }, // J: Коммент
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 10, endIndex: 11 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } }, // K: UserID (СКРЫТ)
                        
                        // Сводка (N, O)
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 13, endIndex: 14 }, properties: { pixelSize: 200 }, fields: "pixelSize" } }, 
                        { updateDimensionProperties: { range: { sheetId: newSheetId, dimension: "COLUMNS", startIndex: 14, endIndex: 15 }, properties: { pixelSize: 80 }, fields: "pixelSize" } }   
                    ]
                }
            });

            // 3. Заголовки (Новый порядок)
            const headers = [
                "Заказ", "Оформлен", "Имя", 
                "Телефон", "Адрес", "Тип доставки", 
                "Товары", "Сумма", "Статус", 
                "Комментарий", "User ID"
            ];
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [headers] }
            });
        }
    } catch (e) {
        console.error("Ошибка настройки листа:", e.message);
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
                if (!p) throw new Error("Товар не найден (ID " + item.id + ")");
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
            
            // --- ФОРМАТИРОВАНИЕ ДАННЫХ ---
            // 1. Время без секунд (16.01.2026, 14:09)
            const dateOptions = { 
                year: 'numeric', month: 'numeric', day: 'numeric', 
                hour: '2-digit', minute: '2-digit' 
            };
            const nowTime = new Date().toLocaleString("ru-RU", dateOptions);
            
            // 2. Телефон с формулой ="..." чтобы не было ошибки
            const formattedPhone = `="${data.orderDetails.phone}"`;

            // 3. Формирование строки заказа (НОВЫЙ ПОРЯДОК СТОЛБЦОВ)
            // A: Заказ, B: Оформлен, C: Имя, D: Тел, E: Адрес, F: Тип, G: Товары, H: Сумма, I: Статус, J: Коммент, K: UID
            const orderData = [
                orderId, 
                nowTime, 
                data.orderDetails.name, 
                formattedPhone, 
                data.orderDetails.address,
                data.orderDetails.deliveryType,
                itemsList.join('\n'), 
                totals.finalTotal + ' ₽', 
                'Новый',
                data.orderDetails.comment,
                userId // Скрытая колонка
            ];

            await appendRow(targetSheetName, orderData);
            await updateDailySummary(targetSheetName);

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
