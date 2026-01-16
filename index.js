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
    } catch (e) {
        return [];
    }
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

// УПРОЩЕННАЯ ФУНКЦИЯ СОЗДАНИЯ ЛИСТА (Без сложного форматирования)
async function ensureDailySheet(sheetName) {
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const sheetExists = meta.data.sheets.some(s => s.properties.title === sheetName);

        if (!sheetExists) {
            console.log(`📝 Создаем новый лист: ${sheetName}`);
            
            // 1. Просто создаем лист
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
            });

            // 2. Пишем заголовки
            const headers = [
                "ID Заказа", "Время создания", "User ID", 
                "Имя", "Телефон", "Адрес", 
                "Товары", "Сумма", "Статус", 
                "Комментарий", "Тип доставки", "Дата доставки"
            ];
            
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [headers] }
            });
        }
    } catch (e) {
        console.error("Ошибка при создании листа:", e);
        // Не выбрасываем ошибку, чтобы попробовать записать заказ даже если создание сбойнуло (редкий кейс)
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

            // --- ОПРЕДЕЛЕНИЕ ЛИСТА (ПО ДАТЕ) ---
            let datePartForId = "";
            let targetSheetName = "";

            if (data.orderDetails.deliveryRaw) {
                // Если пришла дата "2026-01-30"
                const parts = data.orderDetails.deliveryRaw.split('-'); 
                datePartForId = `${parts[2]}.${parts[1]}`;
                targetSheetName = `${parts[2]}.${parts[1]}.${parts[0]}`;
            } else {
                // Если даты нет - берем сегодня
                const now = new Date();
                const d = String(now.getDate()).padStart(2, '0');
                const m = String(now.getMonth() + 1).padStart(2, '0');
                const y = now.getFullYear();
                datePartForId = `${d}.${m}`;
                targetSheetName = `${d}.${m}.${y}`;
            }

            // Создаем лист, если его нет
            await ensureDailySheet(targetSheetName);

            // Генерируем ID
            const existingRows = await getSheetData(`${targetSheetName}!A:A`);
            const count = existingRows ? existingRows.length : 0;
            const nextNum = String(count === 0 ? 1 : count).padStart(3, '0');
            
            const typeLetter = (data.orderDetails.deliveryType === 'Самовывоз') ? 'С' : 'Д';
            const orderId = `${typeLetter}-${datePartForId}-${nextNum}`;

            const totals = calculateOrderTotals(cart, products);
            
            // Берем время с устройства клиента, если оно есть
            const nowTime = data.orderDetails.creationTime || new Date().toLocaleString("ru-RU");

            const orderData = [
                orderId, nowTime, userId,
                data.orderDetails.name, data.orderDetails.phone, data.orderDetails.address,
                itemsList.join('\n'), totals.finalTotal, 'Новый',
                data.orderDetails.comment,
                data.orderDetails.deliveryType,
                data.orderDetails.deliveryDate
            ];

            await appendRow(targetSheetName, orderData);

            const rowIndex = cartRows.findIndex(r => r[0] == userId) + 1;
            await updateRow(`${SHEET_CARTS}!B${rowIndex}`, ["[]"]);
            cache.del("products");

            res.json({ status: 'success', orderId, message: `Заказ ${orderId} принят!` });
        }
    } catch (e) {
        console.error("SERVER ERROR:", e);
        res.status(500).json({ status: 'error', message: e.message || "Ошибка сервера" });
    }
});

app.get('/ping', (req, res) => res.send('pong'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
