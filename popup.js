// Ngôn ngữ đích cho bước dịch
const TARGET_OPTIONS = [
  ['vi', 'Tiếng Việt'],
  ['en', 'Tiếng Anh'],
  ['ko', 'Tiếng Hàn'],
  ['ja', 'Tiếng Nhật'],
  ['zh-CN', 'Tiếng Trung (giản thể)'],
  ['fr', 'Tiếng Pháp'],
];

const DEFAULTS = { targetLang: 'vi' };

const tgtSel = document.getElementById('targetLang');
const keyInput = document.getElementById('geminiKey');

function fill(sel, options, value) {
  sel.innerHTML = '';
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = value;
}

chrome.storage.sync.get(DEFAULTS).then((s) => fill(tgtSel, TARGET_OPTIONS, s.targetLang));
chrome.storage.local.get({ geminiKey: '' }).then((k) => { keyInput.value = k.geminiKey; });

tgtSel.onchange = () => chrome.storage.sync.set({ targetLang: tgtSel.value });
keyInput.onchange = () => chrome.storage.local.set({ geminiKey: keyInput.value.trim() });

document.getElementById('translateAll').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_ALL_START' }).catch(() => {});
  window.close();
};

document.getElementById('start').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'START_SELECTION' }).catch(() => {});
  window.close();
};
