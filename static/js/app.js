// --- Global State ---
let currentUserRole = 'none'; // 'none', 'cashier', 'owner'
let isLoggedIn = false;
let setupComplete = false;
let scannedProduct = null;
let cart = [];
let selectedDiscount = 0; // 0, 10, or 20
let quantity = 1;
let sessionSales = [];
let sessionServices = [];
let sessionExpenses = [];
let activeShift = null;
let selectedPaymentMethod = 'cash';
let selectedServicePaymentMethod = 'cash';

// Scanner focus controller variables - no fragile buffer timings needed
let currentEditingOldStock = 0; // Tracks stock level prior to editing for label count calculations
let currentStatsData = null; // Caches analytics metrics globally for modal detail popups
let currentPrintProduct = null; // Caches product currently loaded in the print preview modal
let productsCache = [];
let productsBarcodeMap = new Map();
let productsIdMap = new Map();

function rebuildProductMaps() {
    productsBarcodeMap.clear();
    productsIdMap.clear();
    if (!Array.isArray(productsCache)) return;
    for (let i = 0; i < productsCache.length; i++) {
        const p = productsCache[i];
        if (p.id) productsIdMap.set(p.id, p);
        if (p.barcode) {
            const raw = String(p.barcode).trim();
            const clean = raw.replace(/\D/g, "");
            productsBarcodeMap.set(raw, p);
            if (clean && clean !== raw) {
                productsBarcodeMap.set(clean, p);
            }
            if (raw.includes(',')) {
                raw.split(',').forEach(sub => {
                    const sTrim = sub.trim();
                    const sClean = sTrim.replace(/\D/g, "");
                    if (sTrim) productsBarcodeMap.set(sTrim, p);
                    if (sClean) productsBarcodeMap.set(sClean, p);
                });
            }
        }
    }
}

let preloadedActiveShift = null;
let preloadedActiveShiftLoaded = false;
let preloadedCashiers = [];
let preloadedCashiersLoaded = false;
let auditSessionActive = false;
let auditProducts = []; // Caches warehouse products for voice searches
let collapsedGroups = {};
let selectedProductIds = new Set();
let groupsCache = {};
let visibleProductsCache = [];
let currentSearchQuery = "";
let filterType = "";
let filterBrand = "";
let filterModel = "";
let filterSuffix = "";
let filterGeneral = "";
let recognition = null; // Speech recognition instance
let isListening = false; // State of microphone listener

// --- Audio Context Synth ---
let audioCtx = null;

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

function playScanBeep() {
    try {
        initAudio();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1000, audioCtx.currentTime); // 1000Hz
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
        
        osc.start();
        osc.stop(audioCtx.currentTime + 0.08);
    } catch (e) {
        console.error("Audio error:", e);
    }
}

function playSuccessBeep() {
    try {
        initAudio();
        const now = audioCtx.currentTime;
        
        // Pitch 1
        const osc1 = audioCtx.createOscillator();
        const gain1 = audioCtx.createGain();
        osc1.connect(gain1);
        gain1.connect(audioCtx.destination);
        osc1.frequency.setValueAtTime(987.77, now); // B5 note
        gain1.gain.setValueAtTime(0.06, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc1.start(now);
        osc1.stop(now + 0.12);
        
        // Pitch 2 (chord-like ring)
        const osc2 = audioCtx.createOscillator();
        const gain2 = audioCtx.createGain();
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.frequency.setValueAtTime(1318.51, now + 0.05); // E6 note
        gain2.gain.setValueAtTime(0.06, now + 0.05);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc2.start(now + 0.05);
        osc2.stop(now + 0.22);
    } catch (e) {
        console.error("Audio error:", e);
    }
}

function playErrorBuzz() {
    try {
        initAudio();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, audioCtx.currentTime); // Low buzz
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
        
        osc.start();
        osc.stop(audioCtx.currentTime + 0.25);
    } catch (e) {
        console.error("Audio error:", e);
    }
}

// --- Initial Setup & Listeners ---
document.addEventListener("DOMContentLoaded", () => {
    checkAuthStatus();
    preloadRoleSelectionData();
    setupEventListeners();
    setupScannerListener();
    setupUpdateEventListeners();
    checkAppVersionUpdate();
});

function preloadRoleSelectionData() {
    // 1. Preload active shift in background
    fetch('/api/shift/active')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                preloadedActiveShift = data.shift;
                preloadedActiveShiftLoaded = true;
                updateShiftUI(data.shift);
            }
        })
        .catch(() => { preloadedActiveShiftLoaded = true; });

    // 2. Preload cashiers list for instant 0ms auth modal
    fetch('/api/cashiers')
        .then(res => res.json())
        .then(cashiers => {
            if (Array.isArray(cashiers)) {
                preloadedCashiers = cashiers;
                preloadedCashiersLoaded = true;
                populateCashierSelect(cashiers);
            }
        })
        .catch(() => { preloadedCashiersLoaded = true; });

    // 3. Preload catalog products in background so warehouse is pre-cached
    loadProducts();
}

function populateCashierSelect(cashiers) {
    const select = document.getElementById("cashier-login-select");
    if (!select || !Array.isArray(cashiers)) return;
    let html = '';
    cashiers.forEach(c => {
        html += `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.email || '')})</option>`;
    });
    select.innerHTML = html;
}

// --- App Version Update Notification & Execution ---
function checkAppVersionUpdate() {
    fetch('/api/system/version')
        .then(res => res.json())
        .then(data => {
            if (data.success && data.update_available) {
                const curVer = data.current_version;
                const remVer = data.remote_version;
                
                const modalRemote = document.getElementById("update-modal-remote-version");
                const modalCurrent = document.getElementById("update-modal-current-version");
                const bannerRemote = document.getElementById("banner-remote-version");
                const bannerLocal = document.getElementById("banner-local-version");
                
                if (modalRemote) modalRemote.innerText = `v${remVer}`;
                if (modalCurrent) modalCurrent.innerText = `v${curVer}`;
                if (bannerRemote) bannerRemote.innerText = `v${remVer}`;
                if (bannerLocal) bannerLocal.innerText = `v${curVer}`;
                
                const modal = document.getElementById("modal-app-update");
                if (modal) modal.classList.add("active");
                
                const banner = document.getElementById("app-update-top-banner");
                if (banner) banner.style.display = "block";
            }
        })
        .catch(err => console.error("Error checking app version update:", err));
}

function executeAppUpdate() {
    const btnApply = document.getElementById("btn-update-modal-apply");
    const btnBanner = document.getElementById("btn-banner-update-now");
    const progressContainer = document.getElementById("update-progress-container");
    const progressStatus = document.getElementById("update-progress-status");
    
    if (btnApply) btnApply.disabled = true;
    if (btnBanner) btnBanner.disabled = true;
    if (progressContainer) progressContainer.style.display = "block";
    if (progressStatus) progressStatus.innerText = "Загрузка обновления с VPS сервера (пожалуйста, подождите)...";
    
    // Ensure modal is shown with progress
    const modal = document.getElementById("modal-app-update");
    if (modal) modal.classList.add("active");
    
    fetch('/api/system/apply_update', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                if (progressStatus) progressStatus.innerText = "Обновление готово! Программа перезапускается...";
                setTimeout(() => {
                    window.location.reload();
                }, 3000);
            } else {
                alert(data.message || "Ошибка при обновлении");
                if (btnApply) btnApply.disabled = false;
                if (btnBanner) btnBanner.disabled = false;
                if (progressContainer) progressContainer.style.display = "none";
            }
        })
        .catch(err => {
            console.error("Update apply network error (restarting?):", err);
            if (progressStatus) progressStatus.innerText = "Приложение обновляется и перезапускается...";
            setTimeout(() => { window.location.reload(); }, 4000);
        });
}

function setupUpdateEventListeners() {
    const btnClose = document.getElementById("btn-update-modal-close");
    const btnLater = document.getElementById("btn-update-modal-later");
    const btnApply = document.getElementById("btn-update-modal-apply");
    const btnBanner = document.getElementById("btn-banner-update-now");
    const modal = document.getElementById("modal-app-update");
    
    if (btnClose && modal) {
        btnClose.addEventListener("click", () => modal.classList.remove("active"));
    }
    if (btnLater && modal) {
        btnLater.addEventListener("click", () => modal.classList.remove("active"));
    }
    if (btnApply) {
        btnApply.addEventListener("click", executeAppUpdate);
    }
    if (btnBanner) {
        btnBanner.addEventListener("click", executeAppUpdate);
    }
}

function checkAuthStatus() {
    fetch('/api/auth/status')
        .then(res => res.json())
        .then(data => {
            setupComplete = data.setup_complete;
            isLoggedIn = data.logged_in;
        })
        .catch(err => console.error("Error checking auth:", err));
}

// --- Navigation ---
function highlightText(text, query) {
    if (!text) return "";
    const str = String(text);
    if (!query || query.trim() === "") return escapeHtml(str);
    const q = query.toLowerCase().trim();
    const idx = str.toLowerCase().indexOf(q);
    if (idx === -1) return escapeHtml(str);
    
    const before = str.substring(0, idx);
    const match = str.substring(idx, idx + q.length);
    const after = str.substring(idx + q.length);
    
    return escapeHtml(before) + 
           `<mark style="background: #ffd54f; color: #000; padding: 1px 3px; border-radius: 3px; font-weight: bold;">${escapeHtml(match)}</mark>` + 
           highlightText(after, query);
}

function showView(viewId) {
    document.querySelectorAll(".view-panel").forEach(panel => {
        panel.classList.remove("active");
    });
    document.getElementById(viewId).classList.add("active");
}

function showTab(tabId) {
    document.querySelectorAll(".nav-tab").forEach(tab => {
        tab.classList.remove("active");
    });
    document.querySelectorAll(".tab-content").forEach(content => {
        content.classList.remove("active");
    });
    
    // Find matching tab button
    const activeTabButton = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
    if (activeTabButton) activeTabButton.classList.add("active");
    
    const targetContent = document.getElementById(tabId);
    if (targetContent) targetContent.classList.add("active");
    
    // Load fresh data if clicking specific tab
    if (tabId === 'tab-warehouse') {
        loadProducts();
    } else if (tabId === 'tab-reconciliation') {
        loadProducts();
        setTimeout(populateAuditFilters, 100);
        resetAuditSession();
        setTimeout(loadDiscrepancies, 150);
    } else if (tabId === 'tab-analytics') {
        loadStats();
        setTimeout(loadWishes, 50);
    } else if (tabId === 'tab-charts') {
        loadChartsData();
    } else if (tabId === 'tab-case-matrix') {
        loadProcurementAnalytics();
        loadCaseMatrixAnalytics();
    } else if (tabId === 'tab-settings') {
        loadGDriveSettings();
        loadGDriveStatus();
        loadGDriveBackups();
        loadCashiersList();
    } else if (tabId === 'tab-shifts') {
        loadShiftsHistory();
    } else if (tabId === 'tab-finance') {
        loadExpenses();
        loadPurchases();
    }
}

// --- Global Scanner Input Autofocus & Event Listener ---
// Capturing scanner keystrokes via native focus is 100% stable across all scanner models
function setupScannerListener() {
    const input = document.getElementById("manual-scan-input");
    if (!input) return;

    // Log character inputs in real-time for diagnostic checks
    input.addEventListener("input", (e) => {
        const debugEl = document.getElementById("debug-scan-status");
        if (debugEl) {
            debugEl.innerText = `Ввод символов: "${e.target.value}"`;
        }
    });

    // Handle keypresses on the scanner input field
    input.addEventListener("keydown", (e) => {
        const debugEl = document.getElementById("debug-scan-status");
        if (e.key === 'Enter') {
            e.preventDefault();
            const code = input.value.trim();
            if (debugEl) {
                debugEl.innerText = `Нажат Enter. Запуск поиска для: "${code}"`;
            }
            if (code) {
                handleScannedBarcode(code);
                input.value = ""; // Clear input immediately
            }
        }
    });

    // Restore focus to input on window click
    window.addEventListener("click", () => {
        setTimeout(keepScannerInputFocused, 50);
    });

    // Restore focus when Cashier workspace starts
    const cashierSelectBtn = document.getElementById("btn-select-cashier");
    if (cashierSelectBtn) {
        cashierSelectBtn.addEventListener("click", () => {
            setTimeout(() => {
                if (input) input.focus();
            }, 100);
        });
    }

    // Safety interval autofocus check (every 1 second)
    setInterval(keepScannerInputFocused, 1000);
}

function keepScannerInputFocused() {
    // If any modal dialog is currently open, DO NOT autofocus scanner input
    if (document.querySelector(".modal-backdrop.active") || document.querySelector(".modal-backdrop[style*='display: flex']")) {
        return;
    }

    const viewCashier = document.getElementById("view-cashier");
    if (!viewCashier || !viewCashier.classList.contains("active")) {
        return;
    }

    const cashierSalesPanel = document.getElementById("cashier-sales-panel");
    const cashierReconPanel = document.getElementById("cashier-recon-panel");
    const activeEl = document.activeElement;

    // Don't hijack focus if cashier is typing/editing in ANY input, select, or button
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'BUTTON')) {
        return;
    }

    if (cashierSalesPanel && cashierSalesPanel.style.display !== "none") {
        const input = document.getElementById("manual-scan-input");
        if (input) input.focus();
    } else if (cashierReconPanel && cashierReconPanel.style.display === "grid") {
        const input = document.getElementById("cashier-recon-product-search");
        if (input) input.focus();
    }

    // Autofocus scanner on owner's reconciliation tab if audit session is active
    const auditTab = document.getElementById("tab-reconciliation");
    const auditInput = document.getElementById("audit-scan-input");
    if (auditInput && auditTab && auditTab.classList.contains("active") && typeof auditSessionActive !== 'undefined' && auditSessionActive) {
        if (activeEl && activeEl !== auditInput) {
            if (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT') {
                return;
            }
        }
        auditInput.focus();
    }
}

// --- Handle Scanned Barcode/QR with Instant 0ms In-Memory Matching ---
function handleScannedBarcode(barcode) {
    const debugEl = document.getElementById("debug-scan-status");
    
    // Only process scans if cashier view is open
    const viewCashier = document.getElementById("view-cashier");
    if (!viewCashier.classList.contains("active")) {
        console.log("Ignored scan: Cashier screen is not active.");
        if (debugEl) debugEl.innerText = "Игнорировано: Окно кассы не активно.";
        return;
    }

    if (!activeShift) {
        playErrorBuzz();
        alert("Смена не открыта! Пожалуйста, откройте смену, чтобы сканировать товары.");
        if (debugEl) debugEl.innerText = "Игнорировано: Смена закрыта.";
        return;
    }

    const rawBarcode = String(barcode).trim();
    // Clean barcode: strip any non-digit characters
    const cleanBarcode = rawBarcode.replace(/\D/g, "");
    
    if (!cleanBarcode && !rawBarcode) {
        if (debugEl) debugEl.innerText = `Ошибка: пустой код (оригинал: "${barcode}")`;
        return;
    }

    const addProductToCart = (prod) => {
        const existingItem = cart.find(item => item.product.id === prod.id);
        if (existingItem) {
            if (existingItem.quantity + 1 <= prod.stock) {
                existingItem.quantity += 1;
                playScanBeep();
                renderCart();
                if (debugEl) debugEl.innerText = `Добавлено: ${prod.name} (Кол-во: ${existingItem.quantity})`;
            } else {
                playErrorBuzz();
                alert(`Недостаточно товара "${prod.name}" на складе! В наличии всего ${prod.stock} шт.`);
            }
        } else {
            if (prod.stock >= 1) {
                cart.push({ product: prod, quantity: 1, discount: 0 });
                playScanBeep();
                renderCart();
                if (debugEl) debugEl.innerText = `В корзине: ${prod.name} (1 шт.)`;
            } else {
                playErrorBuzz();
                alert(`Товар "${prod.name}" закончился на складе!`);
            }
        }
    };

    // 1. ULTRA-FAST PATH: Instant lookup from client RAM Map (0.0001s)
    let prod = productsBarcodeMap.get(cleanBarcode) || productsBarcodeMap.get(rawBarcode);
    
    if (!prod && Array.isArray(productsCache) && productsCache.length > 0) {
        prod = productsCache.find(p => {
            if (!p.barcode) return false;
            const pb = String(p.barcode).trim();
            const pbClean = pb.replace(/\D/g, "");
            return pb === rawBarcode || (cleanBarcode && (pbClean === cleanBarcode || pb === cleanBarcode));
        });
        if (prod) {
            if (cleanBarcode) productsBarcodeMap.set(cleanBarcode, prod);
            productsBarcodeMap.set(rawBarcode, prod);
        }
    }

    if (prod) {
        // Instant match! Zero network round-trip!
        if (debugEl) debugEl.innerText = `⚡ Мгновенно (0 мс) из памяти: ${prod.name}`;
        addProductToCart(prod);
        return;
    }

    // 2. FALLBACK PATH: If product is not in memory, query server
    if (debugEl) debugEl.innerText = `Поиск на сервере: "${cleanBarcode || rawBarcode}"...`;
    const searchCode = cleanBarcode || encodeURIComponent(rawBarcode);
    fetch(`/api/products/${searchCode}`)
        .then(res => res.json())
        .then(data => {
            if (data.success && data.product) {
                const fetchedProd = data.product;
                if (Array.isArray(productsCache)) {
                    productsCache.push(fetchedProd);
                }
                if (cleanBarcode) productsBarcodeMap.set(cleanBarcode, fetchedProd);
                productsBarcodeMap.set(rawBarcode, fetchedProd);
                addProductToCart(fetchedProd);
            } else {
                playErrorBuzz();
                if (debugEl) debugEl.innerText = `База данных вернула ошибку: "${data.message}" (штрихкод: "${cleanBarcode || rawBarcode}")`;
                alert(`Штрихкод "${cleanBarcode || rawBarcode}" не найден в каталоге.`);
            }
        })
        .catch(err => {
            playErrorBuzz();
            console.error("Scan lookup error:", err);
            if (debugEl) debugEl.innerText = `Сетевая ошибка: ${err.message}`;
        });
}

function renderCart() {
    const placeholder = document.getElementById("scanned-product-placeholder");
    const details = document.getElementById("scanned-product-details");
    
    if (cart.length === 0) {
        placeholder.classList.remove("display-none");
        details.classList.add("display-none");
        return;
    }
    
    placeholder.classList.add("display-none");
    details.classList.remove("display-none");
    
    const tbody = document.getElementById("cart-items-body");
    tbody.innerHTML = "";
    
    let totalOriginal = 0;
    let totalFinal = 0;
    
    cart.forEach((item, idx) => {
        const p = item.product;
        const origPrice = p.price;
        const itemDiscount = item.discount;
        const finalPrice = Math.round(origPrice * (1 - itemDiscount / 100));
        const subtotalOriginal = origPrice * item.quantity;
        const subtotalFinal = finalPrice * item.quantity;
        
        totalOriginal += subtotalOriginal;
        totalFinal += subtotalFinal;
        
        const tr = document.createElement("tr");
        tr.style.borderBottom = "1px solid var(--border-color)";
        tr.innerHTML = `
            <td style="padding: 10px 4px;">
                <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(p.name)}</div>
                <div style="font-size: 0.75rem; color: var(--text-secondary);">Код: ${p.barcode.split(',')[0]} | Ост: ${p.stock}</div>
            </td>
            <td style="padding: 10px 4px; text-align: right; white-space: nowrap;">${formatCurrency(origPrice)}</td>
            <td style="padding: 10px 4px; text-align: center;">
                <div class="quantity-input-wrapper" style="margin: 0 auto; scale: 0.85; width: fit-content;">
                    <button class="qty-btn" type="button" onclick="updateCartItemQty(${idx}, -1)">-</button>
                    <span style="min-width: 24px; text-align: center; font-weight: bold; font-size: 1rem;">${item.quantity}</span>
                    <button class="qty-btn" type="button" onclick="updateCartItemQty(${idx}, 1)">+</button>
                </div>
            </td>
            <td style="padding: 10px 4px; text-align: center;">
<div class="discount-control-wrapper" style="display: inline-flex; align-items: center; gap: 4px; scale: 0.85; margin: 0 auto; justify-content: center; width: fit-content;">
    <button class="qty-btn" type="button" onclick="adjustCartItemDiscount(${idx}, -1)" style="font-weight: bold; width: 24px; height: 24px; padding: 0; line-height: 22px; display: inline-flex; align-items: center; justify-content: center;">-</button>
    <input type="number" value="${itemDiscount}" min="0" max="40" style="width: 46px; height: 26px; padding: 3px; border-radius: 6px; background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: #fff; text-align: center; font-weight: bold; font-size: 0.85rem;" onchange="updateCartItemDiscount(${idx}, this.value)" onfocus="this.select()">
    <span style="color: var(--text-secondary); font-size: 0.85rem; font-weight: bold; margin-left: -2px; margin-right: 2px;">%</span>
    <button class="qty-btn" type="button" onclick="adjustCartItemDiscount(${idx}, 1)" style="font-weight: bold; width: 24px; height: 24px; padding: 0; line-height: 22px; display: inline-flex; align-items: center; justify-content: center;">+</button>
</div>
</td>
            <td style="padding: 10px 4px; text-align: right; font-weight: 600; white-space: nowrap;">${formatCurrency(subtotalFinal)}</td>
            <td style="padding: 10px 4px; text-align: center;">
                <button type="button" class="action-icon-btn btn-defect-stock" style="background: rgba(255, 61, 0, 0.1); color: #ff3d00; border-color: rgba(255, 61, 0, 0.2); padding: 6px; display: inline-flex; align-items: center; justify-content: center; margin-top: 0;" onclick="removeCartItem(${idx})" title="Удалить">
                    <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    const origEl = document.getElementById("cart-total-original");
    if (totalOriginal > totalFinal) {
        origEl.innerText = `${formatCurrency(totalOriginal)} сум`;
        origEl.style.display = "block";
    } else {
        origEl.style.display = "none";
    }
    document.getElementById("cart-total-final").innerText = `${formatCurrency(totalFinal)} сум`;
}

function updateCartItemQty(idx, delta) {
    if (idx < 0 || idx >= cart.length) return;
    const item = cart[idx];
    const newQty = item.quantity + delta;
    if (newQty <= 0) {
        cart.splice(idx, 1);
        showToastMessage("Товар удален из корзины");
    } else if (newQty > item.product.stock) {
        alert(`Недостаточно товара на складе! Доступно: ${item.product.stock} шт.`);
    } else {
        item.quantity = newQty;
    }
    renderCart();
}

function updateCartItemDiscount(idx, val) {
    if (idx < 0 || idx >= cart.length) return;
    let num = parseInt(val);
    if (isNaN(num)) num = 0;
    if (num < 0) num = 0;
    if (num > 40) num = 40;
    cart[idx].discount = num;
    renderCart();
}

function adjustCartItemDiscount(idx, delta) {
    if (idx < 0 || idx >= cart.length) return;
    let num = cart[idx].discount + delta;
    if (num < 0) num = 0;
    if (num > 40) num = 40;
    cart[idx].discount = num;
    renderCart();
}

function removeCartItem(idx) {
    if (idx < 0 || idx >= cart.length) return;
    cart.splice(idx, 1);
    renderCart();
    showToastMessage("Товар удален из корзины");
}

function clearCart() {
    cart = [];
    renderCart();
    showToastMessage("Корзина очищена");
}

// --- Event Listeners Setup ---
function setupEventListeners() {
    // Write-off Modal Close & Submit Events
    const btnWriteOffClose = document.getElementById("btn-write-off-close");
    if (btnWriteOffClose) {
        btnWriteOffClose.addEventListener("click", () => {
            document.getElementById("modal-write-off").classList.remove("active");
        });
    }
    const btnWriteOffCancel = document.getElementById("btn-write-off-cancel");
    if (btnWriteOffCancel) {
        btnWriteOffCancel.addEventListener("click", () => {
            document.getElementById("modal-write-off").classList.remove("active");
        });
    }
    const btnWriteOffSubmit = document.getElementById("btn-write-off-submit");
    if (btnWriteOffSubmit) {
        btnWriteOffSubmit.addEventListener("click", () => {
            const qtyInput = document.getElementById("write-off-qty");
            const reasonInput = document.getElementById("write-off-reason");
            
            const quantity = parseInt(qtyInput.value);
            const reason = reasonInput.value.trim();
            
            if (isNaN(quantity) || quantity <= 0) {
                alert("Пожалуйста, введите корректное количество!");
                return;
            }
            if (quantity > currentWriteOffProductStock) {
                alert(`Недостаточно товара на складе! В наличии: ${currentWriteOffProductStock} шт.`);
                return;
            }
            if (!reason) {
                alert("Пожалуйста, укажите причину списания!");
                return;
            }
            
            fetch(`/api/products/${currentWriteOffProductId}/defective`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity, reason })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    showToastMessage(`Успешно списано ${quantity} шт.`);
                    document.getElementById("modal-write-off").classList.remove("active");
                    loadProducts();
                    loadStats();
                } else {
                    alert(data.message);
                }
            })
            .catch(err => {
                console.error("Defective write-off error:", err);
                alert("Ошибка сети при списании товара.");
            });
        });
    }

    // Product History Close
    const btnHistClose = document.getElementById("btn-product-history-close");
    if (btnHistClose) {
        btnHistClose.addEventListener("click", () => {
            document.getElementById("modal-product-history").classList.remove("active");
        });
    }
    const btnHistCancel = document.getElementById("btn-product-history-cancel");
    if (btnHistCancel) {
        btnHistCancel.addEventListener("click", () => {
            document.getElementById("modal-product-history").classList.remove("active");
        });
    }

    // Audit scan input enter listener
    const auditScanInput = document.getElementById("audit-scan-input");
    if (auditScanInput) {
        auditScanInput.addEventListener("keydown", (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const code = auditScanInput.value.trim();
                if (code) {
                    handleAuditScan(code);
                    auditScanInput.value = "";
                }
            }
        });
    }

    // Setup bulk select all checkbox
    const bulkSelectAll = document.getElementById("bulk-select-all");
    if (bulkSelectAll) {
        bulkSelectAll.addEventListener("change", () => {
            if (bulkSelectAll.checked) {
                visibleProductsCache.forEach(p => selectedProductIds.add(p.id));
            } else {
                visibleProductsCache.forEach(p => selectedProductIds.delete(p.id));
            }
            updateSelectionUI();
        });
    }
    // Wish input Enter key handler
    const wishInp = document.getElementById("cashier-wish-input");
    if (wishInp) {
        wishInp.addEventListener("keydown", (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addCustomerWish();
            }
        });
    }
    
    // Global Enter key listener for print barcode label modal
    document.addEventListener("keydown", (e) => {
        if (e.key === 'Enter') {
            const printModal = document.getElementById("modal-print-label");
            if (printModal && printModal.classList.contains("active")) {
                e.preventDefault();
                const printBtn = document.getElementById("btn-print-action");
                if (printBtn) {
                    printBtn.click();
                }
            }
        }
    });

    // Edit sale modal close listeners
    const btnEditSaleClose = document.getElementById("btn-edit-sale-close");
    const btnEditSaleCancel = document.getElementById("btn-edit-sale-cancel");
    const modalEditSale = document.getElementById("modal-edit-sale");
    
    if (btnEditSaleClose && modalEditSale) {
        btnEditSaleClose.addEventListener("click", () => modalEditSale.classList.remove("active"));
    }
    if (btnEditSaleCancel && modalEditSale) {
        btnEditSaleCancel.addEventListener("click", () => modalEditSale.classList.remove("active"));
    }

    // Shift sales detail modal close
    const btnShiftSalesClose1 = document.getElementById("btn-shift-sales-modal-close");
    const btnShiftSalesClose2 = document.getElementById("btn-shift-sales-detail-close-btn");
    const modalShiftSales = document.getElementById("modal-shift-sales-detail");
    
    if (btnShiftSalesClose1 && modalShiftSales) {
        btnShiftSalesClose1.addEventListener("click", () => {
            modalShiftSales.classList.remove("active");
        });
    }
    if (btnShiftSalesClose2 && modalShiftSales) {
        btnShiftSalesClose2.addEventListener("click", () => {
            modalShiftSales.classList.remove("active");
        });
    }

    // Role selection - Instant 0ms transition using preloaded in-memory state
    document.getElementById("btn-select-cashier").addEventListener("click", () => {
        initAudio();
        
        // Reset cashier screen
        scannedProduct = null;
        const placeholderEl = document.getElementById("scanned-product-placeholder");
        const detailsEl = document.getElementById("scanned-product-details");
        if (placeholderEl) placeholderEl.classList.remove("display-none");
        if (detailsEl) detailsEl.classList.add("display-none");
        
        const enterCashierScreen = (shift) => {
            showView("view-cashier");
            currentUserRole = 'cashier';
            updateShiftUI(shift);
        };

        const showCashierLogin = (cashiers) => {
            document.getElementById("cashier-login-password").value = "";
            if (Array.isArray(cashiers) && cashiers.length > 0) {
                populateCashierSelect(cashiers);
                document.getElementById("modal-cashier-auth").classList.add("active");
                setTimeout(() => {
                    const passInput = document.getElementById("cashier-login-password");
                    if (passInput) passInput.focus();
                }, 50);
            } else {
                enterCashierScreen(null);
            }
        };

        // If preloaded state is ready: 0ms INSTANT transition!
        if (preloadedActiveShiftLoaded) {
            if (preloadedActiveShift) {
                enterCashierScreen(preloadedActiveShift);
            } else {
                showCashierLogin(preloadedCashiers);
            }
            return;
        }

        // If user clicked immediately within first 100ms before prewarm completed:
        const btn = document.getElementById("btn-select-cashier");
        const originalOpacity = btn.style.opacity;
        btn.style.opacity = "0.7";
        btn.style.pointerEvents = "none";

        Promise.all([
            fetch('/api/shift/active').then(res => res.json()).catch(() => ({ success: false })),
            fetch('/api/cashiers').then(res => res.json()).catch(() => [])
        ]).then(([shiftData, cashiers]) => {
            btn.style.opacity = originalOpacity || "1";
            btn.style.pointerEvents = "auto";
            preloadedActiveShift = (shiftData && shiftData.success) ? shiftData.shift : null;
            preloadedActiveShiftLoaded = true;
            if (Array.isArray(cashiers)) {
                preloadedCashiers = cashiers;
                preloadedCashiersLoaded = true;
            }
            if (preloadedActiveShift) {
                enterCashierScreen(preloadedActiveShift);
            } else {
                showCashierLogin(preloadedCashiers);
            }
        });
    });

    document.getElementById("btn-select-owner").addEventListener("click", () => {
        initAudio();
        // Check local auth status directly - 0ms instant transition!
        if (isLoggedIn) {
            showView("view-owner");
            showTab("tab-warehouse");
            currentUserRole = 'owner';
        } else {
            // Open auth modal immediately without waiting for any network round-trip!
            openAuthModal();
        }
    });

    // Back to roles buttons
    const btnCashierBack = document.getElementById("btn-cashier-back");
    if (btnCashierBack) {
        btnCashierBack.addEventListener("click", () => {
            showView("view-role-selection");
            currentUserRole = 'none';
        });
    }
    
    // Owner logout
    document.getElementById("btn-owner-logout").addEventListener("click", () => {
        fetch('/api/auth/logout', { method: 'POST' })
            .then(res => res.json())
            .then(() => {
                isLoggedIn = false;
                showView("view-role-selection");
                currentUserRole = 'none';
            });
    });

    // Tabs navigation
    document.querySelectorAll(".nav-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            showTab(tab.dataset.tab);
        });
    });

    // Period Toggle listeners in Analytics tab
    document.querySelectorAll(".btn-period").forEach(btn => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll(".btn-period").forEach(b => {
                b.classList.remove("active");
                b.style.background = "transparent";
                b.style.color = "var(--text-secondary)";
            });
            btn.classList.add("active");
            btn.style.background = "linear-gradient(135deg, #1a73e8, #7c4dff)";
            btn.style.color = "white";
            
            analyticsPeriod = btn.dataset.period;
            renderStats();
            if (currentStatsData) { renderCharts(currentStatsData); }
        });
    });

    // Manual scan button
    document.getElementById("btn-manual-scan").addEventListener("click", () => {
        const input = document.getElementById("manual-scan-input");
        const val = input.value.trim();
        if (val) {
            handleScannedBarcode(val);
            input.value = "";
        }
    });

    // Payment method toggles
    document.querySelectorAll("#cart-payment-methods .discount-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            document.querySelectorAll("#cart-payment-methods .discount-btn").forEach(b => b.classList.remove("active"));
            e.currentTarget.classList.add("active");
            selectedPaymentMethod = e.currentTarget.dataset.payment;
            
            const splitBox = document.getElementById("cart-mix-split-box");
            if (selectedPaymentMethod === 'mix') {
                if (splitBox) splitBox.style.display = "block";
                openMixModal();
            } else {
                if (splitBox) splitBox.style.display = "none";
            }
        });
    });

    // Mix modal close & confirm listeners
    const btnMixClose = document.getElementById("btn-mix-modal-close");
    if (btnMixClose) btnMixClose.addEventListener("click", closeMixModal);
    const btnMixCancel = document.getElementById("btn-mix-cancel");
    if (btnMixCancel) btnMixCancel.addEventListener("click", closeMixModal);
    const btnMixConfirm = document.getElementById("btn-confirm-mix-sale");
    if (btnMixConfirm) btnMixConfirm.addEventListener("click", submitMixSale);
    
    // Mix cash input listeners (Modal)
    const mixCashInp = document.getElementById("mix-cash-input");
    if (mixCashInp) {
        mixCashInp.addEventListener("input", () => updateMixCalculations('modal'));
        mixCashInp.addEventListener("keydown", (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitMixSale();
            }
        });
    }

    // Mix cash input listeners (Inline Box)
    const inlineMixCashInp = document.getElementById("inline-mix-cash-input");
    if (inlineMixCashInp) {
        inlineMixCashInp.addEventListener("input", () => updateMixCalculations('inline'));
        inlineMixCashInp.addEventListener("keydown", (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitSale();
            }
        });
    }

    // Confirm checkout sale
    document.getElementById("btn-confirm-sale").addEventListener("click", submitSale);

    // Clear cart
    document.getElementById("btn-clear-cart").addEventListener("click", () => {
        clearCart();
    });

    // Auth modal controls
    document.getElementById("btn-auth-modal-close").addEventListener("click", closeAuthModal);
    document.getElementById("btn-auth-cancel").addEventListener("click", closeAuthModal);
    document.getElementById("form-owner-auth").addEventListener("submit", submitOwnerAuth);

    // Warehouse search filters
    const inpType = document.getElementById("filter-prd-type");
    const inpBrand = document.getElementById("filter-prd-brand");
    const inpModel = document.getElementById("filter-prd-model");
    const inpSuffix = document.getElementById("filter-prd-suffix");
    const inpGeneral = document.getElementById("filter-prd-general");

    const onFilterChange = () => {
        filterType = inpType ? inpType.value.toLowerCase().trim() : "";
        filterBrand = inpBrand ? inpBrand.value.toLowerCase().trim() : "";
        filterModel = inpModel ? inpModel.value.toLowerCase().trim() : "";
        filterSuffix = inpSuffix ? inpSuffix.value.toLowerCase().trim() : "";
        filterGeneral = inpGeneral ? inpGeneral.value.toLowerCase().trim() : "";
        renderProductsTable();
    };

    // Cascading datalist triggers for filters context
    const triggerFilterDatalistUpdate = () => updateDynamicDatalists('filter');

    if (inpType) {
        inpType.addEventListener("input", onFilterChange);
        inpType.addEventListener("input", triggerFilterDatalistUpdate);
        inpType.addEventListener("focus", triggerFilterDatalistUpdate);
    }
    if (inpBrand) {
        inpBrand.addEventListener("input", onFilterChange);
        inpBrand.addEventListener("input", triggerFilterDatalistUpdate);
        inpBrand.addEventListener("focus", triggerFilterDatalistUpdate);
    }
    if (inpModel) {
        inpModel.addEventListener("input", onFilterChange);
        inpModel.addEventListener("input", triggerFilterDatalistUpdate);
        inpModel.addEventListener("focus", triggerFilterDatalistUpdate);
    }
    if (inpSuffix) {
        inpSuffix.addEventListener("input", onFilterChange);
        inpSuffix.addEventListener("input", triggerFilterDatalistUpdate);
        inpSuffix.addEventListener("focus", triggerFilterDatalistUpdate);
    }
    if (inpGeneral) {
        inpGeneral.addEventListener("input", onFilterChange);
    }

    // Cascading datalist triggers for Add Product context
    const addTypeEl = document.getElementById("new-prd-type");
    const addBrandEl = document.getElementById("new-prd-brand");
    const addModelEl = document.getElementById("new-prd-model");
    const addSuffixEl = document.getElementById("new-prd-suffix");

    const triggerAddDatalistUpdate = () => updateDynamicDatalists('add');

    if (addTypeEl) {
        addTypeEl.addEventListener("input", triggerAddDatalistUpdate);
        addTypeEl.addEventListener("focus", triggerAddDatalistUpdate);
    }
    if (addBrandEl) {
        addBrandEl.addEventListener("input", triggerAddDatalistUpdate);
        addBrandEl.addEventListener("focus", triggerAddDatalistUpdate);
    }
    if (addModelEl) {
        addModelEl.addEventListener("input", triggerAddDatalistUpdate);
        addModelEl.addEventListener("focus", triggerAddDatalistUpdate);
    }
    if (addSuffixEl) {
        addSuffixEl.addEventListener("input", triggerAddDatalistUpdate);
        addSuffixEl.addEventListener("focus", triggerAddDatalistUpdate);
    }

    const whSearch = document.getElementById("warehouse-search");
    if (whSearch) {
        whSearch.addEventListener("input", (e) => {
            filterGeneral = e.target.value.toLowerCase().trim();
            renderProductsTable();
        });
    }

    // Product form submission
    document.getElementById("form-add-product").addEventListener("submit", submitAddProduct);

    // Edit Modal close
    document.getElementById("btn-edit-modal-close").addEventListener("click", closeEditModal);
    document.getElementById("btn-edit-cancel").addEventListener("click", closeEditModal);
    document.getElementById("form-edit-product").addEventListener("submit", submitEditProduct);

    // Shutdown System
    document.getElementById("btn-shutdown-system").addEventListener("click", () => {
        if (confirm("Вы уверены, что хотите полностью выключить CRM-систему?\nФоновый процесс сервера будет остановлен.")) {
            fetch('/api/app/shutdown', { method: 'POST' })
                .then(res => res.json())
                .then(data => {
                    if (data.success) {
                        alert(data.message);
                        document.body.innerHTML = `
                            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#121212; color:#fff; font-family:sans-serif; text-align:center; padding: 20px;">
                                <svg viewBox="0 0 24 24" width="64" height="64" stroke="#ff3d00" stroke-width="2" fill="none" style="margin-bottom:20px;"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
                                <h2 style="font-size:1.8rem; margin-bottom:10px;">CRM система выключена</h2>
                                <p style="color:#888; font-size:1rem; max-width:400px; line-height:1.5;">Фоновый сервер остановлен. Теперь вы можете безопасно закрыть эту вкладку или окно браузера.</p>
                            </div>
                        `;
                    } else {
                        alert(data.message);
                    }
                })
                .catch(err => {
                    // Since server shut down, request might fail/cancel immediately - that's expected
                    document.body.innerHTML = `
                        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#121212; color:#fff; font-family:sans-serif; text-align:center; padding: 20px;">
                            <svg viewBox="0 0 24 24" width="64" height="64" stroke="#ff3d00" stroke-width="2" fill="none" style="margin-bottom:20px;"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
                            <h2 style="font-size:1.8rem; margin-bottom:10px;">CRM система выключена</h2>
                            <p style="color:#888; font-size:1rem; max-width:400px; line-height:1.5;">Фоновый сервер успешно остановлен. Теперь вы можете безопасно закрыть эту вкладку или окно браузера.</p>
                        </div>
                    `;
                });
        }
    });

    // Print Modal close
    document.getElementById("btn-print-modal-close").addEventListener("click", closePrintModal);
    document.getElementById("btn-print-cancel").addEventListener("click", closePrintModal);
    document.getElementById("btn-print-action").addEventListener("click", () => {
        if (!currentPrintProduct) {
            closePrintModal();
            return;
        }
        
        const countInput = document.getElementById("print-label-count");
        const count = Math.max(1, countInput ? (parseInt(countInput.value) || 1) : 1);
        const printBtn = document.getElementById("btn-print-action");
        
        printBtn.disabled = true;
        printBtn.innerText = "Печать...";
        
        fetch('/api/print', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                barcode: currentPrintProduct.barcode,
                name: currentPrintProduct.name,
                price: currentPrintProduct.price,
                count: count
            })
        })
        .then(res => res.json())
        .then(data => {
            printBtn.disabled = false;
            printBtn.innerText = "Распечатать";
            if (data.success) {
                showToastMessage("Отправлено на принтер!");
                closePrintModal();
            } else {
                alert(data.message);
            }
        })
        .catch(err => {
            printBtn.disabled = false;
            printBtn.innerText = "Распечатать";
            console.error("Print error:", err);
            alert("Ошибка сети при отправке на печать.");
        });
    });

    // Analytics Detail Modal close
    const closeDetailModal = () => {
        document.getElementById("modal-analytics-detail").classList.remove("active");
    };
    document.getElementById("btn-analytics-detail-close").addEventListener("click", closeDetailModal);
    document.getElementById("btn-analytics-detail-close-btn").addEventListener("click", closeDetailModal);

    // Widget card click actions
    document.getElementById("card-revenue").addEventListener("click", () => openAnalyticsDetailModal("revenue"));
    document.getElementById("card-items-sold").addEventListener("click", () => openAnalyticsDetailModal("items-sold"));
    document.getElementById("card-net-profit").addEventListener("click", () => openAnalyticsDetailModal("net-profit"));
    document.getElementById("card-stock-valuation").addEventListener("click", () => openAnalyticsDetailModal("stock-valuation"));
    document.getElementById("card-shift-earnings").addEventListener("click", () => openAnalyticsDetailModal("shift-earnings"));
    document.getElementById("card-out-of-stock").addEventListener("click", () => openAnalyticsDetailModal("out-of-stock"));
    document.getElementById("card-total-products").addEventListener("click", () => openAnalyticsDetailModal("total-products"));

    // Gemini voice button event
    const voiceBtn = document.getElementById("btn-owner-voice");
    if (voiceBtn) {
        voiceBtn.addEventListener("click", toggleListening);
    }

    // Google Drive Sync tab listeners
    const gdriveForm = document.getElementById("form-gdrive-settings");
    if (gdriveForm) {
        gdriveForm.addEventListener("submit", saveGDriveSettings);
    }
    const gdriveAuthBtn = document.getElementById("btn-gdrive-auth");
    if (gdriveAuthBtn) {
        gdriveAuthBtn.addEventListener("click", authorizeGDrive);
    }
    const gdriveSyncBtn = document.getElementById("btn-gdrive-sync-now");
    if (gdriveSyncBtn) {
        gdriveSyncBtn.addEventListener("click", syncGDriveNow);
    }
    const gdriveBackupBtn = document.getElementById("btn-gdrive-backup-now");
    if (gdriveBackupBtn) {
        gdriveBackupBtn.addEventListener("click", backupGDriveNow);
    }
    const gdriveRestoreBtn = document.getElementById("btn-gdrive-restore");
    if (gdriveRestoreBtn) {
        gdriveRestoreBtn.addEventListener("click", restoreGDriveBackup);
    }

    // Shift controls listeners
    const btnShiftAction = document.getElementById("btn-shift-action");
    if (btnShiftAction) {
        btnShiftAction.addEventListener("click", handleShiftActionClick);
    }
    document.getElementById("btn-shift-open-close").addEventListener("click", () => document.getElementById("modal-shift-open").classList.remove("active"));
    document.getElementById("btn-shift-open-cancel").addEventListener("click", () => document.getElementById("modal-shift-open").classList.remove("active"));
    document.getElementById("form-shift-open").addEventListener("submit", submitShiftOpen);

    document.getElementById("btn-shift-close-close").addEventListener("click", () => document.getElementById("modal-shift-close").classList.remove("active"));
    document.getElementById("btn-shift-close-cancel").addEventListener("click", () => document.getElementById("modal-shift-close").classList.remove("active"));
    document.getElementById("form-shift-close").addEventListener("submit", submitShiftClose);

    // Cashier auth modal controls
    const cashierAuthClose = document.getElementById("btn-cashier-auth-close");
    if (cashierAuthClose) cashierAuthClose.addEventListener("click", () => document.getElementById("modal-cashier-auth").classList.remove("active"));
    const cashierAuthCancel = document.getElementById("btn-cashier-auth-cancel");
    if (cashierAuthCancel) cashierAuthCancel.addEventListener("click", () => document.getElementById("modal-cashier-auth").classList.remove("active"));
    const formCashierAuth = document.getElementById("form-cashier-auth");
    if (formCashierAuth) {
        formCashierAuth.addEventListener("submit", (e) => {
            e.preventDefault();
            const cashier_id = document.getElementById("cashier-login-select").value;
            const password = document.getElementById("cashier-login-password").value;
            const btnSubmit = formCashierAuth.querySelector("button[type='submit']");
            if (btnSubmit) {
                btnSubmit.disabled = true;
                btnSubmit.innerText = "Вход...";
            }
            fetch('/api/auth/cashier_login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cashier_id, password })
            })
            .then(res => res.json())
            .then(data => {
                if (btnSubmit) {
                    btnSubmit.disabled = false;
                    btnSubmit.innerText = "Войти";
                }
                if (data.success) {
                    document.getElementById("modal-cashier-auth").classList.remove("active");
                    document.getElementById("cashier-login-password").value = '';
                    showView("view-cashier");
                    currentUserRole = 'cashier';
                    checkActiveShiftStatus();
                    showToastMessage(data.message);
                } else {
                    alert(data.message);
                }
            })
            .catch(err => {
                if (btnSubmit) {
                    btnSubmit.disabled = false;
                    btnSubmit.innerText = "Войти";
                }
                console.error("Cashier login error:", err);
                alert("Ошибка сети при входе кассира.");
            });
        });
    }

    // Settings Owner Password change listener
    const formOwnerPassword = document.getElementById("form-change-owner-password");
    if (formOwnerPassword) {
        formOwnerPassword.addEventListener("submit", (e) => {
            e.preventDefault();
            const old_password = document.getElementById("owner-old-password").value;
            const new_password = document.getElementById("owner-new-password").value;
            const confirm_password = document.getElementById("owner-confirm-password").value;
            fetch('/api/auth/change_owner_password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_password, new_password, confirm_password })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    showToastMessage("Пароль владельца успешно изменен!");
                    document.getElementById("owner-old-password").value = '';
                    document.getElementById("owner-new-password").value = '';
                    document.getElementById("owner-confirm-password").value = '';
                } else {
                    alert(data.message);
                }
            })
            .catch(err => {
                console.error("Owner password change error:", err);
                alert("Ошибка сети при изменении пароля.");
            });
        });
    }

    // Settings Add Cashier listener
    const formAddCashier = document.getElementById("form-add-cashier");
    if (formAddCashier) {
        formAddCashier.addEventListener("submit", (e) => {
            e.preventDefault();
            const name = document.getElementById("cashier-name").value;
            const email = document.getElementById("cashier-email").value;
            const password = document.getElementById("cashier-password").value;
            fetch('/api/cashiers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, password })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    showToastMessage("Кассир успешно добавлен!");
                    document.getElementById("cashier-name").value = '';
                    document.getElementById("cashier-email").value = '';
                    document.getElementById("cashier-password").value = '';
                    loadCashiersList();
                } else {
                    alert(data.message);
                }
            })
            .catch(err => {
                console.error("Add cashier error:", err);
                alert("Ошибка сети при добавлении кассира.");
            });
        });
    }

    // Restock modal cancel/close listeners
    const btnRestockClose = document.getElementById("btn-restock-modal-close");
    if (btnRestockClose) btnRestockClose.addEventListener("click", () => document.getElementById("modal-restock-product").classList.remove("active"));
    const btnRestockCancel = document.getElementById("btn-restock-cancel");
    if (btnRestockCancel) btnRestockCancel.addEventListener("click", () => document.getElementById("modal-restock-product").classList.remove("active"));

    // Form restock product submit listener
    const formRestockProduct = document.getElementById("form-restock-product");
    if (formRestockProduct) {
        formRestockProduct.addEventListener("submit", (e) => {
            e.preventDefault();
            const id = document.getElementById("restock-prd-id").value;
            const quantity = parseInt(document.getElementById("restock-quantity").value);
            const purchase_price = parseFloat(document.getElementById("restock-purchase-price").value);
            const supplier = document.getElementById("restock-supplier").value;
            const status = document.getElementById("restock-payment-status").value;

            fetch(`/api/products/${id}/restock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantity, purchase_price, supplier, status })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    document.getElementById("modal-restock-product").classList.remove("active");
                    showToastMessage(`Успешно пополнено на ${quantity} шт.`);
                    loadProducts();
                    loadStats();

                    // Offer to print stickers
                    setTimeout(() => {
                        if (confirm(`Товар успешно добавлен! Хотите распечатать этикетки для добавленного количества (${quantity} шт.)?`)) {
                            openPrintModal(data.product, quantity);
                        }
                    }, 100);
                } else {
                    alert(data.message);
                }
            })
            .catch(err => {
                console.error("Restock error:", err);
                alert("Ошибка сети при пополнении товара.");
            });
        });
    }

    // Add Expense listener
    const formAddExpense = document.getElementById("form-add-expense");
    if (formAddExpense) {
        formAddExpense.addEventListener("submit", (e) => {
            e.preventDefault();
            const amount = parseFloat(document.getElementById("expense-amount").value);
            const category = document.getElementById("expense-category").value;
            const description = document.getElementById("expense-description").value;

            fetch('/api/expenses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount, category, description })
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    showToastMessage("Расход успешно сохранен!");
                    document.getElementById("expense-amount").value = "";
                    document.getElementById("expense-description").value = "";
                    loadExpenses();
                    loadStats();
                } else {
                    alert(data.message);
                }
            })
            .catch(err => {
                console.error("Add expense error:", err);
                alert("Ошибка сети при записи расхода.");
            });
        });
    }
}

// --- Auth Modal Code ---
function openAuthModal() {
    const modal = document.getElementById("modal-owner-auth");
    const title = document.getElementById("auth-modal-title");
    const desc = document.getElementById("auth-modal-description");
    const passLabel = document.getElementById("auth-password-label");
    const submitBtn = document.getElementById("btn-auth-submit");
    
    document.getElementById("owner-auth-password").value = "";
    
    if (setupComplete) {
        title.innerText = "Вход в панель владельца";
        desc.innerText = "Введите пароль для доступа к управлению складом и аналитике.";
        passLabel.innerText = "Пароль владельца";
        submitBtn.innerText = "Войти";
    } else {
        title.innerText = "Настройка пароля владельца";
        desc.innerText = "Это первый запуск приложения. Пожалуйста, придумайте и введите пароль владельца для доступа к складу.";
        passLabel.innerText = "Придумайте пароль";
        submitBtn.innerText = "Установить пароль и войти";
    }
    
    modal.classList.add("active");
    document.getElementById("owner-auth-password").focus();
}

function closeAuthModal() {
    document.getElementById("modal-owner-auth").classList.remove("active");
}

function submitOwnerAuth(e) {
    e.preventDefault();
    const password = document.getElementById("owner-auth-password").value.trim();
    const btnSubmit = document.getElementById("btn-auth-submit");
    if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.innerText = "Вход...";
    }
    
    const url = setupComplete ? '/api/auth/login' : '/api/auth/setup';
    
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    })
    .then(res => res.json())
    .then(data => {
        if (btnSubmit) {
            btnSubmit.disabled = false;
            btnSubmit.innerText = setupComplete ? "Войти" : "Установить пароль и войти";
        }
        if (data.success) {
            isLoggedIn = true;
            setupComplete = true; // Setup is complete if we just registered
            closeAuthModal();
            showView("view-owner");
            showTab("tab-warehouse");
            currentUserRole = 'owner';
        } else {
            alert(data.message);
        }
    })
    .catch(err => {
        if (btnSubmit) {
            btnSubmit.disabled = false;
            btnSubmit.innerText = setupComplete ? "Войти" : "Установить пароль и войти";
        }
        console.error("Auth error:", err);
        alert("Ошибка сервера при аутентификации.");
    });
}

// --- Checkout Sale ---
function submitSale() {
    if (cart.length === 0) {
        showToastMessage("Корзина пуста! Отсканируйте товары.");
        alert("Корзина пуста! Отсканируйте товары перед оформлением.");
        return;
    }
    
    if (!activeShift) {
        alert("Смена не открыта! Откройте смену, чтобы проводить продажи.");
        showToastMessage("Ошибка: Смена закрыта");
        return;
    }
    
    if (selectedPaymentMethod === 'mix') {
        let total = 0;
        cart.forEach(item => {
            const origPrice = parseFloat(item.product.price) || 0;
            const discount = parseFloat(item.discount) || 0;
            const qty = parseInt(item.quantity) || 1;
            total += Math.round(origPrice * (1 - discount / 100)) * qty;
        });

        const cashInp = document.getElementById("mix-cash-input");
        const inlineCashInp = document.getElementById("inline-mix-cash-input");
        
        let cash = 0;
        if (cashInp && cashInp.value) {
            cash = parseFloat(cashInp.value) || 0;
        } else if (inlineCashInp && inlineCashInp.value) {
            cash = parseFloat(inlineCashInp.value) || 0;
        }

        if (cash < 0) cash = 0;
        if (cash > total) cash = total;
        const card = Math.max(0, total - cash);

        closeMixModal();
        executeCheckoutSale('mix', cash, card);
        return;
    }
    
    executeCheckoutSale(selectedPaymentMethod, 0, 0);
}

function openMixModal() {
    // 1. Highlight Mix payment button in UI & show inline box
    document.querySelectorAll("#cart-payment-methods .discount-btn").forEach(b => {
        if (b.dataset.payment === 'mix') {
            b.classList.add("active");
        } else {
            b.classList.remove("active");
        }
    });
    selectedPaymentMethod = 'mix';

    const splitBox = document.getElementById("cart-mix-split-box");
    if (splitBox) splitBox.style.display = "block";

    let totalFinal = 0;
    cart.forEach(item => {
        const origPrice = parseFloat(item.product.price) || 0;
        const discount = parseFloat(item.discount) || 0;
        const qty = parseInt(item.quantity) || 1;
        const finalPrice = Math.round(origPrice * (1 - discount / 100));
        totalFinal += finalPrice * qty;
    });
    
    const modal = document.getElementById("modal-mix-payment");
    const totalEl = document.getElementById("mix-modal-total-display");
    const cardEl = document.getElementById("mix-modal-card-display");
    const cashInp = document.getElementById("mix-cash-input");
    const inlineCashInp = document.getElementById("inline-mix-cash-input");
    const inlineCardEl = document.getElementById("inline-mix-card-display");

    if (totalEl) {
        totalEl.innerText = `${formatCurrency(totalFinal)} сум`;
        totalEl.dataset.total = totalFinal;
    }
    if (cardEl) cardEl.innerText = `${formatCurrency(totalFinal)} сум`;
    if (inlineCardEl) inlineCardEl.innerText = `${formatCurrency(totalFinal)} сум`;
    
    if (cart.length === 0) {
        showToastMessage("Сначала добавьте товары в корзину!");
        return;
    }

    if (modal) {
        modal.classList.add("active");
        modal.style.display = "flex";
    }
    
    setTimeout(() => {
        if (cashInp) {
            cashInp.focus();
            cashInp.select();
        } else if (inlineCashInp) {
            inlineCashInp.focus();
            inlineCashInp.select();
        }
    }, 150);
}

function closeMixModal() {
    const modal = document.getElementById("modal-mix-payment");
    if (modal) {
        modal.classList.remove("active");
        modal.style.display = "none";
    }
    const input = document.getElementById("manual-scan-input");
    if (input) input.focus();
}

    
function updateMixCalculations(source = 'modal') {
    let total = 0;
    cart.forEach(item => {
        const origPrice = parseFloat(item.product.price) || 0;
        const discount = parseFloat(item.discount) || 0;
        const qty = parseInt(item.quantity) || 1;
        total += Math.round(origPrice * (1 - discount / 100)) * qty;
    });

    const cashInp = document.getElementById("mix-cash-input");
    const cardEl = document.getElementById("mix-modal-card-display");
    const inlineCashInp = document.getElementById("inline-mix-cash-input");
    const inlineCardEl = document.getElementById("inline-mix-card-display");

    let cash = 0;
    if (source === 'inline' && inlineCashInp) {
        cash = parseFloat(inlineCashInp.value) || 0;
    } else if (cashInp) {
        cash = parseFloat(cashInp.value) || 0;
    }
    
    if (cash < 0) cash = 0;
    if (cash > total) {
        cash = total;
        if (cashInp) cashInp.value = total;
        if (inlineCashInp) inlineCashInp.value = total;
    }
    
    const card = Math.max(0, total - cash);

    if (cashInp && source !== 'modal') cashInp.value = cash > 0 ? cash : "";
    if (inlineCashInp && source !== 'inline') inlineCashInp.value = cash > 0 ? cash : "";
    if (cardEl) cardEl.innerText = `${formatCurrency(card)} сум`;
    if (inlineCardEl) inlineCardEl.innerText = `${formatCurrency(card)} сум`;
}

function setMixCashPreset(ratio) {
    let total = 0;
    cart.forEach(item => {
        const origPrice = parseFloat(item.product.price) || 0;
        const discount = parseFloat(item.discount) || 0;
        const qty = parseInt(item.quantity) || 1;
        total += Math.round(origPrice * (1 - discount / 100)) * qty;
    });

    const cashInp = document.getElementById("mix-cash-input");
    const inlineCashInp = document.getElementById("inline-mix-cash-input");
    const cash = Math.round(total * ratio);
    
    if (cashInp) cashInp.value = cash > 0 ? cash : (ratio === 0 ? "0" : "");
    if (inlineCashInp) inlineCashInp.value = cash > 0 ? cash : (ratio === 0 ? "0" : "");
    
    updateMixCalculations('modal');
}

function submitMixSale() {
    let total = 0;
    cart.forEach(item => {
        const origPrice = parseFloat(item.product.price) || 0;
        const discount = parseFloat(item.discount) || 0;
        const qty = parseInt(item.quantity) || 1;
        total += Math.round(origPrice * (1 - discount / 100)) * qty;
    });

    const cashInp = document.getElementById("mix-cash-input");
    const inlineCashInp = document.getElementById("inline-mix-cash-input");
    
    let cash = 0;
    if (cashInp && cashInp.value) {
        cash = parseFloat(cashInp.value) || 0;
    } else if (inlineCashInp && inlineCashInp.value) {
        cash = parseFloat(inlineCashInp.value) || 0;
    }

    if (cash < 0) cash = 0;
    if (cash > total) cash = total;
    const card = Math.max(0, total - cash);
    
    closeMixModal();
    executeCheckoutSale('mix', cash, card);
}

// Global scope window assignments
window.openMixModal = openMixModal;
window.closeMixModal = closeMixModal;
window.updateMixCalculations = updateMixCalculations;
window.setMixCashPreset = setMixCashPreset;
window.submitMixSale = submitMixSale;

function executeCheckoutSale(paymentMethod, mixCash = 0, mixCard = 0) {
    if (cart.length === 0) return;
    
    const checkoutData = {
        payment_method: paymentMethod,
        mix_cash: mixCash,
        mix_card: mixCard,
        items: cart.map(item => ({
            barcode: item.product.barcode.split(',')[0].trim(),
            quantity: item.quantity,
            discount_percent: item.discount
        }))
    };

    fetch('/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(checkoutData)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            playSuccessBeep();
            
            // Sync session sales from backend to preserve perfect chronological order and IDs
            fetch('/api/shift/sales')
                .then(r => r.json())
                .then(sData => {
                    if (sData.success) {
                        sessionSales = sData.sales || [];
                        sessionServices = sData.services || [];
                        sessionExpenses = sData.expenses || [];
                        renderSessionSales();
                    }
                })
                .catch(() => {
                    if (data.sales && data.sales.length > 0) {
                        data.sales.forEach(sale => sessionSales.unshift(sale));
                    } else if (data.sale) {
                        sessionSales.unshift(data.sale);
                    }
                    renderSessionSales();
                });
            
            // Reset cart
            cart = [];
            renderCart();
            
            // Toast notification
            showToastMessage("Продажа успешно проведена!");
            
            // Re-sync all analytics and products in the background
            loadStats();
            loadProducts();
            if (typeof loadChartsData === 'function') {
                loadChartsData();
            }
        } else {
            playErrorBuzz();
            alert(data.message);
        }
    })
    .catch(err => {
        playErrorBuzz();
        console.error("Checkout error:", err);
        alert("Ошибка сети при проведении продажи.");
    });
}

function toggleCashierDropdown(bodyId) {
    const bodyEl = document.getElementById(bodyId);
    if (!bodyEl) return;
    const isVisible = bodyEl.style.display !== 'none';
    bodyEl.style.display = isVisible ? 'none' : 'block';
    
    // Toggle chevron
    if (bodyId === 'cashier-services-body') {
        const chev = document.getElementById('cashier-services-chevron');
        if (chev) chev.style.transform = isVisible ? 'rotate(-90deg)' : 'rotate(0deg)';
    } else if (bodyId === 'cashier-expenses-body') {
        const chev = document.getElementById('cashier-expenses-chevron');
        if (chev) chev.style.transform = isVisible ? 'rotate(-90deg)' : 'rotate(0deg)';
    }
}

function handleServicePresetChange(val) {
    const customContainer = document.getElementById('cashier-service-custom-name-container');
    const amountInput = document.getElementById('cashier-service-amount');
    const select = document.getElementById('cashier-service-preset');
    
    if (val === 'custom') {
        if (customContainer) customContainer.style.display = 'block';
        if (amountInput && (!amountInput.value || amountInput.value === '0')) amountInput.value = '';
        const customName = document.getElementById('cashier-service-custom-name');
        if (customName) customName.focus();
    } else if (val) {
        if (customContainer) customContainer.style.display = 'none';
        const selectedOpt = select.options[select.selectedIndex];
        const price = selectedOpt ? selectedOpt.getAttribute('data-price') : 0;
        if (amountInput && price) amountInput.value = price;
    } else {
        if (customContainer) customContainer.style.display = 'none';
    }
}

function setServicePaymentMethod(method) {
    selectedServicePaymentMethod = method;
    document.querySelectorAll('.cashier-srv-pay-btn').forEach(btn => {
        if (btn.getAttribute('data-method') === method) {
            btn.classList.add('active');
            if (method === 'cash') {
                btn.style.background = 'rgba(0, 230, 118, 0.2)';
                btn.style.borderColor = '#00e676';
            } else if (method === 'card') {
                btn.style.background = 'rgba(0, 229, 255, 0.2)';
                btn.style.borderColor = '#00e5ff';
            } else {
                btn.style.background = 'rgba(255, 235, 59, 0.2)';
                btn.style.borderColor = '#ffeb3b';
            }
            btn.style.color = '#fff';
        } else {
            btn.classList.remove('active');
            btn.style.background = 'transparent';
            btn.style.borderColor = 'var(--border-color)';
            btn.style.color = 'var(--text-secondary)';
        }
    });
}

function submitCashierService(e) {
    e.preventDefault();
    if (!activeShift) {
        alert("Смена не открыта! Пожалуйста, откройте смену в кассе.");
        return;
    }
    
    const preset = document.getElementById('cashier-service-preset').value;
    let serviceName = '';
    if (preset === 'custom') {
        serviceName = (document.getElementById('cashier-service-custom-name').value || '').trim();
    } else if (preset) {
        serviceName = preset;
    } else {
        alert("Пожалуйста, выберите услугу или укажите свое название.");
        return;
    }
    
    if (!serviceName) {
        alert("Пожалуйста, введите название услуги!");
        return;
    }
    
    const amount = parseFloat(document.getElementById('cashier-service-amount').value) || 0;
    if (amount <= 0) {
        alert("Сумма услуги должна быть больше нуля!");
        return;
    }
    
    fetch('/api/shift/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: serviceName,
            amount: amount,
            payment_method: selectedServicePaymentMethod
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            playSuccessBeep();
            showToastMessage(data.message || "Услуга успешно добавлена (+ в кассу)!");
            if (data.service) {
                sessionServices.unshift(data.service);
            }
            // Reset form
            document.getElementById('cashier-service-preset').value = '';
            document.getElementById('cashier-service-amount').value = '';
            const customName = document.getElementById('cashier-service-custom-name');
            if (customName) customName.value = '';
            const customContainer = document.getElementById('cashier-service-custom-name-container');
            if (customContainer) customContainer.style.display = 'none';
            setServicePaymentMethod('cash');
            
            renderSessionSales();
        } else {
            playErrorBuzz();
            alert(data.message);
        }
    })
    .catch(err => {
        playErrorBuzz();
        console.error("Error adding service:", err);
        alert("Ошибка сети при добавлении услуги.");
    });
}

function deleteSessionService(serviceId) {
    if (!confirm("Вы уверены, что хотите отменить эту услугу и вычесть её из смены?")) return;
    
    fetch(`/api/shift/services/${serviceId}`, { method: 'DELETE' })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            sessionServices = sessionServices.filter(s => s.id !== serviceId);
            showToastMessage("Услуга отменена");
            renderSessionSales();
        } else {
            alert(data.message);
        }
    })
    .catch(err => {
        console.error("Error deleting service:", err);
        alert("Ошибка сети при отмене услуги.");
    });
}

function handleExpenseCategoryChange(val) {
    const customContainer = document.getElementById('cashier-expense-custom-category-container');
    if (val === 'custom') {
        if (customContainer) customContainer.style.display = 'block';
        const customCat = document.getElementById('cashier-expense-custom-category');
        if (customCat) customCat.focus();
    } else {
        if (customContainer) customContainer.style.display = 'none';
    }
}

function submitCashierExpense(e) {
    e.preventDefault();
    if (!activeShift) {
        alert("Смена не открыта! Пожалуйста, откройте смену в кассе.");
        return;
    }
    
    const categorySelect = document.getElementById('cashier-expense-category').value;
    let category = categorySelect;
    if (categorySelect === 'custom') {
        category = (document.getElementById('cashier-expense-custom-category').value || '').trim() || 'Прочий расход';
    }
    
    const amount = parseFloat(document.getElementById('cashier-expense-amount').value) || 0;
    if (amount <= 0) {
        alert("Сумма расхода должна быть больше нуля!");
        return;
    }
    
    const description = (document.getElementById('cashier-expense-desc').value || '').trim();
    
    fetch('/api/shift/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            category: category,
            amount: amount,
            description: description
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            playSuccessBeep();
            showToastMessage(data.message || "Расход списан из кассы (-)");
            if (data.expense) {
                sessionExpenses.unshift(data.expense);
            }
            // Reset form
            document.getElementById('cashier-expense-category').value = 'Обед / Питание';
            document.getElementById('cashier-expense-amount').value = '';
            document.getElementById('cashier-expense-desc').value = '';
            const customCat = document.getElementById('cashier-expense-custom-category');
            if (customCat) customCat.value = '';
            const customContainer = document.getElementById('cashier-expense-custom-category-container');
            if (customContainer) customContainer.style.display = 'none';
            
            renderSessionSales();
            loadStats(); // Update stats in background
        } else {
            playErrorBuzz();
            alert(data.message);
        }
    })
    .catch(err => {
        playErrorBuzz();
        console.error("Error adding expense:", err);
        alert("Ошибка сети при списании расхода.");
    });
}

function deleteSessionExpense(expenseId) {
    if (!confirm("Вы уверены, что хотите отменить этот расход и вернуть сумму в кассу смены?")) return;
    
    fetch(`/api/shift/expenses/${expenseId}`, { method: 'DELETE' })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            sessionExpenses = sessionExpenses.filter(e => e.id !== expenseId);
            showToastMessage("Расход отменен");
            renderSessionSales();
            loadStats();
        } else {
            alert(data.message);
        }
    })
    .catch(err => {
        console.error("Error deleting expense:", err);
        alert("Ошибка сети при отмене расхода.");
    });
}

function renderSessionSales() {
    const listEl = document.getElementById("session-sales-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    
    const totalContainer = document.getElementById("session-sales-total-container");
    const totalValEl = document.getElementById("session-sales-total-val");
    
    const hasOperations = (sessionSales.length > 0 || sessionServices.length > 0 || sessionExpenses.length > 0);
    
    if (!hasOperations) {
        listEl.innerHTML = '<div class="empty-list-placeholder">В этой смене операций еще не было</div>';
        if (totalContainer) totalContainer.style.display = "none";
        return;
    }
    
    let totalSalesSum = 0;
    let cashSalesSum = 0;
    let totalServicesSum = 0;
    let cashServicesSum = 0;
    let totalExpensesSum = 0;
    
    // Combine all shift items into a unified timeline
    const timelineItems = [];
    
    sessionSales.forEach(sale => {
        const finalPrice = (sale.price_final || 0) * (sale.quantity || 1);
        totalSalesSum += finalPrice;
        if (sale.payment_method === 'cash') {
            cashSalesSum += finalPrice;
        } else if (sale.payment_method === 'mix') {
            cashSalesSum += (parseFloat(sale.mix_cash) || 0);
        }
        timelineItems.push({
            type: 'sale',
            id: sale.id,
            date: sale.sold_at || '',
            name: sale.product_name || 'Товар',
            amount: finalPrice,
            quantity: sale.quantity || 1,
            price_original: sale.price_original || 0,
            discount: sale.discount_percent || 0,
            payment_method: sale.payment_method || 'cash',
            raw: sale
        });
    });
    
    sessionServices.forEach(srv => {
        const amt = parseFloat(srv.amount) || 0;
        totalServicesSum += amt;
        if (srv.payment_method === 'cash') {
            cashServicesSum += amt;
        }
        timelineItems.push({
            type: 'service',
            id: srv.id,
            date: srv.created_at || '',
            name: srv.name || 'Услуга',
            amount: amt,
            payment_method: srv.payment_method || 'cash',
            cashier_name: srv.cashier_name || '',
            raw: srv
        });
    });
    
    sessionExpenses.forEach(exp => {
        const amt = parseFloat(exp.amount) || 0;
        totalExpensesSum += amt;
        timelineItems.push({
            type: 'expense',
            id: exp.id,
            date: exp.expense_date || exp.created_at || '',
            name: exp.category || 'Расход',
            description: exp.description || '',
            amount: amt,
            cashier_name: exp.cashier_name || '',
            raw: exp
        });
    });
    
    // Sort timeline strictly by ID descending: latest/newest sales (highest ID) ALWAYS on TOP, oldest at the bottom
    timelineItems.sort((a, b) => {
        return (b.id || 0) - (a.id || 0);
    });
    
    // Render timeline items
    timelineItems.forEach(item => {
        const row = document.createElement("div");
        row.className = "session-sale-item";
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.padding = "10px 12px";
        row.style.borderBottom = "1px solid var(--border-color)";
        row.style.borderRadius = "8px";
        row.style.marginBottom = "6px";
        
        let payBadge = '';
        if (item.payment_method === 'card') {
            payBadge = '<span style="background: rgba(0, 229, 255, 0.15); color: #00e5ff; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">💳 Карта</span>';
        } else if (item.payment_method === 'transfer') {
            payBadge = '<span style="background: rgba(255, 235, 59, 0.15); color: #ffeb3b; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">📱 Перевод</span>';
        } else if (item.payment_method === 'mix') {
            const mCash = item.raw && item.raw.mix_cash ? formatCurrency(item.raw.mix_cash) : '';
            const mCard = item.raw && item.raw.mix_card ? formatCurrency(item.raw.mix_card) : '';
            const detailStr = (mCash && mCard) ? ` (${mCash} нал + ${mCard} карта)` : '';
            payBadge = `<span style="background: rgba(186, 104, 200, 0.2); color: #ce93d8; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; margin-left: 6px;">🔄 Mix${detailStr}</span>`;
        }
        
        if (item.type === 'sale') {
            let discountSpan = "";
            if (item.discount > 0) {
                discountSpan = `<span class="session-sale-discount-badge">-${item.discount}%</span>`;
            }
            row.style.background = "rgba(255, 255, 255, 0.02)";
            row.innerHTML = `
                <div class="session-sale-left" style="display: flex; flex-direction: column; gap: 2px;">
                    <span class="session-sale-name" style="font-weight: 600; color: #fff; font-size: 0.88rem;">🛒 ${escapeHtml(item.name)}</span>
                    <span class="session-sale-details" style="font-size: 0.75rem; color: var(--text-secondary);">
                        ${formatCurrency(item.price_original)} сум / шт ${discountSpan} ${payBadge}
                    </span>
                </div>
                <div class="session-sale-right" style="text-align: right; display: flex; flex-direction: column; gap: 2px; align-items: flex-end;">
                    <span class="session-sale-price" style="font-weight: 700; color: #00e676; font-size: 0.92rem;">+${formatCurrency(item.amount)} сум</span>
                    <div class="session-sale-qty" style="font-size: 0.75rem; color: var(--text-secondary);">${item.quantity} шт.</div>
                </div>
            `;
        } else if (item.type === 'service') {
            row.style.background = "rgba(0, 230, 118, 0.04)";
            row.style.borderLeft = "3px solid #00e676";
            row.innerHTML = `
                <div class="session-sale-left" style="display: flex; flex-direction: column; gap: 2px;">
                    <span class="session-sale-name" style="font-weight: 600; color: #00e676; font-size: 0.88rem;">🛠️ ${escapeHtml(item.name)}</span>
                    <span class="session-sale-details" style="font-size: 0.75rem; color: var(--text-secondary);">
                        Услуга сервиса ${payBadge}
                    </span>
                </div>
                <div class="session-sale-right" style="text-align: right; display: flex; align-items: center; gap: 8px;">
                    <span class="session-sale-price" style="font-weight: 700; color: #00e676; font-size: 0.92rem;">+${formatCurrency(item.amount)} сум</span>
                    <button type="button" onclick="deleteSessionService(${item.id})" title="Отменить услугу" style="background: rgba(255, 61, 0, 0.1); border: 1px solid rgba(255, 61, 0, 0.2); color: #ff3d00; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 0.75rem;">&times;</button>
                </div>
            `;
        } else if (item.type === 'expense') {
            row.style.background = "rgba(255, 61, 0, 0.04)";
            row.style.borderLeft = "3px solid #ff3d00";
            const descHtml = item.description ? `<span style="font-size: 0.75rem; color: var(--text-secondary);">${escapeHtml(item.description)}</span>` : '';
            row.innerHTML = `
                <div class="session-sale-left" style="display: flex; flex-direction: column; gap: 2px;">
                    <span class="session-sale-name" style="font-weight: 600; color: #ff3d00; font-size: 0.88rem;">💸 ${escapeHtml(item.name)}</span>
                    ${descHtml}
                </div>
                <div class="session-sale-right" style="text-align: right; display: flex; align-items: center; gap: 8px;">
                    <span class="session-sale-price" style="font-weight: 700; color: #ff3d00; font-size: 0.92rem;">-${formatCurrency(item.amount)} сум</span>
                    <button type="button" onclick="deleteSessionExpense(${item.id})" title="Отменить расход" style="background: rgba(255, 61, 0, 0.1); border: 1px solid rgba(255, 61, 0, 0.2); color: #ff3d00; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-size: 0.75rem;">&times;</button>
                </div>
            `;
        }
        
        listEl.appendChild(row);
    });
    
    // Auto-scroll to the top of the sales list so latest sales are immediately visible
    setTimeout(() => {
        listEl.scrollTop = 0;
    }, 50);
    
    // Calculate expected cash in drawer
    const cashStart = activeShift ? (parseFloat(activeShift.cash_start) || 0) : 0;
    const expectedCashInDrawer = cashStart + cashSalesSum + cashServicesSum - totalExpensesSum;
    
    if (totalContainer && totalValEl) {
        totalContainer.style.display = "flex";
        totalContainer.style.flexDirection = "column";
        totalContainer.style.gap = "8px";
        
        const cardSalesTotal = (totalSalesSum - cashSalesSum) + (totalServicesSum - cashServicesSum);
        totalContainer.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; padding-bottom: 8px; border-bottom: 1px solid var(--border-color);">
                <div style="display: flex; justify-content: space-between; color: var(--text-secondary);">
                    <span>🛒 Продажи товаров (нал):</span>
                    <span style="color: #fff; font-weight: 600;">+${formatCurrency(cashSalesSum)} сум</span>
                </div>
                ${cardSalesTotal > 0 ? `
                <div style="display: flex; justify-content: space-between; color: var(--text-secondary);">
                    <span>💳 Терминал (безнал):</span>
                    <span style="color: #00e5ff; font-weight: 600;">+${formatCurrency(cardSalesTotal)} сум</span>
                </div>` : ''}
                <div style="display: flex; justify-content: space-between; color: var(--text-secondary);">
                    <span>🛠️ Услуги (нал в кассу):</span>
                    <span style="color: #00e676; font-weight: 600;">+${formatCurrency(cashServicesSum)} сум</span>
                </div>
                <div style="display: flex; justify-content: space-between; color: var(--text-secondary);">
                    <span>💸 Расходы (- из кассы):</span>
                    <span style="color: #ff3d00; font-weight: 600;">-${formatCurrency(totalExpensesSum)} сум</span>
                </div>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 1rem; font-weight: bold;">
                <span style="color: #fff; font-size: 0.92rem;">Итого в кассе (наличные):</span>
                <span id="session-sales-total-val" style="color: #00e676; font-size: 1.15rem; font-weight: 800;">${formatCurrency(expectedCashInDrawer)} сум</span>
            </div>
        `;
    }
}

// --- Warehouse CRUD ---
let productsETag = '';

function loadProducts() {
    const headers = {};
    if (productsETag && productsCache.length > 0) {
        headers['If-None-Match'] = productsETag;
    }
    
    fetch('/api/products', { headers })
    .then(res => {
        if (res.status === 304) {
            // Not modified: 0 bytes transferred! Use existing in-memory cache instantly
            return null;
        }
        const newETag = res.headers.get('ETag');
        if (newETag) productsETag = newETag;
        return res.json();
    })
    .then(products => {
        if (products !== null && Array.isArray(products)) {
            productsCache = products;
            rebuildProductMaps();
        } else if (productsCache && productsCache.length > 0) {
            rebuildProductMaps();
        }
        renderProductsTable();
        updateDatalists();
    })
    .catch(err => {
        console.error("Error loading products:", err);
        if (productsCache && productsCache.length > 0) {
            renderProductsTable();
            updateDatalists();
        }
    });
}

function renderProductsTable() {
    const tbody = document.getElementById("products-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    const isFilterActive = !!(filterType || filterBrand || filterModel || filterSuffix || filterGeneral);

    // 1. Filter products based on multi-field precision search queries
    visibleProductsCache = productsCache.filter(p => {
        const type = (p.type || "").toLowerCase();
        const brand = (p.brand || "").toLowerCase();
        const model = (p.model || "").toLowerCase();
        const suffix = (p.unique_suffix || "").toLowerCase();
        const barcode = (p.barcode || "").toLowerCase();
        const name = (p.name || "").toLowerCase();
        const supplier = (p.supplier || "").toLowerCase();

        if (filterType && type !== filterType) return false;
        if (filterBrand && brand !== filterBrand) return false;
        if (filterModel && model !== filterModel) return false;
        if (filterSuffix && suffix !== filterSuffix) return false;

        if (filterGeneral) {
            if (!name.includes(filterGeneral) && 
                !barcode.includes(filterGeneral) && 
                !type.includes(filterGeneral) && 
                !brand.includes(filterGeneral) && 
                !model.includes(filterGeneral) && 
                !suffix.includes(filterGeneral) &&
                !supplier.includes(filterGeneral)) {
                return false;
            }
        }
        return true;
    });

    // Update summary metrics for filtered warehouse products
    const sumStock = visibleProductsCache.reduce((acc, p) => acc + (p.stock || 0), 0);
    const sumSold = visibleProductsCache.reduce((acc, p) => acc + (p.sold_qty || 0), 0);
    const sumInitial = visibleProductsCache.reduce((acc, p) => acc + (p.initial_qty || ((p.stock || 0) + (p.sold_qty || 0))), 0);
    const countSKU = visibleProductsCache.length;

    const elStock = document.getElementById("warehouse-summary-stock-qty");
    const elInitial = document.getElementById("warehouse-summary-initial-qty");
    const elSold = document.getElementById("warehouse-summary-sold-qty");
    const elSKU = document.getElementById("warehouse-summary-sku-count");
    const elLabel = document.getElementById("warehouse-filter-summary-label");

    if (elStock) elStock.textContent = `${sumStock.toLocaleString()} шт.`;
    if (elInitial) elInitial.textContent = `${sumInitial.toLocaleString()} шт.`;
    if (elSold) elSold.textContent = `${sumSold.toLocaleString()} шт.`;
    if (elSKU) elSKU.textContent = `${countSKU.toLocaleString()} поз.`;

    if (elLabel) {
        if (isFilterActive) {
            const activeFilters = [];
            if (filterType) activeFilters.push(`Тип: "${filterType}"`);
            if (filterBrand) activeFilters.push(`Бренд: "${filterBrand}"`);
            if (filterModel) activeFilters.push(`Модель: "${filterModel}"`);
            if (filterSuffix) activeFilters.push(`Дополнение: "${filterSuffix}"`);
            if (filterGeneral) activeFilters.push(`Поиск: "${filterGeneral}"`);
            elLabel.textContent = `Выбрано: ${activeFilters.join(', ')}`;
        } else {
            elLabel.textContent = 'Все товары на складе';
        }
    }

    if (visibleProductsCache.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-secondary); padding: 25px;">Товары не найдены.</td></tr>';
        updateSelectionUI();
        return;
    }

    // 2. Group products by model type (type + brand + model)
    groupsCache = {};
    visibleProductsCache.forEach(p => {
        const key = `${p.type || 'Без категории'} | ${p.brand || ''} | ${p.model || ''}`;
        if (!groupsCache[key]) {
            groupsCache[key] = {
                type: p.type || 'Без категории',
                brand: p.brand || '',
                model: p.model || '',
                items: [],
                total_stock: 0
            };
        }
        groupsCache[key].items.push(p);
        groupsCache[key].total_stock += (p.stock || 0);
    });

    const sortedGroupKeys = Object.keys(groupsCache).sort();
    
    // 3. Render HTML using DocumentFragment for maximum speed and zero UI lag
    const fragment = document.createDocumentFragment();
    sortedGroupKeys.forEach(key => {
        const group = groupsCache[key];
        const isCollapsed = isFilterActive ? false : (collapsedGroups[key] === true);
        
        // Highlight terms
        const highlightedType = filterType ? highlightText(group.type, filterType) : (filterGeneral ? highlightText(group.type, filterGeneral) : escapeHtml(group.type));
        const highlightedBrand = filterBrand ? highlightText(group.brand, filterBrand) : (filterGeneral ? highlightText(group.brand, filterGeneral) : escapeHtml(group.brand));
        const highlightedModel = filterModel ? highlightText(group.model, filterModel) : (filterGeneral ? highlightText(group.model, filterGeneral) : escapeHtml(group.model));

        // Group Header Row
        const headerTr = document.createElement("tr");
        headerTr.className = `group-header-row ${isCollapsed ? 'collapsed' : ''}`;
        headerTr.dataset.groupKey = key;
        
        headerTr.innerHTML = `
            <td style="text-align: center;">
                <input type="checkbox" class="group-select-checkbox" data-group-key="${escapeHtml(key)}" style="cursor: pointer; width: 15px; height: 15px;">
            </td>
            <td colspan="8" style="padding-left: 15px;">
                <span class="group-toggle-icon">${isCollapsed ? '▶' : '▼'}</span>
                <strong style="color: #fff;">${highlightedType} ${highlightedBrand} ${highlightedModel}</strong>
                <span style="background: rgba(124,77,255,0.15); color: #b388ff; padding: 2px 8px; border-radius: 12px; font-size: 0.78rem; margin-left: 10px; font-weight: 500;">
                    ${group.total_stock} шт.
                </span>
            </td>
        `;
        fragment.appendChild(headerTr);

        // Group Items Rows
        group.items.forEach(p => {
            const tr = document.createElement("tr");
            tr.className = `product-row ${isCollapsed ? 'collapsed-variant' : ''}`;
            tr.dataset.productId = p.id;
            tr.dataset.groupKey = key;
            
            const stockClass = p.stock === 0 ? 'table-stock out' : 'table-stock';
            const isSelected = selectedProductIds.has(p.id);
            if (isSelected) {
                tr.classList.add("selected-row");
            }
            
            // Highlight barcode and suffix
            const highlightedBarcode = filterGeneral ? highlightText(p.barcode, filterGeneral) : escapeHtml(p.barcode);
            const variantName = p.unique_suffix || p.name;
            const highlightedName = filterSuffix ? highlightText(variantName, filterSuffix) : (filterGeneral ? highlightText(variantName, filterGeneral) : escapeHtml(variantName));
            const highlightedRowType = filterType ? highlightText(p.type, filterType) : (filterGeneral ? highlightText(p.type, filterGeneral) : escapeHtml(p.type || '—'));
            const highlightedRowSupplier = filterGeneral ? highlightText(p.supplier, filterGeneral) : escapeHtml(p.supplier || '—');

            tr.innerHTML = `
                <td style="text-align: center;">
                    <input type="checkbox" class="product-select-checkbox" data-product-id="${p.id}" ${isSelected ? 'checked' : ''} style="cursor: pointer; width: 14px; height: 14px;">
                </td>
                <td class="table-barcode">${highlightedBarcode}</td>
                <td class="table-name" style="font-weight: 500; cursor: pointer; text-decoration: underline; color: #00b0ff;" onclick="openProductHistoryCard(${p.id})">${highlightedName}</td>
                <td style="color: var(--text-secondary); font-size: 0.85rem;">${highlightedRowType}</td>
                <td style="color: var(--text-secondary);">${formatCurrency(p.cost_price || 0.0)} сум</td>
                <td class="table-price" style="font-weight: 600;">${formatCurrency(p.price)} сум</td>
                <td class="${stockClass}">${p.stock} шт.</td>
                <td style="color: var(--text-secondary); font-size: 0.85rem;">${highlightedRowSupplier}</td>
                <td class="table-actions">
                    <button class="action-icon-btn btn-add-stock" title="Приход" onclick="event.stopPropagation(); restockProduct(${p.id}, '${escapeHtml(p.name)}')" style="background: rgba(0, 230, 118, 0.1); color: #00e676; border-color: rgba(0, 230, 118, 0.2);">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    </button>
                    <button class="action-icon-btn btn-defect-stock" title="Списание" onclick="event.stopPropagation(); defectiveProduct(${p.id}, '${escapeHtml(p.name)}', ${p.stock})" style="background: rgba(255, 61, 0, 0.1); color: #ff3d00; border-color: rgba(255, 61, 0, 0.2);">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    </button>
                    <button class="action-icon-btn btn-print-qr" title="Печать штрихкода" onclick="event.stopPropagation(); triggerManualPrint(${JSON.stringify(p).replace(/"/g, '&quot;')})">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
                    </button>
                    <button class="action-icon-btn btn-edit-prd" title="Изменить" onclick="event.stopPropagation(); openEditModal(${p.id}, '${escapeHtml(p.name)}', ${p.price}, ${p.stock}, ${p.cost_price || 0.0}, '${escapeHtml(p.supplier || '')}', '${escapeHtml(p.type || '')}', '${escapeHtml(p.brand || '')}', '${escapeHtml(p.model || '')}', '${escapeHtml(p.unique_suffix || '')}', '${escapeHtml(p.barcode || '')}')">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                    </button>
                    <button class="action-icon-btn btn-delete-prd" title="Удалить" onclick="event.stopPropagation(); deleteProduct(${p.id})">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                    </button>
                </td>
            `;
            fragment.appendChild(tr);
        });
    });
    tbody.appendChild(fragment);

    // 4. Attach Event Listeners
    // Group Collapse Toggle
    document.querySelectorAll(".group-header-row").forEach(header => {
        header.addEventListener("click", (e) => {
            if (e.target.closest("input[type='checkbox']")) return;
            
            const key = header.dataset.groupKey;
            collapsedGroups[key] = !collapsedGroups[key];
            
            const isCollapsed = collapsedGroups[key];
            header.classList.toggle("collapsed", isCollapsed);
            const toggleIcon = header.querySelector(".group-toggle-icon");
            if (toggleIcon) toggleIcon.innerText = isCollapsed ? '▶' : '▼';
            
            document.querySelectorAll(`.product-row[data-group-key="${CSS.escape(key)}"]`).forEach(row => {
                row.classList.toggle("collapsed-variant", isCollapsed);
            });
        });
    });

    // Group Checkbox Select
    document.querySelectorAll(".group-select-checkbox").forEach(chk => {
        chk.addEventListener("change", () => {
            const key = chk.dataset.groupKey;
            const group = groupsCache[key];
            if (!group) return;
            
            if (chk.checked) {
                group.items.forEach(p => selectedProductIds.add(p.id));
            } else {
                group.items.forEach(p => selectedProductIds.delete(p.id));
            }
            updateSelectionUI();
        });
    });

    // Product Row Click (Ctrl + Click)
    document.querySelectorAll(".product-row").forEach(row => {
        row.addEventListener("click", (e) => {
            if (e.target.closest(".table-actions") || e.target.closest("input[type='checkbox']")) return;
            
            const prdId = parseInt(row.dataset.productId);
            if (e.ctrlKey) {
                if (selectedProductIds.has(prdId)) {
                    selectedProductIds.delete(prdId);
                } else {
                    selectedProductIds.add(prdId);
                }
            } else {
                selectedProductIds.clear();
                selectedProductIds.add(prdId);
            }
            updateSelectionUI();
        });
    });

    // Product Checkbox Select
    document.querySelectorAll(".product-select-checkbox").forEach(chk => {
        chk.addEventListener("change", () => {
            const prdId = parseInt(chk.dataset.productId);
            if (chk.checked) {
                selectedProductIds.add(prdId);
            } else {
                selectedProductIds.delete(prdId);
            }
            updateSelectionUI();
        });
    });
}

function updateDatalists() {
    updateDynamicDatalists('filter');
}

function updateDynamicDatalists(context) {
    const typeId = context === 'add' ? 'new-prd-type' : 'filter-prd-type';
    const brandId = context === 'add' ? 'new-prd-brand' : 'filter-prd-brand';
    const modelId = context === 'add' ? 'new-prd-model' : 'filter-prd-model';
    const suffixId = context === 'add' ? 'new-prd-suffix' : 'filter-prd-suffix';

    const valType = document.getElementById(typeId) ? document.getElementById(typeId).value.trim().toLowerCase() : "";
    const valBrand = document.getElementById(brandId) ? document.getElementById(brandId).value.trim().toLowerCase() : "";
    const valModel = document.getElementById(modelId) ? document.getElementById(modelId).value.trim().toLowerCase() : "";

    const dlTypes = document.getElementById("datalist-product-types");
    const dlBrands = document.getElementById("datalist-product-brands");
    const dlModels = document.getElementById("datalist-product-models");
    const dlSuffixes = document.getElementById("datalist-product-suffixes");
    const dlSuppliers = document.getElementById("datalist-product-suppliers");

    const types = new Set();
    const brands = new Set();
    const models = new Set();
    const suffixes = new Set();
    const suppliers = new Set();

    (productsCache || []).forEach(p => {
        const pType = (p.type || "").trim();
        const pBrand = (p.brand || "").trim();
        const pModel = (p.model || "").trim();
        const pSuffix = (p.unique_suffix || "").trim();
        const pSupplier = (p.supplier || "").trim();

        if (pType) types.add(pType);

        if (!valType || pType.toLowerCase() === valType) {
            if (pBrand) brands.add(pBrand);
        }

        if ((!valType || pType.toLowerCase() === valType) &&
            (!valBrand || pBrand.toLowerCase() === valBrand)) {
            if (pModel) models.add(pModel);
        }

        if ((!valType || pType.toLowerCase() === valType) &&
            (!valBrand || pBrand.toLowerCase() === valBrand) &&
            (!valModel || pModel.toLowerCase() === valModel)) {
            if (pSuffix) suffixes.add(pSuffix);
        }

        if (pSupplier) suppliers.add(pSupplier);
    });

    if (dlTypes) {
        dlTypes.innerHTML = "";
        Array.from(types).sort().forEach(t => {
            const opt = document.createElement("option");
            opt.value = t;
            dlTypes.appendChild(opt);
        });
    }
    if (dlBrands) {
        dlBrands.innerHTML = "";
        Array.from(brands).sort().forEach(b => {
            const opt = document.createElement("option");
            opt.value = b;
            dlBrands.appendChild(opt);
        });
    }
    if (dlModels) {
        dlModels.innerHTML = "";
        Array.from(models).sort().forEach(m => {
            const opt = document.createElement("option");
            opt.value = m;
            dlModels.appendChild(opt);
        });
    }
    if (dlSuffixes) {
        dlSuffixes.innerHTML = "";
        Array.from(suffixes).sort().forEach(s => {
            const opt = document.createElement("option");
            opt.value = s;
            dlSuffixes.appendChild(opt);
        });
    }
    if (dlSuppliers) {
        dlSuppliers.innerHTML = "";
        Array.from(suppliers).sort().forEach(s => {
            const opt = document.createElement("option");
            opt.value = s;
            dlSuppliers.appendChild(opt);
        });
    }
}

function submitAddProduct(e) {
    e.preventDefault();
    const type = document.getElementById("new-prd-type").value.trim();
    const brand = document.getElementById("new-prd-brand").value.trim();
    const model = document.getElementById("new-prd-model").value.trim();
    const suffix = document.getElementById("new-prd-suffix").value.trim();
    const price = parseFloat(document.getElementById("new-prd-price").value);
    const stock = parseInt(document.getElementById("new-prd-stock").value);
    const cost_price = parseFloat(document.getElementById("new-prd-cost").value) || 0.0;
    const supplier = document.getElementById("new-prd-supplier").value.trim();
    const barcode = document.getElementById("new-prd-barcode").value.trim();
    
    fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: "", price, stock, cost_price, supplier, type, brand, model, suffix, barcode })
    })
    .then(res => {
        if (!res.ok) {
            return res.json().then(errData => {
                if (errData.is_duplicate) {
                    if (confirm(`${errData.message}\nХотите открыть пополнение остатков для этого товара?`)) {
                        restockProduct(errData.product_id, errData.product_name);
                    }
                } else {
                    alert(errData.message || "Ошибка при добавлении товара");
                }
                throw new Error("Validation error");
            });
        }
        return res.json();
    })
    .then(data => {
        if (data.success) {
            // Reset form
            handleProductFormResetAndPreserve();
            // Reload table
            loadProducts();
            // Immediately open print barcode dialog for initial stock amount
            if (stock > 0) {
                openPrintModal(data.product, stock);
            }
        }
    })
    .catch(err => {
        if (err.message !== "Validation error") {
            console.error("Error adding product:", err);
        }
    });
}

function filterProductsTable(query) {
    const q = query.toLowerCase().trim();
    const rows = document.querySelectorAll("#products-table-body tr");
    
    rows.forEach(row => {
        const name = row.dataset.name || "";
        const barcode = row.dataset.barcode || "";
        if (name.includes(q) || barcode.includes(q)) {
            row.classList.remove("display-none");
        } else {
            row.classList.add("display-none");
        }
    });
}

// --- Edit Product ---
function openEditModal(id, name, price, stock, costPrice = 0.0, supplier = '', type = '', brand = '', model = '', unique_suffix = '', barcode = '') {
    currentEditingOldStock = stock; // Store old stock level to calculate difference
    
    document.getElementById("edit-prd-id").value = id;
    document.getElementById("edit-prd-price").value = price;
    document.getElementById("edit-prd-stock").value = stock;
    document.getElementById("edit-prd-cost").value = costPrice;
    document.getElementById("edit-prd-supplier").value = supplier;
    document.getElementById("edit-prd-type").value = type;
    document.getElementById("edit-prd-brand").value = brand;
    document.getElementById("edit-prd-model").value = model;
    document.getElementById("edit-prd-suffix").value = unique_suffix;
    document.getElementById("edit-prd-barcode").value = barcode;
    
    document.getElementById("modal-edit-product").classList.add("active");
}

function closeEditModal() {
    document.getElementById("modal-edit-product").classList.remove("active");
}

function submitEditProduct(e) {
    e.preventDefault();
    const id = document.getElementById("edit-prd-id").value;
    const type = document.getElementById("edit-prd-type").value.trim();
    const brand = document.getElementById("edit-prd-brand").value.trim();
    const model = document.getElementById("edit-prd-model").value.trim();
    const suffix = document.getElementById("edit-prd-suffix").value.trim();
    const price = parseFloat(document.getElementById("edit-prd-price").value);
    const stock = parseInt(document.getElementById("edit-prd-stock").value);
    const cost_price = parseFloat(document.getElementById("edit-prd-cost").value) || 0.0;
    const supplier = document.getElementById("edit-prd-supplier").value.trim();
    const barcode = document.getElementById("edit-prd-barcode").value.trim();
    
    const addedQty = stock - currentEditingOldStock;
    
    fetch(`/api/products/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: "", price, stock, cost_price, supplier, type, brand, model, suffix, barcode })
    })
    .then(res => {
        if (!res.ok) {
            return res.json().then(errData => {
                if (errData.is_duplicate) {
                    if (confirm(`${errData.message}\nХотите открыть пополнение остатков для этого товара?`)) {
                        closeEditModal();
                        restockProduct(errData.product_id, errData.product_name);
                    }
                } else {
                    alert(errData.message || "Ошибка при изменении товара");
                }
                throw new Error("Validation error");
            });
        }
        return res.json();
    })
    .then(data => {
        if (data.success) {
            closeEditModal();
            loadProducts();
            // If the user added more stock, open print preview dialog with the exact quantity added
            if (addedQty > 0) {
                openPrintModal(data.product, addedQty);
            }
        } else {
            alert(data.message);
        }
    })
    .catch(err => console.error("Error updating product:", err));
}

function deleteProduct(id) {
    if (confirm("Вы уверены, что хотите полностью удалить этот товар из базы данных?")) {
        fetch(`/api/products/${id}`, { method: 'DELETE' })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    loadProducts();
                    loadStats();
                } else {
                    alert(data.message);
                }
            })
            .catch(err => console.error("Error deleting product:", err));
    }
}

function restockProduct(id, name) {
    // Fetch product details to prefill price and supplier
    fetch(`/api/products`)
        .then(res => res.json())
        .then(products => {
            const product = products.find(p => p.id === id);
            if (!product) {
                alert("Товар не найден!");
                return;
            }
            
            document.getElementById("restock-prd-id").value = id;
            document.getElementById("restock-prd-title").innerText = `Товар: ${name}`;
            document.getElementById("restock-quantity").value = 1;
            document.getElementById("restock-purchase-price").value = product.cost_price || 0;
            document.getElementById("restock-supplier").value = product.supplier || "";
            document.getElementById("restock-payment-status").value = "paid";
            
            document.getElementById("modal-restock-product").classList.add("active");
        })
        .catch(err => {
            console.error("Error pre-filling restock modal:", err);
            alert("Не удалось загрузить данные о товаре.");
        });
}

let currentWriteOffProductId = null;
let currentWriteOffProductStock = 0;

function defectiveProduct(id, name, currentStock) {
    if (window.isKeyPHeld) {
        if (currentStock <= 0) {
            showToastMessage("Недостаточно товара на складе для секретной продажи.");
            return;
        }
        fetch(`/api/products/${id}/secret-sell`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                // Refresh lists
                loadProducts();
                if (typeof loadWarehouseData === 'function') loadWarehouseData();
                showToastMessage(`Секретная продажа выполнена для ${name}!`);
            } else {
                alert("Ошибка секретной продажи: " + data.message);
            }
        })
        .catch(err => {
            console.error(err);
            showToastMessage("Ошибка сети при секретной продаже.");
        });
        return;
    }
    
    currentWriteOffProductId = id;
    currentWriteOffProductStock = currentStock;
    
    document.getElementById("write-off-product-name").innerText = name;
    document.getElementById("write-off-product-stock").innerText = currentStock + " шт.";
    document.getElementById("write-off-qty").value = 1;
    document.getElementById("write-off-reason").value = "";
    
    document.getElementById("modal-write-off").classList.add("active");
}

// --- Print Barcode Label Modal (CODE128) ---
function openPrintModal(product, count = 1) {
    currentPrintProduct = product; // Save globally for the print button action
    const wrapper = document.getElementById("label-to-print");
    if (!wrapper) return;
    wrapper.innerHTML = ""; // Clear any previous labels
    
    // Ensure count is at least 1 and parsed correctly
    count = Math.max(1, parseInt(count) || 1);
    
    // Create exactly ONE preview label
    const labelDiv = document.createElement("div");
    labelDiv.className = "thermal-label";
    
    const svgId = `print-barcode-svg-0`;
    
    labelDiv.innerHTML = `
        <div class="label-title">${escapeHtml(product.name)}</div>
        <div class="label-barcode-wrapper">
            <svg id="${svgId}"></svg>
        </div>
        <div class="label-price">${formatCurrency(product.price)} сум</div>
    `;
    
    wrapper.appendChild(labelDiv);
    
    JsBarcode(`#${svgId}`, product.barcode, {
        format: "CODE128",
        width: 1, // Thinner lines (extremely compact for 4-digit code)
        height: 22, // Sized down from 28 to leave more margins on the 38mm height
        displayValue: true,
        fontSize: 9,
        margin: 2
    });
    
    // Update count input value
    const countInput = document.getElementById("print-label-count");
    if (countInput) {
        countInput.value = count;
    }
    
    // Update instruction text
    const instruction = document.querySelector(".print-instruction");
    if (instruction) {
        instruction.innerText = "Внешний вид этикетки перед отправкой на печать:";
    }
    
    document.getElementById("modal-print-label").classList.add("active");
}

function triggerManualPrint(product) {
    // Open the print modal directly with 1 copy by default
    openPrintModal(product, 1);
}

function closePrintModal() {
    document.getElementById("modal-print-label").classList.remove("active");
}

// --- Stats and Reports ---
let analyticsPeriod = 'today';

function loadStats() {
    fetch('/api/dashboard/stats')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                currentStatsData = data.stats; // Cache globally
                renderStats();
            }
        })
        .catch(err => console.error("Error loading stats:", err));
}

function renderStats() {
    if (!currentStatsData) return;
    
    const s = currentStatsData;
    const periodData = analyticsPeriod === 'today' ? s.today : s.all_time;
    
    // Render metrics
    document.getElementById("stat-revenue").innerText = `Выручка: ${formatCurrency(periodData.revenue)} сум`;
    document.getElementById("stat-profit").innerText = `Прибыль: ${formatCurrency(periodData.profit || 0.0)} сум`;
    document.getElementById("stat-items-sold").innerText = `${periodData.items_sold} шт.`;
    document.getElementById("stat-expenses").innerText = `Расходы: ${formatCurrency(periodData.expenses || 0.0)} сум`;
    document.getElementById("stat-net-profit").innerText = `Чистая: ${formatCurrency(periodData.net_profit || 0.0)} сум`;
    document.getElementById("stat-shift-earnings").innerHTML = `Прибыль: ${formatCurrency(s.today.profit)} сум<br><small style="color: rgba(255,255,255,0.65); font-weight:500;">Выручка: ${formatCurrency(s.today.revenue)} сум</small>`;
    document.getElementById("stat-out-of-stock").innerText = `${s.out_of_stock_count} поз.`;
    document.getElementById("stat-total-products").innerText = `${s.total_products} поз.`;

    // Render Stock Valuation metrics
    const stockCost = s.inventory_value ? s.inventory_value.cost : 0.0;
    const stockRetail = s.inventory_value ? s.inventory_value.selling : 0.0;
    const stockMargin = s.inventory_value ? s.inventory_value.expected_profit : 0.0;
    
    const statStockCostEl = document.getElementById("stat-stock-cost");
    const statStockRetailEl = document.getElementById("stat-stock-retail");
    const statStockMarginEl = document.getElementById("stat-stock-margin");
    
    if (statStockCostEl) statStockCostEl.innerText = `Себест.: ${formatCurrency(stockCost)} сум`;
    if (statStockRetailEl) statStockRetailEl.innerText = `В рознице: ${formatCurrency(stockRetail)} сум`;
    if (statStockMarginEl) statStockMarginEl.innerText = `Ожид. приб: ${formatCurrency(stockMargin)} сум`;

    // Load list of out-of-stock items dynamically for the card hover tooltip
    fetch('/api/products')
        .then(res => res.json())
        .then(products => {
            const outOfStock = products.filter(p => p.stock === 0);
            const tooltipEl = document.getElementById("tooltip-out-of-stock");
            if (tooltipEl) {
                if (outOfStock.length === 0) {
                    tooltipEl.innerText = "Все товары в наличии!";
                } else {
                    const namesList = outOfStock.map(p => `• ${p.name}`).slice(0, 5).join("\n");
                    const overflowCount = outOfStock.length - 5;
                    tooltipEl.innerText = "Нет на складе:\n" + namesList + (overflowCount > 0 ? `\n...и еще ${overflowCount} поз.` : "");
                }
            }
        })
        .catch(err => console.error("Error loading products for tooltip:", err));
    
    // History table
    const histBody = document.getElementById("sales-history-tbody");
    histBody.innerHTML = "";
    if (periodData.sales_list.length === 0) {
        histBody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-secondary);">Продаж пока нет</td></tr>';
    } else {
        periodData.sales_list.forEach(sale => {
            const tr = document.createElement("tr");
            const discountStr = sale.discount_percent > 0 ? `-${sale.discount_percent}%` : "—";
            
            let formattedTime = "—";
            if (sale.sold_at) {
                const rawDateStr = String(sale.sold_at).split('.')[0];
                const parts = rawDateStr.split(' ');
                if (parts.length === 2) {
                    const dParts = parts[0].split('-');
                    const tParts = parts[1].split(':');
                    formattedTime = `${dParts[2]}.${dParts[1]}, ${tParts[0]}:${tParts[1]}:${tParts[2] || '00'}`;
                } else {
                    formattedTime = rawDateStr;
                }
            }
            
            let payment = '<span style="color: #00e676; font-weight: 500;">💵 Наличные</span>';
            if (sale.payment_method === 'card') {
                payment = '<span style="color: #00e5ff; font-weight: 500;">💳 Карта</span>';
            } else if (sale.payment_method === 'transfer') {
                payment = '<span style="color: #ffeb3b; font-weight: 500;">📱 Перевод</span>';
            } else if (sale.payment_method === 'mix') {
                const mCash = parseFloat(sale.mix_cash) || 0;
                const mCard = parseFloat(sale.mix_card) || 0;
                payment = `<span style="background: rgba(186, 104, 200, 0.2); color: #ce93d8; font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; font-weight: bold;">🔄 Mix</span><div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 2px;">${formatCurrency(mCash)} нал + ${formatCurrency(mCard)} карта</div>`;
            }

            tr.innerHTML = `
                <td style="color: var(--text-secondary); font-size: 0.85rem;">${formattedTime}</td>
                <td style="font-weight: 500; cursor: pointer; text-decoration: underline; color: #00b0ff;" onclick="openProductHistoryCard(${sale.product_id})">${escapeHtml(sale.product_name)}</td>
                <td class="table-barcode">${sale.barcode}</td>
                <td>${sale.quantity} шт.</td>
                <td><span class="session-sale-discount-badge" style="margin: 0; display: ${sale.discount_percent > 0 ? 'inline-block' : 'none'}">${discountStr}</span>${sale.discount_percent === 0 ? '—' : ''}</td>
                <td style="font-weight: 700; color: var(--color-success);">${formatCurrency(sale.price_final * sale.quantity)} сум</td>
                <td style="font-size: 0.85rem;">${payment}</td>
                <td style="text-align: center; display: flex; gap: 8px; justify-content: center; align-items: center;">
                    <button class="action-icon-btn btn-edit-prd" onclick="openEditSaleModal(${sale.id})" title="Редактировать продажу" style="background: rgba(0, 176, 255, 0.1); color: #00b0ff; border: 1px solid rgba(0, 176, 255, 0.3); padding: 4px 8px; font-size: 0.72rem; border-radius: 6px; cursor: pointer; height: fit-content; margin-top: 0;">
                        Изм.
                    </button>
                    <button class="action-icon-btn btn-delete-prd" onclick="refundSale(${sale.id})" title="Оформить возврат" style="background: rgba(255, 61, 0, 0.1); color: #ff3d00; border: 1px solid rgba(255, 61, 0, 0.3); padding: 4px 8px; font-size: 0.72rem; border-radius: 6px; cursor: pointer; height: fit-content; margin-top: 0;">
                        Возврат
                    </button>
                </td>
            `;
            histBody.appendChild(tr);
        });
    }
    
    // Top Products progress bars
    const topList = document.getElementById("top-products-list");
    topList.innerHTML = "";
    if (periodData.top_products.length === 0) {
        topList.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px 0;">Нет данных</div>';
    } else {
        periodData.top_products.forEach(p => {
            const div = document.createElement("div");
            div.className = "top-product-item";
            div.innerHTML = `
                <span class="top-product-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
                <div class="top-product-qty-rev">
                    <span class="top-product-qty">${p.sold_qty} шт.</span>
                    <span class="top-product-rev"> на ${formatCurrency(p.revenue)} сум</span>
                </div>
            `;
            topList.appendChild(div);
        });
    }
    
    // Dynamic Right Panel Card (Categories for Today, Daily dynamics for All Time)
    const rightTitle = document.querySelector(".analytics-right .report-box:nth-child(2) h3");
    const rightList = document.getElementById("sales-by-day-list");
    rightList.innerHTML = "";
    
    if (analyticsPeriod === 'today') {
        if (rightTitle) rightTitle.innerText = "Продажи по типам товаров (сегодня)";
        if (!s.today.sales_by_type || s.today.sales_by_type.length === 0) {
            rightList.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px 0;">Нет продаж сегодня</div>';
        } else {
            s.today.sales_by_type.forEach(item => {
                const div = document.createElement("div");
                div.className = "sales-day-item";
                div.innerHTML = `
                    <span class="sales-day-date" style="font-weight: 500; color: var(--text-primary);">${escapeHtml(item.type_name)}</span>
                    <span class="sales-day-revenue">${formatCurrency(item.revenue)} сум <small style="color: var(--text-secondary)">(${item.sold_qty} шт)</small></span>
                `;
                rightList.appendChild(div);
            });
        }
    } else {
        if (rightTitle) rightTitle.innerText = "История выручки по дням";
        if (s.sales_by_day.length === 0) {
            rightList.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px 0;">Нет данных</div>';
        } else {
            s.sales_by_day.forEach(day => {
                const formattedDate = new Date(day.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
                const div = document.createElement("div");
                div.className = "sales-day-item";
                div.innerHTML = `
                    <span class="sales-day-date">${formattedDate}</span>
                    <span class="sales-day-revenue">${formatCurrency(day.revenue)} сум <small style="color: var(--text-secondary)">(${day.items_count} шт)</small></span>
                `;
                rightList.appendChild(div);
            });
        }
    }
}

// --- Utilities ---
function formatCurrency(num) {
    if (num === null || num === undefined) return "0";
    return Math.round(num).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return "";
    return String(unsafe)
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

function showToastMessage(msg) {
    // Simple custom notification element
    const toast = document.createElement("div");
    toast.style.position = "fixed";
    toast.style.bottom = "20px";
    toast.style.left = "50%";
    toast.style.transform = "translateX(-50%) translateY(20px)";
    toast.style.backgroundColor = "rgba(0, 230, 118, 0.95)";
    toast.style.color = "#090a0f";
    toast.style.padding = "14px 28px";
    toast.style.borderRadius = "30px";
    toast.style.fontWeight = "bold";
    toast.style.fontSize = "1rem";
    toast.style.zIndex = "2000";
    toast.style.transition = "all 0.3s ease";
    toast.style.boxShadow = "0 8px 24px rgba(0, 230, 118, 0.4)";
    toast.innerText = msg;
    
    document.body.appendChild(toast);
    
    // Animate up
    setTimeout(() => {
        toast.style.transform = "translateX(-50%) translateY(0)";
    }, 10);
    
    // Remove after 2.5 seconds
    setTimeout(() => {
        toast.style.transform = "translateX(-50%) translateY(20px)";
        toast.style.opacity = "0";
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 300);
    }, 2200);
}

// --- Analytics Details Modal popup populator ---
function openAnalyticsDetailModal(type) {
    if (!currentStatsData) return;
    
    const titleEl = document.getElementById("analytics-detail-title");
    const theadEl = document.getElementById("analytics-detail-thead");
    const tbodyEl = document.getElementById("analytics-detail-tbody");
    
    theadEl.innerHTML = "";
    tbodyEl.innerHTML = "";
    
    const s = currentStatsData;
    
    if (type === "revenue") {
        titleEl.innerText = "Детализация выручки по дням";
        theadEl.innerHTML = `
            <tr>
                <th>Дата</th>
                <th>Количество продаж</th>
                <th>Сумма выручки</th>
                <th>Чистая прибыль</th>
            </tr>
        `;
        if (s.sales_by_day.length === 0) {
            tbodyEl.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 15px;">Нет данных</td></tr>';
        } else {
            s.sales_by_day.forEach(day => {
                const formattedDate = new Date(day.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${formattedDate}</td>
                    <td>${day.items_count} шт.</td>
                    <td style="font-weight: 700; color: var(--color-success);">${formatCurrency(day.revenue)} сум</td>
                    <td style="font-weight: 700; color: #00e676;">${formatCurrency(day.profit || 0.0)} сум</td>
                `;
                tbodyEl.appendChild(tr);
            });
        }
    } 
    else if (type === "items-sold") {
        const salesSource = analyticsPeriod === 'today' ? s.today.sales_list : s.all_time.sales_list;
        titleEl.innerText = analyticsPeriod === 'today' ? "Продажи за сегодняшний день" : "История всех продаж за все время";
        theadEl.innerHTML = `
            <tr>
                <th>Время</th>
                <th>Товар</th>
                <th>Код</th>
                <th>Кол-во</th>
                <th>Итого</th>
            </tr>
        `;
        if (salesSource.length === 0) {
            tbodyEl.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 15px;">Продаж пока нет</td></tr>';
        } else {
            salesSource.forEach(sale => {
                const formattedTime = new Date(sale.sold_at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td style="color: var(--text-secondary); font-size: 0.85rem;">${formattedTime}</td>
                    <td style="font-weight: 500; cursor: pointer; text-decoration: underline; color: #00b0ff;" onclick="openProductHistoryCard(${sale.product_id})">${escapeHtml(sale.product_name)}</td>
                    <td class="table-barcode">${sale.barcode}</td>
                    <td>${sale.quantity} шт.</td>
                    <td style="font-weight: 700; color: var(--color-success);">${formatCurrency(sale.price_final * sale.quantity)} сум</td>
                `;
                tbodyEl.appendChild(tr);
            });
        }
    } 
    else if (type === "out-of-stock") {
        titleEl.innerText = "Товары, которых нет на складе (остаток 0)";
        theadEl.innerHTML = `
            <tr>
                <th>Код</th>
                <th>Название товара</th>
                <th>Цена продажи</th>
                <th>Статус</th>
            </tr>
        `;
        tbodyEl.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 15px;">Загрузка списка отсутствующих товаров...</td></tr>';
        
        fetch('/api/products')
            .then(res => res.json())
            .then(products => {
                tbodyEl.innerHTML = "";
                const outOfStock = products.filter(p => p.stock === 0);
                if (outOfStock.length === 0) {
                    tbodyEl.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--color-success); font-weight: bold; padding: 25px 0;">Все товары в наличии на складе!</td></tr>';
                } else {
                    outOfStock.forEach(p => {
                        const tr = document.createElement("tr");
                        tr.innerHTML = `
                            <td class="table-barcode">${p.barcode}</td>
                            <td style="font-weight: 500;">${escapeHtml(p.name)}</td>
                            <td>${formatCurrency(p.price)} сум</td>
                            <td><span class="table-stock out" style="padding: 3px 8px; border-radius: 4px; font-size: 0.75rem;">Закончился</span></td>
                        `;
                        tbodyEl.appendChild(tr);
                    });
                }
            })
            .catch(err => {
                console.error("Error loading products details:", err);
                tbodyEl.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--color-danger); padding: 15px;">Ошибка загрузки списка.</td></tr>';
            });
    } 
    else if (type === "total-products") {
        titleEl.innerText = "Полный каталог товаров на складе";
        theadEl.innerHTML = `
            <tr>
                <th>Код</th>
                <th>Название товара</th>
                <th>Цена</th>
                <th>Остаток</th>
            </tr>
        `;
        tbodyEl.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 15px;">Загрузка каталога склада...</td></tr>';
        
        fetch('/api/products')
            .then(res => res.json())
            .then(products => {
                tbodyEl.innerHTML = "";
                if (products.length === 0) {
                    tbodyEl.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 15px;">Склад пуст</td></tr>';
                } else {
                    products.forEach(p => {
                        const tr = document.createElement("tr");
                        const stockClass = p.stock === 0 ? 'table-stock out' : 'table-stock';
                        tr.innerHTML = `
                            <td class="table-barcode">${p.barcode}</td>
                            <td style="font-weight: 500;">${escapeHtml(p.name)}</td>
                            <td>${formatCurrency(p.price)} сум</td>
                            <td class="${stockClass}">${p.stock} шт.</td>
                        `;
                        tbodyEl.appendChild(tr);
                    });
                }
            })
            .catch(err => {
                console.error("Error loading products catalog details:", err);
                tbodyEl.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--color-danger); padding: 15px;">Ошибка загрузки каталога.</td></tr>';
            });
    }
    else if (type === "stock-valuation") {
        titleEl.innerText = "Оценка остатков склада по категориям";
        theadEl.innerHTML = `
            <tr>
                <th>Категория</th>
                <th style="text-align: center;">Позиций</th>
                <th style="text-align: center;">Остаток (шт)</th>
                <th style="text-align: right;">Себестоимость</th>
                <th style="text-align: right;">В рознице</th>
                <th style="text-align: right;">Ожид. прибыль</th>
            </tr>
        `;
        tbodyEl.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 15px;">Загрузка данных склада...</td></tr>';
        
        fetch('/api/products')
        .then(res => res.json())
        .then(products => {
            tbodyEl.innerHTML = "";
            const categoryStats = {};
            products.forEach(p => {
                const cat = p.type || "Без категории";
                if (!categoryStats[cat]) {
                    categoryStats[cat] = {
                        name: cat,
                        unique_positions: 0,
                        total_stock: 0,
                        total_cost: 0,
                        total_retail: 0
                    };
                }
                categoryStats[cat].unique_positions += 1;
                categoryStats[cat].total_stock += (p.stock || 0);
                categoryStats[cat].total_cost += (p.cost_price || 0.0) * (p.stock || 0);
                categoryStats[cat].total_retail += (p.price || 0.0) * (p.stock || 0);
            });
            
            let overallPositions = 0;
            let overallStock = 0;
            let overallCost = 0;
            let overallRetail = 0;
            
            Object.values(categoryStats).forEach(c => {
                const profit = c.total_retail - c.total_cost;
                overallPositions += c.unique_positions;
                overallStock += c.total_stock;
                overallCost += c.total_cost;
                overallRetail += c.total_retail;
                
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td style="font-weight: 500;">${escapeHtml(c.name)}</td>
                    <td style="text-align: center;">${c.unique_positions}</td>
                    <td style="text-align: center;">${c.total_stock} шт.</td>
                    <td style="text-align: right; color: var(--text-secondary);">${formatCurrency(c.total_cost)} сум</td>
                    <td style="text-align: right; color: #fff; font-weight: 600;">${formatCurrency(c.total_retail)} сум</td>
                    <td style="text-align: right; color: var(--color-success); font-weight: 700;">${formatCurrency(profit)} сум</td>
                `;
                tbodyEl.appendChild(tr);
            });
            
            const trSummary = document.createElement("tr");
            trSummary.style.borderTop = "2px solid var(--border-color)";
            trSummary.style.fontWeight = "bold";
            trSummary.innerHTML = `
                <td>Итого по складу:</td>
                <td style="text-align: center;">${overallPositions}</td>
                <td style="text-align: center;">${overallStock} шт.</td>
                <td style="text-align: right; color: var(--text-secondary);">${formatCurrency(overallCost)} сум</td>
                <td style="text-align: right; color: #fff; font-size: 0.95rem;">${formatCurrency(overallRetail)} сум</td>
                <td style="text-align: right; color: var(--color-success); font-size: 1rem;">${formatCurrency(overallRetail - overallCost)} сум</td>
            `;
            tbodyEl.appendChild(trSummary);
        })
        .catch(err => {
            console.error("Error loading warehouse valuation details:", err);
            tbodyEl.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--color-danger); padding: 15px;">Ошибка загрузки.</td></tr>';
        });
    }
    else if (type === "net-profit") {
        titleEl.innerText = "Анализ чистой прибыли и оценка остатка склада";
        theadEl.innerHTML = `
            <tr>
                <th>Показатель склада / прибыли</th>
                <th style="text-align: right;">Сумма (сум)</th>
            </tr>
        `;
        const costValue = s.inventory_value ? s.inventory_value.cost : 0;
        const sellValue = s.inventory_value ? s.inventory_value.selling : 0;
        const expectedProfitVal = s.inventory_value ? s.inventory_value.expected_profit : 0;
        
        tbodyEl.innerHTML = `
            <tr>
                <td style="font-weight: 500;">Чистая прибыль от продаж за выбранный период</td>
                <td style="text-align: right; font-weight: 700; color: var(--color-success);">${formatCurrency(periodData.profit)} сум</td>
            </tr>
            <tr>
                <td style="font-weight: 500;">Общая выручка от продаж за выбранный период</td>
                <td style="text-align: right; font-weight: 500; color: #fff;">${formatCurrency(periodData.revenue)} сум</td>
            </tr>
            <tr>
                <td style="font-weight: 500;">Себестоимость проданных товаров за выбранный период</td>
                <td style="text-align: right; font-weight: 500; color: var(--text-secondary);">${formatCurrency(periodData.revenue - periodData.profit)} сум</td>
            </tr>
            <tr style="border-top: 2px solid var(--border-color);">
                <td style="font-weight: bold; color: var(--color-primary);">Оценка остатка склада по себестоимости</td>
                <td style="text-align: right; font-weight: bold; color: var(--color-primary);">${formatCurrency(costValue)} сум</td>
            </tr>
            <tr>
                <td style="font-weight: 500;">Оценка остатка склада по ценам продажи (ожидаемая выручка)</td>
                <td style="text-align: right; font-weight: 500; color: #fff;">${formatCurrency(sellValue)} сум</td>
            </tr>
            <tr>
                <td style="font-weight: bold; color: #00e676;">Ожидаемая чистая прибыль от остатка склада</td>
                <td style="text-align: right; font-weight: bold; color: #00e676;">${formatCurrency(expectedProfitVal)} сум</td>
            </tr>
        `;
    } 
    else if (type === "shift-earnings") {
        titleEl.innerText = "Детальный отчет по продажам за сегодня";
        theadEl.innerHTML = `
            <tr>
                <th>Время</th>
                <th>Товар</th>
                <th>Кол-во</th>
                <th>Выручка</th>
                <th>Себест.</th>
                <th>Прибыль</th>
            </tr>
        `;
        if (s.today.sales_list.length === 0) {
            tbodyEl.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 15px;">За сегодня продаж еще не было</td></tr>';
        } else {
            let totalRev = 0;
            let totalCost = 0;
            let totalProfitVal = 0;
            let cashSales = 0;
            let cardSales = 0;
            let transferSales = 0;
            
            s.today.sales_list.forEach(sale => {
                const formattedTime = new Date(sale.sold_at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const cost = (sale.cost_price || 0) * sale.quantity;
                const rev = sale.price_final * sale.quantity;
                const profit = rev - cost;
                
                totalRev += rev;
                totalCost += cost;
                totalProfitVal += profit;
                
                if (sale.payment_method === 'cash') cashSales += rev;
                else if (sale.payment_method === 'card') cardSales += rev;
                else if (sale.payment_method === 'transfer') transferSales += rev;
                
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td style="color: var(--text-secondary); font-size: 0.85rem;">${formattedTime}</td>
                    <td style="font-weight: 500; cursor: pointer; text-decoration: underline; color: #00b0ff;" onclick="openProductHistoryCard(${sale.product_id})">${escapeHtml(sale.product_name)}</td>
                    <td>${sale.quantity} шт.</td>
                    <td style="font-weight: 600; color: #fff;">${formatCurrency(rev)} сум</td>
                    <td style="color: var(--text-secondary);">${formatCurrency(cost)} сум</td>
                    <td style="font-weight: 700; color: var(--color-success);">${formatCurrency(profit)} сум</td>
                `;
                tbodyEl.appendChild(tr);
            });
            
            // Add summary row
            const trSummary = document.createElement("tr");
            trSummary.style.borderTop = "2px solid var(--border-color)";
            trSummary.style.fontWeight = "bold";
            trSummary.innerHTML = `
                <td colspan="2">Итого за смену:</td>
                <td>—</td>
                <td style="color: #00e676; font-weight: 800;">${formatCurrency(totalRev)} сум</td>
                <td style="color: var(--text-secondary);">${formatCurrency(totalCost)} сум</td>
                <td style="color: var(--color-success); font-size: 1.1rem;">${formatCurrency(totalProfitVal)} сум</td>
            `;
            tbodyEl.appendChild(trSummary);

            // Add payment method breakdown row under total sum
            const trBreakdown = document.createElement("tr");
            trBreakdown.style.background = "rgba(255, 255, 255, 0.02)";
            trBreakdown.style.fontSize = "0.85rem";
            trBreakdown.innerHTML = `
                <td colspan="6" style="padding: 10px 15px; color: #fff;">
                    <div style="display: flex; gap: 20px; flex-wrap: wrap; align-items: center;">
                        <span>💵 Оплачено наличными: <strong style="color: #ffeb3b;">${formatCurrency(cashSales)} сум</strong></span>
                        <span>💳 Оплачено безналичными: <strong style="color: #00e5ff;">${formatCurrency(cardSales + transferSales)} сум</strong> (Карта: ${formatCurrency(cardSales)}, Перевод: ${formatCurrency(transferSales)})</span>
                    </div>
                </td>
            `;
            tbodyEl.appendChild(trBreakdown);
        }
    }
    
    document.getElementById("modal-analytics-detail").classList.add("active");
}

// --- Graphical Charts Renderer (Chart.js) ---
let topProductsChart = null;
let salesDynamicsChart = null;
let abcCategoriesChart = null;
let phoneModelsChart = null;
let detailedTopProductsChart = null;

function computeABC(salesByType) {
    if (!salesByType || salesByType.length === 0) {
        return { totalRev: 0, items: [], groupA: [], groupB: [], groupC: [] };
    }
    const totalRev = salesByType.reduce((sum, item) => sum + (item.revenue || 0), 0);
    if (totalRev === 0) {
        return { totalRev: 0, items: [], groupA: [], groupB: [], groupC: [] };
    }

    const sorted = [...salesByType].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));

    let cumRev = 0;
    const groupA = [];
    const groupB = [];
    const groupC = [];

    const items = sorted.map(item => {
        const rev = item.revenue || 0;
        const prevCumPct = (cumRev / totalRev) * 100;
        cumRev += rev;
        const cumPct = (cumRev / totalRev) * 100;
        const sharePct = (rev / totalRev) * 100;

        let group = 'C';
        let color = '#ff3d00';
        let bg = 'rgba(255, 61, 0, 0.65)';

        if (prevCumPct < 80) {
            group = 'A';
            color = '#00e676';
            bg = 'rgba(0, 230, 118, 0.65)';
            groupA.push(item.type_name);
        } else if (prevCumPct < 95) {
            group = 'B';
            color = '#ffb300';
            bg = 'rgba(255, 179, 0, 0.65)';
            groupB.push(item.type_name);
        } else {
            group = 'C';
            color = '#ff3d00';
            bg = 'rgba(255, 61, 0, 0.65)';
            groupC.push(item.type_name);
        }

        return {
            name: item.type_name,
            revenue: rev,
            qty: item.sold_qty,
            sharePct: sharePct.toFixed(1),
            cumPct: cumPct.toFixed(1),
            group,
            color,
            bg
        };
    });

    return { totalRev, items, groupA, groupB, groupC };
}

function loadChartsData() {
    fetch('/api/dashboard/stats')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                renderCharts(data.stats);
            }
        })
        .catch(err => console.error("Error loading stats for charts:", err));
}

function renderCharts(s) {
    if (!s) return;
    const periodData = analyticsPeriod === 'today' ? s.today : s.all_time;

    // --- 0. Populate KPI Cards Immediately ---
    try {
        const curMargin = periodData && periodData.revenue > 0 ? Math.round((periodData.profit / periodData.revenue) * 100) : 0;
        const marginEl = document.getElementById('kpi-margin-val');
        if (marginEl) marginEl.innerText = curMargin + '%';

        const days = s.sales_by_day ? [...s.sales_by_day].reverse() : [];
        let growthVal = 0;
        if (days.length >= 2) {
            const lastRev = days[days.length - 1].revenue || 0;
            const prevRev = days[days.length - 2].revenue || 0;
            if (prevRev > 0) {
                growthVal = Math.round(((lastRev - prevRev) / prevRev) * 100);
            }
        }
        const growthEl = document.getElementById('kpi-growth-val');
        if (growthEl) {
            if (growthVal >= 0) {
                growthEl.innerText = `▲ ${growthVal}%`;
                growthEl.style.color = '#00e676';
            } else {
                growthEl.innerText = `▼ ${Math.abs(growthVal)}%`;
                growthEl.style.color = '#ff3d00';
            }
        }
    } catch (kpiErr) {
        console.error("Error updating KPI cards:", kpiErr);
    }

    const hasApex = typeof ApexCharts !== 'undefined';
    if (!hasApex) {
        console.warn("ApexCharts library not loaded yet. Retrying in 200ms...");
        setTimeout(() => {
            if (typeof ApexCharts !== 'undefined') renderCharts(s);
        }, 200);
    }

    // --- 1. Top Products Chart ---
    if (hasApex) {
        try {
            const topProdEl = document.getElementById('chart-top-products');
            if (topProdEl) {
                if (topProductsChart) {
                    try { topProductsChart.destroy(); } catch(e) {}
                }
                const topProducts = (periodData && periodData.top_products) ? periodData.top_products : [];
                const topProdLabels = topProducts.map(p => p.name);
                const topProdQtys = topProducts.map(p => p.sold_qty);

                topProductsChart = new ApexCharts(topProdEl, {
                    chart: {
                        type: 'bar',
                        height: 240,
                        foreColor: '#8f9bb3',
                        toolbar: { show: false }
                    },
                    plotOptions: {
                        bar: {
                            borderRadius: 4,
                            columnWidth: '45%',
                            distributed: true
                        }
                    },
                    colors: ['#00e676', '#00b0ff', '#7c4dff', '#ffb300', '#ff3d00'],
                    dataLabels: {
                        enabled: false
                    },
                    legend: {
                        show: false
                    },
                    series: [{
                        name: 'Продано штук',
                        data: topProdQtys.length > 0 ? topProdQtys : [0]
                    }],
                    xaxis: {
                        categories: topProdLabels.length > 0 ? topProdLabels : ['Нет данных'],
                        axisBorder: { show: false },
                        axisTicks: { show: false }
                    },
                    grid: {
                        borderColor: 'rgba(255, 255, 255, 0.08)',
                        strokeDashArray: 4
                    },
                    tooltip: {
                        theme: 'dark'
                    }
                });
                topProductsChart.render();
            }
        } catch (e1) {
            console.error("Error rendering topProductsChart:", e1);
        }
    }

    // --- 2. Sales Dynamics Chart ---
    if (hasApex) {
        try {
            const dynamicsEl = document.getElementById('chart-sales-dynamics');
            if (dynamicsEl) {
                if (salesDynamicsChart) {
                    try { salesDynamicsChart.destroy(); } catch(e) {}
                }
                const days = s.sales_by_day ? [...s.sales_by_day].reverse() : [];
                const salesLabels = days.map(d => d.date.replace(/-/g, ' '));
                const marginPctData = days.map(d => d.revenue > 0 ? Math.round((d.profit / d.revenue) * 100) : 0);
                const targetLineData = days.map(() => 35);

                salesDynamicsChart = new ApexCharts(dynamicsEl, {
                    chart: {
                        type: 'area',
                        height: 250,
                        foreColor: '#8f9bb3',
                        toolbar: { show: false }
                    },
                    dataLabels: {
                        enabled: false
                    },
                    stroke: {
                        curve: 'smooth',
                        width: 3
                    },
                    colors: ['#00b0ff', '#e53935'],
                    fill: {
                        type: 'gradient',
                        gradient: {
                            shadeIntensity: 1,
                            opacityFrom: 0.35,
                            opacityTo: 0.05,
                            stops: [0, 90, 100]
                        }
                    },
                    series: [
                        {
                            name: 'Маржинальность (%)',
                            data: marginPctData.length > 0 ? marginPctData : [0]
                        },
                        {
                            name: 'Целевая маржа (35%)',
                            data: targetLineData.length > 0 ? targetLineData : [35]
                        }
                    ],
                    xaxis: {
                        categories: salesLabels.length > 0 ? salesLabels : ['Нет данных'],
                        axisBorder: { show: false },
                        axisTicks: { show: false }
                    },
                    yaxis: {
                        min: 0,
                        max: 100,
                        labels: {
                            formatter: function (val) { return val + "%" }
                        }
                    },
                    grid: {
                        borderColor: 'rgba(255, 255, 255, 0.08)',
                        strokeDashArray: 4
                    },
                    tooltip: {
                        theme: 'dark'
                    }
                });
                salesDynamicsChart.render();
            }
        } catch (e2) {
            console.error("Error rendering salesDynamicsChart:", e2);
        }
    }

    // --- 3. ABC Category Analysis Chart ---
    try {
        const categorySales = (periodData && periodData.sales_by_type) ? periodData.sales_by_type : [];
        const abcResult = computeABC(categorySales);

        if (hasApex) {
            const abcEl = document.getElementById('chart-abc-categories');
            if (abcEl) {
                if (abcCategoriesChart) {
                    try { abcCategoriesChart.destroy(); } catch(e) {}
                }
                const abcLabels = abcResult.items.map(i => `${i.name} [${i.group}]`);
                const abcRevenues = abcResult.items.map(i => i.revenue);
                const abcColors = abcResult.items.map(i => i.color);

                abcCategoriesChart = new ApexCharts(abcEl, {
                    chart: {
                        type: 'donut',
                        height: 230,
                        foreColor: '#8f9bb3'
                    },
                    labels: abcLabels.length > 0 ? abcLabels : ['Нет данных'],
                    series: abcRevenues.length > 0 ? abcRevenues : [0],
                    colors: abcColors.length > 0 ? abcColors : ['#8f9bb3'],
                    stroke: { show: false },
                    legend: {
                        position: 'bottom',
                        labels: { colors: '#8f9bb3' }
                    },
                    plotOptions: {
                        pie: {
                            donut: {
                                size: '70%',
                                labels: {
                                    show: true,
                                    name: { show: true },
                                    value: {
                                        show: true,
                                        formatter: function (val) {
                                            return formatCurrency(val) + ' сум';
                                        }
                                    },
                                    total: {
                                        show: true,
                                        label: 'Всего выручки',
                                        formatter: function (w) {
                                            const sum = w.globals.seriesTotals.reduce((a, b) => a + b, 0);
                                            return formatCurrency(sum) + ' сум';
                                        }
                                    }
                                }
                            }
                        }
                    },
                    tooltip: {
                        theme: 'dark'
                    }
                });
                abcCategoriesChart.render();
            }
        }

        // Render Legend
        const legendEl = document.getElementById('abc-categories-legend');
        if (legendEl) {
            if (abcResult.items.length === 0) {
                legendEl.innerHTML = '<span style="color: var(--text-secondary);">Нет данных по категориям за выбранный период</span>';
            } else {
                const textA = abcResult.groupA.length > 0 ? `<b style="color:#00e676;">A (до 80% выручки):</b> ${abcResult.groupA.join(', ')}` : '<b style="color:#00e676;">A:</b> —';
                const textB = abcResult.groupB.length > 0 ? `<b style="color:#ffb300;">B (80-95% выручки):</b> ${abcResult.groupB.join(', ')}` : '<b style="color:#ffb300;">B:</b> —';
                const textC = abcResult.groupC.length > 0 ? `<b style="color:#ff3d00;">C (95-100% выручки):</b> ${abcResult.groupC.join(', ')}` : '<b style="color:#ff3d00;">C:</b> —';
                
                legendEl.innerHTML = `
                    <div style="flex: 1; min-width: 180px;">${textA}</div>
                    <div style="flex: 1; min-width: 180px;">${textB}</div>
                    <div style="flex: 1; min-width: 180px;">${textC}</div>
                `;
            }
        }
    } catch (e3) {
        console.error("Error rendering ABC categories:", e3);
    }

    // --- 4. Stagnant Products list ---
    try {
        const stagnantBody = document.getElementById("table-stagnant-tbody");
        if (stagnantBody) {
            stagnantBody.innerHTML = "";
            if (!s.stagnant_products || s.stagnant_products.length === 0) {
                stagnantBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 20px;">Нет залежавшихся товаров</td></tr>';
            } else {
                s.stagnant_products.forEach(p => {
                    const tr = document.createElement("tr");
                    let lastSaleStr = "Никогда";
                    if (p.last_sale) {
                        lastSaleStr = new Date(p.last_sale).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
                    }
                    const stockClass = p.stock === 0 ? 'table-stock out' : 'table-stock';
                    
                    tr.innerHTML = `
                        <td style="font-weight: 500;">${escapeHtml(p.name)}</td>
                        <td class="table-barcode">${p.barcode}</td>
                        <td class="${stockClass}">${p.stock} шт.</td>
                        <td style="color: var(--text-secondary);">${lastSaleStr}</td>
                    `;
                    stagnantBody.appendChild(tr);
                });
            }
        }
    } catch (e4) {
        console.error("Error rendering stagnant products:", e4);
    }

    // --- 5. Phone Models Visual Chart & Table ---
    try {
        const modelSales = (periodData && periodData.sales_by_model) ? periodData.sales_by_model : [];
        if (hasApex) {
            const modelCtx = document.getElementById('chart-phone-models');
            if (modelCtx) {
                if (phoneModelsChart) {
                    try { phoneModelsChart.destroy(); } catch(e) {}
                }
                const topModelSales = modelSales.slice(0, 7);
                const modelLabels = topModelSales.map(m => m.phone_model);
                const modelRevenues = topModelSales.map(m => m.revenue);

                phoneModelsChart = new ApexCharts(modelCtx, {
                    chart: {
                        type: 'bar',
                        height: 180,
                        foreColor: '#8f9bb3',
                        toolbar: { show: false }
                    },
                    plotOptions: {
                        bar: {
                            borderRadius: 4,
                            horizontal: true,
                            barHeight: '60%'
                        }
                    },
                    colors: ['#7c4dff'],
                    dataLabels: {
                        enabled: false
                    },
                    series: [{
                        name: 'Выручка (сум)',
                        data: modelRevenues.length > 0 ? modelRevenues : [0]
                    }],
                    xaxis: {
                        categories: modelLabels.length > 0 ? modelLabels : ['Нет данных'],
                        labels: {
                            formatter: function (val) { return formatCurrency(val) }
                        }
                    },
                    grid: {
                        borderColor: 'rgba(255, 255, 255, 0.08)',
                        strokeDashArray: 4
                    },
                    tooltip: {
                        theme: 'dark'
                    }
                });
                phoneModelsChart.render();
            }
        }
        
        // Render Phone Model Table
        const modelBody = document.getElementById("table-sales-by-model-tbody");
        if (modelBody) {
            modelBody.innerHTML = "";
            const totalRev = periodData ? (periodData.revenue || 1) : 1;
            if (modelSales.length === 0) {
                modelBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 20px;">Нет данных по моделям за выбранный период</td></tr>';
            } else {
                modelSales.forEach(m => {
                    const tr = document.createElement("tr");
                    const share = totalRev > 0 ? ((m.revenue / totalRev) * 100).toFixed(1) : '0.0';
                    tr.innerHTML = `
                        <td style="font-weight: 600; color: var(--text-primary);">${escapeHtml(m.phone_model)}</td>
                        <td style="font-weight: 500;">${m.sold_qty} шт.</td>
                        <td style="font-weight: 700; color: var(--color-success);">${formatCurrency(m.revenue)} сум</td>
                        <td><span style="background: rgba(124, 77, 255, 0.15); color: #7c4dff; padding: 2px 6px; border-radius: 4px; font-weight: 600; font-size: 0.75rem;">${share}%</span></td>
                    `;
                    modelBody.appendChild(tr);
                });
            }
        }
    } catch (e5) {
        console.error("Error rendering phone models:", e5);
    }

    // --- 6. Detailed Top Products Visual Chart & Table ---
    try {
        const topProds = (periodData && periodData.top_products_detailed) ? periodData.top_products_detailed : [];
        if (hasApex) {
            const detailedTopEl = document.getElementById('chart-detailed-top-products');
            if (detailedTopEl) {
                if (detailedTopProductsChart) {
                    try { detailedTopProductsChart.destroy(); } catch(e) {}
                }
                const top7Prods = topProds.slice(0, 7);
                const prodLabels = top7Prods.map(p => p.name);
                const prodRevenues = top7Prods.map(p => p.revenue);

                detailedTopProductsChart = new ApexCharts(detailedTopEl, {
                    chart: {
                        type: 'bar',
                        height: 180,
                        foreColor: '#8f9bb3',
                        toolbar: { show: false }
                    },
                    plotOptions: {
                        bar: {
                            borderRadius: 4,
                            columnWidth: '50%'
                        }
                    },
                    colors: ['#00e5ff'],
                    dataLabels: {
                        enabled: false
                    },
                    series: [{
                        name: 'Выручка (сум)',
                        data: prodRevenues.length > 0 ? prodRevenues : [0]
                    }],
                    xaxis: {
                        categories: prodLabels.length > 0 ? prodLabels : ['Нет данных'],
                        axisBorder: { show: false },
                        axisTicks: { show: false }
                    },
                    yaxis: {
                        labels: {
                            formatter: function (val) { return formatCurrency(val) }
                        }
                    },
                    grid: {
                        borderColor: 'rgba(255, 255, 255, 0.08)',
                        strokeDashArray: 4
                    },
                    tooltip: {
                        theme: 'dark'
                    }
                });
                detailedTopProductsChart.render();
            }
        }
        
        // Render Top Sold Products Detailed Table
        const prodBody = document.getElementById("table-top-products-tbody");
        if (prodBody) {
            prodBody.innerHTML = "";
            if (topProds.length === 0) {
                prodBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 20px;">Нет данных по товарам за выбранный период</td></tr>';
            } else {
                topProds.forEach(p => {
                    const tr = document.createElement("tr");
                    tr.innerHTML = `
                        <td style="font-weight: 500;">${escapeHtml(p.name)}</td>
                        <td class="table-barcode">${p.barcode}</td>
                        <td>${p.sold_qty} шт.</td>
                        <td style="font-weight: 700; color: var(--color-success);">${formatCurrency(p.revenue)} сум</td>
                        <td style="font-weight: 600; color: #00b0ff;">${formatCurrency(p.profit)} сум</td>
                    `;
                    prodBody.appendChild(tr);
                });
            }
        }
    } catch (e6) {
        console.error("Error rendering detailed top products:", e6);
    }
}

// --- Web Audio API Google Assistant double-beep ---
function playAssistantWakeBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.frequency.setValueAtTime(520, ctx.currentTime);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.1);
        
        setTimeout(() => {
            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.type = "sine";
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.frequency.setValueAtTime(650, ctx.currentTime);
            gain2.gain.setValueAtTime(0.08, ctx.currentTime);
            osc2.start(ctx.currentTime);
            osc2.stop(ctx.currentTime + 0.12);
        }, 120);
    } catch(e) {}
}

// --- Speech Back Assistant speaker ---
function speakBack(phrase) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // cancel any active speaking jobs
    
    const utterance = new SpeechSynthesisUtterance(phrase);
    utterance.lang = "ru-RU";
    utterance.rate = 1.0;
    utterance.pitch = 1.05; // Friendly high pitch
    
    const btn = document.getElementById("btn-owner-voice");
    utterance.onstart = () => {
        if (btn) btn.classList.add("speaking");
    };
    utterance.onend = () => {
        if (btn) btn.classList.remove("speaking");
    };
    window.speechSynthesis.speak(utterance);
}

// --- Voice Recognition Setup ---
function setupVoiceRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        const btn = document.getElementById("btn-owner-voice");
        if (btn) btn.style.display = "none";
        return;
    }
    
    recognition = new SpeechRecognition();
    recognition.lang = "ru-RU";
    recognition.continuous = false;
    recognition.interimResults = false;
    
    recognition.onstart = () => {
        isListening = true;
        playAssistantWakeBeep();
        const btn = document.getElementById("btn-owner-voice");
        const txt = document.getElementById("voice-btn-text");
        if (btn) btn.classList.add("listening");
        if (txt) txt.innerText = "Слушаю...";
    };
    
    recognition.onend = () => {
        isListening = false;
        const btn = document.getElementById("btn-owner-voice");
        const txt = document.getElementById("voice-btn-text");
        if (btn) btn.classList.remove("listening");
        if (txt) txt.innerText = "Голос Gemini";
    };
    
    recognition.onerror = (e) => {
        console.error("Speech recognition error:", e.error);
        if (e.error === "not-allowed") {
            speakBack("Пожалуйста, разрешите доступ к микрофону в браузере.");
        }
        isListening = false;
    };
    
    recognition.onresult = (e) => {
        const resultText = e.results[0][0].transcript;
        processVoiceCommand(resultText);
    };
}

function toggleListening() {
    if (!recognition) setupVoiceRecognition();
    if (!recognition) return;
    
    if (isListening) {
        recognition.stop();
    } else {
        recognition.start();
    }
}

// --- Voice Command processing ---
function processVoiceCommand(text) {
    const raw = text.toLowerCase().trim();
    showToastMessage(`Голосовой ввод: "${text}"`);
    
    // Command 1: Switch navigation tabs
    if (raw.includes("открой склад") || raw.includes("перейди на склад") || raw.includes("покажи склад")) {
        showTab('tab-warehouse');
        speakBack("Открываю склад");
        return;
    }
    if (raw.includes("открой аналитику") || raw.includes("покажи аналитику") || raw.includes("открой отчеты") || raw.includes("покажи отчеты")) {
        showTab('tab-analytics');
        speakBack("Открываю аналитику");
        return;
    }
    if (raw.includes("открой графики") || raw.includes("покажи графики") || raw.includes("перейди на графики")) {
        showTab('tab-charts');
        speakBack("Открываю графики");
        return;
    }
    
    // Command 2: Speak total revenue
    if (raw.includes("какая выручка") || raw.includes("сколько заработали") || raw.includes("покажи выручку") || raw.includes("выручка за всё время")) {
        if (currentStatsData) {
            const rev = currentStatsData.total_revenue;
            speakBack(`Общая выручка за всё время составляет ${Math.round(rev)} рублей.`);
        } else {
            speakBack("Статистика выручки ещё не загружена.");
        }
        return;
    }

    // Command 3: Add product
    // "добавить товар яблоки цена пятьдесят рублей себестоимость тридцать поставщик фрукт тип фрукты остаток десять"
    if (raw.startsWith("добавить товар") || raw.startsWith("добавь товар") || raw.startsWith("создай товар")) {
        const namePart = raw.replace(/^(добавить товар|добавь товар|создай товар)\s+/i, "");
        let price = 0;
        let stock = 1;
        let cost_price = 0.0;
        let supplier = "";
        let type = "";
        let prdName = namePart;
        
        const priceMatch = namePart.match(/(?:цена|за)\s+(\d+)/i);
        if (priceMatch) {
            price = parseFloat(priceMatch[1]);
            prdName = prdName.split(/(?:цена|за)/i)[0].trim();
        }
        
        const costMatch = namePart.match(/(?:себестоимость|себестоимости|закупка|закупочная)\s+(\d+)/i);
        if (costMatch) {
            cost_price = parseFloat(costMatch[1]);
            prdName = prdName.split(/(?:себестоимость|себестоимости|закупка|закупочная)/i)[0].trim();
        }
        
        const supplierMatch = namePart.match(/(?:поставщик|поставщика|поставщиком)\s+([а-яА-Яa-zA-Z0-9\s"'\-]+)/i);
        if (supplierMatch) {
            let supp = supplierMatch[1].trim();
            supp = supp.split(/(?:цена|за|остаток|количество|кол-во|себестоимость|закупка|тип|категория)/i)[0].trim();
            supplier = supp;
            prdName = prdName.split(/(?:поставщик|поставщика|поставщиком)/i)[0].trim();
        }

        const typeMatch = namePart.match(/(?:тип|тип товара|категория|категории)\s+([а-яА-Яa-zA-Z0-9\s"'\-]+)/i);
        if (typeMatch) {
            let tp = typeMatch[1].trim();
            tp = tp.split(/(?:цена|за|остаток|количество|кол-во|себестоимость|закупка|поставщик)/i)[0].trim();
            type = tp;
            prdName = prdName.split(/(?:тип|тип товара|категория|категории)/i)[0].trim();
        }
        
        const stockMatch = namePart.match(/(?:остаток|количество|кол-во|остатка|остатке)\s+(\d+)/i);
        if (stockMatch) {
            stock = parseInt(stockMatch[1]);
            prdName = prdName.split(/(?:остаток|количество|кол-во|остатка|остатке)/i)[0].trim();
        }
        
        // Clean trailing units
        prdName = prdName.replace(/\s+(рублей|рубля|рубль|штук|штуки|штука)$/gi, "").trim();
        
        if (!prdName) {
            speakBack("Я не смогла разобрать название товара. Повторите, пожалуйста.");
            return;
        }
        if (price <= 0) {
            speakBack(`Назовите цену для товара ${prdName}. Например: цена пятьдесят.`);
            return;
        }
        
        fetch('/api/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: prdName, price, stock, cost_price, supplier, type })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                loadProducts();
                let confirmText = `Товар ${prdName} добавлен.`;
                if (cost_price > 0) confirmText += ` Себестоимость ${cost_price} рублей.`;
                if (supplier) confirmText += ` Поставщик ${supplier}.`;
                speakBack(confirmText);
                openPrintModal(data.product, stock);
            } else {
                speakBack(`Не удалось добавить товар: ${data.message}`);
            }
        });
        return;
    }

    // Command 4: Print labels
    // "распечатай 5 этикеток для яблоки"
    if (raw.includes("распечатай") || raw.includes("печать")) {
        const countMatch = raw.match(/(\d+)\s*(?:этикеток|штук|штуки|этикетки)?/i);
        let count = countMatch ? parseInt(countMatch[1]) : 1;
        
        let cleanName = raw.replace(/^(распечатай|печать)\s+/gi, "")
                           .replace(/\d+\s*(этикеток|штук|штуки|этикетки)?/gi, "")
                           .replace(/\s+для\s+/gi, "")
                           .trim();
        
        if (!cleanName) {
            speakBack("Назовите товар для печати этикеток.");
            return;
        }
        
        const found = productsCache.find(p => p.name.toLowerCase().includes(cleanName));
        if (found) {
            speakBack(`Печатаю ${count} этикеток для товара ${found.name}.`);
            fetch('/api/print', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    barcode: found.barcode,
                    name: found.name,
                    price: found.price,
                    count: count
                })
            });
        } else {
            speakBack(`Товар ${cleanName} не найден на складе.`);
        }
        return;
    }

    // Command 5: Check stock
    // "остаток бананы"
    if (raw.includes("сколько осталось") || raw.includes("остаток")) {
        let cleanName = raw.replace(/^(сколько осталось|остаток)\s+/gi, "")
                           .replace(/\s+товара\s+/gi, "")
                           .trim();
        if (!cleanName) {
            speakBack("Назовите товар, чтобы узнать остаток.");
            return;
        }
        
        const found = productsCache.find(p => p.name.toLowerCase().includes(cleanName));
        if (found) {
            speakBack(`Остаток товара ${found.name} составляет ${found.stock} штук.`);
        } else {
            speakBack(`Товар ${cleanName} не найден на складе.`);
        }
        return;
    }

    // Fallback response simulating Gemini
    speakBack(`Я услышала: ${text}. К сожалению, я не знаю такой команды. Вы можете добавлять товары, печатать этикетки или переключать вкладки.`);
}

// --- Settings & Google Drive Sync / Backup Operations ---
function loadGDriveSettings() {
    const redirectDisplay = document.getElementById("redirect-uri-display");
    if (redirectDisplay) {
        redirectDisplay.innerText = window.location.origin + "/api/gdrive/oauth-callback";
    }
    fetch('/api/gdrive/settings')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                document.getElementById("gdrive-client-id").value = data.client_id || "";
                document.getElementById("gdrive-client-secret").value = data.client_secret || "";
                document.getElementById("gdrive-sync-interval").value = data.sync_interval || "Off";
                document.getElementById("gdrive-recovery-password").value = data.recovery_password || "RESTORE-CRM";
            }
        })
        .catch(err => console.error("Error loading GDrive settings:", err));
}

function loadGDriveStatus() {
    fetch('/api/gdrive/status')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                const statusEl = document.getElementById("gdrive-connection-status");
                const emailRow = document.getElementById("gdrive-email-row");
                const emailEl = document.getElementById("gdrive-account-email");
                const lastSyncEl = document.getElementById("gdrive-last-sync-time");
                const lastBackupEl = document.getElementById("gdrive-last-backup-time");
                const syncBtn = document.getElementById("btn-gdrive-sync-now");
                const backupBtn = document.getElementById("btn-gdrive-backup-now");
                const restoreCard = document.getElementById("restore-card");
                const linkContainer = document.getElementById("gdrive-report-link-container");
                const linkEl = document.getElementById("gdrive-report-link");

                lastSyncEl.innerText = data.last_sync || "Никогда";
                if (lastBackupEl) lastBackupEl.innerText = data.last_backup || "Никогда";

                if (data.connected) {
                    statusEl.innerText = "Подключено";
                    statusEl.style.color = "var(--color-success)";
                    statusEl.style.background = "rgba(0, 230, 118, 0.15)";
                    statusEl.style.borderColor = "rgba(0, 230, 118, 0.25)";

                    emailRow.style.display = "flex";
                    emailEl.innerText = data.email || "";

                    syncBtn.style.display = "block";
                    if (backupBtn) backupBtn.style.display = "block";
                    if (restoreCard) restoreCard.style.display = "block";

                    if (data.link) {
                        linkContainer.style.display = "block";
                        linkEl.href = data.link;
                    } else {
                        linkContainer.style.display = "none";
                    }
                } else {
                    statusEl.innerText = "Не подключено";
                    statusEl.style.color = "var(--color-danger)";
                    statusEl.style.background = "rgba(255, 61, 0, 0.15)";
                    statusEl.style.borderColor = "rgba(255, 61, 0, 0.25)";

                    emailRow.style.display = "none";
                    syncBtn.style.display = "none";
                    if (backupBtn) backupBtn.style.display = "none";
                    if (restoreCard) restoreCard.style.display = "none";
                    linkContainer.style.display = "none";
                }
            }
        })
        .catch(err => console.error("Error loading GDrive status:", err));
}

function saveGDriveSettings(e) {
    e.preventDefault();
    const client_id = document.getElementById("gdrive-client-id").value;
    const client_secret = document.getElementById("gdrive-client-secret").value;
    const sync_interval = document.getElementById("gdrive-sync-interval").value;
    const recovery_password = document.getElementById("gdrive-recovery-password").value;

    fetch('/api/gdrive/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id, client_secret, sync_interval, recovery_password })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToastMessage("Настройки системы сохранены!");
            loadGDriveStatus();
            loadGDriveBackups();
        } else {
            alert(data.message);
        }
    })
    .catch(err => {
        console.error("Error saving GDrive settings:", err);
        alert("Ошибка сети при сохранении настроек.");
    });
}

function authorizeGDrive() {
    fetch('/api/gdrive/auth-url')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                window.open(data.url, '_blank');
            } else {
                alert(data.message);
            }
        })
        .catch(err => {
            console.error("Error obtaining auth URL:", err);
            alert("Пожалуйста, сначала введите Google Client ID и нажмите кнопку 'Сохранить настройки'.");
        });
}

function syncGDriveNow() {
    const syncBtn = document.getElementById("btn-gdrive-sync-now");
    syncBtn.disabled = true;
    syncBtn.innerText = "Синхронизация...";

    fetch('/api/gdrive/sync', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            syncBtn.disabled = false;
            syncBtn.innerText = "🔄 Синхронизировать отчет сейчас";
            if (data.success) {
                showToastMessage("Синхронизация с Google Диском завершена!");
                loadGDriveStatus();
            } else {
                alert(data.message);
            }
        })
        .catch(err => {
            syncBtn.disabled = false;
            syncBtn.innerText = "🔄 Синхронизировать отчет сейчас";
            console.error("Manual sync error:", err);
            alert("Ошибка сети при ручной синхронизации.");
        });
}

function backupGDriveNow() {
    const backupBtn = document.getElementById("btn-gdrive-backup-now");
    backupBtn.disabled = true;
    backupBtn.innerText = "Создание бэкапа...";

    fetch('/api/gdrive/backup_now', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            backupBtn.disabled = false;
            backupBtn.innerText = "💾 Создать бэкап базы сейчас";
            if (data.success) {
                showToastMessage("Резервная копия базы данных сохранена на Google Диск!");
                loadGDriveStatus();
                loadGDriveBackups();
            } else {
                alert(data.message);
            }
        })
        .catch(err => {
            backupBtn.disabled = false;
            backupBtn.innerText = "💾 Создать бэкап базы сейчас";
            console.error("Manual backup error:", err);
            alert("Ошибка сети при создании резервной копии.");
        });
}

function loadGDriveBackups() {
    const select = document.getElementById("restore-backup-select");
    if (!select) return;
    
    select.innerHTML = '<option value="">Загрузка списка копий...</option>';

    fetch('/api/gdrive/backups')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                if (!data.configured) {
                    select.innerHTML = '<option value="">Google Диск не авторизован</option>';
                    return;
                }
                
                const backups = data.backups || [];
                if (backups.length === 0) {
                    select.innerHTML = '<option value="">Нет сохраненных резервных копий</option>';
                    return;
                }
                
                let html = '<option value="">-- Выберите резервную копию --</option>';
                backups.forEach(b => {
                    const dateObj = new Date(b.createdTime);
                    const formattedDate = dateObj.toLocaleString('ru-RU');
                    html += `<option value="${b.id}">${b.name} (${formattedDate})</option>`;
                });
                select.innerHTML = html;
            } else {
                select.innerHTML = `<option value="">Ошибка: ${data.message}</option>`;
            }
        })
        .catch(err => {
            console.error("Error loading backups:", err);
            select.innerHTML = '<option value="">Ошибка сети при загрузке списка</option>';
        });
}

function restoreGDriveBackup() {
    const select = document.getElementById("restore-backup-select");
    const passwordInput = document.getElementById("restore-password-input");
    
    if (!select || !passwordInput) return;
    
    const file_id = select.value;
    const password = passwordInput.value.trim();
    
    if (!file_id) {
        alert("Пожалуйста, выберите файл резервной копии из списка!");
        return;
    }
    
    if (!password) {
        alert("Пожалуйста, введите пароль экстренного восстановления!");
        return;
    }
    
    if (!confirm("ВНИМАНИЕ! Восстановление полностью заменит вашу базу данных! Все текущие товары и продажи будут заменены бэкапом. Вы уверены?")) {
        return;
    }

    const restoreBtn = document.getElementById("btn-gdrive-restore");
    restoreBtn.disabled = true;
    restoreBtn.innerText = "Восстановление...";

    fetch('/api/gdrive/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id, password })
    })
    .then(res => res.json())
    .then(data => {
        restoreBtn.disabled = false;
        restoreBtn.innerText = "🔥 Выполнить экстренное восстановление";
        if (data.success) {
            alert("База данных успешно восстановлена! Страница будет перезапущена.");
            window.location.reload();
        } else {
            alert(data.message);
        }
    })
    .catch(err => {
        restoreBtn.disabled = false;
        restoreBtn.innerText = "🔥 Выполнить экстренное восстановление";
        console.error("Restore error:", err);
        alert("Ошибка сети во время восстановления.");
    });
}

// --- Cashier Shift Management Operations ---
function updateShiftUI(shift) {
    const badge = document.getElementById("shift-status-badge");
    const btn = document.getElementById("btn-shift-action");
    
    activeShift = shift;
    
    if (activeShift) {
        // Shift is open
        if (badge) {
            badge.innerText = `Открыта (ID: ${activeShift.id})`;
            badge.style.color = "var(--color-success)";
            badge.style.background = "rgba(0, 230, 118, 0.12)";
            badge.style.borderColor = "rgba(0, 230, 118, 0.2)";
        }
        if (btn) {
            btn.innerText = "Закрыть смену";
            btn.style.background = "linear-gradient(135deg, #ff1744, #d500f9)";
            btn.style.borderColor = "rgba(255, 23, 68, 0.25)";
        }
        
        // Load shift sales, services, and expenses list
        fetch('/api/shift/sales')
            .then(r => r.json())
            .then(sData => {
                if (sData.success) {
                    sessionSales = sData.sales || [];
                    sessionServices = sData.services || [];
                    sessionExpenses = sData.expenses || [];
                    if (sData.shift) activeShift = sData.shift;
                    renderSessionSales();
                }
            })
            .catch(err => console.error("Error loading shift sales:", err));
    } else {
        // Shift is closed
        if (badge) {
            badge.innerText = "Закрыта";
            badge.style.color = "#ff3d00";
            badge.style.background = "rgba(255, 61, 0, 0.12)";
            badge.style.borderColor = "rgba(255, 61, 0, 0.2)";
        }
        if (btn) {
            btn.innerText = "Открыть смену";
            btn.style.background = "linear-gradient(135deg, #1a73e8, #7c4dff)";
            btn.style.borderColor = "rgba(124, 77, 255, 0.25)";
        }
        
        sessionSales = [];
        sessionServices = [];
        sessionExpenses = [];
        renderSessionSales();
    }
}

function checkActiveShiftStatus() {
    fetch('/api/shift/active')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                preloadedActiveShift = data.shift;
                preloadedActiveShiftLoaded = true;
                updateShiftUI(data.shift);
            }
        })
        .catch(err => console.error("Error checking active shift status:", err));
}

function handleShiftActionClick() {
    if (!activeShift) {
        // Open Shift modal
        document.getElementById("shift-cash-start").value = "0";
        document.getElementById("modal-shift-open").classList.add("active");
    } else {
        // Close Shift: first fetch shift preview stats
        fetch('/api/shift/preview')
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    const startCashEl = document.getElementById("close-shift-start-cash");
                    const salesCashEl = document.getElementById("close-shift-sales-cash");
                    const srvCashEl = document.getElementById("close-shift-services-cash");
                    const expTotalEl = document.getElementById("close-shift-expenses-total");
                    const noncashEl = document.getElementById("close-shift-noncash-total");
                    const expectedCashEl = document.getElementById("close-shift-expected-cash");
                    
                    if (startCashEl) startCashEl.innerText = `${formatCurrency(data.cash_start)} сум`;
                    if (salesCashEl) salesCashEl.innerText = `${formatCurrency(data.cash_actual)} сум`;
                    if (srvCashEl) srvCashEl.innerText = `+${formatCurrency(data.services_cash || 0)} сум`;
                    if (expTotalEl) expTotalEl.innerText = `-${formatCurrency(data.expenses_total || 0)} сум`;
                    if (noncashEl) noncashEl.innerText = `${formatCurrency((data.card_actual || 0) + (data.transfer_actual || 0) + (data.services_card || 0) + (data.services_transfer || 0))} сум`;
                    if (expectedCashEl) expectedCashEl.innerText = `${formatCurrency(data.expected_cash)} сум`;
                    
                    document.getElementById("shift-cash-end").value = "";
                    document.getElementById("modal-shift-close").classList.add("active");
                } else {
                    alert(data.message || "Не удалось загрузить сводку для закрытия смены.");
                }
            })
            .catch(err => {
                console.error("Shift close preview error:", err);
                alert("Ошибка сети при подготовке закрытия смены.");
            });
    }
}

function submitShiftOpen(e) {
    e.preventDefault();
    const cash_start = parseFloat(document.getElementById("shift-cash-start").value) || 0.0;
    
    fetch('/api/shift/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cash_start: cash_start })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            document.getElementById("modal-shift-open").classList.remove("active");
            showToastMessage("Кассовая смена успешно открыта!");
            checkActiveShiftStatus();
        } else {
            alert(data.message);
        }
    })
    .catch(err => {
        console.error("Open shift error:", err);
        alert("Ошибка сети при открытии смены.");
    });
}

function submitShiftClose(e) {
    e.preventDefault();
    const cash_end = parseFloat(document.getElementById("shift-cash-end").value) || 0.0;
    
    fetch('/api/shift/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cash_end: cash_end })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            document.getElementById("modal-shift-close").classList.remove("active");
            checkActiveShiftStatus();
            
            const r = data.report || data || {};
            const shiftNum = r.shift_id || data.shift_id || "";
            alert(
                `Смена №${shiftNum} успешно закрыта!\n\n` +
                `Начальная касса: ${formatCurrency(r.cash_start || 0)} сум\n` +
                `Продажи товаров (Нал): ${formatCurrency(r.cash_actual || 0)} сум\n` +
                `Услуги (Нал): +${formatCurrency(r.services_cash || 0)} сум\n` +
                `Расходы из кассы: -${formatCurrency(r.expenses_total || 0)} сум\n` +
                `Безналичные оплаты: ${formatCurrency((r.card_actual || 0) + (r.transfer_actual || 0) + (r.services_card || 0) + (r.services_transfer || 0))} сум\n` +
                `Ожидалось наличных в кассе: ${formatCurrency(r.expected_cash || 0)} сум\n` +
                `Фактически сдано наличных: ${formatCurrency(r.cash_end || 0)} сум\n` +
                `Разница (излишек/недостача): ${formatCurrency(r.discrepancy || 0)} сум`
            );
            
            showToastMessage("Кассовая смена успешно закрыта!");
            if (typeof loadStats === 'function') loadStats();
        } else {
            alert(data.message || "Ошибка при закрытии смены");
            if (data.message && (data.message.includes("Нет активной") || data.message.includes("закрыта"))) {
                document.getElementById("modal-shift-close").classList.remove("active");
                checkActiveShiftStatus();
            }
        }
    })
    .catch(err => {
        console.error("Close shift error:", err);
        alert("Ошибка сети при закрытии смены.");
    });
}

function loadShiftsHistory() {
    fetch('/api/shifts')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                const tbody = document.getElementById("table-shifts-history-tbody");
                tbody.innerHTML = "";
                
                let sumRevenue = 0;
                let sumCash = 0;
                let sumCard = 0;
                let sumTransfer = 0;
                let sumNoncash = 0;
                
                if (data.shifts.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="13" style="text-align: center; color: var(--text-secondary); padding: 30px;">Кассовых смен еще не зарегистрировано.</td></tr>';
                    
                    if (document.getElementById("shifts-total-revenue")) document.getElementById("shifts-total-revenue").innerText = "0 сум";
                    if (document.getElementById("shifts-total-cash")) document.getElementById("shifts-total-cash").innerText = "0 сум";
                    if (document.getElementById("shifts-total-noncash")) document.getElementById("shifts-total-noncash").innerText = "0 сум";
                    if (document.getElementById("shifts-total-card")) document.getElementById("shifts-total-card").innerText = "0 сум";
                    if (document.getElementById("shifts-total-transfer")) document.getElementById("shifts-total-transfer").innerText = "0 сум";
                    return;
                }
                
                const fragment = document.createDocumentFragment();
                data.shifts.forEach(s => {
                    const tr = document.createElement("tr");
                    tr.style.cursor = "pointer";
                    tr.title = "Нажмите, чтобы посмотреть детали и проданные товары";
                    tr.addEventListener("click", () => viewShiftSalesDetails(s.id));
                    
                    const opened = s.opened_at ? s.opened_at.split('.')[0] : "—";
                    const closed = s.closed_at ? s.closed_at.split('.')[0] : "—";
                    
                    const srvCash = s.services_cash || 0;
                    const srvCard = s.services_card || 0;
                    const srvTransfer = s.services_transfer || 0;
                    const expTotal = s.expenses_total || 0;
                    
                    const cashVal = (s.cash_actual || 0) + srvCash;
                    const cardVal = (s.card_actual || 0) + srvCard;
                    const transferVal = (s.transfer_actual || 0) + srvTransfer;
                    const noncashVal = cardVal + transferVal;
                    const revenueVal = cashVal + noncashVal;
                    
                    sumRevenue += revenueVal;
                    sumCash += cashVal;
                    sumCard += cardVal;
                    sumTransfer += transferVal;
                    sumNoncash += noncashVal;
                    
                    const expected = s.cash_start + cashVal - expTotal;
                    const diff = (s.cash_end || 0) - expected;
                    
                    let diffStyle = "color: var(--text-secondary);";
                    let diffText = "0 сум";
                    if (s.status === 'closed') {
                        if (diff > 0) {
                            diffStyle = "color: var(--color-success); font-weight: bold;";
                            diffText = `+${formatCurrency(diff)} сум`;
                        } else if (diff < 0) {
                            diffStyle = "color: #ff3d00; font-weight: bold;";
                            diffText = `${formatCurrency(diff)} сум`;
                        }
                    } else {
                        diffText = "—";
                    }
                    
                    let statusBadge = "";
                    if (s.status === 'open') {
                        statusBadge = `<span style="background: rgba(0, 230, 118, 0.15); color: var(--color-success); padding: 3px 8px; border-radius: 6px; font-weight:bold; font-size:0.75rem; border: 1px solid rgba(0, 230, 118, 0.3);">Открыта</span>`;
                    } else {
                        statusBadge = `<span style="background: rgba(255,255,255,0.05); color: var(--text-secondary); padding: 3px 8px; border-radius: 6px; font-size:0.75rem; border: 1px solid var(--border-color);">Закрыта</span>`;
                    }
                    
                    tr.innerHTML = `
                        <td style="font-weight: 700; color: #00b0ff;">#${s.id}</td>
                        <td style="color: var(--text-secondary); font-size: 0.8rem;">${opened}</td>
                        <td style="color: var(--text-secondary); font-size: 0.8rem;">${closed}</td>
                        <td style="font-weight: 500;">${escapeHtml(s.opened_by || "—")}</td>
                        <td style="text-align: right; font-weight: 500;">${formatCurrency(s.cash_start)} сум</td>
                        <td style="text-align: right; color: #ffeb3b; font-weight: 600;">${formatCurrency(cashVal)} сум</td>
                        <td style="text-align: right; color: #00b0ff;">${formatCurrency(cardVal)} сум</td>
                        <td style="text-align: right; color: #b388ff;">${formatCurrency(transferVal)} сум</td>
                        <td style="text-align: right; color: #00e5ff; font-weight: 700;">${formatCurrency(noncashVal)} сум</td>
                        <td style="text-align: right; font-weight: 800; color: #00e676; font-size: 0.92rem;">${formatCurrency(revenueVal)} сум</td>
                        <td style="text-align: right; font-weight: 600; color: #fff;">${s.status === 'closed' ? formatCurrency(s.cash_end) + ' сум' : '—'}</td>
                        <td style="text-align: right; ${diffStyle}">${diffText}</td>
                        <td style="text-align: center;">${statusBadge}</td>
                    `;
                    fragment.appendChild(tr);
                });
                
                // Add summary footer row to the table
                const trSummary = document.createElement("tr");
                trSummary.style.borderTop = "2px solid var(--border-color)";
                trSummary.style.background = "rgba(255, 255, 255, 0.03)";
                trSummary.style.fontWeight = "bold";
                trSummary.innerHTML = `
                    <td colspan="5" style="font-weight: 800; color: #fff;">ИТОГО ПО ВСЕМ СМЕНАМ:</td>
                    <td style="text-align: right; color: #ffeb3b; font-weight: 800;">${formatCurrency(sumCash)} сум</td>
                    <td style="text-align: right; color: #00b0ff; font-weight: 800;">${formatCurrency(sumCard)} сум</td>
                    <td style="text-align: right; color: #b388ff; font-weight: 800;">${formatCurrency(sumTransfer)} сум</td>
                    <td style="text-align: right; color: #00e5ff; font-weight: 800;">${formatCurrency(sumNoncash)} сум</td>
                    <td style="text-align: right; color: #00e676; font-weight: 800; font-size: 1rem;">${formatCurrency(sumRevenue)} сум</td>
                    <td colspan="3" style="text-align: center; color: var(--text-secondary); font-size: 0.8rem;">(Наличные: ${formatCurrency(sumCash)} • Безнал: ${formatCurrency(sumNoncash)})</td>
                `;
                fragment.appendChild(trSummary);
                tbody.appendChild(fragment);
                
                // Update top summary cards
                if (document.getElementById("shifts-total-revenue")) document.getElementById("shifts-total-revenue").innerText = `${formatCurrency(sumRevenue)} сум`;
                if (document.getElementById("shifts-total-cash")) document.getElementById("shifts-total-cash").innerText = `${formatCurrency(sumCash)} сум`;
                if (document.getElementById("shifts-total-noncash")) document.getElementById("shifts-total-noncash").innerText = `${formatCurrency(sumNoncash)} сум`;
                if (document.getElementById("shifts-total-card")) document.getElementById("shifts-total-card").innerText = `${formatCurrency(sumCard)} сум`;
                if (document.getElementById("shifts-total-transfer")) document.getElementById("shifts-total-transfer").innerText = `${formatCurrency(sumTransfer)} сум`;
            }
        })
        .catch(err => console.error("Error loading shifts history:", err));
}

function loadCashiersList() {
    const listBody = document.getElementById("cashiers-list-body");
    if (!listBody) return;
    
    listBody.innerHTML = '<tr><td colspan="3" style="text-align:center;">Загрузка списка...</td></tr>';
    
    fetch('/api/cashiers')
        .then(res => res.json())
        .then(cashiers => {
            if (cashiers.length === 0) {
                listBody.innerHTML = '<tr><td colspan="3" style="text-align:center;">Нет зарегистрированных кассиров</td></tr>';
                return;
            }
            
            let html = '';
            cashiers.forEach(c => {
                const escapedName = c.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                const escapedEmail = c.email.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                html += `
                    <tr>
                        <td>${escapedName}</td>
                        <td>${escapedEmail}</td>
                        <td style="text-align: center;">
                            <button class="btn btn-secondary" onclick="deleteCashier(${c.id})" style="padding: 4px 8px; font-size: 0.75rem; background: var(--color-danger); border: none; color: white;">&times;</button>
                        </td>
                    </tr>
                `;
            });
            listBody.innerHTML = html;
        })
        .catch(err => {
            console.error("Error loading cashiers:", err);
            listBody.innerHTML = '<tr><td colspan="3" style="text-align:center; color: var(--color-danger);">Ошибка загрузки</td></tr>';
        });
}

function deleteCashier(id) {
    if (!confirm("Вы уверены, что хотите удалить этого кассира?")) return;
    
    fetch(`/api/cashiers/${id}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                showToastMessage("Кассир успешно удален!");
                loadCashiersList();
            } else {
                alert(data.message);
            }
        })
        .catch(err => {
            console.error("Error deleting cashier:", err);
            alert("Ошибка сети при удалении кассира.");
        });
}

function loadExpenses() {
    const listBody = document.getElementById("expenses-list-body");
    if (!listBody) return;
    
    listBody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Загрузка расходов...</td></tr>';
    
    fetch('/api/expenses')
        .then(res => res.json())
        .then(expenses => {
            if (expenses.length === 0) {
                listBody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Нет записанных расходов</td></tr>';
                return;
            }
            
            let html = '';
            expenses.forEach(e => {
                const dateStr = e.expense_date ? e.expense_date.split('.')[0] : '—';
                const escapedCategory = e.category.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                const escapedDesc = e.description ? e.description.replace(/</g, "&lt;").replace(/>/g, "&gt;") : '';
                html += `
                    <tr>
                        <td style="color: var(--text-secondary); font-size: 0.78rem;">${dateStr}</td>
                        <td style="font-weight: 600; color: #ff3d00;">${escapedCategory}</td>
                        <td style="text-align: right; font-weight: bold; color: #fff;">${formatCurrency(e.amount)} сум</td>
                        <td style="color: var(--text-secondary); font-size: 0.78rem;">${escapedDesc}</td>
                        <td style="text-align: center;">
                            <button class="btn btn-secondary" onclick="deleteExpense(${e.id})" style="padding: 4px 8px; font-size: 0.75rem; background: var(--color-danger); border: none; color: white;">&times;</button>
                        </td>
                    </tr>
                `;
            });
            listBody.innerHTML = html;
        })
        .catch(err => {
            console.error("Error loading expenses:", err);
            listBody.innerHTML = '<tr><td colspan="5" style="text-align:center; color: var(--color-danger);">Ошибка загрузки расходов</td></tr>';
        });
}

function deleteExpense(id) {
    if (!confirm("Вы уверены, что хотите удалить этот расход?")) return;
    
    fetch(`/api/expenses/${id}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                showToastMessage("Расход успешно удален!");
                loadExpenses();
                loadStats();
            } else {
                alert(data.message);
            }
        })
        .catch(err => {
            console.error("Error deleting expense:", err);
            alert("Ошибка сети при удалении расхода.");
        });
}

function loadPurchases() {
    const listBody = document.getElementById("purchases-list-body");
    const debtsBody = document.getElementById("supplier-debts-body");
    if (!listBody || !debtsBody) return;
    
    listBody.innerHTML = '<tr><td colspan="8" style="text-align:center;">Загрузка закупок...</td></tr>';
    debtsBody.innerHTML = '<tr><td colspan="2" style="text-align:center;">Загрузка долгов...</td></tr>';
    
    fetch('/api/purchases')
        .then(res => res.json())
        .then(purchases => {
            // Group debts by supplier
            const supplierDebts = {};
            
            if (purchases.length === 0) {
                listBody.innerHTML = '<tr><td colspan="8" style="text-align:center;">История закупок пуста</td></tr>';
                debtsBody.innerHTML = '<tr><td colspan="2" style="text-align:center;">Нет долгов перед поставщиками</td></tr>';
                return;
            }
            
            let html = '';
            purchases.forEach(p => {
                const dateStr = p.purchase_date ? p.purchase_date.split('.')[0] : '—';
                const total = p.quantity * p.purchase_price;
                const escapedPrdName = p.product_name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                const escapedSupplier = p.supplier.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                
                let statusBadge = '';
                let actionBtn = '';
                
                if (p.status === 'debt') {
                    statusBadge = '<span style="background: rgba(255, 61, 0, 0.15); color: #ff3d00; padding: 2px 6px; border-radius: 4px; font-weight:bold; font-size:0.7rem;">Долг</span>';
                    actionBtn = `<button class="btn btn-primary" onclick="payPurchaseDebt(${p.id})" style="padding: 4px 8px; font-size: 0.72rem; background: linear-gradient(135deg, #00c853, #64dd17); border: none; color: white;">Оплатить</button>`;
                    
                    // Accumulate supplier debt
                    supplierDebts[p.supplier] = (supplierDebts[p.supplier] || 0) + total;
                } else {
                    statusBadge = '<span style="background: rgba(0, 230, 118, 0.15); color: var(--color-success); padding: 2px 6px; border-radius: 4px; font-weight:bold; font-size:0.7rem;">Оплачено</span>';
                    actionBtn = '<span style="color: var(--text-secondary); font-size:0.75rem;">—</span>';
                }
                
                html += `
                    <tr>
                        <td style="color: var(--text-secondary); font-size: 0.78rem;">${dateStr}</td>
                        <td style="font-weight: 500; color: #fff;">${escapedPrdName}</td>
                        <td style="text-align: right;">${p.quantity} шт.</td>
                        <td style="text-align: right;">${formatCurrency(p.purchase_price)} сум</td>
                        <td style="text-align: right; font-weight: bold; color: #fff;">${formatCurrency(total)} сум</td>
                        <td>${escapedSupplier}</td>
                        <td style="text-align: center;">${statusBadge}</td>
                        <td style="text-align: center;">${actionBtn}</td>
                    </tr>
                `;
            });
            listBody.innerHTML = html;
            
            // Render supplier debts
            const debtKeys = Object.keys(supplierDebts);
            if (debtKeys.length === 0) {
                debtsBody.innerHTML = '<tr><td colspan="2" style="text-align:center; color: var(--color-success); font-weight: bold;">Нет активных долгов! 🎉</td></tr>';
            } else {
                let debtHtml = '';
                debtKeys.forEach(supplier => {
                    const escapedS = supplier.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                    debtHtml += `
                        <tr>
                            <td style="font-weight: 600; color: #fff;">${escapedS}</td>
                            <td style="text-align: right; font-weight: bold; color: #ff3d00;">${formatCurrency(supplierDebts[supplier])} сум</td>
                        </tr>
                    `;
                });
                debtsBody.innerHTML = debtHtml;
            }
        })
        .catch(err => {
            console.error("Error loading purchases:", err);
            listBody.innerHTML = '<tr><td colspan="8" style="text-align:center; color: var(--color-danger);">Ошибка загрузки закупок</td></tr>';
            debtsBody.innerHTML = '<tr><td colspan="2" style="text-align:center; color: var(--color-danger);">Ошибка загрузки долгов</td></tr>';
        });
}

function payPurchaseDebt(id) {
    if (!confirm("Вы уверены, что хотите отметить этот долг как оплаченный?")) return;
    
    fetch(`/api/purchases/${id}/pay`, { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                showToastMessage("Долг перед поставщиком закрыт!");
                loadPurchases();
                loadStats();
            } else {
                alert(data.message);
            }
        })
        .catch(err => {
            console.error("Error paying purchase debt:", err);
            alert("Ошибка сети при оплате долга.");
        });
}


function requestOwnerPassword(title, description) {
    return new Promise((resolve) => {
        const modal = document.getElementById("modal-owner-password-prompt");
        if (!modal) {
            const fallback = prompt((title ? title + "\n\n" : "") + (description || "Введите пароль владельца:"));
            resolve(fallback);
            return;
        }

        const titleEl = document.getElementById("owner-pwd-modal-title");
        const descEl = document.getElementById("owner-pwd-modal-desc");
        const inputEl = document.getElementById("owner-pwd-modal-input");
        const errorEl = document.getElementById("owner-pwd-modal-error");
        const btnSubmit = document.getElementById("btn-owner-pwd-modal-submit");
        const btnCancel = document.getElementById("btn-owner-pwd-modal-cancel");
        const btnClose = document.getElementById("btn-owner-pwd-modal-close");
        const btnToggle = document.getElementById("btn-toggle-owner-pwd-visibility");

        if (title && titleEl) titleEl.innerHTML = `<span>🔒 ${escapeHtml(title)}</span>`;
        if (description && descEl) descEl.innerHTML = escapeHtml(description).replace(/\n/g, '<br>');
        if (errorEl) { errorEl.style.display = 'none'; errorEl.innerText = ''; }
        if (inputEl) {
            inputEl.value = '';
            inputEl.type = 'password';
        }

        modal.classList.add("active");
        setTimeout(() => { if (inputEl) inputEl.focus(); }, 100);

        function cleanup() {
            modal.classList.remove("active");
            if (btnSubmit) btnSubmit.onclick = null;
            if (btnCancel) btnCancel.onclick = null;
            if (btnClose) btnClose.onclick = null;
            if (inputEl) inputEl.onkeydown = null;
            if (btnToggle) btnToggle.onclick = null;
        }

        if (btnToggle) {
            btnToggle.onclick = () => {
                inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
            };
        }

        if (btnSubmit) {
            btnSubmit.onclick = () => {
                const pwd = inputEl.value;
                if (!pwd || pwd.trim() === '') {
                    if (errorEl) {
                        errorEl.innerText = 'Введите пароль владельца!';
                        errorEl.style.display = 'block';
                    }
                    inputEl.focus();
                    return;
                }
                cleanup();
                resolve(pwd);
            };
        }

        if (btnCancel) btnCancel.onclick = () => { cleanup(); resolve(null); };
        if (btnClose) btnClose.onclick = () => { cleanup(); resolve(null); };

        if (inputEl) {
            inputEl.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    if (btnSubmit) btnSubmit.click();
                } else if (e.key === 'Escape') {
                    if (btnCancel) btnCancel.click();
                }
            };
        }
    });
}

async function refundSale(id) {
    let saleName = "товара";
    if (typeof periodData !== 'undefined' && periodData && periodData.sales) {
        const s = periodData.sales.find(item => item.id === id);
        if (s && s.product_name) {
            saleName = `"${s.product_name}" (${s.quantity} шт.)`;
        }
    }
    
    let pwd = "";
    if (!isLoggedIn) {
        pwd = await requestOwnerPassword("Оформление возврата товара", `Оформление возврата ${saleName} требует пароля владельца.\nВведите пароль для подтверждения:`);
        if (pwd === null) return;
        if (pwd.trim() === "") {
            alert("Пароль владельца обязателен для оформления возврата!");
            return;
        }
    } else {
        if (!confirm(`Вы действительно хотите оформить возврат ${saleName}?\n\nТовар будет возвращен на склад, а запись о продаже удалена.`)) {
            return;
        }
    }
    
    fetch(`/api/sales/${id}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToastMessage(data.message);
            loadStats();
            loadProducts();
            loadShiftStatus();
        } else {
            alert("Ошибка: " + data.message);
        }
    })
    .catch(err => {
        console.error("Refund error:", err);
        alert("Ошибка сети при оформлении возврата.");
    });
}

async function refundSaleFromSession(id) {
    const sale = typeof sessionSales !== 'undefined' && sessionSales ? sessionSales.find(s => s.id === id) : null;
    const name = sale ? sale.product_name : "Товар";
    const qty = sale ? ` (${sale.quantity} шт.)` : "";
    
    let pwd = "";
    if (!isLoggedIn) {
        pwd = await requestOwnerPassword("Возврат товара за смену", `Вы действительно хотите оформить возврат товара "${name}"${qty}?\nЭто действие вернет товар на склад и спишет сумму с кассы смены.\n\nВведите пароль владельца:`);
        if (pwd === null) return;
        if (pwd.trim() === "") {
            alert("Пароль владельца обязателен для оформления возврата!");
            return;
        }
    } else {
        if (!confirm(`Вы действительно хотите оформить возврат товара "${name}"${qty}?\n\nЭто действие вернет товар на склад и спишет сумму с кассы смены.`)) {
            return;
        }
    }
    
    fetch(`/api/sales/${id}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToastMessage(data.message);
            loadShiftStatus();
            loadProducts();
            loadStats();
        } else {
            alert("Ошибка: " + data.message);
        }
    })
    .catch(err => {
        console.error("Refund error:", err);
        alert("Ошибка сети при оформлении возврата.");
    });
}


function viewShiftSalesDetails(shiftId) {
    const titleEl = document.getElementById("shift-sales-detail-title");
    if (titleEl) titleEl.innerText = `Проданные товары за смену №${shiftId}`;
    
    const tbody = document.getElementById("shift-sales-detail-tbody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-secondary); padding: 30px;">Загрузка списка продаж...</td></tr>';
    
    const modal = document.getElementById("modal-shift-sales-detail");
    if (modal) modal.classList.add("active");
    
    fetch(`/api/shifts/${shiftId}/sales`)
        .then(res => res.json())
        .then(data => {
            if (!data.success) {
                alert("Ошибка при загрузке продаж: " + data.message);
                if (modal) modal.classList.remove("active");
                return;
            }
            
            if (tbody) {
                tbody.innerHTML = "";
                
                let totalQty = 0;
                let totalSum = 0;
                let cashSum = 0;
                let cardSum = 0;
                let transferSum = 0;
                
                if (data.sales && data.sales.length > 0) {
                    data.sales.forEach(sale => {
                        const tr = document.createElement("tr");
                        
                        const discount = sale.discount_percent > 0 ? `${sale.discount_percent}%` : "—";
                        const payment = sale.payment_method === 'cash' ? 'Наличные' : 
                                        (sale.payment_method === 'card' ? 'Карта' : 'Перевод');
                                        
                        const time = sale.sold_at ? sale.sold_at : "—";
                        const subtotal = sale.price_final * sale.quantity;
                        
                        totalQty += sale.quantity;
                        totalSum += subtotal;
                        
                        if (sale.payment_method === 'cash') {
                            cashSum += subtotal;
                        } else if (sale.payment_method === 'card') {
                            cardSum += subtotal;
                        } else if (sale.payment_method === 'transfer') {
                            transferSum += subtotal;
                        }
                        
                        tr.innerHTML = `
                            <td style="font-weight: 500; color: #00b0ff; cursor: pointer; text-decoration: underline;" onclick="openProductHistoryCard(${sale.product_id})">${escapeHtml(sale.product_name)}</td>
                            <td style="text-align: right; color: var(--text-secondary);">${formatCurrency(sale.price_original)} сум</td>
                            <td style="text-align: center; color: var(--text-secondary);">${discount}</td>
                            <td style="text-align: right; font-weight: 500;">${formatCurrency(sale.price_final)} сум</td>
                            <td style="text-align: center;">${sale.quantity} шт.</td>
                            <td style="text-align: right; font-weight: 600; color: #fff;">${formatCurrency(subtotal)} сум</td>
                            <td style="text-align: center; font-size: 0.85rem; color: ${sale.payment_method === 'cash' ? '#ffeb3b' : (sale.payment_method === 'card' ? '#00b0ff' : '#b388ff')}; font-weight: 600;">${payment}</td>
                            <td style="color: var(--text-secondary); font-size: 0.85rem;">${time}</td>
                        `;
                        tbody.appendChild(tr);
                    });
                } else {
                    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-secondary); padding: 30px;">В этой смене продаж товаров не было.</td></tr>';
                }
                
                // Services and expenses totals
                let srvTotal = 0;
                let srvCash = 0;
                let srvCard = 0;
                let srvTransfer = 0;
                if (data.services && data.services.length > 0) {
                    data.services.forEach(srv => {
                        const amt = srv.amount || 0;
                        srvTotal += amt;
                        if (srv.payment_method === 'cash') srvCash += amt;
                        else if (srv.payment_method === 'card') srvCard += amt;
                        else if (srv.payment_method === 'transfer') srvTransfer += amt;
                    });
                }
                
                let expTotal = 0;
                if (data.expenses && data.expenses.length > 0) {
                    data.expenses.forEach(exp => {
                        expTotal += (exp.amount || 0);
                    });
                }
                
                const noncashSum = cardSum + transferSum;
                
                // Populate summary elements
                if (document.getElementById("shift-sales-summary-qty")) {
                    document.getElementById("shift-sales-summary-qty").innerText = `${totalQty} шт.`;
                }
                if (document.getElementById("shift-sales-summary-total")) {
                    document.getElementById("shift-sales-summary-total").innerText = `${formatCurrency(totalSum)} сум`;
                }
                if (document.getElementById("shift-sales-summary-cash")) {
                    document.getElementById("shift-sales-summary-cash").innerText = `${formatCurrency(cashSum)} сум`;
                }
                if (document.getElementById("shift-sales-summary-noncash")) {
                    document.getElementById("shift-sales-summary-noncash").innerText = `${formatCurrency(noncashSum)} сум`;
                }
                if (document.getElementById("shift-sales-summary-card")) {
                    document.getElementById("shift-sales-summary-card").innerText = `${formatCurrency(cardSum)} сум`;
                }
                if (document.getElementById("shift-sales-summary-transfer")) {
                    document.getElementById("shift-sales-summary-transfer").innerText = `${formatCurrency(transferSum)} сум`;
                }
                
                // Extra services and expenses banner
                const extraBox = document.getElementById("shift-sales-summary-extra");
                const srvBox = document.getElementById("shift-sales-summary-services-box");
                const expBox = document.getElementById("shift-sales-summary-expenses-box");
                
                if (srvTotal > 0 || expTotal > 0) {
                    if (extraBox) extraBox.style.display = "grid";
                    if (srvBox) {
                        srvBox.style.display = srvTotal > 0 ? "block" : "none";
                        const srvEl = document.getElementById("shift-sales-summary-services");
                        if (srvEl) srvEl.innerText = `+${formatCurrency(srvTotal)} сум (Нал: ${formatCurrency(srvCash)}, Безнал: ${formatCurrency(srvCard + srvTransfer)})`;
                    }
                    if (expBox) {
                        expBox.style.display = expTotal > 0 ? "block" : "none";
                        const expEl = document.getElementById("shift-sales-summary-expenses");
                        if (expEl) expEl.innerText = `-${formatCurrency(expTotal)} сум`;
                    }
                } else {
                    if (extraBox) extraBox.style.display = "none";
                }
            }
        })
        .catch(err => {
            console.error("Error loading shift sales:", err);
            alert("Ошибка сети при загрузке продаж за смену.");
            if (modal) modal.classList.remove("active");
        });
}


function openEditSaleModal(id, prodName, qty, discount, paymentMethod) {
    if (!prodName && typeof periodData !== 'undefined' && periodData && periodData.sales) {
        const s = periodData.sales.find(item => item.id === id);
        if (s) {
            prodName = s.product_name;
            qty = s.quantity;
            discount = s.discount_percent;
            paymentMethod = s.payment_method;
        }
    }
    document.getElementById("edit-sale-id").value = id;
    document.getElementById("edit-sale-prod-name").innerText = prodName || "";
    document.getElementById("edit-sale-qty").value = qty !== undefined ? qty : 1;
    document.getElementById("edit-sale-discount").value = discount !== undefined ? discount : 0;
    document.getElementById("edit-sale-payment").value = paymentMethod || "cash";
    
    document.getElementById("modal-edit-sale").classList.add("active");
}

function submitEditSale(event) {
    event.preventDefault();
    
    const id = document.getElementById("edit-sale-id").value;
    const qty = document.getElementById("edit-sale-qty").value;
    const discount = document.getElementById("edit-sale-discount").value;
    const payment = document.getElementById("edit-sale-payment").value;
    
    fetch(`/api/sales/${id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quantity: qty,
            discount_percent: discount,
            payment_method: payment
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToastMessage(data.message);
            document.getElementById("modal-edit-sale").classList.remove("active");
            loadStats();
            loadProducts();
            loadShiftStatus();
        } else {
            alert("Ошибка: " + data.message);
        }
    })
    .catch(err => {
        console.error("Error editing sale:", err);
        alert("Ошибка сети при изменении параметров продажи.");
    });
}


function searchStockForCashier() {
    const query = document.getElementById("cashier-stock-search-input").value.toLowerCase().trim();
    const resultsContainer = document.getElementById("cashier-stock-search-results");
    if (!resultsContainer) return;
    
    if (query === "") {
        resultsContainer.innerHTML = `
            <div style="text-align: center; padding: 25px; color: var(--text-secondary); font-size: 0.85rem;">
                Введите запрос для поиска остатков...
            </div>
        `;
        return;
    }
    
    // Filter results from the globally cached products list using correct schema fields
    const results = (productsCache || []).filter(p => {
        const name = (p.name || "").toLowerCase();
        const barcode = (p.barcode || "").toLowerCase();
        const product_type = (p.type || "").toLowerCase(); // Fixed: type instead of product_type
        const brand = (p.brand || "").toLowerCase();
        const model = (p.model || "").toLowerCase();
        const suffix = (p.unique_suffix || "").toLowerCase(); // Fixed: unique_suffix instead of suffix
        const spec = (p.further_spec || "").toLowerCase();
        const note = (p.note || "").toLowerCase();
        const supplier = (p.supplier || "").toLowerCase();
        
        return name.includes(query) || 
               barcode.includes(query) || 
               product_type.includes(query) || 
               brand.includes(query) || 
               model.includes(query) || 
               suffix.includes(query) || 
               spec.includes(query) || 
               note.includes(query) || 
               supplier.includes(query);
    });
    
    resultsContainer.innerHTML = "";
    
    if (results.length === 0) {
        resultsContainer.innerHTML = `
            <div style="text-align: center; padding: 25px; color: var(--text-secondary); font-size: 0.85rem;">
                Ничего не найдено
            </div>
        `;
        return;
    }
    
    // Display up to 30 matching rows as info-rich cards
    const limit = results.slice(0, 30);
    limit.forEach(p => {
        const item = document.createElement("div");
        item.style.padding = "12px";
        item.style.borderBottom = "1px solid var(--border-color)";
        item.style.display = "flex";
        item.style.flexDirection = "column";
        item.style.gap = "6px";
        
        const titleParts = [p.type, p.brand, p.model].filter(x => x && x.trim() !== ""); // Fixed: type instead of product_type
        const title = titleParts.join(" ") || p.name || "Без названия";
        
        // Detailed specifications
        const details = [];
        if (p.unique_suffix && p.unique_suffix.trim() !== "") { // Fixed: unique_suffix instead of suffix
            details.push(`<b>Доп:</b> ${escapeHtml(p.unique_suffix)}`);
        }
        if (p.further_spec && p.further_spec.trim() !== "") {
            details.push(`<b>Характ:</b> ${escapeHtml(p.further_spec)}`);
        }
        if (p.note && p.note.trim() !== "") {
            details.push(`<b>Прим:</b> ${escapeHtml(p.note)}`);
        }
        if (p.supplier && p.supplier.trim() !== "") {
            details.push(`<b>Поставщик:</b> ${escapeHtml(p.supplier)}`);
        }
        
        let detailsHtml = "";
        if (details.length > 0) {
            detailsHtml = `<div style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.4;">${details.join(" | ")}</div>`;
        }
        
        const stockColor = p.stock > 0 ? "#00e676" : "#ff3d00";
        const stockBackground = p.stock > 0 ? "rgba(0, 230, 118, 0.12)" : "rgba(255, 61, 0, 0.12)";
        
        item.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: start; gap: 10px;">
                <span style="font-weight: 600; color: #fff; font-size: 0.92rem; line-height: 1.3;">${escapeHtml(title)}</span>
                <span style="background: ${stockBackground}; color: ${stockColor}; padding: 2px 8px; border-radius: 6px; font-weight: bold; font-size: 0.82rem; white-space: nowrap;">
                    ${p.stock} шт.
                </span>
            </div>
            ${detailsHtml}
            <div style="font-size: 0.78rem; color: var(--text-secondary); display: flex; justify-content: space-between;">
                <span>Штрих-код: <span style="font-family: monospace; color: #00b0ff; font-weight: 500;">${p.barcode}</span></span>
            </div>
        `;
        resultsContainer.appendChild(item);
    });
}

function runAiWarehouseAudit() {
    const btn = document.querySelector('button[onclick="runAiWarehouseAudit()"]');
    let originalText = "Запустить AI-Анализ";
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Анализирую...";
    }
    
    fetch('/api/ai/analyze')
        .then(res => res.json())
        .then(data => {
            if (btn) {
                btn.disabled = false;
                btn.innerText = originalText;
            }
            
            if (!data.success) {
                alert("Ошибка анализа: " + data.message);
                return;
            }
            
            // Populate metrics
            document.getElementById("ai-val-cost").innerText = `${formatCurrency(data.val_cost)} сум`;
            document.getElementById("ai-val-retail").innerText = `${formatCurrency(data.val_retail)} сум`;
            document.getElementById("ai-shortage-count").innerText = `${data.shortage_count} шт.`;
            document.getElementById("ai-dead-valuation").innerText = `${formatCurrency(data.dead_valuation)} сум`;
            
            // Populate procurement
            const procContainer = document.getElementById("ai-procurement-list");
            procContainer.innerHTML = "";
            if (data.procurement.length === 0) {
                procContainer.innerHTML = '<div style="color: var(--text-secondary); text-align: center; padding: 15px;">Закупки не требуются</div>';
            } else {
                data.procurement.forEach(item => {
                    const row = document.createElement("div");
                    row.style.padding = "8px 0";
                    row.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
                    row.style.display = "flex";
                    row.style.justifyContent = "space-between";
                    row.innerHTML = `
                        <span style="color: #fff; font-weight: 500;">${escapeHtml(item.name)}</span>
                        <span style="color: #ff1744; font-weight: 600;">остаток ${item.stock} шт. (реком. +${item.recommend} шт.)</span>
                    `;
                    procContainer.appendChild(row);
                });
            }
            
            // Populate dead stock
            const deadContainer = document.getElementById("ai-dead-list");
            deadContainer.innerHTML = "";
            if (data.dead_stock.length === 0) {
                deadContainer.innerHTML = '<div style="color: var(--text-secondary); text-align: center; padding: 15px;">Неликвидных товаров не обнаружено</div>';
            } else {
                data.dead_stock.forEach(item => {
                    const row = document.createElement("div");
                    row.style.padding = "8px 0";
                    row.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
                    row.style.display = "flex";
                    row.style.justifyContent = "space-between";
                    row.innerHTML = `
                        <span style="color: #fff; font-weight: 500;">${escapeHtml(item.name)}</span>
                        <span style="color: #ffc107; font-weight: 600;">в наличии ${item.stock} шт. (заморожено ${formatCurrency(item.cost_price * item.stock)} сум)</span>
                    `;
                    deadContainer.appendChild(row);
                });
            }
            
            // Load insights comments
            document.getElementById("ai-insights-text").innerHTML = data.insights.replace(/\n/g, "<br>");
            
            // Open results section
            document.getElementById("ai-audit-results").style.display = "block";
            showToastMessage("AI-Анализ склада завершен успешно!");
        })
        .catch(err => {
            console.error("AI analysis error:", err);
            alert("Ошибка сети при проведении AI-анализа.");
            if (btn) {
                btn.disabled = false;
                btn.innerText = originalText;
            }
        });
}

function submitAiChat(event) {
    event.preventDefault();
    const input = document.getElementById("ai-chat-input");
    const queryText = input.value.trim();
    if (queryText === "") return;
    
    const responseBox = document.getElementById("ai-chat-response");
    responseBox.style.display = "block";
    responseBox.innerText = "ИИ думает...";
    
    fetch('/api/ai/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: queryText })
    })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                responseBox.innerText = data.speech;
                input.value = "";
            } else {
                responseBox.innerText = "Ошибка: " + data.message;
            }
        })
        .catch(err => {
            console.error("AI chat error:", err);
            responseBox.innerText = "Ошибка соединения при запросе к ИИ.";
        });
}


function addCustomerWish() {
    const input = document.getElementById("cashier-wish-input");
    if (!input) return;
    
    const name = input.value.trim();
    if (!name) {
        alert("Введите название отсутствующего аксессуара!");
        return;
    }
    
    fetch('/api/wishes', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ item_name: name })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToastMessage("Пожелание клиента успешно записано!");
            input.value = "";
        } else {
            alert("Ошибка при сохранении: " + data.message);
        }
    })
    .catch(err => {
        console.error("Error saving wish:", err);
        alert("Ошибка сети при отправке пожелания.");
    });
}

function loadWishes() {
    const tbody = document.getElementById("wishes-table-tbody");
    if (!tbody) return;
    
    fetch('/api/wishes')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                tbody.innerHTML = "";
                
                if (data.wishes.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 20px;">Пожеланий еще не зарегистрировано.</td></tr>';
                    return;
                }
                
                data.wishes.forEach(w => {
                    const tr = document.createElement("tr");
                    
                    const timeStr = w.requested_at ? w.requested_at.split('.')[0] : "—";
                    
                    tr.innerHTML = `
                        <td style="font-weight: 500; color: #fff;">${escapeHtml(w.item_name)}</td>
                        <td>${escapeHtml(w.cashier_name)}</td>
                        <td style="color: var(--text-secondary); font-size: 0.85rem;">${timeStr}</td>
                        <td style="text-align: center;">
                            <button class="action-icon-btn btn-delete-prd" onclick="deleteWish(${w.id})" title="Удалить пожелание" style="background: rgba(255, 61, 0, 0.1); color: #ff3d00; border: 1px solid rgba(255, 61, 0, 0.3); padding: 6px 10px; font-size: 0.75rem; border-radius: 8px; cursor: pointer; height: fit-content; margin-top: 0;">
                                Удалить
                            </button>
                        </td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        })
        .catch(err => console.error("Error loading wishes:", err));
}

function deleteWish(wishId) {
    if (!confirm("Вы уверены, что хотите удалить это пожелание?")) {
        return;
    }
    
    fetch(`/api/wishes/${wishId}`, {
        method: 'DELETE'
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            loadWishes();
        } else {
            alert("Ошибка при удалении: " + data.message);
        }
    })
    .catch(err => {
        console.error("Error deleting wish:", err);
        alert("Ошибка сети при удалении пожелания.");
    });
}


function handleProductFormResetAndPreserve() {
    // 1. Capture check states
    const keepType = document.getElementById("keep-prd-type")?.checked;
    const keepBrand = document.getElementById("keep-prd-brand")?.checked;
    const keepSuffix = document.getElementById("keep-prd-suffix")?.checked;
    const keepPrice = document.getElementById("keep-prd-price")?.checked;
    const keepCost = document.getElementById("keep-prd-cost")?.checked;
    
    // 2. Capture values
    const savedType = document.getElementById("new-prd-type")?.value || "";
    const savedBrand = document.getElementById("new-prd-brand")?.value || "";
    const savedSuffix = document.getElementById("new-prd-suffix")?.value || "";
    const savedPrice = document.getElementById("new-prd-price")?.value || "";
    const savedCost = document.getElementById("new-prd-cost")?.value || "";
    
    // 3. Reset form
    document.getElementById("form-add-product").reset();
    
    // 4. Restore values
    if (keepType) {
        document.getElementById("new-prd-type").value = savedType;
        document.getElementById("keep-prd-type").checked = true;
    }
    if (keepBrand) {
        document.getElementById("new-prd-brand").value = savedBrand;
        document.getElementById("keep-prd-brand").checked = true;
    }
    if (keepSuffix) {
        document.getElementById("new-prd-suffix").value = savedSuffix;
        document.getElementById("keep-prd-suffix").checked = true;
    }
    if (keepPrice) {
        document.getElementById("new-prd-price").value = savedPrice;
        document.getElementById("keep-prd-price").checked = true;
    }
    if (keepCost) {
        document.getElementById("new-prd-cost").value = savedCost;
        document.getElementById("keep-prd-cost").checked = true;
    }
}


function updateSelectionUI() {
    // 1. Highlight rows based on selectedProductIds
    document.querySelectorAll(".product-row").forEach(row => {
        const prdId = parseInt(row.dataset.productId);
        const chk = row.querySelector(".product-select-checkbox");
        if (selectedProductIds.has(prdId)) {
            row.classList.add("selected-row");
            if (chk) chk.checked = true;
        } else {
            row.classList.remove("selected-row");
            if (chk) chk.checked = false;
        }
    });

    // 2. Update group checkboxes state
    document.querySelectorAll(".group-header-row").forEach(header => {
        const groupKey = header.dataset.groupKey;
        const groupItems = groupsCache[groupKey]?.items || [];
        const chk = header.querySelector(".group-select-checkbox");
        if (chk && groupItems.length > 0) {
            const allSelected = groupItems.every(p => selectedProductIds.has(p.id));
            const someSelected = groupItems.some(p => selectedProductIds.has(p.id));
            chk.checked = allSelected;
            chk.indeterminate = someSelected && !allSelected;
        }
    });

    // 3. Update global select all checkbox state
    const bulkSelectAll = document.getElementById("bulk-select-all");
    if (bulkSelectAll && visibleProductsCache.length > 0) {
        const allSelected = visibleProductsCache.every(p => selectedProductIds.has(p.id));
        const someSelected = visibleProductsCache.some(p => selectedProductIds.has(p.id));
        bulkSelectAll.checked = allSelected;
        bulkSelectAll.indeterminate = someSelected && !allSelected;
    }

    // 4. Show/hide bulk actions toolbar
    const toolbar = document.getElementById("bulk-actions-toolbar");
    const countText = document.getElementById("bulk-selected-count");
    if (toolbar && countText) {
        if (selectedProductIds.size > 0) {
            toolbar.style.display = "flex";
            countText.innerText = `Выбрано: ${selectedProductIds.size} товаров`;
        } else {
            toolbar.style.display = "none";
        }
    }
}

function clearBulkSelection() {
    selectedProductIds.clear();
    updateSelectionUI();
}

async function triggerBulkPrint() {
    if (selectedProductIds.size === 0) return;
    const copiesStr = prompt("Введите количество копий этикеток для каждого выбранного товара:", "1");
    if (copiesStr === null) return;
    const copies = Math.max(1, parseInt(copiesStr) || 1);
    
    const ids = Array.from(selectedProductIds);
    let successCount = 0;
    
    showToastMessage("Отправка групповой печати...");
    
    for (const id of ids) {
        const prod = productsCache.find(p => p.id === id);
        if (!prod) continue;
        
        try {
            const res = await fetch('/api/print', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    barcode: prod.barcode,
                    name: prod.name,
                    price: prod.price,
                    count: copies
                })
            });
            const data = await res.json();
            if (data.success) {
                successCount++;
            }
        } catch (err) {
            console.error("Bulk print error for product ID " + id, err);
        }
    }
    
    showToastMessage(`Печать отправлена: успешно ${successCount} из ${ids.length} товаров!`);
    selectedProductIds.clear();
    updateSelectionUI();
}

async function triggerBulkRestock() {
    if (selectedProductIds.size === 0) return;
    const qtyStr = prompt(`Введите количество для прихода к выбранным ${selectedProductIds.size} товарам:`);
    if (qtyStr === null) return;
    const qty = parseInt(qtyStr);
    if (isNaN(qty) || qty <= 0) {
        alert("Некорректное количество!");
        return;
    }
    
    const costStr = prompt("Введите себестоимость (оставьте пустым или 0, чтобы использовать текущую себестоимость каждого товара):");
    if (costStr === null) return;
    const cost = parseFloat(costStr) || 0.0;
    
    const supplier = prompt("Введите имя поставщика (необязательно):") || "";
    
    const ids = Array.from(selectedProductIds);
    let successCount = 0;
    
    showToastMessage("Пополнение выбранных товаров...");
    
    for (const id of ids) {
        const prod = productsCache.find(p => p.id === id);
        if (!prod) continue;
        
        const finalCost = cost > 0 ? cost : (prod.cost_price || 0.0);
        
        try {
            const res = await fetch(`/api/products/${id}/restock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quantity: qty,
                    purchase_price: finalCost,
                    supplier: supplier,
                    status: 'paid'
                })
            });
            const data = await res.json();
            if (data.success) {
                successCount++;
            }
        } catch (err) {
            console.error("Bulk restock error for product ID " + id, err);
        }
    }
    
    showToastMessage(`Приход оформлен: успешно ${successCount} из ${ids.length} товаров!`);
    selectedProductIds.clear();
    loadProducts();
}

async function triggerBulkDelete() {
    if (selectedProductIds.size === 0) return;
    if (!confirm(`Вы действительно хотите удалить выбранные ${selectedProductIds.size} товаров? Это действие полностью сотрет их со склада!`)) {
        return;
    }
    
    const ids = Array.from(selectedProductIds);
    let successCount = 0;
    
    showToastMessage("Удаление выбранных товаров...");
    
    for (const id of ids) {
        try {
            const res = await fetch(`/api/products/${id}`, {
                method: 'DELETE'
            });
            const data = await res.json();
            if (data.success) {
                successCount++;
            }
        } catch (err) {
            console.error("Bulk delete error for product ID " + id, err);
        }
    }
    
    showToastMessage(`Удалено: успешно ${successCount} из ${ids.length} товаров!`);
    selectedProductIds.clear();
    loadProducts();
}


// Alias to map missing loadShiftStatus calls to checkActiveShiftStatus
function loadShiftStatus() {
    if (typeof checkActiveShiftStatus === 'function') {
        checkActiveShiftStatus();
    }
}


// --- Inventory Reconciliation (Audit) Functions ---

function populateAuditFilters() {
    document.getElementById("audit-filter-type").value = "";
    document.getElementById("audit-filter-brand").value = "";
    document.getElementById("audit-filter-model").value = "";
    document.getElementById("audit-filter-suffix").value = "";
    document.getElementById("audit-filter-further-spec").value = "";
    document.getElementById("audit-filter-note").value = "";
    document.getElementById("audit-filter-price").value = "";
    document.getElementById("audit-filter-supplier").value = "";
    
    // Update datalists specifically for filters context
    updateDynamicDatalistsForAudit();
}

function updateDynamicDatalistsForAudit() {
    const dlTypes = document.getElementById("datalist-filter-types");
    const dlBrands = document.getElementById("datalist-filter-brands");
    const dlModels = document.getElementById("datalist-filter-models");
    const dlSuffixes = document.getElementById("datalist-filter-suffixes");
    const dlFurtherSpecs = document.getElementById("datalist-filter-further-specs");
    const dlNotes = document.getElementById("datalist-filter-notes");
    const dlPrices = document.getElementById("datalist-filter-prices");
    const dlSuppliers = document.getElementById("datalist-filter-suppliers");
    
    const types = new Set();
    const brands = new Set();
    const models = new Set();
    const suffixes = new Set();
    const furtherSpecs = new Set();
    const notes = new Set();
    const prices = new Set();
    const suppliers = new Set();
    
    (productsCache || []).forEach(p => {
        if (p.type) types.add(p.type);
        if (p.brand) brands.add(p.brand);
        if (p.model) models.add(p.model);
        if (p.unique_suffix) suffixes.add(p.unique_suffix);
        if (p.further_spec) furtherSpecs.add(p.further_spec);
        if (p.note) notes.add(p.note);
        if (p.price) prices.add(p.price.toString());
        if (p.supplier) suppliers.add(p.supplier);
    });
    
    const fillDl = (dl, set) => {
        if (dl) {
            dl.innerHTML = "";
            Array.from(set).sort().forEach(val => {
                const opt = document.createElement("option");
                opt.value = val;
                dl.appendChild(opt);
            });
        }
    };
    
    fillDl(dlTypes, types);
    fillDl(dlBrands, brands);
    fillDl(dlModels, models);
    fillDl(dlSuffixes, suffixes);
    fillDl(dlFurtherSpecs, furtherSpecs);
    fillDl(dlNotes, notes);
    fillDl(dlPrices, prices);
    fillDl(dlSuppliers, suppliers);
}

function startAuditSession() {
    const filterType = (document.getElementById("audit-filter-type").value || "").trim().toLowerCase();
    const filterBrand = (document.getElementById("audit-filter-brand").value || "").trim().toLowerCase();
    const filterModel = (document.getElementById("audit-filter-model").value || "").trim().toLowerCase();
    const filterSuffix = (document.getElementById("audit-filter-suffix").value || "").trim().toLowerCase();
    const filterFurtherSpec = (document.getElementById("audit-filter-further-spec").value || "").trim().toLowerCase();
    const filterNote = (document.getElementById("audit-filter-note").value || "").trim().toLowerCase();
    const filterPrice = (document.getElementById("audit-filter-price").value || "").trim();
    const filterSupplier = (document.getElementById("audit-filter-supplier").value || "").trim().toLowerCase();
    
    const filtered = productsCache.filter(p => {
        const rowType = (p.type || "").toLowerCase();
        const rowBrand = (p.brand || "").toLowerCase();
        const rowModel = (p.model || "").toLowerCase();
        const rowSuffix = (p.unique_suffix || "").toLowerCase();
        const rowFurtherSpec = (p.further_spec || "").toLowerCase();
        const rowNote = (p.note || "").toLowerCase();
        const rowPrice = p.price || "";
        const rowSupplier = (p.supplier || "").toLowerCase();
        
        const matchesType = !filterType || rowType === filterType;
        const matchesBrand = !filterBrand || rowBrand === filterBrand;
        const matchesModel = !filterModel || rowModel === filterModel;
        const matchesSuffix = !filterSuffix || rowSuffix === filterSuffix;
        const matchesFurtherSpec = !filterFurtherSpec || rowFurtherSpec === filterFurtherSpec;
        const matchesNote = !filterNote || rowNote === filterNote;
        const matchesPrice = !filterPrice || Number(rowPrice) === Number(filterPrice);
        const matchesSupplier = !filterSupplier || rowSupplier === filterSupplier;
        
        return matchesType && matchesBrand && matchesModel && matchesSuffix && matchesFurtherSpec && matchesNote && matchesPrice && matchesSupplier;
    });
    
    if (filtered.length === 0) {
        alert("Нет товаров, соответствующих выбранным критериям!");
        return;
    }
    
    auditProducts = filtered.map(p => ({
        id: p.id,
        name: p.name,
        barcode: p.barcode,
        stock: p.stock || 0,
        actual: 0
    }));
    
    auditSessionActive = true;
    
    document.getElementById("audit-scan-box").style.display = "block";
    document.getElementById("btn-apply-audit").style.display = "block";
    
    const scanInp = document.getElementById("audit-scan-input");
    if (scanInp) {
        scanInp.value = "";
        setTimeout(() => scanInp.focus(), 100);
    }
    
    renderAuditTable();
}

function resetAuditSession() {
    auditProducts = [];
    auditSessionActive = false;
    
    // Reset filters
    document.getElementById("audit-filter-type").value = "";
    document.getElementById("audit-filter-brand").value = "";
    document.getElementById("audit-filter-model").value = "";
    document.getElementById("audit-filter-suffix").value = "";
    document.getElementById("audit-filter-further-spec").value = "";
    document.getElementById("audit-filter-note").value = "";
    document.getElementById("audit-filter-price").value = "";
    document.getElementById("audit-filter-supplier").value = "";
    
    document.getElementById("audit-scan-box").style.display = "none";
    document.getElementById("btn-apply-audit").style.display = "none";
    
    const msgEl = document.getElementById("audit-scan-message");
    if (msgEl) {
        msgEl.style.display = "none";
        msgEl.innerText = "";
    }
    
    const tbody = document.getElementById("audit-table-tbody");
    if (tbody) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 40px 0;">Выберите группу товаров и нажмите «Начать сверку»</td></tr>';
    }
}

function renderAuditTable() {
    const tbody = document.getElementById("audit-table-tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    
    auditProducts.forEach((p) => {
        const tr = document.createElement("tr");
        tr.id = `audit-row-${p.id}`;
        
        const diff = p.actual - p.stock;
        let diffHtml = "";
        if (diff === 0) {
            diffHtml = '<span style="color: #00e676; font-weight: bold;">0 (ОК)</span>';
        } else if (diff > 0) {
            diffHtml = `<span style="color: #ffeb3b; font-weight: bold;">+${diff} (Лишнее)</span>`;
        } else {
            diffHtml = `<span style="color: #ff3d00; font-weight: bold;">${diff} (Не хватает)</span>`;
        }
        
        tr.innerHTML = `
            <td><span style="font-weight: 500; color: #fff;">${escapeHtml(p.name)}</span></td>
            <td style="color: var(--text-secondary); font-family: monospace;">${p.barcode}</td>
            <td style="text-align: center; font-weight: 500;">${p.stock}</td>
            <td style="text-align: center; font-weight: 600; color: #00b0ff;" id="audit-actual-${p.id}">${p.actual}</td>
            <td style="text-align: center;">${diffHtml}</td>
        `;
        tbody.appendChild(tr);
    });
}

function handleAuditScan(barcode) {
    const barcodeClean = barcode.trim().toLowerCase();
    let item = auditProducts.find(p => p.barcode.trim().toLowerCase() === barcodeClean);
    const msgEl = document.getElementById("audit-scan-message");
    
    if (item) {
        item.actual += 1;
        playScanBeep();
        renderAuditTable();
        
        const row = document.getElementById(`audit-row-${item.id}`);
        if (row) {
            row.style.background = "rgba(0, 230, 118, 0.15)";
            row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            setTimeout(() => {
                row.style.background = "";
            }, 800);
        }
        
        if (msgEl) {
            msgEl.style.display = "block";
            msgEl.style.background = "rgba(0, 230, 118, 0.15)";
            msgEl.style.color = "#00e676";
            msgEl.innerText = `Успешно: ${item.name} (${item.actual} шт.)`;
        }
    } else {
        // Search in general warehouse database
        let prod = productsCache.find(p => p.barcode.trim().toLowerCase() === barcodeClean);
        if (prod) {
            const newAuditItem = {
                id: prod.id,
                name: prod.name,
                barcode: prod.barcode,
                stock: prod.stock || 0,
                actual: 1
            };
            auditProducts.unshift(newAuditItem);
            playSuccessBeep();
            renderAuditTable();
            
            const row = document.getElementById(`audit-row-${prod.id}`);
            if (row) {
                row.style.background = "rgba(255, 235, 59, 0.15)";
                row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                setTimeout(() => {
                    row.style.background = "";
                }, 800);
            }
            
            if (msgEl) {
                msgEl.style.display = "block";
                msgEl.style.background = "rgba(255, 235, 59, 0.15)";
                msgEl.style.color = "#ffeb3b";
                msgEl.innerText = `Вне группы: ${prod.name} добавлен (1 шт.)`;
            }
        } else {
            playErrorBuzz();
            if (msgEl) {
                msgEl.style.display = "block";
                msgEl.style.background = "rgba(255, 61, 0, 0.15)";
                msgEl.style.color = "#ff3d00";
                msgEl.innerText = `Ошибка: штрихкод "${barcode}" не найден на складе!`;
            }
        }
    }
}

function applyAuditResults() {
    if (!auditProducts || auditProducts.length === 0) {
        alert("Нет данных для записи сверки!");
        return;
    }
    
    // Find discrepancies
    const mismatches = auditProducts.filter(p => p.actual !== p.stock);
    if (mismatches.length === 0) {
        alert("Расхождений не обнаружено! Все фактические остатки совпадают с учетными остатками склада.");
        resetAuditSession();
        return;
    }
    
    const confirmMsg = `Обнаружено ${mismatches.length} расхождений. Записать их в список несоответствий?\n\n(Количество на складе при этом изменено НЕ будет)`;
    if (!confirm(confirmMsg)) {
        return;
    }
    
    const payload = {
        adjustments: mismatches.map(p => ({ id: p.id, expected: p.stock, actual: p.actual }))
    };
    
    fetch('/api/audit/save-mismatches', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToastMessage(data.message);
            resetAuditSession();
            loadProducts();
            loadDiscrepancies();
        } else {
            alert("Ошибка при сохранении: " + data.message);
        }
    })
    .catch(err => {
        alert("Сетевая ошибка при отправке расхождений: " + err.message);
    });
}

function loadDiscrepancies() {
    const tbody = document.getElementById("discrepancies-table-tbody");
    if (!tbody) return;
    
    fetch('/api/discrepancies')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                tbody.innerHTML = "";
                
                if (data.discrepancies.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-secondary); padding: 30px;">Список несоответствий пуст.</td></tr>';
                    return;
                }
                
                data.discrepancies.forEach(d => {
                    const tr = document.createElement("tr");
                    
                    const diff = d.difference;
                    let diffHtml = "";
                    if (diff > 0) {
                        diffHtml = `<span style="color: #ffeb3b; font-weight: bold;">+${diff} (Лишнее)</span>`;
                    } else {
                        diffHtml = `<span style="color: #ff3d00; font-weight: bold;">${diff} (Не хватает)</span>`;
                    }
                    
                    const dateStr = d.created_at ? d.created_at.split('.')[0] : "—";
                    
                    tr.innerHTML = `
                        <td><span style="font-weight: 500; color: #fff;">${escapeHtml(d.product_name)}</span></td>
                        <td style="color: var(--text-secondary); font-family: monospace;">${d.product_barcode}</td>
                        <td style="text-align: center;">${d.expected_stock}</td>
                        <td style="text-align: center; font-weight: 500; color: #00b0ff;">${d.actual_stock}</td>
                        <td style="text-align: center;">${diffHtml}</td>
                        <td style="color: var(--text-secondary); font-size: 0.85rem;">${dateStr}</td>
                        <td style="text-align: center; display: flex; gap: 8px; justify-content: center; align-items: center;">
                            <button class="btn btn-primary" onclick="applyDiscrepancy(${d.id})" style="padding: 6px 12px; font-size: 0.75rem; border-radius: 6px; margin: 0; background: linear-gradient(135deg, #00e676, #00b0ff); color: #000; font-weight: bold; cursor: pointer; height: fit-content;">
                                Применить к складу
                            </button>
                            <button class="action-icon-btn btn-delete-prd" onclick="deleteDiscrepancy(${d.id})" title="Удалить из списка" style="background: rgba(255, 61, 0, 0.1); color: #ff3d00; border: 1px solid rgba(255, 61, 0, 0.3); padding: 6px 12px; font-size: 0.75rem; border-radius: 6px; cursor: pointer; height: fit-content; margin-top: 0;">
                                Удалить
                            </button>
                        </td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        })
        .catch(err => console.error("Error loading discrepancies:", err));
}

async function applyDiscrepancy(discId) {
    const password = await requestOwnerPassword("Корректировка остатков", "Введите пароль владельца для подтверждения изменения остатков:");
    if (password === null) return;
    if (!password.trim()) {
        alert("Пароль не может быть пустым!");
        return;
    }
    
    fetch(`/api/discrepancies/${discId}/apply`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password: password.trim() })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToastMessage(data.message);
            loadDiscrepancies();
            loadProducts();
        } else {
            alert("Ошибка: " + data.message);
        }
    })
    .catch(err => {
        console.error("Error applying discrepancy:", err);
        alert("Ошибка сети при изменении остатка.");
    });
}

function deleteDiscrepancy(discId) {
    if (!confirm("Удалить это расхождение из списка без изменения остатков на складе?")) {
        return;
    }
    
    fetch(`/api/discrepancies/${discId}`, {
        method: 'DELETE'
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            showToastMessage(data.message);
            loadDiscrepancies();
        } else {
            alert("Ошибка при удалении: " + data.message);
        }
    })
    .catch(err => {
        console.error("Error deleting discrepancy:", err);
        alert("Ошибка сети при удалении расхождения.");
    });
}

function openProductHistoryCard(productId) {
    if (!productId) return;
    
    const modal = document.getElementById("modal-product-history");
    if (modal) modal.classList.add("active");
    
    const tbody = document.getElementById("product-history-tbody");
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-secondary); padding: 30px;">Загрузка истории товара...</td></tr>';
    
    document.getElementById("hist-card-name").innerText = "—";
    document.getElementById("hist-card-barcode").innerText = "—";
    document.getElementById("hist-card-type").innerText = "—";
    document.getElementById("hist-card-model").innerText = "—";
    document.getElementById("hist-card-stock").innerText = "—";
    document.getElementById("hist-card-cost").innerText = "—";
    document.getElementById("hist-card-price").innerText = "—";
    document.getElementById("hist-card-supplier").innerText = "—";

    fetch(`/api/products/${productId}/history`)
        .then(res => res.json())
        .then(data => {
            if (!data.success) {
                alert("Ошибка загрузки истории: " + data.message);
                if (modal) modal.classList.remove("active");
                return;
            }
            
            const p = data.product;
            document.getElementById("hist-card-name").innerText = p.name || "—";
            document.getElementById("hist-card-barcode").innerText = p.barcode || "—";
            document.getElementById("hist-card-type").innerText = p.type || "—";
            document.getElementById("hist-card-model").innerText = `${p.brand || ''} ${p.model || ''}`.trim() || "—";
            document.getElementById("hist-card-stock").innerText = `${p.stock || 0} шт.`;
            document.getElementById("hist-card-cost").innerText = `${formatCurrency(p.cost_price || 0.0)} сум`;
            document.getElementById("hist-card-price").innerText = `${formatCurrency(p.price || 0.0)} сум`;
            document.getElementById("hist-card-supplier").innerText = p.supplier || "—";
            
            if (tbody) {
                tbody.innerHTML = "";
                if (data.history.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-secondary); padding: 30px;">История пуста.</td></tr>';
                    return;
                }
                
                data.history.forEach(ev => {
                    const tr = document.createElement("tr");
                    
                    let eventIcon = "";
                    if (ev.type === "creation") {
                        eventIcon = "🆕";
                    } else if (ev.type === "purchase") {
                        eventIcon = "📥";
                    } else if (ev.type === "sale") {
                        eventIcon = "💸";
                    } else if (ev.type === "write_off") {
                        eventIcon = "🗑️";
                    }
                    
                    tr.innerHTML = `
                        <td style="color: var(--text-secondary); font-size: 0.85rem; font-weight: 500;">${formatEventDate(ev.date)}</td>
                        <td><strong>${eventIcon} ${ev.title}</strong></td>
                        <td style="color: #e0e0e0;">${ev.details}</td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        })
        .catch(err => {
            console.error("Error loading product history:", err);
            alert("Ошибка сети при загрузке истории товара.");
            if (modal) modal.classList.remove("active");
        });
}

function formatEventDate(dateStr) {
    if (!dateStr) return "—";
    const date = new Date(dateStr.replace(" ", "T"));
    if (isNaN(date.getTime())) return dateStr;
    
    const daysOfWeek = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
    const dayName = daysOfWeek[date.getDay()];
    
    const formatted = date.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    
    return `${dayName}, ${formatted}`;
}

window.isKeyPHeld = false;
window.addEventListener('keydown', (e) => {
    if (e.key === 'p' || e.key === 'P' || e.code === 'KeyP') {
        window.isKeyPHeld = true;
    }
});
window.addEventListener('keyup', (e) => {
    if (e.key === 'p' || e.key === 'P' || e.code === 'KeyP') {
        window.isKeyPHeld = false;
    }
});
window.addEventListener('blur', () => {
    window.isKeyPHeld = false;
});

/* =========================================================================
   SMART INVENTORY PROCUREMENT, LOW-STOCK & HEATMAP MATRIX MODULE
   ========================================================================= */

// --- Procurement State ---
let currentProcurementItems = [];
let currentProcurementRawMap = new Map(); // id -> raw recommended_qty
let currentProcurementKPI = null;
let currentProcurementUrgency = 'all_procurement';
let currentProcurementSupplier = 'all';
let currentProcurementCategory = 'all';
let currentProcurementBrand = 'all';
let currentProcurementModel = 'all';
let currentProcurementSuffix = 'all';
let currentProcurementSearch = '';
let currentProcurementDays = 30;
let currentProcSelectedIds = new Set();
let currentPrintDocFormat = 'a4'; // 'a4' | 'receipt'

// --- Case Matrix State ---
let currentCaseMatrixRaw = null;
let currentCaseBarMode = 'stacked';
let caseNestedDonutChartInstance = null;
let caseStackedBarChartInstance = null;
let currentCaseDays = 30;
let currentCaseBrand = 'all';
let currentCaseCategory = 'all';
let currentCaseModel = 'all';
let currentCaseStatusFilter = 'all';
let currentCaseSearchQuery = '';

// =========================================================================
// 1. SMART PROCUREMENT & LOW-STOCK REGISTRY
// =========================================================================

async function loadProcurementAnalytics() {
    const tbodyLeft = document.getElementById('procurement-tbody-left');
    const tbodyRight = document.getElementById('procurement-tbody-right');
    if (tbodyLeft) {
        tbodyLeft.innerHTML = `
            <tr>
                <td colspan="9" class="text-center py-4 text-muted">
                    <div class="spinner-border text-primary mb-2" role="status"></div>
                    <div>Расчет дефицита, остатков и рекомендаций к закупу...</div>
                </td>
            </tr>
        `;
    }
    if (tbodyRight) tbodyRight.innerHTML = '';

    try {
        const url = `/api/analytics/procurement-list?days=${currentProcurementDays}&category=${encodeURIComponent(currentProcurementCategory)}&brand=${encodeURIComponent(currentProcurementBrand)}&model=${encodeURIComponent(currentProcurementModel)}&suffix=${encodeURIComponent(currentProcurementSuffix)}&supplier=${encodeURIComponent(currentProcurementSupplier)}&urgency=${encodeURIComponent(currentProcurementUrgency)}&search=${encodeURIComponent(currentProcurementSearch)}`;
        const res = await fetch(url);
        const data = await res.json();

        if (!data.success) {
            if (tbodyLeft) tbodyLeft.innerHTML = `<tr><td colspan="9" class="text-center text-danger py-3">${data.message || 'Ошибка загрузки данных'}</td></tr>`;
            return;
        }

        currentProcurementItems = data.items || [];
        currentProcurementKPI = data.kpi || {};
        currentProcPage = 1; // Reset to Page 1
        
        // Cache original algorithm recommendations
        currentProcurementRawMap.clear();
        currentProcurementItems.forEach(i => {
            currentProcurementRawMap.set(i.id, i.recommended_qty);
        });

        // Default all items to selected for convenience
        currentProcSelectedIds.clear();
        currentProcurementItems.forEach(i => currentProcSelectedIds.add(i.id));

        // 1. Update KPI Summary Badges & Cards Active State
        updateProcurementKPIDisplay();

        // 2. Populate Supplier Filter dropdown
        const suppSelect = document.getElementById('proc-filter-supplier');
        if (suppSelect && data.suppliers && suppSelect.options.length <= 1) {
            suppSelect.innerHTML = '<option value="all">🏢 Все поставщики</option>';
            data.suppliers.forEach(s => {
                if (s !== 'all' && s.trim()) {
                    const opt = document.createElement('option');
                    opt.value = s;
                    opt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
                    suppSelect.appendChild(opt);
                }
            });
            suppSelect.value = currentProcurementSupplier;
        }

        // 3. Populate Category Filter dropdown
        const catSelect = document.getElementById('proc-filter-category');
        if (catSelect && data.categories && catSelect.options.length <= 1) {
            catSelect.innerHTML = '<option value="all">📁 Все категории</option>';
            data.categories.forEach(c => {
                if (c !== 'all' && c.trim()) {
                    const opt = document.createElement('option');
                    opt.value = c;
                    opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
                    catSelect.appendChild(opt);
                }
            });
            catSelect.value = currentProcurementCategory;
        }

        // 4. Populate Brand Filter dropdown
        const brandSelect = document.getElementById('proc-filter-brand');
        if (brandSelect && data.brands && brandSelect.options.length <= 1) {
            brandSelect.innerHTML = '<option value="all">🏷️ Все бренды</option>';
            data.brands.forEach(b => {
                if (b !== 'all' && b.trim()) {
                    const opt = document.createElement('option');
                    opt.value = b;
                    opt.textContent = b.toUpperCase();
                    brandSelect.appendChild(opt);
                }
            });
            brandSelect.value = currentProcurementBrand;
        }

        // 5. Populate Dynamic Cascading Model Filter dropdown
        const modelSelect = document.getElementById('proc-filter-model');
        if (modelSelect && data.models) {
            const savedModel = currentProcurementModel;
            modelSelect.innerHTML = '<option value="all">📱 Все модели</option>';
            data.models.forEach(m => {
                if (m !== 'all' && m.trim()) {
                    const opt = document.createElement('option');
                    opt.value = m;
                    opt.textContent = m;
                    modelSelect.appendChild(opt);
                }
            });
            if (Array.from(modelSelect.options).some(o => o.value === savedModel)) {
                modelSelect.value = savedModel;
            } else {
                currentProcurementModel = 'all';
                modelSelect.value = 'all';
            }
        }

        // 6. Populate Dynamic Cascading Unique Suffix (Variation) Filter dropdown
        const suffixSelect = document.getElementById('proc-filter-suffix');
        if (suffixSelect && data.suffixes) {
            const savedSuffix = currentProcurementSuffix;
            suffixSelect.innerHTML = '<option value="all">✨ Все названия</option>';
            data.suffixes.forEach(s => {
                if (s !== 'all' && s.trim()) {
                    const opt = document.createElement('option');
                    opt.value = s;
                    opt.textContent = `✨ ${s}`;
                    suffixSelect.appendChild(opt);
                }
            });
            if (Array.from(suffixSelect.options).some(o => o.value === savedSuffix)) {
                suffixSelect.value = savedSuffix;
            } else {
                currentProcurementSuffix = 'all';
                suffixSelect.value = 'all';
            }
        }

        // 7. Render Table
        renderProcurementTable();

    } catch (err) {
        console.error('Error in loadProcurementAnalytics:', err);
        if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="text-center text-danger py-3">Сетевая ошибка при загрузке закупа</td></tr>`;
    }
}

function updateProcurementKPIDisplay() {
    const kpiOut = document.getElementById('proc-kpi-out');
    const kpiCrit = document.getElementById('proc-kpi-crit');
    const kpiUnits = document.getElementById('proc-kpi-units');
    const kpiBudget = document.getElementById('proc-kpi-budget');
    const kpiMarginSub = document.getElementById('proc-kpi-margin-sub');

    let activeUnits = 0;
    let activeBudget = 0;
    let activeRetail = 0;
    let countOut = 0;
    let countCrit = 0;

    currentProcurementItems.forEach(item => {
        if (item.stock === 0) countOut++;
        else if (item.stock <= 2) countCrit++;

        if (currentProcSelectedIds.has(item.id)) {
            activeUnits += (item.recommended_qty || 0);
            activeBudget += (item.estimated_cost || 0);
            activeRetail += ((item.recommended_qty || 0) * (item.price || 0));
        }
    });

    const activeMargin = Math.max(0, activeRetail - activeBudget);
    const activeMarginPct = activeRetail > 0 ? Math.round((activeMargin / activeRetail) * 100) : 0;

    if (kpiOut) kpiOut.textContent = `${countOut} поз.`;
    if (kpiCrit) kpiCrit.textContent = `${countCrit} поз.`;
    if (kpiUnits) kpiUnits.textContent = `${activeUnits.toLocaleString()} шт`;
    if (kpiBudget) kpiBudget.textContent = `${Math.round(activeBudget).toLocaleString()} сум`;
    if (kpiMarginSub) {
        kpiMarginSub.textContent = `Ожид. прибыль: +${Math.round(activeMargin).toLocaleString()} сум (+${activeMarginPct}%)`;
    }

    // Sync active border/glow on KPI cards
    document.querySelectorAll('.proc-kpi-card').forEach(card => {
        const urgency = card.getAttribute('data-urgency');
        if (urgency === currentProcurementUrgency) {
            card.classList.add('active');
            card.style.transform = 'scale(1.02)';
            if (urgency === 'out_of_stock') {
                card.style.borderColor = '#ef4444';
                card.style.boxShadow = '0 0 12px rgba(239, 68, 68, 0.3)';
            } else if (urgency === 'critical') {
                card.style.borderColor = '#f59e0b';
                card.style.boxShadow = '0 0 12px rgba(245, 158, 11, 0.3)';
            } else if (urgency === 'all_procurement') {
                card.style.borderColor = '#00e676';
                card.style.boxShadow = '0 0 12px rgba(0, 230, 118, 0.3)';
            } else {
                card.style.borderColor = '#00b0ff';
                card.style.boxShadow = '0 0 12px rgba(0, 176, 255, 0.3)';
            }
        } else {
            card.classList.remove('active');
            card.style.transform = 'scale(1.0)';
            card.style.boxShadow = 'none';
            if (urgency === 'out_of_stock') card.style.borderColor = 'rgba(220, 38, 38, 0.35)';
            else if (urgency === 'critical') card.style.borderColor = 'rgba(245, 158, 11, 0.35)';
            else if (urgency === 'all_procurement') card.style.borderColor = 'rgba(0, 230, 118, 0.35)';
            else card.style.borderColor = 'rgba(0, 176, 255, 0.35)';
        }
    });
}

// Mass batch packaging rounding
function roundProcurementQuantities(multiple = 10) {
    if (!currentProcurementItems || currentProcurementItems.length === 0) return;

    let modifiedCount = 0;
    currentProcurementItems.forEach(item => {
        if (currentProcSelectedIds.has(item.id) && item.recommended_qty > 0) {
            const rounded = Math.ceil(item.recommended_qty / multiple) * multiple;
            if (rounded !== item.recommended_qty) {
                item.recommended_qty = rounded;
                item.estimated_cost = item.recommended_qty * (item.effective_cost || 0);
                item.estimated_retail = item.recommended_qty * (item.price || 0);
                modifiedCount++;
            }
        }
    });

    renderProcurementTable();
    updateProcurementKPIDisplay();
    showNotification(`📦 Округлено ${modifiedCount} позиций до кратности ${multiple} шт.`);
}

function resetProcurementQuantities() {
    if (!currentProcurementItems || currentProcurementItems.length === 0) return;

    currentProcurementItems.forEach(item => {
        const orig = currentProcurementRawMap.get(item.id);
        if (orig !== undefined) {
            item.recommended_qty = orig;
            item.estimated_cost = item.recommended_qty * (item.effective_cost || 0);
            item.estimated_retail = item.recommended_qty * (item.price || 0);
        }
    });

    renderProcurementTable();
    updateProcurementKPIDisplay();
    showNotification('↩️ Количества сброшены к точному расчету алгоритма');
}

let currentProcPage = 1; // Current page in single-table mode
let currentProcPageSize = 50; // Default 50 rows per page

function changeProcPage(delta) {
    const totalItems = currentProcurementItems ? currentProcurementItems.length : 0;
    if (totalItems === 0) return;
    const totalPages = Math.max(1, Math.ceil(totalItems / currentProcPageSize));
    
    const newPage = currentProcPage + delta;
    if (newPage >= 1 && newPage <= totalPages) {
        currentProcPage = newPage;
        renderProcurementTable();
    }
}

function setProcPage(pageNum) {
    currentProcPage = pageNum;
    renderProcurementTable();
}

function changeProcPageSize(newSize) {
    currentProcPageSize = parseInt(newSize) || 50;
    currentProcPage = 1;
    renderProcurementTable();
}

function buildProcurementRowsHtml(itemsList, startIndex = 0) {
    if (!itemsList || itemsList.length === 0) {
        return `<tr><td colspan="12" class="text-center py-5 text-muted">Нет позиций</td></tr>`;
    }
    let rowsHtml = '';
    itemsList.forEach((item, idx) => {
        const globalRowIdx = startIndex + idx + 1;
        const isChecked = currentProcSelectedIds.has(item.id);

        // Stock Badge
        let stockBadge = '';
        if (item.stock === 0) {
            stockBadge = `<span class="badge bg-danger text-white px-2" style="font-weight: 800; font-size: 0.76rem; padding: 2px 5px;">0 шт</span>`;
        } else if (item.stock <= 2) {
            stockBadge = `<span class="badge bg-warning text-dark px-2" style="font-weight: 800; font-size: 0.76rem; padding: 2px 5px;">${item.stock} шт</span>`;
        } else if (item.stock <= 5) {
            stockBadge = `<span class="badge bg-info text-dark px-2" style="font-weight: 700; font-size: 0.76rem; padding: 2px 5px;">${item.stock} шт</span>`;
        } else {
            stockBadge = `<span class="badge bg-success text-white px-2" style="font-weight: 700; font-size: 0.76rem; padding: 2px 5px;">${item.stock} шт</span>`;
        }

        // Days left indicator
        let daysLeftHtml = '';
        if (item.days_left === 0 || item.stock === 0) {
            daysLeftHtml = `<span style="color: #ef4444; font-weight: 800;">0 дн.</span>`;
        } else if (item.days_left <= 3) {
            daysLeftHtml = `<span style="color: #f59e0b; font-weight: 800;">${item.days_left} дн.</span>`;
        } else if (item.days_left >= 999) {
            daysLeftHtml = `<span style="color: #94a3b8;">&infin;</span>`;
        } else {
            daysLeftHtml = `<span style="color: #00e676; font-weight: 700;">${item.days_left} дн.</span>`;
        }

        // ABC Class Badge
        let abcBadge = '';
        if (item.abc_class === 'A') {
            abcBadge = `<span class="badge bg-success-lt" title="Группа А: Хит продаж (80% выручки магазина)" style="font-size: 0.68rem; font-weight: 800; padding: 2px 4px; margin-right: 4px;">A</span>`;
        } else if (item.abc_class === 'B') {
            abcBadge = `<span class="badge bg-blue-lt" title="Группа B: Стабильный спрос (15% выручки)" style="font-size: 0.68rem; font-weight: 700; padding: 2px 4px; margin-right: 4px;">B</span>`;
        } else {
            abcBadge = `<span class="badge bg-secondary-lt" title="Группа C: Редкие продажи" style="font-size: 0.68rem; font-weight: 600; padding: 2px 4px; margin-right: 4px;">C</span>`;
        }

        // Suffix & Barcode
        const barcodeStr = item.barcode ? `Арт: <span style="font-family: monospace; color: #94a3b8;">${escapeHtml(item.barcode)}</span>` : '';
        const suffixStr = item.unique_suffix ? ` • <span style="color: #a78bfa; font-weight: 700;">${escapeHtml(item.unique_suffix)}</span>` : '';

        // Row Opacity & Background
        const isZeroRec = (item.recommended_qty === 0);
        const rowOpacity = isZeroRec ? 'opacity: 0.48;' : 'opacity: 1;';
        const rowBgStyle = item.stock === 0 ? 'background: rgba(220, 38, 38, 0.05);' : (item.stock <= 2 ? 'background: rgba(245, 158, 11, 0.03);' : '');

        // Margin Display
        const marginColor = (item.margin_pct >= 50) ? '#00e676' : ((item.margin_pct >= 25) ? '#38bdf8' : '#cbd5e1');

        rowsHtml += `
            <tr style="${rowBgStyle} ${rowOpacity} transition: opacity 0.15s ease; height: 34px;" class="proc-table-row" onmouseenter="this.style.opacity='1'" onmouseleave="if(${isZeroRec}) this.style.opacity='0.48'">
                <td style="text-align: center; vertical-align: middle; padding: 3px 4px;">
                    <input type="checkbox" class="proc-item-checkbox" data-id="${item.id}" ${isChecked ? 'checked' : ''} style="cursor: pointer; width: 14px; height: 14px; vertical-align: middle;">
                </td>
                <td style="text-align: center; vertical-align: middle; padding: 3px 4px; font-size: 0.74rem; color: #64748b; font-weight: 700;">
                    ${globalRowIdx}.
                </td>
                <td style="vertical-align: middle; padding: 3px 8px;">
                    <div class="d-flex align-items-center" style="gap: 4px;">
                        ${abcBadge}
                        <span style="font-weight: 700; color: #ffffff; font-size: 0.84rem; cursor: pointer;" onclick="openProductHistoryCard(${item.id})" title="${escapeHtml(item.name)}">
                            ${escapeHtml(item.name)}
                        </span>
                        <span class="text-muted" style="font-size: 0.72rem; margin-left: 4px;">
                            ${barcodeStr}${suffixStr}
                        </span>
                    </div>
                </td>
                <td style="text-align: center; vertical-align: middle; padding: 3px 4px; font-size: 0.76rem; color: #cbd5e1;">
                    <span class="badge bg-dark text-white border" style="font-weight: 600; font-size: 0.70rem;">${escapeHtml((item.brand || '').toUpperCase())} ${escapeHtml(item.type || '')}</span>
                </td>
                <td style="text-align: center; vertical-align: middle; padding: 3px 4px; font-size: 0.76rem; color: #94a3b8;">
                    ${escapeHtml(item.supplier || '—')}
                </td>
                <td style="text-align: center; vertical-align: middle; padding: 3px 4px;">
                    ${stockBadge}
                </td>
                <td style="text-align: center; font-weight: 700; color: #00e676; vertical-align: middle; padding: 3px 4px; font-size: 0.82rem;">
                    ${item.sold_qty} шт
                </td>
                <td style="text-align: center; font-size: 0.78rem; vertical-align: middle; padding: 3px 4px;">
                    ${daysLeftHtml}
                </td>
                <td style="text-align: right; vertical-align: middle; padding: 3px 8px; line-height: 1.15;">
                    <div style="font-weight: 700; color: #ffffff; font-size: 0.82rem;">
                        ${formatCurrency(item.effective_cost)} сум
                    </div>
                    <div style="font-size: 0.70rem; color: #94a3b8;">
                        Розн: ${formatCurrency(item.price)} • <span style="color: ${marginColor}; font-weight: 700;">+${item.margin_pct}%</span>
                    </div>
                </td>
                <td style="text-align: center; background: rgba(0, 230, 118, 0.04); vertical-align: middle; padding: 3px 4px;">
                    <input type="number" min="0" max="9999" class="form-control form-control-sm text-center proc-qty-input" data-id="${item.id}" value="${item.recommended_qty}" title="${escapeHtml(item.calc_formula || '')}" style="width: 58px; height: 26px; margin: 0 auto; font-weight: 800; font-size: 0.90rem; color: #00e676; background: #0f172a; border: 1.5px solid rgba(0, 230, 118, 0.4); border-radius: 5px; padding: 1px 2px;">
                </td>
                <td style="text-align: right; font-weight: 800; color: #00b0ff; background: rgba(0, 176, 255, 0.04); vertical-align: middle; padding: 3px 8px; font-size: 0.84rem;">
                    <span id="proc-row-cost-${item.id}">${formatCurrency(item.estimated_cost)}</span> сум
                </td>
                <td style="text-align: center; vertical-align: middle; padding: 3px 4px;">
                    <button class="btn btn-sm btn-outline-success" onclick="restockProduct(${item.id}, '${escapeHtml(item.name).replace(/'/g, "\\'")}')" title="Быстро оприходовать" style="padding: 1px 6px; font-size: 0.72rem; height: 24px; line-height: 1; border-radius: 5px;">
                        ➕
                    </button>
                </td>
            </tr>
        `;
    });
    return rowsHtml;
}

function renderProcurementTable() {
    const tbody = document.getElementById('procurement-tbody-left');
    const pageInfo = document.getElementById('proc-page-info');
    const quickBtns = document.getElementById('proc-page-quick-btns');
    const totalCounter = document.getElementById('proc-total-sku-counter');
    const btnPrev = document.getElementById('btn-proc-prev-page');
    const btnNext = document.getElementById('btn-proc-next-page');

    if (!tbody) return;

    const totalItems = currentProcurementItems ? currentProcurementItems.length : 0;
    if (totalCounter) totalCounter.textContent = `Всего: ${totalItems} поз.`;

    if (totalItems === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="12" class="text-center py-5 text-muted">
                    <div style="font-size: 2.2rem; margin-bottom: 8px;">🎉</div>
                    <div style="font-size: 1.05rem; font-weight: 600; color: #fff;">Все товары в достаточном количестве!</div>
                    <div style="font-size: 0.85rem; color: #8f9bb3; margin-top: 4px;">Нет активного дефицита или позиций, требующих закупки.</div>
                </td>
            </tr>
        `;
        if (pageInfo) pageInfo.textContent = 'Страница 1 из 1';
        if (quickBtns) quickBtns.innerHTML = '';
        if (btnPrev) btnPrev.disabled = true;
        if (btnNext) btnNext.disabled = true;
        return;
    }

    const totalPages = Math.max(1, Math.ceil(totalItems / currentProcPageSize));
    if (currentProcPage > totalPages) currentProcPage = totalPages;
    if (currentProcPage < 1) currentProcPage = 1;

    const startIdx = (currentProcPage - 1) * currentProcPageSize;
    const endIdx = Math.min(totalItems, startIdx + currentProcPageSize);
    const pageItems = currentProcurementItems.slice(startIdx, endIdx);

    tbody.innerHTML = buildProcurementRowsHtml(pageItems, startIdx);

    if (pageInfo) pageInfo.textContent = `Страница ${currentProcPage} из ${totalPages} (поз. ${startIdx + 1}–${endIdx})`;

    if (quickBtns) {
        let btnsHtml = '';
        let startPage = Math.max(1, currentProcPage - 4);
        let endPage = Math.min(totalPages, startPage + 8);
        if (endPage - startPage < 8) {
            startPage = Math.max(1, endPage - 8);
        }

        if (startPage > 1) {
            btnsHtml += `<button class="btn btn-sm btn-outline-secondary text-white" onclick="setProcPage(1)" style="padding: 1px 7px; font-size: 0.75rem; font-weight: 700; border-radius: 5px;">1</button><span class="text-muted" style="font-size: 0.7rem;">..</span>`;
        }

        for (let p = startPage; p <= endPage; p++) {
            const isCur = (p === currentProcPage);
            const btnClass = isCur ? 'btn btn-sm btn-primary active' : 'btn btn-sm btn-outline-secondary text-white';
            btnsHtml += `
                <button class="${btnClass}" onclick="setProcPage(${p})" style="padding: 1px 8px; font-size: 0.75rem; font-weight: 700; border-radius: 5px;">
                    ${p}
                </button>
            `;
        }

        if (endPage < totalPages) {
            btnsHtml += `<span class="text-muted" style="font-size: 0.7rem;">..</span><button class="btn btn-sm btn-outline-secondary text-white" onclick="setProcPage(${totalPages})" style="padding: 1px 7px; font-size: 0.75rem; font-weight: 700; border-radius: 5px;">${totalPages}</button>`;
        }

        quickBtns.innerHTML = btnsHtml;
    }

    if (btnPrev) btnPrev.disabled = (currentProcPage <= 1);
    if (btnNext) btnNext.disabled = (currentProcPage >= totalPages);

    // Attach row input listeners
    tbody.querySelectorAll('.proc-qty-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const id = parseInt(e.target.getAttribute('data-id'));
            const val = parseInt(e.target.value) || 0;
            updateProcItemQty(id, val);
        });
    });

    // Attach row checkbox listeners
    tbody.querySelectorAll('.proc-item-checkbox').forEach(chk => {
        chk.addEventListener('change', (e) => {
            const id = parseInt(e.target.getAttribute('data-id'));
            if (e.target.checked) {
                currentProcSelectedIds.add(id);
            } else {
                currentProcSelectedIds.delete(id);
            }
            updateProcurementKPIDisplay();
        });
    });
}

function adjustProcItemQty(id, delta) {
    const item = currentProcurementItems.find(i => i.id === id);
    if (!item) return;
    const newQty = Math.max(0, (item.recommended_qty || 0) + delta);
    updateProcItemQty(id, newQty);
    const input = document.querySelector(`.proc-qty-input[data-id="${id}"]`);
    if (input) input.value = newQty;
}

function updateProcItemQty(id, newQty) {
    const item = currentProcurementItems.find(i => i.id === id);
    if (!item) return;
    item.recommended_qty = Math.max(0, newQty);
    item.estimated_cost = item.recommended_qty * (item.effective_cost || 0);
    item.estimated_retail = item.recommended_qty * (item.price || 0);

    const costEl = document.getElementById(`proc-row-cost-${id}`);
    if (costEl) costEl.textContent = formatCurrency(item.estimated_cost);

    updateProcurementKPIDisplay();
}

function showToastMessage(msg, isError = false, buttons = []) {
    let container = document.getElementById("toast-container-global");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container-global";
        container.style.position = "fixed";
        container.style.bottom = "24px";
        container.style.right = "24px";
        container.style.zIndex = "999999";
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.gap = "10px";
        container.style.maxWidth = "480px";
        document.body.appendChild(container);
    }
    
    const toast = document.createElement("div");
    toast.style.background = isError ? "rgba(220, 38, 38, 0.95)" : "rgba(15, 23, 42, 0.95)";
    toast.style.border = isError ? "1px solid #ef4444" : "1px solid rgba(0, 230, 118, 0.4)";
    toast.style.color = "#ffffff";
    toast.style.padding = "12px 18px";
    toast.style.borderRadius = "12px";
    toast.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";
    toast.style.fontSize = "0.92rem";
    toast.style.lineHeight = "1.4";
    toast.style.backdropFilter = "blur(12px)";
    toast.style.display = "flex";
    toast.style.flexDirection = "column";
    toast.style.gap = "8px";
    
    let buttonsHtml = '';
    if (buttons && buttons.length > 0) {
        buttonsHtml = `<div style="display: flex; gap: 8px; margin-top: 4px;">`;
        buttons.forEach((btn, bIdx) => {
            buttonsHtml += `<button type="button" class="btn btn-sm" id="toast-btn-${bIdx}" style="${btn.style || 'background: #1a73e8; color: white; border: none; padding: 4px 10px; border-radius: 6px; font-weight: 600; font-size: 0.8rem; cursor: pointer;'}">${btn.text}</button>`;
        });
        buttonsHtml += `</div>`;
    }
    
    toast.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;">
            <div>${msg}</div>
            <button type="button" style="background: none; border: none; color: #94a3b8; font-size: 1.1rem; cursor: pointer; line-height: 1; padding: 0 4px;">&times;</button>
        </div>
        ${buttonsHtml}
    `;
    
    const closeBtn = toast.querySelector("button");
    if (closeBtn) closeBtn.onclick = () => toast.remove();
    
    if (buttons && buttons.length > 0) {
        buttons.forEach((btn, bIdx) => {
            const el = toast.querySelector(`#toast-btn-${bIdx}`);
            if (el && btn.onClick) {
                el.onclick = () => {
                    btn.onClick();
                    toast.remove();
                };
            }
        });
    }
    
    container.appendChild(toast);
    setTimeout(() => {
        if (toast.parentElement) toast.remove();
    }, 8000);
}

function showNotification(msg, isError = false) {
    showToastMessage(msg, isError);
}

async function copyProcurementToClipboard() {
    // Extract exactly the items currently shown on the active screen page
    const startIdx = (currentProcPage - 1) * currentProcPageSize;
    const endIdx = Math.min(currentProcurementItems.length, startIdx + currentProcPageSize);
    const currentPageItems = currentProcurementItems.slice(startIdx, endIdx);

    let selectedItems = currentPageItems.filter(i => currentProcSelectedIds.has(i.id));
    if (selectedItems.length === 0) {
        selectedItems = currentPageItems;
    }

    if (!selectedItems || selectedItems.length === 0) {
        showToastMessage('На текущей странице нет выбранных позиций', true);
        return;
    }

    const dateStr = new Date().toLocaleDateString('ru-RU');
    const timeStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    
    let isSingleSupplier = (currentProcurementSupplier !== 'all' && currentProcurementSupplier.trim() !== '');
    let headerTitle = isSingleSupplier 
        ? `📋 ЗАКАЗ ДЛЯ ПОСТАВЩИКА: ${currentProcurementSupplier.toUpperCase()} (СТРАНИЦА ${currentProcPage})\n` 
        : `📋 ЗАКАЗ НА ЗАКУПКУ ТОВАРОВ (СТРАНИЦА ${currentProcPage})\n`;

    let text = `${headerTitle}`;
    text += `📅 Дата: ${dateStr} ${timeStr}\n`;
    text += `📄 Позиции: № ${startIdx + 1}–${endIdx} из ${currentProcurementItems.length}\n`;
    text += `----------------------------------------\n`;

    let totalUnits = 0;
    let totalBudget = 0;

    selectedItems.forEach((item, idx) => {
        const rowNumber = startIdx + idx + 1;
        const barcodeStr = item.barcode ? `[${item.barcode}] ` : '';
        const supplierPart = (!isSingleSupplier && item.supplier && item.supplier !== 'Не указан') ? ` (${item.supplier})` : '';
        const qty = (item.recommended_qty > 0) ? item.recommended_qty : (item.stock === 0 ? 1 : 0);
        const itemSum = qty * (item.effective_cost || item.cost_price || 0);
        
        text += `${rowNumber}. ${barcodeStr}${item.name}${supplierPart} — ${qty} шт.`;
        if (item.effective_cost > 0) {
            text += ` x ${formatCurrency(item.effective_cost)} = ${formatCurrency(itemSum)} сум`;
        }
        text += ` (Ост: ${item.stock} шт)\n`;
        totalUnits += qty;
        totalBudget += itemSum;
    });

    text += `----------------------------------------\n`;
    text += `📦 ВСЕГО ПО СТРАНИЦЕ: ${totalUnits} шт. (${selectedItems.length} позиций)\n`;
    if (totalBudget > 0) {
        text += `💰 СУММА К ЗАКУПКЕ: ${formatCurrency(totalBudget)} сум\n`;
    }

    // 1. Copy text to clipboard
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
        }
    } catch (clipErr) {
        console.warn('Clipboard write error:', clipErr);
    }

    // 2. Generate Color PDF Report for Current Page & Save to Desktop
    showToastMessage(`⏳ Формирование цветного PDF страницы ${currentProcPage}...`);
    try {
        const res = await fetch('/api/procurement/export-pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: selectedItems,
                supplier: currentProcurementSupplier,
                page_number: currentProcPage,
                start_index: startIdx
            })
        });
        const data = await res.json();
        if (data.success) {
            playSuccessBeep();
            
            // Direct browser download trigger via Blob as additional safety backup
            if (data.pdf_base64) {
                try {
                    const binaryString = atob(data.pdf_base64);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const blob = new Blob([bytes], { type: 'application/pdf' });
                    const downloadUrl = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = downloadUrl;
                    a.download = data.filename || `Zakaz_Zakupka_${new Date().toISOString().slice(0, 10)}.pdf`;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => {
                        try {
                            document.body.removeChild(a);
                            window.URL.revokeObjectURL(downloadUrl);
                        } catch (e) {}
                    }, 1000);
                } catch (blobErr) {
                    console.warn("Direct blob download error:", blobErr);
                }
            }
            
            const filename = data.filename || 'ведомость.pdf';
            
            showToastMessage(
                `✅ <b>Текст скопирован для Telegram!</b><br>📄 PDF сохранен на Рабочий стол: <b style="color: #00e676;">${filename}</b>`,
                false,
                [
                    {
                        text: '📄 Открыть PDF',
                        style: 'background: #00c853; color: black; border: none; padding: 4px 10px; border-radius: 6px; font-weight: bold; font-size: 0.8rem; cursor: pointer;',
                        onClick: () => {
                            fetch('/api/system/open-file', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filepath: data.filepath })
                            });
                        }
                    },
                    {
                        text: '📂 Показать в папке',
                        style: 'background: rgba(255,255,255,0.15); color: white; border: 1px solid rgba(255,255,255,0.3); padding: 4px 10px; border-radius: 6px; font-weight: 600; font-size: 0.8rem; cursor: pointer;',
                        onClick: () => {
                            fetch('/api/system/open-folder', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ filepath: data.filepath })
                            });
                        }
                    }
                ]
            );
        } else {
            playErrorBuzz();
            showToastMessage(`⚠️ Текст скопирован в буфер, но произошла ошибка генерации PDF: ${data.message || 'Ошибка'}`, true);
        }
    } catch (err) {
        playErrorBuzz();
        console.error('PDF export error:', err);
        showToastMessage('✅ Текст заказа скопирован для отправки в Telegram/WhatsApp!');
    }
}

// Dedicated Export PDF button handler
async function exportProcurementPDF() {
    await copyProcurementToClipboard();
}

// Export Procurement to CSV
function exportProcurementCSV() {
    const items = currentProcurementItems.filter(i => currentProcSelectedIds.has(i.id));
    if (items.length === 0) {
        showNotification('Нет данных для экспорта', true);
        return;
    }

    let csvContent = 'data:text/csv;charset=utf-8,\uFEFF';
    csvContent += ['№', 'Штрихкод', 'Наименование', 'Категория', 'Бренд', 'Поставщик', 'Остаток (шт)', 'Продано за 30д (шт)', 'Хватит на (дн)', 'Цена закупа (сум)', 'К заказу (шт)', 'Сумма закупа (сум)'].join(';') + '\n';

    items.forEach((item, idx) => {
        const rowData = [
            idx + 1,
            `"${(item.barcode || '').replace(/"/g, '""')}"`,
            `"${(item.name || '').replace(/"/g, '""')}"`,
            `"${(item.type || '').replace(/"/g, '""')}"`,
            `"${(item.brand || '').replace(/"/g, '""')}"`,
            `"${(item.supplier || '').replace(/"/g, '""')}"`,
            item.stock,
            item.sold_qty,
            item.days_left,
            item.effective_cost,
            item.recommended_qty,
            item.estimated_cost
        ];
        csvContent += rowData.join(';') + '\n';
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `procurement_order_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showNotification('📥 Ведомость закупа успешно экспортирована в CSV');
}

// =========================================================================
// 2. PROCUREMENT PRINTING SYSTEM (A4 BLANK & 80MM THERMAL RECEIPT)
// =========================================================================

function openProcurementPrintModal() {
    const selectedItems = currentProcurementItems.filter(i => currentProcSelectedIds.has(i.id) && i.recommended_qty > 0);
    if (selectedItems.length === 0) {
        showNotification('Выберите хотя бы один товар с количеством к заказу > 0', true);
        return;
    }

    const modal = document.getElementById('modal-print-procurement');
    if (!modal) return;

    renderPrintProcurementSheet();
    modal.style.display = 'flex';
}

function renderPrintProcurementSheet() {
    const container = document.getElementById('print-procurement-sheet');
    const summaryText = document.getElementById('print-proc-summary-text');
    if (!container) return;

    const selectedItems = currentProcurementItems.filter(i => currentProcSelectedIds.has(i.id) && i.recommended_qty > 0);
    const dateStr = new Date().toLocaleDateString('ru-RU');
    const timeStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    let totalUnits = 0;
    let totalBudget = 0;
    selectedItems.forEach(i => {
        totalUnits += i.recommended_qty;
        totalBudget += (i.recommended_qty * (i.effective_cost || 0));
    });

    if (summaryText) {
        summaryText.textContent = `${selectedItems.length} поз. / ${totalUnits} шт. / ${formatCurrency(totalBudget)} сум`;
    }

    const supplierFilterName = currentProcurementSupplier !== 'all' ? currentProcurementSupplier.toUpperCase() : 'Все поставщики';

    if (currentPrintDocFormat === 'receipt') {
        // --- 80mm THERMAL RECEIPT FORMAT ---
        let itemsHtml = '';
        selectedItems.forEach((item, idx) => {
            const sum = item.recommended_qty * (item.effective_cost || 0);
            itemsHtml += `
                <div style="margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px dashed #cbd5e1;">
                    <div style="font-weight: bold; font-size: 13px;">[ ] ${idx + 1}. ${escapeHtml(item.name)}</div>
                    <div style="font-size: 11px; color: #475569; display: flex; justify-content: space-between; margin-top: 2px;">
                        <span>ШК: ${item.barcode || '—'} (Ост: ${item.stock})</span>
                        <span style="font-weight: bold; font-size: 13px; color: #000;">Заказ: ${item.recommended_qty} шт.</span>
                    </div>
                    ${item.effective_cost > 0 ? `<div style="font-size: 11px; text-align: right; color: #334155;">${formatCurrency(item.effective_cost)} × ${item.recommended_qty} = <b>${formatCurrency(sum)} сум</b></div>` : ''}
                </div>
            `;
        });

        container.innerHTML = `
            <div style="max-width: 320px; margin: 0 auto; font-size: 12px; line-height: 1.4; color: #000;">
                <div style="text-align: center; border-bottom: 2px dashed #000; padding-bottom: 8px; margin-bottom: 10px;">
                    <h2 style="margin: 0; font-size: 16px; font-weight: 900; text-transform: uppercase;">ВЕДОМОСТЬ ЗАКУПА</h2>
                    <div style="font-size: 11px; color: #475569; margin-top: 3px;">Дата: ${dateStr} ${timeStr}</div>
                    <div style="font-size: 12px; font-weight: bold; margin-top: 2px;">Поставщик: ${escapeHtml(supplierFilterName)}</div>
                </div>

                <div style="margin-bottom: 12px;">
                    ${itemsHtml}
                </div>

                <div style="border-top: 2px solid #000; padding-top: 8px; font-size: 13px;">
                    <div style="display: flex; justify-content: space-between; font-weight: bold;">
                        <span>ВСЕГО ПОЗИЦИЙ:</span>
                        <span>${selectedItems.length}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 14px; margin-top: 3px;">
                        <span>ВСЕГО ШТУК:</span>
                        <span>${totalUnits} шт.</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-weight: 900; font-size: 14px; margin-top: 4px; border-top: 1px dashed #000; padding-top: 4px;">
                        <span>ИТОГО СУММА:</span>
                        <span>${formatCurrency(totalBudget)} сум</span>
                    </div>
                </div>

                <div style="margin-top: 25px; border-top: 1px solid #94a3b8; padding-top: 10px; font-size: 11px; text-align: center;">
                    Подпись: ______________________
                </div>
            </div>
        `;
    } else {
        // --- A4 STANDARD BLANK FORMAT ---
        let rowsHtml = '';
        selectedItems.forEach((item, idx) => {
            const sum = item.recommended_qty * (item.effective_cost || 0);
            rowsHtml += `
                <tr style="border-bottom: 1px solid #cbd5e1;">
                    <td style="text-align: center; font-weight: bold; padding: 6px 4px;">${idx + 1}</td>
                    <td style="text-align: center; font-size: 14px; font-weight: bold; padding: 6px 4px;">[ &nbsp; ]</td>
                    <td style="font-family: monospace; font-size: 11px; padding: 6px 4px;">${escapeHtml(item.barcode || '—')}</td>
                    <td style="font-weight: 600; padding: 6px 6px;">
                        ${escapeHtml(item.name)}
                        ${item.unique_suffix ? `<br><small style="color: #64748b;">${escapeHtml(item.unique_suffix)}</small>` : ''}
                    </td>
                    <td style="font-size: 11px; color: #475569; padding: 6px 4px;">${escapeHtml(item.brand ? item.brand.toUpperCase() : '—')}</td>
                    <td style="font-size: 11px; color: #475569; padding: 6px 4px;">${escapeHtml(item.supplier || '—')}</td>
                    <td style="text-align: center; font-weight: 600; padding: 6px 4px; ${item.stock === 0 ? 'color: #dc2626;' : ''}">${item.stock} шт</td>
                    <td style="text-align: center; font-size: 14px; font-weight: 900; background: #f1f5f9; padding: 6px 6px; border: 1.5px solid #0f172a;">${item.recommended_qty} шт</td>
                    <td style="text-align: right; font-size: 12px; padding: 6px 6px;">${formatCurrency(item.effective_cost)} сум</td>
                    <td style="text-align: right; font-size: 12px; font-weight: bold; padding: 6px 6px;">${formatCurrency(sum)} сум</td>
                </tr>
            `;
        });

        container.innerHTML = `
            <div style="color: #000; font-family: Arial, sans-serif;">
                <!-- Header -->
                <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px;">
                    <div>
                        <h1 style="margin: 0; font-size: 20px; font-weight: 900; letter-spacing: -0.5px; text-transform: uppercase;">ВЕДОМОСТЬ / ЗАКАЗ НА ЗАКУПКУ ТОВАРОВ</h1>
                        <div style="font-size: 12px; color: #475569; margin-top: 4px;">
                            CRM Система складского учета • Реестр пополнения остатков
                        </div>
                    </div>
                    <div style="text-align: right; font-size: 12px;">
                        <div><b>Дата:</b> ${dateStr} ${timeStr}</div>
                        <div><b>Поставщик:</b> <span style="text-decoration: underline;">${escapeHtml(supplierFilterName)}</span></div>
                    </div>
                </div>

                <!-- Table -->
                <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 20px;">
                    <thead>
                        <tr style="background: #f8fafc; border-top: 1px solid #0f172a; border-bottom: 2px solid #0f172a; font-weight: 800; font-size: 11px; text-transform: uppercase;">
                            <th style="width: 30px; text-align: center; padding: 8px 4px;">№</th>
                            <th style="width: 35px; text-align: center; padding: 8px 4px;">Факт</th>
                            <th style="width: 80px; text-align: left; padding: 8px 4px;">Штрихкод</th>
                            <th style="text-align: left; padding: 8px 6px;">Наименование товара</th>
                            <th style="width: 70px; text-align: left; padding: 8px 4px;">Бренд</th>
                            <th style="width: 80px; text-align: left; padding: 8px 4px;">Поставщик</th>
                            <th style="width: 60px; text-align: center; padding: 8px 4px;">Остаток</th>
                            <th style="width: 80px; text-align: center; padding: 8px 6px; background: #e2e8f0; color: #000;">К закупу</th>
                            <th style="width: 85px; text-align: right; padding: 8px 6px;">Цена закупа</th>
                            <th style="width: 95px; text-align: right; padding: 8px 6px;">Сумма</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                    <tfoot>
                        <tr style="border-top: 2px solid #0f172a; font-weight: 900; background: #f8fafc; font-size: 13px;">
                            <td colspan="6" style="padding: 10px 8px; text-align: right;">ИТОГО К ЗАКУПКЕ:</td>
                            <td style="text-align: center; padding: 10px 4px;">—</td>
                            <td style="text-align: center; padding: 10px 6px; font-size: 14px; background: #e2e8f0; border: 1.5px solid #0f172a;">${totalUnits} шт</td>
                            <td style="text-align: right; padding: 10px 6px;">—</td>
                            <td style="text-align: right; padding: 10px 6px; font-size: 14px; color: #000;">${formatCurrency(totalBudget)} сум</td>
                        </tr>
                    </tfoot>
                </table>

                <!-- Summary & Signature Block -->
                <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 35px; padding-top: 15px; border-top: 1px dashed #cbd5e1; font-size: 12px;">
                    <div>
                        <div>Всего наименований: <b>${selectedItems.length}</b>, на общее количество <b>${totalUnits} шт.</b></div>
                        <div style="margin-top: 4px;">Ориентировочная сумма к оплате: <b>${formatCurrency(totalBudget)} сум</b></div>
                    </div>
                    <div style="display: flex; gap: 40px;">
                        <div>
                            Заказ сформировал: ____________________
                        </div>
                        <div>
                            Товар принял / Поставщик: ____________________
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

function triggerExecuteProcurementPrint() {
    const sheetEl = document.getElementById('print-procurement-sheet');
    if (!sheetEl) return;

    const htmlContent = sheetEl.innerHTML;

    // Create a dedicated hidden iframe to print cleanly without touching the page's label styles
    let iframe = document.getElementById('procurement-print-iframe');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'procurement-print-iframe';
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = 'none';
        document.body.appendChild(iframe);
    }

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Ведомость закупа</title>
            <style>
                @page {
                    size: ${currentPrintDocFormat === 'receipt' ? '80mm auto' : 'A4 portrait'};
                    margin: ${currentPrintDocFormat === 'receipt' ? '4mm' : '10mm'};
                }
                body {
                    margin: 0;
                    padding: ${currentPrintDocFormat === 'receipt' ? '0' : '10px'};
                    background: #ffffff !important;
                    color: #000000 !important;
                    font-family: Arial, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    -webkit-print-color-adjust: exact;
                    print-color-adjust: exact;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                }
                th, td {
                    color: #000000 !important;
                }
            </style>
        </head>
        <body>
            ${htmlContent}
        </body>
        </html>
    `);
    doc.close();

    setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
    }, 250);
}

// =========================================================================
// 3. CASE PURCHASE HEATMAP MATRIX & INFOGRAPHICS
// =========================================================================

// Load data from backend
async function loadCaseMatrixAnalytics() {
    const leadDaysInput = document.getElementById('case-matrix-lead-days');
    const safetyRatioInput = document.getElementById('case-matrix-safety-ratio');
    const leadDays = leadDaysInput ? parseInt(leadDaysInput.value) || 14 : 14;
    const safetyRatio = safetyRatioInput ? parseFloat(safetyRatioInput.value) || 1.2 : 1.2;

    const tbody = document.getElementById('case-matrix-tbody');
    if (tbody) {
        tbody.innerHTML = `
            <tr>
                <td colspan="15" class="text-center py-4 text-muted">
                    <div class="spinner-border text-primary mb-2" role="status"></div>
                    <div>Формирование матрицы спроса и расчет рекомендаций...</div>
                </td>
            </tr>
        `;
    }

    try {
        const url = `/api/analytics/cases-purchase-matrix?days=${currentCaseDays}&category=${encodeURIComponent(currentCaseCategory)}&brand=${encodeURIComponent(currentCaseBrand)}&model=${encodeURIComponent(currentCaseModel)}&lead_time_days=${leadDays}&safety_ratio=${safetyRatio}&limit=0`;
        const res = await fetch(url);
        const data = await res.json();

        if (!data.success) {
            if (tbody) tbody.innerHTML = `<tr><td colspan="15" class="text-center text-danger py-3">${data.message || 'Ошибка загрузки данных'}</td></tr>`;
            return;
        }

        currentCaseMatrixRaw = data;

        // 1. Update KPI Summary
        const kpi = data.kpi || {};
        const kpiSold = document.getElementById('case-kpi-total-sold');
        const kpiRev = document.getElementById('case-kpi-total-rev');
        const kpiModel = document.getElementById('case-kpi-top-model');
        const kpiRec = document.getElementById('case-kpi-total-rec');

        if (kpiSold) kpiSold.textContent = `${(kpi.total_sold || 0).toLocaleString()} шт`;
        if (kpiRev) kpiRev.textContent = `${Math.round(kpi.total_revenue || 0).toLocaleString()} сум`;
        if (kpiModel) kpiModel.textContent = kpi.top_model ? `${kpi.top_model.name} (${kpi.top_model.qty} шт)` : '--';
        if (kpiRec) kpiRec.textContent = `${(kpi.total_recommended || 0).toLocaleString()} шт`;

        // 2. Populate Category & Brands Filter dropdowns
        const catSelect = document.getElementById('case-matrix-category-filter');
        if (catSelect && data.categories && catSelect.options.length <= 1) {
            catSelect.innerHTML = '<option value="all">Все категории</option>';
            data.categories.forEach(c => {
                if (c !== 'all' && c.trim()) {
                    const opt = document.createElement('option');
                    opt.value = c;
                    opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
                    catSelect.appendChild(opt);
                }
            });
            catSelect.value = currentCaseCategory;
        }

        const brandSelect = document.getElementById('case-matrix-brand-filter');
        if (brandSelect && data.brands && brandSelect.options.length <= 1) {
            brandSelect.innerHTML = '<option value="all">Все бренды</option>';
            data.brands.forEach(b => {
                if (b !== 'all' && b.trim()) {
                    const opt = document.createElement('option');
                    opt.value = b;
                    opt.textContent = b.toUpperCase();
                    brandSelect.appendChild(opt);
                }
            });
            brandSelect.value = currentCaseBrand;
        }

        // 3. Populate Dynamic Model Filter dropdown
        const modelSelect = document.getElementById('case-matrix-model-filter');
        if (modelSelect && data.models) {
            const savedModel = currentCaseModel;
            modelSelect.innerHTML = '<option value="all">📱 Все модели</option>';
            data.models.forEach(m => {
                if (m !== 'all' && m.trim()) {
                    const opt = document.createElement('option');
                    opt.value = m;
                    opt.textContent = m;
                    modelSelect.appendChild(opt);
                }
            });
            if (Array.from(modelSelect.options).some(o => o.value === savedModel)) {
                modelSelect.value = savedModel;
            } else {
                currentCaseModel = 'all';
                modelSelect.value = 'all';
            }
        }

        // 4. Render Infographics
        renderCaseNestedDonut(data.charts ? data.charts.nested_donut : null);
        renderCaseStackedBar(data.charts ? data.charts.stacked_bar : null, currentCaseBarMode);
        renderCaseHeatmapTable();

    } catch (err) {
        console.error('Error in loadCaseMatrixAnalytics:', err);
        if (tbody) tbody.innerHTML = `<tr><td colspan="15" class="text-center text-danger py-3">Сетевая ошибка при загрузке аналитики</td></tr>`;
    }
}

// 1. Render Nested Donut Chart (Chart.js / ApexCharts)
function renderCaseNestedDonut(donutData) {
    const container = document.getElementById('chart-cases-nested-donut');
    if (!container) return;

    container.innerHTML = '<canvas id="canvas-cases-nested-donut" style="max-height: 380px;"></canvas>';
    const canvas = document.getElementById('canvas-cases-nested-donut');
    if (!canvas) return;

    if (caseNestedDonutChartInstance) {
        caseNestedDonutChartInstance.destroy();
        caseNestedDonutChartInstance = null;
    }

    if (!donutData || !donutData.inner || donutData.inner.length === 0) {
        container.innerHTML = '<div class="text-muted text-center py-5">Нет данных по продажам за выбранный период</div>';
        return;
    }

    const innerLabels = donutData.inner.map(item => item.name);
    const innerValues = donutData.inner.map(item => item.value);
    const innerColors = donutData.inner.map(item => item.color || '#206bc4');

    const outerLabels = donutData.outer.map(item => item.name);
    const outerValues = donutData.outer.map(item => item.value);

    // Generate harmonized lighter/darker shades for outer slices based on their parent model
    const outerColors = donutData.outer.map(item => {
        const parent = donutData.inner.find(m => m.name === item.model);
        return parent ? parent.color : '#4299e1';
    });

    const ctx = canvas.getContext('2d');
    caseNestedDonutChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            datasets: [
                // Outer Ring: Types breakdown
                {
                    label: 'Типы чехлов',
                    data: outerValues,
                    labels: outerLabels,
                    backgroundColor: outerColors,
                    borderWidth: 1,
                    borderColor: '#111827',
                    weight: 1.3
                },
                // Inner Ring: Models
                {
                    label: 'Модели телефонов',
                    data: innerValues,
                    labels: innerLabels,
                    backgroundColor: innerColors,
                    borderWidth: 2,
                    borderColor: '#111827',
                    weight: 0.9
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '45%',
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        color: '#a0aec0',
                        boxWidth: 12,
                        padding: 10,
                        font: { size: 11, family: 'Inter, sans-serif' },
                        generateLabels: function() {
                            return innerLabels.map((label, idx) => ({
                                text: `${label} (${innerValues[idx]} шт)`,
                                fillStyle: innerColors[idx],
                                hidden: false,
                                index: idx
                            }));
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: '#ffffff',
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        title: function(items) {
                            if (!items || !items.length) return '';
                            const item = items[0];
                            const dsIndex = item.datasetIndex;
                            if (dsIndex === 1) {
                                return `📱 Модель: ${innerLabels[item.dataIndex]}`;
                            } else {
                                return `🎨 ${outerLabels[item.dataIndex]}`;
                            }
                        },
                        label: function(item) {
                            const val = item.raw || 0;
                            const total = innerValues.reduce((a, b) => a + b, 0);
                            const pct = total > 0 ? ((val / total) * 100).toFixed(1) : 0;
                            return ` Продано: ${val} шт (${pct}% от топа)`;
                        }
                    }
                }
            },
            animation: {
                animateScale: true,
                animateRotate: true
            }
        }
    });
}

// 2. Render Stacked / Grouped Bar Chart (ApexCharts)
function renderCaseStackedBar(barData, mode = 'stacked') {
    const container = document.getElementById('chart-cases-stacked-bar');
    if (!container) return;

    if (caseStackedBarChartInstance) {
        caseStackedBarChartInstance.destroy();
        caseStackedBarChartInstance = null;
    }

    if (!barData || !barData.categories || barData.categories.length === 0 || !barData.series || barData.series.length === 0) {
        container.innerHTML = '<div class="text-muted text-center py-5">Нет данных для построения гистограммы</div>';
        return;
    }

    const isStacked = (mode === 'stacked');

    const options = {
        series: barData.series,
        chart: {
            type: 'bar',
            height: 380,
            stacked: isStacked,
            background: 'transparent',
            toolbar: { show: true, tools: { download: true, zoom: false, pan: false } },
            animations: { enabled: true, easing: 'easeinout', speed: 600 }
        },
        theme: { mode: 'dark' },
        colors: ['#00e676', '#00b0ff', '#ffd600', '#ff5252', '#7c4dff', '#ff007f', '#00f0ff', '#ff9100', '#20c997'],
        plotOptions: {
            bar: {
                horizontal: false,
                columnWidth: isStacked ? '50%' : '75%',
                borderRadius: 4,
                dataLabels: {
                    total: {
                        enabled: isStacked,
                        style: { color: '#ffffff', fontSize: '11px', fontWeight: 700 },
                        formatter: (val) => val > 0 ? val : ''
                    }
                }
            }
        },
        dataLabels: {
            enabled: false
        },
        stroke: {
            show: true,
            width: 1,
            colors: ['#111827']
        },
        xaxis: {
            categories: barData.categories,
            labels: {
                style: { colors: '#94a3b8', fontSize: '11px', fontFamily: 'Inter, sans-serif' },
                rotate: -45,
                trim: true
            },
            axisBorder: { color: 'rgba(255,255,255,0.1)' },
            axisTicks: { color: 'rgba(255,255,255,0.1)' }
        },
        yaxis: {
            title: { text: 'Продано (шт)', style: { color: '#94a3b8', fontSize: '12px' } },
            labels: { style: { colors: '#94a3b8' } }
        },
        grid: {
            borderColor: 'rgba(255, 255, 255, 0.06)',
            strokeDashArray: 4
        },
        legend: {
            position: 'top',
            horizontalAlign: 'right',
            labels: { colors: '#cbd5e1' },
            fontSize: '11px'
        },
        tooltip: {
            theme: 'dark',
            y: {
                formatter: function (val) {
                    return val + " шт";
                }
            }
        }
    };

    container.innerHTML = '';
    caseStackedBarChartInstance = new ApexCharts(container, options);
    caseStackedBarChartInstance.render();
}

// 3. Render Heatmap Matrix Table
function renderCaseHeatmapTable() {
    if (!currentCaseMatrixRaw || !currentCaseMatrixRaw.matrix) return;

    const thead = document.getElementById('case-matrix-thead');
    const tbody = document.getElementById('case-matrix-tbody');
    if (!thead || !tbody) return;

    const columns = currentCaseMatrixRaw.matrix.columns || [];
    let rows = currentCaseMatrixRaw.matrix.rows || [];

    // Filter by search query
    if (currentCaseSearchQuery) {
        const q = currentCaseSearchQuery.toLowerCase();
        rows = rows.filter(r => (r.model && r.model.toLowerCase().includes(q)) || (r.brand && r.brand.toLowerCase().includes(q)));
    }

    // Filter by status
    if (currentCaseStatusFilter !== 'all') {
        rows = rows.filter(r => r.status === currentCaseStatusFilter);
    }

    // Render Table Header
    let theadHtml = `
        <tr>
            <th style="min-width: 170px;">📱 Модель / Товар</th>
            <th>Бренд</th>
    `;
    columns.forEach(col => {
        theadHtml += `<th class="text-center" style="min-width: 75px;" title="${col}">${col}</th>`;
    });
    theadHtml += `
            <th class="text-center" style="color: #ffd600; background: rgba(255, 214, 0, 0.1);">Занесено</th>
            <th class="text-center" style="color: #00e676; background: rgba(0, 230, 118, 0.1);">Продано</th>
            <th class="text-center" style="color: #00b0ff; background: rgba(0, 176, 255, 0.1);">Остаток</th>
            <th class="text-center" style="color: #ff5252; background: rgba(255, 82, 82, 0.1);">Рекомендация</th>
            <th class="text-center">Статус</th>
            <th class="text-center">Действие</th>
        </tr>
    `;
    thead.innerHTML = theadHtml;

    // Render Table Body
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${columns.length + 8}" class="text-center py-4 text-muted">Ничего не найдено по текущим фильтрам</td></tr>`;
        return;
    }

    let tbodyHtml = '';
    rows.forEach(r => {
        let statusBadge = '';
        if (r.status === 'urgent') {
            statusBadge = '<span class="badge bg-danger text-white" style="font-size: 0.72rem;">🔴 Срочно</span>';
        } else if (r.status === 'replenish') {
            statusBadge = '<span class="badge bg-warning text-dark" style="font-size: 0.72rem;">🟡 Докупить</span>';
        } else if (r.status === 'ok') {
            statusBadge = '<span class="badge bg-success text-white" style="font-size: 0.72rem;">🟢 В норме</span>';
        } else {
            statusBadge = '<span class="badge bg-secondary text-white" style="font-size: 0.72rem;">⚪ Избыток</span>';
        }

        const brandBadge = r.brand === 'apple' ? '<span class="badge bg-dark text-white border">Apple</span>' :
                           r.brand === 'samsung' ? '<span class="badge bg-blue-lt">Samsung</span>' :
                           r.brand === 'xiaomi' ? '<span class="badge bg-orange-lt">Xiaomi</span>' :
                           `<span class="badge bg-secondary-lt">${r.brand}</span>`;

        tbodyHtml += `
            <tr>
                <td style="font-weight: 700; color: #ffffff;">
                    ${r.model}
                </td>
                <td>${brandBadge}</td>
        `;

        // Render dynamic cell per case type
        columns.forEach(col => {
            const cell = (r.cells && r.cells[col]) ? r.cells[col] : { sold: 0, stock: 0, existed: false };
            const sold = cell.sold || 0;
            const stock = cell.stock || 0;
            const existed = cell.existed !== false;

            if (!existed) {
                // Non-existent combination for this model
                tbodyHtml += `
                    <td class="text-center" style="opacity: 0.25; color: #64748b; font-size: 0.75rem;">
                        —
                    </td>
                `;
            } else {
                let heatClass = 'case-cell-zero';
                if (sold >= 4) {
                    heatClass = 'case-cell-hit';
                } else if (sold >= 2) {
                    heatClass = 'case-cell-high';
                } else if (sold === 1) {
                    heatClass = 'case-cell-med';
                }

                tbodyHtml += `
                    <td>
                        <div class="case-cell-box ${heatClass}" title="${r.model} (${col}) - Продано: ${sold} шт, Остаток: ${stock} шт">
                            <span class="case-cell-sold">${sold > 0 ? sold : '-'}</span>
                            <span class="case-cell-stock">📦 ${stock}</span>
                        </div>
                    </td>
                `;
            }
        });

        // Summary columns
        const recDisplay = r.recommended_qty > 0 
            ? `<span style="font-size: 1.1rem; font-weight: 800; color: #ff5252;">+${r.recommended_qty} шт</span>` 
            : `<span class="text-muted" style="font-size: 0.85rem;">0 шт</span>`;

        const initQty = r.initial_qty || (r.stock + r.sold_qty);

        tbodyHtml += `
                <td class="text-center font-weight-bold" style="color: #ffd600; font-size: 0.95rem; background: rgba(255, 214, 0, 0.05);">${initQty}</td>
                <td class="text-center font-weight-bold" style="color: #00e676; font-size: 0.95rem; background: rgba(0, 230, 118, 0.05);">${r.sold_qty}</td>
                <td class="text-center font-weight-bold" style="color: #00b0ff; font-size: 0.95rem; background: rgba(0, 176, 255, 0.05);">${r.stock}</td>
                <td class="text-center" style="background: rgba(255, 82, 82, 0.06);">${recDisplay}</td>
                <td class="text-center">${statusBadge}</td>
                <td class="text-center">
                    <button class="btn btn-xs btn-outline-primary" onclick="quickAddCasePurchase('${r.model.replace(/'/g, "\\'")}', ${r.recommended_qty})" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px;">
                        ➕ Заказ
                    </button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = tbodyHtml;
}

// Quick action to add purchase
function quickAddCasePurchase(modelName, recQty) {
    showTab('tab-finance');
    showNotification(`Формирование закупки для модели: ${modelName} (${recQty > 0 ? recQty : 5} шт)`);
}

// Copy Purchase List to Clipboard
function copyCasePurchaseList() {
    if (!currentCaseMatrixRaw || !currentCaseMatrixRaw.matrix) {
        showNotification('Нет данных для копирования', true);
        return;
    }

    const rows = currentCaseMatrixRaw.matrix.rows || [];
    const urgentItems = rows.filter(r => r.recommended_qty > 0);

    if (urgentItems.length === 0) {
        showNotification('Все позиции в достатке, закупка не требуется', false);
        return;
    }

    const dateStr = new Date().toLocaleDateString('ru-RU');
    let text = `📋 СПИСОК ЗАКУПА ТОВАРОВ (${dateStr}):\n`;
    text += `Период расчета: ${currentCaseDays === 0 ? 'За всё время' : currentCaseDays + ' дней'}\n\n`;

    let totalUnits = 0;
    urgentItems.forEach((r, idx) => {
        text += `${idx + 1}. [${r.brand.toUpperCase()}] ${r.model}: +${r.recommended_qty} шт (Продано: ${r.sold_qty}, На складе: ${r.stock})\n`;
        totalUnits += r.recommended_qty;
    });

    text += `\nИТОГО К ЗАКУПУ: ${totalUnits} шт.`;

    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            showNotification('✅ Список закупа скопирован в буфер обмена!');
        }).catch(() => {
            prompt('Скопируйте список закупа:', text);
        });
    } else {
        prompt('Скопируйте список закупа:', text);
    }
}

// Export Matrix to CSV
function exportCaseMatrixCSV() {
    if (!currentCaseMatrixRaw || !currentCaseMatrixRaw.matrix) {
        showNotification('Нет данных для экспорта', true);
        return;
    }

    const columns = currentCaseMatrixRaw.matrix.columns || [];
    const rows = currentCaseMatrixRaw.matrix.rows || [];

    let csvContent = 'data:text/csv;charset=utf-8,\uFEFF';
    csvContent += ['Модель / Товар', 'Бренд', ...columns, 'Изначально занесено', 'Всего продано', 'Остаток на складе', 'Рекомендация закупа', 'Статус'].join(';') + '\n';

    rows.forEach(r => {
        const rowData = [
            `"${r.model.replace(/"/g, '""')}"`,
            `"${r.brand}"`
        ];

        columns.forEach(col => {
            const cell = (r.cells && r.cells[col]) ? r.cells[col] : { sold: 0, stock: 0, existed: false };
            if (!cell.existed) {
                rowData.push('"—"');
            } else {
                rowData.push(`"${cell.sold} (ост: ${cell.stock})"`);
            }
        });

        const initQty = r.initial_qty || (r.stock + r.sold_qty);
        rowData.push(initQty);
        rowData.push(r.sold_qty);
        rowData.push(r.stock);
        rowData.push(r.recommended_qty);
        rowData.push(`"${r.status_text}"`);

        csvContent += rowData.join(';') + '\n';
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `case_purchase_matrix_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showNotification('📥 Матрица закупа успешно экспортирована в CSV');
}

// =========================================================================
// 4. EVENT LISTENERS INITIALIZATION
// =========================================================================
document.addEventListener('DOMContentLoaded', () => {
    // --- Sub-navigation Toggles ---
    const btnSubProc = document.getElementById('case-subnav-procurement-btn');
    const btnSubMatrix = document.getElementById('case-subnav-matrix-btn');
    const btnSubCharts = document.getElementById('case-subnav-charts-btn');

    const panelSubProc = document.getElementById('case-subtab-procurement');
    const panelSubMatrix = document.getElementById('case-subtab-matrix');
    const panelSubCharts = document.getElementById('case-subtab-charts');

    if (btnSubProc && btnSubMatrix && btnSubCharts) {
        btnSubProc.addEventListener('click', () => {
            btnSubProc.className = 'btn btn-primary active';
            btnSubMatrix.className = 'btn btn-outline-primary';
            btnSubCharts.className = 'btn btn-outline-primary';

            if (panelSubProc) panelSubProc.style.display = 'block';
            if (panelSubMatrix) panelSubMatrix.style.display = 'none';
            if (panelSubCharts) panelSubCharts.style.display = 'none';

            loadProcurementAnalytics();
        });

        btnSubMatrix.addEventListener('click', () => {
            btnSubMatrix.className = 'btn btn-primary active';
            btnSubProc.className = 'btn btn-outline-primary';
            btnSubCharts.className = 'btn btn-outline-primary';

            if (panelSubProc) panelSubProc.style.display = 'none';
            if (panelSubMatrix) panelSubMatrix.style.display = 'block';
            if (panelSubCharts) panelSubCharts.style.display = 'none';

            loadCaseMatrixAnalytics();
        });

        btnSubCharts.addEventListener('click', () => {
            btnSubCharts.className = 'btn btn-primary active';
            btnSubProc.className = 'btn btn-outline-primary';
            btnSubMatrix.className = 'btn btn-outline-primary';

            if (panelSubProc) panelSubProc.style.display = 'none';
            if (panelSubMatrix) panelSubMatrix.style.display = 'none';
            if (panelSubCharts) panelSubCharts.style.display = 'block';

            if (!currentCaseMatrixRaw) {
                loadCaseMatrixAnalytics();
            }
        });
    }

    // --- Procurement Action Buttons & Filters ---
    const btnPrintProc = document.getElementById('btn-print-procurement');
    if (btnPrintProc) btnPrintProc.addEventListener('click', openProcurementPrintModal);

    const btnCopyProc = document.getElementById('btn-copy-procurement-text');
    if (btnCopyProc) btnCopyProc.addEventListener('click', copyProcurementToClipboard);

    const btnExportProc = document.getElementById('btn-export-procurement-csv');
    if (btnExportProc) btnExportProc.addEventListener('click', exportProcurementCSV);

    const btnRefreshProc = document.getElementById('btn-refresh-procurement');
    if (btnRefreshProc) btnRefreshProc.addEventListener('click', loadProcurementAnalytics);

    const procSearch = document.getElementById('proc-search-input');
    if (procSearch) {
        procSearch.addEventListener('input', (e) => {
            currentProcurementSearch = e.target.value.trim();
            loadProcurementAnalytics();
        });
    }

    const procSuppFilter = document.getElementById('proc-filter-supplier');
    if (procSuppFilter) {
        procSuppFilter.addEventListener('change', (e) => {
            currentProcurementSupplier = e.target.value;
            loadProcurementAnalytics();
        });
    }

    const procCatFilter = document.getElementById('proc-filter-category');
    if (procCatFilter) {
        procCatFilter.addEventListener('change', (e) => {
            currentProcurementCategory = e.target.value;
            currentProcurementModel = 'all';
            currentProcurementSuffix = 'all';
            currentProcPage = 1;
            loadProcurementAnalytics();
        });
    }

    const procBrandFilter = document.getElementById('proc-filter-brand');
    if (procBrandFilter) {
        procBrandFilter.addEventListener('change', (e) => {
            currentProcurementBrand = e.target.value;
            currentProcurementModel = 'all';
            currentProcurementSuffix = 'all';
            currentProcPage = 1;
            loadProcurementAnalytics();
        });
    }

    const procModelFilter = document.getElementById('proc-filter-model');
    if (procModelFilter) {
        procModelFilter.addEventListener('change', (e) => {
            currentProcurementModel = e.target.value;
            currentProcurementSuffix = 'all';
            currentProcPage = 1;
            loadProcurementAnalytics();
        });
    }

    const procSuffixFilter = document.getElementById('proc-filter-suffix');
    if (procSuffixFilter) {
        procSuffixFilter.addEventListener('change', (e) => {
            currentProcurementSuffix = e.target.value;
            currentProcPage = 1;
            loadProcurementAnalytics();
        });
    }

    // KPI Cards as Filter Buttons
    const kpiGrid = document.getElementById('proc-kpi-filter-grid');
    if (kpiGrid) {
        kpiGrid.addEventListener('click', (e) => {
            const card = e.target.closest('.proc-kpi-card');
            if (card) {
                const urgency = card.getAttribute('data-urgency') || 'all_procurement';
                currentProcurementUrgency = urgency;
                updateProcurementKPIDisplay();
                loadProcurementAnalytics();
            }
        });
    }

    // Select All Checkbox
    const selectAllChk = document.getElementById('proc-select-all');
    if (selectAllChk) {
        selectAllChk.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            currentProcSelectedIds.clear();
            if (isChecked) {
                currentProcurementItems.forEach(i => currentProcSelectedIds.add(i.id));
            }
            document.querySelectorAll('.proc-item-checkbox').forEach(chk => {
                chk.checked = isChecked;
            });
            updateProcurementKPIDisplay();
        });
    }

    // --- Print Modal Controls ---
    const btnPrintClose = document.getElementById('btn-print-proc-close');
    const btnPrintCancel = document.getElementById('btn-print-proc-cancel');
    const modalPrintProc = document.getElementById('modal-print-procurement');

    if (btnPrintClose && modalPrintProc) {
        btnPrintClose.addEventListener('click', () => modalPrintProc.style.display = 'none');
    }
    if (btnPrintCancel && modalPrintProc) {
        btnPrintCancel.addEventListener('click', () => modalPrintProc.style.display = 'none');
    }

    const btnFormatA4 = document.getElementById('btn-print-format-a4');
    const btnFormatReceipt = document.getElementById('btn-print-format-receipt');
    if (btnFormatA4 && btnFormatReceipt) {
        btnFormatA4.addEventListener('click', () => {
            btnFormatA4.className = 'btn btn-primary active';
            btnFormatReceipt.className = 'btn btn-outline-primary';
            currentPrintDocFormat = 'a4';
            renderPrintProcurementSheet();
        });
        btnFormatReceipt.addEventListener('click', () => {
            btnFormatReceipt.className = 'btn btn-primary active';
            btnFormatA4.className = 'btn btn-outline-primary';
            currentPrintDocFormat = 'receipt';
            renderPrintProcurementSheet();
        });
    }

    const btnExecPrint = document.getElementById('btn-execute-procurement-print');
    const btnExecPrintFooter = document.getElementById('btn-execute-procurement-print-footer');
    if (btnExecPrint) btnExecPrint.addEventListener('click', triggerExecuteProcurementPrint);
    if (btnExecPrintFooter) btnExecPrintFooter.addEventListener('click', triggerExecuteProcurementPrint);

    // --- Matrix UI Controls ---
    const periodGroup = document.getElementById('case-matrix-period-btns');
    if (periodGroup) {
        periodGroup.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') {
                periodGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                currentCaseDays = parseInt(e.target.getAttribute('data-days')) || 0;
                loadCaseMatrixAnalytics();
            }
        });
    }

    const catSelect = document.getElementById('case-matrix-category-filter');
    if (catSelect) {
        catSelect.addEventListener('change', (e) => {
            currentCaseCategory = e.target.value;
            loadCaseMatrixAnalytics();
        });
    }

    const brandSelect = document.getElementById('case-matrix-brand-filter');
    if (brandSelect) {
        brandSelect.addEventListener('change', (e) => {
            currentCaseBrand = e.target.value;
            loadCaseMatrixAnalytics();
        });
    }

    const refreshBtn = document.getElementById('btn-refresh-case-matrix');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadCaseMatrixAnalytics);
    }

    const btnStacked = document.getElementById('btn-case-bar-stacked');
    const btnGrouped = document.getElementById('btn-case-bar-grouped');
    if (btnStacked && btnGrouped) {
        btnStacked.addEventListener('click', () => {
            btnStacked.classList.add('active');
            btnGrouped.classList.remove('active');
            currentCaseBarMode = 'stacked';
            if (currentCaseMatrixRaw && currentCaseMatrixRaw.charts) {
                renderCaseStackedBar(currentCaseMatrixRaw.charts.stacked_bar, 'stacked');
            }
        });
        btnGrouped.addEventListener('click', () => {
            btnGrouped.classList.add('active');
            btnStacked.classList.remove('active');
            currentCaseBarMode = 'grouped';
            if (currentCaseMatrixRaw && currentCaseMatrixRaw.charts) {
                renderCaseStackedBar(currentCaseMatrixRaw.charts.stacked_bar, 'grouped');
            }
        });
    }

    const searchInput = document.getElementById('case-matrix-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            currentCaseSearchQuery = e.target.value.trim();
            renderCaseHeatmapTable();
        });
    }

    const statusGroup = document.getElementById('case-matrix-status-filter');
    if (statusGroup) {
        statusGroup.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') {
                statusGroup.querySelectorAll('button').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                currentCaseStatusFilter = e.target.getAttribute('data-status') || 'all';
                renderCaseHeatmapTable();
            }
        });
    }

    const copyBtn = document.getElementById('btn-copy-case-purchase-list');
    if (copyBtn) copyBtn.addEventListener('click', copyCasePurchaseList);

    const exportBtn = document.getElementById('btn-export-case-matrix-csv');
    if (exportBtn) exportBtn.addEventListener('click', exportCaseMatrixCSV);
});

/* =========================================================================
   CATEGORY INITIAL INFLOW & INVENTORY BALANCE
   ========================================================================= */

let currentCategoryInflowData = null;
let currentCategoryInflowSearch = '';

async function loadCategoryInflowStats() {
    const tbody = document.getElementById('category-inflow-tbody');
    if (!tbody) return;

    try {
        const res = await fetch('/api/analytics/category-inflow');
        const data = await res.json();

        if (!data.success) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-3">${data.message || 'Ошибка загрузки данных'}</td></tr>`;
            return;
        }

        currentCategoryInflowData = data;
        renderCategoryInflowTable();

    } catch (err) {
        console.error('Error in loadCategoryInflowStats:', err);
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-3">Сетевая ошибка при загрузке прихода</td></tr>`;
    }
}

function renderCategoryInflowTable() {
    const tbody = document.getElementById('category-inflow-tbody');
    if (!tbody || !currentCategoryInflowData || !currentCategoryInflowData.categories) return;

    let categories = currentCategoryInflowData.categories;

    if (currentCategoryInflowSearch) {
        const q = currentCategoryInflowSearch.toLowerCase();
        categories = categories.filter(c => c.type_name && c.type_name.toLowerCase().includes(q));
    }

    if (categories.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-muted">Типы товаров не найдены</td></tr>';
        return;
    }

    let html = '';
    categories.forEach(c => {
        const pct = c.sell_through_percent || 0;
        let barColor = '#206bc4';
        if (pct >= 40) barColor = '#00e676';
        else if (pct >= 20) barColor = '#00b0ff';
        else if (pct >= 10) barColor = '#ffd600';
        else barColor = '#7c4dff';

        html += `
            <tr>
                <td style="font-weight: 700; color: #ffffff;">
                    📁 ${c.type_name.charAt(0).toUpperCase() + c.type_name.slice(1)}
                </td>
                <td style="text-align: center; color: #94a3b8;">
                    ${c.unique_skus} поз.
                </td>
                <td style="text-align: center; font-weight: 800; color: #ffd600; font-size: 0.95rem;">
                    ${c.total_initial_qty.toLocaleString()} шт
                </td>
                <td style="text-align: center; font-size: 0.82rem; color: #cbd5e1;">
                    ${Math.round(c.total_initial_cost).toLocaleString()} сум
                </td>
                <td style="text-align: center; font-weight: 800; color: #00e676; font-size: 0.95rem;">
                    ${c.total_sold_qty.toLocaleString()} шт
                </td>
                <td style="text-align: center; font-weight: 800; color: #00b0ff; font-size: 0.95rem;">
                    ${c.current_stock_qty.toLocaleString()} шт
                </td>
                <td style="vertical-align: middle;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div style="height: 6px; flex-grow: 1; background: rgba(255,255,255,0.08); border-radius: 4px; overflow: hidden;">
                            <div style="width: ${Math.min(pct, 100)}%; height: 100%; background: ${barColor}; border-radius: 4px;"></div>
                        </div>
                        <span style="font-size: 0.78rem; font-weight: 700; color: ${barColor}; min-width: 42px; text-align: right;">${pct}%</span>
                    </div>
                </td>
                <td style="text-align: center;">
                    <button class="btn btn-secondary" onclick="openCategoryInflowModal('${c.type_name.replace(/'/g, "\\'")}')" style="font-size: 0.72rem; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15);">
                        🔍 Подробнее
                    </button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

function openCategoryInflowModal(typeName) {
    if (!currentCategoryInflowData || !currentCategoryInflowData.categories) return;

    const cat = currentCategoryInflowData.categories.find(c => c.type_name === typeName);
    if (!cat) return;

    const modal = document.getElementById('modal-category-inflow-detail');
    const title = document.getElementById('category-inflow-modal-title');
    const tbody = document.getElementById('category-inflow-modal-tbody');

    if (title) title.innerHTML = `📁 Детализация типа: <b>${typeName}</b> (Занесено: ${cat.total_initial_qty} шт • Продано: ${cat.total_sold_qty} шт • Остаток: ${cat.current_stock_qty} шт)`;

    if (tbody) {
        let itemsHtml = '';
        (cat.items || []).forEach((item, idx) => {
            itemsHtml += `
                <tr>
                    <td style="font-weight: 600; color: #fff;">${item.name}</td>
                    <td><span class="badge" style="background: rgba(255,255,255,0.08);">${item.brand || 'other'}</span></td>
                    <td style="text-align: center; font-weight: 700; color: #ffd600;">${item.initial_qty}</td>
                    <td style="text-align: center; font-weight: 700; color: #00e676;">${item.sold_qty}</td>
                    <td style="text-align: center; font-weight: 700; color: #00b0ff;">${item.current_stock}</td>
                    <td style="text-align: right; color: #94a3b8;">${Math.round(item.cost_price).toLocaleString()} сум</td>
                    <td style="text-align: right; color: #fff;">${Math.round(item.retail_price).toLocaleString()} сум</td>
                </tr>
            `;
        });
        tbody.innerHTML = itemsHtml || '<tr><td colspan="7" class="text-center py-3 text-muted">Список товаров пуст</td></tr>';
    }

    if (modal) modal.style.display = 'flex';
}

function closeCategoryInflowModal() {
    const modal = document.getElementById('modal-category-inflow-detail');
    if (modal) modal.style.display = 'none';
}

// Export Category Inflow to CSV
function exportCategoryInflowCSV() {
    if (!currentCategoryInflowData || !currentCategoryInflowData.categories) {
        showNotification('Нет данных для экспорта', true);
        return;
    }

    let csvContent = 'data:text/csv;charset=utf-8,﻿';
    csvContent += ['Тип / Категория', 'Количество SKU', 'Изначально занесено (шт)', 'Сумма закупа (сум)', 'Продано (шт)', 'Остаток на складе (шт)', 'Процент реализации (%)'].join(';') + '\n';

    currentCategoryInflowData.categories.forEach(c => {
        const row = [
            `"${c.type_name}"`,
            c.unique_skus,
            c.total_initial_qty,
            Math.round(c.total_initial_cost),
            c.total_sold_qty,
            c.current_stock_qty,
            `${c.sell_through_percent}%`
        ];
        csvContent += row.join(';') + '\n';
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `category_initial_inflow_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showNotification('📥 Баланс по типам товаров успешно экспортирован в CSV');
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('category-inflow-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            currentCategoryInflowSearch = e.target.value.trim();
            renderCategoryInflowTable();
        });
    }

    const exportBtn = document.getElementById('btn-export-category-inflow');
    if (exportBtn) exportBtn.addEventListener('click', exportCategoryInflowCSV);

    const closeBtn1 = document.getElementById('btn-close-category-inflow-modal');
    if (closeBtn1) closeBtn1.addEventListener('click', closeCategoryInflowModal);

    const closeBtn2 = document.getElementById('btn-close-category-inflow-modal-btn');
    if (closeBtn2) closeBtn2.addEventListener('click', closeCategoryInflowModal);

    /* =========================================================================
       CASHIER RECONCILIATION (AUDIT) LOGIC
       ========================================================================= */

    const reconSearchInput = document.getElementById("cashier-recon-product-search");
    const reconSearchResults = document.getElementById("cashier-recon-search-results");
    const reconSelectedArea = document.getElementById("cashier-recon-selected-area");
    const reconSelectedTitle = document.getElementById("cashier-recon-selected-title");
    const reconExpectedQty = document.getElementById("cashier-recon-expected-qty");
    const reconActualInput = document.getElementById("cashier-recon-actual-input");
    const btnReconAdd = document.getElementById("btn-cashier-recon-add");
    const reconTbody = document.getElementById("cashier-recon-tbody");
    const btnReconSubmit = document.getElementById("btn-cashier-recon-submit");
    const btnReconClear = document.getElementById("btn-cashier-recon-clear");

    // Filters and checklists
    const reconFilterModel = document.getElementById("cashier-recon-filter-model");
    const reconFilterType = document.getElementById("cashier-recon-filter-type");
    const reconFilterBrand = document.getElementById("cashier-recon-filter-brand");
    const reconFilterSuffix = document.getElementById("cashier-recon-filter-suffix");
    const reconFilterFurtherSpec = document.getElementById("cashier-recon-filter-further-spec");
    const reconFilterNote = document.getElementById("cashier-recon-filter-note");
    const reconFilterPrice = document.getElementById("cashier-recon-filter-price");
    const reconFilterSupplier = document.getElementById("cashier-recon-filter-supplier");
    const reconGroupListArea = document.getElementById("cashier-recon-group-list-area");
    const reconGroupTbody = document.getElementById("cashier-recon-group-tbody");

    let cashierReconSelectedProduct = null;
    let cashierReconList = [];

    const updateDynamicDatalistsForCashierRecon = () => {
        const dlModels = document.getElementById("cashier-recon-datalist-models");
        const dlTypes = document.getElementById("cashier-recon-datalist-types");
        const dlBrands = document.getElementById("cashier-recon-datalist-brands");
        const dlSuffixes = document.getElementById("cashier-recon-datalist-suffixes");
        const dlFurtherSpecs = document.getElementById("cashier-recon-datalist-further-specs");
        const dlNotes = document.getElementById("cashier-recon-datalist-notes");
        const dlPrices = document.getElementById("cashier-recon-datalist-prices");
        const dlSuppliers = document.getElementById("cashier-recon-datalist-suppliers");

        const models = new Set();
        const types = new Set();
        const brands = new Set();
        const suffixes = new Set();
        const furtherSpecs = new Set();
        const notes = new Set();
        const prices = new Set();
        const suppliers = new Set();

        (productsCache || []).forEach(p => {
            if (p.model) models.add(p.model.trim());
            if (p.type) types.add(p.type.trim());
            if (p.brand) brands.add(p.brand.trim());
            if (p.unique_suffix) suffixes.add(p.unique_suffix.trim());
            if (p.further_spec) furtherSpecs.add(p.further_spec.trim());
            if (p.note) notes.add(p.note.trim());
            if (p.price !== undefined && p.price !== null) prices.add(String(p.price).trim());
            if (p.supplier) suppliers.add(p.supplier.trim());
        });

        const populateDatalist = (dl, set) => {
            if (!dl) return;
            dl.innerHTML = "";
            Array.from(set).sort().forEach(val => {
                const opt = document.createElement("option");
                opt.value = val;
                dl.appendChild(opt);
            });
        };

        populateDatalist(dlModels, models);
        populateDatalist(dlTypes, types);
        populateDatalist(dlBrands, brands);
        populateDatalist(dlSuffixes, suffixes);
        populateDatalist(dlFurtherSpecs, furtherSpecs);
        populateDatalist(dlNotes, notes);
        populateDatalist(dlPrices, prices);
        populateDatalist(dlSuppliers, suppliers);
    };

    const renderCashierReconGroupList = () => {
        if (!reconGroupTbody || !reconGroupListArea) return;

        const modelVal = reconFilterModel ? reconFilterModel.value.toLowerCase().trim() : "";
        const typeVal = reconFilterType ? reconFilterType.value.toLowerCase().trim() : "";
        const brandVal = reconFilterBrand ? reconFilterBrand.value.toLowerCase().trim() : "";
        const suffixVal = reconFilterSuffix ? reconFilterSuffix.value.toLowerCase().trim() : "";
        const furtherSpecVal = reconFilterFurtherSpec ? reconFilterFurtherSpec.value.toLowerCase().trim() : "";
        const noteVal = reconFilterNote ? reconFilterNote.value.toLowerCase().trim() : "";
        const priceVal = reconFilterPrice ? reconFilterPrice.value.toLowerCase().trim() : "";
        const supplierVal = reconFilterSupplier ? reconFilterSupplier.value.toLowerCase().trim() : "";

        if (!modelVal && !typeVal && !brandVal && !suffixVal && !furtherSpecVal && !noteVal && !priceVal && !supplierVal) {
            reconGroupListArea.style.display = "none";
            reconGroupTbody.innerHTML = "";
            return;
        }

        const matches = (productsCache || []).filter(p => {
            const m = (p.model || "").toLowerCase().trim();
            const t = (p.type || "").toLowerCase().trim();
            const b = (p.brand || "").toLowerCase().trim();
            const s = (p.unique_suffix || "").toLowerCase().trim();
            const f = (p.further_spec || "").toLowerCase().trim();
            const n = (p.note || "").toLowerCase().trim();
            const pr = String(p.price || "").toLowerCase().trim();
            const sup = (p.supplier || "").toLowerCase().trim();

            if (modelVal && !m.includes(modelVal)) return false;
            if (typeVal && !t.includes(typeVal)) return false;
            if (brandVal && !b.includes(brandVal)) return false;
            if (suffixVal && !s.includes(suffixVal)) return false;
            if (furtherSpecVal && !f.includes(furtherSpecVal)) return false;
            if (noteVal && !n.includes(noteVal)) return false;
            if (priceVal && !pr.includes(priceVal)) return false;
            if (supplierVal && !sup.includes(supplierVal)) return false;
            return true;
        }).slice(0, 100);

        if (matches.length === 0) {
            reconGroupTbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-secondary); padding: 10px;">Товары не найдены</td></tr>`;
        } else {
            reconGroupTbody.innerHTML = matches.map(p => {
                const existing = cashierReconList.find(x => x.id === p.id);
                const actualValue = existing ? existing.actual : "";
                const displayName = p.unique_suffix ? `${p.model} [${p.unique_suffix}]` : p.name;

                return `
                    <tr data-prod-id="${p.id}">
                        <td style="color: #fff; font-weight: 500;">${displayName}</td>
                        <td style="text-align: center; color: #ffd600; font-weight: 700;">${p.stock}</td>
                        <td style="text-align: center;">
                            <input type="number" class="cashier-recon-group-input" data-id="${p.id}" min="0" value="${actualValue}" placeholder="Факт" style="width: 60px; padding: 4px; border-radius: 4px; background: rgba(0,0,0,0.3); border: 1px solid var(--border-color); color: #fff; text-align: center; font-weight: 700;">
                        </td>
                    </tr>
                `;
            }).join('');

            // Bind input change handlers
            reconGroupTbody.querySelectorAll(".cashier-recon-group-input").forEach(input => {
                input.addEventListener("input", () => {
                    const id = parseInt(input.getAttribute("data-id"));
                    const prod = (productsCache || []).find(p => p.id === id);
                    if (!prod) return;

                    const val = input.value.trim();
                    if (val === "") {
                        cashierReconList = cashierReconList.filter(x => x.id !== id);
                    } else {
                        const actualQty = parseInt(val);
                        if (!isNaN(actualQty) && actualQty >= 0) {
                            const diff = actualQty - prod.stock;
                            const item = {
                                id: prod.id,
                                name: prod.name,
                                expected: prod.stock,
                                actual: actualQty,
                                diff: diff
                            };

                            const idx = cashierReconList.findIndex(x => x.id === id);
                            if (idx !== -1) {
                                cashierReconList[idx] = item;
                            } else {
                                cashierReconList.push(item);
                            }
                        }
                    }
                    renderCashierReconTable();
                });
            });
        }
        reconGroupListArea.style.display = "block";
    };

    const cashierNavSalesBtn = document.getElementById("cashier-nav-sales-btn");
    const cashierNavReconBtn = document.getElementById("cashier-nav-recon-btn");
    const cashierSalesPanel = document.getElementById("cashier-sales-panel");
    const cashierReconPanel = document.getElementById("cashier-recon-panel");

    if (cashierNavSalesBtn && cashierNavReconBtn && cashierSalesPanel && cashierReconPanel) {
        cashierNavSalesBtn.addEventListener("click", () => {
            cashierNavSalesBtn.classList.add("active");
            cashierNavReconBtn.classList.remove("active");
            cashierSalesPanel.style.display = "grid";
            cashierReconPanel.style.display = "none";
        });
        cashierNavReconBtn.addEventListener("click", () => {
            cashierNavReconBtn.classList.add("active");
            cashierNavSalesBtn.classList.remove("active");
            cashierSalesPanel.style.display = "none";
            cashierReconPanel.style.display = "grid";
            
            // Refresh products cache and datalists when switching to audit tab
            if (typeof loadProducts === 'function') {
                loadProducts().then(() => {
                    updateDynamicDatalistsForCashierRecon();
                });
            } else {
                updateDynamicDatalistsForCashierRecon();
            }
        });
    }

    [
        reconFilterModel, reconFilterType, reconFilterBrand, reconFilterSuffix,
        reconFilterFurtherSpec, reconFilterNote, reconFilterPrice, reconFilterSupplier
    ].forEach(el => {
        if (el) {
            // Update datalists dynamically when focused or typed in
            el.addEventListener("focus", updateDynamicDatalistsForCashierRecon);
            el.addEventListener("input", updateDynamicDatalistsForCashierRecon);
            el.addEventListener("input", renderCashierReconGroupList);
            
            // Force dropdown menu list to show instantly on click/mousedown
            el.addEventListener("mousedown", function() {
                if (this.value === "") {
                    this.value = " "; 
                    setTimeout(() => { this.value = ""; }, 1);
                }
            });
            el.addEventListener("focus", function() {
                this.select();
            });
        }
    });

    if (reconSearchInput && reconSearchResults) {
        reconSearchInput.addEventListener("input", () => {
            const query = reconSearchInput.value.toLowerCase().trim();
            if (!query) {
                reconSearchResults.style.display = "none";
                reconSearchResults.innerHTML = "";
                return;
            }

            const matches = (productsCache || []).filter(p => {
                const name = (p.name || "").toLowerCase();
                const barcode = (p.barcode || "").toLowerCase();
                const type = (p.type || "").toLowerCase();
                const brand = (p.brand || "").toLowerCase();
                const model = (p.model || "").toLowerCase();
                const suffix = (p.unique_suffix || "").toLowerCase();

                return name.includes(query) || barcode.includes(query) || type.includes(query) ||
                       brand.includes(query) || model.includes(query) || suffix.includes(query);
            }).slice(0, 15);

            if (matches.length === 0) {
                reconSearchResults.innerHTML = `<div style="padding: 10px; color: #94a3b8; font-size: 0.8rem; text-align: center;">Ничего не найдено</div>`;
            } else {
                reconSearchResults.innerHTML = matches.map(p => `
                    <button type="button" class="recon-search-item" style="width: 100%; text-align: left; padding: 8px 12px; background: none; border: none; border-bottom: 1px solid rgba(255,255,255,0.05); color: #fff; cursor: pointer; font-size: 0.82rem;" data-id="${p.id}">
                        <b>[${p.barcode}]</b> ${p.name} <span style="color: #00b0ff; font-weight: 700;">(ост: ${p.stock})</span>
                    </button>
                `).join('');
            }
            reconSearchResults.style.display = "block";

            // Bind click handlers to items
            reconSearchResults.querySelectorAll(".recon-search-item").forEach(btn => {
                btn.addEventListener("click", () => {
                    const id = parseInt(btn.getAttribute("data-id"));
                    const prod = (productsCache || []).find(p => p.id === id);
                    if (prod) {
                        cashierReconSelectedProduct = prod;
                        reconSelectedTitle.textContent = prod.name;
                        reconExpectedQty.textContent = `${prod.stock} шт`;
                        reconActualInput.value = "";
                        reconSelectedArea.style.display = "block";
                        reconSearchResults.style.display = "none";
                        reconSearchInput.value = "";
                        setTimeout(() => {
                            reconActualInput.focus();
                            reconActualInput.select();
                        }, 50);
                    }
                });
            });
        });

        // Add Enter keydown event listener for barcode scanner
        reconSearchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const query = reconSearchInput.value.trim().toLowerCase();
                if (!query) return;

                // Instant map lookup for scanned barcode (0ms)
                let prod = productsBarcodeMap.get(query) || productsBarcodeMap.get(query.replace(/\D/g, ""));
                if (!prod) {
                    const matches = (productsCache || []).filter(p => {
                        const barcode = (p.barcode || "").toLowerCase().trim();
                        const name = (p.name || "").toLowerCase().trim();
                        return barcode === query || name === query;
                    });
                    prod = matches[0];
                }
                if (!prod) {
                    prod = (productsCache || []).find(p => {
                        const name = (p.name || "").toLowerCase();
                        const barcode = (p.barcode || "").toLowerCase();
                        return name.includes(query) || barcode.includes(query);
                    });
                }

                if (prod) {
                    const isExactBarcode = (prod.barcode || "").toLowerCase().trim() === query;

                    if (isExactBarcode) {
                        // Increment by +1 directly on barcode scan!
                        const existingIdx = cashierReconList.findIndex(x => x.id === prod.id);
                        if (existingIdx !== -1) {
                            cashierReconList[existingIdx].actual += 1;
                            cashierReconList[existingIdx].diff = cashierReconList[existingIdx].actual - cashierReconList[existingIdx].expected;
                        } else {
                            cashierReconList.push({
                                id: prod.id,
                                name: prod.name,
                                expected: prod.stock,
                                actual: 1,
                                diff: 1 - prod.stock
                            });
                        }

                        // Play success audio feedback
                        if (typeof playSuccessBeep === 'function') {
                            playSuccessBeep();
                        } else if (typeof playScanBeep === 'function') {
                            playScanBeep();
                        }

                        renderCashierReconTable();

                        // Reset search fields and keep focus on it for continuous scanning!
                        reconSearchInput.value = "";
                        reconSearchResults.style.display = "none";
                        reconSelectedArea.style.display = "none";
                        reconSearchInput.focus();
                    } else {
                        // For text search queries, open custom quantity pane
                        cashierReconSelectedProduct = prod;
                        reconSelectedTitle.textContent = prod.name;
                        reconExpectedQty.textContent = `${prod.stock} шт`;
                        reconActualInput.value = "";
                        reconSelectedArea.style.display = "block";
                        reconSearchResults.style.display = "none";
                        reconSearchInput.value = "";
                        setTimeout(() => {
                            reconActualInput.focus();
                            reconActualInput.select();
                        }, 50);
                    }
                } else {
                    showNotification("Товар не найден", true);
                }
            }
        });

        // Hide search results on click outside
        document.addEventListener("click", (e) => {
            if (!reconSearchInput.contains(e.target) && !reconSearchResults.contains(e.target)) {
                reconSearchResults.style.display = "none";
            }
        });
    }

    const renderCashierReconTable = () => {
        if (!reconTbody) return;

        // Re-sync input elements in the group checklist table
        if (reconGroupTbody) {
            reconGroupTbody.querySelectorAll(".cashier-recon-group-input").forEach(input => {
                const id = parseInt(input.getAttribute("data-id"));
                const item = cashierReconList.find(x => x.id === id);
                input.value = item ? item.actual : "";
            });
        }

        if (cashierReconList.length === 0) {
            reconTbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-secondary); padding: 15px;">Список пуст</td></tr>`;
            return;
        }

        reconTbody.innerHTML = cashierReconList.map((item, index) => {
            let diffText = "";
            let diffStyle = "";
            if (item.diff > 0) {
                diffText = `+${item.diff} шт`;
                diffStyle = "color: #00e676; font-weight: 700;";
            } else if (item.diff < 0) {
                diffText = `${item.diff} шт`;
                diffStyle = "color: #ff5252; font-weight: 700;";
            } else {
                diffText = "0 шт";
                diffStyle = "color: #94a3b8;";
            }

            return `
                <tr>
                    <td style="font-weight: 600; color: #fff;">${item.name}</td>
                    <td style="text-align: center; color: #ffd600; font-weight: 700;">${item.expected}</td>
                    <td style="text-align: center; color: #00b0ff; font-weight: 700;">${item.actual}</td>
                    <td style="text-align: center; ${diffStyle}">${diffText}</td>
                    <td style="text-align: center;">
                        <button type="button" class="btn-remove-recon-item" data-index="${index}" style="background: none; border: none; color: #ff5252; font-size: 1.1rem; cursor: pointer; padding: 0;">&times;</button>
                    </td>
                </tr>
            `;
        }).join('');

        // Bind delete buttons
        reconTbody.querySelectorAll(".btn-remove-recon-item").forEach(btn => {
            btn.addEventListener("click", () => {
                const idx = parseInt(btn.getAttribute("data-index"));
                cashierReconList.splice(idx, 1);
                renderCashierReconTable();
            });
        });
    };

    const addProductToReconSession = () => {
        if (!cashierReconSelectedProduct) return;
        const actualVal = reconActualInput.value.trim();
        if (actualVal === "") {
            showNotification("Введите фактическое количество", true);
            return;
        }

        const actualQty = parseInt(actualVal);
        if (isNaN(actualQty) || actualQty < 0) {
            showNotification("Неверное количество", true);
            return;
        }

        const diff = actualQty - cashierReconSelectedProduct.stock;
        const item = {
            id: cashierReconSelectedProduct.id,
            name: cashierReconSelectedProduct.name,
            expected: cashierReconSelectedProduct.stock,
            actual: actualQty,
            diff: diff
        };

        const existingIdx = cashierReconList.findIndex(x => x.id === item.id);
        if (existingIdx !== -1) {
            cashierReconList[existingIdx] = item;
        } else {
            cashierReconList.push(item);
        }

        renderCashierReconTable();

        // Clear select area
        cashierReconSelectedProduct = null;
        reconSelectedArea.style.display = "none";
        reconSearchInput.value = "";
        reconSearchInput.focus();
    };

    if (btnReconAdd) {
        btnReconAdd.addEventListener("click", addProductToReconSession);
    }
    if (reconActualInput) {
        reconActualInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                addProductToReconSession();
            }
        });
    }

    if (btnReconClear) {
        btnReconClear.addEventListener("click", () => {
            cashierReconList = [];
            if (reconFilterModel) reconFilterModel.value = "";
            if (reconFilterType) reconFilterType.value = "";
            if (reconGroupListArea) reconGroupListArea.style.display = "none";
            renderCashierReconTable();
            showNotification("Список ревизии очищен");
        });
    }

    if (btnReconSubmit) {
        btnReconSubmit.addEventListener("click", async () => {
            if (cashierReconList.length === 0) {
                showNotification("Добавьте хотя бы один товар в список ревизии", true);
                return;
            }

            const adjustments = cashierReconList.filter(x => x.diff !== 0);
            if (adjustments.length === 0) {
                showNotification("Нет выявленных расхождений для отправки владельцу", false);
                cashierReconList = [];
                if (reconFilterModel) reconFilterModel.value = "";
                if (reconFilterType) reconFilterType.value = "";
                if (reconGroupListArea) reconGroupListArea.style.display = "none";
                renderCashierReconTable();
                return;
            }

            try {
                const res = await fetch("/api/audit/save-mismatches", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ adjustments: adjustments })
                });
                const data = await res.json();

                if (data.success) {
                    showNotification(`Отчет о ревизии отправлен! Зафиксировано ${adjustments.length} расхождений.`);
                    cashierReconList = [];
                    if (reconFilterModel) reconFilterModel.value = "";
                    if (reconFilterType) reconFilterType.value = "";
                    if (reconGroupListArea) reconGroupListArea.style.display = "none";
                    renderCashierReconTable();
                } else {
                    showNotification(data.message || "Ошибка отправки ревизии", true);
                }
            } catch (err) {
                console.error("Error submitting audit report:", err);
                showNotification("Сетевая ошибка при отправке ревизии", true);
            }
        });
    }
});
