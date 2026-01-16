async function submitOrder() {
    const name = document.getElementById('name').value;
    const phone = document.getElementById('phone').value;
    const address = document.getElementById('address').value;
    const deliveryType = document.getElementById('delivery-type').value;
    const comment = document.getElementById('comment').value;

    // --- 1. ПОЛУЧЕНИЕ ДАТЫ ---
    const rawDate = document.getElementById('custom-date').value; // Например: "2026-01-30"
    
    // Проверка: выбрана ли дата?
    if (!rawDate && !IS_LOCAL_MODE) {
        return tg.showAlert("Выберите дату доставки!");
    }

    // Красивая дата для отображения в таблице
    const dateVal = rawDate ? formatSmartDate(rawDate) : '';
    
    // --- 2. ВРЕМЯ НА УСТРОЙСТВЕ ---
    const deviceTime = new Date().toLocaleString('ru-RU');

    // Локальный режим
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
                    deliveryDate: dateVal, // Текст: "30 Января"
                    deliveryRaw: rawDate,  // ВАЖНО: Сырая дата "2026-01-30"
                    creationTime: deviceTime, // ВАЖНО: Время с телефона
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
        console.error(e);
    } finally {
        tg.MainButton.hideProgress();
    }
}
