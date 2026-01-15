const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // Кэш на 10 минут (600 сек)

app.use(cors());
app.use(express.json());

// --- КОНФИГУРАЦИЯ ---
// ID вашей таблицы (берется из URL таблицы: /d/ЭТОТ_ID/edit)
const SPREADSHEET_ID = process.env.SPREADSHEET_ID; 

const SHEET_PRODUCTS = "Товары";
const SHEET_CARTS = "Корзины";
const SHEET_USERS = "Пользователи";
const BASE_DELIVERY_COST = 300;
const FREE_DELIVERY_THRESHOLD = 5000;

// --- АВТОРИЗАЦИЯ GOOGLE ---
// На Render мы будем передавать ключи через Environment Variables, 
// чтобы не хранить файл secrets.json в коде.
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'), // Важно для Render
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// --- ХЕЛПЕРЫ ---

async function getSheetData(range) {
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
    });
    return response.data.values || [];
}

async function appendRow(range, values) {
    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] },
    });
}

async function updateRow(range, values) {
    await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: range,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values] },
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

// --- API ROUTES ---

// 1. GET PRODUCTS
app.get('/api/get_products', async (req, res) => {
    try {
        const cached = cache.get("products");
        if (cached) return res.json(cached);

        const rows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`); // Читаем всё кроме заголовка
        const products = rows
            .filter(row => row[7] === 'Да') // Столбец H
            .map((row, index) => ({
                id: row[0],
                category: row[1],
                name: row[2],
                price: parseFloat(row[3]) || 0,
                description: row[4],
                imageUrl: row[5],
                stock: parseInt(row[6]) || 0,
                options: row[8] ? row[8].split(',').map(o => o.trim()) : [],
                rowIndex: index + 2 // Сохраняем реальный номер строки для обновлений (2 = start row)
            }));

        const response = { status: 'success', products };
        cache.set("products", response);
        res.json(response);
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// 2. GET CART & USER
app.get('/api/get_cart', async (req, res) => {
    try {
        const userId = req.query.userId;
        if (!userId) throw new Error("No userId");

        // Получаем корзину
        const cartRows = await getSheetData(SHEET_CARTS);
        const userRow = cartRows.find(row => row[0] == userId);
        const cart = userRow ? JSON.parse(userRow[1]) : [];

        // Получаем продукты для подсчета (берем из кэша для скорости, если есть)
        // Для точного расчета лучше загрузить, но для GET запроса можно упростить
        // Здесь мы сделаем быстрый запрос, но лучше кэшировать товары глобально
        let productsResp = cache.get("products");
        if (!productsResp) {
             // Если кэша нет, считаем totals 0 или делаем запрос (упростим до 0 для скорости отклика, фронт пересчитает)
             // Или можно вызвать логику get_products
        }
        
        // В Node.js лучше передавать totals с фронта или иметь отдельный метод, 
        // но здесь вернем базовую структуру.
        // Для полноценного расчета нам нужен список товаров.
        const allRows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
        const products = allRows.map(row => ({ id: row[0], price: parseFloat(row[3]) || 0 }));
        
        const totals = calculateOrderTotals(cart, products);
        res.json({ status: 'success', cart, totals });

    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

app.get('/api/get_user_info', async (req, res) => {
    try {
        const userId = req.query.userId;
        const rows = await getSheetData(SHEET_USERS);
        const user = rows.find(r => r[0] == userId);
        
        if (user) {
            res.json({ status: 'success', user: { id: user[0], name: user[1], address: user[2], phone: user[3] } });
        } else {
            // Создаем, если нет (в Apps Script это было синхронно, тут асинхронно)
            await appendRow(SHEET_USERS, [userId, '', '', '']);
            res.json({ status: 'success', user: { id: userId, name: '', address: '', phone: '' } });
        }
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 3. POST ACTIONS
app.post('/api/action', async (req, res) => {
    const { action, userId, ...data } = req.body;
    
    try {
        if (action === 'save_cart' || action === 'add_to_cart') {
            // Логика добавления/сохранения упрощена: мы просто обновляем JSON корзины
            // Для add_to_cart нужно сначала прочитать, изменить и записать.
            // Для save_cart просто перезаписываем.
            
            let newCart = [];
            
            // 1. Читаем текущую таблицу корзин
            const cartRows = await getSheetData(SHEET_CARTS);
            let rowIndex = -1;
            
            // Находим строку пользователя
            for (let i = 0; i < cartRows.length; i++) {
                if (cartRows[i][0] == userId) {
                    rowIndex = i + 1; // 1-based index
                    if (action === 'add_to_cart') {
                        const currentCart = JSON.parse(cartRows[i][1] || '[]');
                        // Простая логика: найти и увеличить или добавить
                        const idx = currentCart.findIndex(it => it.id === data.itemId && it.opt === data.option);
                        if (idx !== -1) currentCart[idx].qty += data.quantity;
                        else currentCart.push({ id: data.itemId, qty: data.quantity, opt: data.option });
                        newCart = currentCart;
                    } 
                    break;
                }
            }

            if (action === 'save_cart') newCart = data.newCart;

            // Если юзер не найден и это add_to_cart
            if (rowIndex === -1 && action === 'add_to_cart') {
                 newCart = [{ id: data.itemId, qty: data.quantity, opt: data.option }];
            }

            // Проверка стока (опционально, требует загрузки товаров)
            // ... пропустим для краткости, аналогично GAS ...

            const now = new Date().toISOString();
            const jsonCart = JSON.stringify(newCart);

            if (rowIndex !== -1) {
                // Обновляем ячейки B и C (Cart JSON, Date)
                await updateRow(`${SHEET_CARTS}!B${rowIndex}:C${rowIndex}`, [jsonCart, now]);
            } else {
                await appendRow(SHEET_CARTS, [userId, jsonCart, now]);
            }
            
            // Расчет итогов для ответа
            const allP = await getSheetData(`${SHEET_PRODUCTS}!A2:D`);
            const productsSimple = allP.map(r => ({ id: r[0], price: parseFloat(r[3]) || 0 }));
            
            res.json({ 
                status: 'success', 
                newCart, 
                newTotals: calculateOrderTotals(newCart, productsSimple) 
            });
        } 
        
        else if (action === 'update_user_info') {
             const rows = await getSheetData(SHEET_USERS);
             let rowIndex = -1;
             for (let i = 0; i < rows.length; i++) {
                 if (rows[i][0] == userId) { rowIndex = i + 1; break; }
             }
             
             if (rowIndex !== -1) {
                 await updateRow(`${SHEET_USERS}!B${rowIndex}:D${rowIndex}`, [data.name, data.address, data.phone]);
             } else {
                 await appendRow(SHEET_USERS, [userId, data.name, data.address, data.phone]);
             }
             res.json({ status: 'success' });
        }

        else if (action === 'place_order') {
            // 1. Получаем корзину
            const cartRows = await getSheetData(SHEET_CARTS);
            const userRow = cartRows.find(r => r[0] == userId);
            if (!userRow) throw new Error("Корзина пуста");
            const cart = JSON.parse(userRow[1]);
            if (!cart.length) throw new Error("Корзина пуста");

            // 2. Получаем товары (свежие данные)
            const prodRows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
            const products = prodRows.map((row, i) => ({
                id: row[0], name: row[2], price: parseFloat(row[3]), stock: parseInt(row[6]), rowIndex: i + 2
            }));

            // 3. Проверяем остатки и готовим список
            let itemsList = [];
            let totalSum = 0;

            for (const item of cart) {
                const p = products.find(x => x.id === item.id);
                if (!p) throw new Error("Товар не найден");
                if (p.stock > 0 && item.qty > p.stock) throw new Error(`Мало товара: ${p.name}`);
                
                itemsList.push(`${p.name} x ${item.qty}`);
                totalSum += p.price * item.qty;

                // 4. Списание (сразу пишем в таблицу)
                if (p.stock > 0) {
                    const newStock = p.stock - item.qty;
                    // Обновляем столбец G (Stock)
                    await updateRow(`${SHEET_PRODUCTS}!G${p.rowIndex}`, [newStock]);
                }
            }

            // 5. Создаем заказ
            // Упрощение: Пишем все в один лист "Заказы" (создайте его руками в таблице один раз!)
            // Или используем логику даты. Для надежности API лучше писать в единый лист.
            const SHEET_ORDERS = "Заказы"; // Создайте этот лист в таблице!
            
            const delivery = (totalSum >= FREE_DELIVERY_THRESHOLD) ? 0 : BASE_DELIVERY_COST;
            const finalTotal = totalSum + delivery;
            const orderId = `ORD-${Date.now().toString().slice(-6)}`;
            const now = new Date().toLocaleString("ru-RU");

            const orderData = [
                orderId, now, userId, 
                data.orderDetails.name, data.orderDetails.phone, data.orderDetails.address,
                itemsList.join('\n'), finalTotal, 'Новый', 
                data.orderDetails.comment, data.orderDetails.deliveryType
            ];

            await appendRow(SHEET_ORDERS, orderData);

            // 6. Очищаем корзину
            const rowIndex = cartRows.findIndex(r => r[0] == userId) + 1;
            await updateRow(`${SHEET_CARTS}!B${rowIndex}`, ["[]"]);

            // 7. СБРОС КЭША
            cache.del("products");

            res.json({ status: 'success', orderId, message: `Заказ ${orderId} оформлен!` });
        }

    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Пинговалка для Render (чтобы не засыпал, используйте cron-job.org)
app.get('/ping', (req, res) => res.send('pong'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});