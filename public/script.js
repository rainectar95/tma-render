const tg = window.Telegram.WebApp;
tg.expand();
const API_URL = ''; 
const userId = tg.initDataUnsafe?.user?.id || 'test_user_123';

let state = { products: [], cart: [], totals: { finalTotal: 0 } };

document.addEventListener('DOMContentLoaded', async () => {
    if (tg.initDataUnsafe?.user) {
        const u = tg.initDataUnsafe.user;
        document.getElementById('name').value = [u.first_name, u.last_name].join(' ').trim();
    }
    await loadProducts();
    await loadCart();
    document.getElementById('loader').style.display = 'none';
    document.getElementById('app').style.display = 'block';
});

tg.MainButton.onClick(() => {
    if (document.getElementById('cart-view').classList.contains('hidden')) showCart();
    else submitOrder();
});

// --- ЛОГИКА ДАТЫ ---
function toggleDateInput() {
    const select = document.getElementById('date-select');
    const customInput = document.getElementById('custom-date');
    if (select.value === 'custom') customInput.classList.remove('hidden');
    else customInput.classList.add('hidden');
}

// --- API ---
async function loadProducts() {
    try {
        const res = await fetch(`${API_URL}/api/get_products`);
        const data = await res.json();
        if (data.products) {
            state.products = data.products;
            renderProducts();
        }
    } catch(e) { tg.showAlert("Ошибка загрузки"); }
}

async function loadCart() {
    try {
        const res = await fetch(`${API_URL}/api/get_cart?userId=${userId}`);
        const data = await res.json();
        if (data.cart) {
            state.cart = data.cart;
            state.totals = data.totals;
            updateMainButton();
            // Если мы в корзине, нужно перерисовать её, чтобы обновить цифры
            if (!document.getElementById('cart-view').classList.contains('hidden')) {
                renderCartList();
            } else {
                renderProducts(); // Обновить кнопки в каталоге
            }
        }
    } catch(e) {}
}

// ЕДИНАЯ ФУНКЦИЯ ИЗМЕНЕНИЯ КОЛИЧЕСТВА
async function changeQty(itemId, delta) {
    tg.MainButton.showProgress();
    try {
        const res = await fetch(`${API_URL}/api/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'add_to_cart',
                userId: userId,
                itemId: itemId,
                quantity: delta // +1 или -1
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            state.cart = data.newCart;
            state.totals = data.newTotals;
            updateMainButton();
            tg.HapticFeedback.selectionChanged();
            
            // Обновляем UI в зависимости от того, где мы
            if (!document.getElementById('cart-view').classList.contains('hidden')) {
                renderCartList();
            } else {
                renderProducts();
            }
        }
    } catch(e) { tg.showAlert("Ошибка"); } 
    finally { tg.MainButton.hideProgress(); }
}

async function submitOrder() {
    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;
    const address = document.getElementById('address').value;
    const deliveryType = document.getElementById('delivery-type').value;
    const comment = document.getElementById('comment').value;
    
    // Получаем дату
    let dateVal = document.getElementById('date-select').value;
    if (dateVal === 'custom') dateVal = document.getElementById('custom-date').value;
    if (!dateVal) dateVal = "Не указана";

    if (!name || !phone || !address) return tg.showAlert("Заполните все поля!");

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
        } else tg.showAlert(data.message);
    } catch(e) { tg.showAlert("Ошибка заказа"); }
    finally { tg.MainButton.hideProgress(); }
}

// --- ОТРИСОВКА ---

function renderProducts() {
    const container = document.getElementById('product-list');
    container.innerHTML = '';
    state.products.forEach(p => {
        // Ищем, есть ли товар в корзине
        const cartItem = state.cart.find(c => c.id === p.id);
        const qty = cartItem ? cartItem.qty : 0;
        const imgUrl = p.imageUrl || 'https://via.placeholder.com/150';

        const card = document.createElement('div');
        card.className = 'product-card';
        
        let buttonHtml = '';
        if (qty > 0) {
            // Если товар в корзине - показываем +/-
            buttonHtml = `
                <div class="qty-control">
                    <button class="btn-qty" onclick="changeQty('${p.id}', -1)">−</button>
                    <span class="qty-val">${qty}</span>
                    <button class="btn-qty" onclick="changeQty('${p.id}', 1)">+</button>
                </div>
            `;
        } else {
            // Если нет - кнопка "В корзину"
            buttonHtml = `<button class="btn-add" onclick="changeQty('${p.id}', 1)">В корзину</button>`;
        }

        card.innerHTML = `
            <img src="${imgUrl}" class="product-img">
            <div class="product-name">${p.name}</div>
            <div class="product-price">${p.price} ₽</div>
            ${buttonHtml}
        `;
        container.appendChild(card);
    });
}

function renderCartList() {
    const container = document.getElementById('cart-items-list');
    
    if (state.cart.length === 0) {
        container.innerHTML = '<p style="text-align:center; padding:20px;">Корзина пуста</p>';
        return;
    }

    container.innerHTML = state.cart.map(item => {
        const product = state.products.find(p => p.id === item.id);
        if (!product) return '';
        return `
            <div class="cart-item">
                <div class="cart-item-left">
                    <b>${product.name}</b>
                    <span>${product.price} ₽/шт.</span>
                </div>
                <div class="qty-control" style="width: 100px;">
                     <button class="btn-qty" onclick="changeQty('${item.id}', -1)">−</button>
                     <span class="qty-val">${item.qty}</span>
                     <button class="btn-qty" onclick="changeQty('${item.id}', 1)">+</button>
                </div>
            </div>
        `;
    }).join('');
    
    document.getElementById('delivery-cost').innerText = state.totals.deliveryCost;
    document.getElementById('total-price').innerText = state.totals.finalTotal;
}

function updateMainButton() {
    if (state.cart.length === 0) {
        tg.MainButton.hide();
    } else {
        tg.MainButton.setText(`Корзина (${state.totals.finalTotal} ₽)`);
        tg.MainButton.show();
        tg.MainButton.color = "#3390ec";
    }
}

// Навигация
function showCart() {
    document.getElementById('product-list').classList.add('hidden');
    document.getElementById('cart-view').classList.remove('hidden');
    document.getElementById('page-title').innerText = 'Оформление';
    renderCartList(); // Отрисовать корзину с кнопками
    
    tg.MainButton.setText(`ОФОРМИТЬ (${state.totals.finalTotal} ₽)`);
    tg.MainButton.color = "#31b545";
    tg.BackButton.show();
    tg.BackButton.onClick(showCatalog);
}

function showCatalog() {
    document.getElementById('product-list').classList.remove('hidden');
    document.getElementById('cart-view').classList.add('hidden');
    document.getElementById('page-title').innerText = 'Каталог';
    renderProducts(); // Перерисовать каталог (чтобы обновились кнопки)
    
    updateMainButton();
    tg.BackButton.hide();
    tg.BackButton.offClick(showCatalog);
}

// Экспорт для HTML onchange (дата)
window.toggleDateInput = toggleDateInput;
window.changeQty = changeQty;
