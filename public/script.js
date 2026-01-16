const tg = window.Telegram.WebApp;
tg.expand();

// ==========================================
// ⚙️ НАСТРОЙКИ
// ==========================================
const IS_LOCAL_MODE = false; 
const API_URL = '';
const userId = tg.initDataUnsafe?.user?.id || 'test_user_777';

const MOCK_PRODUCTS = [
    { id: '1', name: 'Лаваш Тонкий', price: 60, stock: 100, imageUrl: 'https://via.placeholder.com/150', description: 'Армянский лаваш, 10 шт' },
];

let state = {
    products: [],
    cart: [],
    totals: { finalTotal: 0, deliveryCost: 0, totalQty: 0 }
};

document.addEventListener('DOMContentLoaded', async () => {
    const dateInput = document.getElementById('custom-date');
    if (dateInput) {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        dateInput.min = tomorrow.toISOString().split('T')[0];
    }

    if (tg.initDataUnsafe?.user) {
        const u = tg.initDataUnsafe.user;
        const nameField = document.getElementById('name');
        if (nameField) nameField.value = [u.first_name, u.last_name].join(' ').trim();
    }

    const phoneInput = document.getElementById('phone');
    if (phoneInput) {
        phoneInput.addEventListener('input', onPhoneInput);
        phoneInput.addEventListener('keydown', onPhoneKeyDown);
        phoneInput.addEventListener('paste', onPhonePaste);
    }

    // Загружаем только товары. Корзина локальная и пустая при старте.
    await loadProducts();
    
    // Если хотите сохранять корзину между сессиями на телефоне (не в Google Sheets):
    // const savedCart = localStorage.getItem('myAppCart');
    // if (savedCart) { state.cart = JSON.parse(savedCart); calculateTotals(); updateCartUI(); }

    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display = 'block';
});

// --- МАСКА ТЕЛЕФОНА ---
function getInputNumbersValue(input) { return input.value.replace(/\D/g, ''); }
function onPhonePaste(e) {
    const input = e.target;
    const inputNumbersValue = getInputNumbersValue(input);
    const pasted = e.clipboardData || window.clipboardData;
    if (pasted) {
        const pastedText = pasted.getData('Text');
        if (/\D/g.test(pastedText)) {
            input.value = inputNumbersValue;
            return;
        }
    }
}
function onPhoneInput(e) {
    const input = e.target;
    let inputNumbersValue = getInputNumbersValue(input);
    let selectionStart = input.selectionStart;
    let formattedInputValue = "";
    if (!inputNumbersValue) return input.value = "";
    if (input.value.length != selectionStart) {
        if (e.data && /\D/g.test(e.data)) input.value = inputNumbersValue;
        return;
    }
    if (["7", "8", "9"].indexOf(inputNumbersValue[0]) > -1) {
        if (inputNumbersValue[0] == "9") inputNumbersValue = "7" + inputNumbersValue;
        let firstSymbols = "+7"; 
        formattedInputValue = input.value = firstSymbols + " ";
        if (inputNumbersValue.length > 1) formattedInputValue += "(" + inputNumbersValue.substring(1, 4);
        if (inputNumbersValue.length >= 5) formattedInputValue += ") " + inputNumbersValue.substring(4, 7);
        if (inputNumbersValue.length >= 8) formattedInputValue += " " + inputNumbersValue.substring(7, 9);
        if (inputNumbersValue.length >= 10) formattedInputValue += " " + inputNumbersValue.substring(9, 11);
    } else {
        formattedInputValue = "+" + inputNumbersValue.substring(0, 16);
    }
    input.value = formattedInputValue;
}
function onPhoneKeyDown(e) {
    const inputValue = e.target.value.replace(/\D/g, '');
    if (e.keyCode == 8 && inputValue.length == 1) e.target.value = "";
}

// --- НАВИГАЦИЯ ---
function showCatalog() { switchView('catalog'); }
function showCart() { switchView('cart'); }
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

// --- ЗАГРУЗКА ---
async function loadProducts() {
    try {
        if (IS_LOCAL_MODE) {
            state.products = MOCK_PRODUCTS;
        } else {
            const res = await fetch(`${API_URL}/api/get_products`);
            const data = await res.json();
            if (data.products) state.products = data.products;
        }
        renderProducts();
    } catch (e) { console.error("Ошибка загрузки товаров", e); }
}

// --- КОРЗИНА (ЛОКАЛЬНАЯ) ---
function changeQty(itemId, delta) {
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

    // Сохраняем локально (если нужно, раскомментируйте)
    // localStorage.setItem('myAppCart', JSON.stringify(state.cart));

    calculateTotals();
    updateCartUI();    
    
    if (!document.getElementById('cart-view').classList.contains('hidden')) {
        renderCart();
    } else {
        renderProducts();
    }
    
    // БОЛЬШЕ НЕ ОТПРАВЛЯЕМ ЗАПРОС НА СЕРВЕР ТУТ!
}

function removeItem(itemId) {
    const item = state.cart.find(i => i.id === itemId);
    if (item) changeQty(itemId, -item.qty);
}

// 🔥 ОФОРМЛЕНИЕ ЗАКАЗА 🔥
async function submitOrder() {
    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;
    const address = document.getElementById('address').value;
    const deliveryType = document.getElementById('delivery-type').value;
    const comment = document.getElementById('comment').value;

    const rawDate = document.getElementById('custom-date').value;
    
    if (!rawDate && !IS_LOCAL_MODE) return tg.showAlert("Выберите дату доставки!");
    if (!state.cart.length) return tg.showAlert("Корзина пуста!");

    const dateVal = rawDate ? formatSmartDate(rawDate) : '';
    
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
                cart: state.cart, // 🔥 ОТПРАВЛЯЕМ КОРЗИНУ ПРЯМО ЗДЕСЬ
                orderDetails: {
                    name, phone, address, deliveryType,
                    deliveryDate: dateVal,
                    deliveryRaw: rawDate, 
                    comment
                }
            })
        });

        const data = await res.json();
        
        if (data.status === 'success') {
            tg.showAlert(data.message);
            state.cart = []; // Очищаем локальную корзину
            calculateTotals();
            updateCartUI();
            // localStorage.removeItem('myAppCart'); // Если используете
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

    state.totals = {
        totalItemsAmount,
        deliveryCost: 0,
        finalTotal: totalItemsAmount,
        totalQty
    };
}

function updateCartUI() {
    const totalElem = document.getElementById('total-price');
    const badge = document.getElementById('cart-badge');

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
    return `${weekDays[dateObj.getDay()]}, ${dateObj.getDate()} ${monthsGenitive[dateObj.getMonth()]}`;
}

window.updatePrettyDate = updatePrettyDate;
window.removeItem = removeItem;
window.changeQty = changeQty;
window.submitOrder = submitOrder;
window.showCatalog = showCatalog;
window.showCart = showCart;
