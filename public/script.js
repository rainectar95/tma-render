const tg = window.Telegram.WebApp;
tg.expand(); // Раскрыть на весь экран

// Относительный путь, так как фронт и бэк на одном домене
const API_URL = ''; 

// Получаем ID пользователя (для тестов в браузере используем 'test_user')
const userId = tg.initDataUnsafe?.user?.id || 'test_user_123';

// Состояние приложения
let state = {
    products: [],
    cart: [],
    totals: { finalTotal: 0 }
};

// --- ИНИЦИАЛИЗАЦИЯ ---
document.addEventListener('DOMContentLoaded', async () => {
    // Предзаполняем имя, если есть в Telegram
    if (tg.initDataUnsafe?.user) {
        const u = tg.initDataUnsafe.user;
        const fullName = `${u.first_name || ''} ${u.last_name || ''}`.trim();
        document.getElementById('name').value = fullName;
    }
    
    await loadProducts();
    await loadCart();
    
    // Убираем лоадер
    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display = 'block';
});

// Настройка Главной Кнопки Telegram
tg.MainButton.onClick(() => {
    if (document.getElementById('cart-view').classList.contains('hidden')) {
        // Если мы в каталоге -> идем в корзину
        showCart();
    } else {
        // Если мы в корзине -> оформляем заказ
        submitOrder();
    }
});

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
            updateMainButton();
        }
    } catch (e) {
        console.error(e);
    }
}

async function addToCart(itemId) {
    tg.MainButton.showProgress(); // Показать крутилку на кнопке
    
    try {
        const res = await fetch(`${API_URL}/api/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'add_to_cart',
                userId: userId,
                itemId: itemId,
                quantity: 1
            })
        });
        
        const data = await res.json();
        if (data.status === 'success') {
            state.cart = data.newCart;
            state.totals = data.newTotals;
            updateMainButton();
            tg.HapticFeedback.notificationOccurred('success'); // Вибрация
        } else {
            tg.showAlert(data.message);
        }
    } catch (e) {
        tg.showAlert("Ошибка связи с сервером");
    } finally {
        tg.MainButton.hideProgress();
    }
}

async function submitOrder() {
    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;
    const address = document.getElementById('address').value;
    const delivery = document.getElementById('delivery-type').value;
    const comment = document.getElementById('comment').value;

    if (!name || !phone || !address) {
        tg.showAlert("Пожалуйста, заполните Имя, Телефон и Адрес");
        return;
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
                    name, phone, address, deliveryType: delivery, comment
                }
            })
        });

        const data = await res.json();
        
        if (data.status === 'success') {
            tg.showAlert(data.message);
            tg.close(); // Закрыть приложение после заказа
        } else {
            tg.showAlert("Ошибка: " + data.message);
        }
    } catch (e) {
        tg.showAlert("Не удалось оформить заказ");
    } finally {
        tg.MainButton.hideProgress();
    }
}

// --- ОТРИСОВКА (RENDER) ---

function renderProducts() {
    const container = document.getElementById('product-list');
    container.innerHTML = '';

    state.products.forEach(p => {
        const card = document.createElement('div');
        card.className = 'product-card';
        // Используем заглушку, если картинки нет
        const imgUrl = p.imageUrl || 'https://via.placeholder.com/150?text=No+Image';
        
        card.innerHTML = `
            <img src="${imgUrl}" class="product-img" alt="${p.name}">
            <div class="product-name">${p.name}</div>
            <div class="product-price">${p.price} ₽</div>
            <button class="btn-add" onclick="addToCart('${p.id}')">В корзину</button>
        `;
        container.appendChild(card);
    });
}

function updateMainButton() {
    if (state.cart.length === 0) {
        tg.MainButton.hide();
    } else {
        tg.MainButton.setText(`Корзина (${state.totals.finalTotal} ₽)`);
        tg.MainButton.show();
        tg.MainButton.color = "#3390ec"; // Стандартный синий
    }
}

// --- НАВИГАЦИЯ ---

function showCart() {
    // Скрываем каталог, показываем корзину
    document.getElementById('product-list').classList.add('hidden');
    document.getElementById('cart-view').classList.remove('hidden');
    document.getElementById('page-title').innerText = 'Оформление заказа';
    
    // Меняем кнопку на "Оплатить"
    tg.MainButton.setText(`ОФОРМИТЬ ЗАКАЗ (${state.totals.finalTotal} ₽)`);
    tg.MainButton.color = "#31b545"; // Зеленый цвет для оплаты
    
    // Рендерим список товаров в корзине (простой список)
    const cartList = document.getElementById('cart-items-list');
    cartList.innerHTML = state.cart.map(item => {
        const product = state.products.find(p => p.id === item.id);
        const name = product ? product.name : 'Товар';
        const price = product ? product.price : 0;
        return `
            <div class="cart-item">
                <div><b>${name}</b> <br> ${item.qty} шт. x ${price} ₽</div>
                <div>${price * item.qty} ₽</div>
            </div>
        `;
    }).join('');
    
    document.getElementById('delivery-cost').innerText = state.totals.deliveryCost;
    document.getElementById('total-price').innerText = state.totals.finalTotal;
    
    // Добавляем кнопку "Назад" в хедер Telegram
    tg.BackButton.show();
    tg.BackButton.onClick(() => {
        showCatalog();
    });
}

function showCatalog() {
    document.getElementById('product-list').classList.remove('hidden');
    document.getElementById('cart-view').classList.add('hidden');
    document.getElementById('page-title').innerText = 'Каталог';
    
    updateMainButton(); // Вернуть синюю кнопку "Корзина"
    tg.BackButton.hide();
    
    // Удаляем листенер, чтобы не дублировался (Telegram API особенность)
    tg.BackButton.offClick(showCatalog); 
}