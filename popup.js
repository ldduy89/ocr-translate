// Ngôn ngữ đích cho bước dịch: [mã, tên hiển thị]. Tên gửi cho Gemini nằm trong background.js (TARGET_NAMES).
const TARGET_OPTIONS = [
  ["vi", "Tiếng Việt"],
  ["en", "Tiếng Anh"],
  ["zh-CN", "Tiếng Trung (giản thể)"],
  ["zh-TW", "Tiếng Trung (phồn thể)"],
  ["ja", "Tiếng Nhật"],
  ["ko", "Tiếng Hàn"],
  ["th", "Tiếng Thái"],
  ["id", "Tiếng Indonesia"],
  ["ms", "Tiếng Mã Lai"],
  ["fil", "Tiếng Philippines"],
  ["km", "Tiếng Khmer"],
  ["lo", "Tiếng Lào"],
  ["my", "Tiếng Myanmar"],
  ["mn", "Tiếng Mông Cổ"],
  ["hi", "Tiếng Hindi"],
  ["bn", "Tiếng Bengali"],
  ["ur", "Tiếng Urdu"],
  ["ta", "Tiếng Tamil"],
  ["te", "Tiếng Telugu"],
  ["mr", "Tiếng Marathi"],
  ["gu", "Tiếng Gujarati"],
  ["pa", "Tiếng Punjabi"],
  ["kn", "Tiếng Kannada"],
  ["ml", "Tiếng Malayalam"],
  ["ne", "Tiếng Nepal"],
  ["si", "Tiếng Sinhala"],
  ["ar", "Tiếng Ả Rập"],
  ["fa", "Tiếng Ba Tư"],
  ["he", "Tiếng Do Thái"],
  ["tr", "Tiếng Thổ Nhĩ Kỳ"],
  ["kk", "Tiếng Kazakh"],
  ["uz", "Tiếng Uzbek"],
  ["az", "Tiếng Azerbaijan"],
  ["ka", "Tiếng Gruzia"],
  ["hy", "Tiếng Armenia"],
  ["ru", "Tiếng Nga"],
  ["uk", "Tiếng Ukraina"],
  ["be", "Tiếng Belarus"],
  ["fr", "Tiếng Pháp"],
  ["de", "Tiếng Đức"],
  ["es", "Tiếng Tây Ban Nha"],
  ["pt", "Tiếng Bồ Đào Nha"],
  ["it", "Tiếng Ý"],
  ["nl", "Tiếng Hà Lan"],
  ["sv", "Tiếng Thụy Điển"],
  ["no", "Tiếng Na Uy"],
  ["da", "Tiếng Đan Mạch"],
  ["fi", "Tiếng Phần Lan"],
  ["is", "Tiếng Iceland"],
  ["pl", "Tiếng Ba Lan"],
  ["cs", "Tiếng Séc"],
  ["sk", "Tiếng Slovakia"],
  ["hu", "Tiếng Hungary"],
  ["ro", "Tiếng Romania"],
  ["bg", "Tiếng Bulgaria"],
  ["sr", "Tiếng Serbia"],
  ["hr", "Tiếng Croatia"],
  ["sl", "Tiếng Slovenia"],
  ["et", "Tiếng Estonia"],
  ["lv", "Tiếng Latvia"],
  ["lt", "Tiếng Litva"],
  ["el", "Tiếng Hy Lạp"],
  ["sq", "Tiếng Albania"],
  ["mk", "Tiếng Macedonia"],
  ["bs", "Tiếng Bosnia"],
  ["ca", "Tiếng Catalan"],
  ["eu", "Tiếng Basque"],
  ["gl", "Tiếng Galicia"],
  ["ga", "Tiếng Ireland"],
  ["cy", "Tiếng Wales"],
  ["sw", "Tiếng Swahili"],
  ["am", "Tiếng Amharic"],
  ["af", "Tiếng Afrikaans"],
  ["ha", "Tiếng Hausa"],
  ["yo", "Tiếng Yoruba"],
  ["ig", "Tiếng Igbo"],
  ["zu", "Tiếng Zulu"],
  ["eo", "Tiếng Esperanto"],
  ["la", "Tiếng Latinh"],
];

const DEFAULTS = { targetLang: 'vi' };
const $ = (id) => document.getElementById(id);
const listEl = $('list');
const countEl = $('count');
const translateBtn = $('translate');
const selectAllCb = $('selectAllCb');
const modal = $('modal');         // cài đặt
const userModal = $('userModal'); // tài khoản

let items = []; // { url, w, h, checked, done, notext }
let currentTabId = null;
let busy = false; // đang dịch ở tab hiện tại
let account = null; // { token, user: { email, name, credits, credits_free, credits_paid, gemini_key } } hoặc null nếu chưa đăng nhập

// ---------- Ngôn ngữ đích: ô tìm kiếm + danh sách ----------
const langBox = $('langBox');
const langInput = $('langInput');
const langList = $('langList');
const langCollator = new Intl.Collator('vi'); // sắp xếp theo bảng chữ cái tiếng Việt
const LANGS = [...TARGET_OPTIONS].sort((x, y) => langCollator.compare(x[1], y[1]));
let langValue = DEFAULTS.targetLang;

function langLabel(code) {
  const hit = TARGET_OPTIONS.find(([v]) => v === code);
  return hit ? hit[1] : code;
}

function renderLangList(filter = '') {
  const q = filter.trim().toLowerCase();
  const shown = LANGS.filter(([v, label]) => !q || label.toLowerCase().includes(q) || v.toLowerCase().includes(q));
  langList.innerHTML = '';
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'lang-empty';
    empty.textContent = 'Không có ngôn ngữ phù hợp';
    langList.appendChild(empty);
    return;
  }
  for (const [v, label] of shown) {
    const row = document.createElement('div');
    row.className = 'lang-item' + (v === langValue ? ' sel' : '');
    row.textContent = label;
    // mousedown (không phải click) để chọn trước khi ô tìm kiếm mất focus
    row.onmousedown = (e) => { e.preventDefault(); pickLang(v); };
    langList.appendChild(row);
  }
}

function openLang() {
  langInput.value = '';
  langInput.placeholder = langLabel(langValue); // đang chọn hiện làm gợi ý, gõ để tìm
  renderLangList('');
  langBox.classList.add('open');
}

function closeLang() {
  langBox.classList.remove('open');
  langInput.placeholder = '';
  langInput.value = langLabel(langValue);
}

function pickLang(code) {
  langValue = code;
  chrome.storage.sync.set({ targetLang: code });
  langInput.blur(); // onblur sẽ đóng danh sách và hiện tên ngôn ngữ đã chọn
}

langInput.onfocus = openLang;
langInput.oninput = () => renderLangList(langInput.value);
langInput.onblur = closeLang;
langInput.onkeydown = (e) => {
  if (e.key === 'Escape') langInput.blur();
  if (e.key === 'Enter') {
    const first = langList.querySelector('.lang-item');
    if (first) first.dispatchEvent(new MouseEvent('mousedown'));
  }
};
// Bấm vào biểu tượng kính lúp cũng mở ô tìm kiếm
document.querySelector('.lang-icon').style.pointerEvents = 'auto';
document.querySelector('.lang-icon').onclick = () => langInput.focus();

chrome.storage.sync.get(DEFAULTS).then((s) => {
  langValue = TARGET_OPTIONS.some(([v]) => v === s.targetLang) ? s.targetLang : DEFAULTS.targetLang;
  langInput.value = langLabel(langValue);
});

// Mở modal: dialog phóng ra từ icon đã bấm (tính độ lệch từ tâm icon đến tâm dialog)
function openModal(modalEl, fromBtn) {
  const dlg = modalEl.querySelector('.dialog');
  if (fromBtn) {
    // Tắt transition khi đặt vị trí, để khung nằm sẵn ở icon trước khi phóng ra
    dlg.style.transition = 'none';
    dlg.style.transform = 'none';
    const d = dlg.getBoundingClientRect();
    dlg.style.transform = '';
    const r = fromBtn.getBoundingClientRect();
    dlg.style.setProperty('--fx', ((r.left + r.width / 2) - (d.left + d.width / 2)) + 'px');
    dlg.style.setProperty('--fy', ((r.top + r.height / 2) - (d.top + d.height / 2)) + 'px');
    void dlg.offsetWidth; // chốt vị trí thu nhỏ tại icon (lúc này transition đang tắt)
    dlg.style.transition = '';
  }
  modalEl.classList.add('show');
}

$('settings').onclick = () => openModal(modal, $('settings'));
$('closeSettings').onclick = () => modal.classList.remove('show');
modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('show'); };

// ---------- Tài khoản (modal riêng) ----------
$('userBtn').onclick = () => openModal(userModal, $('userBtn'));
$('closeUser').onclick = () => userModal.classList.remove('show');
userModal.onclick = (e) => { if (e.target === userModal) userModal.classList.remove('show'); };

// Nhấn Esc để đóng popup đang mở
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { modal.classList.remove('show'); userModal.classList.remove('show'); }
});

// ---------- Tài khoản ----------
function showAcctMsg(text) {
  $('acctMsg').textContent = text || '';
}

function renderAccount() {
  const u = account && account.user;
  $('userBtn').title = u ? `${u.email}: còn ${u.credits} lượt dịch (miễn phí ${u.credits_free ?? 0}, đã mua ${u.credits_paid ?? 0})` : 'Đăng nhập Google';
  const initial = u ? String(u.name || u.email || '?').trim().charAt(0).toUpperCase() : '?';
  $('acctAvatar').textContent = initial || '?';
  $('acctName').textContent = u ? (u.name || u.email) : 'Chưa đăng nhập';
  $('acctEmail').textContent = u ? u.email : '';
  $('acctPlan').textContent = u ? ((u.credits_paid ?? 0) > 0 ? 'Đã mua lượt' : 'Miễn phí') : '–';
  $('acctFree').textContent = u ? String(u.credits_free ?? 0) : '–';
  $('acctPaid').textContent = u ? String(u.credits_paid ?? 0) : '–';
  $('acctCredits').textContent = u ? String(u.credits) : '–';
  $('loginBtn').style.display = u ? 'none' : '';
  $('logoutBtn').style.display = u ? '' : 'none';
  $('acctInfo').style.display = u ? '' : 'none';
  $('acctGuest').style.display = u ? 'none' : '';
  updateFooter();
}

// Làm mới số lượt và thông tin từ server theo nút trong modal
// Làm mới số lượt và thông tin từ server (nút có ở cả hai trạng thái)
let refreshingAcct = false;
async function refreshAccount() {
  if (refreshingAcct) return;
  refreshingAcct = true;
  const btns = document.querySelectorAll('.refresh-btn');
  const hadAccount = !!account;
  btns.forEach((b) => { b.disabled = true; b.classList.add('spinning'); });
  showAcctMsg('');
  try {
    const next = await Account.refresh();
    account = next;
    if (!next && hadAccount) showAcctMsg('Phiên đăng nhập đã hết. Hãy đăng nhập lại.');
  } catch (err) {
    showAcctMsg(err.message);
  } finally {
    refreshingAcct = false;
    btns.forEach((b) => { b.disabled = false; b.classList.remove('spinning'); });
    renderAccount();
  }
}
document.querySelectorAll('.refresh-btn').forEach((b) => { b.onclick = refreshAccount; });

let loggingIn = false;
async function doLogin() {
  if (loggingIn) return;
  loggingIn = true;
  showAcctMsg('');
  $('loginBtn').disabled = true;
  try {
    account = await Account.login(true);
  } catch (err) {
    showAcctMsg(err.message);
    openModal(userModal, $('userBtn')); // cho người dùng thấy lý do lỗi
  } finally {
    loggingIn = false;
    $('loginBtn').disabled = false;
    renderAccount();
  }
}

$('loginBtn').onclick = doLogin;
$('logoutBtn').onclick = async () => {
  await Account.logout();
  account = null;
  showAcctMsg('');
  renderAccount();
};

// Tài khoản đổi (trừ/hoàn lượt ở background, đăng nhập ở nơi khác...) thì cập nhật ngay
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.account) {
    account = changes.account.newValue || null;
    renderAccount();
  }
});

async function loadAccount() {
  account = await Account.load();
  renderAccount();
  // Làm mới lượt còn lại và key từ server
  Account.refresh().then((a) => { account = a; renderAccount(); }).catch(() => {});
}

// ---------- Trạng thái lưu ở background ----------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function readSession() {
  return chrome.storage.session.get({ done: {}, noText: {}, job: null });
}

function setSetOf(map, tabId) {
  return new Set((map && map[tabId]) || []);
}

// Gắn trạng thái đã dịch / không có chữ vào từng ảnh. Ảnh đã có trạng thái thì bỏ chọn và khoá.
function applyStates(store) {
  const done = setSetOf(store.done, currentTabId);
  const noText = setSetOf(store.noText, currentTabId);
  for (const it of items) {
    it.done = done.has(it.url);
    it.notext = noText.has(it.url);
    if (it.done || it.notext) it.checked = false;
  }
}

// resetScroll: true khi đổi tab hoặc trang tải lại (danh sách khác hẳn nên về đầu);
// còn lại (nội dung trang đổi, bấm làm mới) thì giữ nguyên vị trí cuộn của danh sách
async function loadImages(resetScroll = false) {
  // Chỉ hiện "Đang tìm ảnh..." lần đầu; đã có danh sách thì giữ nguyên để không bị nhảy lên đầu
  if (!items.length || resetScroll) listEl.innerHTML = '<div class="empty">Đang tìm ảnh...</div>';
  const tab = await activeTab();
  const tabChanged = tab?.id !== currentTabId;
  currentTabId = tab?.id ?? null;
  let res = null;
  if (currentTabId) res = await chrome.tabs.sendMessage(currentTabId, { type: 'LIST_IMAGES' }).catch(() => null);
  const store = await readSession();
  // Mặc định chọn hết, trừ ảnh đã dịch hoặc không có chữ
  items = (res?.images || []).map((x) => ({ ...x, checked: true, done: false, notext: false }));
  applyStates(store);
  busy = !!(store.job && store.job.tabId === currentTabId && store.job.status === 'running');
  render();
  if (resetScroll || tabChanged) listEl.scrollTop = 0;
}

// ---------- Hiển thị ----------
function render() {
  const scrollTop = listEl.scrollTop; // dựng lại danh sách sẽ làm mất vị trí cuộn, nên nhớ lại rồi trả về
  listEl.innerHTML = '';
  if (!items.length) {
    listEl.innerHTML = '<div class="empty">Không tìm thấy ảnh nào trên trang này.</div>';
  }
  for (const it of items) {
    const locked = it.done || it.notext;
    const card = document.createElement('label');
    // Ảnh không có chữ: không hiện ô chọn và không làm mờ; chỉ ảnh đã dịch có nhãn "✓ Đã dịch"
    card.className = 'card' + (it.done ? ' done' : '') + (!it.checked && !it.notext ? ' off' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = it.checked;
    cb.disabled = locked || busy;
    cb.onchange = () => {
      if (busy || locked) { cb.checked = it.checked; return; }
      it.checked = cb.checked;
      card.classList.toggle('off', !it.checked);
      updateFooter();
    };

    const img = document.createElement('img');
    img.src = it.thumb || it.url;
    img.alt = '';
    img.loading = 'lazy';

    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = `${it.w}×${it.h}`;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '✓ Đã dịch';

    // Ảnh đã dịch / không có chữ: bấm vào thì cuộn trang tới đúng ảnh đó
    if (locked) {
      card.title = 'Bấm để cuộn tới ảnh này trên trang';
      card.onclick = (e) => {
        e.preventDefault();
        if (currentTabId != null) chrome.tabs.sendMessage(currentTabId, { type: 'SCROLL_TO_IMAGE', url: it.url }).catch(() => {});
      };
    }

    const parts = [];
    if (!it.notext) parts.push(cb);
    parts.push(img, dim);
    if (it.done) parts.push(badge);
    card.append(...parts);
    listEl.appendChild(card);
  }
  listEl.scrollTop = scrollTop;
  updateFooter();
}

function setAll(value) {
  if (busy) return;
  for (const it of items) if (!it.done && !it.notext) it.checked = value;
  render();
}

function updateFooter() {
  const eligible = items.filter((x) => !x.done && !x.notext);
  const selected = eligible.filter((x) => x.checked).length;
  countEl.textContent = `${selected}/${eligible.length}`;

  // Ô "Chọn hết": tick khi mọi ảnh còn lại đều được chọn
  selectAllCb.checked = eligible.length > 0 && selected === eligible.length;
  selectAllCb.disabled = busy || eligible.length === 0;

  translateBtn.disabled = busy || selected === 0;
  if (busy) translateBtn.textContent = 'Đang dịch...';
  else translateBtn.textContent = selected ? `Dịch ${selected} ảnh đã chọn` : 'Chưa chọn ảnh nào';

  // Chưa đăng nhập: nút này thành nút đăng nhập
  if (!account && !busy) {
    translateBtn.disabled = false;
    translateBtn.textContent = 'Đăng nhập Google để dịch';
  }
}

selectAllCb.onchange = () => setAll(selectAllCb.checked);
$('refresh').onclick = () => loadImages();

translateBtn.onclick = async () => {
  if (busy) return;
  if (!account) { doLogin(); return; }
  const urls = items.filter((x) => x.checked && !x.done && !x.notext).map((x) => x.url);
  if (!urls.length) return;
  const tab = await activeTab();
  if (!tab?.id) return;
  busy = true;
  render();
  const ok = await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_ALL_START', urls }).then(() => true).catch(() => false);
  if (!ok) {
    busy = false;
    render();
  }
};

// ---------- Cập nhật theo thay đổi từ background ----------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || currentTabId == null) return;
  let touched = false;

  if (changes.done || changes.noText) {
    const store = {
      done: changes.done ? changes.done.newValue : undefined,
      noText: changes.noText ? changes.noText.newValue : undefined,
    };
    // Giữ nguyên phần không đổi
    readSession().then((cur) => {
      applyStates({ done: store.done ?? cur.done, noText: store.noText ?? cur.noText });
      render();
    });
    touched = true;
  }

  if (changes.job) {
    const job = changes.job.newValue;
    busy = !!(job && job.tabId === currentTabId && job.status === 'running');
    if (!touched) render();
  }
});

// Trang báo ảnh thay đổi (div bị vẽ lại, thêm/xoá ảnh...) thì làm mới danh sách
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'IMAGES_CHANGED' && sender.tab && sender.tab.id === currentTabId) loadImages();
});

// Đổi tab thì tải lại danh sách của tab mới
chrome.tabs.onActivated.addListener(() => loadImages(true));

// Trang của tab đang xem tải xong thì tự làm mới danh sách
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && tabId === currentTabId) loadImages(true);
});

loadAccount();
loadImages();
