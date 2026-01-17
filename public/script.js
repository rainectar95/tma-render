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
        phoneInput.addEventListener('focus', onPhoneFocus);
        phoneInput.addEventListener('blur', onPhoneBlur);
        phoneInput.addEventListener('input', () => phoneInput.classList.remove('input-error'));
    }

    toggleDeliveryFields();
    await loadProducts();
    
    // Восстановление корзины
    const savedCart = localStorage.getItem('myAppCart');
    if (savedCart) {
        try {
            const parsedCart = JSON.parse(savedCart);
            state.cart = parsedCart.filter(item => {
                const product = state.products.find(p => p.id === item.id);
                return !!product; 
            }).map(item => {
                const product = state.products.find(p => p.id === item.id);
                // Корректируем кол-во под локальные данные (предварительно)
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

    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    
    startLiveUpdates();
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

// ⚡ ИЗМЕНЕНИЕ: Асинхронный переход в корзину
async function showCart() { 
    if (state.cart.length > 0 && !IS_LOCAL_MODE) {
        tg.MainButton.showProgress(); // Показываем крутилку в ТГ
        
        try {
            // Спрашиваем сервер: "Все ли есть в наличии?"
            const res = await fetch(`${API_URL}/api/check_stock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cart: state.cart })
            });
            const data = await res.json();
            
            tg.MainButton.hideProgress();

            if (data.status === 'error') {
                // Если чего-то нет, ругаемся и обновляем каталог
                tg.showAlert(data.message);
                await loadProducts(); 
                // Не пускаем в корзину, пока не исправят
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
    // 1. Сброс предыдущих ошибок
    document.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));

    // 2. АВТО-ЧИСТКА: Удаляем из заказа товары, которых нет в наличии (stock <= 0)
    // Это решает проблему блокировки заказа из-за отсутствующего товара
    const originalCount = state.cart.length;
    state.cart = state.cart.filter(item => {
        const p = state.products.find(x => x.id === item.id);
        return p && p.stock > 0;
    });

    // Если что-то удалилось, обновляем UI и пересчитываем сумму
    if (state.cart.length !== originalCount) {
        calculateTotals();
        updateCartUI();
        renderCart();
        tg.showAlert("Некоторые товары закончились и были удалены из заказа.");
    }

    // 3. Сбор данных из полей ввода
    const nameInput = document.getElementById('name');
    const phoneInput = document.getElementById('phone');
    const deliveryType = document.getElementById('delivery-type').value;
    const comment = document.getElementById('comment').value;
    const dateInput = document.getElementById('custom-date');
    const streetInput = document.getElementById('address-street');
    const houseInput = document.getElementById('address-house');
    
    // 4. Валидация
    let errors = [];

    // Проверка корзины
    if (state.cart.length === 0) {
        return tg.showAlert("Корзина пуста 🛒");
    }

    // Проверка полей
    if (!nameInput.value.trim()) errors.push(nameInput);
    
    // Телефон должен содержать минимум 11 цифр (7XXXXXXXXXX)
    if (!phoneInput.value.trim() || phoneInput.value.replace(/\D/g, '').length < 11) {
        errors.push(phoneInput); 
    }
    
    if (!dateInput.value) errors.push(document.getElementById('date-display')); 

    // Адрес нужен только для курьера
    if (deliveryType === 'Курьерская доставка') {
        if (!streetInput.value.trim()) errors.push(streetInput);
        if (!houseInput.value.trim()) errors.push(houseInput);
    }

    // Если есть ошибки — подсвечиваем и скроллим к первой
    if (errors.length > 0) {
        errors.forEach(field => field.classList.add('input-error'));
        errors[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        tg.HapticFeedback.notificationOccurred('error');
        return; 
    }

    // 5. Формирование финальных данных
    let finalAddress = "";
    if (deliveryType === 'Курьерская доставка') {
        finalAddress = `${streetInput.value.trim()}, д. ${houseInput.value.trim()}`;
    } else {
        finalAddress = "Самовывоз (ул. Предпортовая, д. 10)";
    }
    const dateVal = formatSmartDate(dateInput.value);

    // 6. UI: Блокировка кнопки и показ загрузки
    const btn = document.querySelector('.btn-main');
    const originalBtnText = btn.innerText;
    
    btn.innerText = "Оформляю..."; 
    btn.classList.add('btn-loading'); 
    
    try {
        // 7. Отправка запроса на сервер
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
        
        // 8. Обработа ответа
        if (data.status === 'success') {
            tg.HapticFeedback.notificationOccurred('success');
            
            // Показываем модалку успеха
            showSuccessModal(data.orderId);
            
            // Очищаем корзину и локальное хранилище
            state.cart = []; 
            localStorage.removeItem('myAppCart');
            calculateTotals();
            updateCartUI();
            
            // При закрытии модалки (resetApp) кнопка вернется в норму
        } else {
            // Если сервер вернул ошибку (например, "товар закончился")
            throw new Error(data.message);
        }
    } catch (e) {
        tg.HapticFeedback.notificationOccurred('error');
        tg.showAlert("Ошибка: " + e.message); 
        
        // Обновляем каталог, чтобы пользователь увидел актуальные остатки
        await loadProducts();
        
        // Возвращаем кнопку в исходное состояние
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
        // Считаем только если товар существует И его сток > 0
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
        const cartItem = state.cart.find(i => i.id === p.id);
        const qty = cartItem ? cartItem.qty : 0;
        const details = p.stock === 0 ? '<span style="color:red">Нет в наличии</span>' : (p.description || '');
        
        let btn = (p.stock === 0) 
            ? `<button class="btn-add" disabled style="opacity:0.5; background:#ccc; color:#000">Нет товара</button>` 
            : (qty === 0) 
                ? `<button class="btn-add" onclick="changeQty('${p.id}', 1)">В корзину</button>`
                : `<div class="qty-control"><button class="btn-qty" onclick="changeQty('${p.id}', -1)">−</button><span class="qty-val">${qty}</span><button class="btn-qty" onclick="changeQty('${p.id}', 1)">+</button></div>`;

        const div = document.createElement('div');
        div.className = 'product-card';
        div.innerHTML = `<div class="img-frame"><img src="${p.imageUrl}" class="product-img" loading="lazy"></div><div class="product-price">${p.price} ₽</div><div class="product-name">${p.name}</div><div class="product-details">${details}</div>${btn}`;
        container.appendChild(div);
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

        // Проверяем наличие
        const isOutOfStock = p.stock === 0;
        
        // Стили для прозрачности (оставляем, чтобы было понятно, что товар недоступен)
        const opacityStyle = isOutOfStock ? 'style="opacity: 0.6; pointer-events: none;"' : '';
        
        const priceHtml = isOutOfStock 
            ? '<div class="cart-item-price" style="color: #ff3b30; font-size: 0.9rem;">Нет в наличии</div>' 
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
    // Запускаем проверку каждые 10 секунд
    updateInterval = setInterval(async () => {
        // Если открыта корзина или модальное окно — не обновляем, чтобы не сбить пользователя
        const cartHidden = document.getElementById('cart-view').classList.contains('hidden');
        const modalVisible = document.getElementById('success-modal').classList.contains('visible');
        
        if (!cartHidden || modalVisible) return;

        await updateStockOnly();
    }, 10000); // 10000 мс = 10 секунд
}

async function updateStockOnly() {
    try {
        if (IS_LOCAL_MODE) return;

        // 1. Тихо запрашиваем свежие данные
        const res = await fetch(`${API_URL}/api/get_products`);
        const data = await res.json();
        
        if (!data.products) return;

        // 2. Обновляем локальные данные, сохраняя количество в корзине
        const newProducts = data.products;

        // 3. Пробегаемся по карточкам и меняем только текст
        newProducts.forEach(newP => {
            // Находим старый продукт в памяти
            const oldP = state.products.find(p => p.id === newP.id);
            
            // Если сток изменился
            if (oldP && oldP.stock !== newP.stock) {
                console.log(`Обновление товара ${newP.name}: ${oldP.stock} -> ${newP.stock}`);
                oldP.stock = newP.stock; // Обновляем в памяти
                
                // Обновляем UI конкретной карточки
                updateCardUI(newP);
            }
        });

    } catch (e) {
        console.error("Ошибка авто-обновления:", e);
    }
}

// Функция точечного обновления одной карточки
function updateCardUI(product) {
    // Нам нужно найти карточку товара в HTML. 
    // Для этого при рендере (renderProducts) нужно давать карточкам ID.
    // Но так как у нас простой список, найдем перебором или перерисуем всё, если список небольшой.
    
    // В вашем случае проще вызвать renderProducts(), так как товаров мало.
    // Но чтобы не моргало, лучше найти конкретный элемент.
    
    // Давайте лучше просто перерисуем каталог, если пользователь его сейчас смотрит.
    renderProducts(); 
}

// Добавляем запуск в инициализацию
// Найдите строчку: document.addEventListener('DOMContentLoaded', async () => { ...
// И внутри, в самом конце перед закрывающей скобкой }, добавьте:
// startLiveUpdates();
window.updatePrettyDate = updatePrettyDate;
window.removeItem = removeItem;
window.changeQty = changeQty;
window.submitOrder = submitOrder;
window.showCatalog = showCatalog;
window.showCart = showCart;
window.toggleDeliveryFields = toggleDeliveryFields;
window.resetApp = resetApp;







