const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const NodeCache = require('node-cache');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const app = express();
const cache = new NodeCache({ stdTTL: 5 }); // Кэш на 5 секунд

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

// ==========================================
// 🛡️ АДМИН-ПАНЕЛЬ (ЧЕРЕЗ БОТА)
// ==========================================

// 1. Отчет за СЕГОДНЯ: /report
bot.onText(/\/report/, async (msg) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;
    const todayStr = getFormattedDate(new Date());
    await sendSummary(msg.chat.id, todayStr, "сегодня");
});

// 2. Отчет за ЗАВТРА: /report_tomorrow
bot.onText(/\/report_tomorrow/, async (msg) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomStr = getFormattedDate(tomorrow);
    await sendSummary(msg.chat.id, tomStr, "завтра");
});

async function sendSummary(chatId, dateStr, label) {
    try {
        bot.sendChatAction(chatId, 'typing');
        // Проверяем наличие листа
        const rows = await getSheetData(`${dateStr}!A2:H`);
        if (!rows.length) throw new Error("empty");

        const totalOrders = rows.length;
        // Суммируем 8-ю колонку (H), удаляя " ₽" и пробелы
        const totalCash = rows.reduce((sum, row) => {
            const val = row[7] ? parseFloat(row[7].replace(/[^\d.]/g, '')) : 0;
            return sum + val;
        }, 0);

        bot.sendMessage(chatId, 
            `📊 <b>Сводка на ${label} (${dateStr}):</b>\n\n` +
            `✅ Заказов: <b>${totalOrders}</b>\n` +
            `💰 Сумма: <b>${totalCash} ₽</b>`, 
            { parse_mode: 'HTML' }
        );
    } catch (e) {
        bot.sendMessage(chatId, `📅 На ${label} (${dateStr}) заказов пока нет.`);
    }
}

// 3. Добавление товара: /add_stock ID КОЛИЧЕСТВО
bot.onText(/\/add_stock (\d+) (\d+)/, async (msg, match) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;
    const prodId = match[1];
    const qtyToAdd = parseInt(match[2]);

    try {
        const rows = await getSheetData(`${SHEET_PRODUCTS}!A2:G`);
        const rowIndex = rows.findIndex(r => r[0] == prodId);
        
        if (rowIndex === -1) return bot.sendMessage(ADMIN_CHAT_ID, `❌ Товар с ID ${prodId} не найден.`);
        
        const currentStock = parseInt(rows[rowIndex][6]) || 0;
        const newStock = currentStock + qtyToAdd;
        const prodName = rows[rowIndex][2];
        
        // Обновляем ячейку G (7-я колонка)
        await updateRow(`${SHEET_PRODUCTS}!G${rowIndex + 2}`, [newStock]);
        
        cache.del("products"); // Сброс кэша
        bot.sendMessage(ADMIN_CHAT_ID, `✅ <b>Приход принят!</b>\n${prodName}\nБыло: ${currentStock} -> Стало: <b>${newStock}</b>`, {parse_mode: 'HTML'});
    } catch (e) {
        bot.sendMessage(ADMIN_CHAT_ID, `Ошибка: ${e.message}`);
    }
});


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
        
        const rows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
        const products = rows
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

// ⚡ НОВОЕ: Проверка остатков перед корзиной
app.post('/api/check_stock', async (req, res) => {
    const { cart } = req.body;
    try {
        // Берем свежие данные (без кэша или с минимальным)
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

            // 1. Получаем СВЕЖИЕ остатки
            const prodRows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
            const products = prodRows.map((row, i) => ({ 
                id: row[0], 
                name: row[2], 
                price: parseFloat(row[3]), 
                stock: parseInt(row[6]), 
                rowIndex: i + 2 
            }));

            let itemsList = []; 
            let totalSum = 0;

            // 2. Проверка и списание
            for (const item of cart) {
                const p = products.find(x => x.id === item.id);
                if (!p) throw new Error(`Товар ${item.id} не найден`);
                
                // Финальная проверка наличия
                if (p.stock < item.qty) {
                    throw new Error(`Товар "${p.name}" закончился (осталось ${p.stock}). Пожалуйста, обновите корзину.`);
                }

                itemsList.push(`${p.name} x ${item.qty}`); 
                totalSum += p.price * item.qty;
                
                // Вычисляем новый остаток
                const newStock = p.stock - item.qty;
                
                // Обновляем в Google Sheets
                await updateRow(`${SHEET_PRODUCTS}!G${p.rowIndex}`, [newStock]);

                // 🔔 НАПОМИНАЛКА АДМИНУ
                if (newStock <= 10) {
                    bot.sendMessage(ADMIN_CHAT_ID, `⚠️ <b>ЗАКАНЧИВАЕТСЯ ТОВАР!</b>\n📦 ${p.name}\nОстаток: <b>${newStock}</b> шт.`, {parse_mode: 'HTML'});
                }
            }

            // 3. Запись заказа (Логика создания листа с датой)
            const deliveryDateRaw = data.orderDetails.deliveryRaw; // ГГГГ-ММ-ДД
            let dateObj = new Date();
            // Если клиент выбрал дату доставки, используем её для имени листа, ИЛИ используем текущую дату оформления
            // *Обычно заказы пишут в лист той даты, КОГДА нужно доставить*
            if (deliveryDateRaw) dateObj = new Date(deliveryDateRaw);
            
            const targetSheetName = getFormattedDate(dateObj); // ДД.ММ.ГГГГ

            await ensureDailySheet(targetSheetName);
            const existingRows = await getSheetData(`${targetSheetName}!A:A`);
            const nextNum = String((existingRows.length === 0 ? 1 : existingRows.length)).padStart(3, '0');
            const typeLetter = (data.orderDetails.deliveryType === 'Самовывоз') ? 'С' : 'Д';
            const orderId = `${typeLetter}-${nextNum}`;
            
            const productsString = itemsList.join('\n');
            const nowTime = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }); // Укажите свой пояс

            await updateRow(`${targetSheetName}!A${existingRows.length + 1}`, [
                orderId, nowTime, 
                data.orderDetails.name, `="${data.orderDetails.phone}"`, 
                data.orderDetails.address, data.orderDetails.deliveryType, 
                productsString, totalSum + ' ₽', 
                'Новый', data.orderDetails.comment, userId
            ]);
            
            // Обновляем сводку и базу клиентов
            await updateDailySummary(targetSheetName);
            await sortSheetsByDate();
            await updateCustomerDatabase({ 
                name: data.orderDetails.name, 
                phone: data.orderDetails.phone, 
                address: data.orderDetails.address, 
                items: productsString, 
                userId: userId 
            });
            
            cache.del("products"); // Очищаем кэш

            // Уведомления
            const displayAddress = data.orderDetails.deliveryType === 'Самовывоз' ? "Самовывоз" : data.orderDetails.address;
            try { await bot.sendMessage(userId, `✅ <b>Заказ № ${orderId} оформлен!</b>\n\n💰 <b>Сумма:</b> ${totalSum} ₽`, { parse_mode: 'HTML' }); } catch (e) {}

            if (ENABLE_WORK_CHAT) {
                const keyboard = { inline_keyboard: [[{ text: '🍳 Готовим', callback_data: `status|${targetSheetName}|${orderId}|Готовится` }, { text: '🚀 В пути', callback_data: `status|${targetSheetName}|${orderId}|В пути` }], [{ text: '✅ Готов', callback_data: `status|${targetSheetName}|${orderId}|Готов` }], [{ text: '🏁 Выполнен', callback_data: `status|${targetSheetName}|${orderId}|Выполнен` }, { text: '❌ Отмена', callback_data: `status|${targetSheetName}|${orderId}|Отменен` }]] };
                try { await bot.sendMessage(ADMIN_CHAT_ID, `Новый заказ на <b>${targetSheetName}</b> 🔥\n\n<b>№ ${orderId}</b>\n👤 ${data.orderDetails.name}\n📞 ${data.orderDetails.phone}\n📍 ${displayAddress}\n🛒\n${itemsList.join('\n')}\n\nСумма: <b>${totalSum} ₽</b>`, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) {}
            }
            res.json({ status: 'success', orderId, message: `Заказ №${orderId} оформлен!` });
        }
    } catch (e) { 
        res.status(500).json({ status: 'error', message: "Ошибка: " + e.message }); 
    }
});

// Служебные функции для Sheets (сокращенные, как у вас были)
async function sortSheetsByDate() { try { const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }); const allSheets = meta.data.sheets; const dateSheets = []; const otherSheets = []; allSheets.forEach(s => { /^\d{2}\.\d{2}\.\d{4}$/.test(s.properties.title) ? dateSheets.push(s) : otherSheets.push(s); }); dateSheets.sort((a, b) => { const [d1, m1, y1] = a.properties.title.split('.'); const [d2, m2, y2] = b.properties.title.split('.'); return new Date(y1, m1-1, d1) - new Date(y2, m2-1, d2); }); const requests = [...otherSheets, ...dateSheets].map((s, i) => ({ updateSheetProperties: { properties: { sheetId: s.properties.sheetId, index: i }, fields: "index" } })); if(requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests } }); } catch(e){} }
async function updateDailySummary(sheetName) { try { const rows = await getSheetData(`${sheetName}!G2:G`); const totals = {}; rows.forEach(row => { if (!row[0]) return; row[0].split('\n').forEach(line => { const m = line.match(/(.+) x (\d+)$/); if (m) totals[m[1].trim()] = (totals[m[1].trim()] || 0) + parseInt(m[2]); }); }); const data = [['📦 ИТОГО', 'КОЛ-ВО'], ...Object.entries(totals)]; await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!N1`, valueInputOption: 'USER_ENTERED', resource: { values: data } }); } catch(e){} }
async function ensureDailySheet(sheetName) { try { const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }); if (!meta.data.sheets.some(s => s.properties.title === sheetName)) { const id = (await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] } })).data.replies[0].addSheet.properties.sheetId; await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [["Заказ", "Время", "Имя", "Телефон", "Адрес", "Тип", "Товары", "Сумма", "Статус", "Коммент", "UID"]] } }); } } catch(e){} }
async function updateCustomerDatabase(d) { try { await ensureClientsSheet(); const rows = await getSheetData(`${SHEET_CLIENTS}!A2:F`); const ph = d.phone.replace(/\D/g,''); let idx = rows.findIndex(r => (r[3]||"").replace(/\D/g,'').includes(ph)); if (idx > -1) await updateRow(`${SHEET_CLIENTS}!B${idx+2}:E${idx+2}`, [d.name, d.address, `="${d.phone}"`, d.items]); else await updateRow(`${SHEET_CLIENTS}!A${rows.length+2}`, [rows.length+1, d.name, d.address, `="${d.phone}"`, d.items, d.userId]); } catch(e){} }
async function ensureClientsSheet() { try { await getSheetData(`${SHEET_CLIENTS}!A1`); } catch(e) { await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [{ addSheet: { properties: { title: SHEET_CLIENTS } } }] } }); await updateRow(`${SHEET_CLIENTS}!A1`, [["№", "Имя", "Адрес", "Телефон", "Последний заказ", "ID"]]); } }

app.get('/ping', (req, res) => res.send('pong'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
