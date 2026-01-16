const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const NodeCache = require('node-cache');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api'); // Библиотека бота
require('dotenv').config();

const app = express();
// 🔥 КЭШ = 5 секунд.
const cache = new NodeCache({ stdTTL: 5 }); 

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- КОНФИГУРАЦИЯ ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_PRODUCTS = "Товары";
const SHEET_CLIENTS = "Клиенты";

// --- НАСТРОЙКИ БОТА ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// --- АВТОРИЗАЦИЯ GOOGLE ---
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

        for (let i = 0; i < rows.length; i++) {
            const cellVal = rows[i][3] || "";
            const phonesInCell = cellVal.toString().split('\n');
            for (let p of phonesInCell) {
                if (p.replace(/\D/g, '') === phoneToFind && phoneToFind.length > 5) {
                    foundIndex = i;
                    break;
                }
            }
            if (foundIndex !== -1) break;
        }

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
            const sheetRow = foundIndex + 2;
            const currentName = rows[foundIndex][1] || "";
            const currentPhone = rows[foundIndex][3] || "";
            let newNameVal = currentName;
            let newPhoneVal = currentPhone;

            if (foundByAddress) {
                if (!currentName.includes(customerData.name)) newNameVal = currentName + "\n" + customerData.name;
                if (!currentPhone.includes(customerData.phone)) {
                    const cleanOld = currentPhone.replace(/^="/, '').replace(/"$/, '');
                    newPhoneVal = cleanOld + "\n" + customerData.phone;
                }
            } else {
                if (customerData.name.length > currentName.length) newNameVal = customerData.name;
                newPhoneVal = formattedPhone;
            }

            const updateRange = `${SHEET_CLIENTS}!B${sheetRow}:E${sheetRow}`;
            await updateRow(updateRange, [newNameVal, customerData.address, newPhoneVal, customerData.items]);
        } else {
            const nextId = rows.length + 1;
            const newRowIndex = rows.length + 2;
            const newRow = [nextId, customerData.name, customerData.address, formattedPhone, customerData.items];
            await updateRow(`${SHEET_CLIENTS}!A${newRowIndex}`, newRow);
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
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

app.post('/api/action', async (req, res) => {
    const { action, userId, ...data } = req.body;
    try {
        if (action === 'place_order') {
            const cart = data.cart; 
            if (!cart || !cart.length) throw new Error("Корзина пуста");

            const prodRows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
            const products = prodRows.map((row, i) => ({
                id: row[0], name: row[2], price: parseFloat(row[3]), stock: parseInt(row[6]), rowIndex: i + 2
            }));

            let itemsList = [];
            let totalSum = 0;
            for (const item of cart) {
                const p = products.find(x => x.id === item.id);
                if (!p) throw new Error("Товар не найден: " + item.id);
                if (p.stock > 0 && item.qty > p.stock) throw new Error(`Мало товара: ${p.name}`);
                itemsList.push(`${p.name} x ${item.qty}`);
                totalSum += p.price * item.qty;
                if (p.stock > 0) await updateRow(`${SHEET_PRODUCTS}!G${p.rowIndex}`, [p.stock - item.qty]);
            }

            // Логика даты для имени листа (для БД)
            let targetSheetName = "";
            if (data.orderDetails.deliveryRaw && data.orderDetails.deliveryRaw.includes('-')) {
                const parts = data.orderDetails.deliveryRaw.split('-'); 
                targetSheetName = `${parts[2]}.${parts[1]}.${parts[0]}`;
            } else {
                const now = new Date();
                const d = String(now.getDate()).padStart(2, '0');
                const m = String(now.getMonth() + 1).padStart(2, '0');
                const y = now.getFullYear();
                targetSheetName = `${d}.${m}.${y}`;
            }

            await ensureDailySheet(targetSheetName);

            // 1. ГЕНЕРАЦИЯ ID (С-001)
            const existingRows = await getSheetData(`${targetSheetName}!A:A`);
            const nextRowIndex = existingRows.length + 1; 
            const orderCount = existingRows.length; // если есть заголовок, то кол-во строк = кол-во заказов + 1 (не совсем, но индекс верный)
            // Если заказов 0 (только хедер), то длина 1. ID должен быть 1.
            // Если заказов 1, длина 2. ID должен быть 2.
            // Логика: если длина 0 (пустой лист) - 1, если длина 1 (хедер) - 1. 
            const counter = orderCount === 0 ? 1 : orderCount; 
            const nextNum = String(counter).padStart(3, '0');
            const typeLetter = (data.orderDetails.deliveryType === 'Самовывоз') ? 'С' : 'Д';
            
            // 🔥 НОВЫЙ ФОРМАТ ID: С-008
            const orderId = `${typeLetter}-${nextNum}`;
            const totals = calculateOrderTotals(cart, products);
            
            const dateOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' };
            const nowTime = new Date().toLocaleString("ru-RU", dateOptions);
            
            // Для таблицы (с формулой)
            const formattedPhone = `="${data.orderDetails.phone}"`; 
            const productsString = itemsList.join('\n');

            const orderData = [orderId, nowTime, data.orderDetails.name, formattedPhone, data.orderDetails.address, data.orderDetails.deliveryType, productsString, totals.finalTotal + ' ₽', 'Новый', data.orderDetails.comment, userId];

            await updateRow(`${targetSheetName}!A${nextRowIndex}`, orderData);
            await updateDailySummary(targetSheetName);
            await sortSheetsByDate();
            await updateCustomerDatabase({ name: data.orderDetails.name, phone: data.orderDetails.phone, address: data.orderDetails.address, items: productsString });
            
            cache.del("products");

            // 👇 ОТПРАВКА УВЕДОМЛЕНИЙ (НОВЫЙ ШАБЛОН) 👇
            
            // 1. Подготовка данных для сообщения
            const cleanPhone = data.orderDetails.phone; // Чистый номер для ТГ (+7...)
            
            // Логика отображения адреса/типа
            let displayAddress = "";
            if (data.orderDetails.deliveryType === 'Самовывоз') {
                displayAddress = "Самовывоз";
            } else {
                displayAddress = data.orderDetails.address;
            }

            // Логика комментария (если есть - добавляем строку)
            let commentBlock = "";
            if (data.orderDetails.comment && data.orderDetails.comment.trim() !== "") {
                commentBlock = `📝  ${data.orderDetails.comment}\n`;
            }

            // 2. Сообщение КЛИЕНТУ (Простое подтверждение)
            const userMessage = `✅ <b>Заказ № ${orderId} оформлен!</b>\n\n` +
                                `💰 <b>Сумма:</b> ${totals.finalTotal} ₽\n` +
                                `🚚 <b>Тип:</b> ${displayAddress}\n\n` +
                                `<i>Скоро начнем готовить!</i>`;
            
            try {
                await bot.sendMessage(userId, userMessage, { parse_mode: 'HTML' });
            } catch (err) {
                console.error("Не удалось отправить сообщение клиенту:", err.message);
            }

            // 3. Сообщение АДМИНУ (ВАШ ШАБЛОН)
            const adminMessage = `Новый заказ 🔥\n\n` +
                                 `<b>№ ${orderId}</b>\n\n` +
                                 `👤  ${data.orderDetails.name}\n` +
                                 `📞  ${cleanPhone}\n` +
                                 `📍  ${displayAddress}\n` +
                                 `${commentBlock}\n` +
                                 `🛒  <b>Товары:</b>\n` +
                                 `${itemsList.join('\n')}\n\n` +
                                 `Сумма:   <b>${totals.finalTotal} ₽</b>`;

            try {
                await bot.sendMessage(ADMIN_CHAT_ID, adminMessage, { parse_mode: 'HTML' });
            } catch (err) {
                console.error("Не удалось отправить сообщение админу:", err.message);
            }
            // 👆 КОНЕЦ УВЕДОМЛЕНИЙ 👆

            res.json({ status: 'success', orderId, message: `Заказ №${orderId} оформлен!` });
        }
    } catch (e) {
        console.error("SERVER ERROR:", e);
        res.status(500).json({ status: 'error', message: "Ошибка: " + e.message });
    }
});

app.get('/ping', (req, res) => res.send('pong'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
