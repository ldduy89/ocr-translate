// Mở cài đặt bằng Side Panel khi bấm icon trên thanh công cụ, thay cho popup
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.warn('[sidePanel]', err.message));

const DEFAULTS = { targetLang: 'vi' };

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

// ---------- Menu chuột phải ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-image',
      title: 'AI Image Translate: dịch ảnh này',
      contexts: ['image'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'translate-image' && tab?.id) {
    runImageViewer(tab.id, info.srcUrl);
  }
});


// ---------- Gemini: đọc và dịch bằng mô hình thị giác ----------
const TARGET_NAMES = {
  'vi': 'Vietnamese',
  'en': 'English',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  'ja': 'Japanese',
  'ko': 'Korean',
  'th': 'Thai',
  'id': 'Indonesian',
  'ms': 'Malay',
  'fil': 'Filipino',
  'km': 'Khmer',
  'lo': 'Lao',
  'my': 'Burmese',
  'mn': 'Mongolian',
  'hi': 'Hindi',
  'bn': 'Bengali',
  'ur': 'Urdu',
  'ta': 'Tamil',
  'te': 'Telugu',
  'mr': 'Marathi',
  'gu': 'Gujarati',
  'pa': 'Punjabi',
  'kn': 'Kannada',
  'ml': 'Malayalam',
  'ne': 'Nepali',
  'si': 'Sinhala',
  'ar': 'Arabic',
  'fa': 'Persian',
  'he': 'Hebrew',
  'tr': 'Turkish',
  'kk': 'Kazakh',
  'uz': 'Uzbek',
  'az': 'Azerbaijani',
  'ka': 'Georgian',
  'hy': 'Armenian',
  'ru': 'Russian',
  'uk': 'Ukrainian',
  'be': 'Belarusian',
  'fr': 'French',
  'de': 'German',
  'es': 'Spanish',
  'pt': 'Portuguese',
  'it': 'Italian',
  'nl': 'Dutch',
  'sv': 'Swedish',
  'no': 'Norwegian',
  'da': 'Danish',
  'fi': 'Finnish',
  'is': 'Icelandic',
  'pl': 'Polish',
  'cs': 'Czech',
  'sk': 'Slovak',
  'hu': 'Hungarian',
  'ro': 'Romanian',
  'bg': 'Bulgarian',
  'sr': 'Serbian',
  'hr': 'Croatian',
  'sl': 'Slovenian',
  'et': 'Estonian',
  'lv': 'Latvian',
  'lt': 'Lithuanian',
  'el': 'Greek',
  'sq': 'Albanian',
  'mk': 'Macedonian',
  'bs': 'Bosnian',
  'ca': 'Catalan',
  'eu': 'Basque',
  'gl': 'Galician',
  'ga': 'Irish',
  'cy': 'Welsh',
  'sw': 'Swahili',
  'am': 'Amharic',
  'af': 'Afrikaans',
  'ha': 'Hausa',
  'yo': 'Yoruba',
  'ig': 'Igbo',
  'zu': 'Zulu',
  'eo': 'Esperanto',
  'la': 'Latin',
};

// Key mặc định; key nhập trong popup (nếu có) sẽ được ưu tiên

async function getGeminiKey() {
  const { geminiKey } = await chrome.storage.local.get({ geminiKey: '' });
  const key = geminiKey;
  if (!key) throw new Error('Chưa nhập API key Gemini trong popup.');
  return key;
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Danh sách mô hình, thử lần lượt. Mô hình dùng được lần trước được nhớ để gọi trước lần sau.
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
];
const CYCLE_WAIT_MS = 10000;
const MAX_CYCLES = 2;

async function getSavedModelIndex() {
  const { geminiModelIndex } = await chrome.storage.local.get({ geminiModelIndex: 0 });
  return geminiModelIndex < GEMINI_MODELS.length ? geminiModelIndex : 0;
}

// Gọi một mô hình một lần; lỗi sẽ được ném ra để chuyển sang mô hình khác
async function requestGemini(apiKey, model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 150);
    throw new Error(`${model}: HTTP ${res.status} ${detail}`);
  }
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

// Thử lần lượt các mô hình; parse(text) đọc kết quả, lỗi ở đây cũng chuyển sang mô hình khác
async function geminiRotate(apiKey, body, parse) {
  const start = await getSavedModelIndex();
  const errors = [];
  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    for (let k = 0; k < GEMINI_MODELS.length; k++) {
      const idx = (start + k) % GEMINI_MODELS.length;
      const model = GEMINI_MODELS[idx];
      try {
        const text = await requestGemini(apiKey, model, body);
        const value = parse(text, model);
        await chrome.storage.local.set({ geminiModelIndex: idx });
        return value;
      } catch (err) {
        errors.push(err.message);
        console.warn('[Gemini]', err.message);
      }
    }
    if (cycle < MAX_CYCLES - 1) {
      await new Promise((r) => setTimeout(r, CYCLE_WAIT_MS));
    }
  }
  throw new Error('Tất cả mô hình Gemini đều lỗi: ' + errors.slice(-3).join(' | '));
}

function parseJsonText(text, model) {
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (_) {
    throw new Error(`${model}: trả về không phải JSON`);
  }
}

// Gọi cho một ảnh
async function callGemini(apiKey, base64, mime, targetLang) {
  const target = TARGET_NAMES[targetLang] || targetLang;
  const prompt = `This image is a comic/manga page or a screenshot containing speech bubbles or caption text.
Find every block of readable text. Merge lines that belong to the same sentence or bubble into one block.
For each block return:
- "original": the exact text as written, in its original language, with line breaks replaced by spaces.
- "translated": a natural translation into ${target}.
- "bubble_box": [ymin, xmin, ymax, xmax], integers normalized to 0-1000 relative to the image size. Its meaning depends on how the text is presented:
  * speech bubble (round, oval, cloud, spiky): the outer edge of the bubble outline, touching its leftmost, rightmost, topmost and bottommost points.
  * rectangular dialogue or caption box (square or rounded rectangle, narration box): the ENTIRE box including its border.
  * text with NO bubble or box (lettering placed directly on the artwork): only a tight box around the text characters, including their outline/stroke/glow, and nothing else.
  Never include the bubble tail/pointer, other bubbles, or surrounding artwork.
- "text_box": the tight bounding box [ymin, xmin, ymax, xmax] of only the printed text lines inside, same 0-1000 normalization.
- "shape": "ellipse" only if the bubble is round, oval, cloud-like or spiky; "rect" for rectangular/square boxes and for text with no bubble.
- "lines": the number of text lines of the ORIGINAL block as printed (count columns if the text is vertical).
- "vertical": true if the original text runs top-to-bottom in columns, otherwise false.
- "font_size": the em size of the original text (height of one character line) in the same 0-1000 units as the image height. For example, on an image 1000 px tall, text with 25 px characters is 25. Estimate from the glyph size, not the bubble.
Only translate dialogue, narration and caption text. SKIP all sound effects and onomatopoeia (stylized or hand-lettered words for noises, ambient sounds, heartbeats, whispering, footsteps, impacts, laughter or crying sounds, etc., e.g. "ドキドキ", "ざわざわ", "BAM", "thump", "bisbis"), as well as isolated interjections or mimetic words that only describe the scene rather than being spoken or narrated. Do not return a block for them at all.
Return ONLY JSON in this form: {"blocks":[{"original":"...","translated":"...","bubble_box":[0,0,0,0],"text_box":[0,0,0,0],"shape":"ellipse","lines":1,"font_size":30,"vertical":false}]}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: base64 } }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  const parsed = await geminiRotate(apiKey, body, parseJsonText);
  return Array.isArray(parsed.blocks) ? parsed.blocks : [];
}

// Gemini có thể trả khung dạng [ymin, xmin, ymax, xmax] hoặc danh sách nhiều khung;
// với nhiều khung thì gộp thành một khung bao tất cả
function normalizeBox(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const boxes = Array.isArray(raw[0]) ? raw : [raw];
  let ymin = Infinity, xmin = Infinity, ymax = -Infinity, xmax = -Infinity;
  for (const bx of boxes) {
    if (!Array.isArray(bx) || bx.length !== 4) continue;
    const [a, b2, c, d] = bx.map((v) => Number(v));
    if ([a, b2, c, d].some((v) => Number.isNaN(v))) continue;
    ymin = Math.min(ymin, a);
    xmin = Math.min(xmin, b2);
    ymax = Math.max(ymax, c);
    xmax = Math.max(xmax, d);
  }
  if (ymin === Infinity) return null;
  return [ymin, xmin, ymax, xmax];
}

// Mốc chuẩn hoá: luôn dùng 1000 cho cả hai chiều
function boxDenominators(blocks) {
  return { dx: 1000, dy: 1000 };
}

// Đổi danh sách khung từ Gemini thành items để phủ lên trang
// Ghép kết quả Gemini với từng ảnh trong lô. Ưu tiên index; nếu index thiếu hoặc lệch thì theo thứ tự.
function mapImageResults(result, count) {
  const list = Array.isArray(result.images) ? result.images : [];
  const byIndex = new Map();
  for (const e of list) {
    const idx = Number(e && e.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < count) byIndex.set(idx, e.blocks || []);
  }
  // Không đoán theo vị trí: ảnh nào Gemini không trả đúng số thứ tự thì trả về null để gửi lại riêng
  const noIndexes = list.length === count && list.every((e) => e && e.index === undefined);
  return Array.from({ length: count }, (_, i) => {
    if (byIndex.has(i)) return byIndex.get(i);
    if (noIndexes) return list[i].blocks || [];
    return null;
  });
}

// Cỡ một dòng chữ gốc (px ảnh gốc) = cạnh dọc theo hướng xếp dòng / số dòng.
// Chữ ngang: chia chiều cao khung cho số dòng; chữ dọc: chia chiều rộng cho số cột.
function linePitch(b, raw) {
  const n = Math.round(Number(b.lines));
  if (!Number.isFinite(n) || n < 1 || n > 30) return null;
  const span = b.vertical ? raw.x1 - raw.x0 : raw.y1 - raw.y0;
  const pitch = span / n;
  return pitch >= 6 ? Math.round(pitch) : null;
}

// Đổi font_size của Gemini (thang 0-1000 theo chiều cao ảnh) sang px. Trả về null nếu vô lý.
function fontPxFrom(b, H) {
  const f = Number(b.font_size);
  if (!Number.isFinite(f) || f < 5 || f > 400) return null;
  return (f / 1000) * H;
}

// Khung sát nét chữ thật: bao các điểm ảnh khác hẳn màu nền trong khung Gemini.
// Khung Gemini thường rộng hơn chữ, nên đo trực tiếp trên ảnh cho cỡ chữ gốc chính xác hơn.
function inkBounds(data, W, raw, bg) {
  const x0 = Math.max(0, Math.floor(raw.x0)), x1 = Math.ceil(raw.x1);
  const y0 = Math.max(0, Math.floor(raw.y0)), y1 = Math.ceil(raw.y1);
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const rows = new Uint16Array(h);
  const cols = new Uint16Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = ((y0 + y) * W + (x0 + x)) * 4;
      const d = Math.abs(data[o] - bg.r) + Math.abs(data[o + 1] - bg.g) + Math.abs(data[o + 2] - bg.b);
      if (d > 200) { rows[y]++; cols[x]++; }
    }
  }
  const first = (arr) => { for (let i = 0; i < arr.length; i++) if (arr[i] >= 2) return i; return -1; };
  const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= 2) return i; return -1; };
  const ty0 = first(rows), ty1 = last(rows), tx0 = first(cols), tx1 = last(cols);
  if (ty0 < 0 || tx0 < 0 || ty1 - ty0 < 3 || tx1 - tx0 < 3) return null;
  let count = 0;
  for (let i = 0; i < h; i++) count += rows[i];
  return { x0: x0 + tx0, x1: x0 + tx1 + 1, y0: y0 + ty0, y1: y0 + ty1 + 1, count, area: w * h };
}

// Hai khung đã nới có thể đè lên nhau (hai bong bóng dính liền): cắt tại điểm giữa
// khoảng trống giữa hai khung chữ gốc, không bao giờ cắt vào chữ gốc của chính khung đó
function avoidOverlap(items) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (!a.raw || !b.raw) continue;
      if (a.fromBubble && b.fromBubble) continue; // khung bong bóng chính xác, không cần cắt
      const A = a.box, B = b.box;
      if (A.x1 <= B.x0 || B.x1 <= A.x0 || A.y1 <= B.y0 || B.y1 <= A.y0) continue;
      const ra = a.raw, rb = b.raw;
      const gapY = Math.max(rb.y0 - ra.y1, ra.y0 - rb.y1);
      const gapX = Math.max(rb.x0 - ra.x1, ra.x0 - rb.x1);
      if (gapY <= 0 && gapX <= 0) continue; // chữ gốc đã chồng nhau: không xử lý
      if (gapY >= gapX) {
        const [up, down, rUp, rDown] = ra.y1 <= rb.y0 ? [a, b, ra, rb] : [b, a, rb, ra];
        const mid = (rUp.y1 + rDown.y0) / 2;
        up.box.y1 = Math.min(up.box.y1, Math.max(rUp.y1, mid));
        down.box.y0 = Math.max(down.box.y0, Math.min(rDown.y0, mid));
      } else {
        const [left, right, rLeft, rRight] = ra.x1 <= rb.x0 ? [a, b, ra, rb] : [b, a, rb, ra];
        const mid = (rLeft.x1 + rRight.x0) / 2;
        left.box.x1 = Math.min(left.box.x1, Math.max(rLeft.x1, mid));
        right.box.x0 = Math.max(right.box.x0, Math.min(rRight.x0, mid));
      }
    }
  }
}

// Dựng một item từ khối Gemini. raw = khung chữ; bubble = khung bong bóng (mép ngoài) nếu có.
// Có khung bong bóng thì dùng luôn, không đoán thêm; thiếu hoặc vô lý thì quay về cách cũ (nới theo màu nền).
function buildItem(b, raw, bubble, data, W, H, clipY, strict) {
  const y0lim = clipY ? clipY.y0 : 0;
  const y1lim = clipY ? clipY.y1 : H;
  const area = (r) => Math.max(1, (r.x1 - r.x0) * (r.y1 - r.y0));
  let box, bg, fromBubble = false;
  if (bubble && area(bubble) <= area(raw) * 40) {
    box = {
      x0: Math.max(0, Math.min(bubble.x0, raw.x0)),
      x1: Math.min(W, Math.max(bubble.x1, raw.x1)),
      y0: Math.max(y0lim, Math.min(bubble.y0, raw.y0)),
      y1: Math.min(y1lim, Math.max(bubble.y1, raw.y1)),
    };
    bg = dominantColor(data, W, Math.max(0, Math.floor(raw.x0)), Math.max(0, Math.floor(raw.y0)), Math.min(W, Math.ceil(raw.x1)), Math.min(H, Math.ceil(raw.y1)));
    fromBubble = true;
  } else {
    const r = analyzeBox(data, W, H, raw);
    bg = r.bg;
    box = { x0: r.box.x0, x1: r.box.x1, y0: Math.max(y0lim, r.box.y0), y1: Math.min(y1lim, r.box.y1) };
  }
  // Vùng chữ gần như trống (không có nét chữ nào): khối bị gán nhầm sang ảnh này -> bỏ
  const ink = inkBounds(data, W, raw, bg);
  // Chế độ chặt (chỉ dùng cho khối của vòng cuối, dễ bị model "bịa"): vùng chữ thật phải có nền khá đồng màu
  // và có lượng nét chữ hợp lý; vùng tranh vẽ/nhiễu bị loại thay vì vẽ sub đè lên tranh.
  if (strict && ink && (bg.frac < 0.35 || ink.count / ink.area < 0.015)) {
    console.warn('[OCR] bỏ khối (vòng kiểm tra lại): vùng này không giống chữ trong bong bóng (vòng cuối)', { original: b.original, bgFrac: bg.frac, inkRatio: ink.count / ink.area });
    return null;
  }
  // Chữ chỉ có dấu chấm/ba chấm (ví dụ "....") có rất ít nét nên không qua được kiểm tra nét.
  // Với loại này vẫn giữ khối, dùng chính khung text_box để đo khoảng dòng.
  const punctOnly = /^[\s.,…·!?~\-]+$/.test(String(b.original || ''));
  if (!punctOnly && (!ink || ink.count < Math.max(20, ink.area * 0.001))) {
    console.warn('[OCR] bỏ khối: không thấy nét chữ trong vùng text_box', { original: b.original, raw, bg, ink });
    return null;
  }
  const ellipse = fromBubble && String(b.shape || '').toLowerCase() === 'ellipse';
  return {
    box, conf: 100, original: b.original || '', translated: b.translated, bg, raw,
    fromBubble, shape: ellipse ? 'ellipse' : 'rect',
    linePx: linePitch(b, ink || box),
    fontPx: fontPxFrom(b, H),
  };
}

// Đọc khung chữ và khung bong bóng của một khối (chuẩn hoá 0-1000)
function blockBoxes(b) {
  const bubbleNb = normalizeBox(b.bubble_box) || normalizeBox(b.box);
  const textNb = normalizeBox(b.text_box) || bubbleNb;
  return { textNb, bubbleNb };
}

function itemsFromBlocks(blocks, bitmap, strict) {
  const W = bitmap.width;
  const H = bitmap.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, W, H).data;
  const items = [];
  const { dx, dy } = boxDenominators(blocks);
  const toRect = (nb) => ({ x0: (nb[1] / dx) * W, y0: (nb[0] / dy) * H, x1: (nb[3] / dx) * W, y1: (nb[2] / dy) * H });
  for (const b of blocks) {
    if (!b || !b.translated) continue;
    const { textNb, bubbleNb } = blockBoxes(b);
    if (!textNb) {
      console.warn('[OCR] bỏ khối: thiếu/không đọc được text_box', b);
      continue;
    }
    const raw = toRect(textNb);
    if (raw.x1 - raw.x0 < 4 || raw.y1 - raw.y0 < 4) {
      console.warn('[OCR] bỏ khối: text_box nhỏ hơn 4px', { original: b.original, raw, W, H });
      continue;
    }
    const it = buildItem(b, raw, bubbleNb ? toRect(bubbleNb) : null, data, W, H, null, strict);
    if (it) items.push(it);
  }
  avoidOverlap(items);
  return items;
}

// Ảnh gần như một màu (khoảng đen/trắng ngăn cách): không cần gửi cho Gemini
function isBlankBitmap(bmp) {
  const w = 256;
  const h = Math.max(8, Math.min(2400, Math.round((w * bmp.height) / bmp.width)));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < n; i++) { mr += d[i * 4]; mg += d[i * 4 + 1]; mb += d[i * 4 + 2]; }
  mr /= n; mg /= n; mb /= n;
  let diff = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(d[i * 4] - mr) + Math.abs(d[i * 4 + 1] - mg) + Math.abs(d[i * 4 + 2] - mb) > 40) diff++;
  }
  return diff < 6;
}

// Nhắc cứng số lượng ảnh để Gemini không bỏ qua ảnh không có chữ
function countReminder(n) {
  return `\n\nThis request contains exactly ${n} image${n === 1 ? '' : 's'}: labels "Image 0" to "Image ${n - 1}". The "images" array MUST have exactly ${n} entries, one for EVERY index from 0 to ${n - 1}. An image with no text at all (pure artwork, mostly black or empty, a cropped panel) STILL gets its own entry with an empty array, for example {"index":2,"summary":"pot on a table, no text","blocks":[]}. Never omit an entry because the image has nothing to translate.`;
}

const BATCH_MAX_IMAGES = 8; // lô nhỏ: model lite hay trả "no text" hàng loạt khi lô lớn
const BATCH_MAX_BYTES = 10 * 1024 * 1024;
const EXTRA_ROUND = 4; // vòng cuối: chỉ chạy khi vòng 3 còn > 1 ảnh rỗng; chạy xong thì dừng

// Tải ảnh thành Blob. Ảnh blob: chỉ đọc được trong trang tạo ra nó,
// nên nhờ content script đọc giúp rồi gửi về dưới dạng data URL.
async function loadImageBlob(tabId, srcUrl) {
  if (srcUrl.startsWith('blob:')) {
    if (tabId == null) throw new Error('Thiếu tab để đọc ảnh blob:');
    const r = await chrome.tabs.sendMessage(tabId, { type: 'FETCH_BLOB', url: srcUrl }).catch(() => null);
    if (!r || r.error || !r.dataUrl) {
      throw new Error('Không đọc được ảnh blob:' + (r && r.error ? ' (' + r.error + ')' : ''));
    }
    return await (await fetch(r.dataUrl)).blob();
  }
  const res = await fetch(srcUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.blob();
}

// Dịch tất cả ảnh: gửi nhiều ảnh trong một yêu cầu, chia lô khi quá nhiều hoặc quá nặng
async function translateAllGemini(tabId, urls) {
  const { targetLang } = await getSettings();
  const target = TARGET_NAMES[targetLang] || targetLang;
  const apiKey = await getGeminiKey();
  const list = [...new Set(urls)];

  const loaded = [];
  for (const srcUrl of list) {
    try {
      const blob = await loadImageBlob(tabId, srcUrl);
      const mime = (blob.type || 'image/png').split(';')[0];
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error(`định dạng ${mime}`);
      const bmp = await createImageBitmap(blob);
      const tall = SPLIT_TALL_IMAGES && bmp.height > TALL_LIMIT;
      const blank = !tall && isBlankBitmap(bmp);
      bmp.close();
      loaded.push({ srcUrl, blob, mime, tall, blank });
    } catch (err) {
      console.warn('[Gemini] bỏ qua ảnh', srcUrl, err.message);
    }
  }

  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const img of loaded.filter((x) => !x.tall && !x.blank)) {
    if (cur.length && (cur.length >= BATCH_MAX_IMAGES || curBytes + img.blob.size > BATCH_MAX_BYTES)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(img);
    curBytes += img.blob.size;
  }
  if (cur.length) batches.push(cur);

  const prompt = `You are given several images, each labeled "Image N". They are comic/manga pages or screenshots with speech bubbles or caption text.
For each image, find every block of readable text. Merge lines that belong to the same sentence or bubble into one block.
For each block return:
- "original": the exact text as written, in its original language, with line breaks replaced by spaces.
- "translated": a natural translation into ${target}.
- "bubble_box": [ymin, xmin, ymax, xmax], integers normalized to 0-1000 relative to THAT image's size. Its meaning depends on how the text is presented:
  * speech bubble (round, oval, cloud, spiky): the outer edge of the bubble outline, touching its leftmost, rightmost, topmost and bottommost points.
  * rectangular dialogue or caption box (square or rounded rectangle, narration box): the ENTIRE box including its border.
  * text with NO bubble or box (lettering placed directly on the artwork): only a tight box around the text characters, including their outline/stroke/glow, and nothing else.
  Never include the bubble tail/pointer, other bubbles, or surrounding artwork.
- "text_box": the tight bounding box [ymin, xmin, ymax, xmax] of only the printed text lines inside, same 0-1000 normalization.
- "shape": "ellipse" only if the bubble is round, oval, cloud-like or spiky; "rect" for rectangular/square boxes and for text with no bubble.
- "lines": the number of text lines of the ORIGINAL block as printed (count columns if the text is vertical).
- "vertical": true if the original text runs top-to-bottom in columns, otherwise false.
- "font_size": the em size of the original text (height of one character line) in the same 0-1000 units as the image height. For example, on an image 1000 px tall, text with 25 px characters is 25. Estimate from the glyph size, not the bubble.
Only translate dialogue, narration and caption text. SKIP all sound effects and onomatopoeia (stylized or hand-lettered words for noises, ambient sounds, heartbeats, whispering, footsteps, impacts, laughter or crying sounds, etc., e.g. "ドキドキ", "ざわざわ", "BAM", "thump", "bisbis"), as well as isolated interjections or mimetic words that only describe the scene rather than being spoken or narrated. Do not return a block for them at all. Never mix blocks between images.
Return ONLY JSON in this form: {"images":[{"index":0,"summary":"...","blocks":[{"original":"...","translated":"...","bubble_box":[0,0,0,0],"text_box":[0,0,0,0],"shape":"ellipse","lines":1,"font_size":30,"vertical":false}]}]}
Use the same index number as the "Image N" label. Return exactly one entry per label, in the same order, and never skip a label.
In "summary", write 3-8 words describing what THAT specific image shows (e.g. "woman at a desk, no text"), BEFORE listing its blocks. This keeps every block attached to the right image.
Many consecutive images may contain no text at all (just artwork or empty space): that is normal. Return an empty "blocks" array for them. NEVER move text from one image to another to fill a gap, and never shift blocks to the previous or next image. A block belongs only to the image where its text is actually printed, and its boxes are relative to that image.`;

  let ok = 0;
  // Cập nhật tiến độ lên panel trong trang mỗi khi vẽ xong một ảnh
  const progress = () => notify(tabId, { type: 'SHOW_INFO', text: `Đang dịch: ${ok}/${list.length} ảnh...` });
  progress();
  const undrawn = []; // ảnh có khối từ model nhưng không vẽ được
  const drawn = new Set(); // URL ảnh đã vẽ được ít nhất một khối
  const batchErrors = []; // ảnh thuộc lô vòng 1 bị lỗi yêu cầu
  const tallErrors = []; // ảnh rất cao bị lỗi
  const tallEmpty = []; // ảnh rất cao model không trả khối nào
  const RECHECK_HINT = 'Some of these images were reported as having no text in a previous pass. Check each one again. Return blocks only for text that is actually printed in THAT image, with exact boxes; do not guess or invent text. If an image truly has no readable text, return an empty "blocks" array for it.';

  // Gửi một nhóm ảnh trong một yêu cầu; trả về mảng blocks theo từng ảnh (null = thiếu)
  const askBatch = async (imgs, hint) => {
    const parts = [{ text: prompt + countReminder(imgs.length) + (hint ? '\n' + hint : '') }];
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      parts.push({ text: `Image ${i}:` });
      parts.push({ inline_data: { mime_type: img.mime, data: bytesToBase64(new Uint8Array(await img.blob.arrayBuffer())) } });
    }
    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const result = await geminiRotate(apiKey, body, parseJsonText);
    return mapImageResults(result, imgs.length);
  };

  // Dựng khung và vẽ bản dịch cho một ảnh
  const showBlocks = async (img, blocks, canRecheck, round = 1) => {
    const bitmap = await createImageBitmap(img.blob);
    try {
      let items = itemsFromBlocks(blocks, bitmap, round === EXTRA_ROUND); // chỉ kiểm tra chặt ở vòng cuối
      console.log(`[OCR] vòng ${round}: ${blocks.length} khối -> vẽ ${items.length}`, img.srcUrl);
      if (items.length) {
        notify(tabId, { type: 'OVERLAY_IMAGE', srcUrl: img.srcUrl, width: bitmap.width, height: bitmap.height, items });
        ok++;
        progress();
        drawn.add(img.srcUrl);
        await markDone(tabId, img.srcUrl);
      } else if (blocks.length) {
        // Model có trả khối nhưng không khối nào vẽ được: ghi lại để xem trong log
        undrawn.push({ url: img.srcUrl, blocks: blocks.length, round });
        // Không vẽ được khối nào thì coi như không có chữ: bỏ chọn và khoá trong side panel
        await markState(tabId, 'noText', img.srcUrl);
        console.warn(`[OCR] ảnh không vẽ được khối nào (vòng ${round}, ${blocks.length} khối)`, img.srcUrl);
      }
    } finally {
      bitmap.close();
    }
  };

  // Vòng 1: gửi theo lô, vẽ ngay những ảnh đã có chữ. Ảnh trả rỗng/thiếu bị nghi
  // (model lite hay gán "no text" nhầm) -> gom lại để hỏi tiếp ở vòng 2.
  const suspects = [];
  for (const batch of batches) {
    try {
      const perImage = await askBatch(batch);
      for (let i = 0; i < batch.length; i++) {
        const blocks = perImage[i];
        if (blocks === null || blocks.length === 0) {
          suspects.push(batch[i]);
          continue;
        }
        await showBlocks(batch[i], blocks, true);
      }
    } catch (err) {
      console.error('[OCR] lô Gemini lỗi', err);
      batchErrors.push(...batch);
      notify(tabId, { type: 'SHOW_ERROR', error: err.message });
    }
  }

  // Chia ảnh thành các lô theo số lượng và dung lượng
  const makeGroups = (imgs) => {
    const groups = [];
    let cur = [], curBytes = 0;
    for (const img of imgs) {
      if (cur.length && (cur.length >= BATCH_MAX_IMAGES || curBytes + img.blob.size > BATCH_MAX_BYTES)) {
        groups.push(cur);
        cur = [];
        curBytes = 0;
      }
      cur.push(img);
      curBytes += img.blob.size;
    }
    if (cur.length) groups.push(cur);
    return groups;
  };

  // Một vòng gửi lại theo lô. Trả về:
  // empty: ảnh model đã trả lời nhưng không có khối nào (hoặc thiếu trong kết quả)
  // failed: ảnh có yêu cầu bị lỗi (mạng, quota, JSON hỏng), không tính vào ngưỡng
  const runRecheckRound = async (imgs, round) => {
    const empty = [], failed = [];
    for (const group of makeGroups(imgs)) {
      let perImage;
      try {
        perImage = await askBatch(group, RECHECK_HINT);
      } catch (err) {
        console.error(`[OCR] lô kiểm tra lại (vòng ${round}) lỗi`, err);
        failed.push(...group);
        continue;
      }
      for (let i = 0; i < group.length; i++) {
        const blocks = perImage[i];
        if (blocks && blocks.length) await showBlocks(group[i], blocks, false, round);
        else empty.push(group[i]);
      }
    }
    return { empty, failed };
  };

  // Sau vòng 1: suspects là ảnh rỗng/thiếu do model trả lời
  let emptyImgs = suspects;
  let failedImgs = [];

  // Vòng 2 và 3: gửi lại theo lô
  for (let round = 2; round <= 3; round++) {
    const work = [...emptyImgs, ...failedImgs];
    if (!work.length) break;
    ({ empty: emptyImgs, failed: failedImgs } = await runRecheckRound(work, round));
  }

  // Vòng 4: chỉ khi vòng 3 còn hơn 1 ảnh rỗng. Chạy xong thì dừng.
  if (emptyImgs.length > 1) {
    const work = [...emptyImgs, ...failedImgs];
    ({ empty: emptyImgs, failed: failedImgs } = await runRecheckRound(work, EXTRA_ROUND));
  }

  for (const img of loaded.filter((x) => x.tall)) {
    try {
      const { items, width, height } = await geminiImageItems(img.blob, img.mime, apiKey, targetLang);
      if (items.length) {
        notify(tabId, { type: 'OVERLAY_IMAGE', srcUrl: img.srcUrl, width, height, items });
        ok++;
        progress();
        drawn.add(img.srcUrl);
        await markDone(tabId, img.srcUrl);
      } else {
        tallEmpty.push(img.srcUrl);
      }
    } catch (err) {
      tallErrors.push(img.srcUrl);
      console.error('[OCR] ảnh rất cao lỗi', img.srcUrl, err);
      notify(tabId, { type: 'SHOW_ERROR', error: err.message });
    }
  }

  // Tổng kết: mỗi ảnh nằm trong đúng một nhóm
  const loadedUrls = new Set(loaded.map((x) => x.srcUrl));
  const notDrawn = (arr) => [...new Set(arr.map((x) => (typeof x === 'string' ? x : x.srcUrl)))].filter((u) => !drawn.has(u));
  const groups = [
    ['có khối từ model nhưng không vẽ được', [...new Set(undrawn.map((u) => u.url))].filter((u) => !drawn.has(u))],
    ['model trả rỗng sau khi thử hết các vòng', notDrawn(emptyImgs)],
    ['lỗi yêu cầu, không thử lại được', notDrawn([...failedImgs, ...batchErrors])],
    ['ảnh trống (bỏ qua)', notDrawn(loaded.filter((x) => x.blank))],
    ['ảnh rất cao: model trả rỗng', notDrawn(tallEmpty)],
    ['ảnh rất cao: lỗi', notDrawn(tallErrors)],
    ['không tải được ảnh', list.filter((u) => !loadedUrls.has(u))],
  ];
  for (const u of [...groups[1][1], ...groups[3][1], ...groups[4][1]]) await markState(tabId, 'noText', u);
  const sumGroups = groups.reduce((n, [, urls]) => n + urls.length, 0);
  console.group(`[OCR] TỔNG KẾT: ${list.length} ảnh | đã vẽ ${drawn.size} | khác ${sumGroups}`);
  for (const [label, urls] of groups) {
    console.log(`${label}: ${urls.length}`);
    for (const u of urls) console.log('   ' + u);
  }
  if (drawn.size + sumGroups !== list.length) console.warn('[OCR] còn ảnh chưa phân loại:', list.length - drawn.size - sumGroups);
  console.groupEnd();
  notify(tabId, { type: 'SHOW_INFO', text: `Đã dịch ${ok}/${list.length} ảnh.` });
}

// Màu nền quanh khung, dùng để phủ bản dịch
// ---------- Lấy màu nền bong bóng và canh khung theo đúng vùng bong bóng ----------
// Màu nền = màu chiếm nhiều nhất bên trong khung (chữ thường là phần ít hơn), thay vì trung bình vùng xung quanh
function dominantColor(data, W, x0, y0, x1, y1) {
  const hist = new Map();
  const step = 2;
  let total = 0;
  for (let y = y0 + 1; y < y1 - 1; y += step) {
    for (let x = x0 + 1; x < x1 - 1; x += step) {
      total++;
      const o = (y * W + x) * 4;
      const key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
      const e = hist.get(key);
      if (e) { e.n++; e.r += data[o]; e.g += data[o + 1]; e.b += data[o + 2]; }
      else hist.set(key, { n: 1, r: data[o], g: data[o + 1], b: data[o + 2] });
    }
  }
  let best = null;
  for (const e of hist.values()) if (!best || e.n > best.n) best = e;
  if (!best) return { r: 255, g: 255, b: 255, dark: false };
  const r = Math.round(best.r / best.n), g = Math.round(best.g / best.n), b = Math.round(best.b / best.n);
  return { r, g, b, dark: 0.299 * r + 0.587 * g + 0.114 * b < 128, frac: best.n / Math.max(1, total) };
}

// Mở rộng từng cạnh của khung ra ngoài khi dòng/cột kế bên vẫn là màu nền bong bóng,
// để khung bao trọn bong bóng thay vì chỉ phần chữ (Gemini thường trả khung hơi nhỏ hoặc lệch)
function snapToBubble(data, W, H, box, bg) {
  const isBg = (x, y) => {
    const o = (y * W + x) * 4;
    return Math.abs(data[o] - bg.r) + Math.abs(data[o + 1] - bg.g) + Math.abs(data[o + 2] - bg.b) < 60;
  };
  const rowFrac = (y, x0, x1) => {
    let n = 0;
    for (let x = x0; x < x1; x++) if (isBg(x, y)) n++;
    return n / Math.max(1, x1 - x0);
  };
  const colFrac = (x, y0, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y++) if (isBg(x, y)) n++;
    return n / Math.max(1, y1 - y0);
  };
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  // Giới hạn mở rộng rộng rãi; dừng ở khoảng đen giữa các bong bóng nên không tràn sang khung khác
  const grow = Math.min(600, Math.max(200, Math.round(0.8 * Math.max(w, h))));
  const L = Math.max(0, box.x0 - grow), R = Math.min(W, box.x1 + grow);
  const T = Math.max(0, box.y0 - grow), B = Math.min(H, box.y1 + grow);
  const out = { ...box };
  const TH = 0.15; // dòng có chữ dày vẫn còn nhiều màu nền; khoảng đen ngoài bong bóng thì gần 0
  while (out.y0 - 1 >= T && rowFrac(out.y0 - 1, out.x0, out.x1) >= TH) out.y0--;
  while (out.y1 + 1 <= B - 1 && rowFrac(out.y1, out.x0, out.x1) >= TH) out.y1++;
  while (out.x0 - 1 >= L && colFrac(out.x0 - 1, out.y0, out.y1) >= TH) out.x0--;
  while (out.x1 + 1 <= R - 1 && colFrac(out.x1, out.y0, out.y1) >= TH) out.x1++;
  // Thu lại các cạnh đang nằm trên khoảng đen hoàn toàn (khung Gemini vẽ quá tay)
  while (out.y1 - out.y0 > 8 && rowFrac(out.y1 - 1, out.x0, out.x1) === 0) out.y1--;
  while (out.y1 - out.y0 > 8 && rowFrac(out.y0, out.x0, out.x1) === 0) out.y0++;
  while (out.x1 - out.x0 > 8 && colFrac(out.x1 - 1, out.y0, out.y1) === 0) out.x1--;
  while (out.x1 - out.x0 > 8 && colFrac(out.x0, out.y0, out.y1) === 0) out.x0++;
  return out;
}

// Từ khung Gemini (đã đổi ra toạ độ pixel) -> khung đã canh + màu nền
function analyzeBox(data, W, H, box) {
  const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(W, Math.ceil(box.x1)), y1 = Math.min(H, Math.ceil(box.y1));
  const bg = dominantColor(data, W, x0, y0, x1, y1);
  // Nền tối thường là khoảng đen giữa các khung truyện: không mở rộng để tránh nuốt tranh
  const snapped = bg.dark ? { x0, y0, x1, y1 } : snapToBubble(data, W, H, { x0, y0, x1, y1 }, bg);
  return { box: snapped, bg };
}

// ---------- Ảnh rất cao (> 7000px): cắt thành đoạn 4000px, chồng 300px ----------
// Bật/tắt việc cắt ảnh cao (ảnh > TALL_LIMIT được cắt thành đoạn)
const SPLIT_TALL_IMAGES = true;
const TALL_LIMIT = 7000;
const TILE_H = 4000;
const TILE_OVERLAP = 300;

// Tìm dòng cắt an toàn gần vị trí mong muốn: dòng gần như đồng màu (khoảng trống giữa các khung),
// không có nét chữ hay viền bong bóng đi ngang
function findCutRow(img, W, lo, hi) {
  const lum = (x, y) => {
    const o = (y * W + x) * 4;
    return 0.299 * img[o] + 0.587 * img[o + 1] + 0.114 * img[o + 2];
  };
  const score = (y) => {
    let sc = 0;
    for (let x = 0; x < W; x += 2) {
      sc += Math.abs(lum(x, y) - lum(x, y - 1));
      if (x >= 2 && Math.abs(lum(x, y) - lum(x - 2, y)) > 40) sc += 50;
    }
    return sc;
  };
  let best = hi;
  let bestScore = Infinity;
  for (let y = hi; y >= lo; y--) {
    const sc = score(y);
    if (sc < bestScore) {
      bestScore = sc;
      best = y;
    }
    if (sc === 0) break;
  }
  return best;
}

async function imageTiles(blob, mime) {
  const bitmap = await createImageBitmap(blob);
  const W = bitmap.width;
  const H = bitmap.height;
  const fullCanvas = new OffscreenCanvas(W, H);
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
  fullCtx.drawImage(bitmap, 0, 0);

  if (!SPLIT_TALL_IMAGES || H <= TALL_LIMIT) {
    bitmap.close();
    return { W, H, fullCtx, tiles: [{ blob, mime, y0: 0, h: H }] };
  }

  const img = fullCtx.getImageData(0, 0, W, H).data;
  const tiles = [];
  let y0 = 0;
  while (true) {
    const end = y0 + TILE_H >= H ? H : findCutRow(img, W, y0 + TILE_H - 600, y0 + TILE_H);
    const h = end - y0;
    const c = new OffscreenCanvas(W, h);
    c.getContext('2d').drawImage(bitmap, 0, y0, W, h, 0, 0, W, h);
    const tb = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    tiles.push({ blob: tb, mime: 'image/jpeg', y0, h });
    if (end >= H) break;
    y0 = end;
  }
  bitmap.close();
  return { W, H, fullCtx, tiles };
}

// Đổi khung trong một đoạn về toạ độ ảnh gốc
function itemsFromTileBlocks(blocks, tile, W, fullCtx) {
  const H = fullCtx.canvas.height;
  const data = fullCtx.getImageData(0, 0, W, H).data;
  const { dx, dy } = boxDenominators(blocks);
  const tileBottom = tile.y0 + tile.h;
  const items = [];
  const toRect = (nb) => ({
    x0: Math.max(0, (nb[1] / dx) * W),
    x1: Math.min(W, (nb[3] / dx) * W),
    y0: Math.max(tile.y0, tile.y0 + (nb[0] / dy) * tile.h),
    y1: Math.min(tileBottom, tile.y0 + (nb[2] / dy) * tile.h),
  });
  for (const b of blocks) {
    if (!b || !b.translated) continue;
    const { textNb, bubbleNb } = blockBoxes(b);
    if (!textNb) {
      console.warn('[OCR] bỏ khối: thiếu/không đọc được text_box', b);
      continue;
    }
    const raw = toRect(textNb);
    if (raw.x1 - raw.x0 < 4 || raw.y1 - raw.y0 < 4) {
      console.warn('[OCR] bỏ khối: text_box nhỏ hơn 4px', { original: b.original, raw, W, H });
      continue;
    }
    // Khung không được vượt ra khỏi đoạn đang xử lý (tránh lấy nhầm chữ của đoạn kề bên)
    const it = buildItem(b, raw, bubbleNb ? toRect(bubbleNb) : null, data, W, H, { y0: tile.y0, y1: tileBottom });
    if (it) items.push(it);
  }
  return items;
}

// Bỏ khung trùng ở vùng chồng nhau giữa hai đoạn
function dedupeItems(items) {
  const out = [];
  for (const it of items) {
    const cx = (it.box.x0 + it.box.x1) / 2;
    const cy = (it.box.y0 + it.box.y1) / 2;
    const dup = out.some((o) =>
      o.original === it.original &&
      Math.abs((o.box.x0 + o.box.x1) / 2 - cx) < 40 &&
      Math.abs((o.box.y0 + o.box.y1) / 2 - cy) < 40
    );
    if (!dup) out.push(it);
  }
  return out;
}

// Gửi nhiều đoạn của cùng một ảnh trong một yêu cầu, mỗi đoạn có nhãn thứ tự
async function callGeminiPieces(apiKey, pieces, targetLang) {
  const target = TARGET_NAMES[targetLang] || targetLang;
  const prompt = `You are given several consecutive vertical pieces of ONE tall comic/manga page, labeled "Image 0", "Image 1", ... from top to bottom. The pieces are cut at blank gutters between panels, so no text block is split across two pieces.
For each piece, find every block of readable text in THAT piece. Merge lines that belong to the same sentence or bubble into one block.
For each block return:
- "original": the exact text as written, in its original language, with line breaks replaced by spaces.
- "translated": a natural translation into ${target}.
- "bubble_box": [ymin, xmin, ymax, xmax], integers normalized to 0-1000 relative to THAT piece's size. Its meaning depends on how the text is presented:
  * speech bubble (round, oval, cloud, spiky): the outer edge of the bubble outline, touching its leftmost, rightmost, topmost and bottommost points.
  * rectangular dialogue or caption box (square or rounded rectangle, narration box): the ENTIRE box including its border.
  * text with NO bubble or box (lettering placed directly on the artwork): only a tight box around the text characters, including their outline/stroke/glow, and nothing else.
  Never include the bubble tail/pointer, other bubbles, or surrounding artwork.
- "text_box": the tight bounding box [ymin, xmin, ymax, xmax] of only the printed text lines inside, same 0-1000 normalization.
- "shape": "ellipse" only if the bubble is round, oval, cloud-like or spiky; "rect" for rectangular/square boxes and for text with no bubble.
- "lines": the number of text lines of the ORIGINAL block as printed (count columns if the text is vertical).
- "vertical": true if the original text runs top-to-bottom in columns, otherwise false.
- "font_size": the em size of the original text (height of one character line) in the same 0-1000 units as the image height. For example, on an image 1000 px tall, text with 25 px characters is 25. Estimate from the glyph size, not the bubble.
Only translate dialogue, narration and caption text. SKIP all sound effects and onomatopoeia (stylized or hand-lettered words for noises, ambient sounds, heartbeats, whispering, footsteps, impacts, laughter or crying sounds, etc., e.g. "ドキドキ", "ざわざわ", "BAM", "thump", "bisbis"), as well as isolated interjections or mimetic words that only describe the scene rather than being spoken or narrated. Do not return a block for them at all. Never mix blocks between pieces.
Return ONLY JSON in this form: {"images":[{"index":0,"summary":"...","blocks":[{"original":"...","translated":"...","bubble_box":[0,0,0,0],"text_box":[0,0,0,0],"shape":"ellipse","lines":1,"font_size":30,"vertical":false}]}]}
Use the same index number as the "Image N" label. Return exactly one entry per label, in the same order, and never skip a label.
In "summary", write 3-8 words describing what THAT specific image shows (e.g. "woman at a desk, no text"), BEFORE listing its blocks. This keeps every block attached to the right image.
Many consecutive images may contain no text at all (just artwork or empty space): that is normal. Return an empty "blocks" array for them. NEVER move text from one image to another to fill a gap, and never shift blocks to the previous or next image. A block belongs only to the image where its text is actually printed, and its boxes are relative to that image.`;

  const parts = [{ text: prompt + countReminder(pieces.length) }];
  pieces.forEach((p, i) => {
    parts.push({ text: `Image ${i}:` });
    parts.push({ inline_data: { mime_type: p.mime, data: p.base64 } });
  });
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  const result = await geminiRotate(apiKey, body, parseJsonText);
  return mapImageResults(result, pieces.length);
}

// Một ảnh (có thể gồm nhiều đoạn) -> items để phủ lên trang
async function geminiImageItems(blob, mime, apiKey, targetLang) {
  const { W, H, fullCtx, tiles } = await imageTiles(blob, mime);
  let all = [];

  if (tiles.length === 1) {
    const base64 = bytesToBase64(new Uint8Array(await tiles[0].blob.arrayBuffer()));
    const blocks = await callGemini(apiKey, base64, tiles[0].mime, targetLang);
    all = itemsFromTileBlocks(blocks, tiles[0], W, fullCtx);
  } else {
    const pieces = [];
    for (const t of tiles) {
      pieces.push({ mime: t.mime, base64: bytesToBase64(new Uint8Array(await t.blob.arrayBuffer())) });
    }
    const perPiece = await callGeminiPieces(apiKey, pieces, targetLang);
    tiles.forEach((t, i) => {
      all = all.concat(itemsFromTileBlocks(perPiece[i] || [], t, W, fullCtx));
    });
  }

  const items = dedupeItems(all);
  avoidOverlap(items);
  return { items, width: W, height: H };
}

// Ảnh chuột phải: Gemini trả về khung, đổi sang toạ độ pixel rồi lấy màu nền
async function geminiImageBlocks(tabId, srcUrl, targetLang) {
  const key = await getGeminiKey();
  const blob = await loadImageBlob(tabId, srcUrl);
  const mime = (blob.type || 'image/png').split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
    throw new Error(`Gemini không hỗ trợ định dạng ${mime}`);
  }
  return geminiImageItems(blob, mime, key, targetLang);
}

// Vùng chọn: cắt ảnh chụp rồi gửi Gemini
async function geminiRegion({ dataUrl, rect, dpr }, targetLang) {
  const key = await getGeminiKey();
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.round(rect.w * dpr);
  const sh = Math.round(rect.h * dpr);
  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  const blocks = (await callGemini(key, base64, 'image/png', targetLang)).filter((b) => b && b.translated);
  if (!blocks.length) throw new Error('Gemini không tìm thấy chữ trong vùng chọn.');
  return {
    original: blocks.map((b) => b.original || '').join('\n'),
    translated: blocks.map((b) => b.translated).join('\n'),
  };
}



// ---------- Dịch một ảnh (chuột phải) ----------
async function runImageViewer(tabId, srcUrl, quiet = false) {
  try {
    if (!srcUrl) throw new Error('Không lấy được đường dẫn ảnh.');
    const { targetLang } = await getSettings();
    if (!quiet) notify(tabId, { type: 'SHOW_LOADING' });

    const { items, width, height } = await geminiImageBlocks(tabId, srcUrl, targetLang);
    if (!items.length) {
      await markState(tabId, 'noText', srcUrl); // side panel: khoá ảnh không có chữ
      throw new Error('Gemini không tìm thấy chữ trong ảnh.');
    }

    notify(tabId, { type: 'OVERLAY_IMAGE', srcUrl, width, height, items });
    await markDone(tabId, srcUrl); // side panel: hiện "✓ Đã dịch" và bỏ chọn ảnh này
    notify(tabId, { type: 'HIDE_PANEL' });
    return true;
  } catch (err) {
    console.error('[OCR]', srcUrl, err);
    notify(tabId, { type: 'SHOW_ERROR', error: err.message });
    return false;
  }
}

// ---------- Chọn vùng (Ctrl+C+C) ----------
async function runPipeline(tabId, prepare) {
  try {
    const { targetLang } = await getSettings();
    notify(tabId, { type: 'SHOW_LOADING' });
    const payload = await prepare();
    const { original, translated } = await geminiRegion(payload, targetLang);
    notify(tabId, { type: 'SHOW_RESULT', original, translated });
  } catch (err) {
    console.error('[OCR]', err);
    notify(tabId, { type: 'SHOW_ERROR', error: err.message });
  }
}

// ---------- Dịch tất cả ảnh trên trang ----------
async function translateAll(tabId, urls) {
  const list = [...new Set(urls)];
  if (!list.length) {
    notify(tabId, { type: 'SHOW_ERROR', error: 'Không tìm thấy ảnh đủ lớn trên trang.' });
    return;
  }
  await setJob(tabId, 'running');
  try {
    await translateAllGemini(tabId, list);
  } finally {
    await setJob(tabId, 'idle');
  }
}

// ---------- Phím tắt và chọn vùng ----------
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start-ocr') await startSelectionOnActiveTab();
});

async function startSelectionOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) notify(tab.id, { type: 'START_SELECTION' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TRANSLATE_ONE' && sender.tab) {
    // Nút "Dịch ảnh" trên từng ảnh: dịch đúng ảnh đó, báo kết quả về để nút đổi trạng thái
    runImageViewer(sender.tab.id, msg.srcUrl, true).then(
      (ok) => sendResponse({ ok }),
      () => sendResponse({ ok: false })
    );
    return true;
  }
  if (msg.type === 'CAPTURE' && sender.tab) {
    runPipeline(sender.tab.id, async () => {
      const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      return { type: 'OCR', dataUrl, rect: msg.rect, dpr: msg.dpr };
    });
  }
  if (msg.type === 'TRANSLATE_ALL' && sender.tab) {
    translateAll(sender.tab.id, msg.urls || []);
  }
  return false;
});




function notify(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}


// ---------- Trạng thái theo tab cho side panel: đã dịch, không có chữ, đang chạy ----------
async function markState(tabId, key, url) {
  try {
    const store = await chrome.storage.session.get(key);
    const map = store[key] || {};
    const set = new Set(map[tabId] || []);
    set.add(url);
    map[tabId] = [...set];
    await chrome.storage.session.set({ [key]: map });
  } catch (err) {
    console.warn(`[${key}] không lưu được`, err.message);
  }
}

async function markDone(tabId, url) {
  await markState(tabId, 'done', url);
}

async function setJob(tabId, status) {
  await chrome.storage.session.set({ job: { tabId, status } }).catch(() => {});
}

async function clearTabState(tabId) {
  const store = await chrome.storage.session.get(['done', 'noText']);
  for (const key of ['done', 'noText']) {
    const map = store[key] || {};
    if (map[tabId]) {
      delete map[tabId];
      await chrome.storage.session.set({ [key]: map });
    }
  }
}

// Trang tải lại hoặc tab đóng thì xoá trạng thái của tab đó
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading') await clearTabState(tabId);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearTabState(tabId);
});
