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
// Получаем URL из настроек Render (если есть)
const WEBHOOK_URL = process.env.WEBHOOK_URL; 

// --- ИНИЦИАЛИЗАЦИЯ БОТА (УМНАЯ) ---
let bot;
if (WEBHOOK_URL) {
    // Режим Webhook (для Render)
    console.log("🚀 Запуск в режиме WEBHOOK");
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
    bot.setWebHook(`${WEBHOOK_URL}/bot${TELEGRAM_BOT_TOKEN}`);
} else {
    // Режим Polling (для тестов на компьютере)
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

// --- ГЛАВНОЕ МЕНЮ БОТА ---
const mainMenuKeyboard = {
    reply_markup: {
        keyboard: [
            // 👇 СЮДА АВТОМАТИЧЕСКИ ПОДСТАВИТСЯ ВАША ССЫЛКА
            [{ text: '🛍 Сделать заказ', web_app: { url: WEBHOOK_URL || 'https://google.com' } }], 
            [{ text: '🚚 Где мой заказ?' }, { text: '👤 Мой профиль' }],
            [{ text: '📞 Поддержка' }]
        ],
        resize_keyboard: true
    }
};

// --- ОБРАБОТКА КОМАНД БОТА ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, `👋 Привет, ${msg.from.first_name}! \nЯ готов принять заказ.`, mainMenuKeyboard);
});

bot.onText(/📞 Поддержка/, (msg) => {
    bot.sendMessage(msg.chat.id, "Есть вопросы? Пишите нашему менеджеру: @ВАШ_ЮЗЕРНЕЙМ");
});

bot.onText(/🚚 Где мой заказ\?/, async (msg) => {
    const userId = msg.from.id;
    const now = new Date();
    const d = String(now.getDate()).padStart(2, '0');
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const y = now.getFullYear();
    const sheetName = `${d}.${m}.${y}`;

    bot.sendChatAction(userId, 'typing');

    try {
        const rows = await getSheetData(`${sheetName}!A:K`);
        const myOrder = rows.reverse().find(row => row[10] && String(row[10]) === String(userId));

        if (myOrder) {
            const orderId = myOrder[0];
            const status = myOrder[8];
            const items = myOrder[6];
            let statusEmoji = "🕒";
            if (status === 'Готовится') statusEmoji = "👨‍🍳";
            if (status === 'В пути') statusEmoji = "🚗";
            if (status === 'Готов') statusEmoji = "✅";
            if (status === 'Выполнен') statusEmoji = "🏁";

            bot.sendMessage(userId, 
                `📦 <b>Заказ № ${orderId}</b>\n` +
                `Статус: <b>${status} ${statusEmoji}</b>\n\n` +
                `Состав:\n${items}`, 
                { parse_mode: 'HTML' }
            );
        } else {
            bot.sendMessage(userId, "Сегодня активных заказов не найдено. 🤷‍♂️");
        }
    } catch (e) {
        bot.sendMessage(userId, "Пока заказов нет или магазин закрыт.");
    }
});

bot.onText(/👤 Мой профиль/, async (msg) => {
    const userId = msg.from.id;
    bot.sendChatAction(userId, 'typing');
    try {
        await ensureClientsSheet();
        const rows = await getSheetData(`${SHEET_CLIENTS}!A:F`);
        const client = rows.find(row => row[5] && String(row[5]) === String(userId));
        if (client) {
            const name = client[1];
            const address = client[2];
            const phone = client[3].replace('="', '').replace('"', '');
            const lastOrder = client[4];
            bot.sendMessage(userId, 
                `👤 <b>Ваш профиль:</b>\n\n` +
                `🏷 Имя: ${name}\n` +
                `📱 Телефон: ${phone}\n` +
                `📍 Адрес: ${address}\n\n` +
                `📜 <b>Последний заказ:</b>\n${lastOrder}`,
                { parse_mode: 'HTML' }
            );
        } else {
            bot.sendMessage(userId, "Мы пока не знакомы! Сделайте первый заказ.");
        }
    } catch (e) { console.error(e); }
});

// --- ХЕЛПЕРЫ GOOGLE SHEETS ---
async function getSheetData(range) {
    try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
        return response.data.values || [];
    } catch (e) { return []; }
}
async function updateRow(range, values) {
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range, valueInputOption: 'USER_ENTERED', resource: { values: [values] } });
}

// --- ОБРАБОТКА КНОПОК ---
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;

    if (data.startsWith('rate|')) {
        const [_, stars, orderId] = data.split('|');
        bot.answerCallbackQuery(query.id, { text: `Спасибо за оценку!` });
        bot.editMessageText(`✅ Спасибо! Вы поставили ${stars}⭐ заказу ${orderId}`, { chat_id: userId, message_id: query.message.message_id });
        if (ENABLE_WORK_CHAT && parseInt(stars) <= 3) {
             bot.sendMessage(ADMIN_CHAT_ID, `⚠️ <b>ПЛОХОЙ ОТЗЫВ!</b>\nКлиент поставил ${stars}⭐ заказу ${orderId}.\nНадо связаться!`, { parse_mode: 'HTML' });
        }
        return;
    }

    try {
        const [action, sheetName, orderId, newStatus] = data.split('|');
        if (action === 'status') {
            const rows = await getSheetData(`${sheetName}!A:K`);
            const rowIndex = rows.findIndex(row => row[0] == orderId);
            if (rowIndex === -1) return;
            const sheetRow = rowIndex + 1;
            const clientUserId = rows[rowIndex][10]; 
            await updateRow(`${sheetName}!I${sheetRow}`, [newStatus]);

            let userNotifyText = "";
            let askFeedback = false;
            if (newStatus === 'Готовится') userNotifyText = `👨‍🍳 Ваш заказ <b>${orderId}</b> начал готовиться!`;
            if (newStatus === 'В пути') userNotifyText = `🚗 Ваш заказ <b>${orderId}</b> передан курьеру!`;
            if (newStatus === 'Готов') userNotifyText = `✅ Ваш заказ <b>${orderId}</b> готов к выдаче!`;
            if (newStatus === 'Выполнен') { userNotifyText = `🎉 Заказ <b>${orderId}</b> доставлен!`; askFeedback = true; }
            if (newStatus === 'Отменен') userNotifyText = `❌ Ваш заказ <b>${orderId}</b> был отменен.`;

            if (clientUserId && userNotifyText) {
                try {
                    await bot.sendMessage(clientUserId, userNotifyText, { parse_mode: 'HTML' });
                    if (askFeedback) {
                        setTimeout(async () => {
                            await bot.sendMessage(clientUserId, "Как вам заказ? Оцените нас:", {
                                reply_markup: { inline_keyboard: [[{ text: '⭐ 1', callback_data: `rate|1|${orderId}` }, { text: '⭐ 5', callback_data: `rate|5|${orderId}` }]] }
                            });
                        }, 2000);
                    }
                } catch (e) {}
            }
            await bot.answerCallbackQuery(query.id, { text: `Статус: ${newStatus}` });
        }
    } catch (e) { console.error("Callback Error", e); }
});

// --- GOOGLE SHEETS UTILS (Сокращено для краткости) ---
async function sortSheetsByDate() { try { const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }); const allSheets = meta.data.sheets; const otherSheets = []; const dateSheets = []; allSheets.forEach(sheet => { if (/^\d{2}\.\d{2}\.\d{4}$/.test(sheet.properties.title)) dateSheets.push(sheet); else otherSheets.push(sheet); }); dateSheets.sort((a, b) => parseDate(a.properties.title) - parseDate(b.properties.title)); const sortedSheets = [...otherSheets, ...dateSheets]; const requests = []; sortedSheets.forEach((sheet, index) => { if (sheet.properties.index !== index) requests.push({ updateSheetProperties: { properties: { sheetId: sheet.properties.sheetId, index: index }, fields: "index" } }); }); if (requests.length > 0) await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests } }); } catch (e) {} }
function parseDate(str) { const parts = str.split('.'); return new Date(parts[2], parts[1] - 1, parts[0]); }
async function updateDailySummary(sheetName) { try { const rows = await getSheetData(`${sheetName}!G2:G`); const totals = {}; rows.forEach(row => { if (!row[0]) return; const lines = row[0].split('\n'); lines.forEach(line => { const match = line.match(/(.+) x (\d+)$/); if (match) { const name = match[1].trim(); const qty = parseInt(match[2], 10); if (!totals[name]) totals[name] = 0; totals[name] += qty; } }); }); const summaryData = [['📦 ИТОГО НА ДЕНЬ', 'КОЛ-ВО']]; for (const [name, qty] of Object.entries(totals)) summaryData.push([name, qty]); await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!N1:O100` }); await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!N1`, valueInputOption: 'USER_ENTERED', resource: { values: summaryData } }); } catch (e) {} }
async function ensureDailySheet(sheetName) { try { const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }); const sheetExists = meta.data.sheets.some(s => s.properties.title === sheetName); if (!sheetExists) { const createRes = await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [{ addSheet: { properties: { title: sheetName } } }] } }); const newSheetId = createRes.data.replies[0].addSheet.properties.sheetId; await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [ { repeatCell: { range: { sheetId: newSheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat" } }, { updateSheetProperties: { properties: { sheetId: newSheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } } ]}}); const headers = ["Заказ", "Оформлен", "Имя", "Телефон", "Адрес", "Тип доставки", "Товары", "Сумма", "Статус", "Комментарий", "User ID"]; await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${sheetName}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [headers] } }); } } catch (e) {} }
async function ensureClientsSheet() { try { const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }); if (!meta.data.sheets.some(s => s.properties.title === SHEET_CLIENTS)) { await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [{ addSheet: { properties: { title: SHEET_CLIENTS } } }] } }); await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_CLIENTS}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [["№", "Имя", "Адрес", "Номер телефона", "Последний заказ", "User ID"]] } }); } } catch (e) {} }
async function updateCustomerDatabase(customerData) { try { await ensureClientsSheet(); const rows = await getSheetData(`${SHEET_CLIENTS}!A2:F`); const phoneToFind = customerData.phone.replace(/\D/g, ''); let foundIndex = -1; for (let i = 0; i < rows.length; i++) { const cellVal = rows[i][3] || ""; if (cellVal.replace(/\D/g, '').includes(phoneToFind)) { foundIndex = i; break; } } const formattedPhone = `="${customerData.phone}"`; const userIdVal = customerData.userId || ""; if (foundIndex !== -1) { const sheetRow = foundIndex + 2; const currentName = rows[foundIndex][1]; await updateRow(`${SHEET_CLIENTS}!B${sheetRow}:F${sheetRow}`, [currentName, customerData.address, formattedPhone, customerData.items, userIdVal]); } else { const newRowIndex = rows.length + 2; await updateRow(`${SHEET_CLIENTS}!A${newRowIndex}`, [rows.length + 1, customerData.name, customerData.address, formattedPhone, customerData.items, userIdVal]); } } catch (e) {} }
function calculateOrderTotals(cart, products) { let totalItemsAmount = 0; cart.forEach(item => { const product = products.find(p => p.id === item.id); if (product) totalItemsAmount += product.price * item.qty; }); return { totalItemsAmount, finalTotal: totalItemsAmount }; }

// --- API ROUTES ---
// ⚠️ САМОЕ ВАЖНОЕ: Маршрут для Webhook от Телеграма
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// ... (API get_products и action остались как были, я их не менял)
app.get('/api/get_products', async (req, res) => { try { const cached = cache.get("products"); if (cached) return res.json(cached); const rows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`); const products = rows.filter(row => row[7] === 'TRUE' || row[7] === 'Да' || row[7] === true).map((row, index) => ({ id: row[0], category: row[1], name: row[2], price: parseFloat(row[3]) || 0, description: row[4], imageUrl: row[5], stock: parseInt(row[6]) || 0, rowIndex: index + 2 })); const response = { status: 'success', products }; cache.set("products", response); res.json(response); } catch (error) { res.status(500).json({ status: 'error', message: error.message }); } });
app.post('/api/action', async (req, res) => {
    const { action, userId, ...data } = req.body;
    try {
        if (action === 'place_order') {
            const cart = data.cart; 
            if (!cart || !cart.length) throw new Error("Корзина пуста");
            const prodRows = await getSheetData(`${SHEET_PRODUCTS}!A2:I`);
            const products = prodRows.map((row, i) => ({ id: row[0], name: row[2], price: parseFloat(row[3]), stock: parseInt(row[6]), rowIndex: i + 2 }));
            let itemsList = []; let totalSum = 0;
            for (const item of cart) {
                const p = products.find(x => x.id === item.id);
                if (!p) throw new Error("Товар не найден");
                itemsList.push(`${p.name} x ${item.qty}`); totalSum += p.price * item.qty;
                if (p.stock > 0) await updateRow(`${SHEET_PRODUCTS}!G${p.rowIndex}`, [p.stock - item.qty]);
            }
            const now = new Date();
            const targetSheetName = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;
            await ensureDailySheet(targetSheetName);
            const existingRows = await getSheetData(`${targetSheetName}!A:A`);
            const nextNum = String((existingRows.length === 0 ? 1 : existingRows.length)).padStart(3, '0');
            const typeLetter = (data.orderDetails.deliveryType === 'Самовывоз') ? 'С' : 'Д';
            const orderId = `${typeLetter}-${nextNum}`;
            const totals = calculateOrderTotals(cart, products);
            const productsString = itemsList.join('\n');
            const nowTime = now.toLocaleString("ru-RU", { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

            await updateRow(`${targetSheetName}!A${existingRows.length + 1}`, [orderId, nowTime, data.orderDetails.name, `="${data.orderDetails.phone}"`, data.orderDetails.address, data.orderDetails.deliveryType, productsString, totals.finalTotal + ' ₽', 'Новый', data.orderDetails.comment, userId]);
            await updateDailySummary(targetSheetName);
            await sortSheetsByDate();
            await updateCustomerDatabase({ name: data.orderDetails.name, phone: data.orderDetails.phone, address: data.orderDetails.address, items: productsString, userId: userId });
            
            cache.del("products");

            const displayAddress = data.orderDetails.deliveryType === 'Самовывоз' ? "Самовывоз" : data.orderDetails.address;
            try { await bot.sendMessage(userId, `✅ <b>Заказ № ${orderId} оформлен!</b>\n\n💰 <b>Сумма:</b> ${totals.finalTotal} ₽\n🚚 <b>Тип:</b> ${displayAddress}`, { parse_mode: 'HTML' }); } catch (e) {}

            if (ENABLE_WORK_CHAT) {
                const keyboard = { inline_keyboard: [[{ text: '🍳 Готовим', callback_data: `status|${targetSheetName}|${orderId}|Готовится` }, { text: '🚀 В пути', callback_data: `status|${targetSheetName}|${orderId}|В пути` }], [{ text: '✅ Готов', callback_data: `status|${targetSheetName}|${orderId}|Готов` }], [{ text: '🏁 Выполнен', callback_data: `status|${targetSheetName}|${orderId}|Выполнен` }, { text: '❌ Отмена', callback_data: `status|${targetSheetName}|${orderId}|Отменен` }]] };
                try { await bot.sendMessage(ADMIN_CHAT_ID, `Новый заказ 🔥\n\n<b>№ ${orderId}</b>\n\n👤 ${data.orderDetails.name}\n📞 ${data.orderDetails.phone}\n📍 ${displayAddress}\n🛒 <b>Товары:</b>\n${itemsList.join('\n')}\n\nСумма: <b>${totals.finalTotal} ₽</b>`, { parse_mode: 'HTML', reply_markup: keyboard }); } catch (e) {}
            }
            res.json({ status: 'success', orderId, message: `Заказ №${orderId} оформлен!` });
        }
    } catch (e) { res.status(500).json({ status: 'error', message: "Ошибка: " + e.message }); }
});

app.get('/ping', (req, res) => res.send('pong'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
