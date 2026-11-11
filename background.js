importScripts('account.js');

// Open settings in a Side Panel when the toolbar icon is clicked, instead of the popup
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.warn('[sidePanel]', err.message));

const DEFAULTS = { targetLang: 'vi' };

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

// ---------- Right-click menu ----------
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
    // Let the page handle it like clicking the icon on an image (the icon that rotates on the image). If the page does not respond (no <img> tag,
    // content script not loaded...), fall back to the old method: translate and show a panel in the bottom-right corner
    chrome.tabs.sendMessage(tab.id, { type: 'MENU_TRANSLATE', srcUrl: info.srcUrl })
      .then((r) => { if (!r?.handled) runImageViewer(tab.id, info.srcUrl); })
      .catch(() => runImageViewer(tab.id, info.srcUrl));
  }
});


// ---------- Gemini: read and translate with a vision model ----------
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

// Gemini key comes from the account (issued by the server). Account.require() already refreshed the info before translating.
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

// Model list, tried in order. The model that worked last time is remembered and called first next time.
const GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.6-flash',
];
const CYCLE_WAIT_MS = 10000;
const MAX_CYCLES = 2;

async function getSavedModelIndex() {
  const { geminiModelIndex } = await chrome.storage.local.get({ geminiModelIndex: 0 });
  return geminiModelIndex < GEMINI_MODELS.length ? geminiModelIndex : 0;
}

// Call one model once; errors are thrown so the caller can switch to another model
// Each request has a 40-second limit; on timeout, give up and switch to the next model (geminiRotate)
const GEMINI_TIMEOUT_MS = 40000;
async function requestGemini(apiKey, model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`${model}: quá ${GEMINI_TIMEOUT_MS / 1000} giây, chuyển mô hình khác`);
    }
    throw err;
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 150);
    throw new Error(`${model}: HTTP ${res.status} ${detail}`);
  }
  const data = await res.json();
  return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

// Try the models in order; parse(text) reads the result, and errors here also switch to the next model
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

// Call for one image
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

// Gemini may return a box as [ymin, xmin, ymax, xmax] or a list of several boxes;
// with several boxes, merge them into one box that encloses all of them
function normalizeBox(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const boxes = Array.isArray(raw[0]) ? raw : [raw];
  let ymin = Infinity, xmin = Infinity, ymax = -Infinity, xmax = -Infinity;
  for (const bx of boxes) {
    if (!Array.isArray(bx)) continue;
    // The model often adds non-numeric items (e.g. "rect" after the coordinates): keep only the 4 coordinate numbers
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

// Normalization scale: always use 1000 for both axes
function boxDenominators(blocks) {
  return { dx: 1000, dy: 1000 };
}

// Convert the box list from Gemini into items to overlay on the page
// Match Gemini results to each image in the batch. Use the index first; if the index is missing or wrong, fall back to order.
function mapImageResults(result, count) {
  const list = Array.isArray(result.images) ? result.images : [];
  const byIndex = new Map();
  for (const e of list) {
    const idx = Number(e && e.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < count) byIndex.set(idx, e.blocks || []);
  }
  // Don't guess by position: an image whose index Gemini did not return correctly gets null so it is re-sent alone
  const noIndexes = list.length === count && list.every((e) => e && e.index === undefined);
  return Array.from({ length: count }, (_, i) => {
    if (byIndex.has(i)) return byIndex.get(i);
    if (noIndexes) return list[i].blocks || [];
    return null;
  });
}

// Size of one line of the original text (source-image px) = edge along the line direction / number of lines.
// Horizontal text: divide box height by the number of lines; vertical text: divide box width by the number of columns.
function linePitch(b, raw) {
  const n = Math.round(Number(b.lines));
  if (!Number.isFinite(n) || n < 1 || n > 30) return null;
  const span = b.vertical ? raw.x1 - raw.x0 : raw.y1 - raw.y0;
  const pitch = span / n;
  return pitch >= 6 ? Math.round(pitch) : null;
}

// Convert Gemini's font_size (0-1000 scale of image height) to px. Return null if the value is unreasonable.
function fontPxFrom(b, H) {
  const f = Number(b.font_size);
  if (!Number.isFinite(f) || f < 5 || f > 400) return null;
  return (f / 1000) * H;
}

// Tight box around the real text strokes: enclose the pixels inside the Gemini box that differ clearly from the background color.
// The Gemini box is usually wider than the text, so measuring directly on the image gives a more accurate original text size.
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

// Two expanded boxes may overlap (two speech bubbles touching): cut at the midpoint
// of the gap between the two original text boxes, never cutting into the original text of the box itself
function avoidOverlap(items) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (!a.raw || !b.raw) continue;
      if (a.fromBubble && b.fromBubble) continue; // bubble box is accurate, no cut needed
      const A = a.box, B = b.box;
      if (A.x1 <= B.x0 || B.x1 <= A.x0 || A.y1 <= B.y0 || B.y1 <= A.y0) continue;
      const ra = a.raw, rb = b.raw;
      const gapY = Math.max(rb.y0 - ra.y1, ra.y0 - rb.y1);
      const gapX = Math.max(rb.x0 - ra.x1, ra.x0 - rb.x1);
      if (gapY <= 0 && gapX <= 0) continue; // original text already overlaps: not processed
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

// When two blocks overlap (bubble with text, bubble with bubble, sub with sub): shrink both toward the center by SHRINK_SCALE.
// Do not move the blocks, do not cut bubbles.
// Shrink ratio when two blocks overlap (default 90% of original size; adjust here for testing)
const SHRINK_SCALE = 0.9;
// Small overlap (below OVERLAP_TOL of the smaller box's area) is accepted, no shrinking
const OVERLAP_TOL = 0.15;
// Overlap above this level (bubble-bubble or sub-sub) merges the two blocks into one
const MERGE_TOL = 0.7;
function mergeItems(a, c) {
  const u = (p, q) => ({ x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1) });
  a.original = `${a.original || ''} ${c.original || ''}`.trim();
  a.translated = `${a.translated || ''} ${c.translated || ''}`.trim();
  a.box = u(a.box, c.box);
  if (a.raw && c.raw) a.raw = u(a.raw, c.raw);
  if (a.bubbleRect && c.bubbleRect) a.bubbleRect = u(a.bubbleRect, c.bubbleRect);
  else a.bubbleRect = a.bubbleRect || c.bubbleRect || null;
  if (a.inkBox && c.inkBox) a.inkBox = u(a.inkBox, c.inkBox);
  if (a.fontPx != null && c.fontPx != null) a.fontPx = Math.min(a.fontPx, c.fontPx);
  a.merged = true;
  // Shrink state is recomputed from the new boxes
  a._s = 1;
  a._x0 = { ...a.box };
  a._b0 = a.bubbleRect ? { ...a.bubbleRect } : null;
  delete a._origBubble;
  delete a._shrunk;
}
const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
function nudgeOverlaps(items, W, H) {
  const hits = (A, B) =>
    Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0) > 0 && Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) > 0;
  const bub = (it) => it.bubbleRect || it.box;
  const txt = (it) => it.raw || it.box;
  // Overlap area / area of the smaller box
  const overlapRatio = (A, B) => {
    const w = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
    const h = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
    if (w <= 0 || h <= 0) return 0;
    return (w * h) / Math.max(1e-6, Math.min(area(A), area(B)));
  };
  const sig = (A, B) => overlapRatio(A, B) > OVERLAP_TOL;
  const conflicts = (x, y) =>
    sig(bub(x), txt(y)) || sig(bub(y), txt(x)) || sig(bub(x), bub(y)) || sig(x.box, y.box);
  const center = (r) => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });
  const scaleRect = (r, f) => {
    const c = center(r);
    return { x0: c.x - (c.x - r.x0) * f, x1: c.x + (r.x1 - c.x) * f, y0: c.y - (c.y - r.y0) * f, y1: c.y + (r.y1 - c.y) * f };
  };
  for (const it of items) {
    if (it._s == null) it._s = 1;
    if (it.bubbleRect && !it._b0) it._b0 = { ...it.bubbleRect };
    if (it.box && !it._x0) it._x0 = { ...it.box };
  }
  const setScale = (it, f) => {
    if (it._b0 && it.bubbleRect) it.bubbleRect = scaleRect(it._b0, f);
    if (it._x0 && it.box) it.box = scaleRect(it._x0, f);
    it._s = f;
  };
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], c = items[j];
        if (!a.box || !c.box) continue;
        if (Math.max(overlapRatio(bub(a), bub(c)), overlapRatio(a.box, c.box)) > MERGE_TOL) {
          mergeItems(a, c);
          items.splice(j, 1);
          j--;
          changed = true;
          continue;
        }
        if (!conflicts(a, c)) continue;
        for (const it of [a, c]) {
          // Each block shrinks only once to SHRINK_SCALE relative to the original, no repeated shrinking over several passes
          if (it._s > SHRINK_SCALE) { setScale(it, SHRINK_SCALE); changed = true; }
        }
      }
    }
    if (!changed) break;
  }
  // Log the overlapping pairs after shrinking: overlap % per type and the shrink ratio of each block
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], c = items[j];
      if (!a.box || !c.box) continue;
      const bt = Math.max(overlapRatio(bub(a), txt(c)), overlapRatio(bub(c), txt(a)));
      const bb = overlapRatio(bub(a), bub(c));
      const ss = overlapRatio(a.box, c.box);
      const m = Math.max(bt, bb, ss);
      if (m <= 0) continue;
      rows.push({
        A: String(a.original || '').slice(0, 18),
        B: String(c.original || '').slice(0, 18),
        'bubble↔chữ gốc %': Math.round(bt * 100),
        'bubble↔bubble %': Math.round(bb * 100),
        'sub↔sub %': Math.round(ss * 100),
        'co A': a._s.toFixed(2),
        'co B': c._s.toFixed(2),
      });
    }
  }
  if (rows.length) {
    console.log(`[ĐÈ] ${rows.length} cặp đang đè nhau`);
    console.table(rows);
  }
}

// Build one item from a Gemini block. raw = text box; bubble = bubble box (outer edge) if present.
// If a bubble box exists, use it directly without guessing; if it is missing or unreasonable, fall back to the old method (expand by background color).
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
  // Text area is almost empty (no text strokes): the block was wrongly assigned to this image -> discard
  let ink = inkBounds(data, W, raw, bg);
  // Text box has no strokes but the bubble does: Gemini placed the text box off target, so use the whole bubble
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
  // Strict mode (only for blocks in the last round, where the model is more likely to hallucinate): the real text area must have a fairly uniform background color
  // and a reasonable amount of text strokes; drawing/noise areas are dropped instead of drawing a sub over the artwork.
  if (strict && ink && (bg.frac < 0.35 || ink.count / ink.area < 0.015)) {
    console.warn('[OCR] bỏ khối (vòng kiểm tra lại): vùng này không giống chữ trong bong bóng (vòng cuối)', { original: b.original, bgFrac: bg.frac, inkRatio: ink.count / ink.area });
    return null;
  }
  // Text made only of dots/ellipses (e.g. "....") has very few strokes, so it does not pass the stroke check.
  // For this type the block is kept, and the text box itself is used to measure line spacing.
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
    // Gemini's font_size is relative to the height of the image piece being sent (for a tall image, the piece, not the whole image)
    fontPx: fontPxFrom(b, clipY ? clipY.y1 - clipY.y0 : H),
    inkBox: ink ? { x0: ink.x0, y0: ink.y0, x1: ink.x1, y1: ink.y1 } : null,
    bubbleRect: bubble ? { x0: bubble.x0, y0: bubble.y0, x1: bubble.x1, y1: bubble.y1 } : null,
  };
}

// Shape: prefer the shape field. If it is missing or invalid, take the
// 'ellipse'/'rect' value the model accidentally put in the coordinate array. If neither exists, return '' (process as normal).
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

// Read the text box and bubble box of one block (normalized 0-1000)
// List of boxes [ymin, xmin, ymax, xmax] in one box field (non-numeric items dropped)
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

// Take only the first box of each field (bubble_box, text_box). When the model returns several boxes in one block
// the later ones are ignored, not merged.
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
  nudgeOverlaps(items, W, H);
  return items;
}

// Image that is almost one color (black/white separator): no need to send to Gemini
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

// Hard-state the number of images so Gemini does not skip images without text
function countReminder(n) {
  return `\n\nThis request contains exactly ${n} image${n === 1 ? '' : 's'}: labels "Image 0" to "Image ${n - 1}". The "images" array MUST have exactly ${n} entries, one for EVERY index from 0 to ${n - 1}. An image with no text at all (pure artwork, mostly black or empty, a cropped panel) STILL gets its own entry with an empty array, for example {"index":2,"summary":"pot on a table, no text","blocks":[]}. Never omit an entry because the image has nothing to translate.`;
}

const BATCH_MAX_IMAGES = 8; // small batch: lite models often return "no text" for the whole batch when the batch is large
const PARALLEL_REQUESTS = 2; // number of requests running at the same time (Promise.all)
const BATCH_PAUSE_MS = 3000; // pause after each group of requests before sending the next group
const BATCH_MAX_BYTES = 10 * 1024 * 1024;
const LAST_ROUND = 3; // round 1 for all images; rounds 2 and 3 only for images still empty or failed

// Load an image as a Blob. Blob images can only be read in the page that created them,
// so ask the content script to read them and send back a data URL.
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

// Translate all images: send several images in one request, split into batches when there are too many or they are too heavy
// Raw Gemini block data returned for each image (url -> blocks), used for logging at the end
let geminiReport = new Map();

async function translateAllGemini(tabId, urls, stats = { drawn: 0 }) {
  geminiReport = new Map();
  busyStopped = false;
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
  // Update progress on the in-page panel each time an image is drawn
  const progress = () => {
    stats.drawn = ok; // translateAll uses this number to refund quota for images that could not be translated
    notify(tabId, { type: 'SHOW_INFO', text: `Đang dịch: ${ok}/${list.length} ảnh...` });
  };
  progress();
  const undrawn = []; // images that have blocks from the model but could not be drawn
  const drawn = new Set(); // URL of images where at least one block was drawn
  const batchErrors = []; // images in a round-1 batch that failed with a request error
  const tallErrors = []; // tall images that errored
  const tallEmpty = []; // tall images where the model returned no blocks
  const RECHECK_HINT = 'Some of these images were reported as having no text in a previous pass. Check each one again. Return blocks only for text that is actually printed in THAT image, with exact boxes; do not guess or invent text. If an image truly has no readable text, return an empty "blocks" array for it.';

  // Send one group of images in one request; return a blocks array per image (null = missing)
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

  // Build the boxes and draw the translation for one image
  const showBlocks = async (img, blocks, canRecheck, round = 1) => {
    geminiReport.set(img.srcUrl, blocks);
    const bitmap = await createImageBitmap(img.blob);
    try {
      let items = itemsFromBlocks(blocks, bitmap, round === LAST_ROUND); // strict check only in the last round
      console.log(`[OCR] vòng ${round}: ${blocks.length} khối -> vẽ ${items.length}`, img.srcUrl);
      if (items.length && !cancelCheck()) {
        notify(tabId, { type: 'OVERLAY_IMAGE', srcUrl: img.srcUrl, width: bitmap.width, height: bitmap.height, items });
        ok++;
        progress();
        drawn.add(img.srcUrl);
        await markDone(tabId, img.srcUrl);
      } else if (blocks.length && !cancelCheck()) {
        // Model returned blocks but none could be drawn: record it for the log
        undrawn.push({ url: img.srcUrl, blocks: blocks.length, round });
        // If no block could be drawn, treat the image as having no text: deselect it and lock it in the side panel
        await markState(tabId, 'noText', img.srcUrl);
        console.warn(`[OCR] ảnh không vẽ được khối nào (vòng ${round}, ${blocks.length} khối)`, img.srcUrl);
      }
    } finally {
      bitmap.close();
    }
  };

  // Round 1: send in batches and draw images that already have text right away. Images returned empty or missing
  // (lite models often wrongly assign "no text") are collected to be asked again in round 2.
  // Send batches in groups of PARALLEL_REQUESTS requests at once (Promise.all). After a group finishes, process its results,
  // pause BATCH_PAUSE_MS, then send the next group.
  const askParallel = async (groups, hint, onResults) => {
    for (let k = 0; k < groups.length; k += PARALLEL_REQUESTS) {
      if (stopRequested()) break; // stopped (cancelled or server busy): do not send more requests
      const part = groups.slice(k, k + PARALLEL_REQUESTS);
      const res = await Promise.all(part.map((g) =>
        askBatch(g, hint).then((perImage) => ({ g, perImage }), (err) => ({ g, err }))
      ));
      await onResults(res);
      if (k + PARALLEL_REQUESTS < groups.length) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
    }
  };

  // Split images into batches by count and size
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

  // One recheck round, sent in batches. Returns:
  // empty: images the model answered but returned no blocks for (or that are missing from the result)
  // failed: images whose request errored (network, quota, broken JSON); not counted toward the threshold
  const runRecheckRound = async (imgs, round) => {
    const empty = [], failed = [];
    await askParallel(makeGroups(imgs), RECHECK_HINT, async (res) => {
      for (const { g: group, perImage, err } of res) {
        if (err) {
          console.error(`[OCR] lô kiểm tra lại (vòng ${round}) lỗi`, err);
      notifyBusyOnce(err);
          failed.push(...group);
          continue;
        }
        for (let i = 0; i < group.length; i++) {
          const blocks = perImage[i];
          if (blocks && blocks.length) await showBlocks(group[i], blocks, false, round);
          else empty.push(group[i]);
        }
      }
    });
    return { empty, failed };
  };

  // Round 1 covers all images in list order: normal images are sent in batches, tall images are cut into pieces and sent in batches.
  // Images that come back empty are not rechecked here; they are rechecked in rounds 2 and 3 below.
  // Drawing order no longer depends on the image type.
  let emptyImgs = [];
  let failedImgs = [];

  // Server overloaded (503/429): report only once per run, and tell the user to wait and retry
  const isBusyError = (err) => /HTTP (503|429)|high demand|quá tải/i.test(String(err && err.message || err));
  // On 503/429: stop immediately and report once
  const notifyBusyOnce = (err) => {
    console.error('[OCR] lô Gemini lỗi', err);
    if (!isBusyError(err) || busyStopped) return;
    busyStopped = true;
    notify(tabId, { type: 'SHOW_ERROR', error: 'Máy chủ đang bận, vui lòng đợi một chút rồi dịch lại.' });
  };

  // Tall image has finished all its pieces: draw it using original-image coordinates
  const onTallDone = async (r) => {
    const img = r.img;
    if (r.error) {
      tallErrors.push(img.srcUrl);
      console.error('[OCR] ảnh rất cao lỗi', img.srcUrl, r.error);
      notifyBusyOnce(r.error);
    } else if (r.items.length && !cancelCheck()) {
      notify(tabId, { type: 'OVERLAY_IMAGE', srcUrl: img.srcUrl, width: r.width, height: r.height, items: r.items });
      ok++;
      progress();
      drawn.add(img.srcUrl);
      await markDone(tabId, img.srcUrl);
    } else {
      tallEmpty.push(img.srcUrl);
    }
  };

  // Normal image: draw with showBlocks as before. Images the model returns empty for are rechecked in later rounds.
  const onWholeDone = async (r) => {
    const img = r.img;
    if (r.error) {
      batchErrors.push(img);
      notifyBusyOnce(r.error);
    } else if (!r.blocks.length) {
      emptyImgs.push(img);
    } else {
      await showBlocks(img, r.blocks, true);
    }
  };

  // One flow for all images: batch them together, route each result to the handler for its image type
  const onImageDone = (r) => (r.whole ? onWholeDone(r) : onTallDone(r));
  await geminiTallBatch(loaded.filter((x) => !x.blank), apiKey, targetLang, onImageDone);

  // Round 1 runs for all images above. Then recheck images still empty or failed: rounds 2 and 3 only
  for (let round = 2; round <= LAST_ROUND; round++) {
    const work = [...emptyImgs, ...failedImgs];
    if (!work.length || stopRequested()) break;
    ({ empty: emptyImgs, failed: failedImgs } = await runRecheckRound(work, round));
  }

  // Summary: each image falls into exactly one group
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
  // Cancelled: unfinished images are not "no text" images, so do not lock them
  if (!stopRequested()) {
    for (const u of [...groups[1][1], ...groups[3][1], ...groups[4][1]]) await markState(tabId, 'noText', u);
  }
  const sumGroups = groups.reduce((n, [, urls]) => n + urls.length, 0);
  console.group(`[OCR] TỔNG KẾT: ${list.length} ảnh | đã vẽ ${drawn.size} | khác ${sumGroups}`);
  for (const [label, urls] of groups) {
    console.log(`${label}: ${urls.length}`);
    for (const u of urls) console.log('   ' + u);
  }
  if (drawn.size + sumGroups !== list.length) console.warn('[OCR] còn ảnh chưa phân loại:', list.length - drawn.size - sumGroups);
  console.groupEnd();
  // Raw Gemini block data per image link (tall images: _piece is the piece label, coordinates relative to that piece)
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

// Background color around the box, used to cover the original text with the translation
// ---------- Get bubble background color and align the box to the bubble area ----------
// Background color = most common color inside the box (text is the minority), instead of the average of the surrounding area
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

// Extend each edge of the box outward while the adjacent row/column is still bubble background color,
// so the box covers the whole bubble instead of only the text (Gemini often returns a box that is slightly small or off)
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
  // Wide extension limit; stop at the black gap between bubbles so it does not spill into other boxes
  const grow = Math.min(600, Math.max(200, Math.round(0.8 * Math.max(w, h))));
  const L = Math.max(0, box.x0 - grow), R = Math.min(W, box.x1 + grow);
  const T = Math.max(0, box.y0 - grow), B = Math.min(H, box.y1 + grow);
  const out = { ...box };
  const TH = 0.15; // a row with dense text still has many background-colored pixels; the black gap outside a bubble is nearly 0
  while (out.y0 - 1 >= T && rowFrac(out.y0 - 1, out.x0, out.x1) >= TH) out.y0--;
  while (out.y1 + 1 <= B - 1 && rowFrac(out.y1, out.x0, out.x1) >= TH) out.y1++;
  while (out.x0 - 1 >= L && colFrac(out.x0 - 1, out.y0, out.y1) >= TH) out.x0--;
  while (out.x1 + 1 <= R - 1 && colFrac(out.x1, out.y0, out.y1) >= TH) out.x1++;
  // Pull back edges that lie entirely on the black gap (Gemini drew the box too generously)
  while (out.y1 - out.y0 > 8 && rowFrac(out.y1 - 1, out.x0, out.x1) === 0) out.y1--;
  while (out.y1 - out.y0 > 8 && rowFrac(out.y0, out.x0, out.x1) === 0) out.y0++;
  while (out.x1 - out.x0 > 8 && colFrac(out.x1 - 1, out.y0, out.y1) === 0) out.x1--;
  while (out.x1 - out.x0 > 8 && colFrac(out.x0, out.y0, out.y1) === 0) out.x0++;
  return out;
}

// From the Gemini box (converted to pixel coordinates) -> aligned box + background color
function analyzeBox(data, W, H, box) {
  const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(W, Math.ceil(box.x1)), y1 = Math.min(H, Math.ceil(box.y1));
  const bg = dominantColor(data, W, x0, y0, x1, y1);
  // A dark background is usually the black gap between comic panels: do not extend, to avoid swallowing artwork
  const snapped = bg.dark ? { x0, y0, x1, y1 } : snapToBubble(data, W, H, { x0, y0, x1, y1 }, bg);
  return { box: snapped, bg };
}

// ---------- Tall image: split into equal pieces, each piece no larger than the limit ----------
// Enable/disable cutting tall images (images > TALL_LIMIT are cut into pieces)
const SPLIT_TALL_IMAGES = true;
const TALL_LIMIT = 4000; // only tall images taller than this are cut
const TILE_MAX = 4000;   // each piece is at most TILE_MAX px; add one piece for every additional TILE_MAX px
const CUT_SEARCH = 600;  // search for the cut line within +-600px of the midpoint

// Find a safe cut line in [lo, hi], preferring a row near `target`: a uniform-color gap between boxes,
// with no text strokes or bubble edges crossing it. Score a band of 7 rows around the cut line
// to avoid cutting right at the edge of text or a bubble.
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

// Cut one image into JPEG pieces. Keep only the compressed pieces; the full-image pixels are released right after cutting.
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
  // Number of pieces: add one piece for every TILE_MAX px (each piece is always <= TILE_MAX)
  const n = Math.floor(H / TILE_MAX) + 1;
  const cuts = [0];
  for (let i = 1; i < n; i++) {
    const prev = cuts[cuts.length - 1];
    const target = Math.round((H * i) / n);
    // The current piece <= TILE_MAX, and the remainder can still be split into (n - i) pieces <= TILE_MAX
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

// Convert a piece's boxes back to original-image coordinates. Reads only the pixels of that piece, not the whole image.
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
    // Gemini returned several bubble_box for one block = the block merged several bubbles: still draw it, but do not measure the offset
    it.merged = rectsOf(b.bubble_box).length > 1;
    items.push(it);
  }
  console.log(`[TILE] đoạn ${tile.y0}..${tile.y0 + H}: ${blocks.length} khối -> vẽ ${items.length}`);
  // Convert from piece coordinates to original-image coordinates
  for (const it of items) {
    it.box.y0 += tile.y0;
    it.box.y1 += tile.y0;
    it.raw.y0 += tile.y0;
    it.raw.y1 += tile.y0;
    if (it.inkBox) {
      it.inkBox.y0 += tile.y0;
      it.inkBox.y1 += tile.y0;
    }
    if (it.bubbleRect) {
      it.bubbleRect.y0 += tile.y0;
      it.bubbleRect.y1 += tile.y0;
    }
  }
  // Offset log: real text strokes vs the sub box to be drawn. dx/dy > 0 means the sub lies right/below the original text.
  return items;
}

// Remove duplicate boxes in the overlap zone between two pieces
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

// Send several pieces of the same image in one request, each piece with an order label
// Send several pieces (of one or more images) in one request. Each piece label is "k_i":
// k is the image's order in the batch, i is the piece's order within that image (top to bottom). Return a Map label -> blocks;
// labels the model does not return are not in the Map (so they are re-sent alone).
async function callGeminiPieces(apiKey, pieces, targetLang) {
  const target = TARGET_NAMES[targetLang] || targetLang;
  const labels = pieces.map((p) => p.label);
  const prompt = `You are given several vertical pieces of one or more comic/manga pages or screenshots. Each piece is labeled "Image k_i": k identifies the page, i is the order of the piece within that page, from top to bottom. A page that was not cut has a single piece with i = 0. The pieces of the same page are consecutive in this request. Cut pieces are split at blank gutters between panels, so no text block is split across two pieces. Pieces of different pages are unrelated: NEVER move a block from one page to another.
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

// Process several tall images: cut each into pieces and queue them. When TALL_BATCH_PIECES pieces are ready, send one request,
// keep the remainder to combine with the next image. When all pieces of an image are done, call onDone(that image's result)
// right away, without waiting for other images. Return [{ img, items, width, height, error }] in imgs order.
const TALL_BATCH_PIECES = 8; // each request groups at most 8 tall-image pieces
async function geminiTallBatch(imgs, apiKey, targetLang, onDone = null) {
  // gi = the image's order in the whole run; piece labels are gi_i so the same piece always has the same label in every batch
  const recs = imgs.map((img, gi) => ({ img, gi, W: 0, H: 0, tiles: [], all: [], raw: [], error: null, pending: 0, result: null }));

  // Image has all pieces done: gather the result and call onDone to draw it right away
  const finishRec = async (rec) => {
    if (rec.result) return;
    if (rec.error) {
      rec.result = { img: rec.img, whole: rec.whole, blocks: [], items: [], width: rec.W, height: rec.H, error: rec.error };
    } else {
      const items = dedupeItems(rec.all);
      avoidOverlap(items);
      nudgeOverlaps(items, rec.W, rec.H);
      rec.result = { img: rec.img, whole: rec.whole, blocks: rec.raw, items, width: rec.W, height: rec.H, error: null };
    }
    geminiReport.set(rec.img.srcUrl, rec.raw);
    rec.all = [];
    if (onDone) await onDone(rec.result);
  };

  // Send one batch of pieces in one request; any piece the model does not return is re-sent alone
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
          const its = await itemsFromTileLocal(blocks, pc.tile, pc.rec.W);
          pc.rec.all = pc.rec.all.concat(its);
        }
      } catch (err) {
        console.error('[OCR] lô ảnh dài lỗi', err);
        for (const p of live) p.rec.error = err;
      }
    }
    // Release the data of processed pieces, then count and draw the images that are done
    for (const p of batch) p.rec.tiles[p.i].blob = null;
    for (const p of batch) {
      p.rec.pending--;
      if (p.rec.pending === 0) await finishRec(p.rec);
    }
  };

  // Step 1: cut all tall images into pieces
  for (const rec of recs) {
    try {
      const t = await cutToTiles(rec.img.blob, rec.img.mime);
      rec.W = t.W;
      rec.H = t.H;
      rec.tiles = t.tiles;
      rec.whole = t.tiles.length === 1; // normal image: not cut
      rec.pending = rec.tiles.length;
    } catch (err) {
      rec.error = err;
      await finishRec(rec);
    }
  }

  // Step 2: pack pieces into batches, regardless of whether they come from normal or tall images. A batch holds at most TALL_BATCH_PIECES pieces
  // and BATCH_MAX_BYTES. All pieces of the same image always stay in the same batch, unless that image has more pieces than one batch,
  // in which case it must be split.
  const pieceBytes = (ps) => ps.reduce((sum, p) => sum + p.rec.tiles[p.i].blob.size, 0);
  const batches = [];
  let cur = [], curBytes = 0;
  const closeCur = () => { if (cur.length) batches.push(cur); cur = []; curBytes = 0; };
  for (const rec of recs) {
    if (rec.error || !rec.tiles.length) continue;
    const piecesOf = rec.tiles.map((_, i) => ({ rec, i }));
    const n = piecesOf.length;
    const size = pieceBytes(piecesOf);
    if (n > TALL_BATCH_PIECES) {
      closeCur();
      for (let k = 0; k < n; k += TALL_BATCH_PIECES) batches.push(piecesOf.slice(k, k + TALL_BATCH_PIECES));
      continue;
    }
    if (cur.length && (cur.length + n > TALL_BATCH_PIECES || curBytes + size > BATCH_MAX_BYTES)) closeCur();
    cur.push(...piecesOf);
    curBytes += size;
    if (cur.length === TALL_BATCH_PIECES) closeCur();
  }
  closeCur();

  // Step 3: send PARALLEL_REQUESTS batches at once with Promise.all, then pause BATCH_PAUSE_MS before the next group
  for (let k = 0; k < batches.length; k += PARALLEL_REQUESTS) {
    if (stopRequested()) break; // stopped (cancelled or server busy): do not send more batches
    await Promise.all(batches.slice(k, k + PARALLEL_REQUESTS).map((b) => flush(b)));
    if (k + PARALLEL_REQUESTS < batches.length) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
  }

  for (const rec of recs) await finishRec(rec); // safety net for anything left over
  return recs.map((rec) => rec.result);
}

// One image (for right-click) -> items to overlay on the page
async function geminiImageItems(blob, mime, apiKey, targetLang) {
  const [r] = await geminiTallBatch([{ blob, mime }], apiKey, targetLang);
  if (r.error) throw r.error;
  return { items: r.items, width: r.width, height: r.height };
}

// Right-click image: Gemini returns boxes, convert them to pixel coordinates, then get the background color
async function geminiImageBlocks(tabId, srcUrl, targetLang) {
  const key = await getGeminiKey();
  const blob = await loadImageBlob(tabId, srcUrl);
  const mime = (blob.type || 'image/png').split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
    throw new Error(`Gemini không hỗ trợ định dạng ${mime}`);
  }
  return geminiImageItems(blob, mime, key, targetLang);
}

// ---------- Translate one image (right-click) ----------
async function runImageViewer(tabId, srcUrl, quiet = false) {
  let ref = null; // transaction id for the quota deduction, used to refund quota if translation fails
  try {
    if (!srcUrl) throw new Error('Không lấy được đường dẫn ảnh.');
    const { targetLang } = await getSettings();
    if (!quiet) notify(tabId, { type: 'SHOW_LOADING' });
    ref = await Account.charge(1); // must be logged in, have a key and have enough quota before translating

    const { items, width, height } = await geminiImageBlocks(tabId, srcUrl, targetLang);
    if (!items.length) {
      await markState(tabId, 'noText', srcUrl); // side panel: lock an image that has no text
      throw new Error('Gemini không tìm thấy chữ trong ảnh.');
    }

    notify(tabId, { type: 'OVERLAY_IMAGE', srcUrl, width, height, items });
    await markDone(tabId, srcUrl); // side panel: show "✓ Translated" and deselect this image
    notify(tabId, { type: 'HIDE_PANEL' });
    return true;
  } catch (err) {
    console.error('[OCR]', srcUrl, err);
    await Account.refund(ref, 1); // error or no text: refund the quota
    notify(tabId, { type: 'SHOW_ERROR', error: err.message });
    return false;
  }
}

// ---------- Translate all images on the page ----------
// Cancel the running translation for a tab. Unfinished images are refunded at the end of translateAll.
const cancelFlags = new Map(); // tabId -> true when the user presses cancel
let cancelCheck = () => false;
// Stopped by 503/429: do not send more requests, do not mark unfinished images as no-text
let busyStopped = false;
const stopRequested = () => busyStopped || cancelCheck();

async function translateAll(tabId, urls) {
  let list = [...new Set(urls)];
  if (!list.length) {
    notify(tabId, { type: 'SHOW_ERROR', error: 'Không tìm thấy ảnh đủ lớn trên trang.' });
    return;
  }
  const requestedCount = list.length;
  let skippedCount = 0; // number of images skipped for lack of quota
  // Deduct quota by the number of selected images; images not translated (error, no text) are refunded at the end.
  // Set the "running" state first so the side panel always receives the end state, even if the quota deduction fails.
  await setJob(tabId, 'running');
  // The server accepts at most 50 quota units per deduction, so split into several deductions
  const CHARGE_MAX = 50;
  let refs = []; // [{ ref, count }] successful deductions, to refund when needed
  const stats = { drawn: 0 };
  cancelFlags.delete(tabId);
  cancelCheck = () => cancelFlags.get(tabId) === true;
  try {
    try {
      // Not enough quota for the whole run: still translate the first images in the list (top to bottom) using the remaining quota,
      // then report out of quota. When quota is fully used up, Account.require throws the "out of quota" error as before.
      const acc = await Account.require();
      const have = Math.floor(Number(acc.user.credits) || 0);
      if (have < list.length) {
        skippedCount = list.length - have;
        list = list.slice(0, have);
      }
      for (let i = 0; i < list.length; i += CHARGE_MAX) {
        const count = Math.min(CHARGE_MAX, list.length - i);
        const ref = await Account.charge(count);
        refs.push({ ref, count });
      }
    } catch (err) {
      // Partial deduction failure (out of quota, network error...): refund the deductions already made, then stop
      for (const r of refs) await Account.refund(r.ref, r.count);
      refs = [];
      notify(tabId, { type: 'SHOW_ERROR', error: err.message });
      return;
    }
    await translateAllGemini(tabId, list, stats);
  } finally {
    const wasCancelled = cancelCheck(); // read before the cancel flag below is cleared
    // Refund quota for images not translated, in the order of the deductions
    let toRefund = list.length - stats.drawn;
    for (const r of refs) {
      const n = Math.min(r.count, toRefund);
      if (n > 0) await Account.refund(r.ref, n);
      toRefund -= n;
    }
    cancelFlags.delete(tabId);
    notify(tabId, { type: 'QUEUE_CLEAR' }); // out of quota: images still in the queue are no longer locked
    if (skippedCount > 0 && !wasCancelled) {
      notify(tabId, {
        type: 'SHOW_ERROR',
        error: `Bạn đã hết lượt dịch. Đã dịch ${stats.drawn}/${requestedCount} ảnh, còn ${skippedCount} ảnh chưa dịch. Vui lòng mua thêm lượt để tiếp tục.`,
      });
    }
    await setJob(tabId, 'idle');
  }
}

// Which window each open side panel is in (popup.js connects port 'sidepanel:<windowId>' when opened)
const panelPorts = new Map(); // windowId -> Set<Port>
chrome.runtime.onConnect.addListener((port) => {
  const m = /^sidepanel:(\d+)$/.exec(port.name || '');
  if (!m) return;
  const id = Number(m[1]);
  if (!panelPorts.has(id)) panelPorts.set(id, new Set());
  panelPorts.get(id).add(port);
  broadcastPanelState(id, true);
  port.onDisconnect.addListener(() => {
    const set = panelPorts.get(id);
    if (!set) return;
    set.delete(port);
    if (!set.size) { panelPorts.delete(id); broadcastPanelState(id, false); }
  });
});

// Notify all tabs in the window so the floating button keeps its "open" state while the side panel is open
function broadcastPanelState(winId, open) {
  chrome.tabs.query({ windowId: winId }).then((tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'PANEL_STATE', open }).catch(() => {});
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_NOTEXT' && sender.tab) {
    // Content script on page load: return the no-text images for that tab
    chrome.storage.session.get('noText').then(
      (store) => sendResponse({ urls: ((store.noText || {})[sender.tab.id]) || [] }),
      () => sendResponse({ urls: [] })
    );
    return true;
  }
  if (msg.type === 'TRANSLATE_ONE' && sender.tab) {
    // "Translate image" button on each image: translate only that image, and report the result back so the button updates
    runImageViewer(sender.tab.id, msg.srcUrl, true).then(
      (ok) => sendResponse({ ok }),
      () => sendResponse({ ok: false })
    );
    return true;
  }
  if (msg.type === 'GET_PANEL_STATE' && sender.tab) {
    const set = panelPorts.get(sender.tab.windowId);
    sendResponse({ open: !!(set && set.size) });
    return false;
  }
  if (msg.type === 'TOGGLE_SIDE_PANEL' && sender.tab) {
    // Floating button on the right of the page: if open, close it; if closed, open it (same as the toolbar icon).
    // sidePanel.open must be called right away (synchronously) in the handler so it still counts as the user's click gesture.
    const winId = sender.tab.windowId;
    const ports = panelPorts.get(winId);
    if (ports && ports.size) {
      if (typeof chrome.sidePanel.close === 'function') {
        chrome.sidePanel.close({ windowId: winId }).catch(() => {});
      } else {
        for (const p of ports) { try { p.postMessage({ type: 'CLOSE_PANEL' }); } catch (_) {} }
      }
    } else {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch((err) => console.warn('[sidePanel.open]', err.message));
    }
    return false;
  }
  if (msg.type === 'REBIND_URL' && sender.tab) {
    // Page changed the image link that was translated: update the URL key in the "translated" state so the side panel matches the new image
    renameDone(sender.tab.id, msg.oldUrl, msg.newUrl);
    return false;
  }
  if (msg.type === 'CANCEL_TRANSLATE' && Number.isInteger(msg.tabId)) {
    cancelFlags.set(msg.tabId, true);
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


// ---------- Per-tab state for the side panel: translated, no text, running ----------
async function markState(tabId, key, url) {
  try {
    const store = await chrome.storage.session.get(key);
    const map = store[key] || {};
    const set = new Set(map[tabId] || []);
    set.add(url);
    map[tabId] = [...set];
    await chrome.storage.session.set({ [key]: map });
    // Tell the page so the translate button on that image is hidden immediately
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

// Page reloaded or tab closed: delete that tab's state
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading') await clearTabState(tabId);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearTabState(tabId);
});
