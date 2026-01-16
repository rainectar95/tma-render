const tg = window.Telegram.WebApp;
tg.expand();

// ==========================================
// ⚙️ НАСТРОЙКИ
// ==========================================
const IS_LOCAL_MODE = false; 
const API_URL = '';
const userId = tg.initDataUnsafe?.user?.id || 'test_user_777';

// --- ЗАГЛУШКИ (для локального теста) ---
const MOCK_PRODUCTS = [
    { id: '1', name: 'Лаваш Тонкий', price: 60, stock: 100, imageUrl: 'https://via.placeholder.com/150', description: 'Армянский лаваш, 10 шт' },
];

let state = {
    products: [],
    cart: [],
    totals: { finalTotal: 0, deliveryCost: 0, totalQty: 0 }
};

let debounceTimers = {}; 
let pendingChanges = {};

// --- ИНИЦИАЛИЗАЦИЯ ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Настройка календаря
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

    // 3. ЗАГРУЗКА (БЕЗ КЭША)
    await Promise.all([loadProducts(), loadCart()]);

    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display = 'block';
});

// --- UI НАВИГАЦИЯ ---
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
        renderProducts();
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
                calculateTotals(); 
                updateCartUI();
            }
        }
    } catch (e) { console.error(e); }
}

async function changeQty(itemId, delta) {
    tg.HapticFeedback.selectionChanged();

    const product = state.products.find(p => p.id === itemId);
    const cartItem = state.cart.find(i => i.id === itemId);
    const currentQty = cartItem ? cartItem.qty : 0;
    const newQty = currentQty + delta;

    if (product && product.stock > 0 && newQty > product.stock) {
        return tg.showAlert(`Доступно всего ${product.stock} шт.`);
    }
    if (newQty < 0) return;

    if (cartItem) {
        cartItem.qty = newQty;
        if (cartItem.qty <= 0) {
            state.cart = state.cart.filter(i => i.id !== itemId);
        }
    } else if (newQty > 0) {
        state.cart.push({ id: itemId, qty: newQty });
    }

    calculateTotals();
    updateCartUI();    
    
    if (!document.getElementById('cart-view').classList.contains('hidden')) {
        renderCart();
    } else {
        renderProducts();
    }

    if (IS_LOCAL_MODE) return;

    if (debounceTimers[itemId]) clearTimeout(debounceTimers[itemId]);

    if (!pendingChanges[itemId]) pendingChanges[itemId] = 0;
    pendingChanges[itemId] += delta;

    debounceTimers[itemId] = setTimeout(async () => {
        const finalDelta = pendingChanges[itemId];
        if (finalDelta === 0) {
            delete pendingChanges[itemId];
            return;
        }
        try {
            await fetch(`${API_URL}/api/action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'add_to_cart',
                    userId: userId,
                    itemId: itemId,
                    quantity: finalDelta
                })
            });
            delete pendingChanges[itemId];
        } catch (e) {
            console.error("Ошибка синхронизации", e);
        }
    }, 1000);
}

async function removeItem(itemId) {
    const item = state.cart.find(i => i.id === itemId);
    if (item) await changeQty(itemId, -item.qty);
}

// 🔥 ФУНКЦИЯ ОФОРМЛЕНИЯ ЗАКАЗА 🔥
async function submitOrder() {
    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;
    const address = document.getElementById('address').value;
    const deliveryType = document.getElementById('delivery-type').value;
    const comment = document.getElementById('comment').value;

    const rawDate = document.getElementById('custom-date').value;
    
    // 1. Проверка даты
    if (!rawDate && !IS_LOCAL_MODE) {
        return tg.showAlert("Выберите дату доставки!");
    }

    const dateVal = rawDate ? formatSmartDate(rawDate) : '';
    // 2. Время устройства
    const deviceTime = new Date().toLocaleString('ru-RU');

    if (IS_LOCAL_MODE) {
        tg.showAlert(`🔶 [LOCAL] Заказ оформлен!\n📅 Дата: ${dateVal}`);
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
                orderDetails: {
                    name, phone, address, deliveryType,
                    deliveryDate: dateVal,
                    deliveryRaw: rawDate, // Сырая дата
                    creationTime: deviceTime, // Время устройства
                    comment
                }
            })
        });

        const data = await res.json();
        
        if (data.status === 'success') {
            tg.showAlert(data.message);
            tg.close();
        } else {
            tg.showAlert("Ошибка: " + data.message);
        }
    } catch (e) {
        tg.showAlert("Сбой соединения (Network Error)");
        console.error(e);
    } finally {
        tg.MainButton.hideProgress();
    }
}

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

    // Доставка = 0
    const deliveryCost = 0; 

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
            <div class="img-frame"><img src="${imgUrl}" class="product-img" loading="lazy" alt="${p.name}"></div>            
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
                <div class="card-img-container"><img src="${imgUrl}" class="cart-item-img" loading="lazy" alt="${product.name}"></div>
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
    
    return `${dayName}, ${dayNum} ${monthName}`;
}

// --- EXPORT ---
window.updatePrettyDate = updatePrettyDate;
window.removeItem = removeItem;
window.changeQty = changeQty;
window.submitOrder = submitOrder;
window.showCatalog = showCatalog;
window.showCart = showCart;
