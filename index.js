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
const SHEET_USERS = "Пользователи";
const SHEET_ORDERS = "Заказы"; // Убедитесь, что лист создан
const BASE_DELIVERY_COST = 300;
const FREE_DELIVERY_THRESHOLD = 5000;

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
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    return response.data.values || [];
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
function calculateOrderTotals(cart, products) {
    let totalItemsAmount = 0;
    cart.forEach(item => {
        const product = products.find(p => p.id === item.id);
        if (product) totalItemsAmount += product.price * item.qty;
    });
    const deliveryCost = (totalItemsAmount >= FREE_DELIVERY_THRESHOLD || totalItemsAmount === 0) ? 0 : BASE_DELIVERY_COST;
    return { totalItemsAmount, deliveryCost, finalTotal: totalItemsAmount + deliveryCost };
}

// --- API ---

app.get('/api/get_products', async (req, res) => {
    try {
        const cached = cache.get("products");
        if (cached) return res.json(cached);

        const rows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
        const products = rows
            // Фильтр по Активности (Столбец H / индекс 7). Чекбокс отдает "TRUE" (строка)
            .filter(row => row[7] === 'TRUE' || row[7] === 'Да' || row[7] === true)
            .map((row, index) => ({
                id: row[0],
                category: row[1],
                name: row[2],
                price: parseFloat(row[3]) || 0,
                description: row[4],
                imageUrl: row[5],
                stock: parseInt(row[6]) || 0,
                rowIndex: index + 2
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
        
        // Для подсчета итогов нам нужны цены
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
                // Изменяем количество
                currentCart[idx].qty += data.quantity;
                // !!! ЕСЛИ <= 0, УДАЛЯЕМ ТОВАР !!!
                if (currentCart[idx].qty <= 0) {
                    currentCart.splice(idx, 1);
                }
            } else if (data.quantity > 0) {
                // Добавляем только если кол-во положительное
                currentCart.push({ id: data.itemId, qty: data.quantity });
            }

            const now = new Date().toISOString();
            if (rowIndex !== -1) {
                await updateRow(`${SHEET_CARTS}!B${rowIndex}:C${rowIndex}`, [JSON.stringify(currentCart), now]);
            } else {
                await appendRow(SHEET_CARTS, [userId, JSON.stringify(currentCart), now]);
            }

            // Пересчет итогов
            const allP = await getSheetData(`${SHEET_PRODUCTS}!A2:D`);
            const productsSimple = allP.map(r => ({ id: r[0], price: parseFloat(r[3]) || 0 }));
            
            res.json({ status: 'success', newCart: currentCart, newTotals: calculateOrderTotals(currentCart, productsSimple) });
        }
        else if (action === 'place_order') {
            // ... (Логика заказа такая же, как была, только добавляем поле даты доставки)
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
            
            const delivery = (totalSum >= FREE_DELIVERY_THRESHOLD) ? 0 : BASE_DELIVERY_COST;
            const orderId = `ORD-${Date.now().toString().slice(-6)}`;
            const now = new Date().toLocaleString("ru-RU");

            const orderData = [
                orderId, now, userId, 
                data.orderDetails.name, data.orderDetails.phone, data.orderDetails.address,
                itemsList.join('\n'), totalSum + delivery, 'Новый', 
                data.orderDetails.comment, 
                data.orderDetails.deliveryType, // Самовывоз/Доставка
                data.orderDetails.deliveryDate  // <--- НОВОЕ ПОЛЕ: ДАТА
            ];

            await appendRow(SHEET_ORDERS, orderData);

            // Очистка корзины
            const rowIndex = cartRows.findIndex(r => r[0] == userId) + 1;
            await updateRow(`${SHEET_CARTS}!B${rowIndex}`, ["[]"]);
            cache.del("products");

            res.json({ status: 'success', orderId, message: `Заказ ${orderId} оформлен!` });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.get('/ping', (req, res) => res.send('pong'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
