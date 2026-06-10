// ═══════════════════════════════════════════════════════════════
// 1. CONSTANTS AND STATE
// ═══════════════════════════════════════════════════════════════
const STORAGE_KEY = 'lume_inventory_products_v6_clean';
const HISTORY_KEY = 'lume_inventory_history_v6_clean';
const THEME_KEY = 'lume_inventory_theme_v1';
const USERS_KEY = 'lume_inventory_users_v6_clean';
const LEGACY_USERS_KEY = 'lume_inventory_users_v2';
const SESSION_KEY = 'lume_inventory_session_v6_clean';
const SESSION_STARTED_KEY = 'lume_inventory_session_started_v6_clean';
const DELETED_PRODUCTS_KEY = 'lume_inventory_deleted_products_v6_clean';
const DELETED_ARCHIVE_KEY = 'lume_inventory_deleted_archive_v6_clean';
const STORAGE_VERSION_KEY = 'lume_inventory_storage_version_v7';
const BACKUP_PREFIX = 'lume_inventory_auto_backup_';
const CURRENT_STORAGE_VERSION = 7;
const SESSION_MAX_MS = 1000 * 60 * 60 * 8;
const IDLE_LOCK_MS = 1000 * 60 * 60;
const MOVEMENT_TYPES = ['RECEIVE', 'TRANSFER', 'SALE', 'ADJUST', 'DELETE', 'RESTORE', 'CREATE', 'EDIT'];

const OWNER_SEED_USER = {
  id: 'owner-mehdi-locked',
  name: 'Mehdi',
  email: 'mehdi@lume.ma',
  phone: '',
  role: 'admin',
  active: true,
  createdAt: '2026-06-10T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  salt: '8bcac070f5a47c9498e60a6d6f2e5f51',
  passwordHash: '9e7c27f4e0dd5c2c10e418d50eb4074670fe9c97a6d9cb10f4881f248383dcda'
};
function ensureOwnerSeed() {
  const exists = users.some(u => normalizeEmail(u.email) === normalizeEmail(OWNER_SEED_USER.email));
  if (!exists) users.unshift({ ...OWNER_SEED_USER });
}

let products = [];
let history = [];
let users = [];
let deletedArchive = [];
let currentUser = null;
let activeSku = null;
let visualIndex = new Map();
let receiveDraft = {};
let productFormMode = 'create';
let eventsBound = false;
let productScriptPromise = null;
let lastActivityAt = Date.now();
let productsDataError = null;
let appReady = false;

const $ = id => document.getElementById(id);
const has = id => Boolean($(id));

function requiredElement(id, required = true) {
  const el = $(id);
  if (!el && required) console.error(`[LUME] Missing element: #${id}`);
  return el;
}
function on(id, event, handler, required = false) {
  const el = requiredElement(id, required);
  if (!el) return false;
  el.addEventListener(event, handler);
  return true;
}
function onClick(id, handler, required = false) { return on(id, 'click', handler, required); }

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}
function escapeAttr(s = '') { return escapeHtml(s); }
function normSku(s) { return String(s || '').trim(); }
function total(p) { return (Number(p.mediounaQty) || 0) + (Number(p.socrateQty) || 0); }
function safeJson(raw, fallback) {
  if (raw === null || raw === undefined || raw === '' || raw === 'null' || raw === 'undefined') return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch { return fallback; }
}

// ═══════════════════════════════════════════════════════════════
// 2. STORAGE HELPERS
// ═══════════════════════════════════════════════════════════════
function readArrayStorage(key, fallback = []) {
  const raw = localStorage.getItem(key);
  if (raw === null || raw === undefined || raw === '' || raw === 'null' || raw === 'undefined') return [...fallback];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[LUME storage] "${key}" is not an array (${typeof parsed}). Using fallback.`);
      return [...fallback];
    }
    return parsed;
  } catch (err) {
    console.warn(`[LUME storage] "${key}" corrupted:`, err.message);
    return [...fallback];
  }
}
function writeArrayStorage(key, value) {
  if (!Array.isArray(value)) { console.error(`[LUME storage] Refused to write non-array to "${key}"`); return false; }
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (err) { console.error(`[LUME storage] Write failed for "${key}":`, err.message); toast('Storage full or blocked', 'danger'); return false; }
}
function readObjectStorage(key, fallback = null) {
  const raw = localStorage.getItem(key);
  if (raw === null || raw === undefined || raw === '' || raw === 'null' || raw === 'undefined') return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[LUME storage] "${key}" is not an object. Using fallback.`);
      return fallback;
    }
    return parsed;
  } catch (err) {
    console.warn(`[LUME storage] "${key}" corrupted:`, err.message);
    return fallback;
  }
}
function createStorageBackup(label = 'auto') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupKey = `${BACKUP_PREFIX}${label}_${ts}`;
  const snapshot = {
    version: CURRENT_STORAGE_VERSION,
    label,
    createdAt: nowIso(),
    products: localStorage.getItem(STORAGE_KEY),
    history: localStorage.getItem(HISTORY_KEY),
    users: localStorage.getItem(USERS_KEY),
    deleted: localStorage.getItem(DELETED_PRODUCTS_KEY),
    archive: localStorage.getItem(DELETED_ARCHIVE_KEY)
  };
  try {
    localStorage.setItem(backupKey, JSON.stringify(snapshot));
    console.log(`[LUME storage] Backup created: ${backupKey}`);
    return backupKey;
  } catch (err) {
    console.warn('[LUME storage] Could not create backup:', err.message);
    return null;
  }
}
function storageHealthCheck() {
  const issues = [];
  const checks = [
    { key: STORAGE_KEY, type: 'array' },
    { key: HISTORY_KEY, type: 'array' },
    { key: DELETED_PRODUCTS_KEY, type: 'array' },
    { key: DELETED_ARCHIVE_KEY, type: 'array' },
    { key: USERS_KEY, type: 'array' }
  ];
  checks.forEach(({ key, type }) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return;
    if (raw === 'null' || raw === 'undefined' || raw === '') { issues.push({ key, problem: 'empty/null string' }); return; }
    try {
      const parsed = JSON.parse(raw);
      if (type === 'array' && !Array.isArray(parsed)) issues.push({ key, problem: `expected array, got ${typeof parsed}` });
    } catch { issues.push({ key, problem: 'invalid JSON' }); }
  });
  if (issues.length) console.warn('[LUME storage] Health issues found:', issues);
  return issues;
}
function migrateStorageSafely() {
  const currentVer = Number(localStorage.getItem(STORAGE_VERSION_KEY) || '0');
  if (currentVer >= CURRENT_STORAGE_VERSION) return;
  createStorageBackup('pre-migration');
  const legacyProducts = localStorage.getItem('lume_inventory_products_v1');
  if (legacyProducts && !localStorage.getItem(STORAGE_KEY)) {
    localStorage.setItem(STORAGE_KEY, legacyProducts);
    console.log('[LUME migration] Migrated products from v1 key');
  }
  if (!Array.isArray(readArrayStorage(DELETED_PRODUCTS_KEY))) writeArrayStorage(DELETED_PRODUCTS_KEY, []);
  if (!Array.isArray(readArrayStorage(DELETED_ARCHIVE_KEY))) writeArrayStorage(DELETED_ARCHIVE_KEY, []);
  if (!Array.isArray(readArrayStorage(HISTORY_KEY))) writeArrayStorage(HISTORY_KEY, []);
  localStorage.setItem(STORAGE_VERSION_KEY, String(CURRENT_STORAGE_VERSION));
  console.log(`[LUME migration] Storage migrated to v${CURRENT_STORAGE_VERSION}`);
}

function canAdmin() { return currentUser && currentUser.role === 'admin' && currentUser.active !== false; }
function requireLogin() { if (!currentUser) { showLogin(); return false; } return true; }
function requireAdmin() { if (!requireLogin()) return false; if (!canAdmin()) { toast('Admin access required'); return false; } return true; }
function nowIso() { return new Date().toISOString(); }
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function validEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email)); }

function save() {
  writeArrayStorage(STORAGE_KEY, products);
  writeArrayStorage(HISTORY_KEY, history);
}
function saveUsers() { writeArrayStorage(USERS_KEY, users); }
function getDeletedSkus() { return new Set(readArrayStorage(DELETED_PRODUCTS_KEY).map(normSku).filter(Boolean)); }
function saveDeletedSkus(set) { writeArrayStorage(DELETED_PRODUCTS_KEY, [...set].map(normSku).filter(Boolean)); }
function saveDeletedArchive() { writeArrayStorage(DELETED_ARCHIVE_KEY, deletedArchive); }

function toast(msg, type = 'info') {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.dataset.type = type;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function randomId(prefix = 'id') {
  if (crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function randomSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256(text) {
  if (!crypto?.subtle) throw new Error('Secure password hashing requires HTTPS or localhost. Use GitHub Pages HTTPS.');
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password, salt = randomSalt()) {
  const hash = await sha256(`${salt}:lume-inventory-v3:${password}`);
  return { salt, passwordHash: hash };
}
async function verifyPassword(user, password) {
  if (!user || user.active === false) return false;
  if (user.passwordHash && user.salt) {
    const { passwordHash } = await hashPassword(password, user.salt);
    return passwordHash === user.passwordHash;
  }
  // Legacy support for old exported backups only. New saves remove plaintext pins.
  return user.pin ? String(user.pin) === String(password) : false;
}
function publicUser(u) {
  const { pin, ...clean } = u;
  return clean;
}

async function loadUsers() {
  const saved = readArrayStorage(USERS_KEY, []);
  if (saved.length) {
    users = saved;
    ensureOwnerSeed();
    saveUsers();
    return;
  }

  const legacy = readArrayStorage(LEGACY_USERS_KEY, []);
  if (legacy.length) {
    const migrated = [];
    for (const u of legacy) {
      const isWeakDefault = String(u.id || '') === 'admin-mehdi' && String(u.pin || '') === '0000';
      if (isWeakDefault && legacy.length === 1) continue;
      const password = String(u.pin || '').trim();
      if (!password || password === '0000') continue;
      const secure = await hashPassword(password);
      migrated.push({
        id: u.id || randomId('user'),
        name: String(u.name || '').trim() || 'User',
        email: normalizeEmail(u.email),
        phone: String(u.phone || '').trim(),
        role: u.role === 'admin' ? 'admin' : 'sales',
        active: u.active !== false,
        createdAt: u.createdAt || nowIso(),
        updatedAt: nowIso(),
        ...secure
      });
    }
    users = migrated;
    ensureOwnerSeed();
    saveUsers();
    return;
  }

  users = [{ ...OWNER_SEED_USER }];
  saveUsers();
}
function activeAdmins() { return users.filter(u => u.active !== false && u.role === 'admin'); }

async function init() {
  console.log('[LUME] App starting…');
  document.documentElement.dataset.theme = localStorage.getItem(THEME_KEY) || 'light';
  storageHealthCheck();
  migrateStorageSafely();
  await loadUsers();
  console.log('[LUME] Users loaded:', users.length);
  bindAuthOnly();
  if (!users.length || !activeAdmins().length) {
    users = [{ ...OWNER_SEED_USER }];
    saveUsers();
  }
  const sessionId = sessionStorage.getItem(SESSION_KEY);
  const sessionStarted = Number(sessionStorage.getItem(SESSION_STARTED_KEY) || '0');
  currentUser = users.find(u => u.id === sessionId && u.active !== false) || null;
  if (!currentUser || (Date.now() - sessionStarted) > SESSION_MAX_MS) {
    logout(false);
    showLogin();
    console.log('[LUME] Awaiting login');
    return;
  }
  await startWorkspace();
}

function bindAuthOnly() {
  $('loginBtn')?.addEventListener('click', login);
  $('loginPin')?.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('loginEmail')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('loginPin')?.focus(); });
}

function showSetup() { showLogin(); }
function showLogin() {
  $('authOverlay')?.classList.remove('hidden');
  $('setupPanel')?.classList.add('hidden');
  $('loginPanel')?.classList.remove('hidden');
  $('appContent')?.classList.add('hidden');
  document.body.classList.remove('modal-open');
  document.body.style.overflow = '';
  if ($('loginPin')) $('loginPin').value = '';
  setTimeout(() => $('loginEmail')?.focus(), 250);
}
function showApp() {
  $('authOverlay')?.classList.add('hidden');
  $('appContent')?.classList.remove('hidden');
  document.body.style.overflow = '';
}

async function createOwnerAccount() {
  toast('Owner registration is locked. Login with the administrator account.', 'warn');
  showLogin();
}


async function login() {
  const email = normalizeEmail($('loginEmail').value);
  const password = $('loginPin').value;
  if (!email || !password) return toast('Enter email and password', 'warn');

  const u = users.find(x => normalizeEmail(x.email) === email && x.active !== false);
  let ok = false;
  try { ok = await verifyPassword(u, password); } catch (err) { return toast(err.message, 'danger'); }
  if (!ok) {
    $('loginPin').value = '';
    $('loginPin').focus();
    return toast('Invalid email or password', 'danger');
  }

  currentUser = u;
  sessionStorage.setItem(SESSION_KEY, u.id);
  sessionStorage.setItem(SESSION_STARTED_KEY, String(Date.now()));
  await startWorkspace();
  toast(`Welcome, ${u.name}`, 'success');
}

function setLoading(on, msg = 'Loading inventory…') {
  const el = $('loadingOverlay');
  if (!el) return;
  el.classList.toggle('visible', on);
  const txt = $('loadingText');
  if (txt) txt.textContent = msg;
}
function setErrorBanner(msg) {
  const el = $('errorBanner');
  if (!el) return;
  if (msg) { el.textContent = msg; el.classList.add('visible'); }
  else el.classList.remove('visible');
}

async function startWorkspace() {
  showApp();
  setLoading(true);
  setErrorBanner(null);
  productsDataError = null;
  try {
    await ensureProductDataLoaded();
    console.log('[LUME] products-data loaded:', Array.isArray(window.LUME_PRODUCTS) ? window.LUME_PRODUCTS.length : 0);
  } catch (err) {
    productsDataError = err.message;
    setErrorBanner(`Product catalog error: ${err.message}. Using saved data only.`);
    console.error('[LUME] products-data failed:', err.message);
  }
  loadProducts();
  console.log('[LUME] Storage loaded:', products.length, 'products,', history.length, 'history records');
  bindEvents();
  console.log('[LUME] Events bound');
  populateCategories();
  render();
  applyRoleUi();
  resetIdleTimer();
  setLoading(false);
  appReady = true;
  console.log('[LUME] Render complete');
}
function logout(show = true) {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_STARTED_KEY);
  currentUser = null;
  activeSku = null;
  if ($('productGrid')) $('productGrid').innerHTML = '';
  if ($('usersList')) $('usersList').innerHTML = '';
  closeAllShells();
  if (show) showLogin();
}
function resetIdleTimer() { lastActivityAt = Date.now(); }
setInterval(() => {
  if (!currentUser) return;
  if (Date.now() - lastActivityAt > IDLE_LOCK_MS) {
    logout(true);
    toast('Session locked for security', 'warn');
  }
}, 30000);
['click', 'keydown', 'touchstart', 'mousemove'].forEach(ev => window.addEventListener(ev, resetIdleTimer, { passive: true }));

function ensureProductDataLoaded() {
  if (Array.isArray(window.LUME_PRODUCTS)) return Promise.resolve();
  if (productScriptPromise) return productScriptPromise;
  productScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'products-data.js';
    script.onload = () => Array.isArray(window.LUME_PRODUCTS) ? resolve() : reject(new Error('Product file loaded but no products found'));
    script.onerror = () => reject(new Error('Could not load products-data.js'));
    document.body.appendChild(script);
  });
  return productScriptPromise.catch(err => { toast(err.message, 'danger'); throw err; });
}

function normalizeProduct(p) {
  return {
    ...p,
    price1: p.price1 ?? p.price ?? '',
    price2: p.price2 ?? '',
    price3: p.price3 ?? '',
    mediounaQty: Number(p.mediounaQty) || 0,
    socrateQty: Number(p.socrateQty) || 0,
    lowStockLimit: Number(p.lowStockLimit ?? 2) || 0,
    searchImages: Array.isArray(p.searchImages) ? p.searchImages : []
  };
}
// ═══════════════════════════════════════════════════════════════
// 5. PRODUCT LOADING
// ═══════════════════════════════════════════════════════════════
function loadProducts() {
  const savedList = readArrayStorage(STORAGE_KEY);
  const savedMap = new Map(savedList.map(p => [normSku(p.sku), p]).filter(([k]) => k));
  const deletedSkus = getDeletedSkus();
  deletedArchive = readArrayStorage(DELETED_ARCHIVE_KEY);
  const baseList = Array.isArray(window.LUME_PRODUCTS) ? window.LUME_PRODUCTS : [];
  const baseSkuSet = new Set(baseList.map(p => normSku(p.sku)));

  if (baseList.length) {
    products = baseList
      .filter(p => !deletedSkus.has(normSku(p.sku)))
      .map(p => normalizeProduct({ ...p, ...(savedMap.get(normSku(p.sku)) || {}) }));
  } else {
    products = savedList
      .filter(p => !deletedSkus.has(normSku(p.sku)))
      .map(normalizeProduct);
    if (!products.length && productsDataError) console.warn('[LUME] No catalog and no saved products');
  }

  savedList.forEach(p => {
    const sku = normSku(p.sku);
    if (!sku || deletedSkus.has(sku) || baseSkuSet.has(sku)) return;
    products.push(normalizeProduct({ ...p, isCustom: p.isCustom !== false }));
  });

  history = readArrayStorage(HISTORY_KEY);
}

// ═══════════════════════════════════════════════════════════════
// 7. EVENTS
// ═══════════════════════════════════════════════════════════════
function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;

  on('searchInput', 'input', () => {
    render();
    $('clearSearch')?.classList.toggle('visible', Boolean($('searchInput')?.value));
  });
  onClick('clearSearch', () => { if ($('searchInput')) $('searchInput').value = ''; $('clearSearch')?.classList.remove('visible'); render(); });
  on('categoryFilter', 'change', render);
  on('stockFilter', 'change', render);
  onClick('themeBtn', toggleTheme);
  onClick('logoutBtn', () => logout(true));

  onClick('backupBtn', exportBackup);
  on('backupInput', 'change', importBackup);
  onClick('exportStockBtn', exportCurrentStock);
  onClick('historyBtn', openGlobalHistory);
  onClick('restoreBtn', openRestoreModal);
  onClick('imageSearchBtn', () => { resetImageSearchUi(); openShell('imageModal'); });
  on('imageInput', 'change', handleImageSearch);
  on('refImageInput', 'change', addReferencePhoto);
  onClick('clearRefsBtn', clearReferencePhotos);

  on('productGrid', 'click', e => {
    const card = e.target.closest('.product-card');
    if (card?.dataset.sku) openProduct(card.dataset.sku);
  });
  on('imageResults', 'click', e => {
    const item = e.target.closest('.image-result');
    if (item?.dataset.sku) openProduct(item.dataset.sku);
  });
  on('refGallery', 'click', e => {
    const btn = e.target.closest('[data-ref-id]');
    if (btn) removeReferencePhoto(btn.dataset.refId);
  });
  on('usersList', 'click', e => {
    const btn = e.target.closest('[data-user-action]');
    if (!btn) return;
    if (btn.dataset.userAction === 'toggle') toggleUser(btn.dataset.userId);
    if (btn.dataset.userAction === 'delete') deleteUser(btn.dataset.userId);
  });
  on('restoreList', 'click', e => {
    const btn = e.target.closest('[data-restore-sku]');
    if (btn) restoreProduct(btn.dataset.restoreSku);
  });

  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeShell(b.dataset.close)));
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  onClick('manageUsersBtn', () => { if (requireAdmin()) { renderUsers(); openShell('usersModal'); } });
  onClick('newProductBtn', openNewProductModal);
  onClick('receiveBulkBtn', openBulkReceiveModal);
  onClick('addUserBtn', addUser);
  onClick('exportUsersBtn', exportUsers);

  onClick('saveProductBtn', saveProductEdits);
  onClick('deleteProductBtn', deleteActiveProduct);
  onClick('sellBtn', sellFromSocrate);
  onClick('singleReceiveBtn', receiveSingleProduct);
  onClick('transferBtn', transferToSocrate);
  onClick('adjustBtn', adjustStock);
  onClick('createProductBtn', createProductFromForm);
  on('bulkReceiveSearch', 'input', renderBulkReceiveProducts);
  onClick('bulkReceiveClearBtn', clearBulkReceiveDraft);
  onClick('bulkReceiveConfirmBtn', confirmBulkReceive);
  on('bulkReceiveRows', 'input', e => {
    const input = e.target.closest('[data-receive-qty]');
    if (!input) return;
    const sku = input.dataset.sku;
    const val = Math.max(0, Number(input.value) || 0);
    if (val > 0) receiveDraft[sku] = val;
    else delete receiveDraft[sku];
    updateBulkReceiveSummary();
  });

  onClick('exportHistoryBtn', () => exportHistory(activeSku));
  onClick('clearHistoryBtn', clearProductHistory);

  on('historySearch', 'input', renderGlobalHistory);
  on('historyTypeFilter', 'change', renderGlobalHistory);
  on('historyHubFilter', 'change', renderGlobalHistory);
  on('historyCategoryFilter', 'change', renderGlobalHistory);
  on('historyDateFrom', 'change', renderGlobalHistory);
  on('historyDateTo', 'change', renderGlobalHistory);
  on('historyBlFilter', 'input', renderGlobalHistory);
  onClick('historyTodayBtn', () => setHistoryPeriod('today'));
  onClick('historyMonthBtn', () => setHistoryPeriod('month'));
  onClick('historyClearPeriodBtn', () => { if ($('historyDateFrom')) $('historyDateFrom').value = ''; if ($('historyDateTo')) $('historyDateTo').value = ''; renderGlobalHistory(); });
  onClick('exportGlobalHistoryBtn', () => exportHistory());

  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllShells(); });
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
}

function populateCategories() {
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('categoryFilter').innerHTML = '<option value="all">All categories</option>' + cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
}
function filteredProducts() {
  const q = $('searchInput').value.toLowerCase().trim();
  const cat = $('categoryFilter').value;
  const sf = $('stockFilter').value;
  return products.filter(p => {
    if (cat !== 'all' && p.category !== cat) return false;
    const med = Number(p.mediounaQty) || 0;
    const soc = Number(p.socrateQty) || 0;
    const tot = med + soc;
    const lim = Number(p.lowStockLimit) || 0;
    if (sf === 'socrate' && soc <= 0) return false;
    if (sf === 'mediouna' && med <= 0) return false;
    if (sf === 'out' && tot > 0) return false;
    if (sf === 'low' && !(tot <= lim)) return false;
    if (q) {
      const attrs = Object.entries(p.attributes || {}).map(([k, v]) => `${k} ${v}`).join(' ');
      const hay = [p.sku, p.name, p.category, p.categoriesRaw, attrs, p.price1, p.price2, p.price3].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
function render() {
  if (!currentUser) return;
  const list = filteredProducts();
  $('resultsInfo').textContent = `${list.length} / ${products.length} products`;
  $('productGrid').style.display = list.length ? 'grid' : 'none';
  $('emptyState').classList.toggle('visible', !list.length);
  $('productGrid').innerHTML = list.map(cardHtml).join('');
  updateStats();
}
function updateStats() {
  $('totalProducts').textContent = products.length;
  $('mediounaTotal').textContent = products.reduce((s, p) => s + (Number(p.mediounaQty) || 0), 0);
  $('socrateTotal').textContent = products.reduce((s, p) => s + (Number(p.socrateQty) || 0), 0);
  $('lowStockTotal').textContent = products.filter(p => total(p) <= Number(p.lowStockLimit || 0)).length;
}
function pricesHtml(p) {
  const vals = [p.price1, p.price2, p.price3];
  return vals.map((v, i) => `<span class="price-chip"><small>P${i + 1}</small>${v ? escapeHtml(v) : '—'}</span>`).join('');
}
function stockState(p) {
  const tot = total(p);
  const lim = Number(p.lowStockLimit) || 0;
  if (tot <= 0) return 'out';
  if (tot <= lim) return 'low';
  return 'ok';
}
function cardHtml(p) {
  const state = stockState(p);
  const imgHtml = p.image
    ? `<img loading="lazy" src="${escapeAttr(p.image)}" alt="${escapeAttr(p.name)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'placeholder',textContent:'□'}))">`
    : '<div class="placeholder">□</div>';
  return `<article class="product-card ${state}" data-sku="${escapeAttr(p.sku)}">
    <div class="image-box">${imgHtml}<span class="stock-badge ${state}">${state === 'out' ? 'Out' : state === 'low' ? 'Low' : 'OK'}</span></div>
    <div class="product-body">
      <div class="sku">${escapeHtml(p.sku)}</div>
      <h3>${escapeHtml(p.name)}</h3>
      <div class="category">${escapeHtml(p.category || '')}</div>
      <div class="price-row">${pricesHtml(p)}</div>
      <div class="pill-row">
        <div class="pill"><label>Med</label><strong>${Number(p.mediounaQty) || 0}</strong></div>
        <div class="pill"><label>Soc</label><strong>${Number(p.socrateQty) || 0}</strong></div>
        <div class="pill total-pill"><label>Total</label><strong>${total(p)}</strong></div>
      </div>
    </div>
  </article>`;
}

function openShell(id) {
  const el = $(id); if (!el) return;
  el.classList.add('active');
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}
function closeShell(id) {
  const el = $(id); if (!el) return;
  el.classList.remove('active');
  el.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.modal-shell.active')) document.body.classList.remove('modal-open');
}
function closeAllShells() { ['productModal', 'imageModal', 'usersModal', 'productFormModal', 'bulkReceiveModal', 'historyModal', 'restoreModal'].forEach(closeShell); }
function switchTab(tab) {
  if (tab === 'edit' && !canAdmin()) return toast('Admin access required', 'warn');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'history') renderHistory();
}
function findProduct(sku) { return products.find(p => normSku(p.sku) === normSku(sku)); }

function openProduct(sku) {
  if (!requireLogin()) return;
  const p = findProduct(sku);
  if (!p) return toast('Product not found', 'warn');
  activeSku = p.sku;

  $('modalImage').innerHTML = p.image ? `<img src="${escapeAttr(p.image)}" alt="${escapeAttr(p.name)}">` : '<div class="placeholder">□</div>';
  $('modalCategory').textContent = p.category || '';
  $('modalNameTitle').textContent = p.name;
  $('modalSkuTitle').textContent = p.sku;
  refreshModalStock(p);

  $('editSku').value = p.sku;
  $('editName').value = p.name;
  $('editCategory').value = p.category || '';
  $('editImage').value = p.image || '';
  $('editPrice1').value = p.price1 || p.price || '';
  $('editPrice2').value = p.price2 || '';
  $('editPrice3').value = p.price3 || '';
  $('editLowStock').value = p.lowStockLimit ?? 2;
  $('editMediouna').value = Number(p.mediounaQty) || 0;
  $('editSocrate').value = Number(p.socrateQty) || 0;

  ['sellQty', 'sellNote', 'receiveQty', 'receiveBl', 'receiveNote', 'transferQty', 'transferNote', 'adjustQty', 'adjustNote'].forEach(id => { if ($(id)) $(id).value = ''; });
  if ($('receiveHub')) $('receiveHub').value = 'mediounaQty';
  $('modalAttrs').innerHTML = Object.entries(p.attributes || {}).slice(0, 10).map(([k, v]) => `<span>${escapeHtml(k)}: ${escapeHtml(v)}</span>`).join('');
  $('refImageInput').value = '';
  renderReferencePhotos(p);
  applyRoleUi();
  switchTab('sale');
  closeShell('imageModal');
  openShell('productModal');
}
window.openProduct = openProduct;
function refreshModalStock(p) {
  $('modalMediounaView').textContent = Number(p.mediounaQty) || 0;
  $('modalSocrateView').textContent = Number(p.socrateQty) || 0;
  $('modalTotalView').textContent = total(p);
}

function logMove(p, type, fromHub, toHub, qty, before, after, note = '') {
  history.unshift({
    id: randomId('move'), sku: p.sku, name: p.name, type, fromHub, toHub,
    quantity: Number(qty), before, after, note, date: nowIso(),
    userId: currentUser?.id || '', userName: currentUser?.name || 'Unknown', userRole: currentUser?.role || ''
  });
}
function renderHistory() {
  const items = history.filter(h => h.sku === activeSku);
  $('historyList').innerHTML = items.length ? items.map(historyItemHtml).join('') : '<p class="empty-inline">No history for this product yet.</p>';
}
function clearProductHistory() {
  if (!requireAdmin()) return;
  if (!activeSku) return;
  history = history.filter(h => h.sku !== activeSku);
  save();
  renderHistory();
  toast('History cleared', 'success');
}

function saveProductEdits() {
  if (!requireAdmin()) return;
  const p = findProduct(activeSku);
  if (!p) return;
  const before = { mediounaQty: Number(p.mediounaQty) || 0, socrateQty: Number(p.socrateQty) || 0 };
  p.name = $('editName').value.trim() || p.name;
  p.category = $('editCategory').value.trim() || p.category;
  p.image = $('editImage').value.trim();
  p.price1 = $('editPrice1').value.trim();
  p.price2 = $('editPrice2').value.trim();
  p.price3 = $('editPrice3').value.trim();
  p.lowStockLimit = Math.max(0, Number($('editLowStock').value) || 0);
  p.mediounaQty = Math.max(0, Number($('editMediouna').value) || 0);
  p.socrateQty = Math.max(0, Number($('editSocrate').value) || 0);
  const after = { mediounaQty: p.mediounaQty, socrateQty: p.socrateQty };
  if (before.mediounaQty !== after.mediounaQty || before.socrateQty !== after.socrateQty) logMove(p, 'EDIT', 'MANUAL', 'MANUAL', 0, before, after, 'Manual product edit');
  save();
  populateCategories();
  render();
  refreshModalStock(p);
  toast('Product saved', 'success');
}
function deleteActiveProduct() {
  if (!requireAdmin()) return;
  const p = findProduct(activeSku);
  if (!p) return;
  if (!confirm(`Soft-delete ${p.sku} — ${p.name}?\n\nStock data is preserved and can be restored by admin.`)) return;
  const sku = normSku(p.sku);
  const deleted = getDeletedSkus();
  deleted.add(sku);
  saveDeletedSkus(deleted);
  deletedArchive = deletedArchive.filter(x => normSku(x.sku) !== sku);
  deletedArchive.unshift({ ...p, deletedAt: nowIso(), deletedBy: currentUser?.name || 'Unknown' });
  saveDeletedArchive();
  products = products.filter(x => normSku(x.sku) !== sku);
  logMove(p, 'DELETE', 'CATALOG', 'DELETED', 0, { mediounaQty: p.mediounaQty, socrateQty: p.socrateQty }, { mediounaQty: 0, socrateQty: 0 }, 'Product soft-deleted');
  save();
  populateCategories();
  render();
  closeShell('productModal');
  toast('Product soft-deleted — restore from Admin', 'success');
}
function receiveSingleProduct() {
  if (!requireAdmin()) return;
  const p = findProduct(activeSku);
  if (!p) return;
  const qty = Number($('receiveQty').value) || 0;
  if (qty <= 0) return toast('Enter received quantity', 'warn');
  if (!Number.isInteger(qty)) return toast('Quantity must be a whole number', 'warn');
  const hub = $('receiveHub').value === 'socrateQty' ? 'socrateQty' : 'mediounaQty';
  const hubName = hub === 'socrateQty' ? 'SOCRATE' : 'MEDIOUNA';
  const bl = $('receiveBl').value.trim();
  const note = $('receiveNote').value.trim();
  const before = { mediounaQty: Number(p.mediounaQty) || 0, socrateQty: Number(p.socrateQty) || 0 };
  p[hub] = before[hub] + qty;
  const after = { mediounaQty: Number(p.mediounaQty) || 0, socrateQty: Number(p.socrateQty) || 0 };
  logMove(p, 'RECEIVE', bl ? `BL ${bl}` : 'SUPPLIER', hubName, qty, before, after, note);
  save(); render(); refreshModalStock(p);
  ['receiveQty', 'receiveBl', 'receiveNote'].forEach(id => { if ($(id)) $(id).value = ''; });
  toast(`Received ${qty} pcs to ${hubName}`, 'success');
}
function sellFromSocrate() {
  if (!requireLogin()) return;
  const p = findProduct(activeSku);
  const qty = Number($('sellQty').value) || 0;
  if (!p || qty <= 0) return toast('Enter sale quantity', 'warn');
  if (!Number.isInteger(qty)) return toast('Quantity must be a whole number', 'warn');
  if (qty > (Number(p.socrateQty) || 0)) return toast('Not enough stock in Socrate', 'danger');
  const before = { mediounaQty: Number(p.mediounaQty) || 0, socrateQty: Number(p.socrateQty) || 0 };
  p.socrateQty = before.socrateQty - qty;
  const after = { mediounaQty: p.mediounaQty, socrateQty: p.socrateQty };
  logMove(p, 'SALE', 'SOCRATE', 'CLIENT', qty, before, after, $('sellNote').value.trim());
  save(); render(); refreshModalStock(p); $('sellQty').value = ''; $('sellNote').value = '';
  toast('Sale recorded', 'success');
}
function transferToSocrate() {
  if (!requireAdmin()) return;
  const p = findProduct(activeSku);
  const qty = Number($('transferQty').value) || 0;
  if (!p || qty <= 0) return toast('Enter transfer quantity', 'warn');
  if (!Number.isInteger(qty)) return toast('Quantity must be a whole number', 'warn');
  if (qty > (Number(p.mediounaQty) || 0)) return toast('Not enough stock in Mediouna', 'danger');
  if (!confirm(`Transfer ${qty} pcs of ${p.sku} from Mediouna to Socrate?`)) return;
  const before = { mediounaQty: Number(p.mediounaQty) || 0, socrateQty: Number(p.socrateQty) || 0 };
  p.mediounaQty = before.mediounaQty - qty;
  p.socrateQty = before.socrateQty + qty;
  const after = { mediounaQty: p.mediounaQty, socrateQty: p.socrateQty };
  logMove(p, 'TRANSFER', 'MEDIOUNA', 'SOCRATE', qty, before, after, $('transferNote').value.trim());
  save(); render(); refreshModalStock(p); $('transferQty').value = ''; $('transferNote').value = '';
  toast('Transfer completed', 'success');
}
function adjustStock() {
  if (!requireAdmin()) return;
  const p = findProduct(activeSku);
  if (!p) return;
  const hub = $('adjustHub').value;
  const qty = Math.max(0, Number($('adjustQty').value) || 0);
  if (!Number.isInteger(qty)) return toast('Quantity must be a whole number', 'warn');
  const hubName = hub === 'socrateQty' ? 'Socrate' : 'Mediouna';
  if (!confirm(`Set ${hubName} stock to exactly ${qty} for ${p.sku}? This replaces current quantity.`)) return;
  const before = { mediounaQty: Number(p.mediounaQty) || 0, socrateQty: Number(p.socrateQty) || 0 };
  p[hub] = qty;
  const after = { mediounaQty: Number(p.mediounaQty) || 0, socrateQty: Number(p.socrateQty) || 0 };
  logMove(p, 'ADJUST', hub.replace('Qty', '').toUpperCase(), hub.replace('Qty', '').toUpperCase(), qty, before, after, $('adjustNote').value.trim());
  save(); render(); refreshModalStock(p); $('adjustQty').value = ''; $('adjustNote').value = '';
  toast('Adjustment applied', 'success');
}

function renderReferencePhotos(p) {
  const list = p.searchImages || [];
  $('refCount').textContent = list.length ? `${list.length} scan${list.length > 1 ? 's' : ''} linked` : 'No scans linked';
  $('refGallery').innerHTML = list.length ? list.map((r, i) => `<div class="ref-thumb"><img src="${escapeAttr(r.dataUrl)}" alt="Scan ${i + 1}"><button type="button" data-ref-id="${escapeAttr(r.id)}" title="Remove">×</button></div>`).join('') : '<p class="empty-inline small">No scan photos linked yet.</p>';
}
async function addReferencePhoto(e) {
  if (!requireAdmin()) { e.target.value = ''; return; }
  const p = findProduct(activeSku);
  const file = e.target.files[0];
  if (!p || !file) return;
  if (!file.type.startsWith('image/')) { e.target.value = ''; return toast('Please choose an image file', 'warn'); }
  toast('Processing scan...');
  try {
    const img = await fileToImage(file);
    const dataUrl = compressImageToDataUrl(img, 520, 0.78);
    p.searchImages = p.searchImages || [];
    p.searchImages.unshift({ id: randomId('scan'), dataUrl, createdAt: nowIso() });
    visualIndex.clear();
    save(); renderReferencePhotos(p);
    toast('Scan linked to product', 'success');
  } catch { toast('Could not process photo', 'danger'); }
  e.target.value = '';
}
function removeReferencePhoto(id) {
  if (!requireAdmin()) return;
  const p = findProduct(activeSku);
  if (!p) return;
  p.searchImages = (p.searchImages || []).filter(r => r.id !== id);
  visualIndex.clear();
  save(); renderReferencePhotos(p);
  toast('Scan removed', 'success');
}
function clearReferencePhotos() {
  if (!requireAdmin()) return;
  const p = findProduct(activeSku);
  if (!p) return;
  p.searchImages = [];
  visualIndex.clear();
  save(); renderReferencePhotos(p);
  toast('All scans cleared', 'success');
}
function compressImageToDataUrl(img, max = 520, quality = 0.78) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.min(1, max / Math.max(iw, ih));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(iw * scale));
  c.height = Math.max(1, Math.round(ih * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f3f3f3';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

function exportBackup() {
  if (!requireAdmin()) return;
  const data = { version: CURRENT_STORAGE_VERSION, products, history, users: users.map(publicUser), deletedSkus: [...getDeletedSkus()], deletedArchive, exportedAt: nowIso() };
  download(JSON.stringify(data, null, 2), 'lume-inventory-secure-backup.json', 'application/json');
  toast('Backup exported', 'success');
}
async function importBackup(e) {
  if (!requireAdmin()) { e.target.value = ''; return; }
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = async () => {
    try {
      const data = JSON.parse(r.result);
      if (Array.isArray(data.products)) products = data.products.map(normalizeProduct);
      if (Array.isArray(data.deletedSkus)) saveDeletedSkus(new Set(data.deletedSkus.map(normSku)));
      if (Array.isArray(data.deletedArchive)) { deletedArchive = data.deletedArchive; saveDeletedArchive(); }
      if (Array.isArray(data.history)) history = data.history;
      if (Array.isArray(data.users)) {
        const imported = data.users.filter(u => u.email && (u.passwordHash || u.pin));
        if (imported.length) {
          const converted = [];
          for (const u of imported) {
            if (u.passwordHash && u.salt) converted.push({ ...u, pin: undefined });
            else if (u.pin) converted.push({ ...u, ...(await hashPassword(String(u.pin))), pin: undefined });
          }
          if (converted.some(u => u.role === 'admin' && u.active !== false)) users = converted;
        }
      }
      saveUsers(); save(); populateCategories(); render(); applyRoleUi();
      toast('Backup imported successfully', 'success');
    } catch { toast('Invalid backup file', 'danger'); }
  };
  r.readAsText(f);
  e.target.value = '';
}
function exportCurrentStock() {
  if (!requireLogin()) return;
  const rows = products.map(p => [
    p.sku, p.name, p.category || '', Number(p.mediounaQty) || 0, Number(p.socrateQty) || 0, total(p), p.lowStockLimit ?? 2
  ]);
  const csv = [['SKU', 'Name', 'Category', 'Mediouna', 'Socrate', 'Total', 'Low Alert'], ...rows]
    .map(r => r.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  download(csv, `lume-stock-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
  toast('Stock CSV exported', 'success');
}

function exportHistory(sku) {
  const rows = (sku ? history.filter(h => h.sku === sku) : filteredHistory()).map(h => [
    h.date, h.sku, h.name, h.type, h.fromHub, h.toHub, h.quantity,
    h.before?.mediounaQty, h.before?.socrateQty, h.after?.mediounaQty, h.after?.socrateQty,
    h.userName || '', h.userRole || '', (h.note || '').replaceAll('"', '""')
  ]);
  const csv = [['Date', 'SKU', 'Name', 'Type', 'From', 'To', 'Qty', 'Before Mediouna', 'Before Socrate', 'After Mediouna', 'After Socrate', 'User', 'Role', 'Note'], ...rows]
    .map(r => r.map(v => `"${v ?? ''}"`).join(',')).join('\n');
  download(csv, sku ? `history-${String(sku).replace(/[^a-z0-9_-]/gi, '_')}.csv` : 'history.csv', 'text/csv');
}
function download(content, name, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function openNewProductModal() {
  if (!requireAdmin()) return;
  productFormMode = 'create';
  ['productSku','productName','productCategory','productImage','productPrice1','productPrice2','productPrice3','productLowStock','productMediouna','productSocrate'].forEach(id => { if ($(id)) $(id).value = ''; });
  $('productLowStock').value = '2';
  $('productMediouna').value = '0';
  $('productSocrate').value = '0';
  openShell('productFormModal');
  setTimeout(() => $('productSku')?.focus(), 150);
}
function createProductFromForm() {
  if (!requireAdmin()) return;
  const sku = normSku($('productSku').value);
  const name = $('productName').value.trim();
  const category = $('productCategory').value.trim();
  if (!sku || !name) return toast('SKU and name are required', 'warn');
  if (findProduct(sku)) return toast('This SKU already exists', 'warn');
  const deleted = getDeletedSkus();
  deleted.delete(sku);
  saveDeletedSkus(deleted);
  const p = normalizeProduct({
    id: randomId('product'), sku, name, category,
    categoriesRaw: category,
    image: $('productImage').value.trim(),
    price1: $('productPrice1').value.trim(),
    price2: $('productPrice2').value.trim(),
    price3: $('productPrice3').value.trim(),
    lowStockLimit: Math.max(0, Number($('productLowStock').value) || 0),
    mediounaQty: Math.max(0, Number($('productMediouna').value) || 0),
    socrateQty: Math.max(0, Number($('productSocrate').value) || 0),
    attributes: {},
    searchImages: [],
    isCustom: true,
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  products.unshift(p);
  history.unshift({ id: randomId('move'), sku: p.sku, name: p.name, type: 'CREATE', fromHub: 'APP', toHub: 'CATALOG', quantity: 0, before: { mediounaQty: 0, socrateQty: 0 }, after: { mediounaQty: p.mediounaQty, socrateQty: p.socrateQty }, note: 'Product created in app', date: nowIso(), userId: currentUser?.id || '', userName: currentUser?.name || 'Unknown', userRole: currentUser?.role || '' });
  save(); populateCategories(); render(); closeShell('productFormModal'); toast('Product created', 'success');
}
function openBulkReceiveModal() {
  if (!requireAdmin()) return;
  receiveDraft = {};
  if ($('bulkReceiveDate')) $('bulkReceiveDate').value = new Date().toISOString().slice(0, 10);
  if ($('bulkReceiveHub')) $('bulkReceiveHub').value = 'mediounaQty';
  if ($('bulkReceiveBl')) $('bulkReceiveBl').value = '';
  if ($('bulkReceiveNote')) $('bulkReceiveNote').value = '';
  if ($('bulkReceiveSearch')) $('bulkReceiveSearch').value = '';
  renderBulkReceiveProducts();
  openShell('bulkReceiveModal');
}
function renderBulkReceiveProducts() {
  const q = ($('bulkReceiveSearch')?.value || '').toLowerCase().trim();
  const list = products.filter(p => {
    if (!q) return true;
    const hay = [p.sku, p.name, p.category, p.categoriesRaw].join(' ').toLowerCase();
    return hay.includes(q);
  }).slice(0, 300);
  $('bulkReceiveRows').innerHTML = list.map(p => `
    <div class="receive-row">
      <div class="receive-product">
        <strong>${escapeHtml(p.name)}</strong>
        <span>${escapeHtml(p.sku)} · ${escapeHtml(p.category || '')}</span>
        <small>M:${Number(p.mediounaQty) || 0} · S:${Number(p.socrateQty) || 0}</small>
      </div>
      <input data-receive-qty data-sku="${escapeAttr(p.sku)}" type="number" min="0" step="1" inputmode="numeric" placeholder="Qty" value="${receiveDraft[p.sku] || ''}" />
    </div>`).join('') || '<p class="empty-inline">No products found.</p>';
  updateBulkReceiveSummary();
}
function updateBulkReceiveSummary() {
  const lines = Object.entries(receiveDraft).filter(([sku, qty]) => Number(qty) > 0);
  const totalQty = lines.reduce((s, [, qty]) => s + Number(qty), 0);
  if ($('bulkReceiveSummary')) $('bulkReceiveSummary').textContent = `${lines.length} products selected · ${totalQty} pcs total`;
}
function clearBulkReceiveDraft() {
  receiveDraft = {};
  renderBulkReceiveProducts();
  toast('Receive list cleared', 'success');
}
function confirmBulkReceive() {
  if (!requireAdmin()) return;
  const lines = Object.entries(receiveDraft).map(([sku, qty]) => [sku, Number(qty)]).filter(([, qty]) => qty > 0 && Number.isInteger(qty));
  if (!lines.length) return toast('Add quantities for received products', 'warn');
  const totalPcs = lines.reduce((s, [, q]) => s + q, 0);
  if (!confirm(`Confirm receive of ${totalPcs} pcs across ${lines.length} products?`)) return;
  const hub = $('bulkReceiveHub').value === 'socrateQty' ? 'socrateQty' : 'mediounaQty';
  const hubName = hub === 'socrateQty' ? 'SOCRATE' : 'MEDIOUNA';
  const bl = $('bulkReceiveBl').value.trim();
  const receiveDate = $('bulkReceiveDate').value || new Date().toISOString().slice(0, 10);
  const note = $('bulkReceiveNote').value.trim();
  let totalQty = 0;
  let updatedProducts = 0;
  lines.forEach(([sku, qty]) => {
    const p = findProduct(sku);
    if (!p) return;
    const before = { mediounaQty: Number(p.mediounaQty) || 0, socrateQty: Number(p.socrateQty) || 0 };
    p[hub] = before[hub] + qty;
    const after = { mediounaQty: Number(p.mediounaQty) || 0, socrateQty: Number(p.socrateQty) || 0 };
    logMove(p, 'RECEIVE', bl ? `BL ${bl}` : 'SUPPLIER', hubName, qty, before, after, `${receiveDate}${note ? ' · ' + note : ''}`);
    totalQty += qty;
    updatedProducts++;
  });
  if (!updatedProducts) return toast('No valid products selected', 'warn');
  save(); populateCategories(); render(); closeShell('bulkReceiveModal');
  receiveDraft = {};
  toast(`Received ${totalQty} pcs for ${updatedProducts} products`, 'success');
}

function renderUsers() {
  if (!requireAdmin()) return;
  $('totalUsers').textContent = users.length;
  $('activeUsers').textContent = users.filter(u => u.active !== false).length;
  $('adminUsers').textContent = activeAdmins().length;
  $('usersList').innerHTML = users.map(u => {
    const isSelf = u.id === currentUser?.id;
    const status = u.active === false ? 'disabled' : 'active';
    return `<div class="user-row ${status}">
      <div class="user-avatar mini">${escapeHtml((u.name || 'U').charAt(0).toUpperCase())}</div>
      <div class="user-row-info">
        <strong>${escapeHtml(u.name)} <span class="role-text">${escapeHtml(u.role === 'admin' ? 'Admin' : 'Sales')}</span></strong>
        <span>${escapeHtml(u.email)} · ${escapeHtml(u.phone || 'No phone')} · ${status}</span>
      </div>
      <div class="user-row-actions">
        ${isSelf ? '<span class="you-label">You</span>' : `<button type="button" data-user-action="toggle" data-user-id="${escapeAttr(u.id)}">${u.active === false ? 'Activate' : 'Disable'}</button><button type="button" class="danger small-danger" data-user-action="delete" data-user-id="${escapeAttr(u.id)}">Delete</button>`}
      </div>
    </div>`;
  }).join('') || '<p class="empty-inline">No users yet.</p>';
}
async function addUser() {
  if (!requireAdmin()) return;
  const name = $('newUserName').value.trim();
  const email = normalizeEmail($('newUserEmail').value);
  const phone = $('newUserPhone').value.trim();
  const role = $('newUserRole').value === 'admin' ? 'admin' : 'sales';
  const password = $('newUserPin').value;
  if (!name || !email || !phone || !password) return toast('Name, email, phone and password are required', 'warn');
  if (!validEmail(email)) return toast('Enter a valid email address', 'warn');
  if (password.length < 8) return toast('Password must be at least 8 characters', 'warn');
  if (users.some(u => normalizeEmail(u.email) === email)) return toast('Email already exists', 'warn');
  try {
    const secure = await hashPassword(password);
    users.push({ id: randomId('user'), name, email, phone, role, active: true, createdAt: nowIso(), updatedAt: nowIso(), ...secure });
    saveUsers();
    ['newUserName', 'newUserEmail', 'newUserPhone', 'newUserPin'].forEach(id => $(id).value = '');
    $('newUserRole').value = 'sales';
    renderUsers();
    toast('User created successfully', 'success');
  } catch (err) { toast(err.message || 'Could not create user', 'danger'); }
}
function toggleUser(id) {
  if (!requireAdmin()) return;
  const u = users.find(x => x.id === id);
  if (!u) return;
  if (u.id === currentUser?.id) return toast('Cannot disable yourself', 'warn');
  if (u.role === 'admin' && u.active !== false && activeAdmins().length <= 1) return toast('Keep at least one active admin', 'warn');
  u.active = u.active === false;
  u.updatedAt = nowIso();
  saveUsers(); renderUsers(); toast(u.active ? 'User activated' : 'User disabled', 'success');
}
function deleteUser(id) {
  if (!requireAdmin()) return;
  const u = users.find(x => x.id === id);
  if (!u) return;
  if (u.id === currentUser?.id) return toast('Cannot delete yourself', 'warn');
  if (u.role === 'admin' && u.active !== false && activeAdmins().length <= 1) return toast('Keep at least one active admin', 'warn');
  if (!confirm(`Delete ${u.name}?`)) return;
  users = users.filter(x => x.id !== id);
  saveUsers(); renderUsers(); toast('User deleted', 'success');
}
function exportUsers() {
  if (!requireAdmin()) return;
  const rows = users.map(u => [u.name, u.email, u.phone, u.role, u.active !== false ? 'active' : 'disabled']);
  const csv = [['Name', 'Email', 'Phone', 'Role', 'Status'], ...rows]
    .map(r => r.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  download(csv, 'lume-users.csv', 'text/csv');
}

function applyRoleUi() {
  if (!$('userName')) return;
  $('userName').textContent = currentUser?.name || 'Guest';
  $('userAvatar').textContent = (currentUser?.name || 'G').charAt(0).toUpperCase();
  $('userRole').textContent = canAdmin() ? 'Admin' : 'Sales';
  $('userRole').className = `role-badge ${canAdmin() ? 'admin' : 'sales'}`;
  document.body.dataset.role = canAdmin() ? 'admin' : 'sales';
  document.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = !canAdmin(); });
}

// ═══════════════════════════════════════════════════════════════
// 10. HISTORY / EXPORT
// ═══════════════════════════════════════════════════════════════
function filteredHistory() {
  const q = ($('historySearch')?.value || '').toLowerCase().trim();
  const type = $('historyTypeFilter')?.value || 'all';
  const hub = $('historyHubFilter')?.value || 'all';
  const cat = $('historyCategoryFilter')?.value || 'all';
  const bl = ($('historyBlFilter')?.value || '').toLowerCase().trim();
  const from = $('historyDateFrom')?.value || '';
  const to = $('historyDateTo')?.value || '';
  const fromMs = from ? new Date(from + 'T00:00:00').getTime() : null;
  const toMs = to ? new Date(to + 'T23:59:59').getTime() : null;
  const productCats = new Map(products.map(p => [p.sku, p.category]));

  return history.filter(h => {
    if (type !== 'all' && String(h.type || '').toUpperCase() !== type) return false;
    if (hub !== 'all') {
      const fh = String(h.fromHub || '').toUpperCase();
      const th = String(h.toHub || '').toUpperCase();
      if (!fh.includes(hub) && !th.includes(hub)) return false;
    }
    if (cat !== 'all') {
      const p = products.find(x => x.sku === h.sku);
      const c = p?.category || productCats.get(h.sku) || '';
      if (c !== cat) return false;
    }
    if (bl) {
      const note = String(h.note || '').toLowerCase();
      const fromHub = String(h.fromHub || '').toLowerCase();
      if (!note.includes(bl) && !fromHub.includes(bl)) return false;
    }
    if (fromMs || toMs) {
      const t = new Date(h.date).getTime();
      if (Number.isNaN(t)) return false;
      if (fromMs && t < fromMs) return false;
      if (toMs && t > toMs) return false;
    }
    if (q) {
      const hay = [h.sku, h.name, h.type, h.fromHub, h.toHub, h.note, h.userName].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
function historyItemHtml(h) {
  const date = new Date(h.date);
  const dateStr = Number.isNaN(date.getTime()) ? h.date : date.toLocaleString();
  const socAfter = h.after?.socrateQty ?? '-';
  return `<div class="history-item ${escapeAttr(String(h.type || '').toLowerCase())}">
    <div class="history-top"><span class="move-badge">${escapeHtml(h.type)}</span><strong>${escapeHtml(h.quantity)} pcs</strong><time>${escapeHtml(dateStr)}</time></div>
    <div class="history-line"><strong>${escapeHtml(h.sku)}</strong> · ${escapeHtml(h.name || '')}</div>
    <div class="history-line">${escapeHtml(h.fromHub || '')} → ${escapeHtml(h.toHub || '')} · By ${escapeHtml(h.userName || 'Unknown')}</div>
    <div class="history-line">Before M:${h.before?.mediounaQty ?? '-'} S:${h.before?.socrateQty ?? '-'} · After M:${h.after?.mediounaQty ?? '-'} S:${h.after?.socrateQty ?? '-'}</div>
    ${h.type === 'SALE' ? `<div class="history-line socrate-left">Socrate remaining: <strong>${socAfter}</strong></div>` : ''}
    ${h.note ? `<em>${escapeHtml(h.note)}</em>` : ''}
  </div>`;
}
function renderGlobalHistory() {
  const list = filteredHistory();
  const el = $('globalHistoryList');
  if (!el) return;
  $('globalHistoryCount').textContent = `${list.length} / ${history.length} movements`;
  el.innerHTML = list.length ? list.map(historyItemHtml).join('') : '<p class="empty-inline">No movements match these filters.</p>';
}
function setHistoryPeriod(period) {
  const now = new Date();
  if (period === 'today') {
    const d = now.toISOString().slice(0, 10);
    if ($('historyDateFrom')) $('historyDateFrom').value = d;
    if ($('historyDateTo')) $('historyDateTo').value = d;
  } else if (period === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const end = now.toISOString().slice(0, 10);
    if ($('historyDateFrom')) $('historyDateFrom').value = start;
    if ($('historyDateTo')) $('historyDateTo').value = end;
  }
  renderGlobalHistory();
}
function openGlobalHistory() {
  if (!requireLogin()) return;
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
  if ($('historyCategoryFilter')) {
    $('historyCategoryFilter').innerHTML = '<option value="all">All categories</option>' +
      cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
  }
  renderGlobalHistory();
  openShell('historyModal');
}

// ═══════════════════════════════════════════════════════════════
// 11. ADMIN TOOLS — RESTORE DELETED
// ═══════════════════════════════════════════════════════════════
function openRestoreModal() {
  if (!requireAdmin()) return;
  renderRestoreList();
  openShell('restoreModal');
}
function renderRestoreList() {
  const deleted = getDeletedSkus();
  const list = deletedArchive.filter(p => deleted.has(normSku(p.sku)));
  const el = $('restoreList');
  if (!el) return;
  $('restoreCount').textContent = `${list.length} deleted product${list.length !== 1 ? 's' : ''}`;
  el.innerHTML = list.length ? list.map(p => `
    <div class="restore-row">
      <div class="restore-info">
        <strong>${escapeHtml(p.name)}</strong>
        <span>${escapeHtml(p.sku)} · ${escapeHtml(p.category || '')}</span>
        <small>M:${Number(p.mediounaQty) || 0} · S:${Number(p.socrateQty) || 0}</small>
      </div>
      <button type="button" class="action-btn primary" data-restore-sku="${escapeAttr(p.sku)}">Restore</button>
    </div>`).join('') : '<p class="empty-inline">No deleted products to restore.</p>';
}
function restoreProduct(sku) {
  if (!requireAdmin()) return;
  const key = normSku(sku);
  const archived = deletedArchive.find(p => normSku(p.sku) === key);
  if (!archived) return toast('Archived product not found', 'warn');
  if (!confirm(`Restore ${archived.sku} — ${archived.name}?`)) return;
  const deleted = getDeletedSkus();
  deleted.delete(key);
  saveDeletedSkus(deleted);
  deletedArchive = deletedArchive.filter(p => normSku(p.sku) !== key);
  saveDeletedArchive();
  const base = Array.isArray(window.LUME_PRODUCTS) ? window.LUME_PRODUCTS.find(p => normSku(p.sku) === key) : null;
  const restored = normalizeProduct({ ...(base || {}), ...archived, isCustom: archived.isCustom || !base });
  if (!findProduct(key)) products.unshift(restored);
  logMove(restored, 'RESTORE', 'DELETED', 'CATALOG', 0, { mediounaQty: 0, socrateQty: 0 }, { mediounaQty: restored.mediounaQty, socrateQty: restored.socrateQty }, 'Product restored');
  save();
  populateCategories();
  render();
  renderRestoreList();
  toast(`${restored.name} restored`, 'success');
}
const IMAGE_PROXY_PREFIX='https://images.weserv.nl/?url=';
let imageSearchCacheLoaded=false;
function resetImageSearchUi(){
  $('imageResults').innerHTML='';
  $('imageStatus').textContent='';
  $('imagePreview').innerHTML='';
}
function productImageUrl(url){
  if(!url)return '';
  return String(url).trim();
}
function proxiedImageUrl(url){
  if(!url)return '';
  const clean=String(url).replace(/^https?:\/\//,'');
  return `${IMAGE_PROXY_PREFIX}${encodeURIComponent(clean)}&w=700&h=700&fit=contain&we`;
}
async function handleImageSearch(e){
  const file=e.target.files[0];
  if(!file)return;
  resetImageSearchUi();
  $('imageStatus').textContent='Reading and cleaning the photo background...';
  let qImg;
  try{qImg=await fileToImage(file)}catch(err){$('imageStatus').textContent='Could not read this photo. Try another one.';return;}
  $('imagePreview').innerHTML='';
  const prev=qImg.cloneNode();prev.className='query-preview';$('imagePreview').appendChild(prev);
  const qSig=signatureFromImage(qImg,true);
  const candidates=products.flatMap(p=>productImageSources(p).map(source=>({p,source})));
  if(!candidates.length){$('imageStatus').textContent='No product image links or linked scan photos found in the product data.';return;}
  const scanCount=candidates.filter(c=>c.source.type==='scan').length;
  $('imageStatus').textContent=`Indexing ${candidates.length} visual references (${scanCount} linked scans). First search can take a little time...`;
  let done=0,loaded=0,blocked=0,resultMap=new Map();
  for(const item of candidates){
    const {p,source}=item;
    try{
      const key=p.sku+'::'+source.id;
      let sig=visualIndex.get(key);
      if(!sig){
        const img=await loadSourceImage(source);
        sig=signatureFromImage(img,false);
        visualIndex.set(key,sig);
      }
      loaded++;
      const base=compareSignatures(qSig,sig);
      const scanBoost=source.type==='scan'?0.08:0;
      const score=Math.min(1,base+visualTextBonus(qSig,p)+scanBoost);
      const current=resultMap.get(p.sku);
      if(!current||score>current.score)resultMap.set(p.sku,{p,score,raw:base,source});
    }catch(err){blocked++;}
    done++;
    if(done%5===0||done===candidates.length){
      $('imageStatus').textContent=`Compared ${done}/${candidates.length} references · readable: ${loaded} · blocked: ${blocked}`;
      await new Promise(r=>setTimeout(r,0));
    }
  }
  let results=[...resultMap.values()].sort((a,b)=>b.score-a.score).slice(0,18);
  if(!results.length){
    $('imageStatus').innerHTML='The app could not read your product image links because the image host blocked browser analysis. I added an image proxy fallback, but if this still happens, put product photos inside the GitHub repo in an <b>images</b> folder and use those links.';
    return;
  }
  imageSearchCacheLoaded=true;
  const best=Math.round(results[0].score*100);
  $('imageStatus').textContent=`Best matches found. Tap any result to open the product. Best score: ${best}%`;
  $('imageResults').innerHTML=results.map(({p,score,raw,source},idx)=>imageResultHtml(p,score,idx,raw,source)).join('');
}
function imageResultHtml(p, score, idx, raw, source) {
  const pct = Math.max(1, Math.round(score * 100));
  const confidence = pct >= 70 ? 'Strong' : pct >= 48 ? 'Possible' : 'Visual';
  const imgSrc = source?.thumb || p.image || '';
  const matched = source?.type === 'scan' ? 'Linked scan' : 'Catalog image';
  return `<button type="button" class="image-result" data-sku="${escapeAttr(p.sku)}">
    <img src="${escapeAttr(imgSrc)}" alt="${escapeAttr(p.name)}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'mini-placeholder',textContent:'□'}))">
    <div class="match-copy">
      <strong>${escapeHtml(p.name)}</strong>
      <span>${escapeHtml(p.sku)} · ${escapeHtml(p.category || '')}</span>
      <span class="match-source">${matched}</span>
      <span>Med: ${Number(p.mediounaQty) || 0} · Soc: ${Number(p.socrateQty) || 0}</span>
    </div>
    <div class="match-score"><b>${pct}%</b><small>${confidence}</small></div>
  </button>`;
}
function productImageSources(p){const sources=[];if(productImageUrl(p.image))sources.push({id:'main',type:'main',url:productImageUrl(p.image),thumb:p.image});(p.searchImages||[]).forEach(r=>{if(r.dataUrl)sources.push({id:r.id,type:'scan',url:r.dataUrl,thumb:r.dataUrl})});return sources}
async function loadSourceImage(source){if(source.type==='scan')return await loadImage(source.url,false);return await loadProductImage(source.url)}
function fileToImage(file){return new Promise((res,rej)=>{const url=URL.createObjectURL(file);const img=new Image();img.onload=()=>{URL.revokeObjectURL(url);res(img)};img.onerror=rej;img.src=url})}
async function loadProductImage(url){
  const direct=productImageUrl(url);
  try{return await loadImage(direct,true)}catch(e1){
    try{return await loadImage(proxiedImageUrl(direct),true)}catch(e2){
      return await loadImage(direct,false);
    }
  }
}
function loadImage(url,useCors=true){return new Promise((res,rej)=>{const img=new Image();if(useCors)img.crossOrigin='anonymous';img.onload=()=>res(img);img.onerror=rej;img.src=url})}
function signatureFromImage(img,isQuery=false){
  const base=180, size=64;
  const source=drawImageToCanvas(img,base,true);
  const crop=findForegroundCrop(source,isQuery);
  const c=document.createElement('canvas');c.width=size;c.height=size;
  const ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.fillStyle='#f3f3f3';ctx.fillRect(0,0,size,size);
  const pad=isQuery?4:2;
  ctx.drawImage(source,crop.x,crop.y,crop.w,crop.h,pad,pad,size-pad*2,size-pad*2);
  const d=ctx.getImageData(0,0,size,size).data;
  const gray=[];const obj=[];const hist=new Array(64).fill(0);const edgeGrid=new Array(64).fill(0);let mean=[0,0,0];let dark=0,bright=0,centerDark=0,centerBright=0;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=(y*size+x)*4,r=d[i],g=d[i+1],b=d[i+2];
    const lum=0.299*r+0.587*g+0.114*b;const sat=Math.max(r,g,b)-Math.min(r,g,b);
    gray.push(lum);mean[0]+=r;mean[1]+=g;mean[2]+=b;
    const isObj=sat>18||lum<185||lum>235;obj.push(isObj?1:0);
    if(lum<95)dark++; if(lum>225)bright++;
    if(x>size*.28&&x<size*.72&&y>size*.28&&y<size*.72){if(lum<95)centerDark++; if(lum>220)centerBright++;}
    hist[Math.min(15,Math.floor(r/16))]++;hist[16+Math.min(15,Math.floor(g/16))]++;hist[32+Math.min(15,Math.floor(b/16))]++;hist[48+Math.min(15,Math.floor(lum/16))]++;
  }
  mean=mean.map(v=>v/(size*size));
  const avg=gray.reduce((s,v)=>s+v,0)/gray.length;
  const bits=gray.map(v=>v>avg?1:0);
  const edgeBits=[];let edgeSum=0,edgeCount=0;
  for(let y=1;y<size-1;y++)for(let x=1;x<size-1;x++){
    const gx=gray[y*size+x+1]-gray[y*size+x-1];
    const gy=gray[(y+1)*size+x]-gray[(y-1)*size+x];
    const e=Math.sqrt(gx*gx+gy*gy);edgeSum+=e;edgeCount++;
    const gx8=Math.min(7,Math.floor(x/8)),gy8=Math.min(7,Math.floor(y/8));edgeGrid[gy8*8+gx8]+=e;
  }
  const edgeAvg=edgeSum/(edgeCount||1);
  for(let y=1;y<size-1;y++)for(let x=1;x<size-1;x++){
    const gx=gray[y*size+x+1]-gray[y*size+x-1];const gy=gray[(y+1)*size+x]-gray[(y-1)*size+x];edgeBits.push(Math.sqrt(gx*gx+gy*gy)>edgeAvg?1:0);
  }
  normalizeArray(hist);normalizeArray(edgeGrid);
  const cropRatio=crop.w/(crop.h||1);const objectFill=obj.reduce((s,v)=>s+v,0)/obj.length;
  return{bits,edgeBits,hist,edgeGrid,mean,cropRatio,objectFill,dark:dark/gray.length,bright:bright/gray.length,centerDark:centerDark/gray.length,centerBright:centerBright/gray.length};
}
function drawImageToCanvas(img,size,contain=true){
  const c=document.createElement('canvas');c.width=size;c.height=size;const ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.fillStyle='#f3f3f3';ctx.fillRect(0,0,size,size);
  const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;
  const scale=contain?Math.min(size/iw,size/ih):Math.max(size/iw,size/ih);
  const w=iw*scale,h=ih*scale;ctx.drawImage(img,(size-w)/2,(size-h)/2,w,h);return c;
}
function findForegroundCrop(canvas,isQuery=false){
  const w=canvas.width,h=canvas.height,ctx=canvas.getContext('2d',{willReadFrequently:true}),d=ctx.getImageData(0,0,w,h).data;
  const border=[];
  for(let x=0;x<w;x+=3){border.push(lumAt(d,w,x,0),lumAt(d,w,x,h-1));}
  for(let y=0;y<h;y+=3){border.push(lumAt(d,w,0,y),lumAt(d,w,w-1,y));}
  border.sort((a,b)=>a-b);const bg=border[Math.floor(border.length/2)]||230;
  let minX=w,minY=h,maxX=0,maxY=0,count=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4,r=d[i],g=d[i+1],b=d[i+2];const lum=0.299*r+0.587*g+0.114*b;const sat=Math.max(r,g,b)-Math.min(r,g,b);
    const edge=Math.abs(lum-bg)>24 || sat>20 || lum<145 || lum>238;
    if(edge){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);count++;}
  }
  if(count<80)return{x:0,y:0,w,h};
  const pad=isQuery?12:8;minX=Math.max(0,minX-pad);minY=Math.max(0,minY-pad);maxX=Math.min(w-1,maxX+pad);maxY=Math.min(h-1,maxY+pad);
  const cw=maxX-minX+1,ch=maxY-minY+1;
  if(cw<20||ch<20)return{x:0,y:0,w,h};
  return{x:minX,y:minY,w:cw,h:ch};
}
function lumAt(d,w,x,y){const i=(y*w+x)*4;return 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]}
function normalizeArray(a){const n=Math.sqrt(a.reduce((s,v)=>s+v*v,0))||1;for(let i=0;i<a.length;i++)a[i]/=n;return a}
function bitScore(a,b){let same=0,n=Math.min(a.length,b.length);for(let i=0;i<n;i++)if(a[i]===b[i])same++;return n?same/n:0}
function cosine(a,b){let dot=0,na=0,nb=0,n=Math.min(a.length,b.length);for(let i=0;i<n;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i]}return dot/(Math.sqrt(na)*Math.sqrt(nb)||1)}
function numberSimilarity(a,b,scale=1){return Math.max(0,1-Math.abs(a-b)/scale)}
function compareSignatures(a,b){
  const hashScore=bitScore(a.bits,b.bits);
  const edgeScore=bitScore(a.edgeBits,b.edgeBits);
  const edgeGridScore=cosine(a.edgeGrid,b.edgeGrid);
  const histScore=cosine(a.hist,b.hist);
  const cropScore=numberSimilarity(Math.log(a.cropRatio||1),Math.log(b.cropRatio||1),1.4);
  const fillScore=numberSimilarity(a.objectFill,b.objectFill,.55);
  const darkScore=numberSimilarity(a.dark,b.dark,.45);
  const centerScore=numberSimilarity(a.centerDark+a.centerBright,b.centerDark+b.centerBright,.35);
  return Math.max(0,Math.min(1,hashScore*.18+edgeScore*.18+edgeGridScore*.24+histScore*.17+cropScore*.09+fillScore*.05+darkScore*.04+centerScore*.05));
}
function visualTextBonus(sig,p){
  const hay=[p.name,p.sku,p.category,p.categoriesRaw,Object.entries(p.attributes||{}).map(([k,v])=>`${k} ${v}`).join(' ')].join(' ').toLowerCase();
  let bonus=0;
  if(sig.dark>.18&&(hay.includes('black')||hay.includes('bk')||hay.includes('noir')))bonus+=.04;
  if(sig.centerBright>.01&&(hay.includes('glass')||hay.includes('smok')||hay.includes('sphere')||hay.includes('globe')))bonus+=.03;
  if(sig.cropRatio<.8&&(hay.includes('pendant')||hay.includes('suspension')||hay.includes('p/')))bonus+=.03;
  return bonus;
}

document.addEventListener('DOMContentLoaded', init);
