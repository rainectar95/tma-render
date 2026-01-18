const tg = window.Telegram.WebApp;
tg.expand();

// ==========================================
// ⚙️ НАСТРОЙКИ
// ==========================================
const IS_LOCAL_MODE = false;
const API_URL = 'https://tma-render.onrender.com'; // ВАША ССЫЛКА
const userId = tg.initDataUnsafe?.user?.id || 'test_user_777';

let state = {
    products: [],
    cart: [],
    totals: { finalTotal: 0, deliveryCost: 0, totalQty: 0 }
};

// ==========================================
// 🏁 ИНИЦИАЛИЗАЦИЯ
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Настройка даты (минимум завтра)
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

    // 3. Маска телефона
    const phoneInput = document.getElementById('phone');
    if (phoneInput) {
        phoneInput.addEventListener('input', onPhoneInput);
        phoneInput.addEventListener('keydown', onPhoneKeyDown);
        phoneInput.addEventListener('paste', onPhonePaste);
        phoneInput.addEventListener('focus', onPhoneFocus);
        phoneInput.addEventListener('blur', onPhoneBlur);
        phoneInput.addEventListener('input', () => phoneInput.classList.remove('input-error'));
    }

    toggleDeliveryFields();

    // 4. ЗАГРУЗКА ДАННЫХ (С ЗАДЕРЖКОЙ ДЛЯ ЛОАДЕРА)
    // Ждем минимум 1 секунду, чтобы лоадер не моргал
    const minLoaderTime = new Promise(resolve => setTimeout(resolve, 2500));
    // Запускаем параллельно загрузку товаров и таймер
    await Promise.all([loadProducts(), minLoaderTime]);
    
    // 5. Восстановление корзины
    const savedCart = localStorage.getItem('myAppCart');
    if (savedCart) {
        try {
            const parsedCart = JSON.parse(savedCart);
            state.cart = parsedCart.filter(item => {
                const product = state.products.find(p => p.id === item.id);
                return !!product; 
            }).map(item => {
                const product = state.products.find(p => p.id === item.id);
                // Если товара на складе меньше, чем было в корзине — урезаем
                if (product.stock > 0 && item.qty > product.stock) {
                    item.qty = product.stock;
                }
                return item;
            });
            calculateTotals();
            updateCartUI();
        } catch (e) {
            localStorage.removeItem('myAppCart');
        }
    }

    // 6. Снимаем лоадер плавно
    const loader = document.getElementById('loader');
    if (loader) {
        loader.style.opacity = '0'; // Плавное исчезновение
        loader.style.transition = 'opacity 0.3s ease';
        setTimeout(() => {
            loader.style.display = 'none';
            document.getElementById('app').style.display = 'block';
        }, 300);
    } else {
        document.getElementById('app').style.display = 'block';
    }

    // 7. Запускаем живое обновление
    startLiveUpdates();
    
    // Убираем ошибки при вводе
    document.querySelectorAll('input, textarea, select').forEach(el => {
        el.addEventListener('input', function() { this.classList.remove('input-error'); });
    });
});

// ==========================================
// 📞 ТЕЛЕФОН (МАСКА)
// ==========================================
function onPhoneFocus(e) { if (e.target.value === "") e.target.value = "+7 "; }
function onPhoneBlur(e) { if (e.target.value.trim() === "+7") e.target.value = ""; }
function getInputNumbersValue(input) { return input.value.replace(/\D/g, ''); }
function onPhonePaste(e) {
    const input = e.target;
    const inputNumbersValue = getInputNumbersValue(input);
    const pasted = e.clipboardData || window.clipboardData;
    if (pasted) {
        const pastedText = pasted.getData('Text');
        if (/\D/g.test(pastedText)) { input.value = inputNumbersValue; return; }
    }
}
function onPhoneInput(e) {
    const input = e.target;
    let inputNumbersValue = getInputNumbersValue(input);
    let selectionStart = input.selectionStart;
    let formattedInputValue = "";
    if (!inputNumbersValue) return input.value = "";
    if (input.value.length != selectionStart) { if (e.data && /\D/g.test(e.data)) input.value = inputNumbersValue; return; }
    if (["7", "8", "9"].indexOf(inputNumbersValue[0]) > -1) {
        if (inputNumbersValue[0] == "9") inputNumbersValue = "7" + inputNumbersValue;
        let firstSymbols = "+7"; 
        formattedInputValue = input.value = firstSymbols + " ";
        if (inputNumbersValue.length > 1) formattedInputValue += "(" + inputNumbersValue.substring(1, 4);
        if (inputNumbersValue.length >= 5) formattedInputValue += ") " + inputNumbersValue.substring(4, 7);
        if (inputNumbersValue.length >= 8) formattedInputValue += " " + inputNumbersValue.substring(7, 9);
        if (inputNumbersValue.length >= 10) formattedInputValue += " " + inputNumbersValue.substring(9, 11);
    } else { formattedInputValue = "+" + inputNumbersValue.substring(0, 16); }
    input.value = formattedInputValue;
}
function onPhoneKeyDown(e) { if (e.keyCode == 8 && e.target.value.replace(/\D/g, '').length == 1) e.target.value = ""; }

// ==========================================
// 🧭 НАВИГАЦИЯ И ПРОВЕРКА СКЛАДА
// ==========================================
function showCatalog() { switchView('catalog'); }

// Асинхронный переход в корзину
async function showCart() { 
    if (state.cart.length > 0 && !IS_LOCAL_MODE) {
        tg.MainButton.showProgress(); 
        try {
            const res = await fetch(`${API_URL}/api/check_stock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cart: state.cart })
            });
            const data = await res.json();
            tg.MainButton.hideProgress();

            if (data.status === 'error') {
                tg.showAlert(data.message);
                await loadProducts(); 
                return; 
            }
        } catch (e) {
            console.error("Ошибка проверки", e);
            tg.MainButton.hideProgress();
        }
    }
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

// ==========================================
// 📦 ТОВАРЫ
// ==========================================
async function loadProducts() {
    try {
        const res = await fetch(`${API_URL}/api/get_products`);
        const data = await res.json();
        if (data.products) {
            state.products = data.products;
            // Актуализируем корзину (вдруг сток изменился)
            state.cart.forEach(item => {
                const p = state.products.find(x => x.id === item.id);
                if (p && item.qty > p.stock) item.qty = p.stock;
            });
            calculateTotals();
            updateCartUI();
        }
        renderProducts();
    } catch (e) { console.error("Ошибка загрузки", e); }
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
        if (cartItem.qty <= 0) state.cart = state.cart.filter(i => i.id !== itemId);
    } else if (newQty > 0) {
        state.cart.push({ id: itemId, qty: newQty });
    }

    localStorage.setItem('myAppCart', JSON.stringify(state.cart));
    calculateTotals();
    updateCartUI();    
    
    if (!document.getElementById('cart-view').classList.contains('hidden')) renderCart();
    else renderProducts();
}

function removeItem(itemId) {
    const item = state.cart.find(i => i.id === itemId);
    if (item) changeQty(itemId, -item.qty);
}

// ==========================================
// 🚀 ЗАКАЗ
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

async function submitOrder() {
    document.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));

    if (state.cart.length === 0) return showTopTooltip("Корзина пуста 🛒", "error");

    const nameInput = document.getElementById('name');
    const phoneInput = document.getElementById('phone');
    const deliveryType = document.getElementById('delivery-type').value;
    const dateInput = document.getElementById('custom-date');
    const streetInput = document.getElementById('address-street');
    const houseInput = document.getElementById('address-house');

    let missingFields = []; 

    if (!nameInput.value.trim()) {
        missingFields.push("имя");
        nameInput.classList.add('input-error');
    }

    if (!phoneInput.value.trim() || phoneInput.value.replace(/\D/g, '').length < 11) {
        missingFields.push("номер телефона");
        phoneInput.classList.add('input-error');
    }

    if (!dateInput.value) {
        missingFields.push("дату");
        document.getElementById('date-display').classList.add('input-error');
    }

    if (deliveryType === 'Курьерская доставка') {
        if (!streetInput.value.trim()) {
            missingFields.push("адрес (улицу)");
            streetInput.classList.add('input-error');
        }
        if (!houseInput.value.trim()) {
            missingFields.push("дом");
            houseInput.classList.add('input-error');
        }
    }

    if (missingFields.length > 0) {
        tg.HapticFeedback.notificationOccurred('error');
        const msg = "Введите: " + missingFields.join(', ');
        showTopTooltip(msg, "error");
        return;
    }

    let finalAddress = deliveryType === 'Курьерская доставка' ? `${streetInput.value.trim()}, д. ${houseInput.value.trim()}` : "Самовывоз (ул. Предпортовая, д. 10)";
    const dateVal = formatSmartDate(dateInput.value);
    const comment = document.getElementById('comment').value;

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
            showSuccessModal(data.orderId);
            state.cart = []; 
            localStorage.removeItem('myAppCart');
            calculateTotals();
            updateCartUI();
        } else {
            throw new Error(data.message);
        }
    } catch (e) {
        tg.HapticFeedback.notificationOccurred('error');
        showTopTooltip("Ошибка: " + e.message, "error");
        await loadProducts();
        btn.innerText = originalBtnText;
        btn.classList.remove('btn-loading');
    }
}

// ==========================================
// 🎨 UI
// ==========================================
function showSuccessModal(orderId) {
    const modal = document.getElementById('success-modal');
    if (modal) {
        document.getElementById('modal-msg').innerHTML = `Ваш заказ <b>${orderId}</b> успешно принят.`;
        modal.classList.add('visible');
    }
}
function resetApp() {
    document.getElementById('success-modal').classList.remove('visible');
    const btn = document.querySelector('.btn-main');
    btn.innerText = "Оформить заказ";
    btn.classList.remove('btn-loading');
    document.getElementById('comment').value = "";
    showCatalog();
}
function calculateTotals() {
    let sum = 0, qty = 0;
    state.cart.forEach(item => {
        const p = state.products.find(x => x.id === item.id);
        if (p && p.stock > 0) { 
            sum += p.price * item.qty; 
            qty += item.qty; 
        }
    });
    state.totals = { finalTotal: sum, totalQty: qty };
}
function updateCartUI() {
    const totalElem = document.getElementById('total-price');
    const badge = document.getElementById('cart-badge');
    if (totalElem) totalElem.innerText = `${state.totals.finalTotal} ₽`;
    if (badge) {
        badge.innerText = state.totals.totalQty;
        state.totals.totalQty > 0 ? badge.classList.remove('hidden') : badge.classList.add('hidden');
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
        
        // Описание или "Нет в наличии" (если 0)
        const details = p.stock === 0 ? '<span style="color:red">Нет в наличии</span>' : (p.description || '');

        // 🔥 ЛОГИКА ОСТАТКА (Меньше 10)
        let lowStockLabel = '';
        if (p.stock > 0 && p.stock < 10) {
            lowStockLabel = `<div class="product-stock-warning">Осталось: ${p.stock} шт.</div>`;
        }

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
            ${lowStockLabel} 
            ${buttonHtml}`;
        container.appendChild(card);
    });
}

function renderCart() {
    const container = document.getElementById('cart-items-list');
    if (!container) return;

    if (!state.cart.length) {
        container.innerHTML = `<div class="empty-block"><p class="free-cart">Корзина пуста</p></div>`;
        return;
    }
    
    container.innerHTML = state.cart.map(item => {
        const p = state.products.find(x => x.id === item.id);
        if (!p) return '';

        const isOutOfStock = p.stock === 0;
        const opacityStyle = isOutOfStock ? 'style="opacity: 0.6; pointer-events: none;"' : '';
        
        const priceHtml = isOutOfStock 
            ? '<div class="cart-item-price" style="color: #ff3b30; font-size: 0.75rem;">Нет в наличии</div>' 
            : `<div class="cart-item-price">${p.price * item.qty} ₽</div>`;

        const controlsHtml = isOutOfStock 
            ? `<button class="btn-remove-cart" onclick="removeItem('${item.id}')" style="pointer-events: auto;">Удалить</button>`
            : `<div class="qty-control-cart">
                   <button class="btn-qty" onclick="changeQty('${item.id}', -1)">−</button>
                   <span class="qty-val">${item.qty}</span>
                   <button class="btn-qty" onclick="changeQty('${item.id}', 1)">+</button>
               </div>`;

        return `
        <div class="cart-block">
            <div class="cart-item">
                <div class="card-img-container" ${opacityStyle}>
                    <img src="${p.imageUrl}" class="cart-item-img" loading="lazy">
                </div>
                <div class="cart-item-info">
                    <div class="card-item-block" ${opacityStyle}>
                        <div class="cart-item-name">${p.name}</div>
                        <div class="cart-item-description">${p.description || ''}</div>
                    </div>
                    <div class="cart-counter">
                        ${priceHtml}
                        ${controlsHtml}
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');
}
function updatePrettyDate(input) {
    const display = document.getElementById('date-display');
    display.value = input.value ? formatSmartDate(input.value) : '';
    display.classList.remove('input-error');
}
function formatSmartDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    const m = ['Января','Февраля','Марта','Апреля','Мая','Июня','Июля','Августа','Сентября','Октября','Ноября','Декабря'];
    return `${['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][d.getDay()]}, ${d.getDate()} ${m[d.getMonth()]}`;
}

// ==========================================
// 🔄 ЖИВОЕ ОБНОВЛЕНИЕ (POLLING)
// ==========================================
let updateInterval;

function startLiveUpdates() {
    // Запускаем проверку каждые 2 секунды
    updateInterval = setInterval(async () => {
        const modalVisible = document.getElementById('success-modal').classList.contains('visible');
        // Если висит окно "Заказ оформлен" — не обновляем, чтобы не сбить юзера
        if (modalVisible) return;

        await updateStockOnly();
    }, 2000); 
}

async function updateStockOnly() {
    try {
        if (IS_LOCAL_MODE) return;

        const res = await fetch(`${API_URL}/api/get_products`);
        const data = await res.json();
        
        if (!data.products) return;

        const newProducts = data.products;
        let somethingChanged = false;

        // 1. Сравниваем данные
        newProducts.forEach(newP => {
            const oldP = state.products.find(p => p.id === newP.id);
            if (!oldP) return;

            if (oldP.stock !== newP.stock) {
                somethingChanged = true;
                
                // Уведомления
                if (oldP.stock > 0 && newP.stock === 0) {
                    showTopTooltip(`Товар "${newP.name}" закончился 😢`, "error");
                }
                else if (oldP.stock === 0 && newP.stock > 0) {
                    showTopTooltip(`Товар "${newP.name}" снова в наличии! 🎉`, "success");
                }
            }
        });

        if (somethingChanged) {
            // 2. Обновляем память
            state.products = newProducts;

            // 3. Корректируем корзину (если купили больше, чем есть - уменьшаем)
            state.cart.forEach(item => {
                const p = state.products.find(x => x.id === item.id);
                if (p && p.stock > 0 && item.qty > p.stock) {
                    item.qty = p.stock;
                }
            });

            // 4. 🔥 ВАЖНО: Пересчитываем итоги (чтобы цена перестала быть 0)
            calculateTotals();
            updateCartUI();

            // 5. Перерисовываем экран
            const isCartHidden = document.getElementById('cart-view').classList.contains('hidden');
            
            if (isCartHidden) {
                renderProducts(); // Обновляем каталог
            } else {
                renderCart();     // Обновляем корзину (тут появятся цены и кнопки)
            }
        }

    } catch (e) {
        console.error("Ошибка авто-обновления:", e);
    }
}

// ==========================================
// 🔔 УВЕДОМЛЕНИЯ (ТУЛТИПЫ)
// ==========================================
let tooltipTimer;

function showTopTooltip(text, type = 'info') {
    const tooltip = document.getElementById('top-tooltip');
    if (!tooltip) return;

    // Убираем старые классы типа
    tooltip.classList.remove('error', 'success');
    
    // Добавляем новые
    if (type === 'error') tooltip.classList.add('error');
    if (type === 'success') tooltip.classList.add('success');

    tooltip.innerText = text;
    tooltip.classList.add('visible');

    // Сброс таймера, если сообщение пришло быстро одно за другим
    if (tooltipTimer) clearTimeout(tooltipTimer);

    // Прячем через 3 секунды
    tooltipTimer = setTimeout(() => {
        tooltip.classList.remove('visible');
    }, 3000);
}

// Экспорт (не обязательно, но полезно для отладки)
window.updatePrettyDate = updatePrettyDate;
window.removeItem = removeItem;
window.changeQty = changeQty;
window.submitOrder = submitOrder;
window.showCatalog = showCatalog;
window.showCart = showCart;
window.toggleDeliveryFields = toggleDeliveryFields;
window.resetApp = resetApp;


