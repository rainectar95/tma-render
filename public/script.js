const tg = window.Telegram.WebApp;
tg.expand();

// ==========================================
// ⚙️ НАСТРОЙКИ РЕЖИМА РАЗРАБОТКИ
// ==========================================
// Поставьте true, чтобы верстать локально без сервера.
// Поставьте false перед тем, как заливать на GitHub/Render!
const IS_LOCAL_MODE = false;
// ==========================================


const API_URL = '';
const userId = tg.initDataUnsafe?.user?.id || 'test_user_777';

// --- ЗАГЛУШКИ ДАННЫХ (MOCK DATA) ---
const MOCK_PRODUCTS = [
    { id: '1', name: 'Лаваш Тонкий (Тест)', price: 60, stock: 100, imageUrl: 'https://www.belshashlik.ru/media/cache/81/fb/81fb248b879135638a12721f16d1d826.jpg', description: 'Армянский лаваш, 10 шт' },
    { id: '2', name: 'Сыр Чанах (Тест)', price: 450, stock: 20, imageUrl: 'https://eda-opt.ru/wa-data/public/shop/products/67/15/1567/images/850/850.750x0.jpg', description: 'Рассольный сыр, 500г' },
    { id: '3', name: 'Бастурма (Тест)', price: 1200, stock: 5, imageUrl: 'https://cdn.lifehacker.ru/wp-content/uploads/2022/10/308_1665068046-1800x900.jpg', description: 'Вяленая говядина' },
    { id: '4', name: 'Вода Джермук (Тест)', price: 80, stock: 50, imageUrl: 'https://bestwine24.ru/storage/optimized/product/voda/94b2b969d57206df8d51a298fdcd836b_67fd12090d875_600x800.webp', description: 'Минеральная вода 0.5л' },
    { id: '5', name: 'Суджук (Тест)', price: 950, stock: 0, imageUrl: 'https://avatars.mds.yandex.net/get-eda/3798638/2e4f3381b5cde0cf90f70225436b2db2/orig', description: 'Нет в наличии' },
];

// Состояние приложения
let state = {
    products: [],
    cart: [],
    totals: { finalTotal: 0, deliveryCost: 0, totalQty: 0 }
};

// --- ИНИЦИАЛИЗАЦИЯ ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Настройка минимальной даты (Завтра)
    const dateInput = document.getElementById('custom-date');
    if (dateInput) {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const minDateStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD
        dateInput.min = minDateStr;
    }

    // 2. Предзаполнение имени
    if (tg.initDataUnsafe?.user) {
        const u = tg.initDataUnsafe.user;
        const nameField = document.getElementById('name');
        if (nameField) nameField.value = [u.first_name, u.last_name].join(' ').trim();
    }

    // 3. Загрузка данных
    await loadProducts();
    await loadCart();

    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display = 'block';
});

// --- UI ЛОГИКА ---

function toggleDateInput() {
    const select = document.getElementById('date-select');
    const container = document.getElementById('custom-date-container');
    if (select.value === 'custom') {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }
}

function showCatalog() {
    document.getElementById('catalog-view').classList.remove('hidden');
    document.getElementById('cart-view').classList.add('hidden');
    document.getElementById('page-title').innerText = 'Каталог продукции';
    document.getElementById('nav-catalog').classList.add('active');
    document.getElementById('nav-cart').classList.remove('active');
    renderProducts();
}

function showCart() {
    document.getElementById('catalog-view').classList.add('hidden');
    document.getElementById('cart-view').classList.remove('hidden');
    document.getElementById('page-title').innerText = 'Корзина';
    document.getElementById('nav-catalog').classList.remove('active');
    document.getElementById('nav-cart').classList.add('active');
    renderCart();
}

// --- API И ДАННЫЕ ---

async function loadProducts() {
    try {
        if (IS_LOCAL_MODE) {
            console.log('🔶 [LOCAL] Loading Mock Products');
            state.products = MOCK_PRODUCTS;
        } else {
            const res = await fetch(`${API_URL}/api/get_products`);
            const data = await res.json();
            if (data.products) state.products = data.products;
        }
        renderProducts();
    } catch (e) {
        tg.showAlert("Ошибка загрузки товаров");
        console.error(e);
    }
}

async function loadCart() {
    try {
        if (IS_LOCAL_MODE) {
            state.cart = [];
            calculateLocalTotals();
        } else {
            const res = await fetch(`${API_URL}/api/get_cart?userId=${userId}`);
            const data = await res.json();
            if (data.cart) {
                state.cart = data.cart;
                state.totals = data.totals;
                updateCartUI();
            }
        }
    } catch (e) { console.error(e); }
}

async function changeQty(itemId, delta) {
    tg.HapticFeedback.selectionChanged();

    if (IS_LOCAL_MODE) {
        let cartItem = state.cart.find(i => i.id === itemId);
        if (cartItem) {
            cartItem.qty += delta;
            if (cartItem.qty <= 0) state.cart = state.cart.filter(i => i.id !== itemId);
        } else if (delta > 0) {
            state.cart.push({ id: itemId, qty: delta });
        }
        calculateLocalTotals();
        updateCartUI();
        renderProducts();
        renderCart();
        return;
    }

    // Серверная логика
    try {
        const res = await fetch(`${API_URL}/api/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'add_to_cart',
                userId: userId,
                itemId: itemId,
                quantity: delta
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            state.cart = data.newCart;
            state.totals = data.newTotals;
            updateCartUI();
            renderProducts();
            renderCart();
        }
    } catch (e) {
        tg.showAlert("Ошибка соединения");
    }
}

async function removeItem(itemId) {
    const item = state.cart.find(i => i.id === itemId);
    if (item) {
        await changeQty(itemId, -item.qty);
    }
}

async function submitOrder() {
    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;
    const address = document.getElementById('address').value;
    const deliveryType = document.getElementById('delivery-type').value;
    const comment = document.getElementById('comment').value;

    // Логика даты
    let dateVal = document.getElementById('date-select').value;
    if (dateVal === 'custom') {
        const rawDate = document.getElementById('custom-date').value;
        if (!rawDate && !IS_LOCAL_MODE) return tg.showAlert("Выберите дату в календаре");
        if (rawDate) dateVal = formatSmartDate(rawDate);
    }

    if (IS_LOCAL_MODE) {
        tg.showAlert(`🔶 [LOCAL] Заказ оформлен!\n📅 Дата: ${dateVal}`);
        state.cart = [];
        calculateLocalTotals();
        updateCartUI();
        renderProducts();
        renderCart();
        showCatalog();
        return;
    }

    if (!name || !phone || !address) return tg.showAlert("Заполните имя, телефон и адрес");

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
        tg.showAlert("Ошибка при оформлении");
    } finally {
        tg.MainButton.hideProgress();
    }
}

function calculateLocalTotals() {
    let totalItemsAmount = 0;
    let totalQty = 0;
    state.cart.forEach(item => {
        const product = state.products.find(p => p.id === item.id);
        if (product) {
            totalItemsAmount += product.price * item.qty;
            totalQty += item.qty;
        }
    });
    const deliveryCost = (totalItemsAmount >= 5000 || totalItemsAmount === 0) ? 0 : 300; // Локальный расчет доставки
    state.totals = { totalItemsAmount, deliveryCost, finalTotal: totalItemsAmount + deliveryCost, totalQty };
}

// --- ОТРИСОВКА ---

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

function updateCartUI() {
    const delCostElem = document.getElementById('delivery-cost');
    const totalElem = document.getElementById('total-price');
    const badge = document.getElementById('cart-badge');

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

// --- ФОРМАТИРОВАНИЕ ДАТ ---

function updatePrettyDate(dateInput) {
    const displayInput = document.getElementById('date-display');
    const rawDate = dateInput.value;
    if (rawDate) {
        displayInput.value = formatSmartDate(rawDate);
    } else {
        displayInput.value = '';
    }
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

// --- ЭКСПОРТ ФУНКЦИЙ ---
window.updatePrettyDate = updatePrettyDate;
window.removeItem = removeItem;
window.toggleDateInput = toggleDateInput;
window.changeQty = changeQty;
window.submitOrder = submitOrder;
window.showCatalog = showCatalog;
window.showCart = showCart;
