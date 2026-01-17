const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const NodeCache = require('node-cache');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const app = express();
const cache = new NodeCache({ stdTTL: 5 }); 

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ⚙️ НАСТРОЙКИ
// ==========================================
const ENABLE_WORK_CHAT = true; 
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_PRODUCTS = "Товары";
const SHEET_CLIENTS = "Клиенты";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 

// --- ИНИЦИАЛИЗАЦИЯ БОТА ---
let bot;
if (WEBHOOK_URL) {
    console.log("🚀 Запуск в режиме WEBHOOK");
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`);
} else {
    console.log("🐢 Запуск в режиме POLLING");
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
}

// --- АВТОРИЗАЦИЯ GOOGLE ---
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
function getFormattedDate(dateObj) {
    const d = String(dateObj.getDate()).padStart(2, '0');
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const y = dateObj.getFullYear();
    return `${d}.${m}.${y}`;
}

async function getSheetData(range) {
    try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
        return response.data.values || [];
    } catch (e) { return []; }
}

async function updateRow(range, values) {
    await sheets.spreadsheets.values.update({ 
        spreadsheetId: SPREADSHEET_ID, 
        range, 
        valueInputOption: 'USER_ENTERED', 
        resource: { values: [values] } 
    });
}

// Функция для вытаскивания эмодзи из строки категории (например "🧀 Молочное" -> "🧀")
function extractIcon(categoryStr) {
    if (!categoryStr) return '📦';
    // Берем первую часть строки до пробела. Если там эмодзи, оно вернется.
    const parts = categoryStr.trim().split(' ');
    return parts.length > 0 ? parts[0] : '📦';
}

// ==========================================
// 🚀 API СЕРВЕР
// ==========================================

// Webhook от Telegram
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Получение товаров
app.get('/api/get_products', async (req, res) => { 
    try { 
        const cached = cache.get("products"); 
        if (cached) return res.json(cached); 
        
        // Берем диапазон A:I, где колонка B (index 1) - это Категория
        const rows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
        const products = rows
            .filter(row => row[7] === 'TRUE' || row[7] === 'Да' || row[7] === true)
            .map((row, index) => ({ 
                id: row[0], 
                category: row[1], // Сохраняем категорию как есть (например "🧀 Молочное")
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

// Проверка остатков
app.post('/api/check_stock', async (req, res) => {
    const { cart } = req.body;
    try {
        const rows = await getSheetData(`${SHEET_PRODUCTS}!A2:G`);
        const products = rows.map(row => ({ 
            id: row[0], 
            name: row[2], 
            stock: parseInt(row[6]) || 0 
        }));

        let errors = [];
        for (const item of cart) {
            const p = products.find(x => x.id === item.id);
            if (!p) {
                errors.push(`Товар ID ${item.id} не найден`);
            } else if (p.stock < item.qty) {
                errors.push(`${p.name}: доступно ${p.stock} шт.`);
            }
        }

        if (errors.length > 0) {
            return res.json({ status: 'error', message: "Недостаточно товара:\n" + errors.join('\n') });
        }
        res.json({ status: 'success' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Оформление заказа
app.post('/api/action', async (req, res) => {
    const { action, userId, ...data } = req.body;
    try {
        if (action === 'place_order') {
            const cart = data.cart; 
            if (!cart || !cart.length) throw new Error("Корзина пуста");

            // 1. Получаем СВЕЖИЕ остатки и Категорию (row[1])
            const prodRows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
            const products = prodRows.map((row, i) => ({ 
                id: row[0], 
                category: row[1], // Колонка B: Категория
                name: row[2], 
                price: parseFloat(row[3]), 
                stock: parseInt(row[6]), 
                rowIndex: i + 2 
            }));

            let itemsListForAdmin = []; 
            let itemsListForSheet = []; 
            let totalSum = 0;

            // Разделители для шаблонов
            const SEP_LONG = '· · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · · ·';
            const SEP_SHORT = '· · · · · · · · · · · · · · · · · · · · · · · · · · · · ·';

            // 2. Проверка и списание
            for (const item of cart) {
                const p = products.find(x => x.id === item.id);
                if (!p) throw new Error(`Товар ${item.id} не найден`);
                
                if (p.stock < item.qty) {
                    throw new Error(`Товар "${p.name}" закончился (осталось ${p.stock}).`);
                }

                // Извлекаем иконку из ячейки категории (например "🧀 Молочное" -> "🧀")
                const icon = extractIcon(p.category);

                itemsListForAdmin.push(`${icon} ${p.name} x ${item.qty}`);
                itemsListForSheet.push(`${p.name} x ${item.qty}`);
                
                totalSum += p.price * item.qty;
                
                // Вычисляем новый остаток
                const newStock = p.stock - item.qty;
                
                // Обновляем в Google Sheets
                await updateRow(`${SHEET_PRODUCTS}!G${p.rowIndex}`, [newStock]);

                // 🔔 УВЕДОМЛЕНИЕ: МАЛО ТОВАРА (Ваш новый шаблон)
                if (newStock <= 10) {
                    const lowStockMsg = 
                        `Товар скоро закончится!\n` +
                        `${SEP_SHORT}\n` +
                        `${icon} ${p.name}\n` +
                        `${SEP_SHORT}\n` +
                        `Остаток: ${newStock} шт.`;
                    
                    bot.sendMessage(ADMIN_CHAT_ID, lowStockMsg);
                }
            }

            // 3. Запись заказа
            const deliveryDateRaw = data.orderDetails.deliveryRaw; 
            let dateObj = deliveryDateRaw ? new Date(deliveryDateRaw) : new Date();
            const targetSheetName = getFormattedDate(dateObj); // ДД.ММ.ГГГГ

            await ensureDailySheet(targetSheetName);
            const existingRows = await getSheetData(`${targetSheetName}!A:A`);
            const nextNum = String((existingRows.length === 0 ? 1 : existingRows.length)).padStart(3, '0');
            const typeLetter = (data.orderDetails.deliveryType === 'Самовывоз') ? 'С' : 'Д';
            const orderId = `${typeLetter}-${nextNum}`;
            
            const productsString = itemsListForSheet.join('\n');
            const nowTime = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });

            await updateRow(`${targetSheetName}!A${existingRows.length + 1}`, [
                orderId, nowTime, 
                data.orderDetails.name, `="${data.orderDetails.phone}"`, 
                data.orderDetails.address, data.orderDetails.deliveryType, 
                productsString, totalSum + ' ₽', 
                'Новый', data.orderDetails.comment, userId
            ]);
            
            await updateDailySummary(targetSheetName);
            await sortSheetsByDate();
            await updateCustomerDatabase({ 
                name: data.orderDetails.name, 
                phone: data.orderDetails.phone, 
                address: data.orderDetails.address, 
                items: productsString, 
                userId: userId 
            });
            
            cache.del("products");

            // Уведомление клиенту
            const displayAddress = data.orderDetails.deliveryType === 'Самовывоз' ? "Самовывоз" : data.orderDetails.address;
            try { await bot.sendMessage(userId, `✅ <b>Заказ № ${orderId} оформлен!</b>\n\n💰 <b>Сумма:</b> ${totalSum} ₽`, { parse_mode: 'HTML' }); } catch (e) {}

            if (ENABLE_WORK_CHAT) {
                // 🔥 УВЕДОМЛЕНИЕ: НОВЫЙ ЗАКАЗ (Ваш новый шаблон)
                const adminMsg = 
                    `🔥Новый заказ на ${targetSheetName}\n\n` +
                    `№ ${orderId}\n\n` +
                    `Клиент\n` +
                    `${SEP_LONG}\n` +
                    `👤 ${data.orderDetails.name}\n` +
                    `📞 ${data.orderDetails.phone}\n` +
                    `📍 ${displayAddress}\n` +
                    `${SEP_LONG}\n\n` +
                    `Состав заказа\n` +
                    `${SEP_LONG}\n` +
                    `${itemsListForAdmin.join('\n')}\n` +
                    `${SEP_LONG} \n` +
                    `Сумма: ${totalSum} ₽`;

                const keyboard = { inline_keyboard: [[{ text: '🍳 Готовим', callback_data: `status|${targetSheetName}|${orderId}|Готовится` }, { text: '🚀 В пути', callback_data: `status|${targetSheetName}|${orderId}|В пути` }], [{ text: '✅ Готов', callback_data: `status|${targetSheetName}|${orderId}|Готов` }], [{ text: '🏁 Выполнен', callback_data: `status|${targetSheetName}|${orderId}|Выполнен` }, { text: '❌ Отмена', callback_data: `status|${targetSheetName}|${orderId}|Отменен` }]] };
                
                try { await bot.sendMessage(ADMIN_CHAT_ID, adminMsg, { reply_markup: keyboard }); } catch (e) {}
            }
            res.json({ status: 'success', orderId, message: `Заказ №${orderId} оформлен!` });
        }
    } catch (e) { 
        res.status(500).json({ status: 'error', message: "Ошибка: " + e.message }); 
    }
});

// Служебные функции для Sheets
async function sortSheetsByDate() { try { const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }); const allSheets = meta.data.sheets; const dateSheets = []; const otherSheets = []; allSheets.forEach(s => { /^\d{2}\.\d{2}\.\d{4}$/.test(s.properties.title) ? dateSheets.push(s) : otherSheets.push(s); }); dateSheets.sort((a, b) => { const [d1, m1, y1] = a.properties.title.split('.'); const [d2, m2, y2] = b.properties.title.split('.'); return new Date(y1, m1-1, d1) - new Date(y2, m2-1, d2); }); const requests = [...otherSheets, ...dateSheets].map((s, i) => ({ updateSheetProperties: { properties: { sheetId: s.properties.sheetId, index: i }, fields: "index" } })); if(requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests } }); } catch(e){} }
async function updateDailySummary(sheetName) { try { const rows = await getSheetData(`${sheetName}!G2:G`); const totals = {}; rows.forEach(row => { if (!row[0]) return; row[0].split('\n').forEach(line => { const m = line.match(/(.+) x (\d+)$/); if (m) totals[m[1].trim()] = (totals[m[1].trim()] || 0) + parseInt(m[2]); }); }); const data = [['📦 ИТОГО', 'КОЛ-ВО'], ...Object.entries(totals)]; await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!N1`, valueInputOption: 'USER_ENTERED', resource: { values: data } }); } catch(e){} }
async function ensureDailySheet(sheetName) { try { const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }); if (!meta.data.sheets.some(s => s.properties.title === sheetName)) { const id = (await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] } })).data.replies[0].addSheet.properties.sheetId; await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [["Заказ", "Время", "Имя", "Телефон", "Адрес", "Тип", "Товары", "Сумма", "Статус", "Коммент", "UID"]] } }); } } catch(e){} }
async function updateCustomerDatabase(d) { try { await ensureClientsSheet(); const rows = await getSheetData(`${SHEET_CLIENTS}!A2:F`); const ph = d.phone.replace(/\D/g,''); let idx = rows.findIndex(r => (r[3]||"").replace(/\D/g,'').includes(ph)); if (idx > -1) await updateRow(`${SHEET_CLIENTS}!B${idx+2}:E${idx+2}`, [d.name, d.address, `="${d.phone}"`, d.items]); else await updateRow(`${SHEET_CLIENTS}!A${rows.length+2}`, [rows.length+1, d.name, d.address, `="${d.phone}"`, d.items, d.userId]); } catch(e){} }
async function ensureClientsSheet() { try { await getSheetData(`${SHEET_CLIENTS}!A1`); } catch(e) { await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [{ addSheet: { properties: { title: SHEET_CLIENTS } } }] } }); await updateRow(`${SHEET_CLIENTS}!A1`, [["№", "Имя", "Адрес", "Телефон", "Последний заказ", "ID"]]); } }

app.get('/ping', (req, res) => res.send('pong'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
