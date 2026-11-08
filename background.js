importScripts('account.js');

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
    // Để trang xử lý như bấm icon trên ảnh (icon xoay ngay trên ảnh). Trang không nhận (không có thẻ <img>,
    // chưa nạp content script...) thì dùng cách cũ: dịch và hiện bảng ở góc dưới phải
    chrome.tabs.sendMessage(tab.id, { type: 'MENU_TRANSLATE', srcUrl: info.srcUrl })
      .then((r) => { if (!r?.handled) runImageViewer(tab.id, info.srcUrl); })
      .catch(() => runImageViewer(tab.id, info.srcUrl));
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

// Gemini key lấy từ tài khoản (server cấp). Account.require() đã làm mới thông tin trước khi dịch.
async function getGeminiKey() {
  const key = await Account.geminiKey();
  if (!key) throw new Error('Chưa có key Gemini. Hãy đăng nhập trong side panel.');
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
    if (!Array.isArray(bx)) continue;
    // Model hay trả thêm phần tử không phải số (ví dụ "rect" sau toạ độ): chỉ giữ 4 số toạ độ
    const nums = bx.filter((v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))));
    if (nums.length !== 4) continue;
    const [a, b2, c, d] = nums.map((v) => Number(v));
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
  let ink = inkBounds(data, W, raw, bg);
  // Vùng text_box không có nét chữ nhưng bong bóng thì có: Gemini đặt khung chữ lệch, dùng cả bong bóng
  if (!ink && bubble) {
    const bb = { x0: Math.max(0, Math.floor(bubble.x0)), y0: Math.max(0, Math.floor(bubble.y0)), x1: Math.min(W, Math.ceil(bubble.x1)), y1: Math.min(H, Math.ceil(bubble.y1)) };
    const ink2 = inkBounds(data, W, bb, dominantColor(data, W, bb.x0, bb.y0, bb.x1, bb.y1));
    if (ink2) {
      console.warn('[OCR] text_box không có nét chữ, dùng bong bóng thay thế', { original: b.original, raw, bubble: bb });
      raw = bb;
      bg = dominantColor(data, W, bb.x0, bb.y0, bb.x1, bb.y1);
      box = { x0: bb.x0, x1: bb.x1, y0: Math.max(y0lim, bb.y0), y1: Math.min(y1lim, bb.y1) };
      ink = ink2;
    }
  }
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
  const ellipse = fromBubble && shapeOf(b) === 'ellipse';
  return {
    box, conf: 100, original: b.original || '', translated: b.translated, bg, raw,
    fromBubble, shape: ellipse ? 'ellipse' : 'rect',
    linePx: linePitch(b, ink || box),
    // font_size của Gemini tính theo chiều cao của đoạn ảnh đang gửi (khi cắt ảnh dài là đoạn, không phải cả ảnh)
    fontPx: fontPxFrom(b, clipY ? clipY.y1 - clipY.y0 : H),
  };
}

// Hình dạng khung: ưu tiên trường shape. Nếu trường đó thiếu hoặc không hợp lệ thì lấy phần tử
// 'ellipse'/'rect' mà model lỡ đặt trong mảng toạ độ. Không có thì trả về '' (xử lý như bình thường).
function shapeOf(b) {
  const s = String(b.shape || '').trim().toLowerCase();
  if (s === 'ellipse' || s === 'rect') return s;
  for (const arr of [b.bubble_box, b.text_box, b.box]) {
    if (!Array.isArray(arr)) continue;
    const tag = arr.find((v) => typeof v === 'string' && /^\s*(ellipse|rect)\s*$/i.test(v));
    if (tag) return tag.trim().toLowerCase();
  }
  return '';
}

// Đọc khung chữ và khung bong bóng của một khối (chuẩn hoá 0-1000)
// Danh sách các khung [ymin, xmin, ymax, xmax] trong một trường box (bỏ phần tử không phải số)
function rectsOf(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const boxes = Array.isArray(raw[0]) ? raw : [raw];
  const out = [];
  for (const bx of boxes) {
    if (!Array.isArray(bx)) continue;
    const nums = bx.filter((v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))));
    if (nums.length !== 4) continue;
    out.push(nums.map(Number));
  }
  return out;
}

// Chỉ lấy khung đầu tiên của mỗi trường (bubble_box, text_box). Khi model trả nhiều khung trong một khối
// thì bỏ qua các khung sau, không gộp.
function blockBoxes(b) {
  const bubbleNb = rectsOf(b.bubble_box)[0] || rectsOf(b.box)[0] || null;
  const textNb = rectsOf(b.text_box)[0] || bubbleNb;
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
// Dữ liệu block gốc Gemini trả về cho từng ảnh (url -> blocks), dùng để log khi kết thúc
let geminiReport = new Map();

async function translateAllGemini(tabId, urls, stats = { drawn: 0 }) {
  geminiReport = new Map();
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
  const progress = () => {
    stats.drawn = ok; // translateAll dùng số này để hoàn lượt cho ảnh không dịch được
    notify(tabId, { type: 'SHOW_INFO', text: `Đang dịch: ${ok}/${list.length} ảnh...` });
  };
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
    geminiReport.set(img.srcUrl, blocks);
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

  // Ảnh dài: gộp các đoạn vào các lô (xem geminiTallBatch). Mỗi ảnh được vẽ ngay khi xong, không đợi cả lô.
  const tallImgs = loaded.filter((x) => x.tall);
  if (tallImgs.length) {
    await geminiTallBatch(tallImgs, apiKey, targetLang, async (r) => {
      const img = r.img;
      if (r.error) {
        tallErrors.push(img.srcUrl);
        console.error('[OCR] ảnh rất cao lỗi', img.srcUrl, r.error);
        notify(tabId, { type: 'SHOW_ERROR', error: r.error.message });
      } else if (r.items.length) {
        notify(tabId, { type: 'OVERLAY_IMAGE', srcUrl: img.srcUrl, width: r.width, height: r.height, items: r.items });
        ok++;
        progress();
        drawn.add(img.srcUrl);
        await markDone(tabId, img.srcUrl);
      } else {
        tallEmpty.push(img.srcUrl);
      }
    });
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
  // Dữ liệu block Gemini theo từng link ảnh (ảnh cao: _piece là nhãn đoạn, toạ độ theo đoạn đó)
  console.groupCollapsed(`[OCR] DỮ LIỆU GEMINI theo link ảnh (${geminiReport.size} ảnh)`);
  for (const [url, blocks] of geminiReport) {
    console.groupCollapsed(`${url} — ${blocks.length} khối`);
    console.log(url);
    console.log(blocks.map((b) => ({
      original: b.original,
      translated: b.translated,
      bubble_box: b.bubble_box,
      text_box: b.text_box,
      shape: b.shape,
      font_size: b.font_size,
      lines: b.lines,
      vertical: b.vertical,
      _piece: b._piece,
    })));
    console.groupEnd();
  }
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

// ---------- Ảnh cao (> 6000px): chia đoạn đều nhau, mỗi đoạn không quá 6000px ----------
// Bật/tắt việc cắt ảnh cao (ảnh > TALL_LIMIT được cắt thành đoạn)
const SPLIT_TALL_IMAGES = true;
const TALL_LIMIT = 4000; // ảnh cao hơn mức này mới bị cắt
const TILE_MAX = 4000;   // mỗi đoạn tối đa 4000px; cứ thêm mỗi 4000px thì thêm một đoạn
const CUT_SEARCH = 600;  // tìm dòng cắt trong khoảng +-600px quanh điểm giữa

// Tìm dòng cắt an toàn trong [lo, hi], ưu tiên gần `target`: khoảng trống đồng màu giữa các khung,
// không có nét chữ hay viền bong bóng đi ngang. Chấm điểm cả một dải 7 dòng quanh dòng cắt
// để tránh cắt sát mép chữ hoặc mép bong bóng.
function findCutRow(img, W, lo, hi, target) {
  const H = img.length / (W * 4);
  const lum = (x, y) => {
    const o = (y * W + x) * 4;
    return 0.299 * img[o] + 0.587 * img[o + 1] + 0.114 * img[o + 2];
  };
  const rowScore = (y) => {
    let sc = 0;
    for (let x = 0; x < W; x += 2) {
      sc += Math.abs(lum(x, y) - lum(x, y - 1));
      if (x >= 2 && Math.abs(lum(x, y) - lum(x - 2, y)) > 40) sc += 50;
    }
    return sc;
  };
  const cache = new Map();
  const rs = (y) => {
    if (y < 1 || y >= H) return 0;
    if (!cache.has(y)) cache.set(y, rowScore(y));
    return cache.get(y);
  };
  let best = Math.min(hi, Math.max(lo, target));
  let bestScore = Infinity;
  let bestDist = Infinity;
  for (let y = lo; y <= hi; y++) {
    let sc = 0;
    for (let k = -3; k <= 3; k++) sc += rs(y + k);
    const dist = Math.abs(y - target);
    if (sc < bestScore || (sc === bestScore && dist < bestDist)) {
      bestScore = sc;
      bestDist = dist;
      best = y;
    }
  }
  return best;
}

// Cắt một ảnh thành các đoạn JPEG. Chỉ giữ các đoạn đã nén; bản pixel của cả ảnh được giải phóng ngay sau khi cắt.
async function cutToTiles(blob, mime) {
  const bitmap = await createImageBitmap(blob);
  const W = bitmap.width;
  const H = bitmap.height;
  if (!SPLIT_TALL_IMAGES || H <= TALL_LIMIT) {
    bitmap.close();
    return { W, H, tiles: [{ blob, mime, y0: 0, h: H }] };
  }
  const full = new OffscreenCanvas(W, H);
  full.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = full.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  // Số đoạn: cứ mỗi TILE_MAX px thì thêm một đoạn (mỗi đoạn luôn <= TILE_MAX)
  const n = Math.floor(H / TILE_MAX) + 1;
  const cuts = [0];
  for (let i = 1; i < n; i++) {
    const prev = cuts[cuts.length - 1];
    const target = Math.round((H * i) / n);
    // Đoạn hiện tại <= TILE_MAX, và phần còn lại vẫn chia được cho (n - i) đoạn <= TILE_MAX
    const lo = Math.max(prev + 1, target - CUT_SEARCH, H - (n - i) * TILE_MAX);
    const hi = Math.min(H - 1, target + CUT_SEARCH, prev + TILE_MAX);
    cuts.push(findCutRow(img, W, Math.min(lo, hi), hi, target));
  }
  cuts.push(H);
  const tiles = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const y0 = cuts[i];
    const h = cuts[i + 1] - y0;
    const c = new OffscreenCanvas(W, h);
    c.getContext('2d').drawImage(full, 0, y0, W, h, 0, 0, W, h);
    const tb = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    tiles.push({ blob: tb, mime: 'image/jpeg', y0, h });
  }
  return { W, H, tiles };
}

// Đổi khung của một đoạn về toạ độ ảnh gốc. Chỉ đọc pixel của đúng đoạn đó, không cần cả ảnh.
async function itemsFromTileLocal(blocks, tile, W) {
  if (!blocks.length) return [];
  const bmp = await createImageBitmap(tile.blob);
  const H = tile.h;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const data = ctx.getImageData(0, 0, W, H).data;
  const toRect = (nb) => ({ x0: (nb[1] / 1000) * W, y0: (nb[0] / 1000) * H, x1: (nb[3] / 1000) * W, y1: (nb[2] / 1000) * H });
  const items = [];
  for (const b of blocks) {
    if (!b || !b.translated) continue;
    const { textNb, bubbleNb } = blockBoxes(b);
    if (!textNb) {
      console.warn('[OCR] bỏ khối: thiếu/không đọc được text_box', b);
      continue;
    }
    const raw = toRect(textNb);
    if (raw.x1 - raw.x0 < 4 || raw.y1 - raw.y0 < 4) {
      console.warn('[OCR] bỏ khối: khung chữ quá nhỏ', { original: b.original, raw });
      continue;
    }
    const it = buildItem(b, raw, bubbleNb ? toRect(bubbleNb) : null, data, W, H, { y0: 0, y1: H }, false);
    if (!it) {
      console.warn('[OCR] bỏ khối: buildItem không tạo khung', { original: b.original, raw, bubble: bubbleNb });
      continue;
    }
    items.push(it);
  }
  console.log(`[TILE] đoạn ${tile.y0}..${tile.y0 + H}: ${blocks.length} khối -> vẽ ${items.length}`);
  // Đổi từ toạ độ trong đoạn sang toạ độ ảnh gốc
  for (const it of items) {
    it.box.y0 += tile.y0;
    it.box.y1 += tile.y0;
    it.raw.y0 += tile.y0;
    it.raw.y1 += tile.y0;
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
// Gửi nhiều đoạn (của một hoặc nhiều ảnh) trong một yêu cầu. Nhãn mỗi đoạn: "k_i":
// k là số thứ tự ảnh trong lô, i là thứ tự đoạn trong ảnh đó (từ trên xuống). Trả về Map nhãn -> blocks;
// nhãn nào model không trả về thì không có trong Map (để gửi lại riêng).
async function callGeminiPieces(apiKey, pieces, targetLang) {
  const target = TARGET_NAMES[targetLang] || targetLang;
  const labels = pieces.map((p) => p.label);
  const prompt = `You are given several vertical pieces of one or more tall comic/manga pages. Each piece is labeled "Image k_i": k identifies the page, i is the order of the piece within that page, from top to bottom. The pieces of the same page are consecutive in this request. The pieces are cut at blank gutters between panels, so no text block is split across two pieces. Pieces of different pages are unrelated: NEVER move a block from one page to another.
For each piece, find every block of readable text in THAT piece only. Merge lines that belong to the same sentence or bubble into one block.
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
- "font_size": the em size of the original text (height of one character line) in the same 0-1000 units as the piece height. For example, on a piece 1000 px tall, text with 25 px characters is 25. Estimate from the glyph size, not the bubble.
Only translate dialogue, narration and caption text. SKIP all sound effects and onomatopoeia (stylized or hand-lettered words for noises, ambient sounds, heartbeats, whispering, footsteps, impacts, laughter or crying sounds, etc., e.g. "ドキドキ", "ざわざわ", "BAM", "thump", "bisbis"), as well as isolated interjections or mimetic words that only describe the scene rather than being spoken or narrated. Do not return a block for them at all.
Return ONLY JSON in this form: {"images":[{"index":"0_0","summary":"...","blocks":[{"original":"...","translated":"...","bubble_box":[0,0,0,0],"text_box":[0,0,0,0],"shape":"ellipse","lines":1,"font_size":30,"vertical":false}]}]}
Use the same index string as the piece label. Return exactly one entry per label, in the same order, and never skip a label.
In "summary", write 3-8 words describing what THAT specific piece shows (e.g. "woman at a desk, no text"), BEFORE listing its blocks.
Many pieces may contain no text at all (just artwork or empty space): that is normal. Return an empty "blocks" array for them. NEVER move text from one piece to another to fill a gap. A block belongs only to the piece where its text is actually printed, and its boxes are relative to that piece.`;

  const reminder = `\n\nThis request contains exactly ${pieces.length} pieces, with these labels: ${labels.map((l) => '"' + l + '"').join(', ')}. The "images" array MUST have exactly ${pieces.length} entries, one for EVERY label listed. A piece with no text STILL gets its own entry with an empty array. Never omit an entry.`;
  const parts = [{ text: prompt + reminder }];
  for (const p of pieces) {
    parts.push({ text: `Image ${p.label}:` });
    parts.push({ inline_data: { mime_type: p.mime, data: p.base64 } });
  }
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  });
  const result = await geminiRotate(apiKey, body, parseJsonText);
  const list = Array.isArray(result.images) ? result.images : [];
  const byLabel = new Map();
  for (const e of list) {
    if (e && e.index !== undefined) byLabel.set(String(e.index).trim(), e.blocks || []);
  }
  const out = new Map();
  for (const l of labels) if (byLabel.has(l)) out.set(l, byLabel.get(l));
  return out;
}

// Xử lý nhiều ảnh dài: cắt từng ảnh rồi xếp các đoạn vào hàng chờ. Đủ TALL_BATCH_PIECES đoạn thì gửi một yêu cầu,
// phần dư giữ lại để ghép với ảnh kế tiếp. Khi tất cả đoạn của một ảnh đã xong thì gọi onDone(kết quả của ảnh đó)
// ngay, không đợi các ảnh khác. Trả về [{ img, items, width, height, error }] theo đúng thứ tự imgs.
const TALL_BATCH_PIECES = 8; // mỗi request gom tối đa 8 đoạn ảnh dài
async function geminiTallBatch(imgs, apiKey, targetLang, onDone = null) {
  // gi = số thứ tự ảnh trong cả lượt dịch; nhãn đoạn là gi_i nên cùng một đoạn luôn có cùng nhãn ở mọi lô
  const recs = imgs.map((img, gi) => ({ img, gi, W: 0, H: 0, tiles: [], all: [], raw: [], error: null, pending: 0, result: null }));
  const queue = []; // [{ rec, i }] các đoạn đang chờ gửi

  // Ảnh đã xong hết đoạn: gom kết quả, gọi onDone để vẽ ngay
  const finishRec = async (rec) => {
    if (rec.result) return;
    if (rec.error) {
      rec.result = { img: rec.img, items: [], width: rec.W, height: rec.H, error: rec.error };
    } else {
      const items = dedupeItems(rec.all);
      avoidOverlap(items);
      rec.result = { img: rec.img, items, width: rec.W, height: rec.H, error: null };
    }
    geminiReport.set(rec.img.srcUrl, rec.raw);
    rec.all = [];
    if (onDone) await onDone(rec.result);
  };

  // Gửi một lô đoạn trong một yêu cầu; đoạn nào model không trả về thì gửi lại riêng
  const flush = async (batch) => {
    const live = batch.filter((p) => !p.rec.error);
    if (live.length) {
      try {
        const pieces = [];
        for (const p of live) {
          const tile = p.rec.tiles[p.i];
          pieces.push({
            label: `${p.rec.gi}_${p.i}`,
            rec: p.rec,
            tile,
            mime: tile.mime,
            base64: bytesToBase64(new Uint8Array(await tile.blob.arrayBuffer())),
          });
        }
        const byLabel = await callGeminiPieces(apiKey, pieces, targetLang);
        const asked = pieces.map((pc) => pc.label);
        const got = [...byLabel.keys()];
        console.log(`[TILE] lô: gửi ${asked.join(' ')} | nhận ${got.join(' ') || '(không có)'}`);
        for (const pc of pieces) {
          let blocks = byLabel.get(pc.label);
          if (!blocks) {
            console.warn(`[TILE] đoạn ${pc.label} thiếu trong kết quả gộp, gửi riêng`);
            blocks = await callGemini(apiKey, pc.base64, pc.mime, targetLang);
          }
          pc.rec.raw.push(...blocks.map((b) => ({ ...b, _piece: pc.label })));
          pc.rec.all = pc.rec.all.concat(await itemsFromTileLocal(blocks, pc.tile, pc.rec.W));
        }
      } catch (err) {
        console.error('[OCR] lô ảnh dài lỗi', err);
        for (const p of live) p.rec.error = err;
      }
    }
    // Giải phóng dữ liệu đoạn đã xử lý, rồi đếm và vẽ các ảnh đã xong
    for (const p of batch) p.rec.tiles[p.i].blob = null;
    for (const p of batch) {
      p.rec.pending--;
      if (p.rec.pending === 0) await finishRec(p.rec);
    }
  };

  for (const rec of recs) {
    try {
      const t = await cutToTiles(rec.img.blob, rec.img.mime);
      rec.W = t.W;
      rec.H = t.H;
      rec.tiles = t.tiles;
      rec.pending = rec.tiles.length;
    } catch (err) {
      rec.error = err;
      await finishRec(rec);
      continue;
    }
    const n = rec.tiles.length;
    const piecesOf = (r) => r.tiles.map((_, i) => ({ rec: r, i }));
    if (n > TALL_BATCH_PIECES) {
      // Ảnh tự dài hơn một request: gửi hết hàng chờ trước, rồi chia ảnh này thành các request đầy đủ
      if (queue.length) await flush(queue.splice(0));
      const all = piecesOf(rec);
      for (let k = 0; k < all.length; k += TALL_BATCH_PIECES) await flush(all.slice(k, k + TALL_BATCH_PIECES));
      continue;
    }
    // Ảnh vừa một request: nếu thêm nó vào sẽ vượt giới hạn thì gửi hàng chờ trước, để không tách ảnh này
    if (queue.length && queue.length + n > TALL_BATCH_PIECES) await flush(queue.splice(0));
    queue.push(...piecesOf(rec));
    if (queue.length === TALL_BATCH_PIECES) await flush(queue.splice(0));
  }
  if (queue.length) await flush(queue.splice(0));

  for (const rec of recs) await finishRec(rec); // phòng trường hợp còn sót
  return recs.map((rec) => rec.result);
}

// Một ảnh (dùng cho chuột phải) -> items để phủ lên trang
async function geminiImageItems(blob, mime, apiKey, targetLang) {
  const [r] = await geminiTallBatch([{ blob, mime }], apiKey, targetLang);
  if (r.error) throw r.error;
  return { items: r.items, width: r.width, height: r.height };
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

// ---------- Dịch một ảnh (chuột phải) ----------
async function runImageViewer(tabId, srcUrl, quiet = false) {
  let ref = null; // mã lần trừ lượt, dùng để hoàn lượt khi dịch không thành
  try {
    if (!srcUrl) throw new Error('Không lấy được đường dẫn ảnh.');
    const { targetLang } = await getSettings();
    if (!quiet) notify(tabId, { type: 'SHOW_LOADING' });
    ref = await Account.charge(1); // phải đăng nhập, có key và đủ lượt thì mới dịch

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
    await Account.refund(ref, 1); // lỗi hoặc không có chữ: trả lại lượt
    notify(tabId, { type: 'SHOW_ERROR', error: err.message });
    return false;
  }
}

// ---------- Dịch tất cả ảnh trên trang ----------
async function translateAll(tabId, urls) {
  const list = [...new Set(urls)];
  if (!list.length) {
    notify(tabId, { type: 'SHOW_ERROR', error: 'Không tìm thấy ảnh đủ lớn trên trang.' });
    return;
  }
  // Trừ lượt theo số ảnh được chọn; ảnh không dịch được (lỗi, không có chữ) sẽ được hoàn lại ở cuối.
  // Đặt trạng thái "đang chạy" trước để side panel luôn nhận được lúc kết thúc, kể cả khi trừ lượt thất bại.
  await setJob(tabId, 'running');
  // Server chỉ nhận tối đa 50 lượt trong một lần trừ, nên chia thành nhiều lần trừ
  const CHARGE_MAX = 50;
  let refs = []; // [{ ref, count }] các lần trừ đã thành công, để hoàn lại khi cần
  const stats = { drawn: 0 };
  try {
    try {
      for (let i = 0; i < list.length; i += CHARGE_MAX) {
        const count = Math.min(CHARGE_MAX, list.length - i);
        const ref = await Account.charge(count);
        refs.push({ ref, count });
      }
    } catch (err) {
      // Trừ thiếu (hết lượt, lỗi mạng...): hoàn những lần đã trừ rồi dừng
      for (const r of refs) await Account.refund(r.ref, r.count);
      refs = [];
      notify(tabId, { type: 'SHOW_ERROR', error: err.message });
      return;
    }
    await translateAllGemini(tabId, list, stats);
  } finally {
    // Hoàn lượt cho ảnh không dịch được, theo thứ tự các lần trừ
    let toRefund = list.length - stats.drawn;
    for (const r of refs) {
      const n = Math.min(r.count, toRefund);
      if (n > 0) await Account.refund(r.ref, n);
      toRefund -= n;
    }
    await setJob(tabId, 'idle');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_NOTEXT' && sender.tab) {
    // Content script khi tải trang: trả về các ảnh không có chữ của tab đó
    chrome.storage.session.get('noText').then(
      (store) => sendResponse({ urls: ((store.noText || {})[sender.tab.id]) || [] }),
      () => sendResponse({ urls: [] })
    );
    return true;
  }
  if (msg.type === 'TRANSLATE_ONE' && sender.tab) {
    // Nút "Dịch ảnh" trên từng ảnh: dịch đúng ảnh đó, báo kết quả về để nút đổi trạng thái
    runImageViewer(sender.tab.id, msg.srcUrl, true).then(
      (ok) => sendResponse({ ok }),
      () => sendResponse({ ok: false })
    );
    return true;
  }
  if (msg.type === 'REBIND_URL' && sender.tab) {
    // Trang đổi link ảnh đã dịch: đổi khoá URL ở trạng thái "Đã dịch" để side panel khớp ảnh mới
    renameDone(sender.tab.id, msg.oldUrl, msg.newUrl);
    return false;
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
    // Báo về trang để nút dịch trên ảnh đó được ẩn ngay
    if (key === 'noText') notify(tabId, { type: 'NOTEXT', srcUrl: url });
  } catch (err) {
    console.warn(`[${key}] không lưu được`, err.message);
  }
}

async function markDone(tabId, url) {
  await markState(tabId, 'done', url);
}

async function renameDone(tabId, oldUrl, newUrl) {
  try {
    const store = await chrome.storage.session.get('done');
    const map = store.done || {};
    const list = (map[tabId] || []).filter((u) => u !== oldUrl);
    if (!list.includes(newUrl)) list.push(newUrl);
    map[tabId] = list;
    await chrome.storage.session.set({ done: map });
  } catch (err) {
    console.warn('[done] không đổi được URL', err.message);
  }
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
