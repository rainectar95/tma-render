
const tg = window.Telegram.WebApp;
tg.expand();

// ==========================================
// ⚙️ НАСТРОЙКИ
// ==========================================
const IS_LOCAL_MODE = false;
const API_URL = 'https://script.google.com/macros/s/AKfycbx.../exec'; // Вставьте вашу ссылку
const userId = tg.initDataUnsafe?.user?.id || 'test_user_777';

const MOCK_PRODUCTS = [
    { id: '1', name: 'Лаваш Тонкий (Тест)', price: 60, stock: 100, imageUrl: './img/new/img-lavash-standart-01.webp', description: 'Армянский лаваш, 10 шт' },
    { id: '2', name: 'Сыр Чанах (Тест)', price: 450, stock: 20, imageUrl: './img/new/img-cheese-chanax-02.webp', description: 'Рассольный сыр, 500г' },
    { id: '3', name: 'Бастурма (Тест)', price: 1200, stock: 5, imageUrl: './img/new/img-cheese-chanax-04.webp', description: 'Вяленая говядина' },
    { id: '4', name: 'Вода Джермук (Тест)', price: 80, stock: 50, imageUrl: 'https://bestwine24.ru/storage/optimized/product/voda/94b2b969d57206df8d51a298fdcd836b_67fd12090d875_600x800.webp', description: 'Минеральная вода 0.5л' },
    { id: '5', name: 'Суджук (Тест)', price: 950, stock: 0, imageUrl: 'https://avatars.mds.yandex.net/get-eda/3798638/2e4f3381b5cde0cf90f70225436b2db2/orig', description: 'Нет в наличии' },
];
let state = {
    products: [],
    cart: [],
    totals: { finalTotal: 0, deliveryCost: 0, totalQty: 0 }
};

// ==========================================
// 🏁 ИНИЦИАЛИЗАЦИЯ
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Настройка календаря (минимум завтра)
    const dateInput = document.getElementById('custom-date');
    if (dateInput) {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        dateInput.min = tomorrow.toISOString().split('T')[0];
    }

    // 2. Имя пользователя из Телеграм
    if (tg.initDataUnsafe?.user) {
        const u = tg.initDataUnsafe.user;
        const nameField = document.getElementById('name');
        if (nameField) nameField.value = [u.first_name, u.last_name].join(' ').trim();
    }

    // 3. Настройка маски телефона
    const phoneInput = document.getElementById('phone');
    if (phoneInput) {
        phoneInput.addEventListener('input', onPhoneInput);
        phoneInput.addEventListener('keydown', onPhoneKeyDown);
        phoneInput.addEventListener('paste', onPhonePaste);
        phoneInput.addEventListener('focus', onPhoneFocus); // Показывает +7
        phoneInput.addEventListener('blur', onPhoneBlur);   // Убирает, если пусто
        
        // Убираем красную обводку при вводе
        phoneInput.addEventListener('input', () => phoneInput.classList.remove('input-error'));
    }

    // 4. Проверка полей доставки при старте
    toggleDeliveryFields();

    // 5. Загрузка товаров
    await loadProducts();
    
    // 6. Восстановление корзины
    const savedCart = localStorage.getItem('myAppCart');
    if (savedCart) {
        try {
            const parsedCart = JSON.parse(savedCart);
            // Проверяем актуальность остатков
            state.cart = parsedCart.filter(item => {
                const product = state.products.find(p => p.id === item.id);
                return !!product; 
            }).map(item => {
                const product = state.products.find(p => p.id === item.id);
                if (product.stock > 0 && item.qty > product.stock) {
                    item.qty = product.stock;
                }
                return item;
            });
            calculateTotals();
            updateCartUI();
        } catch (e) {
            console.error("Ошибка восстановления корзины", e);
            localStorage.removeItem('myAppCart');
        }
    }

    // Снимаем лоадер
    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    
    // Вешаем слушатели на инпуты, чтобы убирать красную обводку при вводе
    document.querySelectorAll('input, textarea, select').forEach(el => {
        el.addEventListener('input', function() {
            this.classList.remove('input-error');
        });
    });
});

// ==========================================
// 📞 МАСКА ТЕЛЕФОНА
// ==========================================
function onPhoneFocus(e) {
    const input = e.target;
    if (input.value === "") input.value = "+7 ";
}

function onPhoneBlur(e) {
    const input = e.target;
    if (input.value.trim() === "+7") input.value = "";
}

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

// ==========================================
// 🚚 ЛОГИКА ДОСТАВКИ
// ==========================================
function toggleDeliveryFields() {
    const type = document.getElementById('delivery-type').value;
    const courierBlock = document.getElementById('courier-fields');
    const pickupBlock = document.getElementById('pickup-info');

    if (courierBlock && pickupBlock) {
        if (type === 'Самовывоз') {
            courierBlock.classList.add('hidden');
            pickupBlock.classList.remove('hidden');
        } else {
            courierBlock.classList.remove('hidden');
            pickupBlock.classList.add('hidden');
        }
    }
}

// ==========================================
// 🧭 НАВИГАЦИЯ
// ==========================================
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

// ==========================================
// 📦 ТОВАРЫ И КОРЗИНА
// ==========================================
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

    localStorage.setItem('myAppCart', JSON.stringify(state.cart));
    calculateTotals();
    updateCartUI();    
    
    if (!document.getElementById('cart-view').classList.contains('hidden')) {
        renderCart();
    } else {
        renderProducts();
    }
}

function removeItem(itemId) {
    const item = state.cart.find(i => i.id === itemId);
    if (item) changeQty(itemId, -item.qty);
}

// ==========================================
// 🚀 ОФОРМЛЕНИЕ ЗАКАЗА (С ВАЛИДАЦИЕЙ И АНИМАЦИЕЙ)
// ==========================================
async function submitOrder() {
    // 1. Сброс старых ошибок
    document.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));

    // 2. Сбор данных
    const nameInput = document.getElementById('name');
    const phoneInput = document.getElementById('phone');
    const deliveryType = document.getElementById('delivery-type').value;
    const comment = document.getElementById('comment').value;
    const dateInput = document.getElementById('custom-date');
    const dateDisplay = document.getElementById('date-display');

    const streetInput = document.getElementById('address-street');
    const houseInput = document.getElementById('address-house');
    
    // 3. 🛡️ ВАЛИДАЦИЯ
    let errors = [];

    // Корзина
    if (state.cart.length === 0) {
        return tg.showAlert("Корзина пуста 🛒");
    }

    // Обязательные поля
    if (!nameInput.value.trim()) errors.push(nameInput);
    
    // Телефон: не пустой и достаточной длины (формат: +7 (XXX) XXX XX XX - это 18 символов)
    // Проверим хотя бы наличие цифр > 10
    const rawPhone = phoneInput.value.replace(/\D/g, '');
    if (!phoneInput.value.trim() || rawPhone.length < 11) errors.push(phoneInput); 
    
    // Дата
    if (!dateInput.value) errors.push(dateDisplay); 

    // Адрес (только если Курьер)
    if (deliveryType === 'Курьерская доставка') {
        if (!streetInput.value.trim()) errors.push(streetInput);
        if (!houseInput.value.trim()) errors.push(houseInput);
    }

    // Если есть ошибки
    if (errors.length > 0) {
        errors.forEach(field => field.classList.add('input-error'));
        // Скролл к первой ошибке
        errors[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        tg.HapticFeedback.notificationOccurred('error');
        return; 
    }

    // 4. Подготовка данных
    let finalAddress = "";
    if (deliveryType === 'Курьерская доставка') {
        finalAddress = `${streetInput.value.trim()}, д. ${houseInput.value.trim()}`;
    } else {
        finalAddress = "Самовывоз (ул. Предпортовая, д. 10)";
    }
    const dateVal = formatSmartDate(dateInput.value);

    // Локальный режим
    if (IS_LOCAL_MODE) {
        showSuccessModal("TEST-ORDER-001");
        return;
    }

    // 5. ⏳ АНИМАЦИЯ ЗАГРУЗКИ
    const btn = document.querySelector('.btn-main');
    const originalBtnText = btn.innerText;
    
    btn.innerText = "Оформляю..."; 
    btn.classList.add('btn-loading'); 
    
    try {
        const res = await fetch(`${API_URL}/api/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'place_order',
                userId: userId,
                cart: state.cart, 
                orderDetails: {
                    name: nameInput.value, 
                    phone: phoneInput.value, 
                    address: finalAddress,
                    deliveryType,
                    deliveryDate: dateVal,
                    deliveryRaw: dateInput.value, 
                    comment
                }
            })
        });

        const data = await res.json();
        
        if (data.status === 'success') {
            tg.HapticFeedback.notificationOccurred('success');
            // 6. ✅ УСПЕХ: Открываем модалку
            showSuccessModal(data.orderId);
            
            // Очистка данных
            state.cart = []; 
            localStorage.removeItem('myAppCart');
            calculateTotals();
            updateCartUI();
        } else {
            throw new Error(data.message);
        }
    } catch (e) {
        tg.HapticFeedback.notificationOccurred('error');
        tg.showAlert("Ошибка: " + e.message); 
        // Возвращаем кнопку при ошибке
        btn.innerText = originalBtnText;
        btn.classList.remove('btn-loading');
    }
}

// ==========================================
// 🎨 UI: МОДАЛЬНОЕ ОКНО И СБРОС
// ==========================================
function showSuccessModal(orderId) {
    const modal = document.getElementById('success-modal');
    const msg = document.getElementById('modal-msg');
    
    if (msg) msg.innerHTML = `Ваш заказ <b>${orderId}</b> успешно принят.`;
    if (modal) modal.classList.add('visible');
}

function resetApp() {
    const modal = document.getElementById('success-modal');
    if (modal) modal.classList.remove('visible');
    
    // Сброс кнопки
    const btn = document.querySelector('.btn-main');
    if (btn) {
        btn.innerText = "Оформить заказ";
        btn.classList.remove('btn-loading');
    }

    // Очистка полей (комментарий и дата)
    const comment = document.getElementById('comment');
    if (comment) comment.value = "";
    
    // Переход в каталог
    showCatalog();
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

// ==========================================
// 🎨 РЕНДЕРИНГ
// ==========================================
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
                    <div class="cart-counter">
                        <div class="cart-item-price">${lineTotal} ₽</div>
                        <div class="qty-control-cart">
                            <button class="btn-qty" onclick="changeQty('${item.id}', -1)">−</button>
                            <span class="qty-val">${item.qty}</span>
                            <button class="btn-qty" onclick="changeQty('${item.id}', 1)">+</button>
                        </div>
                    </div>
                </div>
            </div>

        </div>`;
    }).join('');
}

function updatePrettyDate(dateInput) {
    const displayInput = document.getElementById('date-display');
    const rawDate = dateInput.value;
    displayInput.value = rawDate ? formatSmartDate(rawDate) : '';
    // Убираем ошибку, если она была
    if (displayInput.classList.contains('input-error')) displayInput.classList.remove('input-error');
}

function formatSmartDate(isoDateString) {
    if (!isoDateString) return '';
    const dateObj = new Date(isoDateString + 'T12:00:00');
    const weekDays = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    const monthsGenitive = ['Января', 'Февраля', 'Марта', 'Апреля', 'Мая', 'Июня', 'Июля', 'Августа', 'Сентября', 'Октября', 'Ноября', 'Декабря'];
    return `${weekDays[dateObj.getDay()]}, ${dateObj.getDate()} ${monthsGenitive[dateObj.getMonth()]}`;
}

// Экспорт
window.updatePrettyDate = updatePrettyDate;
window.removeItem = removeItem;
window.changeQty = changeQty;
window.submitOrder = submitOrder;
window.showCatalog = showCatalog;
window.showCart = showCart;
window.toggleDeliveryFields = toggleDeliveryFields;

window.resetApp = resetApp;
