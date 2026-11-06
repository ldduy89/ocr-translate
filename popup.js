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
const modal = $('modal');

let items = []; // { url, w, h, checked, done, notext }
let currentTabId = null;
let busy = false; // đang dịch ở tab hiện tại

function fill(sel, options, value) {
  sel.innerHTML = '';
  // Sắp xếp theo bảng chữ cái tiếng Việt
  const collator = new Intl.Collator('vi');
  const sorted = [...options].sort((a, b) => collator.compare(a[1], b[1]));
  for (const [v, label] of sorted) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = options.some(([v]) => v === value) ? value : 'vi';
}

// ---------- Cài đặt (modal) ----------
chrome.storage.sync.get(DEFAULTS).then((s) => fill($('targetLang'), TARGET_OPTIONS, s.targetLang));
chrome.storage.local.get({ geminiKey: '' }).then((k) => { $('geminiKey').value = k.geminiKey; });

$('targetLang').onchange = () => chrome.storage.sync.set({ targetLang: $('targetLang').value });
$('geminiKey').onchange = () => chrome.storage.local.set({ geminiKey: $('geminiKey').value.trim() });

$('settings').onclick = () => modal.classList.add('show');
$('closeSettings').onclick = () => modal.classList.remove('show');
modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('show'); };

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

async function loadImages() {
  listEl.innerHTML = '<div class="empty">Đang tìm ảnh...</div>';
  const tab = await activeTab();
  currentTabId = tab?.id ?? null;
  let res = null;
  if (currentTabId) res = await chrome.tabs.sendMessage(currentTabId, { type: 'LIST_IMAGES' }).catch(() => null);
  const store = await readSession();
  // Mặc định chọn hết, trừ ảnh đã dịch hoặc không có chữ
  items = (res?.images || []).map((x) => ({ ...x, checked: true, done: false, notext: false }));
  applyStates(store);
  busy = !!(store.job && store.job.tabId === currentTabId && store.job.status === 'running');
  render();
}

// ---------- Hiển thị ----------
function render() {
  listEl.innerHTML = '';
  if (!items.length) {
    listEl.innerHTML = '<div class="empty">Không tìm thấy ảnh nào trên trang này.</div>';
  }
  for (const it of items) {
    const locked = it.done || it.notext;
    const card = document.createElement('label');
    card.className = 'card' + (it.done ? ' done' : '') + (it.notext ? ' notext' : '') + (!it.checked ? ' off' : '');

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
    badge.textContent = it.done ? '✓ Đã dịch' : 'Không có chữ';

    card.append(cb, img, dim, badge);
    listEl.appendChild(card);
  }
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
}

selectAllCb.onchange = () => setAll(selectAllCb.checked);
$('refresh').onclick = () => loadImages();

translateBtn.onclick = async () => {
  if (busy) return;
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

// Đổi tab thì tải lại danh sách của tab mới
chrome.tabs.onActivated.addListener(() => loadImages());

// Trang của tab đang xem tải xong thì tự làm mới danh sách
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && tabId === currentTabId) loadImages();
});

loadImages();
