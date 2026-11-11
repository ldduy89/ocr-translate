// Tell the background that the side panel is open (per window) so the floating button on the page can toggle.
// Closing the panel disconnects the port automatically. If the service worker sleeps and drops the port, reconnect.
(async () => {
  let winId;
  try { winId = (await chrome.windows.getCurrent()).id; } catch (_) { return; }
  const connect = () => {
    const port = chrome.runtime.connect({ name: 'sidepanel:' + winId });
    port.onMessage.addListener((m) => { if (m && m.type === 'CLOSE_PANEL') window.close(); });
    port.onDisconnect.addListener(() => setTimeout(connect, 300));
  };
  connect();
})();

// Target language for the translation step: [code, display name]. The name sent to Gemini is in background.js (TARGET_NAMES).
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
const modal = $('modal');         // settings
const userModal = $('userModal'); // account
const buyModal = $('buyModal'); // buy translation credits

let items = []; // { url, w, h, checked, done, notext }
let currentTabId = null;
let busy = false; // translating in the current tab
let account = null; // { token, user: {...} } or null if not signed in

// ---------- Target language: search box + list ----------
const langBox = $('langBox');
const langInput = $('langInput');
const langList = $('langList');
const langCollator = new Intl.Collator('vi'); // sort alphabetically using Vietnamese rules
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
    // mousedown (not click) so the language is selected before the search box loses focus
    row.onmousedown = (e) => { e.preventDefault(); pickLang(v); };
    langList.appendChild(row);
  }
}

function openLang() {
  langInput.value = '';
  langInput.placeholder = langLabel(langValue); // the selected language shows as a hint; type to search
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
  langInput.blur(); // onblur closes the list and shows the selected language name
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
// Clicking the magnifier icon also opens the search box
document.querySelector('.lang-icon').style.pointerEvents = 'auto';
document.querySelector('.lang-icon').onclick = () => langInput.focus();

chrome.storage.sync.get(DEFAULTS).then((s) => {
  langValue = TARGET_OPTIONS.some(([v]) => v === s.targetLang) ? s.targetLang : DEFAULTS.targetLang;
  langInput.value = langLabel(langValue);
});

// Open modal: the dialog zooms out from the clicked icon (offset calculated from the icon center to the dialog center)
function openModal(modalEl, fromBtn) {
  const dlg = modalEl.querySelector('.dialog');
  if (fromBtn) {
    // Turn off the transition while positioning, so the frame sits at the icon before zooming out
    dlg.style.transition = 'none';
    dlg.style.transform = 'none';
    const d = dlg.getBoundingClientRect();
    dlg.style.transform = '';
    const r = fromBtn.getBoundingClientRect();
    dlg.style.setProperty('--fx', ((r.left + r.width / 2) - (d.left + d.width / 2)) + 'px');
    dlg.style.setProperty('--fy', ((r.top + r.height / 2) - (d.top + d.height / 2)) + 'px');
    void dlg.offsetWidth; // lock the shrunk position at the icon (the transition is off now)
    dlg.style.transition = '';
  }
  modalEl.classList.add('show');
}

$('settings').onclick = () => openModal(modal, $('settings'));
$('closeSettings').onclick = () => modal.classList.remove('show');
modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('show'); };

// ---------- Account (separate modal) ----------
$('userBtn').onclick = () => openModal(userModal, $('userBtn'));
$('closeUser').onclick = () => userModal.classList.remove('show');
userModal.onclick = (e) => { if (e.target === userModal) userModal.classList.remove('show'); };

// Press Esc to close the open popup
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { modal.classList.remove('show'); userModal.classList.remove('show'); }
});

// ---------- Account ----------
function showAcctMsg(text) {
  $('acctMsg').textContent = text || '';
}

$('acctId').addEventListener('click', async () => {
  const u = account && account.user;
  if (!u || u.id == null) return;
  try {
    await navigator.clipboard.writeText(String(u.id));
    const el = $('acctId');
    el.textContent = 'Đã sao chép ID';
    setTimeout(renderAccount, 1200);
  } catch { /* ignore */ }
});

function renderAccount() {
  const u = account && account.user;
  $('userBtn').title = u ? `${u.email}: còn ${u.credits} lượt dịch (miễn phí ${u.credits_free ?? 0}, đã mua ${u.credits_paid ?? 0})` : 'Đăng nhập Google';
  const initial = u ? String(u.name || u.email || '?').trim().charAt(0).toUpperCase() : '?';
  $('acctAvatar').textContent = initial || '?';
  $('acctName').textContent = u ? (u.name || u.email) : 'Chưa đăng nhập';
  $('acctEmail').textContent = u ? u.email : '';
  const idEl = $('acctId');
  idEl.textContent = u && u.id != null ? `ID: ${u.id}` : '';
  idEl.style.display = u && u.id != null ? '' : 'none';
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

// Refresh credits and info from the server with the button in the modal
// ---------- Buy credits: list packages (for reference only), show VietQR bank transfer QR ----------
// No package selected: the customer enters the amount when transferring; the note = "Ho tro <id user>" for reconciliation.
const PACKAGES = [
  { vnd: 20000, n: 50 },
  { vnd: 100000, n: 300 },
  { vnd: 200000, n: 700 },
  { vnd: 500000, n: 2000 },
];
const fmtVnd = (v) => v.toLocaleString('vi-VN') + 'đ';

function renderPackages() {
  const box = $('pkgs');
  box.innerHTML = '';
  for (const p of PACKAGES) {
    const row = document.createElement('div');
    row.className = 'pkg';
    row.innerHTML = `<b>${fmtVnd(p.vnd)}</b><span>${p.n} lần dịch</span>`;
    box.appendChild(row);
  }
}

function renderQr() {
  const u = account && account.user;
  if (!u || u.id == null) {
    $('qrImg').removeAttribute('src');
    $('qrImg').style.display = 'none';
    $('qrNote').textContent = 'Chưa có mã tài khoản. Bấm làm mới rồi thử lại.';
    return;
  }
  $('qrImg').style.display = '';
  $('qrImg').src = `https://img.vietqr.io/image/TPB-10006451830-qr_only.svg?&addInfo=Ho%20tro%20${u.id}`;
  const note = $('qrNote');
  note.textContent = '';
  const content = document.createElement('div');
  content.className = 'qr-content';
  content.append('Nội Dung: ');
  const idSpan = document.createElement('span');
  idSpan.className = 'qr-id';
  idSpan.textContent = String(u.id);
  content.append(idSpan);
  note.append(content);
  // Payments are processed within 5 minutes; press refresh to update the status, or contact the fanpage
  const hint = document.createElement('div');
  hint.className = 'qr-hint';
  hint.append('Thông tin sẽ được xử lý trong vòng 5 phút. Hãy nhấn nút làm mới để cập nhật và kiểm tra trạng thái, hoặc liên hệ fanpage: ');
  const a = document.createElement('a');
  a.href = 'https://www.facebook.com/people/AI-Image-Translate/61596497217359/';
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'AI Image Translate';
  hint.append(a);
  note.append(hint);
}

// Open the "Buy credits" modal from the button in the account modal
$('buyToggle').onclick = async () => {
  renderPackages();
  $('qrBox').style.display = 'none';
  openModal(buyModal, $('buyToggle'));
  // An account saved before the server returned its id has no id yet: fetch it from the server before creating the QR
  if (!(account && account.user && account.user.id != null)) await refreshAccount();
  renderQr();
  $('qrBox').style.display = '';
};
$('closeBuy').onclick = () => buyModal.classList.remove('show');
buyModal.onclick = (e) => { if (e.target === buyModal) buyModal.classList.remove('show'); };

// Refresh credits and info from the server (the button exists in both states)
let refreshingAcct = false;
async function refreshAccount() {
  if (refreshingAcct) return;
  refreshingAcct = true;
  const btns = document.querySelectorAll('.refresh-btn');
  const hadAccount = !!account;
  btns.forEach((b) => { b.disabled = true; b.classList.add('spinning'); });
  showAcctMsg('');
  try {
    const stored = await Account.load();
    if (!stored) {
      // No account saved in the extension: cannot call /me, so tell the user
      showAcctMsg('Chưa có tài khoản đã lưu. Hãy đăng nhập lại.');
      account = null;
    } else {
      const next = await Account.refresh();
      console.log('[acct] làm mới: /me ->', next ? 'ok' : 'null');
      account = next;
      if (!next && hadAccount) showAcctMsg('Phiên đăng nhập đã hết. Hãy đăng nhập lại.');
    }
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
    openModal(userModal, $('userBtn')); // show the user the reason for the error
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

// Account changed (credits deducted or refunded in background, signed in elsewhere...): update immediately
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.account) {
    account = changes.account.newValue || null;
    renderAccount();
  }
});

async function loadAccount() {
  account = await Account.load();
  renderAccount();
  // Refresh remaining credits and key from the server
  Account.refresh().then((a) => { account = a; renderAccount(); }).catch(() => {});
}

// ---------- State stored in background ----------
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

// Attach translated / no-text state to each image. Images with a state are unselected and locked.
function applyStates(store) {
  const done = setSetOf(store.done, currentTabId);
  const noText = setSetOf(store.noText, currentTabId);
  for (const it of items) {
    it.done = done.has(it.url);
    it.notext = noText.has(it.url);
    if (it.done || it.notext) it.checked = false;
  }
}

// resetScroll: true when switching tabs or when the page reloads (the list is completely different, so go back to the top);
// otherwise (page content changed, refresh pressed) keep the list's scroll position
async function loadImages(resetScroll = false) {
  // Show "Searching for images..." only the first time; if the list already exists, keep it so it does not jump to the top
  if (!items.length || resetScroll) listEl.innerHTML = '<div class="empty">Đang tìm ảnh...</div>';
  const tab = await activeTab();
  const tabChanged = tab?.id !== currentTabId;
  currentTabId = tab?.id ?? null;
  let res = null;
  if (currentTabId) res = await chrome.tabs.sendMessage(currentTabId, { type: 'LIST_IMAGES' }).catch(() => null);
  const store = await readSession();
  // Select all by default, except translated or no-text images
  items = (res?.images || []).map((x) => ({ ...x, checked: true, done: false, notext: false }));
  applyStates(store);
  busy = !!(store.job && store.job.tabId === currentTabId && store.job.status === 'running');
  render();
  if (resetScroll || tabChanged) listEl.scrollTop = 0;
}

// ---------- Display ----------
function render() {
  const scrollTop = listEl.scrollTop; // rebuilding the list would lose the scroll position, so remember it and restore it
  listEl.innerHTML = '';
  if (!items.length) {
    listEl.innerHTML = '<div class="empty">Không tìm thấy ảnh nào trên trang này.</div>';
  }
  for (const it of items) {
    const locked = it.done || it.notext;
    const card = document.createElement('label');
    // No-text images: no checkbox and not dimmed; only translated images show a "✓ Translated" label
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

    // Translated / no-text images: clicking scrolls the page to that image
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

  // "Select all" checkbox: checked when every remaining image is selected
  selectAllCb.checked = eligible.length > 0 && selected === eligible.length;
  selectAllCb.disabled = busy || eligible.length === 0;

  // Translating: the button becomes "Cancel" (still clickable); unfinished images will be refunded
  translateBtn.disabled = !busy && selected === 0;
  if (busy) translateBtn.textContent = 'Hủy dịch';
  else translateBtn.textContent = selected ? `Dịch ${selected} ảnh đã chọn` : 'Chưa chọn ảnh nào';

  // Not signed in: this button becomes the sign-in button
  if (!account && !busy) {
    translateBtn.disabled = false;
    translateBtn.textContent = 'Đăng nhập Google để dịch';
  }
}

selectAllCb.onchange = () => setAll(selectAllCb.checked);
$('refresh').onclick = () => loadImages();

translateBtn.onclick = async () => {
  if (busy) {
    const tab = await activeTab();
    if (tab?.id != null) chrome.runtime.sendMessage({ type: 'CANCEL_TRANSLATE', tabId: tab.id });
    translateBtn.disabled = true;
    translateBtn.textContent = 'Đang hủy...';
    return;
  }
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

// ---------- Updates from background ----------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || currentTabId == null) return;
  let touched = false;

  if (changes.done || changes.noText) {
    const store = {
      done: changes.done ? changes.done.newValue : undefined,
      noText: changes.noText ? changes.noText.newValue : undefined,
    };
    // Keep the unchanged parts
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

// Page reports an image change (div redrawn, images added or removed...): refresh the list
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'IMAGES_CHANGED' && sender.tab && sender.tab.id === currentTabId) loadImages();
});

// Switching tabs: reload the list for the new tab
chrome.tabs.onActivated.addListener(() => loadImages(true));

// When the active tab's page finishes loading, refresh the list automatically
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && tabId === currentTabId) loadImages(true);
});

loadAccount();
loadImages();
