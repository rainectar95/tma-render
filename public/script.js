const tg = window.Telegram.WebApp;
tg.expand();

// ==========================================
// ⚙️ НАСТРОЙКИ
// ==========================================
const IS_LOCAL_MODE = false; // Ставим false для деплоя
const API_URL = '';
const userId = tg.initDataUnsafe?.user?.id || 'test_user_777';

// --- ЗАГЛУШКИ (для локального теста) ---
const MOCK_PRODUCTS = [
    { id: '1', name: 'Лаваш Тонкий', price: 60, stock: 100, imageUrl: 'https://via.placeholder.com/150', description: 'Армянский лаваш, 10 шт' },
    { id: '2', name: 'Сыр Чанах', price: 450, stock: 20, imageUrl: 'https://via.placeholder.com/150', description: 'Рассольный сыр, 500г' },
];

let state = {
    products: [],
    cart: [],
    totals: { finalTotal: 0, deliveryCost: 0, totalQty: 0 }
};

// Очередь запросов (чтобы не путать сервер частыми кликами)
let syncQueue = Promise.resolve();

// --- ИНИЦИАЛИЗАЦИЯ ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Настройка даты
    const dateInput = document.getElementById('custom-date');
    if (dateInput) {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        dateInput.min = tomorrow.toISOString().split('T')[0];
    }

    // 2. Имя пользователя
    if (tg.initDataUnsafe?.user) {
        const u = tg.initDataUnsafe.user;
        const nameField = document.getElementById('name');
        if (nameField) nameField.value = [u.first_name, u.last_name].join(' ').trim();
    }

    // 3. МГНОВЕННАЯ ЗАГРУЗКА ИЗ КЭША
    // Сначала показываем то, что сохранили в прошлый раз
    const cachedProducts = localStorage.getItem('shop_products');
    if (cachedProducts) {
        try {
            state.products = JSON.parse(cachedProducts);
            renderProducts(); // Сразу рисуем!
            console.log('📦 Loaded from cache');
        } catch (e) {}
    }

    // 4. Фоновая загрузка свежих данных
    await Promise.all([loadProducts(), loadCart()]);

    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display = 'block';
});

// --- UI НАВИГАЦИЯ ---
function toggleDateInput() {
    const select = document.getElementById('date-select');
    const container = document.getElementById('custom-date-container');
    if (select && container) {
        select.value === 'custom' ? container.classList.remove('hidden') : container.classList.add('hidden');
    }
}

function showCatalog() {
    switchView('catalog');
}

function showCart() {
    switchView('cart');
}

function switchView(viewName) {
    const catalogView = document.getElementById('catalog-view');
    const cartView = document.getElementById('cart-view');
    const navCatalog = document.getElementById('nav-catalog');
    const navCart = document.getElementById('nav-cart');
    const title = document.getElementById('page-title');

    if (viewName === 'catalog') {
        catalogView.classList.remove('hidden');
        cartView.classList.add('hidden');
        title.innerText = 'Каталог продукции';
        navCatalog.classList.add('active');
        navCart.classList.remove('active');
        renderProducts(); // Перерисовка кнопок
    } else {
        catalogView.classList.add('hidden');
        cartView.classList.remove('hidden');
        title.innerText = 'Корзина';
        navCatalog.classList.remove('active');
        navCart.classList.add('active');
        renderCart();
    }
}

// --- ЛОГИКА ДАННЫХ ---

async function loadProducts() {
    try {
        if (IS_LOCAL_MODE) {
            state.products = MOCK_PRODUCTS;
        } else {
            const res = await fetch(`${API_URL}/api/get_products`);
            const data = await res.json();
            if (data.products) {
                state.products = data.products;
                // Сохраняем в память телефона для следующего раза
                localStorage.setItem('shop_products', JSON.stringify(state.products));
            }
        }
        renderProducts();
    } catch (e) {
        console.error("Ошибка загрузки товаров", e);
    }
}

async function loadCart() {
    try {
        if (IS_LOCAL_MODE) {
            state.cart = [];
            calculateTotals();
        } else {
            const res = await fetch(`${API_URL}/api/get_cart?userId=${userId}`);
            const data = await res.json();
            if (data.cart) {
                state.cart = data.cart;
                // Пересчитываем итоги локально, чтобы убедиться, что цифры верные
                calculateTotals(); 
                updateCartUI();
            }
        }
    } catch (e) { console.error(e); }
}

// 🔥 ГЛАВНАЯ ФУНКЦИЯ УСКОРЕНИЯ 🔥
async function changeQty(itemId, delta) {
    tg.HapticFeedback.selectionChanged(); // Приятная вибрация

    // 1. Проверка ограничений (Сток)
    const product = state.products.find(p => p.id === itemId);
    const cartItem = state.cart.find(i => i.id === itemId);
    const currentQty = cartItem ? cartItem.qty : 0;
    const newQty = currentQty + delta;

    // Если пытаемся купить больше, чем есть на складе
    if (product && product.stock > 0 && newQty > product.stock) {
        tg.showAlert(`Доступно всего ${product.stock} шт.`);
        return;
    }
    // Нельзя меньше 0 (но 0 можно = удаление)
    if (newQty < 0) return;

    // 2. ОПТИМИСТИЧНОЕ ОБНОВЛЕНИЕ (Мгновенно меняем State)
    if (cartItem) {
        cartItem.qty = newQty;
        if (cartItem.qty <= 0) {
            state.cart = state.cart.filter(i => i.id !== itemId);
        }
    } else if (newQty > 0) {
        state.cart.push({ id: itemId, qty: newQty });
    }

    // 3. МГНОВЕННО ПЕРЕРИСОВЫВАЕМ ИНТЕРФЕЙС
    calculateTotals(); // Пересчитать деньги
    updateCartUI();    // Обновить шапку/футер
    
    // Перерисовываем только нужные части, чтобы не мигало
    // Если мы в корзине - обновляем корзину
    if (!document.getElementById('cart-view').classList.contains('hidden')) {
        renderCart();
    } else {
        renderProducts(); // Если в каталоге - кнопки каталога
    }

    // 4. ОТПРАВЛЯЕМ НА СЕРВЕР (В ФОНЕ)
    if (IS_LOCAL_MODE) return;

    // Добавляем запрос в очередь, чтобы они шли по порядку
    syncQueue = syncQueue.then(async () => {
        try {
            await fetch(`${API_URL}/api/action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'add_to_cart',
                    userId: userId,
                    itemId: itemId,
                    quantity: delta // Отправляем +1 или -1
                })
            });
            // Ответ сервера нам особо не нужен, мы уже все нарисовали сами
        } catch (e) {
            console.error("Ошибка синхронизации с сервером", e);
            // В идеале тут можно показать маленькую ошибку, но пока пропустим
        }
    });
}

async function removeItem(itemId) {
    const item = state.cart.find(i => i.id === itemId);
    if (item) {
        // Удаляем сразу всё количество
        await changeQty(itemId, -item.qty);
    }
}

async function submitOrder() {
    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;
    const address = document.getElementById('address').value;
    const deliveryType = document.getElementById('delivery-type').value;
    const comment = document.getElementById('comment').value;

    let dateVal = document.getElementById('date-select').value;
    if (dateVal === 'custom') {
        const rawDate = document.getElementById('custom-date').value;
        if (!rawDate && !IS_LOCAL_MODE) return tg.showAlert("Выберите дату");
        if (rawDate) dateVal = formatSmartDate(rawDate);
    }

    if (IS_LOCAL_MODE) {
        tg.showAlert(`🔶 [LOCAL] Заказ оформлен!`);
        state.cart = [];
        calculateTotals();
        updateCartUI();
        renderProducts();
        showCatalog();
        return;
    }

    if (!name || !phone || !address) return tg.showAlert("Заполните Имя, Телефон и Адрес");

    tg.MainButton.showProgress();
    try {
        const res = await fetch(`${API_URL}/api/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'place_order',
                userId: userId,
                orderDetails: { name, phone, address, deliveryType, deliveryDate: dateVal, comment }
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            tg.showAlert(data.message);
            tg.close();
        } else {
            tg.showAlert(data.message);
        }
    } catch (e) {
        tg.showAlert("Ошибка заказа");
    } finally {
        tg.MainButton.hideProgress();
    }
}

// --- ЛОКАЛЬНЫЙ РАСЧЕТ ИТОГОВ ---
// Эта функция теперь работает ВСЕГДА (и в local, и в production)
function calculateTotals() {
    let totalItemsAmount = 0;
    let totalQty = 0;
    
    state.cart.forEach(item => {
        const product = state.products.find(p => p.id === item.id);
        if (product) {
            totalItemsAmount += product.price * item.qty;
            totalQty += item.qty;
        }
    });

    const FREE_THRESHOLD = 5000;
    const BASE_COST = 300;
    const deliveryCost = (totalItemsAmount >= FREE_THRESHOLD || totalItemsAmount === 0) ? 0 : BASE_COST;

    state.totals = {
        totalItemsAmount,
        deliveryCost,
        finalTotal: totalItemsAmount + deliveryCost,
        totalQty
    };
}

// --- ОТРИСОВКА ---

function updateCartUI() {
    const delCostElem = document.getElementById('delivery-cost');
    const totalElem = document.getElementById('total-price');
    const badge = document.getElementById('cart-badge');

    // Безопасное обновление (если элементов нет на странице)
    if (delCostElem) delCostElem.innerText = `${state.totals.deliveryCost} ₽`;
    if (totalElem) totalElem.innerText = `${state.totals.finalTotal} ₽`;
    
    if (badge) {
        if (state.totals.totalQty > 0) {
            badge.innerText = state.totals.totalQty;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }
}

function renderProducts() {
    const container = document.getElementById('product-list');
    if (!container) return;
    container.innerHTML = '';

    state.products.forEach(p => {
        const cartItem = state.cart.find(item => item.id === p.id);
        const qty = cartItem ? cartItem.qty : 0;
        const imgUrl = p.imageUrl || 'https://via.placeholder.com/150';
        const details = p.stock === 0 ? '<span style="color:red">Нет в наличии</span>' : (p.description || '');

        const card = document.createElement('div');
        card.className = 'product-card';

        let buttonHtml = '';
        if (p.stock === 0 && !IS_LOCAL_MODE) {
            buttonHtml = `<button class="btn-add" disabled style="opacity:0.5; background:#ccc; color:#000">Нет товара</button>`;
        } else if (qty === 0) {
            buttonHtml = `<button class="btn-add" onclick="changeQty('${p.id}', 1)">В корзину</button>`;
        } else {
            buttonHtml = `
                <div class="qty-control">
                    <button class="btn-qty" onclick="changeQty('${p.id}', -1)">−</button>
                    <span class="qty-val">${qty}</span>
                    <button class="btn-qty" onclick="changeQty('${p.id}', 1)">+</button>
                </div>`;
        }

        card.innerHTML = `
            <div class="img-frame"><img src="${imgUrl}" class="product-img" alt="${p.name}"></div>            
            <div class="product-price">${p.price} ₽</div>
            <div class="product-name">${p.name}</div>
            <div class="product-details">${details}</div>
            ${buttonHtml}`;
        container.appendChild(card);
    });
}

function renderCart() {
    const container = document.getElementById('cart-items-list');
    if (!container) return;

    if (state.cart.length === 0) {
        container.innerHTML = `<div class="empty-block"><p class="free-cart">Корзина пуста</p></div>`;
        return;
    }

    container.innerHTML = state.cart.map(item => {
        const product = state.products.find(p => p.id === item.id);
        if (!product) return '';
        const imgUrl = product.imageUrl || 'https://via.placeholder.com/150';
        const lineTotal = product.price * item.qty;

        return `
        <div class="cart-block">
            <div class="cart-item">
                <div class="card-img-container"><img src="${imgUrl}" class="cart-item-img" alt="${product.name}"></div>
                <div class="cart-item-info">
                    <div class="card-item-block">
                        <div class="cart-item-name">${product.name}</div>
                        <div class="cart-item-description">${product.description || ''}</div>
                    </div>
                    <div class="cart-item-price">${lineTotal} ₽</div>
                </div>
            </div>
            <div class="cart-counter">
                <div class="qty-control-cart">
                    <button class="btn-qty" onclick="changeQty('${item.id}', -1)">−</button>
                    <span class="qty-val">${item.qty}</span>
                    <button class="btn-qty" onclick="changeQty('${item.id}', 1)">+</button>
                </div>
                <span class="remove-item-btn" onclick="removeItem('${item.id}')">Удалить</span>
            </div>
        </div>`;
    }).join('');
}

// --- ФОРМАТИРОВАНИЕ ДАТ ---
function updatePrettyDate(dateInput) {
    const displayInput = document.getElementById('date-display');
    const rawDate = dateInput.value;
    displayInput.value = rawDate ? formatSmartDate(rawDate) : '';
}

function formatSmartDate(isoDateString) {
    if (!isoDateString) return '';
    const dateObj = new Date(isoDateString + 'T12:00:00');
    
    const weekDays = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const monthsGenitive = ['Января', 'Февраля', 'Марта', 'Апреля', 'Мая', 'Июня', 'Июля', 'Августа', 'Сентября', 'Октября', 'Ноября', 'Декабря'];

    const dayName = weekDays[dateObj.getDay()];
    const dayNum = dateObj.getDate();
    const monthName = monthsGenitive[dateObj.getMonth()];
    const baseString = `${dayName}, ${dayNum} ${monthName}`;
    return baseString;
}

// --- EXPORT ---
window.updatePrettyDate = updatePrettyDate;
window.removeItem = removeItem;
window.toggleDateInput = toggleDateInput;
window.changeQty = changeQty;
window.submitOrder = submitOrder;
window.showCatalog = showCatalog;
window.showCart = showCart;
