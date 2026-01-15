const tg = window.Telegram.WebApp;
tg.expand();
// Относительный путь для API
const API_URL = '';
// ID пользователя для тестов или из Telegram
const userId = tg.initDataUnsafe?.user?.id || 'test_user_777';

// Состояние приложения
let state = {
    products: [],
    cart: [],
    totals: { finalTotal: 0, totalQty: 0 }
};

// --- ИНИЦИАЛИЗАЦИЯ ---
document.addEventListener('DOMContentLoaded', async () => {
    if (tg.initDataUnsafe?.user) {
        const u = tg.initDataUnsafe.user;
        // Предзаполнение имени
        document.getElementById('name').value = [u.first_name, u.last_name].join(' ').trim();
    }
    
    await loadProducts();
    await loadCart();
    
    // Скрываем лоадер, показываем приложение
    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display = 'block';
});

// --- ЛОГИКА ИНТЕРФЕЙСА ---

// Переключение выбора даты (показать календарь)
function toggleDateInput() {
    const select = document.getElementById('date-select');
    const customInput = document.getElementById('custom-date');
    if (select.value === 'custom') {
        customInput.classList.remove('hidden');
    } else {
        customInput.classList.add('hidden');
    }
}

// Навигация: Показать каталог
function showCatalog() {
    document.getElementById('catalog-view').classList.remove('hidden');
    document.getElementById('cart-view').classList.add('hidden');
    document.getElementById('page-title').innerText = 'Каталог продукции';
    
    document.getElementById('nav-catalog').classList.add('active');
    document.getElementById('nav-cart').classList.remove('active');
    
    // Перерисовываем, чтобы обновились кнопки количества
    renderProducts(); 
}

// Навигация: Показать корзину
function showCart() {
    document.getElementById('catalog-view').classList.add('hidden');
    document.getElementById('cart-view').classList.remove('hidden');
    document.getElementById('page-title').innerText = 'Корзина';
    
    document.getElementById('nav-catalog').classList.remove('active');
    document.getElementById('nav-cart').classList.add('active');
    
    // Перерисовываем список товаров в корзине
    renderCart();
}

// --- API ЗАПРОСЫ ---

async function loadProducts() {
    try {
        const res = await fetch(`${API_URL}/api/get_products`);
        const data = await res.json();
        if (data.products) {
            state.products = data.products;
            renderProducts();
        }
    } catch (e) {
        tg.showAlert("Ошибка загрузки товаров");
    }
}

async function loadCart() {
    try {
        const res = await fetch(`${API_URL}/api/get_cart?userId=${userId}`);
        const data = await res.json();
        if (data.cart) {
            state.cart = data.cart;
            state.totals = data.totals;
            updateCartUI();
        }
    } catch (e) { console.error(e); }
}

// Единая функция изменения количества (+1 или -1)
async function changeQty(itemId, delta) {
    // Покажем вибрацию при нажатии
    tg.HapticFeedback.selectionChanged();

    try {
        const res = await fetch(`${API_URL}/api/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'add_to_cart',
                userId: userId,
                itemId: itemId,
                quantity: delta // Отправляем +1 или -1
            })
        });

        const data = await res.json();
        if (data.status === 'success') {
            state.cart = data.newCart;
            state.totals = data.newTotals;
            
            // Обновляем UI везде
            updateCartUI();
            renderProducts();
            renderCart();
        }
    } catch (e) {
        tg.showAlert("Ошибка соединения");
    }
}

async function submitOrder() {
    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;
    const address = document.getElementById('address').value;
    const deliveryType = document.getElementById('delivery-type').value;
    const comment = document.getElementById('comment').value;

    // Получаем выбранную дату
    let dateVal = document.getElementById('date-select').value;
    if (dateVal === 'custom') {
        dateVal = document.getElementById('custom-date').value;
        if (!dateVal) return tg.showAlert("Выберите дату в календаре");
    }

    if (!name || !phone || !address) {
        return tg.showAlert("Заполните обязательные поля (Имя, Телефон, Адрес)");
    }

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
                    deliveryDate: dateVal, // Отправляем дату
                    comment
                }
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
        tg.showAlert("Ошибка при оформлении заказа");
    } finally {
        tg.MainButton.hideProgress();
    }
}

// --- ОТРИСОВКА (RENDER) ---

function renderProducts() {
    const container = document.getElementById('product-list');
    container.innerHTML = '';

    state.products.forEach(p => {
        // Проверяем, есть ли товар в корзине
        const cartItem = state.cart.find(item => item.id === p.id);
        const qty = cartItem ? cartItem.qty : 0;
        const imgUrl = p.imageUrl || 'https://via.placeholder.com/150';
        const details = p.description ? `${p.description}` : `${p.stock} шт.`;

        const card = document.createElement('div');
        card.className = 'product-card';

        // Логика кнопки: или "В корзину", или контрол [ - ] qty [ + ]
        let buttonHtml = '';
        if (qty === 0) {
            buttonHtml = `<button class="btn-add" onclick="changeQty('${p.id}', 1)">В корзину</button>`;
        } else {
            buttonHtml = `
                <div class="qty-control">
                    <button class="btn-qty" onclick="changeQty('${p.id}', -1)">−</button>
                    <span class="qty-val">${qty}</span>
                    <button class="btn-qty" onclick="changeQty('${p.id}', 1)">+</button>
                </div>
            `;
        }

        card.innerHTML = `
            <img src="${imgUrl}" class="product-img" alt="${p.name}">
            <div class="product-name">${p.name}</div>
            <div class="product-details">${details}</div>
            <div class="product-price" style="font-weight:bold; margin-bottom:10px;">${p.price} ₽</div>
            ${buttonHtml}
        `;
        container.appendChild(card);
    });
}

function renderCart() {
    const container = document.getElementById('cart-items-list');
    if (state.cart.length === 0) {
        container.innerHTML = '<p>Корзина пуста</p>';
        return;
    }

    container.innerHTML = state.cart.map(item => {
        const product = state.products.find(p => p.id === item.id);
        if (!product) return '';
        return `
            <div class="cart-item">
                <div class="cart-item-info">
                    <div class="cart-item-name">${product.name}</div>
                    <div class="cart-item-price">${product.price} ₽</div>
                </div>
                <div style="width: 110px;">
                    <div class="qty-control">
                        <button class="btn-qty" onclick="changeQty('${item.id}', -1)">−</button>
                        <span class="qty-val">${item.qty}</span>
                        <button class="btn-qty" onclick="changeQty('${item.id}', 1)">+</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function updateCartUI() {
    // Обновляем итоги в корзине
    document.getElementById('delivery-cost').innerText = `${state.totals.deliveryCost} ₽`;
    document.getElementById('total-price').innerText = `${state.totals.finalTotal} ₽`;
    
    // Обновляем бейдж на кнопке навигации
    const badge = document.getElementById('cart-badge');
    if (state.totals.totalQty > 0) {
        badge.innerText = state.totals.totalQty;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// Экспорт функций для вызова из HTML
window.toggleDateInput = toggleDateInput;
window.changeQty = changeQty;
window.submitOrder = submitOrder;
window.showCatalog = showCatalog;
window.showCart = showCart;
